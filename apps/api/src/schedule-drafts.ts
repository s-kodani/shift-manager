import {encodeStoredSchedule,decodeStoredSchedule,scheduleObjectMetadata} from './schedule-serialization';
import { z } from "zod";
import { assertPublishedLocks } from "./published-fixed";
import { optimizerInputSchema } from "../../../packages/contracts/optimizer-input.generated";
import { boundedBytes, loadJob, readJobResult } from "./compute-jobs";
import {
  candidateResult,
  draftCommand,
  type CandidateCommand,
} from "./draft-contract";
import { readInputSnapshot, sha256 } from "./input-snapshots";
import type { InputDatabase } from "./input-versions";
import { ProductError, requireManager } from "./product";

export type DraftVerifier = (command: CandidateCommand) => Promise<unknown>;
type DraftEnvironment = { DB: InputDatabase; INPUTS: R2Bucket };
type DraftRow = {
  company_id: string;
  id: string;
  team_id: string;
  month: string;
  actor_id: string;
  source_job_id: string;
  snapshot_id: string;
  input_revision: number;
  expected_draft_revision: number;
  fingerprint: string;
  object_key: string;
  sha256: string;
  byte_length: number;
  validation_status: string;
  recorded_at: number;
};
export class DraftInvalidError extends ProductError {
  constructor(public violations: string[]) {
    super("DRAFT_INVALID", 400);
  }
}
const row = (db: InputDatabase, company: string, id: string) =>
  db
    .prepare("SELECT * FROM schedule_draft_version WHERE company_id=? AND id=?")
    .bind(company, id)
    .first<DraftRow>();
const response = (r: DraftRow, replayed: boolean) => ({
  draftId: r.id,
  draftRevision: r.expected_draft_revision + 1,
  inputRevision: r.input_revision,
  validationStatus: r.validation_status,
  publication: "BLOCKED_A1",
  replayed,
});

export async function saveDraft(
  env: DraftEnvironment,
  company: string,
  team: string,
  user: string,
  data: z.infer<typeof draftCommand>,
  verify: DraftVerifier,
) {
  const c = draftCommand.parse(data),
    db = env.DB;
  await requireManager(db, company, team, user);
  const fingerprint = await sha256(
    new TextEncoder().encode(
      JSON.stringify({ company, team, user, command: c }),
    ),
  );
  const replay = async () => {
    const old = await row(db, company, c.operationId);
    if (old && old.fingerprint !== fingerprint)
      throw new ProductError("OPERATION_ID_CONFLICT");
    if (old) {
      await requireManager(db, company, team, user);
      return response(old, true);
    }
    return null;
  };
  const old = await replay();
  if (old) return old;
  const job = await loadJob(db, company, team, c.sourceJobId);
  if (!job) throw new ProductError("NOT_FOUND", 404);
  if (job.state !== "SUCCEEDED")
    throw new ProductError("DRAFT_SOURCE_NOT_READY");
  if (job.input_revision !== c.expectedRevision)
    throw new ProductError("VERSION_CONFLICT");
  const frozen = await readInputSnapshot(
    db,
    env.INPUTS,
    company,
    team,
    user,
    job.snapshot_id,
    true,
    true,
  );
  const source = await readJobResult(
    db,
    env.INPUTS,
    company,
    team,
    user,
    job.id,
  );
  if (source.inputStale || source.result.assignments === null)
    throw new ProductError("DRAFT_SOURCE_NOT_READY");
  const headRevision = await db
    .prepare(
      "SELECT revision FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?",
    )
    .bind(company, team, frozen.input.month)
    .first<number>("revision");
  if ((headRevision ?? 0) !== c.expectedDraftRevision)
    throw new ProductError("DRAFT_VERSION_CONFLICT");
  const input = optimizerInputSchema.parse({
    ...frozen.input,
    locks: c.locks,
    exceptions: c.exceptions,
  });
  if (input.mode === "reallocation")
    await assertPublishedLocks(env.DB, company, team, input.month, c.locks);
  let raw: unknown;
  try {
    raw = await verify({
      companyId: company,
      teamId: team,
      userId: user,
      snapshotId: job.snapshot_id,
      assignments: c.assignments,
      locks: c.locks,
      exceptions: c.exceptions,
    });
  } catch (error) {
    const message = String(error);
    if (message.includes("CHECK_BUSY")) throw new ProductError("CHECK_BUSY");
    if (message.includes("CHECK_HTTP_400"))
      throw new ProductError("INVALID_INPUT", 400);
    if (message.includes("CHECK_PAYLOAD_TOO_LARGE"))
      throw new ProductError("CHECK_PAYLOAD_TOO_LARGE", 400);
    throw error;
  }
  const checked = candidateResult.parse(raw);
  const inputSha256 = await sha256(
    new TextEncoder().encode(JSON.stringify(input)),
  );
  if (
    checked.snapshotSha256 !== frozen.snapshot.sha256 ||
    checked.inputSha256 !== inputSha256
  )
    throw new Error("DRAFT_CHECK_IDENTITY_MISMATCH");
  if (
    checked.validation.status === "INVALID" ||
    checked.validation.violations.length
  )
    throw new DraftInvalidError(checked.validation.violations);
  const draft = {
    draftId: c.operationId,
    tenantId: company,
    teamId: team,
    month: input.month,
    sourceJobId: job.id,
    snapshotId: job.snapshot_id,
    snapshotSha256: frozen.snapshot.sha256,
    inputSha256,
    inputRevision: c.expectedRevision,
    draftRevision: c.expectedDraftRevision + 1,
    origin: "manual",
    assignments: c.assignments,
    locks: c.locks,
    exceptions: c.exceptions,
    validation: checked.validation,
    publication: "BLOCKED_A1",
  };
  const bytes = await encodeStoredSchedule(draft,new ProductError("DRAFT_TOO_LARGE",400));
  const digest = await sha256(bytes),
    key = `companies/${company}/teams/${team}/drafts/${input.month}/${c.operationId}/${crypto.randomUUID()}.json`;
  if (
    !(await env.INPUTS.put(key, bytes, {
      sha256: digest,
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: scheduleObjectMetadata(bytes),
    }))
  )
    throw new Error("DRAFT_UPLOAD_FAILED");
  try {
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO schedule_draft_head(company_id,team_id,month) VALUES (?,?,?)",
        )
        .bind(company, team, input.month),
      db
        .prepare(
          `INSERT INTO schedule_draft_version(company_id,id,team_id,month,actor_id,source_job_id,snapshot_id,input_revision,expected_draft_revision,fingerprint,object_key,sha256,byte_length,validation_status,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          company,
          c.operationId,
          team,
          input.month,
          user,
          job.id,
          job.snapshot_id,
          c.expectedRevision,
          c.expectedDraftRevision,
          fingerprint,
          key,
          digest,
          bytes.byteLength,
          checked.validation.status,
          Date.now(),
        ),
      db
        .prepare(
          `INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,'schedule:manual_saved',?,?)`,
        )
        .bind(company, c.operationId, user, c.expectedRevision, Date.now()),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM schedule_draft_version d
        JOIN schedule_draft_head h ON h.company_id=d.company_id AND h.team_id=d.team_id AND h.month=d.month
        JOIN product_audit a ON a.company_id=d.company_id AND a.id=d.id JOIN company c ON c.id=d.company_id
        WHERE d.company_id=? AND d.id=? AND d.team_id=? AND d.month=? AND d.actor_id=?
          AND d.object_key=? AND d.sha256=? AND d.byte_length=? AND d.fingerprint=?
          AND d.input_revision=? AND d.expected_draft_revision=? AND d.validation_status=?
          AND h.draft_id=d.id AND h.revision=d.expected_draft_revision+1 AND c.revision=d.input_revision
          AND a.kind='schedule:manual_saved' AND a.actor_id=d.actor_id AND a.revision=d.input_revision
      ) THEN 1 ELSE abs(-9223372036854775808) END AS draft_saved`)
        .bind(company,c.operationId,team,input.month,user,key,digest,bytes.byteLength,fingerprint,c.expectedRevision,c.expectedDraftRevision,checked.validation.status),
    ]);
  } catch (error) {
    const retry = await replay();
    if (retry) return retry;
    const message = String(error);
    if (message.includes("DRAFT_FORBIDDEN"))
      throw new ProductError("FORBIDDEN", 403);
    if (message.includes("DRAFT_INPUT_CONFLICT"))
      throw new ProductError("VERSION_CONFLICT");
    if (message.includes("DRAFT_VERSION_CONFLICT"))
      throw new ProductError("DRAFT_VERSION_CONFLICT");
    if (message.includes("UNIQUE constraint"))
      throw new ProductError("OPERATION_ID_CONFLICT");
    throw error;
  }
  return response((await row(db, company, c.operationId))!, false);
}

export async function readDraft(
  env: DraftEnvironment,
  company: string,
  team: string,
  user: string,
  id: string,
) {
  await requireManager(env.DB, company, team, user);
  const saved = await readDraftObject(env, company, team, id);
  await requireManager(env.DB, company, team, user);
  return saved;
}

// Internal integrity reader. HTTP draft readers always use readDraft above.
async function readDraftObject(env: DraftEnvironment, company: string, team: string, id: string) {
  const r = await row(env.DB, company, id);
  if (!r || r.team_id !== team) throw new ProductError("NOT_FOUND", 404);
  const object = await env.INPUTS.get(r.object_key);
  if (!object || object.size !== r.byte_length)
    throw new Error("DRAFT_OBJECT_MISSING");
  const bytes = await boundedBytes(object.body, r.byte_length);
  if (bytes.byteLength !== r.byte_length || (await sha256(bytes)) !== r.sha256)
    throw new Error("DRAFT_DIGEST_MISMATCH");
  const draft = await decodeStoredSchedule(bytes);
  if (
    draft.draftId !== id ||
    draft.tenantId !== company ||
    draft.teamId !== team ||
    draft.month !== r.month ||
    draft.inputRevision !== r.input_revision ||
    draft.snapshotId !== r.snapshot_id ||
    draft.sourceJobId !== r.source_job_id ||
    draft.draftRevision !== r.expected_draft_revision + 1 ||
    draft.validation.status !== r.validation_status ||
    draft.publication !== "BLOCKED_A1"
  )
    throw new Error("DRAFT_IDENTITY_MISMATCH");
  const revision = await env.DB.prepare(
    "SELECT revision FROM company WHERE id=?",
  )
    .bind(company)
    .first<number>("revision");
  const current = await env.DB.prepare(
    "SELECT draft_id FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?",
  )
    .bind(company, team, r.month)
    .first<string>("draft_id");
  return {
    draft,
    stale: revision !== r.input_revision,
    superseded: current !== id,
    publication: "BLOCKED_A1",
  };
}

// Return only this person's fixed facts for server-side input validation.
// Staff can never obtain a team's draft, assignments or colleagues' inputs.
export async function readOwnRegistrationDraft(env: DraftEnvironment, company: string, team: string, user: string, id: string) {
  const { ownSubmissionStaff } = await import('./staff-submission-access');
  const staff = await ownSubmissionStaff(env.DB, company, team, user);
  const saved = await readDraftObject(env, company, team, id);
  const { fixedDraftInput } = await import('./draft-recalculation');
  const fixed = fixedDraftInput(saved.draft);
  if (await ownSubmissionStaff(env.DB, company, team, user) !== staff) throw new ProductError('FORBIDDEN',403);
  return { month: saved.draft.month, inputRevision: saved.draft.inputRevision,
    draftRevision: saved.draft.draftRevision, superseded: saved.superseded,
    fixed: {locks:fixed.locks.filter(l=>l.staffId===staff),exceptions:fixed.exceptions.filter(e=>e.staffId===staff)} };
}
export async function readDraftHead(
  env: DraftEnvironment,
  company: string,
  team: string,
  user: string,
  month: string,
) {
  await requireManager(env.DB, company, team, user);
  const head = await env.DB.prepare(
    "SELECT revision,draft_id FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?",
  )
    .bind(company, team, month)
    .first<{ revision: number; draft_id: string | null }>();
  if (!head?.draft_id) return { draftRevision: 0, draft: null };
  const r = await readDraft(env, company, team, user, head.draft_id);
  if (r.superseded) throw new ProductError("DRAFT_VERSION_CONFLICT");
  return { draftRevision: head.revision, ...r };
}
