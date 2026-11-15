import {
  env,
  applyD1Migrations,
  runInDurableObject,
  evictDurableObject,
} from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../../apps/api/src/index";
import { readInputChanges } from "../../apps/api/src/input-changes";
import { readInputReadiness } from "../../apps/api/src/input-readiness";
import {isCompressedSchedule} from '../../apps/api/src/schedule-serialization';
import { inputFixture, probePolicy } from "../../apps/api/src/input-probes";
import {
  createInputSnapshot,
  readInputSnapshot,
  sha256,
} from "../../apps/api/src/input-snapshots";
import { createJob, loadJob } from "../../apps/api/src/compute-jobs";
import { executeJob } from "../../apps/api/src/compute-execution";
import { checkDraftCandidate } from "../../apps/api/src/draft-check";
import {
  draftCommand,
  type CandidateCommand,
} from "../../apps/api/src/draft-contract";
import {
  saveDraft,
  readDraft,
  readDraftHead,
  type DraftVerifier,
} from "../../apps/api/src/schedule-drafts";
import {
  optimizerInputSchema,
  optimizerAssignmentsSchema,
} from "../../packages/contracts/optimizer-input.generated";
import { grantTeamAdmin } from "../../apps/api/src/product";
import { revokeTeamAdmin } from "../../apps/api/src/team-admin";
import {
  createDraftSnapshot,
  fixedDraftInput,
} from "../../apps/api/src/draft-recalculation";
import { getJob, readJobResult } from "../../apps/api/src/compute-jobs";
import {
  saveInputVersion,
  resolveVersion,
  type InputDatabase,
} from "../../apps/api/src/input-versions";
import { validateCompiledInput } from "../../apps/api/src/input-snapshots";
import { probeConfig } from "../../apps/api/src/input-probes";
import { saveStaffSubmission, setSubmissionWindow } from '../../apps/api/src/staff-submission';
import {
  setFixed,
  changePattern,
  changeBreak,
  workedMinutes,
} from "../../apps/web/product/draft-model";
// The Vitest Workers runtime has no native Container binding. Retain real DO
// SQLite/RPC but control the process adapter here; native HTTP is tested separately.
vi.mock("@cloudflare/containers", async () => {
  const { DurableObject } = await import("cloudflare:workers");
  return {
    Container: class extends DurableObject<Env> {
      constructor(state: DurableObjectState, bindings: Env) {
        super(state, bindings);
        Object.defineProperty(state, "container", {
          configurable: true,
          value: { running: false, async destroy() {} },
        });
      }
      async containerFetch(
        _request: RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> {
        throw new Error("CONTROLLED_TRANSPORT_REQUIRED");
      }
      renewActivityTimeout() {}
    },
  };
});

const monthTarget = () => ({
  company: f.company.companyId,
  team: f.team,
  staff: f.staff.staffId,
  kind: "staff_month" as const,
  entity: f.staff.staffId,
});
const unavailable = (start = 607, end = 617) => ({
  unavailable: [{ date: "2026-10-01", start, end }],
  preferences: [],
});
it('本人提出もサーバーの固定・許可済み例外だけを使用し、例外の1分拡大とチーム下書きの閲覧を拒否する',async()=>{
  const c=workingCommand();await save(c);
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();
  await setSubmissionWindow(env.DB,f.company.companyId,f.team,f.company.userId,'2026-10',{operationId:crypto.randomUUID(),expectedRevision:0,closesAt:Date.now()+60000});
  const input={operationId:crypto.randomUUID(),expectedRevision:f.revision,payload:unavailable()};
  expect(await saveStaffSubmission(env.DB,env.INPUTS,f.company.companyId,f.team,f.staffUser,'2026-10',input)).toMatchObject({replayed:false});
  await expect(saveStaffSubmission(env.DB,env.INPUTS,f.company.companyId,f.team,f.staffUser,'2026-10',{...input,operationId:crypto.randomUUID(),expectedRevision:f.revision+1,payload:unavailable(607,618)})).rejects.toThrow('EVENT_ATTENDANCE_CONFLICT');
  await expect(readDraft(env,f.company.companyId,f.team,f.staffUser,c.operationId)).rejects.toThrow('FORBIDDEN');
  expect(await env.DB.prepare('SELECT draft_id,draft_revision FROM input_registration_draft WHERE company_id=? AND operation_id=?').bind(f.company.companyId,input.operationId).first()).toEqual({draft_id:c.operationId,draft_revision:1});
});
it('本人の保存直前に固定案が変わると入力・監査・版をすべてロールバックする',async()=>{
  await save(workingCommand());
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();
  await setSubmissionWindow(env.DB,f.company.companyId,f.team,f.company.userId,'2026-10',{operationId:crypto.randomUUID(),expectedRevision:0,closesAt:Date.now()+60000});
  const db=beforeInputCommit(()=>save({...workingCommand(),expectedDraftRevision:1}));
  await expect(saveStaffSubmission(db,env.INPUTS,f.company.companyId,f.team,f.staffUser,'2026-10',{operationId:crypto.randomUUID(),expectedRevision:f.revision,payload:unavailable()})).rejects.toThrow('DRAFT_VERSION_CONFLICT');
  expect(await revision()).toBe(f.revision);
});
const registerMonth = async (
  payload = unavailable(),
  db: InputDatabase = env.DB,
) =>
  saveInputVersion(
    db,
    monthTarget(),
    f.company.userId,
    {
      operationId: crypto.randomUUID(),
      expectedRevision: (await revision()) as number,
      effectiveFrom: "2026-10",
      payload,
    },
    env.INPUTS,
  );

it("WP-02/06 HTTP: registered unavailability can retain only an approved fully fixed manual placement; registration lineage and replay remain immutable", async () => {
  const c = workingCommand();
  await save(c);
  const app = createApp(),
    base = env.AUTH_BASE_URL;
  const login = await app.request(
    base + "/api/auth/sign-in/email",
    {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        email: f.email,
        password: f.company.initialPassword,
      }),
    },
    env,
  );
  expect(login.status).toBe(200);
  const path =
    base +
    `/api/companies/${f.company.companyId}/inputs/teams/${f.team}/staff/${f.staff.staffId}/month`;
  const body = {
    operationId: crypto.randomUUID(),
    expectedRevision: f.revision,
    effectiveFrom: "2026-10",
    payload: unavailable(),
  };
  const request = () =>
    app.request(
      path,
      {
        method: "POST",
        headers: {
          origin: base,
          "content-type": "application/json",
          cookie: login.headers.get("set-cookie")!.split(";")[0],
        },
        body: JSON.stringify(body),
      },
      env,
    );
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    revision: f.revision + 1,
    replayed: false,
  });
  expect(await (await request()).json()).toMatchObject({ replayed: true });
  const ref = await env.DB.prepare(
    "SELECT draft_id,draft_revision FROM input_registration_draft WHERE company_id=? AND operation_id=?",
  )
    .bind(f.company.companyId, body.operationId)
    .first();
  expect(ref).toEqual({ draft_id: c.operationId, draft_revision: 1 });
  expect(await revision()).toBe(f.revision + 1);
  expect((await head())!.revision).toBe(1);
  const snapshot = await draftSnapshot(c.operationId, 1, f.revision + 1);
  const frozen = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    snapshot.snapshot!.id,
    true,
  );
  expect(frozen.input.staff[0].unavailable).toEqual(unavailable().unavailable);
  const {readHistory}=await import('../../apps/api/src/work-history');
  const history=await readHistory(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,'2026-10');
  expect(history.missing).toHaveLength(6);
  expect(frozen.input.exceptions[0]).toMatchObject({
    lockId: "full",
    start: 607,
    end: 617,
  });
  await expect(
    env.DB.prepare(
      "UPDATE input_registration_draft SET draft_revision=2 WHERE company_id=? AND operation_id=?",
    )
      .bind(f.company.companyId, body.operationId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_INPUT_DRAFT_SOURCE");
});
it("WP-02/06: registration cannot widen an exception by one minute or authorize an unfixed/partial/mismatched placement", async () => {
  for (const mode of ["unfixed", "partial", "mismatch", "wider"]) {
    const c = workingCommand();
    c.expectedDraftRevision = (await head())?.revision ?? 0;
    if (mode === "unfixed") c.locks = [];
    if (mode === "partial") c.locks[0].parts = ["pattern", "time"];
    if (mode === "mismatch") c.exceptions[0].date = "2026-10-02";
    await save(c);
    await expect(
      registerMonth(unavailable(607, mode === "wider" ? 618 : 617)),
    ).rejects.toThrow("EVENT_ATTENDANCE_CONFLICT");
    expect(await revision()).toBe(f.revision);
  }
});
it("Q110: event registration respects a saved full pattern instead of choosing an available alternative", async () => {
  await save(workingCommand());
  const config = {
    ...probeConfig,
    patterns: [
      ...probeConfig.patterns,
      {
        id: "alternate",
        start: 600,
        end: 1020,
        breakKind: "fixed",
        fixedBreak: [720, 780],
      },
    ],
  };
  const changed = await f.save("team_config", config);
  const plan = {
    ...f.plan,
    events: [
      ...f.plan.events,
      {
        id: "new",
        date: "2026-10-01",
        start: 787,
        end: 797,
        kind: "meeting",
        staffIds: [f.staff.staffId],
      },
    ],
  };
  await expect(f.save("planning", plan)).rejects.toThrow(
    "EVENT_ATTENDANCE_CONFLICT",
  );
  expect(await revision()).toBe(changed.revision);
  expect(
    JSON.parse(
      (await resolveVersion(
        env.DB,
        f.company.companyId,
        "planning",
        f.team,
        "2026-10",
      ))!.payload,
    ),
  ).toEqual(f.plan);
});
it.each([false, true])("unpublished fixed-to-auto settings permit recalculation without manual locks (saved draft: %s)", async savedDraft => {
  const c = workingCommand();
  c.locks = []; c.exceptions = [];
  if (savedDraft) await save(c);
  const changed = await f.save("team_config", {
    ...probeConfig, patterns: [{ id: "day", start: 600, end: 1020, breakKind: "auto" }],
  });
  const readiness = await readInputReadiness(env, f.company.companyId, f.team, f.company.userId, "2026-10");
  expect(readiness.canCompute).toBe(true);
  const next = savedDraft
    ? await draftSnapshot(c.operationId, 1, changed.revision)
    : await createInputSnapshot(env.DB, env.INPUTS, f.company.companyId, f.team, f.company.userId, {
      operationId: crypto.randomUUID(), expectedRevision: changed.revision, month: "2026-10",
    });
  const frozen = await readInputSnapshot(env.DB, env.INPUTS, f.company.companyId, f.team, f.company.userId, next.snapshot!.id, true);
  expect(frozen.input.patterns[0].breakKind).toBe("auto");
  expect(frozen.input.locks).toEqual([]);
  expect(frozen.input.events).toEqual(f.plan.events);
});
it("Q110: explicitly fixed automatic break cannot move to admit an event, while an unfixed break can", async () => {
  const frozen = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    snapshotId,
  );
  const input = structuredClone(frozen.input);
  input.patterns = [{ id: "day", start: 600, end: 1020, breakKind: "auto" }];
  input.events = [
    {
      id: "new",
      date: "2026-10-01",
      start: 787,
      end: 797,
      kind: "meeting",
      staffIds: [f.staff.staffId],
    },
  ];
  expect(() => validateCompiledInput(input)).not.toThrow();
  const c = workingCommand();
  c.locks[0].shift!.breakKind = "auto";
  c.locks[0].parts = ["break"];
  input.locks = c.locks;
  expect(() => validateCompiledInput(input)).toThrow(
    "EVENT_ATTENDANCE_CONFLICT",
  );
  input.locks = [];
  expect(() => validateCompiledInput(input)).not.toThrow();
});
function beforeInputCommit(action: () => Promise<unknown>): InputDatabase {
  let insert = false,
    fired = false;
  return {
    prepare: (sql: string) => {
      if (sql.startsWith("INSERT INTO input_operation")) insert = true;
      return env.DB.prepare(sql);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (insert && !fired) {
        fired = true;
        await action();
      }
      return env.DB.batch<T>(statements);
    },
  };
}
it("WP-02/06: unfix after R2 verification rolls back input operation, version, company revision and audit atomically", async () => {
  await save(workingCommand());
  const db = beforeInputCommit(() =>
    save({ ...workingCommand(), locks: [], expectedDraftRevision: 1 }),
  );
  await expect(registerMonth(unavailable(), db)).rejects.toThrow(
    "DRAFT_VERSION_CONFLICT",
  );
  expect(await revision()).toBe(f.revision);
  expect((await head())!.revision).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM work_input_version WHERE company_id=? AND kind='staff_month'",
    )
      .bind(f.company.companyId)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM input_registration_draft WHERE company_id=? AND draft_id IS NOT NULL",
    )
      .bind(f.company.companyId)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM product_audit WHERE company_id=? AND kind='input:staff_month'",
    )
      .bind(f.company.companyId)
      .first("n"),
  ).toBe(1);
});
it("WP-02/06: a first fixed draft appearing after a no-head validation also rolls back input registration", async () => {
  const db = beforeInputCommit(() => save(workingCommand()));
  await expect(
    registerMonth({ unavailable: [], preferences: [] }, db),
  ).rejects.toThrow("DRAFT_VERSION_CONFLICT");
  expect(await revision()).toBe(f.revision);
  expect((await head())!.revision).toBe(1);
});
it("WP-02/06: approved exceptions are read from server R2 and digest tampering fails closed before registration", async () => {
  const c = workingCommand();
  await save(c);
  const row = await env.DB.prepare(
    "SELECT object_key FROM schedule_draft_version WHERE company_id=? AND id=?",
  )
    .bind(f.company.companyId, c.operationId)
    .first<{ object_key: string }>();
  const original = await (await env.INPUTS.get(row!.object_key))!.text();
  const changed = original.replace(
    "Fictional placement",
    "Fictional placemenx",
  );
  expect(changed.length).toBe(original.length);
  expect(changed).not.toBe(original);
  await env.INPUTS.put(row!.object_key, changed);
  await expect(registerMonth()).rejects.toThrow("DRAFT_DIGEST_MISMATCH");
  expect(await revision()).toBe(f.revision);
});
let f: Awaited<ReturnType<typeof inputFixture>>,
  snapshotId: string,
  jobId: string;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  f = await inputFixture(env.DB, env.INPUTS);
  snapshotId = crypto.randomUUID();
  await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    { operationId: snapshotId, expectedRevision: f.revision, month: "2026-10" },
  );
  jobId = (
    await createJob(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      {
        operationId: crypto.randomUUID(),
        snapshotId,
        expectedRevision: f.revision,
      },
    )
  ).job.id;
  // Storage/authorization tests use a controlled transport, not a solver proof.
  await executeJob(
    env,
    { version: 1, companyId: f.company.companyId, teamId: f.team, jobId },
    async (path, payload) =>
      Response.json(
        path === "/solve"
          ? { ...payload, solverStatus: "FEASIBLE", assignments: [] }
          : {
              scope: "multi-task-v1",
              status: "HISTORY_UNVERIFIED",
              violations: [],
            },
      ),
    async () => {},
  );
});
const command = () =>
  draftCommand.parse({
    operationId: crypto.randomUUID(),
    expectedRevision: f.revision,
    sourceJobId: jobId,
    expectedDraftRevision: 0,
    assignments: Array.from({ length: 31 }, (_, i) => ({
      staffId: f.staff.staffId,
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      shift: null,
      blocks: [],
    })),
    locks: [],
    exceptions: [],
  });
const checked: DraftVerifier = async (c) => {
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
  const input = optimizerInputSchema.parse({
    ...frozen.input,
    locks: c.locks,
    exceptions: c.exceptions,
  });
  return {
    snapshotSha256: frozen.snapshot.sha256,
    inputSha256: await sha256(new TextEncoder().encode(JSON.stringify(input))),
    validation: {
      scope: "multi-task-v1",
      status: "HISTORY_UNVERIFIED",
      violations: [],
      missingHistory: ["boundary"],
    },
  };
};
const save = (
  c = command(),
  verify = checked,
  e: Parameters<typeof saveDraft>[0] = env,
) => saveDraft(e, f.company.companyId, f.team, f.company.userId, c, verify);
const revision = () =>
  env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(f.company.companyId)
    .first("revision");
it('compressed draft certificates preserve source identity and current authorization',async()=>{
 const c=command(),padding='fictional'.repeat(10_000);
 await save(c,async(candidate)=>{const v=await checked(candidate) as {snapshotSha256:string;inputSha256:string;validation:object};return {...v,validation:{...v.validation,padding}};});
 const r=await env.DB.prepare('SELECT object_key FROM schedule_draft_version WHERE company_id=? AND id=?').bind(f.company.companyId,c.operationId).first<{object_key:string}>();
 expect(isCompressedSchedule(new Uint8Array(await(await env.INPUTS.get(r!.object_key))!.arrayBuffer()))).toBe(true);
 const saved=await readDraft(env,f.company.companyId,f.team,f.company.userId,c.operationId);
 expect(saved.draft.validation.padding).toBe(padding);
});
const head = () =>
  env.DB.prepare(
    "SELECT revision,draft_id FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?",
  )
    .bind(f.company.companyId, f.team, "2026-10")
    .first<{revision:number;draft_id:string|null}>();
it.each(['audit','version','head-insert','head-update'])('manual draft silent %s omission refuses the entire save and repairs the same ID',async fault=>{
  const c=command(),before=await head(),r=await revision();
  const target={audit:"BEFORE INSERT ON product_audit WHEN NEW.kind='schedule:manual_saved'",version:'BEFORE INSERT ON schedule_draft_version','head-insert':'BEFORE INSERT ON schedule_draft_head','head-update':'BEFORE UPDATE ON schedule_draft_head'}[fault];
  await env.DB.prepare(`CREATE TRIGGER draft_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
  try{
    await expect(save(c)).rejects.toThrow();expect(await head()).toEqual(before);expect(await revision()).toBe(r);
    for(const table of ['schedule_draft_version','product_audit'])expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND id=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER draft_silent_omission').run();}
  expect(await save(c)).toMatchObject({replayed:false,draftRevision:1});expect(await save(c)).toMatchObject({replayed:true,draftRevision:1});
  expect(await head()).toEqual({draft_id:c.operationId,revision:1});
});
it("WP-06 DO: a persisted compute fence rejects checks and diagnostics even after eviction", async () => {
  const stub = env.SOLVER.getByName(`draft-fence:${crypto.randomUUID()}`);
  const c = {
    companyId: f.company.companyId,
    teamId: f.team,
    userId: f.company.userId,
    snapshotId,
    assignments: command().assignments,
    locks: [],
    exceptions: [],
  };
  await runInDurableObject(stub, async (instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO compute_fence(id,payload) VALUES (1,?)",
      JSON.stringify({
        version: 1,
        companyId: c.companyId,
        teamId: c.teamId,
        jobId,
      }),
    );
    await expect(instance.checkDraft(c)).rejects.toThrow("CHECK_BUSY");
    expect(await instance.diagnoseTransport()).toEqual({ busy: true });
    expect(await instance.releaseIdleProbe()).toEqual({ released: false });
  });
  const before = await stub.executionState();
  await evictDurableObject(stub);
  const after = await stub.executionState();
  expect(after.bootId).not.toBe(before.bootId);
  expect(after.persistedFence).toBe(true);
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.checkDraft(c)).rejects.toThrow("CHECK_BUSY");
  });
});
it("WP-06 DO: checks exclude a second check and solve while awaiting controlled transport; stop failure keeps a recoverable fence", async () => {
  const stub = env.SOLVER.getByName(`draft-control:${crypto.randomUUID()}`);
  const c = {
    companyId: f.company.companyId,
    teamId: f.team,
    userId: f.company.userId,
    snapshotId,
    assignments: command().assignments,
    locks: [],
    exceptions: [],
  };
  // Real DO storage/RPC; controlled process and HTTP transport, not a native solver test.
  await runInDurableObject(stub, async (instance, state) => {
    let running = true,
      failStop = true;
    Object.defineProperty(state, "container", {
      configurable: true,
      value: {
        get running() {
          return running;
        },
        async destroy() {
          if (failStop) throw new Error("STOP_FAILED");
          running = false;
        },
      },
    });
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const transport = vi
      .spyOn(instance, "containerFetch")
      .mockImplementation(async () => {
        entered();
        await gate;
        return Response.json({
          scope: "multi-task-v1",
          status: "HISTORY_UNVERIFIED",
          violations: [],
        });
      });
    try {
      const checking = instance.checkDraft(c);
      await ready;
      await expect(instance.checkDraft(c)).rejects.toThrow("CHECK_BUSY");
      expect(
        await instance.runJob({
          version: 1,
          companyId: c.companyId,
          teamId: c.teamId,
          jobId,
        }),
      ).toBe("BUSY");
      expect(await instance.diagnoseTransport()).toEqual({ busy: true });
      expect(await instance.releaseIdleProbe()).toEqual({ released: false });
      expect(instance.executionState().persistedCheckFence).toBe(true);
      release();
      await expect(checking).rejects.toThrow("STOP_FAILED");
      expect(instance.executionState()).toMatchObject({
        activeRpc: false,
        persistedCheckFence: true,
        processRunning: true,
      });
      failStop = false;
      transport.mockImplementation(async () => {
        expect(running).toBe(false); // Recover the old process before the next /check.
        running = true;
        return Response.json({
          scope: "multi-task-v1",
          status: "HISTORY_UNVERIFIED",
          violations: [],
        });
      });
      expect((await instance.checkDraft(c)).validation.status).toBe(
        "HISTORY_UNVERIFIED",
      );
      expect(instance.executionState()).toMatchObject({
        activeRpc: false,
        persistedCheckFence: false,
        processRunning: false,
      });
    } finally {
      release();
      transport.mockRestore();
    }
  });
});
it("WP-06 DO: a surviving check fence is recovered after eviction before new check transport", async () => {
  const stub = env.SOLVER.getByName(
    `draft-check-restart:${crypto.randomUUID()}`,
  );
  const c = {
    companyId: f.company.companyId,
    teamId: f.team,
    userId: f.company.userId,
    snapshotId,
    assignments: command().assignments,
    locks: [],
    exceptions: [],
  };
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO check_fence(id,request_id) VALUES (1,?)",
      crypto.randomUUID(),
    );
  });
  const old = await stub.executionState();
  await evictDurableObject(stub);
  expect((await stub.executionState()).bootId).not.toBe(old.bootId);
  await runInDurableObject(stub, async (instance, state) => {
    let running = true,
      stops = 0;
    Object.defineProperty(state, "container", {
      configurable: true,
      value: {
        get running() {
          return running;
        },
        async destroy() {
          stops++;
          running = false;
        },
      },
    });
    const transport = vi
      .spyOn(instance, "containerFetch")
      .mockImplementation(async () => {
        expect(stops).toBe(1);
        expect(running).toBe(false);
        running = true;
        return Response.json({
          scope: "multi-task-v1",
          status: "HISTORY_UNVERIFIED",
          violations: [],
        });
      });
    try {
      await instance.checkDraft(c);
      expect(stops).toBe(2);
      expect(instance.executionState()).toMatchObject({
        persistedCheckFence: false,
        processRunning: false,
      });
    } finally {
      transport.mockRestore();
    }
  });
});
it("WP-06/Q82: manual draft versions retain independent validation and lineage without mutating computation/input or claiming solver optimality", async () => {
  const c = command(),
    first = await save(c);
  expect(first).toMatchObject({
    draftRevision: 1,
    inputRevision: f.revision,
    validationStatus: "HISTORY_UNVERIFIED",
    publication: "BLOCKED_A1",
    replayed: false,
  });
  const read = await readDraftHead(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    "2026-10",
  );
  expect(read).toMatchObject({
    draftRevision: 1,
    stale: false,
    superseded: false,
    draft: {
      draftId: c.operationId,
      origin: "manual",
      sourceJobId: jobId,
      snapshotId,
      assignments: c.assignments,
    },
  });
  expect(read.draft).not.toHaveProperty("solverStatus");
  expect(await revision()).toBe(f.revision);
  expect(
    (await loadJob(env.DB, f.company.companyId, f.team, jobId))!.state,
  ).toBe("SUCCEEDED");
  const second = { ...command(), expectedDraftRevision: 1 };
  second.assignments[0].roleIntervals = [];
  await save(second);
  expect(
    await readDraft(
      env,
      f.company.companyId,
      f.team,
      f.company.userId,
      c.operationId,
    ),
  ).toMatchObject({
    superseded: true,
    stale: false,
    draft: { assignments: c.assignments, draftRevision: 1 },
  });
  await expect(
    env.DB.prepare(
      "UPDATE schedule_draft_version SET sha256=? WHERE company_id=?",
    )
      .bind("0".repeat(64), f.company.companyId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_DRAFT");
  await expect(
    env.DB.prepare("DELETE FROM schedule_draft_version WHERE company_id=?")
      .bind(f.company.companyId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_DRAFT");
  await expect(
    env.DB.prepare(
      "UPDATE schedule_draft_head SET revision=0,draft_id=NULL WHERE company_id=?",
    )
      .bind(f.company.companyId)
      .run(),
  ).rejects.toThrow("DRAFT_INVALID_HEAD");
});
it("WP-06: known mandatory violations and inconsistent checker responses create no head, version, audit or object", async () => {
  for (const status of ["INVALID", "VERIFIED"]) {
    const c = command();
    await expect(
      save(c, async (data) => {
        const r = (await checked(data)) as { validation: object };
        return {
          ...r,
          validation: {
            scope: "multi-task-v1",
            status,
            violations: ["WORKED_MINUTES"],
          },
        };
      }),
    ).rejects.toMatchObject({
      code: "DRAFT_INVALID",
      violations: ["WORKED_MINUTES"],
    });
    expect(await head()).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM schedule_draft_version WHERE company_id=? AND id=?",
      )
        .bind(f.company.companyId, c.operationId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM product_audit WHERE company_id=? AND id=?",
      )
        .bind(f.company.companyId, c.operationId)
        .first(),
    ).toBeNull();
  }
  expect(
    (
      await env.INPUTS.list({
        prefix: `companies/${f.company.companyId}/teams/${f.team}/drafts/`,
      })
    ).objects,
  ).toHaveLength(0);
});
it("WP-06: checker identity mismatch, unavailability and busy results never become a saved draft", async () => {
  await expect(
    save(command(), async (c) => ({
      ...((await checked(c)) as object),
      snapshotSha256: "0".repeat(64),
    })),
  ).rejects.toThrow("DRAFT_CHECK_IDENTITY_MISMATCH");
  await expect(
    save(command(), async () => {
      throw new Error("CHECK_BUSY");
    }),
  ).rejects.toMatchObject({ code: "CHECK_BUSY" });
  await expect(
    save(command(), async () => {
      throw new Error("CHECK_HTTP_400");
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    save(command(), async () => {
      throw new Error("PROCESS_STOP_UNCONFIRMED");
    }),
  ).rejects.toThrow("PROCESS_STOP_UNCONFIRMED");
  expect(await head()).toBeNull();
});
it("WP-06: concurrent same-operation requests create one version/audit and historical retry cannot overwrite a later edit", async () => {
  const c = command(),
    r = await Promise.all([save(c), save(c)]);
  expect(r.map((x) => x.replayed).sort()).toEqual([false, true]);
  expect(await head()).toMatchObject({ revision: 1, draft_id: c.operationId });
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM product_audit WHERE company_id=? AND id=?",
    )
      .bind(f.company.companyId, c.operationId)
      .first("n"),
  ).toBe(1);
  const next = { ...command(), expectedDraftRevision: 1 };
  await save(next);
  expect((await save(c)).replayed).toBe(true);
  expect(await head()).toMatchObject({
    revision: 2,
    draft_id: next.operationId,
  });
  await expect(
    save({
      ...c,
      locks: [
        {
          id: "holiday",
          staffId: f.staff.staffId,
          date: "2026-10-01",
          parts: ["time"],
          shift: null,
        },
      ],
    }),
  ).rejects.toThrow("OPERATION_ID_CONFLICT");
});
it("WP-06: simultaneous different editors cannot overwrite the same head; stale head fails before another check", async () => {
  const commands = [command(), command()],
    r = await Promise.allSettled(commands.map((c) => save(c)));
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(r.find((x) => x.status === "rejected")).toMatchObject({
    reason: { code: "DRAFT_VERSION_CONFLICT" },
  });
  await expect(
    save(command(), async () => {
      throw new Error("SHOULD_NOT_CHECK");
    }),
  ).rejects.toThrow("DRAFT_VERSION_CONFLICT");
  expect(await head()).toMatchObject({ revision: 1 });
});
it("WP-06: input or permission change after verification/upload rejects adoption and retains only an unreferenced R2 object", async () => {
  const c = command();
  const bucket = {
    get: env.INPUTS.get.bind(env.INPUTS),
    put: async (...args: Parameters<R2Bucket["put"]>) => {
      const r = await env.INPUTS.put(...args);
      await f.save("company_policy", probePolicy);
      return r;
    },
  } as R2Bucket;
  await expect(
    save(c, checked, { DB: env.DB, INPUTS: bucket }),
  ).rejects.toThrow("VERSION_CONFLICT");
  expect(await head()).toBeNull();
  expect(
    (
      await env.INPUTS.list({
        prefix: `companies/${f.company.companyId}/teams/${f.team}/drafts/`,
      })
    ).objects,
  ).toHaveLength(1);
});
it("WP-06: revoked manager after permission read cannot commit an edit; final audit failure rolls back the entire head", async () => {
  const c = command();
  const db = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?")
        .bind(f.company.userId)
        .run();
      return env.DB.batch<T>(statements);
    },
  };
  await expect(
    save(c, checked, { DB: db, INPUTS: env.INPUTS }),
  ).rejects.toThrow("FORBIDDEN");
  expect(await head()).toBeNull();
  await env.DB.prepare("UPDATE access_state SET enabled=1 WHERE user_id=?")
    .bind(f.company.userId)
    .run();
  await env.DB.prepare(
    "CREATE TRIGGER draft_audit_failure BEFORE INSERT ON product_audit WHEN NEW.kind='schedule:manual_saved' BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END",
  ).run();
  try {
    await expect(save(c)).rejects.toThrow("INJECTED_FAILURE");
    expect(await head()).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM schedule_draft_version WHERE company_id=? AND id=?",
      )
        .bind(f.company.companyId, c.operationId)
        .first(),
    ).toBeNull();
  } finally {
    await env.DB.prepare("DROP TRIGGER draft_audit_failure").run();
  }
  expect(await revision()).toBe(f.revision);
});
it("WP-06: archived draft is stale after input change and tampered R2 bytes cannot be read", async () => {
  const c = command();
  await save(c);
  await f.save("company_policy", probePolicy);
  expect(
    await readDraft(
      env,
      f.company.companyId,
      f.team,
      f.company.userId,
      c.operationId,
    ),
  ).toMatchObject({ stale: true });
  const key = (await env.DB.prepare(
    "SELECT object_key FROM schedule_draft_version WHERE company_id=? AND id=?",
  )
    .bind(f.company.companyId, c.operationId)
    .first<string>("object_key"))!;
  await env.INPUTS.put(key, "{}");
  await expect(
    readDraft(
      env,
      f.company.companyId,
      f.team,
      f.company.userId,
      c.operationId,
    ),
  ).rejects.toThrow("DRAFT_OBJECT_MISSING");
});
it("WP-06: foreign company/team, normal staff and revoked managers cannot read or edit another draft", async () => {
  const c = command();
  await save(c);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await expect(
    readDraft(env, f.company.companyId, f.team, f.staffUser, c.operationId),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    readDraft(
      env,
      f.company.companyId,
      crypto.randomUUID(),
      f.company.userId,
      c.operationId,
    ),
  ).rejects.toThrow("FORBIDDEN");
  const other = await inputFixture(env.DB);
  await expect(
    readDraft(
      env,
      f.company.companyId,
      f.team,
      other.company.userId,
      c.operationId,
    ),
  ).rejects.toThrow("FORBIDDEN");
  await grantTeamAdmin(env.DB, f.company.companyId, f.team, f.company.userId, {
    operationId: crypto.randomUUID(),
    expectedRevision: f.revision,
    userId: f.staffUser,
  });
  expect(
    await readDraft(
      env,
      f.company.companyId,
      f.team,
      f.staffUser,
      c.operationId,
    ),
  ).toMatchObject({ stale: true });
  await revokeTeamAdmin(env.DB, f.company.companyId, f.team, f.company.userId, {
    operationId: crypto.randomUUID(),
    expectedRevision: f.revision + 1,
    userId: f.staffUser,
  });
  await expect(
    readDraft(env, f.company.companyId, f.team, f.staffUser, c.operationId),
  ).rejects.toThrow("FORBIDDEN");
});
it("WP-06: shared strict output contract preserves exact roles and rejects forged validation/business locks/time precision", () => {
  const a = command().assignments;
  a[0].roleIntervals = [{ start: 607, end: 617, roleId: "sv" }];
  expect(optimizerAssignmentsSchema.parse(a)[0].roleIntervals).toEqual(
    a[0].roleIntervals,
  );
  expect(() =>
    draftCommand.parse({ ...command(), validation: { status: "VERIFIED" } }),
  ).toThrow();
  expect(() =>
    draftCommand.parse({ ...command(), input: { history: [] } }),
  ).toThrow();
  expect(() =>
    draftCommand.parse({
      ...command(),
      locks: [
        {
          id: "bad",
          staffId: f.staff.staffId,
          date: "2026-10-01",
          parts: ["business"],
          shift: null,
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    optimizerAssignmentsSchema.parse([
      {
        ...a[0],
        blocks: [{ start: 607, end: 637, taskId: "phone", roleId: null }],
      },
    ]),
  ).toThrow();
  expect(
    draftCommand.parse({
      ...command(),
      exceptions: [
        {
          id: "manual",
          lockId: null,
          staffId: f.staff.staffId,
          date: "2026-10-01",
          start: 607,
          end: 617,
          reason: "Fictional manual exception",
        },
      ],
    }).exceptions[0].lockId,
  ).toBeNull();
});
it("WP-06: check-only transport uses immutable server input and does not return until termination is confirmed", async () => {
  const c: CandidateCommand = {
    companyId: f.company.companyId,
    teamId: f.team,
    userId: f.company.userId,
    snapshotId,
    assignments: command().assignments,
    locks: [],
    exceptions: [],
  };
  let stopped = false,
    paths: string[] = [];
  const r = await checkDraftCandidate(
    env,
    c,
    async (path, payload) => {
      paths.push(path);
      expect(payload).toMatchObject({
        input: {
          tenantId: f.company.companyId,
          teamId: f.team,
          inputVersion: f.revision,
          history: [],
          published: [],
        },
        assignments: c.assignments,
      });
      return Response.json({
        scope: "multi-task-v1",
        status: "HISTORY_UNVERIFIED",
        violations: [],
      });
    },
    async () => {
      stopped = true;
    },
  );
  expect(paths).toEqual(["/check"]);
  expect(stopped).toBe(true);
  expect(r.validation.status).toBe("HISTORY_UNVERIFIED");
  await expect(
    checkDraftCandidate(
      env,
      c,
      async () =>
        Response.json({
          scope: "multi-task-v1",
          status: "VERIFIED",
          violations: [],
        }),
      async () => {
        throw new Error("PROCESS_STOP_UNCONFIRMED");
      },
    ),
  ).rejects.toThrow("PROCESS_STOP_UNCONFIRMED");
});
it("WP-06 HTTP: auth, origin, shape and self-only boundaries apply before any checker RPC", async () => {
  const app = createApp(),
    base = env.AUTH_BASE_URL,
    endpoint =
      base +
      `/api/companies/${f.company.companyId}/schedules/teams/${f.team}/drafts`;
  expect((await app.request(endpoint + "?month=2026-10", {}, env)).status).toBe(
    401,
  );
  const login = await app.request(
    base + "/api/auth/sign-in/email",
    {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        email: f.email,
        password: f.company.initialPassword,
      }),
    },
    env,
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  expect(
    (
      await app.request(
        endpoint,
        {
          method: "POST",
          headers: {
            cookie,
            origin: "https://foreign.invalid",
            "content-type": "application/json",
          },
          body: JSON.stringify(command()),
        },
        env,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        endpoint,
        {
          method: "POST",
          headers: { cookie, origin: base, "content-type": "application/json" },
          body: JSON.stringify({
            ...command(),
            validation: { status: "VERIFIED" },
          }),
        },
        env,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(
        endpoint + "?month=2026-10",
        { headers: { cookie } },
        env,
      )
    ).status,
  ).toBe(200);
  expect(await head()).toBeNull();
});

function workingCommand() {
  const c = command(),
    a = c.assignments[0];
  a.shift = {
    patternId: "day",
    start: 600,
    end: 1020,
    breakKind: "fixed",
    break: [780, 840],
    workedMinutes: 360,
    cancelled: [],
  };
  a.blocks = [{ start: 600, end: 630, taskId: "phone", roleId: null }];
  c.locks = [
    {
      id: "full",
      staffId: a.staffId,
      date: a.date,
      parts: ["pattern", "time", "break"],
      shift: structuredClone(a.shift),
    },
  ];
  c.exceptions = [
    {
      id: "manual",
      lockId: null,
      staffId: a.staffId,
      date: a.date,
      start: 607,
      end: 617,
      reason: "Fictional placement",
    },
  ];
  return c;
}
const draftSnapshot = (
  id: string,
  revision = 1,
  expectedRevision = f.revision,
  operationId = crypto.randomUUID(),
  e: Parameters<typeof createDraftSnapshot>[0] = env,
) =>
  createDraftSnapshot(e, f.company.companyId, f.team, f.company.userId, id, {
    operationId,
    expectedRevision,
    expectedDraftRevision: revision,
  });
it('input differences preserve current manual locks, show unfixing, and reject a new head during the final disclosure read',async()=>{
  const c=workingCommand();await save(c);
  const frozen=await draftSnapshot(c.operationId);
  const id=frozen.snapshot!.id;
  const readChanges=(expectedDraftRevision:number,e:Parameters<typeof readInputChanges>[0]=env)=>
    readInputChanges(e,f.company.companyId,f.team,f.company.userId,id,{expectedRevision:f.revision,expectedDraftRevision,offset:0});
  expect(await readChanges(1)).toMatchObject({total:0,changes:[]});
  await save({...c,operationId:crypto.randomUUID(),expectedDraftRevision:1,locks:[]});
  const unfix=await readChanges(2);
  expect(unfix.changes.some(row=>row.path[0]==='locks'&&row.after===undefined)).toBe(true);
  expect(unfix.changes.find(row=>row.path[0]==='sources'&&row.path[1]==='manual_draft')).toMatchObject({before:1,after:2});
  function wrap(s:D1PreparedStatement):D1PreparedStatement {
    return new Proxy(s,{get(target,key){
      if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values));
      if(key==='first')return async<T>(column?:string)=>{
        await save({...c,operationId:crypto.randomUUID(),expectedDraftRevision:2});
        return column?target.first<T>(column):target.first<T>();
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
  }
  const DB={batch:env.DB.batch.bind(env.DB),prepare:(sql:string)=>sql.includes('AS authorized')?wrap(env.DB.prepare(sql)):env.DB.prepare(sql)};
  await expect(readChanges(2,{...env,DB})).rejects.toThrow('DRAFT_VERSION_CONFLICT');
  expect(await head()).toMatchObject({revision:3});
});
it('opt-in recalculation transports the integrity-read draft as advisory with only authorized snapshot locks (controlled checker)',async()=>{
 const c=workingCommand();await save(c);
 const snapshot=await draftSnapshot(c.operationId);
 const snapshotId=snapshot.snapshot?.id;if(!snapshotId)throw new Error('TEST_SNAPSHOT_MISSING');
 const frozen=await readInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,snapshotId,true);
 const job=await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),snapshotId,expectedRevision:f.revision});
 let checked=0,stopped=0;
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-seed-v1'},
  {version:1,companyId:f.company.companyId,teamId:f.team,jobId:job.job.id},async(path,payload)=>{
   if(path==='/solve'){
    const envelope=payload as {schemaVersion:string;input:typeof frozen.input;savedCandidate:{source:object;assignments:unknown[]}};
    expect(envelope.schemaVersion).toBe('solve-seed-v1');
    expect(envelope.savedCandidate).toEqual({source:{draftId:c.operationId,draftRevision:1},assignments:c.assignments});
    expect(envelope.input.locks).toEqual(c.locks);expect(envelope.input.exceptions).toEqual(frozen.input.exceptions);
    return Response.json({...envelope.input,assignments:c.assignments,solverStatus:'FEASIBLE',validation:{status:'INVALID'},calculationProfile:'mvp-joint-seed-v1',savedCandidateSource:envelope.savedCandidate.source,metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4'}});
   }
   checked++;expect((payload as {input:typeof frozen.input}).input.locks).toEqual(c.locks);
   return Response.json({status:'VERIFIED',scope:'multi-task-v1',violations:[]});
  },async()=>{stopped++;});
 expect(stopped).toBe(1);expect(checked).toBe(1);
 const result=await readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,job.job.id);
 expect(result.result.validation.status).toBe('VERIFIED');expect(result.result.snapshotId).toBe(snapshotId);
});
it("WP-06/Q92: recalculation carries only explicit locks and fully fixed matching exceptions; no tasks or edited assignments become automatic locks", () => {
  const c = workingCommand(),
    old = structuredClone(c);
  expect(fixedDraftInput(c)).toEqual({
    locks: c.locks,
    exceptions: [{ ...c.exceptions[0], lockId: "full" }],
  });
  c.locks[0].parts = ["time"];
  expect(fixedDraftInput(c).exceptions).toEqual([]);
  c.locks = [];
  expect(fixedDraftInput(c)).toEqual({ locks: [], exceptions: [] });
  expect(old.assignments[0].blocks.length).toBe(1);
  const mismatch = structuredClone(old);
  mismatch.locks[0].shift!.break = [750, 810];
  expect(fixedDraftInput(mismatch).exceptions).toEqual([]);
  expect(fixedDraftInput(old)).not.toHaveProperty("assignments");
});
it("WP-06: derived snapshot freezes current conditions plus fixed scope, records immutable draft lineage, and cannot be bypassed by a normal snapshot", async () => {
  const c = workingCommand();
  await save(c);
  const operationId = crypto.randomUUID(),
    responses = await Promise.all([
      draftSnapshot(c.operationId, 1, f.revision, operationId),
      draftSnapshot(c.operationId, 1, f.revision, operationId),
    ]);
  expect(responses.filter((r) => r.replayed)).toHaveLength(1);
  const frozen = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    operationId,
    true,
  );
  expect(frozen.input.locks).toEqual(c.locks);
  expect(frozen.input.exceptions).toEqual([
    { ...c.exceptions[0], lockId: "full" },
  ]);
  expect(frozen.input.events).toEqual(f.plan.events);
  expect(frozen.input.history).toEqual([]);
  expect(JSON.parse(frozen.snapshot.lineage)).toContainEqual({
    kind: "manual_draft",
    entity: f.team,
    version: c.operationId,
    revision: 1,
  });
  await expect(
    createInputSnapshot(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      {
        operationId: crypto.randomUUID(),
        expectedRevision: f.revision,
        month: "2026-10",
      },
    ),
  ).rejects.toThrow("DRAFT_SOURCE_REQUIRED");
  await expect(
    env.DB.prepare(
      "UPDATE input_snapshot_draft SET draft_revision=2 WHERE company_id=? AND snapshot_id=?",
    )
      .bind(f.company.companyId, operationId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_DRAFT_SOURCE");
});
it('derived snapshot refuses silently omitted draft lineage without changing the draft; same ID repair binds the saved source',async()=>{
  const c=workingCommand();await save(c);const id=crypto.randomUUID();
  await env.DB.prepare('CREATE TRIGGER lineage_silent_omission BEFORE INSERT ON input_snapshot_draft BEGIN SELECT RAISE(IGNORE); END').run();
  try {
    await expect(draftSnapshot(c.operationId,1,f.revision,id)).rejects.toThrow();
    for(const table of ['input_operation','input_snapshot','product_audit'])
      expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND id=?`).bind(f.company.companyId,id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT draft_id,revision FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?').bind(f.company.companyId,f.team,'2026-10').first()).toMatchObject({draft_id:c.operationId,revision:1});
  }finally{await env.DB.prepare('DROP TRIGGER lineage_silent_omission').run();}
  expect((await draftSnapshot(c.operationId,1,f.revision,id)).replayed).toBe(false);
  expect(await env.DB.prepare('SELECT draft_id,draft_revision FROM input_snapshot_draft WHERE company_id=? AND snapshot_id=?').bind(f.company.companyId,id).first()).toMatchObject({draft_id:c.operationId,draft_revision:1});
  expect((await draftSnapshot(c.operationId,1,f.revision,id)).replayed).toBe(true);
});
it("WP-06/Q118: recalculation uses latest input conditions while retaining explicit previous locks; stale edits are never silently used as current input", async () => {
  const c = workingCommand();
  await save(c);
  const latest = {
    ...f.plan,
    demand: f.plan.demand.map((d) => ({ ...d, direct: 3 })),
  };
  const savedInput = await f.save("planning", latest);
  const frozen = await draftSnapshot(c.operationId, 1, savedInput.revision);
  expect(
    (
      await readDraft(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        c.operationId,
      )
    ).stale,
  ).toBe(true);
  const read = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    frozen.snapshot!.id,
    true,
  );
  expect(read.input.inputVersion).toBe(savedInput.revision);
  expect(read.input.demand.every((d) => d.direct === 3)).toBe(true);
  expect(read.input.locks).toEqual(c.locks);
});
it("WP-06: a new edit during snapshot upload aborts all D1 manifests/lineage/audit, preserving orphan bytes and the winning edit", async () => {
  const c = workingCommand();
  await save(c);
  const operationId = crypto.randomUUID();
  const changed = { ...workingCommand(), expectedDraftRevision: 1 };
  const bucket = new Proxy(env.INPUTS, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const r = await target.put(...args);
          await save(changed);
          return r;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    draftSnapshot(c.operationId, 1, f.revision, operationId, {
      DB: env.DB,
      INPUTS: bucket,
    }),
  ).rejects.toThrow("DRAFT_VERSION_CONFLICT");
  for (const table of ["input_snapshot", "input_operation", "product_audit"])
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS n FROM ${table} WHERE company_id=? AND id=?`,
      )
        .bind(f.company.companyId, operationId)
        .first("n"),
    ).toBe(0);
  expect((await head())!.revision).toBe(2);
  expect(
    (
      await env.INPUTS.list({
        prefix: `companies/${f.company.companyId}/teams/${f.team}/snapshots/${operationId}/`,
      })
    ).objects,
  ).toHaveLength(1);
});
it("WP-06: edits after freeze make the old snapshot unreadable as current and refuse new jobs without changing old history", async () => {
  const c = workingCommand();
  await save(c);
  const frozen = await draftSnapshot(c.operationId);
  await save({ ...workingCommand(), expectedDraftRevision: 1 });
  await expect(
    readInputSnapshot(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      frozen.snapshot!.id,
      true,
    ),
  ).rejects.toThrow("DRAFT_VERSION_CONFLICT");
  expect(
    (
      await readInputSnapshot(
        env.DB,
        env.INPUTS,
        f.company.companyId,
        f.team,
        f.company.userId,
        frozen.snapshot!.id,
      )
    ).stale,
  ).toBe(true);
  await expect(
    createJob(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      {
        operationId: crypto.randomUUID(),
        snapshotId: frozen.snapshot!.id,
        expectedRevision: f.revision,
      },
    ),
  ).rejects.toThrow("DRAFT_VERSION_CONFLICT");
});
it("WP-06: edits during recomputation reject the completed result as STALE with confirmed stop and cannot replace the newer manual head", async () => {
  const c = workingCommand();
  await save(c);
  const frozen = await draftSnapshot(c.operationId),
    job = (
      await createJob(
        env.DB,
        env.INPUTS,
        f.company.companyId,
        f.team,
        f.company.userId,
        {
          operationId: crypto.randomUUID(),
          snapshotId: frozen.snapshot!.id,
          expectedRevision: f.revision,
        },
      )
    ).job;
  let stopped = false;
  await executeJob(
    env,
    {
      version: 1,
      companyId: f.company.companyId,
      teamId: f.team,
      jobId: job.id,
    },
    async (path, payload) => {
      if (path === "/solve") {
        await save({ ...workingCommand(), expectedDraftRevision: 1 });
        return Response.json({
          ...payload,
          solverStatus: "FEASIBLE",
          assignments: c.assignments,
        });
      }
      return Response.json({
        scope: "multi-task-v1",
        status: "HISTORY_UNVERIFIED",
        violations: [],
      });
    },
    async () => {
      stopped = true;
    },
  );
  expect(stopped).toBe(true);
  expect(
    await getJob(env.DB, f.company.companyId, f.team, f.company.userId, job.id),
  ).toMatchObject({
    state: "STALE",
    failure_code: "DRAFT_CHANGED",
    result_sha256: null,
  });
  expect((await head())!.revision).toBe(2);
});
it("WP-06: old queued recomputation never invokes solver after unfix/edit changed the source head", async () => {
  const c = workingCommand();
  await save(c);
  const frozen = await draftSnapshot(c.operationId),
    job = (
      await createJob(
        env.DB,
        env.INPUTS,
        f.company.companyId,
        f.team,
        f.company.userId,
        {
          operationId: crypto.randomUUID(),
          snapshotId: frozen.snapshot!.id,
          expectedRevision: f.revision,
        },
      )
    ).job;
  await save({ ...workingCommand(), locks: [], expectedDraftRevision: 1 });
  let calls = 0;
  await executeJob(
    env,
    {
      version: 1,
      companyId: f.company.companyId,
      teamId: f.team,
      jobId: job.id,
    },
    async () => {
      calls++;
      throw new Error("Must not run");
    },
    async () => {},
  );
  expect(calls).toBe(0);
  expect(
    (
      await getJob(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        job.id,
      )
    ).state,
  ).toBe("STALE");
});
it("WP-06: manual edits can continue from a recomputed source after saving a newer head, while the old calculation is marked historical", async () => {
  const c = workingCommand();
  await save(c);
  const frozen = await draftSnapshot(c.operationId),
    job = (
      await createJob(
        env.DB,
        env.INPUTS,
        f.company.companyId,
        f.team,
        f.company.userId,
        {
          operationId: crypto.randomUUID(),
          snapshotId: frozen.snapshot!.id,
          expectedRevision: f.revision,
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
          ? { ...payload, solverStatus: "FEASIBLE", assignments: c.assignments }
          : {
              scope: "multi-task-v1",
              status: "HISTORY_UNVERIFIED",
              violations: [],
            },
      ),
    async () => {},
  );
  await save({
    ...workingCommand(),
    sourceJobId: job.id,
    expectedDraftRevision: 1,
  });
  expect(
    await readJobResult(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      job.id,
    ),
  ).toMatchObject({ stale: true, inputStale: false });
  await save({
    ...workingCommand(),
    sourceJobId: job.id,
    expectedDraftRevision: 2,
  });
  expect((await head())!.revision).toBe(3);
});
it("WP-06 UI model: edit is separate from fix, unfix retains reasons without a fixed exception, and changed work uses exact union exclusion", async () => {
  const c = workingCommand(),
    data = {
      assignments: c.assignments,
      locks: c.locks,
      exceptions: [{ ...c.exceptions[0], lockId: "full" }],
    };
  const unfixed = setFixed(data, 0, []);
  expect(unfixed.locks).toEqual([]);
  expect(unfixed.exceptions[0]).toMatchObject({
    lockId: null,
    reason: "Fictional placement",
  });
  expect(data.locks).toHaveLength(1);
  const frozen = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    snapshotId,
  );
  expect(() => changePattern(data, 0, "", frozen.input)).toThrow("固定を解除");
  const off = changePattern(unfixed, 0, "", frozen.input);
  expect(off.assignments[0]).toMatchObject({
    shift: null,
    blocks: [],
    roleIntervals: [],
  });
  expect(off.locks).toEqual([]);
  expect(off.exceptions).toEqual([]);
  const input = structuredClone(frozen.input);
  input.events = [
    {
      id: "whole",
      date: off.assignments[0].date,
      start: 660,
      end: 690,
      kind: "training",
      staffIds: [off.assignments[0].staffId],
    },
    {
      id: "partial",
      date: off.assignments[0].date,
      start: 607,
      end: 617,
      kind: "meeting",
      staffIds: [off.assignments[0].staffId],
    },
  ];
  const restored = changePattern(off, 0, "day", input).assignments[0];
  expect(restored.blocks.some((b) => b.start === 600)).toBe(true);
  expect(
    restored.blocks.some(
      (b) => b.start === 660 || b.start === 780 || b.start === 810,
    ),
  ).toBe(false);
  expect(
    workedMinutes({
      ...c.assignments[0].shift!,
      start: 600,
      end: 900,
      break: [750, 810],
      cancelled: [[780, 840]],
    }),
  ).toBe(210);
});
it("WP-06: an old ordinary snapshot cannot bypass newly saved fixed work at job acceptance", async () => {
  await save(workingCommand());
  await expect(
    createJob(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      {
        operationId: crypto.randomUUID(),
        snapshotId,
        expectedRevision: f.revision,
      },
    ),
  ).rejects.toThrow("DRAFT_VERSION_CONFLICT");
  await expect(
    env.DB.prepare(
      "INSERT INTO compute_job(company_id,id,team_id,actor_id,snapshot_id,input_revision,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        f.company.companyId,
        crypto.randomUUID(),
        f.team,
        f.company.userId,
        snapshotId,
        f.revision,
        "forged",
        Date.now(),
        Date.now(),
      )
      .run(),
  ).rejects.toThrow("JOB_DRAFT_VERSION_CONFLICT");
  expect(
    (
      await readJobResult(
        env.DB,
        env.INPUTS,
        f.company.companyId,
        f.team,
        f.company.userId,
        jobId,
      )
    ).stale,
  ).toBe(true);
});
it("WP-06: prospective event input uses only approved fully fixed exception intervals; unfix cannot authorize automatic unavailability", async () => {
  const c = workingCommand();
  const { loadSources, compileInput, validateCompiledInput } =
    await import("../../apps/api/src/input-snapshots");
  const sources = await loadSources(
    env.DB,
    f.company.companyId,
    f.team,
    "2026-10",
  );
  const month = sources.versions.find((v) => v.kind === "staff_month")!;
  month.payload = JSON.stringify({
    unavailable: [{ date: "2026-10-01", start: 607, end: 617 }],
    preferences: [],
  });
  const compiled = compileInput(
    f.company.companyId,
    f.team,
    "2026-10",
    crypto.randomUUID(),
    sources,
    fixedDraftInput(c),
  );
  expect(compiled.input.staff[0].unavailable).toEqual([
    { date: "2026-10-01", start: 607, end: 617 },
  ]);
  expect(compiled.input.exceptions[0]).toMatchObject({
    start: 607,
    end: 617,
    lockId: "full",
  });
  const input = structuredClone(compiled.input);
  input.exceptions = [];
  expect(() => validateCompiledInput(input)).toThrow(
    "EVENT_ATTENDANCE_CONFLICT",
  );
});

async function restEditingFixture() {
  const frozen = await readInputSnapshot(env.DB, env.INPUTS, f.company.companyId, f.team, f.company.userId, snapshotId);
  const input = structuredClone(frozen.input);
  input.events = [];
  input.patterns.push({ id: 'auto-edit', start: 540, end: 720, breakKind: 'auto' });
  const c = workingCommand(), off = changePattern(setFixed(c, 0, []), 0, '', input);
  return { input, draft: changePattern(off, 0, 'auto-edit', input) };
}
it('rest editing from a day off removes rest-only duties and moving rest restores work without moving the shift or fixing duties', async () => {
  const { input, draft } = await restEditingFixture();
  const before = structuredClone(draft);
  const rested = changeBreak(draft, 0, [570, 600], input);
  expect(rested.assignments[0].shift).toMatchObject({ start: 540, end: 720, breakKind: 'auto', break: [570, 600], workedMinutes: 150 });
  expect(rested.assignments[0].blocks.map(b => b.start)).toEqual([540, 600, 630, 660, 690]);
  const preserved = structuredClone(rested.assignments[0].blocks.find(b => b.start === 600));
  const moved = changeBreak(rested, 0, [630, 660], input);
  expect(moved.assignments[0].blocks.map(b => b.start)).toEqual([540, 570, 600, 660, 690]);
  expect(moved.assignments[0].blocks.find(b => b.start === 600)).toEqual(preserved);
  expect(moved.assignments[0].blocks.find(b => b.start === 570)?.roleId).toBeNull();
  expect(moved.locks).toEqual([]);
  expect(draft).toEqual(before);
});
it('rest editing retains partially worked slots and combines rest, minute events and cancellation when identifying empty slots', async () => {
  const { input, draft } = await restEditingFixture(), a = draft.assignments[0];
  const partial = changeBreak(draft, 0, [570, 585], input);
  expect(partial.assignments[0].blocks.map(b => b.start)).toEqual([540, 570, 600, 630, 660, 690]);
  expect(partial.assignments[0].shift?.workedMinutes).toBe(165);
  input.events = [{ id: 'remaining-slot', date: a.date, start: 585, end: 600, kind: 'meeting', staffIds: [a.staffId] },
    { id: 'partial-slot', date: a.date, start: 607, end: 617, kind: 'training', staffIds: [a.staffId] }];
  a.shift!.cancelled = [[540, 570]];
  const combined = changeBreak(draft, 0, [570, 585], input);
  expect(combined.assignments[0].blocks.map(b => b.start)).toEqual([600, 630, 660, 690]);
  expect(combined.assignments[0].shift?.workedMinutes).toBe(135);
  expect(combined.assignments[0].shift?.cancelled).toEqual([[540, 570]]);
});
it('rest editing never changes pattern-fixed or explicitly fixed rest and cannot edit a day off', async () => {
  const { input, draft } = await restEditingFixture();
  const fixed = setFixed(draft, 0, ['break']), before = structuredClone(fixed);
  expect(() => changeBreak(fixed, 0, [600, 630], input)).toThrow('固定された休憩');
  expect(fixed).toEqual(before);
  draft.assignments[0].shift!.breakKind = 'fixed';
  expect(() => changeBreak(draft, 0, null, input)).toThrow('固定された休憩');
  const off = changePattern(draft, 0, '', input);
  expect(() => changeBreak(off, 0, null, input)).toThrow('勤務がありません');
});
