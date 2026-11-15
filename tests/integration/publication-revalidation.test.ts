import {
  env,
  applyD1Migrations,
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
} from "cloudflare:test";
import { beforeAll, beforeEach, it, expect } from "vitest";
import {isCompressedSchedule} from '../../apps/api/src/schedule-serialization';
import {
  inputFixture,
  probePolicy,
  probeEmployment,
  probeConfig,
} from "../../apps/api/src/input-probes";
import {
  createInputSnapshot,
  readInputSnapshot,
  sha256,
} from "../../apps/api/src/input-snapshots";
import { createJob } from "../../apps/api/src/compute-jobs";
import {
  executeJob,
  type ContainerTransport,
} from "../../apps/api/src/compute-execution";
import {
  publishSchedule,
  readPublicationHead,
} from "../../apps/api/src/schedule-publications";
import {
  saveInputVersion,
  type ResourceTarget,
} from "../../apps/api/src/input-versions";
import { saveCalendarSettings } from "../../apps/api/src/product";
import { saveHistory } from "../../apps/api/src/work-history";
import {
  executeRevalidation,
  dispatchRevalidations,
  revalidationRequest,
  validationSummary,
  readRevalidation,
  revalidationHistory,
  recoverInterruptedRevalidation,
  retryRevalidation,
} from "../../apps/api/src/publication-revalidation";
import type { RevalidationMessage } from "../../apps/api/src/revalidation-contract";
import { handleJobMessages } from "../../apps/api/src/compute-worker";
import { optimizerAssignmentsSchema } from "../../packages/contracts/optimizer-input.generated";
let f: Awaited<ReturnType<typeof inputFixture>>, publicationId: string;
const revision = async () =>
  (await env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(f.company.companyId)
    .first<number>("revision"))!;
const validation = () => ({
  scope: "multi-task-v1",
  status: "VERIFIED",
  violations: [],
  missingHistory: [],
  generalShortage: 0,
  roleSameShortage: 0,
  roleRequirements: [],
});
const work = (month = "2026-10") =>
  optimizerAssignmentsSchema.parse(
    Array.from(
      {
        length: new Date(
          Number(month.slice(0, 4)),
          Number(month.slice(5)),
          0,
        ).getDate(),
      },
      (_, i) => ({
        staffId: f.staff.staffId,
        date: month + "-" + String(i + 1).padStart(2, "0"),
        shift:
          i === 0
            ? {
                patternId: "day",
                start: 600,
                end: 1020,
                breakKind: "fixed",
                break: [780, 840],
                workedMinutes: 360,
                cancelled: [],
              }
            : null,
        blocks:
          i === 0
            ? Array.from({ length: 14 }, (_, n) => 600 + n * 30)
                .filter((n) => ![660, 780, 810].includes(n))
                .map((start) => ({
                  start,
                  end: start + 30,
                  taskId: "phone",
                  roleId: null,
                }))
            : [],
        roleIntervals: [],
      }),
    ),
  );
async function save(
  kind: ResourceTarget["kind"],
  payload: unknown,
  month = "2026-10",
  entity?: string,
  team = f.team,
) {
  const global = kind === "company_policy" || kind === "employment_policy",
    personal = kind === "staff_contract" || kind === "staff_month";
  return saveInputVersion(
    env.DB,
    {
      company: f.company.companyId,
      team: global ? null : team,
      staff: personal ? f.staff.staffId : null,
      kind,
      entity:
        entity ??
        (kind === "company_policy"
          ? f.company.companyId
          : personal
            ? f.staff.staffId
            : team),
    },
    f.company.userId,
    {
      operationId: crypto.randomUUID(),
      expectedRevision: await revision(),
      effectiveFrom: month,
      payload,
    },
    env.INPUTS,
  );
}
async function publish(month = "2026-10") {
  if (month !== "2026-10")
    await save(
      "planning",
      { demand: [], events: [], roleRequirements: [] },
      month,
    );
  const rev = await revision(),
    sid = crypto.randomUUID();
  await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    { operationId: sid, expectedRevision: rev, month },
  );
  const job = (
    await createJob(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      {
        operationId: crypto.randomUUID(),
        snapshotId: sid,
        expectedRevision: rev,
      },
    )
  ).job;
  await executeJob(
    env,
    {
      version: 1,
      companyId: f.company.companyId,
      teamId: f.team,
      jobId: job.id,
    },
    async (path, payload) =>
      Response.json(
        path === "/solve"
          ? { ...payload, solverStatus: "FEASIBLE", assignments: work(month) }
          : validation(),
      ),
    async () => {},
  );
  const id = crypto.randomUUID();
  await publishSchedule(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    {
      operationId: id,
      expectedRevision: rev,
      expectedDraftRevision: 0,
      expectedPublicationRevision: 0,
      source: { kind: "job", id: job.id },
      acknowledgeShortage: false,
    },
    async (c) => {
      const frozen = await readInputSnapshot(
        env.DB,
        env.INPUTS,
        c.companyId,
        c.teamId,
        c.userId,
        c.snapshotId,
        true,
        true,
      );
      return {
        snapshotSha256: frozen.snapshot.sha256,
        inputSha256: await sha256(
          new TextEncoder().encode(
            JSON.stringify({
              ...frozen.input,
              locks: c.locks,
              exceptions: c.exceptions,
            }),
          ),
        ),
        validation: validation(),
      };
    },
  );
  return id;
}
const requests = async () =>
  (
    await env.DB.prepare(
      "SELECT * FROM publication_revalidation_request WHERE company_id=? ORDER BY required_revision,month",
    )
      .bind(f.company.companyId)
      .all()
  ).results;
async function message(month = "2026-10"): Promise<RevalidationMessage> {
  const r = (await requests())
    .filter((r) => r.month === month && r.state !== "SUPERSEDED")
    .at(-1)!;
  return {
    version: 1,
    kind: "publication-revalidation",
    companyId: f.company.companyId,
    teamId: f.team,
    requestId: r.id as string,
  };
}
const summary = (month = "2026-10", id = publicationId) =>
  validationSummary(env.DB, f.company.companyId, f.team, month, id);
const run = async (
  m: RevalidationMessage,
  transport: ContainerTransport = async () => Response.json(validation()),
) => executeRevalidation(env, m, transport, async () => {});
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  f = await inputFixture(env.DB, env.INPUTS);
  publicationId = await publish();
});
it("Q118: actual effective month changes enqueue atomically; future settings and unrelated employment do not invalidate October", async () => {
  await expect(
    env.DB.prepare("DELETE FROM publication_validation_head WHERE company_id=?")
      .bind(f.company.companyId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_VALIDATION_HEAD");
  expect(await summary()).toMatchObject({ status: "ORIGINAL_VERIFIED" });
  expect(await requests()).toHaveLength(0);
  await save("company_policy", probePolicy, "2026-11");
  await save(
    "employment_policy",
    probeEmployment,
    "2026-10",
    crypto.randomUUID(),
  );
  expect(await requests()).toHaveLength(0);
  expect(await summary()).toMatchObject({ status: "ORIGINAL_VERIFIED" });
  await save(
    "employment_policy",
    { ...probeEmployment, rule: { ...probeEmployment.rule, dailyMax: 300 } },
    "2026-10",
    f.employment,
  );
  expect(await requests()).toHaveLength(1);
  expect(await summary()).toMatchObject({
    status: "PENDING",
    requiredRevision: await revision(),
  });
});
it("Q118: later effective versions win over a newer backdated revision; exact monthly input never carries forward", async () => {
  await save("company_policy", probePolicy, "2026-12");
  const december = await publish("2026-12");
  await save(
    "company_policy",
    { ...probePolicy, rule: { ...probePolicy.rule, dailyMax: 400 } },
    "2026-10",
  );
  expect(await summary("2026-12", december)).toMatchObject({
    status: "ORIGINAL_VERIFIED",
  });
  expect(await summary()).toMatchObject({ status: "PENDING" });
  const before = (await requests()).length;
  await save("staff_month", { unavailable: [], preferences: [] }, "2026-11");
  expect(await requests()).toHaveLength(before);
});
it('compressed revalidation certificate can be read after the stored-byte manifest is adopted',async()=>{
 await save('company_policy',probePolicy);const m=await message(),padding='fictional'.repeat(10_000);
 expect(await run(m,async()=>Response.json({...validation(),padding}))).toBe('DONE');
 const id=(await summary())!.validationId!,r=await env.DB.prepare('SELECT object_key FROM publication_revalidation_result WHERE company_id=? AND id=?').bind(f.company.companyId,id).first<{object_key:string}>();
 expect(isCompressedSchedule(new Uint8Array(await(await env.INPUTS.get(r!.object_key))!.arrayBuffer()))).toBe(true);
 const detail=await readRevalidation(env,f.company.companyId,f.team,f.company.userId,id);
 expect(detail.certificate.validation?.padding).toBe(padding);expect(detail.adopted).toBe(true);
});
it("Q118: immutable current work and current three rule layers feed only /check; original certificate and published time remain unchanged", async () => {
  const original = await readPublicationHead(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    "2026-10",
  );
  await save("company_policy", probePolicy);
  const m = await message();
  let calls = 0,
    stopped = false;
  expect(
    await executeRevalidation(
      env,
      m,
      async (path, payload) => {
        calls++;
        expect(path).toBe("/check");
        const p = payload as {
          input: {
            mode: string;
            inputVersion: number;
            staff: { rules: unknown[] }[];
            published: unknown[];
          };
          assignments: unknown;
        };
        expect(p.input.mode).toBe("reallocation");
        expect(p.input.inputVersion).toBeGreaterThan(f.revision);
        expect(p.input.staff[0].rules).toHaveLength(3);
        expect(p.assignments).toEqual(work());
        expect(p.input.published).toHaveLength(31);
        expect(await summary()).toMatchObject({ status: "RUNNING" });
        return Response.json(validation());
      },
      async () => {
        stopped = true;
        expect(await summary()).toMatchObject({ status: "RUNNING" });
      },
    ),
  ).toBe("DONE");
  expect(stopped).toBe(true);
  expect(calls).toBe(1);
  expect(await summary()).toMatchObject({
    status: "VERIFIED",
    inputRevision: await revision(),
  });
  const current = await readPublicationHead(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    "2026-10",
  );
  expect(current.publication).toEqual(original.publication);
  expect(current).toMatchObject({ revalidationRequired: false });
  const detail = await readRevalidation(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    (await summary())!.validationId!,
  );
  expect(detail.adopted).toBe(true);
  expect(detail.certificate.validation).toMatchObject(validation());
  expect(
    await run(m, async () => {
      throw new Error("DUPLICATE_MUST_NOT_RUN");
    }),
  ).toBe("DONE");
  for (const table of [
    "publication_revalidation_input",
    "publication_revalidation_result",
  ])
    await expect(
      env.DB.prepare(`DELETE FROM ${table} WHERE company_id=?`)
        .bind(f.company.companyId)
        .run(),
    ).rejects.toThrow("IMMUTABLE_REVALIDATION");
});
it("Q118: INVALID, history missing, input incompatibility and complete metrics are separate; no result repairs published work", async () => {
  for (const v of [
    { ...validation(), status: "INVALID", violations: ["MONTHLY_MIN"] },
    {
      ...validation(),
      status: "HISTORY_UNVERIFIED",
      missingHistory: ["boundary"],
    },
  ]) {
    await save("company_policy", probePolicy);
    expect(await run(await message(), async () => Response.json(v))).toBe(
      "DONE",
    );
    expect(await summary()).toMatchObject({ status: v.status });
    expect(
      await readPublicationHead(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        "2026-10",
      ),
    ).toMatchObject({ revalidationRequired: true });
  }
  await save("company_policy", probePolicy);
  expect(
    await run(await message(), async () =>
      Response.json({
        scope: "multi-task-v1",
        status: "VERIFIED",
        violations: [],
      }),
    ),
  ).toBe("RETRY");
  expect(await summary()).toMatchObject({ status: "PENDING" });
  await save("company_policy", probePolicy);
  expect(
    await run(await message(), async () =>
      Response.json({ error: "ValueError" }, { status: 400 }),
    ),
  ).toBe("DONE");
  expect(await summary()).toMatchObject({ status: "INPUT_INVALID" });
  expect(
    (
      await readPublicationHead(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        "2026-10",
      )
    ).publication!.assignments,
  ).toEqual(work());
});
it("Q118: scoped setting race discards old result, preserves it historically, and schedules latest request", async () => {
  await save("company_policy", probePolicy);
  const old = await message();
  let newer: RevalidationMessage;
  expect(
    await run(old, async () => {
      await save("company_policy", probePolicy);
      newer = await message();
      return Response.json(validation());
    }),
  ).toBe("DONE");
  expect(await revalidationRequest(env.DB, old)).toMatchObject({
    state: "SUPERSEDED",
  });
  expect(await summary()).toMatchObject({
    status: "PENDING",
    validationId: null,
  });
  expect(
    (
      await revalidationHistory(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        publicationId,
      )
    ).versions,
  ).toHaveLength(1);
  expect(await run(newer!)).toBe("DONE");
  expect(await summary()).toMatchObject({ status: "VERIFIED" });
});
it("Q118: unrelated revision during checking prevents stale adoption but retries same request against latest frozen input", async () => {
  await save("company_policy", probePolicy);
  const m = await message();
  expect(
    await run(m, async () => {
      await save("company_policy", probePolicy, "2027-01");
      return Response.json(validation());
    }),
  ).toBe("RETRY");
  expect(await summary()).toMatchObject({
    status: "PENDING",
    validationId: null,
  });
  expect(await run(m)).toBe("DONE");
  expect(await summary()).toMatchObject({
    status: "VERIFIED",
    attempt: 2,
    inputRevision: await revision(),
  });
});
it("Q118: concurrent duplicate delivery checks once; failed process stop leaves RUNNING and cannot certify or reclaim by lease alone", async () => {
  await save("company_policy", probePolicy);
  const m = await message();
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = run(m, async () => {
    calls++;
    await gate;
    return Response.json(validation());
  });
  while ((await revalidationRequest(env.DB, m))!.state !== "RUNNING")
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(await run(m)).toBe("BUSY");
  release();
  await first;
  expect(calls).toBe(1);
  await save("company_policy", probePolicy);
  const next = await message();
  await expect(
    executeRevalidation(
      env,
      next,
      async () => Response.json(validation()),
      async () => {
        throw new Error("PROCESS_STOP_UNCONFIRMED");
      },
    ),
  ).rejects.toThrow("PROCESS_STOP_UNCONFIRMED");
  expect(await summary()).toMatchObject({
    status: "RUNNING",
    validationId: null,
  });
  await env.DB.prepare(
    "UPDATE publication_revalidation_request SET lease_until=0 WHERE company_id=? AND id=?",
  )
    .bind(next.companyId, next.requestId)
    .run();
  expect(await run(next)).toBe("BUSY");
  await recoverInterruptedRevalidation(env, next);
  expect(await summary()).toMatchObject({ status: "PENDING" });
  expect(await run(next)).toBe("DONE");
  expect(await summary()).toMatchObject({ status: "VERIFIED", attempt: 2 });
});
it("Q118: automatic failures stop at three, live manager retry is revision guarded, replayable and auditable", async () => {
  await save("company_policy", probePolicy);
  const m = await message();
  for (let i = 0; i < 3; i++)
    expect(
      await run(m, async () => {
        throw new Error("FAIL");
      }),
    ).toBe(i === 2 ? "DONE" : "RETRY");
  expect(await summary()).toMatchObject({ status: "FAILED", attempt: 3 });
  expect(await run(m)).toBe("DONE");
  const command = {
    operationId: crypto.randomUUID(),
    expectedRevision: await revision(),
    expectedAttempt: 3,
    requiredRevision: (await summary())!.requiredRevision,
  };
  await expect(
    retryRevalidation(
      env.DB,
      m.companyId,
      m.teamId,
      f.staffUser,
      m.requestId,
      command,
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    retryRevalidation(
      env.DB,
      m.companyId,
      m.teamId,
      f.company.userId,
      m.requestId,
      { ...command, expectedRevision: command.expectedRevision - 1 },
    ),
  ).rejects.toThrow("VERSION_CONFLICT");
  expect(
    await retryRevalidation(
      env.DB,
      m.companyId,
      m.teamId,
      f.company.userId,
      m.requestId,
      command,
    ),
  ).toMatchObject({ queued: true, replayed: false });
  expect(
    await retryRevalidation(
      env.DB,
      m.companyId,
      m.teamId,
      f.company.userId,
      m.requestId,
      command,
    ),
  ).toMatchObject({ replayed: true });
  expect(await run(m)).toBe("DONE");
  expect(await summary()).toMatchObject({ status: "VERIFIED", attempt: 4 });
  expect(
    (
      await revalidationHistory(
        env,
        m.companyId,
        m.teamId,
        f.company.userId,
        publicationId,
      )
    ).versions,
  ).toHaveLength(4);
});
it("Q118: revoked initiating manager does not cancel trusted background verification; certificate reads still require current management access", async () => {
  await save("company_policy", probePolicy);
  const m = await message();
  await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?")
    .bind(f.company.userId)
    .run();
  expect(await run(m)).toBe("DONE");
  await expect(
    readRevalidation(
      env,
      m.companyId,
      m.teamId,
      f.company.userId,
      (await summary())!.validationId!,
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    readRevalidation(
      env,
      m.companyId,
      m.teamId,
      f.staffUser,
      (await summary())!.validationId!,
    ),
  ).rejects.toThrow("FORBIDDEN");
});
it("Q118: outbox survives failed sending; service payload strictly excludes user, versions and R2 keys; queue ACK/retry remains distinct", async () => {
  await save("company_policy", probePolicy);
  const m = await message(),
    sent: unknown[] = [];
  await dispatchRevalidations(
    env.DB,
    {
      send: async () => {
        throw new Error("SEND_FAILED");
      },
    },
    f.company.companyId,
  );
  expect(await summary()).toMatchObject({ status: "PENDING" });
  await dispatchRevalidations(
    env.DB,
    {
      send: async (body) => {
        sent.push(body);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
    f.company.companyId,
  );
  expect(sent).toEqual([m]);
  const batch = createMessageBatch<unknown>("test", [
      { id: "1", timestamp: new Date(), attempts: 1, body: m },
      {
        id: "2",
        timestamp: new Date(),
        attempts: 1,
        body: { ...m, objectKey: "attack" },
      },
    ]),
    ctx = createExecutionContext();
  await handleJobMessages(
    batch,
    async () => {
      throw new Error("WRONG_KIND");
    },
    async (parsed) => {
      expect(parsed).toEqual(m);
      return "BUSY";
    },
  );
  const result = await getQueueResult(batch, ctx);
  expect(result.retryMessages.map((r) => r.msgId)).toEqual(["1"]);
  expect(result.explicitAcks).toEqual(["2"]);
});
it("Q118: confirmed boundary history and applicable calendar changes enqueue; original publication stays unchanged", async () => {
  await saveHistory(env.DB, f.company.companyId, f.team, f.company.userId, {
    operationId: crypto.randomUUID(),
    expectedRevision: await revision(),
    month: "2026-10",
    records: [
      {
        staffId: f.staff.staffId,
        date: "2026-09-30",
        workedMinutes: 0,
        evidence: "架空休日確認",
      },
    ],
  });
  expect(await summary()).toMatchObject({ status: "PENDING" });
  await saveCalendarSettings(env.DB, f.company.companyId, f.company.userId, {
    operationId: crypto.randomUUID(),
    expectedRevision: await revision(),
    effectiveFrom: "2026-10",
    settings: {
      weekStart: 1,
      deadlineDay: 20,
      halfDayDivider: 720,
      roleRounding: "floor",
    },
  });
  expect((await requests()).filter((r) => r.state === "PENDING")).toHaveLength(
    1,
  );
  expect(await run(await message())).toBe("DONE");
});

it("Q118: input-save audit failure rolls back the scoped watermark and durable request together", async () => {
  const before = await revision();
  await env.DB.prepare(
    "CREATE TRIGGER revalidation_reject_input_audit BEFORE INSERT ON product_audit WHEN NEW.kind='input:company_policy' BEGIN SELECT RAISE(ABORT,'CONTROLLED_AUDIT_FAILURE'); END",
  ).run();
  try {
    await expect(save("company_policy", probePolicy)).rejects.toThrow(
      "CONTROLLED_AUDIT_FAILURE",
    );
    expect(await revision()).toBe(before);
    expect(await requests()).toHaveLength(0);
    expect(await summary()).toMatchObject({ status: "ORIGINAL_VERIFIED" });
  } finally {
    await env.DB.prepare("DROP TRIGGER revalidation_reject_input_audit").run();
  }
});
it("Q118: current input incompatible with published pattern is recorded separately with frozen sources; no repair or checker claim", async () => {
  await save("team_config", {
    ...probeConfig,
    patterns: probeConfig.patterns.map((p) => ({ ...p, id: "replacement" })),
  });
  expect(
    await run(await message(), async () => {
      throw new Error("INPUT_MUST_FAIL_BEFORE_CHECK");
    }),
  ).toBe("DONE");
  expect(await summary()).toMatchObject({ status: "INPUT_INVALID" });
  const id = (await summary())!.validationId!,
    detail = await readRevalidation(
      env,
      f.company.companyId,
      f.team,
      f.company.userId,
      id,
    );
  expect(detail.certificate.validation).toBeNull();
  expect(detail.certificate.failureCode).toBe("UNKNOWN_PREFERENCE_PATTERN");
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM publication_revalidation_source WHERE company_id=?",
    )
      .bind(f.company.companyId)
      .first("n"),
  ).toBe(1);
  expect(
    (
      await readPublicationHead(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        "2026-10",
      )
    ).publication!.assignments,
  ).toEqual(work());
});

it("Q118: certificate authorization is checked again after R2 read; tenant/team identifiers cannot redirect trusted work", async () => {
  await save("company_policy", probePolicy);
  const m = await message();
  expect(await run({ ...m, teamId: crypto.randomUUID() })).toBe("DONE");
  expect(await summary()).toMatchObject({ status: "PENDING" });
  expect(await run(m)).toBe("DONE");
  const id = (await summary())!.validationId!;
  const bucket = new Proxy(env.INPUTS, {
    get(target, key) {
      if (key === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const object = await target.get(...args);
          await env.DB.prepare(
            "UPDATE access_state SET enabled=0 WHERE user_id=?",
          )
            .bind(f.company.userId)
            .run();
          return object;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    readRevalidation(
      { DB: env.DB, INPUTS: bucket },
      m.companyId,
      m.teamId,
      f.company.userId,
      id,
    ),
  ).rejects.toThrow("FORBIDDEN");
});

it("Q118: failed input manifest keeps the orphan object but produces readable failure evidence, never a certificate for uncommitted input", async () => {
  await save("company_policy", probePolicy);
  const m = await message();
  await env.DB.prepare(
    "CREATE TRIGGER revalidation_reject_manifest BEFORE INSERT ON publication_revalidation_input BEGIN SELECT RAISE(ABORT,'CONTROLLED_MANIFEST_FAILURE'); END",
  ).run();
  try {
    expect(
      await run(m, async () => {
        throw new Error("MUST_NOT_REACH_CHECKER");
      }),
    ).toBe("RETRY");
    expect(await summary()).toMatchObject({
      status: "PENDING",
      validationId: null,
    });
    const history = await revalidationHistory(
      env,
      m.companyId,
      m.teamId,
      f.company.userId,
      publicationId,
    );
    expect(history.versions).toHaveLength(1);
    const detail = await readRevalidation(
      env,
      m.companyId,
      m.teamId,
      f.company.userId,
      history.versions[0].validationId as string,
    );
    expect(detail).toMatchObject({
      adopted: false,
      certificate: { status: "FAILED", inputSha256: null, validation: null },
    });
    expect(
      (
        await env.INPUTS.list({
          prefix: `companies/${m.companyId}/teams/${m.teamId}/revalidation/${m.requestId}/1/inputs/`,
        })
      ).objects,
    ).toHaveLength(1);
  } finally {
    await env.DB.prepare("DROP TRIGGER revalidation_reject_manifest").run();
  }
});
