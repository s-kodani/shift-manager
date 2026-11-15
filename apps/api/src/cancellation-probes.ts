import {settledMaintenanceWork} from './maintenance';
// Private fictional acceptance only. Never imported by the product/local router.
import { z } from "zod";
import { createApp } from "./index";
import { inputFixture, probeConfig } from "./input-probes";
import { ProductError } from "./product";
import { createInputSnapshot, readInputSnapshot } from "./input-snapshots";
import { saveInputVersion } from "./input-versions";
import { readHistory, saveHistory } from "./work-history";
import {
  createJob,
  dispatchJobs,
  loadJob,
  readJobResult,
} from "./compute-jobs";
import { publicationDocument } from "./publication-contract";
import { cancellationCheckResult } from "./cancellation-contract";
import type { CancellationCommitCommand } from "./cancellation-contract";
const uuid = z.string().uuid(),
  password = z.string().min(24).max(128);
export const cancellationProbeCommand = z
  .object({
    probeId: uuid,
    action: z.enum([
      "start",
      "status",
      "publish",
      "cancel",
      "reallocate",
      "republish",
      "cleanup",
    ]),
    adminPassword: password.optional(),
    staffPassword: password.optional(),
  })
  .strict();
const probeResponse = z
  .object({
    error: z.string().optional(),
    status: z.string().optional(),
    replayed: z.boolean().optional(),
    publicationId: uuid.optional(),
    publicationRevision: z.number().optional(),
    found: z.boolean().optional(),
    result: z.object({ publicationId: uuid }).passthrough().optional(),
    publication: z.unknown().optional(),
    version: z
      .object({
        payload: z
          .object({ events: z.array(z.object({ staffIds: z.array(uuid) })) })
          .passthrough(),
      })
      .optional(),
    notices: z
      .array(
        z.object({ id: uuid, readAt: z.number().nullable() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();
type Command = z.infer<typeof cancellationProbeCommand>;
type Case = { name: string; passed: true };
type Metadata = {
  ids: Record<string, string>;
  commands: Record<string, unknown>;
  firstRevision?: number;
  firstDigest?: string;
  currentPublication?: string;
  currentPublicationRevision?: number;
};
type Owner = {
  id: string;
  company_id: string | null;
  team_id: string | null;
  admin_user_id: string | null;
  staff_user_id: string | null;
  stage: string;
  metadata: string;
  results: string;
  lease: string | null;
  expires_at: number;
  cleaned_at: number | null;
};
const name = (id: string) => "架空取消確定検証:" + id;
function assert(ok: unknown): asserts ok {
  if (!ok) throw Error("CANCELLATION_NATIVE_ASSERTION");
}
const privateOnly = (env: Env) => {
  if (env.ENVIRONMENT !== "poc") throw new ProductError("FORBIDDEN", 403);
};
async function owner(env: Env, id: string) {
  const o = await env.DB.prepare("SELECT * FROM cancellation_probe WHERE id=?")
    .bind(id)
    .first<Owner>();
  if (!o) throw new ProductError("NOT_FOUND", 404);
  return o;
}
async function execution(env: Env, o: Owner) {
  return o.company_id && o.team_id
    ? env.SOLVER.getByName(
        `company:${o.company_id}:team:${o.team_id}`,
      ).executionState()
    : null;
}
async function stopped(env: Env, o: Owner) {
  const s = await execution(env, o);
  if (
    s &&
    (s.activeRpc ||
      s.persistedFence ||
      s.persistedCheckFence ||
      s.processRunning)
  )
    throw new ProductError("PROBE_BUSY");
  return s;
}
export async function inspectCancellationProbe(env: Env, id: string) {
  privateOnly(env);
  uuid.parse(id);
  const o = await owner(env, id),
    m = JSON.parse(o.metadata) as Metadata;
  const jobs = o.company_id
    ? (
        await env.DB.prepare(
          "SELECT id,state,attempt,validation_status AS validationStatus,failure_code AS failureCode FROM compute_job WHERE company_id=? AND team_id=? ORDER BY created_at",
        )
          .bind(o.company_id, o.team_id)
          .all()
      ).results
    : [];
  const users =
    "SELECT user_id FROM company_admin WHERE company_id IN (SELECT id FROM company WHERE name=?) UNION SELECT user_id FROM staff WHERE company_id IN (SELECT id FROM company WHERE name=?)";
  const n = name(id),
    counts = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM access_state WHERE enabled=1 AND user_id IN (${users})) enabled,(SELECT count(*) FROM session WHERE userId IN (${users})) sessions,(SELECT count(*) FROM account WHERE password IS NOT NULL AND userId IN (${users})) passwords`,
    )
      .bind(n, n, n, n, n, n)
      .first();
  return {
    scope: "private-fictional-cancellation",
    probeId: id,
    stage: o.stage,
    busy: !!o.lease,
    expired: o.expires_at <= Date.now(),
    cleaned: o.cleaned_at !== null,
    companyId: o.company_id,
    teamId: o.team_id,
    jobs,
    execution: await execution(env, o),
    results: JSON.parse(o.results) as Case[],
    publicationId: m.currentPublication ?? null,
    publicationRevision: m.currentPublicationRevision ?? 0,
    credentials: counts,
  };
}
async function cleanup(env: Env, id: string) {
  const o = await owner(env, id);
  if (o.lease) throw new ProductError("PROBE_BUSY");
  if (
    o.company_id &&
    (await env.DB.prepare(
      "SELECT 1 FROM compute_job WHERE company_id=? AND state IN ('QUEUED','RUNNING','CANCELLING')",
    )
      .bind(o.company_id)
      .first())
  )
    throw new ProductError("PROBE_BUSY");
  await stopped(env, o);
  const users =
      "SELECT user_id FROM company_admin WHERE company_id IN (SELECT id FROM company WHERE name=?) UNION SELECT user_id FROM staff WHERE company_id IN (SELECT id FROM company WHERE name=?)",
    n = name(id);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE access_state SET enabled=0 WHERE user_id IN (${users})`,
    ).bind(n, n),
    env.DB.prepare(`DELETE FROM session WHERE userId IN (${users})`).bind(n, n),
    env.DB.prepare(
      `UPDATE account SET password=NULL WHERE userId IN (${users})`,
    ).bind(n, n),
    env.DB.prepare(`DELETE FROM verification WHERE value IN (${users})`).bind(
      n,
      n,
    ),
    env.DB.prepare(
      "UPDATE cancellation_probe SET stage='CLEANED',cleaned_at=COALESCE(cleaned_at,?) WHERE id=? AND lease IS NULL",
    ).bind(Date.now(), id),
    // A job may be accepted after the earlier idle read yielded. Keep account
    // retirement and owner closure atomic with the final active-job/lease read.
    env.DB.prepare(`SELECT CASE WHEN
      EXISTS(SELECT 1 FROM cancellation_probe WHERE id=? AND cleaned_at IS NOT NULL AND lease IS NULL)
      AND NOT EXISTS(SELECT 1 FROM compute_job WHERE company_id IN (SELECT id FROM company WHERE name=?)
        AND state IN ('QUEUED','RUNNING','CANCELLING'))
      THEN 1 ELSE abs(-9223372036854775808) END AS probe_cleanup_complete`).bind(id,n),
  ]);
  return inspectCancellationProbe(env, id);
}
export async function cleanupExpiredCancellationProbes(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT id FROM cancellation_probe WHERE expires_at<=? AND cleaned_at IS NULL AND lease IS NULL LIMIT 20",
  )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const row of rows.results)
    try {
      await cleanup(env, row.id);
    } catch {
      /* Retain ownership and retry after live jobs/processes are terminal. */
    }
}
export async function runCancellationProbe(env: Env, input: Command) {
  privateOnly(env);
  const c = cancellationProbeCommand.parse(input);
  if (c.action === "status") return inspectCancellationProbe(env, c.probeId);
  if (c.action === "cleanup") return cleanup(env, c.probeId);
  if (!c.adminPassword || !c.staffPassword)
    throw new ProductError("INVALID_INPUT", 400);
  const lease = crypto.randomUUID();
  if (c.action === "start") {
    const ids = Object.fromEntries(
      [
        "snapshot",
        "job",
        "initialPublication",
        "halfRequest",
        "factRequest",
        "leaveRequest",
        "halfCheck",
        "halfCommit",
        "noAck",
        "cancel",
        "approve",
        "reject",
        "snapshot2",
        "job2",
        "republish",
      ].map((k) => [k, crypto.randomUUID()]),
    );
    try {
      await env.DB.prepare(
        "INSERT INTO cancellation_probe(id,stage,metadata,results,lease,created_at,expires_at) VALUES (?,'PREPARING',?,'[]',?,?,?)",
      )
        .bind(
          c.probeId,
          JSON.stringify({ ids, commands: {} }),
          lease,
          Date.now(),
          Date.now() + 3600000,
        )
        .run();
    } catch {
      if (
        await env.DB.prepare("SELECT 1 FROM cancellation_probe WHERE id=?")
          .bind(c.probeId)
          .first()
      )
        throw new ProductError("PROBE_ALREADY_EXISTS");
      throw Error("PROBE_CLAIM_FAILED");
    }
  } else {
    const claimed = await env.DB.prepare(
      "UPDATE cancellation_probe SET lease=? WHERE id=? AND lease IS NULL AND cleaned_at IS NULL AND expires_at>?",
    )
      .bind(lease, c.probeId, Date.now())
      .run();
    if (claimed.meta.changes !== 1) throw new ProductError("PROBE_BUSY");
  }
  let o = await owner(env, c.probeId),
    m = JSON.parse(o.metadata) as Metadata,
    results = JSON.parse(o.results) as Case[];
  const persist = async (stage = o.stage) => {
    const changed = await env.DB.prepare(
      "UPDATE cancellation_probe SET stage=?,metadata=?,results=? WHERE id=? AND lease=? AND cleaned_at IS NULL",
    )
      .bind(stage, JSON.stringify(m), JSON.stringify(results), c.probeId, lease)
      .run();
    if (changed.meta.changes !== 1) throw Error("PROBE_OWNER_LOST");
    o = { ...o, stage };
  };
  const record = async (n: string) => {
    if (!results.some((r) => r.name === n)) {
      results.push({ name: n, passed: true });
      await persist();
    }
  };
  const freeze = async <T>(key: string, make: () => Promise<T>): Promise<T> => {
    if (!(key in m.commands)) {
      m.commands[key] = await make();
      await persist();
    }
    return m.commands[key] as T;
  };
  const app = createApp(),
    month = "2026-10";
  const request = async (
    path: string,
    body: unknown | undefined,
    cookie = "",
    expected = 200,
    bindings = env,
  ) => {
    const r = await app.request(
      env.AUTH_BASE_URL + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: env.AUTH_BASE_URL,
          "content-type": "application/json",
          cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      bindings,
    );
    const data = probeResponse.parse(await r.json());
    if (r.status !== expected || r.headers.get("cache-control") !== "no-store")
      throw Error("CANCELLATION_NATIVE_HTTP:" + r.status + ":" + expected);
    return { data, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const revision = async () =>
    (await env.DB.prepare("SELECT revision FROM company WHERE id=?")
      .bind(o.company_id)
      .first<number>("revision"))!;
  const authenticate = async (user: string, pw: string) => {
    const email = await env.DB.prepare("SELECT email FROM user WHERE id=?")
      .bind(user)
      .first<string>("email");
    return (await request("/api/auth/sign-in/email", { email, password: pw }))
      .cookie;
  };
  const base = () =>
      `/api/companies/${o.company_id}/schedules/teams/${o.team_id}`,
    inputs = () => `/api/companies/${o.company_id}/inputs/teams/${o.team_id}`;
  const head = async (cookie: string) =>
    publicationDocument.parse(
      (
        await request(
          base() + "/publications?month=" + month,
          undefined,
          cookie,
        )
      ).data.publication,
    );
  const done = async (job: string) => {
    const j = await loadJob(env.DB, o.company_id!, o.team_id!, job);
    if (!j || j.state !== "SUCCEEDED" || j.validation_status !== "VERIFIED")
      throw new ProductError("PROBE_JOB_NOT_READY");
    await stopped(env, o);
    return j;
  };
  try {
    if (c.action === "start") {
      const f = await inputFixture(env.DB, env.INPUTS, name(c.probeId));
      await env.DB.prepare(
        "UPDATE cancellation_probe SET company_id=?,team_id=?,admin_user_id=?,staff_user_id=? WHERE id=? AND lease=?",
      )
        .bind(
          f.company.companyId,
          f.team,
          f.company.userId,
          f.staffUser,
          c.probeId,
          lease,
        )
        .run();
      o = await owner(env, c.probeId);
      await env.DB.prepare(
        "UPDATE access_state SET must_change_password=1 WHERE user_id=?",
      )
        .bind(f.company.userId)
        .run();
      const change = async (user: string, initial: string, next: string) => {
        const cookie = await authenticate(user, initial);
        await request(inputs() + "/planning/" + month, undefined, cookie, 403);
        await request(
          "/api/password",
          { currentPassword: initial, newPassword: next },
          cookie,
        );
      };
      await change(
        f.company.userId,
        f.company.initialPassword,
        c.adminPassword,
      );
      await change(f.staffUser!, f.staff.initialPassword!, c.staffPassword);
      await record("native_initial_password_gates_and_changes");
      await saveInputVersion(
        env.DB,
        {
          company: o.company_id!,
          team: o.team_id!,
          staff: null,
          kind: "team_config",
          entity: o.team_id!,
        },
        o.admin_user_id!,
        {
          operationId: crypto.randomUUID(),
          expectedRevision: await revision(),
          effectiveFrom: month,
          payload: {
            ...probeConfig,
            patterns: [{ id: "day", start: 600, end: 1020, breakKind: "auto" }],
          },
        },
        env.INPUTS,
      );
      await saveInputVersion(
        env.DB,
        {
          company: o.company_id!,
          team: o.team_id!,
          staff: null,
          kind: "planning",
          entity: o.team_id!,
        },
        o.admin_user_id!,
        {
          operationId: crypto.randomUUID(),
          expectedRevision: await revision(),
          effectiveFrom: month,
          payload: {
            ...f.plan,
            events: f.plan.events.map((e) => ({ ...e, start: 690, end: 750 })),
            demand: [
              ...f.plan.demand,
              ...["2026-10-02", "2026-10-05"].flatMap((date) =>
                [600, 630].map((start) => ({
                  date,
                  start,
                  end: start + 30,
                  taskId: "phone",
                  direct: 100,
                  calculated: null,
                })),
              ),
            ],
          },
        },
        env.INPUTS,
      );
      const history = await readHistory(
        env.DB,
        env.INPUTS,
        o.company_id!,
        o.team_id!,
        o.admin_user_id!,
        month,
      );
      await saveHistory(env.DB, o.company_id!, o.team_id!, o.admin_user_id!, {
        operationId: crypto.randomUUID(),
        expectedRevision: await revision(),
        month,
        records: history.missing.map((x) => ({
          ...x,
          workedMinutes: 0,
          evidence: "架空の月境界休日・遠隔取消試験",
        })),
      });
      const command = await freeze("initialJob", async () => ({
        operationId: m.ids.job,
        snapshotId: m.ids.snapshot,
        expectedRevision: await revision(),
      }));
      await createInputSnapshot(
        env.DB,
        env.INPUTS,
        o.company_id!,
        o.team_id!,
        o.admin_user_id!,
        {
          operationId: m.ids.snapshot,
          expectedRevision: command.expectedRevision,
          month,
        },
      );
      await createJob(
        env.DB,
        env.INPUTS,
        o.company_id!,
        o.team_id!,
        o.admin_user_id!,
        command,
      );
      await persist("INITIAL_QUEUED");
      await dispatchJobs(env.DB, env.COMPUTE_QUEUE);
    } else if (c.action === "publish") {
      if (o.stage !== "INITIAL_QUEUED")
        throw new ProductError("PROBE_STAGE_CONFLICT");
      await done(m.ids.job);
      const manager = await authenticate(o.admin_user_id!, c.adminPassword),
        staff = await authenticate(o.staff_user_id!, c.staffPassword);
      const command = await freeze("initialPublication", async () => ({
        operationId: m.ids.initialPublication,
        expectedRevision: await revision(),
        expectedDraftRevision: 0,
        expectedPublicationRevision: 0,
        source: { kind: "job", id: m.ids.job },
        acknowledgeShortage: true,
      }));
      await request(base() + "/publications", command, manager);
      const original = await head(manager);
      assert(
        original.publicationId === m.ids.initialPublication &&
          original.validation.status === "VERIFIED",
      );
      m.firstRevision = original.appliedRevision;
      m.firstDigest = (await env.DB.prepare(
        "SELECT sha256 FROM schedule_publication_version WHERE company_id=? AND id=?",
      )
        .bind(o.company_id, m.ids.initialPublication)
        .first<string>("sha256"))!;
      m.currentPublication = original.publicationId;
      m.currentPublicationRevision = 1;
      await persist();
      const staffId = (await env.DB.prepare(
        "SELECT id FROM staff WHERE company_id=? AND user_id=?",
      )
        .bind(o.company_id, o.staff_user_id)
        .first<string>("id"))!;
      const intake = {
        staffId,
        date: "2026-10-01",
        kind: "ABSENCE_FACT",
        part: "FULL",
        reason: "架空の実欠勤・遠隔取消確認",
        publicationId: original.publicationId,
        expectedPublicationRevision: 1,
      };
      await request(
        base() + "/leave",
        { ...intake, operationId: m.ids.factRequest },
        manager,
      );
      await request(
        base() + "/leave",
        {
          ...intake,
          operationId: m.ids.halfRequest,
          kind: "LEAVE_REQUEST",
          part: "AM",
          reason: "架空の半日休暇・境界確認",
        },
        staff,
      );
      await request(
        base() + "/leave",
        {
          ...intake,
          operationId: m.ids.leaveRequest,
          kind: "LEAVE_REQUEST",
          date: "2026-10-02",
          reason: "架空の本人休暇・遠隔承認確認",
        },
        staff,
      );
      await record("native_verified_initial_publication_and_owned_requests");
      await persist("PUBLISHED");
    } else if (c.action === "cancel") {
      if (o.stage !== "PUBLISHED")
        throw new ProductError("PROBE_STAGE_CONFLICT");
      await stopped(env, o);
      const manager = await authenticate(o.admin_user_id!, c.adminPassword),
        staff = await authenticate(o.staff_user_id!, c.staffPassword),
        original = await head(manager);
      const command = async (
        id: string,
      ): Promise<CancellationCommitCommand> => ({
        operationId: id,
        expectedRevision: await revision(),
        expectedRequestRevision: 1,
        publicationId: m.currentPublication!,
        expectedPublicationRevision: m.currentPublicationRevision!,
        acknowledgeShortage: true,
      });
      const half = await freeze("halfCheck", () => command(m.ids.halfCheck)),
        { acknowledgeShortage: _, ...halfCheck } = half;
      const proof = cancellationCheckResult.parse(
        (
          await request(
            base() + "/leave/" + m.ids.halfRequest + "/cancellation-check",
            halfCheck,
            manager,
          )
        ).data,
      );
      assert(
        proof.validation.status === "INVALID" &&
          proof.validation.violations.some((v) =>
            v.startsWith("BREAK_QUANTITY"),
          ) &&
          proof.validation.violations.some((v) => v.startsWith("WAITING")),
      );
      const invalid = await request(
        base() + "/leave/" + m.ids.halfRequest + "/cancellation-commit",
        { ...half, operationId: m.ids.halfCommit },
        manager,
        400,
      );
      assert(invalid.data.error === "CANCELLATION_NOT_VERIFIED");
      await stopped(env, o);
      assert(JSON.stringify(await head(manager)) === JSON.stringify(original));
      await request(
        base() + "/leave/" + m.ids.factRequest + "/cancellation-check",
        halfCheck,
        staff,
        403,
      );
      await record(
        "native_half_break_waiting_rejected_and_staff_check_forbidden",
      );
      const noAck = await freeze("noAck", async () => ({
        ...(await command(m.ids.noAck)),
        acknowledgeShortage: false,
      }));
      const refused = await request(
        base() + "/leave/" + m.ids.factRequest + "/cancellation-commit",
        noAck,
        manager,
        400,
      );
      assert(refused.data.error === "PUBLICATION_SHORTAGE_ACK_REQUIRED");
      await stopped(env, o);
      await record("native_shortage_requires_acknowledgement");
      const full = await freeze("cancel", () => command(m.ids.cancel));
      const commitStatements = new WeakSet<D1PreparedStatement>();
      const failureDB = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.startsWith("INSERT INTO leave_cancellation_operation("))
                return statement;
              return new Proxy(statement, {
                get(s, k) {
                  if (k === "bind")
                    return (...args: unknown[]) => {
                      const bound = s.bind(...args);
                      commitStatements.add(bound);
                      return bound;
                    };
                  const v = Reflect.get(s, k, s);
                  return typeof v === "function" ? v.bind(s) : v;
                },
              });
            };
          if (key === "batch")
            return (statements: D1PreparedStatement[]) =>
              target.batch(
                statements.some((s) => commitStatements.has(s))
                  ? [
                      ...statements,
                      target.prepare("SELECT abs(-9223372036854775808)"),
                    ]
                  : statements,
              );
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await request(
        base() + "/leave/" + m.ids.factRequest + "/cancellation-commit",
        full,
        manager,
        500,
        { ...env, DB: failureDB },
      );
      await stopped(env, o);
      assert(JSON.stringify(await head(manager)) === JSON.stringify(original));
      assert((await revision()) === full.expectedRevision);
      assert(
        !(await env.DB.prepare(
          "SELECT 1 FROM leave_cancellation_operation WHERE company_id=? AND id=?",
        )
          .bind(o.company_id, full.operationId)
          .first()),
      );
      await record("real_D1_late_failure_rolls_back_cancel_and_publication");
      const applied = (
        await request(
          base() + "/leave/" + m.ids.factRequest + "/cancellation-commit",
          full,
          manager,
        )
      ).data;
      assert(
        applied.status === "CANCELLATION_CONFIRMED" &&
          applied.publicationRevision === 2,
      );
      await stopped(env, o);
      m.currentPublication = uuid.parse(applied.publicationId);
      m.currentPublicationRevision = 2;
      await persist();
      const replays = await settledMaintenanceWork(
        Array.from({ length: 4 }, () =>
          request(
            base() + "/leave/" + m.ids.factRequest + "/cancellation-commit",
            full,
            manager,
          ),
        ),
      );
      assert(replays.every((r) => r.data.replayed));
      await request(
        base() + "/leave/" + m.ids.factRequest + "/cancellation-commit",
        { ...full, acknowledgeShortage: false },
        manager,
        409,
      );
      const observed = await request(
        base() +
          "/leave/" +
          m.ids.factRequest +
          "/cancellation-operations/" +
          full.operationId,
        undefined,
        manager,
      );
      assert(
        observed.data.found &&
          observed.data.result?.publicationId === full.operationId,
      );
      await request(
        base() +
          "/leave/" +
          m.ids.factRequest +
          "/cancellation-operations/" +
          full.operationId,
        undefined,
        staff,
        403,
      );
      assert(
        (await request(inputs() + "/planning/" + month, undefined, manager))
          .data.version!.payload.events[0].staffIds.length === 0,
      );
      assert(
        (await head(manager)).assignments.find((a) => a.date === "2026-10-01")
          ?.shift?.workedMinutes === 0,
      );
      assert(
        JSON.stringify(
          (
            await request(
              base() + "/publications/" + m.ids.initialPublication,
              undefined,
              manager,
            )
          ).data.publication,
        ) === JSON.stringify(original),
      );
      await record(
        "native_fact_cancel_effective_participation_origin_replay_and_inspection",
      );
      const approved = await freeze("approve", () => command(m.ids.approve));
      const receipt = (
        await request(
          base() + "/leave/" + m.ids.leaveRequest + "/cancellation-commit",
          approved,
          manager,
        )
      ).data;
      assert(
        receipt.status === "APPROVED" && receipt.publicationRevision === 3,
      );
      await stopped(env, o);
      m.currentPublication = uuid.parse(receipt.publicationId);
      m.currentPublicationRevision = 3;
      await persist();
      const current = await head(manager);
      assert(
        current.cancellation?.parentPublicationId === m.ids.cancel &&
          current.assignments.find((a) => a.date === "2026-10-02")?.shift
            ?.workedMinutes === 0,
      );
      const publicStaff = z
        .object({ assignments: publicationDocument.shape.assignments })
        .passthrough()
        .parse(
          (
            await request(
              base() + "/publications?month=" + month,
              undefined,
              staff,
            )
          ).data.publication,
        );
      assert(
        publicStaff &&
          !("cancellation" in publicStaff) &&
          publicStaff!.assignments.length === 31,
      );
      const notices = (
        await request(base() + "/leave/notices", undefined, staff)
      ).data.notices!;
      assert(
        notices.filter((n: { id: string }) => n.id === m.ids.approve).length ===
          1 &&
          notices.filter((n: { id: string }) => n.id === m.ids.cancel)
            .length === 1,
      );
      await request(
        base() + "/leave/notices/" + m.ids.approve + "/read",
        {},
        staff,
      );
      assert(
        (
          await request(base() + "/leave/notices", undefined, staff)
        ).data.notices!.find((n: { id: string }) => n.id === m.ids.approve)
          ?.readAt != null,
      );
      await record(
        "native_successive_leave_approval_staff_projection_and_notice_read",
      );
      await persist("CANCELLED");
    } else if (c.action === "reallocate") {
      if (o.stage !== "CANCELLED")
        throw new ProductError("PROBE_STAGE_CONFLICT");
      await stopped(env, o);
      const command = await freeze("reallocatedJob", async () => ({
        operationId: m.ids.job2,
        snapshotId: m.ids.snapshot2,
        expectedRevision: await revision(),
      }));
      const snapshot = await createInputSnapshot(
        env.DB,
        env.INPUTS,
        o.company_id!,
        o.team_id!,
        o.admin_user_id!,
        {
          operationId: m.ids.snapshot2,
          expectedRevision: command.expectedRevision,
          month,
        },
      );
      const frozen = await readInputSnapshot(
        env.DB,
        env.INPUTS,
        o.company_id!,
        o.team_id!,
        o.admin_user_id!,
        snapshot.snapshot.id,
      );
      assert(frozen.input.events[0].staffIds.length === 0);
      await createJob(
        env.DB,
        env.INPUTS,
        o.company_id!,
        o.team_id!,
        o.admin_user_id!,
        command,
      );
      await persist("REALLOCATION_QUEUED");
      await dispatchJobs(env.DB, env.COMPUTE_QUEUE);
    } else if (c.action === "republish") {
      if (o.stage !== "REALLOCATION_QUEUED")
        throw new ProductError("PROBE_STAGE_CONFLICT");
      await done(m.ids.job2);
      const manager = await authenticate(o.admin_user_id!, c.adminPassword),
        current = await head(manager),
        snapshot = await readInputSnapshot(
          env.DB,
          env.INPUTS,
          o.company_id!,
          o.team_id!,
          o.admin_user_id!,
          m.ids.snapshot2,
        ),
        result = await readJobResult(
          env.DB,
          env.INPUTS,
          o.company_id!,
          o.team_id!,
          o.admin_user_id!,
          m.ids.job2,
        );
      assert(
        current.publicationId === m.ids.approve &&
          result.result.validation.status === "VERIFIED",
      );
      assert(
        JSON.stringify(snapshot.input.published) ===
          JSON.stringify(
            current.assignments.map(({ staffId, date, shift }) => ({
              staffId,
              date,
              shift,
            })),
          ),
      );
      await record(
        "native_reallocation_keeps_cancelled_hours_and_does_not_publish",
      );
      const command = await freeze("republish", async () => ({
        operationId: m.ids.republish,
        expectedRevision: await revision(),
        expectedDraftRevision: 0,
        expectedPublicationRevision: 3,
        source: { kind: "job", id: m.ids.job2 },
        acknowledgeShortage: true,
      }));
      const receipt = (
        await request(base() + "/publications", command, manager)
      ).data;
      assert(receipt.publicationRevision === 4);
      await stopped(env, o);
      m.currentPublication = uuid.parse(receipt.publicationId);
      m.currentPublicationRevision = 4;
      const next = await head(manager);
      assert(
        JSON.stringify(next.assignments.map((a) => a.shift)) ===
          JSON.stringify(current.assignments.map((a) => a.shift)),
      );
      assert(
        (await env.DB.prepare(
          "SELECT sha256 FROM schedule_publication_version WHERE company_id=? AND id=?",
        )
          .bind(o.company_id, m.ids.initialPublication)
          .first("sha256")) === m.firstDigest,
      );
      assert(
        (await env.DB.prepare("PRAGMA foreign_key_check").all()).results
          .length === 0,
      );
      await record(
        "native_separate_republication_preserves_all_shifts_and_original",
      );
      await persist("COMPLETE");
    }
  } finally {
    await env.DB.prepare(
      "UPDATE cancellation_probe SET lease=NULL WHERE id=? AND lease=?",
    )
      .bind(c.probeId, lease)
      .run();
  }
  return inspectCancellationProbe(env, c.probeId);
}
