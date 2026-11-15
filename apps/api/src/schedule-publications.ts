import {encodeStoredSchedule,decodeStoredSchedule,scheduleObjectMetadata} from './schedule-serialization';
import { z } from "zod";
import {
  optimizerAssignmentsSchema,
  optimizerInputSchema,
} from "../../../packages/contracts/optimizer-input.generated";
import { boundedBytes, loadJob, readJobResult } from "./compute-jobs";
import { candidateResult, draftCommand } from "./draft-contract";
import {
  publicationCommand,
  publicationDocument,
  publicationValidation,
} from "./publication-contract";
import { readDraft, type DraftVerifier } from "./schedule-drafts";
import { readInputSnapshot, sha256 } from "./input-snapshots";
import type { InputDatabase } from "./input-versions";
import { ProductError, requireManager, teamRole } from "./product";
import { validationSummary } from "./publication-revalidation";
import { fixedSourceStatements, assertPublishedLocks } from "./published-fixed";
import {publicationCompletionGuard} from './publication-completion';
import {
  publicationNoticeCursor,
  publicationHistoryCursor,
  publicationNoticePage,
  publicationHistoryPage,
} from "./publication-browse-contract";
import { inputMonth } from "./input-versions";

type Environment = { DB: InputDatabase; INPUTS: R2Bucket };
type PublicationRow = {
  company_id: string;
  id: string;
  team_id: string;
  month: string;
  actor_id: string;
  source_kind: "job" | "draft";
  source_id: string;
  source_job_id: string;
  snapshot_id: string;
  input_revision: number;
  applied_revision: number;
  expected_draft_revision: number;
  expected_publication_revision: number;
  fingerprint: string;
  object_key: string;
  sha256: string;
  byte_length: number;
  recorded_at: number;
  assignment_count: number;
  shortage_acknowledged: number;
  origin: "schedule" | "cancellation";
};
const row = (db: InputDatabase, company: string, id: string) =>
  db
    .prepare(
      `SELECT p.* FROM schedule_publication_version p
 JOIN schedule_publication_commit c ON c.company_id=p.company_id AND c.publication_id=p.id WHERE p.company_id=? AND p.id=?`,
    )
    .bind(company, id)
    .first<PublicationRow>();
const response = (r: PublicationRow, replayed: boolean) => ({
  publicationId: r.id,
  month: r.month,
  publicationRevision: r.expected_publication_revision + 1,
  inputRevision: r.input_revision,
  revision: r.applied_revision,
  publication: "PUBLISHED" as const,
  replayed,
});

export async function publishSchedule(
  env: Environment,
  company: string,
  team: string,
  user: string,
  data: z.infer<typeof publicationCommand>,
  verify: DraftVerifier,
) {
  const c = publicationCommand.parse(data),
    db = env.DB;
  await requireManager(db, company, team, user);
  const fingerprint = await sha256(
    new TextEncoder().encode(
      JSON.stringify({ company, team, user, command: c }),
    ),
  );
  const replay = async () => {
    const old = await row(db, company, c.operationId);
    if (old && (old.team_id !== team || old.fingerprint !== fingerprint))
      throw new ProductError("OPERATION_ID_CONFLICT");
    if (!old) return null;
    await requireManager(db, company, team, user);
    return response(old, true);
  };
  const old = await replay();
  if (old) return old;
  const draftSource = draftCommand
    .pick({ assignments: true, locks: true, exceptions: true })
    .extend({
      sourceJobId: z.string().uuid(),
      snapshotId: z.string().uuid(),
      draftRevision: z.number().int().positive(),
    })
    .strip();
  let sourceJobId = c.source.id,
    draft: z.infer<typeof draftSource> | undefined;
  if (c.source.kind === "draft") {
    const saved = await readDraft(env, company, team, user, c.source.id);
    if (saved.stale) throw new ProductError("VERSION_CONFLICT");
    if (
      saved.superseded ||
      saved.draft.draftRevision !== c.expectedDraftRevision
    )
      throw new ProductError("DRAFT_VERSION_CONFLICT");
    draft = draftSource.parse(saved.draft);
    sourceJobId = z.string().uuid().parse(draft.sourceJobId);
  }
  const job = await loadJob(db, company, team, sourceJobId);
  if (!job) throw new ProductError("NOT_FOUND", 404);
  if (job.state !== "SUCCEEDED")
    throw new ProductError("PUBLICATION_SOURCE_NOT_READY");
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
    c.source.kind === "draft",
  );
  const source = await readJobResult(
    db,
    env.INPUTS,
    company,
    team,
    user,
    job.id,
  );
  if (source.inputStale || (c.source.kind === "job" && source.stale))
    throw new ProductError("PUBLICATION_SOURCE_NOT_READY");
  const assignments = optimizerAssignmentsSchema.parse(
    c.source.kind === "draft" ? draft!.assignments : source.result.assignments,
  );
  const locks = optimizerInputSchema.shape.locks.parse(
    c.source.kind === "draft" ? draft!.locks : frozen.input.locks,
  );
  const exceptions = optimizerInputSchema.shape.exceptions.parse(
    c.source.kind === "draft" ? draft!.exceptions : frozen.input.exceptions,
  );
  const input = optimizerInputSchema.parse({
    ...frozen.input,
    locks,
    exceptions,
  });
  if (input.mode === "reallocation")
    await assertPublishedLocks(db, company, team, input.month, locks);
  const heads = await db.batch([
    db
      .prepare(
        "SELECT revision FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?",
      )
      .bind(company, team, input.month),
    db
      .prepare(
        "SELECT revision FROM schedule_publication_head WHERE company_id=? AND team_id=? AND month=?",
      )
      .bind(company, team, input.month),
  ]);
  const headRevision = (value: unknown) =>
    value
      ? z.object({ revision: z.number().int().nonnegative() }).parse(value)
          .revision
      : 0;
  if (headRevision(heads[0].results[0]) !== c.expectedDraftRevision)
    throw new ProductError("DRAFT_VERSION_CONFLICT");
  if (headRevision(heads[1].results[0]) !== c.expectedPublicationRevision)
    throw new ProductError("PUBLICATION_VERSION_CONFLICT");
  // Guard completeness before transport as well as in SQL. The checker still
  // independently verifies every staff/date and all mandatory conditions.
  const days = new Date(
    Date.UTC(Number(input.month.slice(0, 4)), Number(input.month.slice(5)), 0),
  ).getUTCDate();
  const staff = new Set(input.staff.map((s) => s.id));
  if (
    assignments.length !== staff.size * days ||
    new Set(assignments.map((a) => a.staffId + ":" + a.date)).size !==
      assignments.length ||
    assignments.some(
      (a) => !staff.has(a.staffId) || a.date.slice(0, 7) !== input.month,
    )
  )
    throw new ProductError("PUBLICATION_ASSIGNMENT_KEYS", 400);
  let raw: unknown;
  try {
    raw = await verify({
      companyId: company,
      teamId: team,
      userId: user,
      snapshotId: job.snapshot_id,
      assignments,
      locks,
      exceptions,
    });
  } catch (error) {
    if (String(error).includes("CHECK_BUSY"))
      throw new ProductError("CHECK_BUSY");
    if (String(error).includes("CHECK_HTTP_400"))
      throw new ProductError("INVALID_INPUT", 400);
    if (String(error).includes("CHECK_PAYLOAD_TOO_LARGE"))
      throw new ProductError("CHECK_PAYLOAD_TOO_LARGE", 400);
    throw error;
  }
  const checked = candidateResult.parse(raw),
    inputSha256 = await sha256(new TextEncoder().encode(JSON.stringify(input)));
  if (
    checked.snapshotSha256 !== frozen.snapshot.sha256 ||
    checked.inputSha256 !== inputSha256
  )
    throw new Error("PUBLICATION_CHECK_IDENTITY_MISMATCH");
  if (
    checked.validation.status !== "VERIFIED" ||
    checked.validation.violations.length
  )
    throw new ProductError("PUBLICATION_NOT_VERIFIED", 400);
  const validation = publicationValidation.parse(checked.validation);
  if (validation.missingHistory.length)
    throw new ProductError("PUBLICATION_NOT_VERIFIED", 400);
  const shortage =
    validation.generalShortage > 0 ||
    validation.roleSameShortage > 0 ||
    validation.roleRequirements.some((r) => r.shortagePersonMinutes > 0);
  if (shortage && !c.acknowledgeShortage)
    throw new ProductError("PUBLICATION_SHORTAGE_ACK_REQUIRED", 400);
  const recordedAt = Date.now();
  const document = publicationDocument.parse({
    publicationId: c.operationId,
    tenantId: company,
    teamId: team,
    month: input.month,
    actorId: user,
    source: c.source,
    sourceJobId: job.id,
    snapshotId: job.snapshot_id,
    snapshotSha256: frozen.snapshot.sha256,
    inputSha256,
    inputRevision: c.expectedRevision,
    appliedRevision: c.expectedRevision + 1,
    publicationRevision: c.expectedPublicationRevision + 1,
    expectedDraftRevision: c.expectedDraftRevision,
    assignments,
    locks,
    exceptions,
    validation,
    shortageAcknowledged: c.acknowledgeShortage,
    recordedAt,
    publication: "PUBLISHED",
  });
  const bytes = await encodeStoredSchedule(document,new ProductError("PUBLICATION_TOO_LARGE",400));
  const digest = await sha256(bytes),
    key = `companies/${company}/teams/${team}/publications/${input.month}/${c.operationId}/${crypto.randomUUID()}.json`;
  if (
    !(await env.INPUTS.put(key, bytes, {
      sha256: digest,
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: scheduleObjectMetadata(bytes),
    }))
  )
    throw new Error("PUBLICATION_UPLOAD_FAILED");
  // R2 is immutable evidence, not the visible publication state. Only the final
  // D1 commit makes all version/facts/event/notices/audit visible together.
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "INSERT OR IGNORE INTO schedule_publication_head(company_id,team_id,month) VALUES (?,?,?)",
      )
      .bind(company, team, input.month),
    db
      .prepare(
        `INSERT INTO schedule_publication_version(company_id,id,team_id,month,actor_id,source_kind,source_id,source_job_id,snapshot_id,input_revision,applied_revision,expected_draft_revision,expected_publication_revision,fingerprint,object_key,sha256,byte_length,assignment_count,shortage_acknowledged,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        company,
        c.operationId,
        team,
        input.month,
        user,
        c.source.kind,
        c.source.id,
        job.id,
        job.snapshot_id,
        c.expectedRevision,
        c.expectedRevision + 1,
        c.expectedDraftRevision,
        c.expectedPublicationRevision,
        fingerprint,
        key,
        digest,
        bytes.byteLength,
        assignments.length,
        Number(c.acknowledgeShortage),
        recordedAt,
      ),
  ];
  // Chunked JSON uses few bound parameters even at 500 staff x 31 dates. It
  // avoids one statement per assignment and SQL variable limits.
  for (let i = 0; i < assignments.length; i += 100)
    statements.push(
      db
        .prepare(
          `INSERT INTO schedule_publication_assignment(company_id,publication_id,team_id,staff_id,date,shift,worked_minutes,staff_number,staff_name)
    SELECT ?,?,?,json_extract(a.value,'$.staffId'),json_extract(a.value,'$.date'),COALESCE(json_extract(a.value,'$.shift'),'null'),COALESCE(json_extract(a.value,'$.shift.workedMinutes'),0),s.staff_number,s.name
    FROM json_each(?) a JOIN staff s ON s.company_id=? AND s.team_id=? AND s.id=json_extract(a.value,'$.staffId')`,
        )
        .bind(
          company,
          c.operationId,
          team,
          JSON.stringify(
            assignments
              .slice(i, i + 100)
              .map(({ staffId, date, shift }) => ({ staffId, date, shift })),
          ),
          company,
          team,
        ),
    );
  statements.push(
    ...fixedSourceStatements(db, document, digest),
    db
      .prepare(
        "INSERT INTO schedule_publication_event(company_id,publication_id,team_id,month,recorded_at) VALUES (?,?,?,?,?)",
      )
      .bind(company, c.operationId, team, input.month, recordedAt),
    db
      .prepare(
        `INSERT INTO schedule_publication_notice(company_id,publication_id,team_id,user_id)
      SELECT t.company_id,?,t.team_id,t.user_id FROM team_member t JOIN access_state a ON a.user_id=t.user_id WHERE t.company_id=? AND t.team_id=? AND a.enabled=1`,
      )
      .bind(c.operationId, company, team),
    db
      .prepare(
        "INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,'schedule:published',?,?)",
      )
      .bind(company, c.operationId, user, c.expectedRevision + 1, recordedAt),
    db
      .prepare(
        "INSERT INTO schedule_publication_commit(company_id,publication_id) VALUES (?,?)",
      )
      .bind(company, c.operationId),
  );
  statements.push(publicationCompletionGuard(db,document,key,digest,bytes.byteLength,fingerprint));
  try {
    await db.batch(statements);
  } catch (error) {
    const retry = await replay();
    if (retry) return retry;
    await requireManager(db, company, team, user);
    const message = String(error);
    if (message.includes("PUBLICATION_FORBIDDEN"))
      throw new ProductError("FORBIDDEN", 403);
    if (message.includes("PUBLICATION_INPUT_CONFLICT"))
      throw new ProductError("VERSION_CONFLICT");
    if (message.includes("PUBLICATION_DRAFT_CONFLICT"))
      throw new ProductError("DRAFT_VERSION_CONFLICT");
    if (
      message.includes("PUBLICATION_VERSION_CONFLICT") ||
      message.includes("PUBLICATION_COMMIT_CONFLICT")
    )
      throw new ProductError("PUBLICATION_VERSION_CONFLICT");
    if (message.includes("UNIQUE constraint"))
      throw new ProductError("OPERATION_ID_CONFLICT");
    // Retain uncertain uploads. Do not delete possibly committed evidence.
    throw error;
  }
  const saved = await row(db, company, c.operationId);
  if (!saved) throw new Error("PUBLICATION_COMMIT_MISSING");
  return response(saved, false);
}

async function reader(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
) {
  const access = await db
    .prepare(
      "SELECT enabled,must_change_password FROM access_state WHERE user_id=?",
    )
    .bind(user)
    .first<{ enabled: number; must_change_password: number }>();
  if (!access?.enabled || access.must_change_password)
    throw new ProductError("FORBIDDEN", 403);
  const role = await teamRole(db, company, team, user);
  if (!role) throw new ProductError("FORBIDDEN", 403);
  const staff =
    role === "staff"
      ? await db
          .prepare(
            "SELECT staff_id FROM team_member WHERE company_id=? AND team_id=? AND user_id=?",
          )
          .bind(company, team, user)
          .first<string>("staff_id")
      : null;
  if (role === "staff" && !staff) throw new ProductError("FORBIDDEN", 403);
  return { role, staff };
}
// Internal trusted service loader. Public reads must still authorize before
// and after R2 I/O; background messages resolve their stored scoped request.
export async function publicationEvidence(
  env: Environment,
  company: string,
  team: string,
  id: string,
) {
  const r = await row(env.DB, company, id);
  if (!r || r.team_id !== team) throw new ProductError("NOT_FOUND", 404);
  const object = await env.INPUTS.get(r.object_key);
  if (!object || object.size !== r.byte_length)
    throw new Error("PUBLICATION_OBJECT_MISSING");
  const bytes = await boundedBytes(object.body, r.byte_length);
  if (bytes.byteLength !== r.byte_length || (await sha256(bytes)) !== r.sha256)
    throw new Error("PUBLICATION_DIGEST_MISMATCH");
  const p = publicationDocument.parse(
    await decodeStoredSchedule(bytes),
  );
  if (
    p.publicationId !== r.id ||
    p.tenantId !== r.company_id ||
    p.teamId !== r.team_id ||
    p.month !== r.month ||
    p.actorId !== r.actor_id ||
    p.inputRevision !== r.input_revision ||
    p.appliedRevision !== r.applied_revision ||
    p.publicationRevision !== r.expected_publication_revision + 1 ||
    p.source.kind !== r.source_kind ||
    p.source.id !== r.source_id ||
    p.sourceJobId !== r.source_job_id ||
    p.snapshotId !== r.snapshot_id ||
    p.expectedDraftRevision !== r.expected_draft_revision ||
    p.assignments.length !== r.assignment_count ||
    p.shortageAcknowledged !== !!r.shortage_acknowledged ||
    p.validation.status !== "VERIFIED"
  )
    throw new Error("PUBLICATION_IDENTITY_MISMATCH");
  if ((r.origin === "cancellation") !== !!p.cancellation)
    throw new Error("PUBLICATION_ORIGIN_MISMATCH");
  if (p.cancellation) {
    const origin = p.cancellation;
    const operation = await env.DB.prepare(
      `SELECT o.request_id,o.parent_publication_id,o.parent_sha256,o.candidate_sha256,o.input_sha256,o.planning_id,o.removed_count FROM leave_cancellation_operation o JOIN schedule_publication_version parent ON parent.company_id=o.company_id AND parent.id=o.parent_publication_id WHERE o.company_id=? AND o.id=? AND parent.sha256=o.parent_sha256 AND parent.expected_publication_revision+1=o.publication_revision`,
    )
      .bind(company, id)
      .first<{
        request_id: string;
        parent_publication_id: string;
        parent_sha256: string;
        candidate_sha256: string;
        input_sha256: string;
        planning_id: string;
        removed_count: number;
      }>();
    if (
      !operation ||
      origin.operationId !== id ||
      origin.requestId !== operation.request_id ||
      origin.parentPublicationId !== operation.parent_publication_id ||
      origin.parentPublicationSha256 !== operation.parent_sha256 ||
      origin.candidateSha256 !== operation.candidate_sha256 ||
      origin.planningId !== operation.planning_id ||
      origin.removedParticipations.length !== operation.removed_count ||
      p.inputSha256 !== operation.input_sha256 ||
      origin.input.tenantId !== company ||
      origin.input.teamId !== team ||
      origin.input.month !== p.month ||
      origin.input.inputVersion !== p.inputRevision ||
      origin.input.jobId !== id ||
      (await sha256(new TextEncoder().encode(JSON.stringify(origin.input)))) !==
        p.inputSha256 ||
      (await sha256(
        new TextEncoder().encode(
          JSON.stringify({ input: origin.input, assignments: p.assignments }),
        ),
      )) !== origin.candidateSha256
    )
      throw new Error("CANCELLATION_EVIDENCE_MISMATCH");
  }
  return { row: r, document: p };
}

export async function readPublication(
  env: Environment,
  company: string,
  team: string,
  user: string,
  id: string,
) {
  const before = await reader(env.DB, company, team, user),
    r = await row(env.DB, company, id);
  if (!r || r.team_id !== team) throw new ProductError("NOT_FOUND", 404);
  const { document: p } = await publicationEvidence(env, company, team, id);
  const state = await env.DB.batch([
    env.DB.prepare("SELECT revision FROM company WHERE id=?").bind(company),
    env.DB.prepare(
      "SELECT publication_id FROM schedule_publication_head WHERE company_id=? AND team_id=? AND month=?",
    ).bind(company, team, r.month),
  ]);
  const revalidation = await validationSummary(
    env.DB,
    company,
    team,
    r.month,
    id,
  );
  const after = await reader(env.DB, company, team, user);
  // Re-evaluate scope after R2 I/O; a manager demoted in-flight must not receive
  // another person's assignments, exceptions, or certificate.
  const selfOnly = before.role === "staff" || after.role === "staff";
  const publication = selfOnly
    ? {
        publicationId: p.publicationId,
        month: p.month,
        publicationRevision: p.publicationRevision,
        publication: p.publication,
        recordedAt: p.recordedAt,
        assignments: p.assignments.filter(
          (a) => a.staffId === (after.staff ?? before.staff),
        ),
      }
    : p;
  return {
    publication,
    revalidation:
      selfOnly && revalidation ? { status: revalidation.status } : revalidation,
    revalidationRequired:
      revalidation !== null &&
      !["ORIGINAL_VERIFIED", "VERIFIED"].includes(revalidation.status),
    superseded:
      z
        .object({ publication_id: z.string().nullable() })
        .parse(state[1].results[0]).publication_id !== id,
  };
}
export async function readPublicationHead(
  env: Environment,
  company: string,
  team: string,
  user: string,
  month: string,
) {
  await reader(env.DB, company, team, user);
  const head = await env.DB.prepare(
    "SELECT revision,publication_id FROM schedule_publication_head WHERE company_id=? AND team_id=? AND month=?",
  )
    .bind(company, team, month)
    .first<{ revision: number; publication_id: string | null }>();
  if (!head?.publication_id)
    return { publicationRevision: 0, publication: null };
  const read = await readPublication(
    env,
    company,
    team,
    user,
    head.publication_id,
  );
  if (read.superseded) throw new ProductError("PUBLICATION_VERSION_CONFLICT");
  return { publicationRevision: head.revision, ...read };
}
export async function publicationHistory(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  month: string,
  cursor?: z.infer<typeof publicationHistoryCursor>,
) {
  await requireManager(db, company, team, user);
  inputMonth.parse(month);
  const c = cursor ? publicationHistoryCursor.parse(cursor) : null;
  const result = await db
    .prepare(
      `SELECT p.id AS publicationId,p.actor_id AS actorId,u.name AS actorName,p.recorded_at AS recordedAt,p.expected_publication_revision+1 AS publicationRevision,p.input_revision AS inputRevision,CASE WHEN p.origin='cancellation' THEN 'cancellation' ELSE p.source_kind END AS sourceKind,CASE WHEN p.origin='cancellation' THEN p.id ELSE p.source_id END AS sourceId
    FROM schedule_publication_version p JOIN schedule_publication_commit c ON c.company_id=p.company_id AND c.publication_id=p.id JOIN user u ON u.id=p.actor_id
    WHERE p.company_id=? AND p.team_id=? AND p.month=? AND (? IS NULL OR p.expected_publication_revision+1<?) ORDER BY p.expected_publication_revision DESC LIMIT 51`,
    )
    .bind(company, team, month, c?.revision ?? null, c?.revision ?? null)
    .all();
  await requireManager(db, company, team, user);
  const versions = result.results.slice(0, 50),
    last = versions.at(-1) as { publicationRevision: number } | undefined;
  return publicationHistoryPage.parse({
    versions,
    nextCursor:
      result.results.length > 50 && last
        ? { revision: last.publicationRevision }
        : null,
  });
}
export async function publicationNotices(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  cursor?: z.infer<typeof publicationNoticeCursor>,
) {
  await reader(db, company, team, user);
  const c = cursor ? publicationNoticeCursor.parse(cursor) : null;
  const result = await db
    .prepare(
      `SELECT n.publication_id AS publicationId,n.read_at AS readAt,e.month,e.recorded_at AS recordedAt
    FROM schedule_publication_notice n JOIN schedule_publication_event e ON e.company_id=n.company_id AND e.publication_id=n.publication_id
    JOIN schedule_publication_commit c ON c.company_id=n.company_id AND c.publication_id=n.publication_id
    WHERE n.company_id=? AND n.team_id=? AND n.user_id=?
    AND (? IS NULL OR e.recorded_at<? OR (e.recorded_at=? AND n.publication_id<?)) ORDER BY e.recorded_at DESC,n.publication_id DESC LIMIT 51`,
    )
    .bind(
      company,
      team,
      user,
      c?.recordedAt ?? null,
      c?.recordedAt ?? null,
      c?.recordedAt ?? null,
      c?.id ?? null,
    )
    .all();
  await reader(db, company, team, user);
  const notices = result.results.slice(0, 50),
    last = notices.at(-1) as
      { recordedAt: number; publicationId: string } | undefined;
  return publicationNoticePage.parse({
    notices,
    nextCursor:
      result.results.length > 50 && last
        ? { recordedAt: last.recordedAt, id: last.publicationId }
        : null,
  });
}
export async function readPublicationNotice(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  id: string,
) {
  await reader(db, company, team, user);
  const r = await db
    .prepare(
      `UPDATE schedule_publication_notice SET read_at=max(?,(SELECT recorded_at FROM schedule_publication_event WHERE company_id=? AND publication_id=?)) WHERE company_id=? AND team_id=? AND user_id=? AND publication_id=? AND read_at IS NULL
    AND EXISTS(SELECT 1 FROM schedule_publication_commit WHERE company_id=? AND publication_id=?)
    AND EXISTS(SELECT 1 FROM access_state WHERE user_id=? AND enabled=1 AND must_change_password=0)
    AND (EXISTS(SELECT 1 FROM company_admin WHERE company_id=? AND user_id=?) OR EXISTS(SELECT 1 FROM team_member WHERE company_id=? AND team_id=? AND user_id=?))`,
    )
    .bind(
      Date.now(),
      company,
      id,
      company,
      team,
      user,
      id,
      company,
      id,
      user,
      company,
      user,
      company,
      team,
      user,
    )
    .run();
  await reader(db, company, team, user);
  const exists = await db
    .prepare(
      "SELECT read_at AS readAt FROM schedule_publication_notice WHERE company_id=? AND team_id=? AND user_id=? AND publication_id=?",
    )
    .bind(company, team, user, id)
    .first<{ readAt: number | null }>();
  if (!exists) throw new ProductError("NOT_FOUND", 404);
  if (exists.readAt === null) throw new ProductError("FORBIDDEN", 403);
  return {
    publicationId: id,
    read: true,
    readAt: exists.readAt,
    changed: r.meta.changes > 0,
  };
}
