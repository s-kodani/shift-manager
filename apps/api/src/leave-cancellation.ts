import {encodeStoredSchedule,scheduleObjectMetadata} from './schedule-serialization';
import type { InputDatabase } from "./input-versions";
import { ProductError, requireManager } from "./product";
import { sha256 } from "./input-snapshots";
import {
  buildCancellationCandidate,
  assertCancellationCurrent,
} from "./cancellation-candidate";
import {
  cancellationCandidateCommand,
  cancellationCheckResult,
  cancellationCommitCommand,
  cancellationCommitResult,
  type CancellationCandidateCommand,
  type CancellationCheckResult,
  type CancellationCommitCommand,
} from "./cancellation-contract";
import { publicationDocument } from "./publication-contract";
import { fixedSourceStatements } from "./published-fixed";
import {publicationCompletionGuard} from './publication-completion';
type Environment = { DB: InputDatabase; INPUTS: R2Bucket };
type Receipt = {
  id: string;
  request_id: string;
  team_id: string;
  fingerprint: string;
  request_revision: number;
  publication_revision: number;
  applied_revision: number;
  kind: string;
};
export type CancellationVerifier = (
  c: CancellationCandidateCommand,
) => Promise<CancellationCheckResult>;
export async function inspectLeaveCancellation(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  request: string,
  id: string,
) {
  await requireManager(db, company, team, user);
  const r = await db
    .prepare(
      `SELECT o.id,o.request_id,o.team_id,o.fingerprint,o.request_revision,o.publication_revision,o.applied_revision,r.kind FROM leave_cancellation_operation o JOIN schedule_publication_commit c ON c.company_id=o.company_id AND c.publication_id=o.id JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id WHERE o.company_id=? AND o.team_id=? AND o.request_id=? AND o.id=?`,
    )
    .bind(company, team, request, id)
    .first<Receipt>();
  await requireManager(db, company, team, user);
  return r
    ? {
        found: true as const,
        result: cancellationCommitResult.parse({
          operationId: r.id,
          requestId: r.request_id,
          requestRevision: r.request_revision + 1,
          status:
            r.kind === "ABSENCE_FACT" ? "CANCELLATION_CONFIRMED" : "APPROVED",
          publicationId: r.id,
          publicationRevision: r.publication_revision + 1,
          revision: r.applied_revision,
          replayed: true,
        }),
      }
    : { found: false as const };
}
export async function commitLeaveCancellation(
  env: Environment,
  company: string,
  team: string,
  user: string,
  request: string,
  data: CancellationCommitCommand,
  verify: CancellationVerifier,
) {
  const c = cancellationCommitCommand.parse(data),
    db = env.DB;
  await requireManager(db, company, team, user);
  const fingerprint = await sha256(
    new TextEncoder().encode(
      JSON.stringify({ company, team, user, request, command: c }),
    ),
  );
  const replay = async () => {
    const r = await db
      .prepare(
        `SELECT o.id,o.request_id,o.team_id,o.fingerprint,o.request_revision,o.publication_revision,o.applied_revision,r.kind
  FROM leave_cancellation_operation o JOIN schedule_publication_commit v ON v.company_id=o.company_id AND v.publication_id=o.id JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id WHERE o.company_id=? AND o.id=?`,
      )
      .bind(company, c.operationId)
      .first<Receipt>();
    if (!r) return null;
    if (
      r.fingerprint !== fingerprint ||
      r.team_id !== team ||
      r.request_id !== request
    )
      throw new ProductError("OPERATION_ID_CONFLICT");
    await requireManager(db, company, team, user);
    return cancellationCommitResult.parse({
      operationId: r.id,
      requestId: r.request_id,
      requestRevision: r.request_revision + 1,
      status: r.kind === "ABSENCE_FACT" ? "CANCELLATION_CONFIRMED" : "APPROVED",
      publicationId: r.id,
      publicationRevision: r.publication_revision + 1,
      revision: r.applied_revision,
      replayed: true,
    });
  };
  const old = await replay();
  if (old) return old;
  const { acknowledgeShortage: _, ...checkInput } = c;
  const command = cancellationCandidateCommand.parse({
    ...checkInput,
    companyId: company,
    teamId: team,
    userId: user,
    requestId: request,
  });
  const candidate = await buildCancellationCandidate(env, command);
  const draftRevision =
    (await db
      .prepare(
        "SELECT revision FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?",
      )
      .bind(company, team, candidate.input.month)
      .first<number>("revision")) ?? 0;
  // Always a new independent check for this commit, never a previous preflight.
  const checked = cancellationCheckResult.parse(await verify(command));
  if (
    checked.operationId !== c.operationId ||
    checked.requestId !== request ||
    checked.requestRevision !== c.expectedRequestRevision ||
    checked.publicationId !== c.publicationId ||
    checked.publicationRevision !== c.expectedPublicationRevision ||
    checked.inputRevision !== c.expectedRevision ||
    checked.capacityScale !== candidate.input.capacityScale ||
    checked.candidateSha256 !== candidate.candidateSha256 ||
    checked.publicationSha256 !== candidate.evidence.row.sha256 ||
    JSON.stringify(checked.removedParticipations) !==
      JSON.stringify(candidate.removedParticipations)
  )
    throw new Error("CANCELLATION_CHECK_IDENTITY_MISMATCH");
  const validation = checked.validation;
  if (
    validation.status !== "VERIFIED" ||
    validation.violations.length ||
    validation.missingHistory.length
  )
    throw new ProductError("CANCELLATION_NOT_VERIFIED", 400);
  const shortage =
    validation.generalShortage > 0 ||
    validation.roleSameShortage > 0 ||
    validation.roleRequirements.some((r) => r.shortagePersonMinutes > 0);
  if (shortage && !c.acknowledgeShortage)
    throw new ProductError("PUBLICATION_SHORTAGE_ACK_REQUIRED", 400);
  await assertCancellationCurrent(env, candidate);
  const inputSha256 = await sha256(
      new TextEncoder().encode(JSON.stringify(candidate.input)),
    ),
    recordedAt = Date.now();
  const document = publicationDocument.parse({
    ...candidate.evidence.document,
    publicationId: c.operationId,
    actorId: user,
    inputRevision: c.expectedRevision,
    appliedRevision: c.expectedRevision + 1,
    publicationRevision: c.expectedPublicationRevision + 1,
    expectedDraftRevision: draftRevision,
    inputSha256,
    assignments: candidate.assignments,
    locks: candidate.input.locks,
    exceptions: candidate.input.exceptions,
    validation,
    shortageAcknowledged: c.acknowledgeShortage,
    recordedAt,
    cancellation: {
      operationId: c.operationId,
      requestId: request,
      parentPublicationId: c.publicationId,
      parentPublicationSha256: candidate.evidence.row.sha256,
      candidateSha256: candidate.candidateSha256,
      planningId: candidate.planningId,
      input: candidate.input,
      lineage: candidate.lineage,
      removedParticipations: candidate.removedParticipations,
    },
  });
  const bytes = await encodeStoredSchedule(document,new ProductError("PUBLICATION_TOO_LARGE",400));
  const digest = await sha256(bytes),
    key = `companies/${company}/teams/${team}/publications/${document.month}/${c.operationId}/${crypto.randomUUID()}.json`;
  if (
    !(await env.INPUTS.put(key, bytes, {
      sha256: digest,
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: scheduleObjectMetadata(bytes),
    }))
  )
    throw new Error("CANCELLATION_UPLOAD_FAILED");
  const statements = [
    db
      .prepare(
        `INSERT INTO leave_cancellation_operation(company_id,id,request_id,team_id,actor_id,parent_publication_id,parent_sha256,expected_revision,applied_revision,request_revision,publication_revision,planning_id,candidate_sha256,input_sha256,fingerprint,removed_count,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        company,
        c.operationId,
        request,
        team,
        user,
        c.publicationId,
        candidate.evidence.row.sha256,
        c.expectedRevision,
        c.expectedRevision + 1,
        c.expectedRequestRevision,
        c.expectedPublicationRevision,
        candidate.planningId,
        candidate.candidateSha256,
        inputSha256,
        fingerprint,
        candidate.removedParticipations.length,
        recordedAt,
      ),
    db
      .prepare(
        `INSERT INTO schedule_publication_version(company_id,id,team_id,month,actor_id,source_kind,source_id,source_job_id,snapshot_id,input_revision,applied_revision,expected_draft_revision,expected_publication_revision,fingerprint,object_key,sha256,byte_length,assignment_count,shortage_acknowledged,recorded_at,origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'cancellation')`,
      )
      .bind(
        company,
        c.operationId,
        team,
        document.month,
        user,
        document.source.kind,
        document.source.id,
        document.sourceJobId,
        document.snapshotId,
        c.expectedRevision,
        c.expectedRevision + 1,
        draftRevision,
        c.expectedPublicationRevision,
        fingerprint,
        key,
        digest,
        bytes.byteLength,
        document.assignments.length,
        Number(c.acknowledgeShortage),
        recordedAt,
      ),
  ];
  for (const r of candidate.removedParticipations)
    statements.push(
      db
        .prepare(
          "INSERT INTO planning_participation_removal(company_id,operation_id,planning_id,event_id,staff_id,date,start,end) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          company,
          c.operationId,
          candidate.planningId,
          r.eventId,
          r.staffId,
          r.date,
          r.start,
          r.end,
        ),
    );
  for (let i = 0; i < document.assignments.length; i += 100)
    statements.push(
      db
        .prepare(
          `INSERT INTO schedule_publication_assignment(company_id,publication_id,team_id,staff_id,date,shift,worked_minutes,staff_number,staff_name)
 SELECT ?,?,?,json_extract(a.value,'$.staffId'),json_extract(a.value,'$.date'),COALESCE(json_extract(a.value,'$.shift'),'null'),COALESCE(json_extract(a.value,'$.shift.workedMinutes'),0),s.staff_number,s.name FROM json_each(?) a JOIN staff s ON s.company_id=? AND s.team_id=? AND s.id=json_extract(a.value,'$.staffId')`,
        )
        .bind(
          company,
          c.operationId,
          team,
          JSON.stringify(
            document.assignments
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
      .bind(company, c.operationId, team, document.month, recordedAt),
    db
      .prepare(
        `INSERT INTO schedule_publication_notice(company_id,publication_id,team_id,user_id) SELECT t.company_id,?,t.team_id,t.user_id FROM team_member t JOIN access_state a ON a.user_id=t.user_id WHERE t.company_id=? AND t.team_id=? AND a.enabled=1`,
      )
      .bind(c.operationId, company, team),
    db
      .prepare(
        "INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,'schedule:cancelled',?,?)",
      )
      .bind(company, c.operationId, user, c.expectedRevision + 1, recordedAt),
    db
      .prepare(
        "INSERT INTO schedule_publication_commit(company_id,publication_id) VALUES (?,?)",
      )
      .bind(company, c.operationId),
  );
  statements.push(publicationCompletionGuard(db,document,key,digest,bytes.byteLength,fingerprint),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM leave_cancellation_operation o
      JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id
      JOIN leave_effective_head h ON h.company_id=r.company_id AND h.request_id=r.id
      JOIN staff s ON s.company_id=r.company_id AND s.id=r.staff_id
      JOIN leave_cancellation_notice n ON n.company_id=o.company_id AND n.event_id=o.id AND n.request_id=r.id AND n.user_id=s.user_id
      WHERE o.company_id=? AND o.id=? AND o.request_id=? AND o.team_id=? AND o.actor_id=? AND o.fingerprint=?
        AND h.decision_id=o.id AND h.revision=o.request_revision+1
        AND h.status=CASE WHEN r.kind='ABSENCE_FACT' THEN 'CANCELLATION_CONFIRMED' ELSE 'APPROVED' END
        AND n.kind=h.status AND n.recorded_at=o.recorded_at
        AND o.removed_count=(SELECT count(*) FROM planning_participation_removal WHERE company_id=o.company_id AND operation_id=o.id)
    ) THEN 1 ELSE abs(-9223372036854775808) END AS cancellation_saved`)
      .bind(company,c.operationId,request,team,user,fingerprint));
  try {
    await db.batch(statements);
  } catch (error) {
    const retry = await replay();
    if (retry) return retry;
    await requireManager(db, company, team, user);
    for (const code of [
      "LEAVE_FORBIDDEN",
      "LEAVE_VERSION_CONFLICT",
      "LEAVE_PUBLICATION_CONFLICT",
      "LEAVE_FIXED_RELEASE_REQUIRED",
      "VERSION_CONFLICT",
      "CANCELLATION_PUBLICATION_CONFLICT",
      "CANCELLATION_COMMIT_CONFLICT",
      "CANCELLATION_FACT_CONFLICT",
    ])
      if (String(error).includes(code))
        throw new ProductError(code, code.endsWith("FORBIDDEN") ? 403 : 409);
    if (String(error).includes("UNIQUE constraint"))
      throw new ProductError("OPERATION_ID_CONFLICT");
    throw error;
  }
  const saved = await replay();
  if (!saved) throw new Error("CANCELLATION_COMMIT_MISSING");
  return { ...saved, replayed: false };
}
