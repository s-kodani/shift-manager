import {SCHEDULE_JSON_LIMIT,encodeStoredSchedule,decodeStoredSchedule,scheduleObjectMetadata} from './schedule-serialization';
import { z } from "zod";
import type { InputDatabase } from "./input-versions";
import { ProductError, requireManager } from "./product";
import { boundedBytes } from "./compute-jobs";
import { publicationEvidence } from "./schedule-publications";
import { compileInput, loadSources, sha256 } from "./input-snapshots";
import { ensureFixedSource } from "./published-fixed";
import { draftValidation } from "./draft-contract";
import type { ContainerTransport, ExecutionResult } from "./compute-execution";
import {
  revalidationCertificate,
  revalidationMessage,
  revalidationSummary,
  revalidationRetry,
  type RevalidationMessage,
} from "./revalidation-contract";
type Environment = { DB: InputDatabase; INPUTS: R2Bucket };
type RequestRow = {
  company_id: string;
  id: string;
  team_id: string;
  month: string;
  publication_id: string;
  required_revision: number;
  state: string;
  attempt: number;
  lease_until: number;
};
export const revalidationRequest = (
  db: InputDatabase,
  m: RevalidationMessage,
) =>
  db
    .prepare(
      "SELECT * FROM publication_revalidation_request WHERE company_id=? AND team_id=? AND id=?",
    )
    .bind(m.companyId, m.teamId, m.requestId)
    .first<RequestRow>();
const current = (db: InputDatabase, r: RequestRow) =>
  db
    .prepare(
      "SELECT 1 FROM publication_validation_head WHERE company_id=? AND team_id=? AND month=? AND publication_id=? AND required_revision=?",
    )
    .bind(
      r.company_id,
      r.team_id,
      r.month,
      r.publication_id,
      r.required_revision,
    )
    .first();
type Certificate = z.infer<typeof revalidationCertificate>;
async function storeJson(
  bucket: R2Bucket,
  key: string,
  value: unknown,
  limit: number,
) {
  const bytes = await encodeStoredSchedule(value,new Error("REVALIDATION_OBJECT_TOO_LARGE"),limit);
  const digest = await sha256(bytes);
  const stored = await bucket.put(key, bytes, {
    sha256: digest,
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: scheduleObjectMetadata(bytes),
  });
  if (!stored) throw new Error("REVALIDATION_OBJECT_NOT_WRITTEN");
  return { key, digest, size: bytes.byteLength };
}
async function finish(env: Environment, c: Certificate) {
  const certificate = revalidationCertificate.parse(c);
  const object = await storeJson(
    env.INPUTS,
    `companies/${c.companyId}/teams/${c.teamId}/revalidation/${c.requestId}/${c.attempt}/results/${crypto.randomUUID()}.json`,
    certificate,
    8_000_000,
  );
  // Uploaded objects survive uncertain DB failures. GC must prove absence of a
  // manifest after a grace period, never delete on an ambiguous write response.
  await env.DB.prepare(
    "INSERT INTO publication_revalidation_result(company_id,id,request_id,attempt,input_revision,status,object_key,sha256,byte_length,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      c.companyId,
      c.id,
      c.requestId,
      c.attempt,
      c.inputRevision,
      c.status,
      object.key,
      object.digest,
      object.size,
      c.recordedAt,
    )
    .run();
}
function certificate(r: RequestRow, inputRevision: number): Certificate {
  return {
    schemaVersion: "publication-revalidation-v1",
    id: crypto.randomUUID(),
    companyId: r.company_id,
    teamId: r.team_id,
    month: r.month,
    publicationId: r.publication_id,
    requestId: r.id,
    attempt: r.attempt,
    requiredRevision: r.required_revision,
    inputRevision,
    inputSha256: null,
    publicationSha256: null,
    status: "FAILED",
    validation: null,
    failureCode: null,
    recordedAt: Date.now(),
  };
}
// Only called inside the team's exclusive DO RPC, AFTER confirmed process stop.
// Lease expiry by itself does not authorize reclaiming a running checker.
export async function recoverInterruptedRevalidation(
  env: Environment,
  data: RevalidationMessage,
) {
  const m = revalidationMessage.parse(data),
    r = await revalidationRequest(env.DB, m);
  if (r?.state !== "RUNNING") return;
  const revision = await env.DB.prepare(
    "SELECT revision FROM company WHERE id=?",
  )
    .bind(m.companyId)
    .first<number>("revision");
  if (revision === null) throw new Error("REVALIDATION_COMPANY_MISSING");
  await finish(env, {
    ...certificate(r, revision),
    status: "PROCESS_INTERRUPTED",
    failureCode: "PROCESS_INTERRUPTED",
  });
}
export async function executeRevalidation(
  env: Environment,
  data: RevalidationMessage,
  transport: ContainerTransport,
  terminate: () => Promise<void>,
): Promise<ExecutionResult> {
  const m = revalidationMessage.parse(data),
    old = await revalidationRequest(env.DB, m);
  if (!old || ["SUCCEEDED", "FAILED", "SUPERSEDED"].includes(old.state))
    return "DONE";
  if (old.state === "RUNNING") return "BUSY";
  if (!(await current(env.DB, old))) {
    await env.DB.prepare(
      "UPDATE publication_revalidation_request SET state='SUPERSEDED' WHERE company_id=? AND id=? AND state='PENDING'",
    )
      .bind(m.companyId, m.requestId)
      .run();
    return "DONE";
  }
  const claimed = await env.DB.prepare(
    "UPDATE publication_revalidation_request SET state='RUNNING',attempt=attempt+1,lease_until=?,delivery_due=? WHERE company_id=? AND team_id=? AND id=? AND state='PENDING' AND attempt=?",
  )
    .bind(
      Date.now() + 120_000,
      Date.now() + 120_000,
      m.companyId,
      m.teamId,
      m.requestId,
      old.attempt,
    )
    .run();
  if (claimed.meta.changes !== 1) return "BUSY";
  const r = { ...old, attempt: old.attempt + 1, state: "RUNNING" };
  let c = certificate(
    r,
    (await env.DB.prepare("SELECT revision FROM company WHERE id=?")
      .bind(m.companyId)
      .first<number>("revision"))!,
  );
  try {
    await ensureFixedSource(env, m.companyId, m.teamId, r.publication_id);
    const sources = await loadSources(env.DB, m.companyId, m.teamId, r.month);
    c.inputRevision = sources.revision;
    const frozenSources = await storeJson(
      env.INPUTS,
      `companies/${m.companyId}/teams/${m.teamId}/revalidation/${m.requestId}/${r.attempt}/sources/${crypto.randomUUID()}.json`,
      {
        schemaVersion: "publication-revalidation-source-v1",
        companyId: m.companyId,
        teamId: m.teamId,
        month: r.month,
        requestId: m.requestId,
        attempt: r.attempt,
        sources,
      },
      4_000_000,
    );
    await env.DB.prepare(
      "INSERT INTO publication_revalidation_source(company_id,request_id,attempt,input_revision,object_key,sha256,byte_length) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(
        m.companyId,
        m.requestId,
        r.attempt,
        sources.revision,
        frozenSources.key,
        frozenSources.digest,
        frozenSources.size,
      )
      .run();
    const evidence = await publicationEvidence(
      env,
      m.companyId,
      m.teamId,
      r.publication_id,
    );
    if (sources.publication?.id !== r.publication_id)
      throw new Error("REVALIDATION_SOURCE_CHANGED");
    // Check the immutable published work, with its own recorded exceptions and
    // locks. An unrelated unpublished draft must not grant new exceptions.
    const compiled = compileInput(
      m.companyId,
      m.teamId,
      r.month,
      crypto.randomUUID(),
      sources,
      {
        locks: evidence.document.locks,
        exceptions: evidence.document.exceptions,
      },
      { registrationValidation: false },
    );
    compiled.input.attempt = r.attempt;
    const input = await storeJson(
      env.INPUTS,
      `companies/${m.companyId}/teams/${m.teamId}/revalidation/${m.requestId}/${r.attempt}/inputs/${crypto.randomUUID()}.json`,
      compiled.input,
      4_000_000,
    );
    c.publicationSha256 = evidence.row.sha256;
    await env.DB.prepare(
      "INSERT INTO publication_revalidation_input(company_id,request_id,attempt,input_revision,object_key,sha256,byte_length,lineage,publication_sha256) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        m.companyId,
        m.requestId,
        r.attempt,
        sources.revision,
        input.key,
        input.digest,
        input.size,
        JSON.stringify(compiled.lineage),
        evidence.row.sha256,
      )
      .run();
    // A failed/uncertain manifest write is a processing failure, not a
    // certified input reference. Its uploaded object is retained for recovery.
    c.inputSha256 = input.digest;
    const payload = {
      input: compiled.input,
      assignments: evidence.document.assignments,
    };
    if (
      new TextEncoder().encode(JSON.stringify(payload)).byteLength > SCHEDULE_JSON_LIMIT
    )
      throw new Error("CHECK_PAYLOAD_TOO_LARGE");
    const response = await transport("/check", payload);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 400) {
        c.status = "INPUT_INVALID";
        c.failureCode = "CHECK_INPUT_INVALID";
      } else throw new Error("CHECK_TRANSPORT_FAILED");
    } else {
      const v = draftValidation.parse(
        JSON.parse(
          new TextDecoder().decode(
            await boundedBytes(response.body, SCHEDULE_JSON_LIMIT),
          ),
        ),
      );
      c.status = v.status;
      c.validation = v;
    }
    c = revalidationCertificate.parse(c);
  } catch (error) {
    c = {
      ...c,
      status:
        error instanceof ProductError && error.status === 400
          ? "INPUT_INVALID"
          : "FAILED",
      validation: null,
      failureCode:
        error instanceof ProductError && error.status === 400
          ? error.code
          : "REVALIDATION_FAILED",
    };
  } finally {
    await terminate();
  }
  c.recordedAt = Date.now();
  await finish(env, c);
  const latest = await revalidationRequest(env.DB, m);
  return latest?.state === "PENDING" ? "RETRY" : "DONE";
}
export async function dispatchRevalidations(
  db: InputDatabase,
  queue: Pick<Queue, "send">,
  company?: string,
) {
  const now = Date.now();
  const rows = await db
    .prepare(
      "SELECT company_id,id,team_id FROM publication_revalidation_request WHERE (state='PENDING' OR (state='RUNNING' AND lease_until<=?)) AND delivery_due<=? AND (? IS NULL OR company_id=?) ORDER BY created_at,id LIMIT 25",
    )
    .bind(now, now, company ?? null, company ?? null)
    .all<{ company_id: string; id: string; team_id: string }>();
  for (const r of rows.results) {
    const message = revalidationMessage.parse({
      version: 1,
      kind: "publication-revalidation",
      companyId: r.company_id,
      teamId: r.team_id,
      requestId: r.id,
    });
    try {
      await queue.send(message);
      await db
        .prepare(
          "UPDATE publication_revalidation_request SET delivery_due=? WHERE company_id=? AND id=? AND state IN ('PENDING','RUNNING') AND delivery_due<=?",
        )
        .bind(now + 120_000, r.company_id, r.id, now)
        .run();
    } catch {
      /* Durable outbox stays due; cron redelivers without rolling back input. */
    }
  }
}
export async function validationSummary(
  db: InputDatabase,
  company: string,
  team: string,
  month: string,
  publicationId: string,
) {
  const h = await db
    .prepare(
      `SELECT h.required_revision,h.validation_id,v.status,v.input_revision,r.id AS request_id,r.state,r.attempt,p.applied_revision
  FROM publication_validation_head h JOIN schedule_publication_version p ON p.company_id=h.company_id AND p.id=h.publication_id
  LEFT JOIN publication_revalidation_result v ON v.company_id=h.company_id AND v.id=h.validation_id
  LEFT JOIN publication_revalidation_request r ON r.company_id=h.company_id AND r.publication_id=h.publication_id AND r.required_revision=h.required_revision
  WHERE h.company_id=? AND h.team_id=? AND h.month=? AND h.publication_id=?`,
    )
    .bind(company, team, month, publicationId)
    .first<{
      required_revision: number;
      validation_id: string | null;
      status: string | null;
      input_revision: number | null;
      request_id: string | null;
      state: string | null;
      attempt: number | null;
      applied_revision: number;
    }>();
  if (!h) return null; // Historical publication: use its original certificate.
  return revalidationSummary.parse({
    status: h.status ?? h.state ?? "ORIGINAL_VERIFIED",
    requiredRevision: h.required_revision,
    inputRevision: h.input_revision,
    requestId: h.request_id,
    attempt: h.attempt ?? 0,
    validationId: h.validation_id,
  });
}
export async function revalidationHistory(
  env: Environment,
  company: string,
  team: string,
  user: string,
  publicationId: string,
) {
  await requireManager(env.DB, company, team, user);
  const results = await env.DB.prepare(
    `SELECT v.id AS validationId,v.status,v.input_revision AS inputRevision,r.required_revision AS requiredRevision,r.id AS requestId,v.attempt,v.recorded_at AS recordedAt
 FROM publication_revalidation_result v JOIN publication_revalidation_request r ON r.company_id=v.company_id AND r.id=v.request_id WHERE r.company_id=? AND r.team_id=? AND r.publication_id=? ORDER BY v.recorded_at DESC,v.attempt DESC LIMIT 100`,
  )
    .bind(company, team, publicationId)
    .all();
  await requireManager(env.DB, company, team, user);
  return { versions: results.results };
}
export async function readRevalidation(
  env: Environment,
  company: string,
  team: string,
  user: string,
  id: string,
) {
  await requireManager(env.DB, company, team, user);
  const r = await env.DB.prepare(
    `SELECT v.*,r.team_id,r.publication_id,r.required_revision,r.month,i.sha256 AS input_sha256,p.sha256 AS publication_sha256
     FROM publication_revalidation_result v JOIN publication_revalidation_request r ON r.company_id=v.company_id AND r.id=v.request_id
     JOIN schedule_publication_version p ON p.company_id=r.company_id AND p.id=r.publication_id
     LEFT JOIN publication_revalidation_input i ON i.company_id=v.company_id AND i.request_id=v.request_id AND i.attempt=v.attempt
     WHERE v.company_id=? AND r.team_id=? AND v.id=?`,
  )
    .bind(company, team, id)
    .first<{
      id: string;
      request_id: string;
      attempt: number;
      input_revision: number;
      status: string;
      object_key: string;
      sha256: string;
      byte_length: number;
      publication_id: string;
      required_revision: number;
      month: string;
      recorded_at: number;
      input_sha256: string | null;
      publication_sha256: string;
    }>();
  if (!r) throw new ProductError("NOT_FOUND", 404);
  const object = await env.INPUTS.get(r.object_key);
  if (!object || object.size !== r.byte_length)
    throw new Error("REVALIDATION_OBJECT_MISSING");
  const bytes = await boundedBytes(object.body, r.byte_length);
  if (bytes.byteLength !== r.byte_length || (await sha256(bytes)) !== r.sha256)
    throw new Error("REVALIDATION_DIGEST_MISMATCH");
  const c = revalidationCertificate.parse(
    await decodeStoredSchedule(bytes),
  );
  if (
    c.id !== r.id ||
    c.companyId !== company ||
    c.teamId !== team ||
    c.publicationId !== r.publication_id ||
    c.month !== r.month ||
    c.requestId !== r.request_id ||
    c.attempt !== r.attempt ||
    c.requiredRevision !== r.required_revision ||
    c.inputRevision !== r.input_revision ||
    c.status !== r.status ||
    c.recordedAt !== r.recorded_at ||
    (c.inputSha256 !== null && c.inputSha256 !== r.input_sha256) ||
    (c.publicationSha256 !== null &&
      c.publicationSha256 !== r.publication_sha256)
  )
    throw new Error("REVALIDATION_IDENTITY_MISMATCH");
  const summary = await validationSummary(
    env.DB,
    company,
    team,
    r.month,
    r.publication_id,
  );
  await requireManager(env.DB, company, team, user);
  return { certificate: c, adopted: summary?.validationId === id };
}
export async function retryRevalidation(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  requestId: string,
  data: z.infer<typeof revalidationRetry>,
) {
  const c = revalidationRetry.parse(data);
  revalidationMessage.shape.requestId.parse(requestId);
  await requireManager(db, company, team, user);
  const fingerprint = await sha256(
    new TextEncoder().encode(
      JSON.stringify({ company, team, user, requestId, ...c }),
    ),
  );
  const replay = async () => {
    const r = await db
      .prepare(
        "SELECT fingerprint FROM publication_revalidation_retry WHERE company_id=? AND id=?",
      )
      .bind(company, c.operationId)
      .first<{ fingerprint: string }>();
    if (r && r.fingerprint !== fingerprint)
      throw new ProductError("OPERATION_ID_CONFLICT");
    if (r) await requireManager(db, company, team, user);
    return r !== null;
  };
  if (await replay()) return { queued: true, replayed: true };
  const r = await revalidationRequest(db, {
    version: 1,
    kind: "publication-revalidation",
    companyId: company,
    teamId: team,
    requestId,
  });
  if (!r) throw new ProductError("NOT_FOUND", 404);
  try {
    await db
      .prepare(
        "INSERT INTO publication_revalidation_retry(company_id,id,request_id,actor_id,expected_revision,expected_attempt,required_revision,fingerprint,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        company,
        c.operationId,
        requestId,
        user,
        c.expectedRevision,
        c.expectedAttempt,
        c.requiredRevision,
        fingerprint,
        Date.now(),
      )
      .run();
  } catch (error) {
    await requireManager(db, company, team, user);
    if (await replay()) return { queued: true, replayed: true };
    if (String(error).includes("REVALIDATION_RETRY_CONFLICT"))
      throw new ProductError("VERSION_CONFLICT");
    throw error;
  }
  return { queued: true, replayed: false };
}
