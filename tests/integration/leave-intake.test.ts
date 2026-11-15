import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { inputFixture } from "../../apps/api/src/input-probes";
import {
  createInputSnapshot,
  readInputSnapshot,
  sha256,
} from "../../apps/api/src/input-snapshots";
import { createJob } from "../../apps/api/src/compute-jobs";
import { executeJob } from "../../apps/api/src/compute-execution";
import {
  publishSchedule,
  readPublicationHead,
} from "../../apps/api/src/schedule-publications";
import {
  optimizerAssignmentsSchema,
  optimizerInputSchema,
} from "../../packages/contracts/optimizer-input.generated";
import {
  leaveSubmission,
  requestedWork,
} from "../../apps/api/src/leave-contract";
import {
  submitLeave,
  rejectLeave,
  readLeave,
  listLeaves,
  leaveIntakeContext,
  leaveNotices,
  readLeaveNotice,
} from "../../apps/api/src/leave-intake";
import { leaveRoutes } from "../../apps/api/src/leave-routes";
import { createApp } from "../../apps/api/src/index";
import {
  createStaff,
  createTeam,
  saveCalendarSettings,
  type ApiEnv,
} from "../../apps/api/src/product";
import type { InputDatabase } from "../../apps/api/src/input-versions";
import type { DraftVerifier } from "../../apps/api/src/schedule-drafts";

// Real DO storage/RPC with a controlled process adapter; native checks run separately.
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

let f: Awaited<ReturnType<typeof inputFixture>>, publicationId: string;
const company = () => f.company.companyId,
  manager = () => f.company.userId;
const validation = {
  scope: "multi-task-v1",
  status: "VERIFIED",
  violations: [],
  missingHistory: [],
  generalShortage: 0,
  roleSameShortage: 0,
  roleRequirements: [],
};
const revision = () =>
  env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(company())
    .first<number>("revision");
const input = () =>
  leaveSubmission.parse({
    operationId: crypto.randomUUID(),
    staffId: f.staff.staffId,
    date: "2026-10-01",
    kind: "LEAVE_REQUEST",
    part: "FULL",
    reason: "架空の休暇理由",
    publicationId,
    expectedPublicationRevision: 1,
  });
const submit = (c = input(), user = f.staffUser, db: InputDatabase = env.DB) =>
  submitLeave(db, company(), f.team, user, c);
const reject = (
  id: string,
  c = {
    operationId: crypto.randomUUID(),
    expectedRequestRevision: 1,
    reason: "架空の確認理由",
  },
  user = manager(),
  db: InputDatabase = env.DB,
) => rejectLeave(db, company(), f.team, user, id, c);
const read = (id: string, user = f.staffUser) =>
  readLeave(env.DB, company(), f.team, user, id);
const assignments = () =>
  optimizerAssignmentsSchema.parse(
    Array.from({ length: 31 }, (_, n) => ({
      staffId: f.staff.staffId,
      date: `2026-10-${String(n + 1).padStart(2, "0")}`,
      shift: n
        ? null
        : {
            patternId: "day",
            start: 600,
            end: 1020,
            breakKind: "fixed",
            break: [780, 840],
            workedMinutes: 360,
            cancelled: [],
          },
      blocks: n
        ? []
        : Array.from({ length: 14 }, (_, i) => 600 + i * 30)
            .filter((n) => ![660, 780, 810].includes(n))
            .map((start) => ({
              start,
              end: start + 30,
              taskId: "phone",
              roleId: null,
            })),
      roleIntervals: [],
    })),
  );
const check: DraftVerifier = async (c) => {
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
    validation,
  };
};
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  f = await inputFixture(env.DB, env.INPUTS);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  const snapshotId = crypto.randomUUID();
  await createInputSnapshot(env.DB, env.INPUTS, company(), f.team, manager(), {
    operationId: snapshotId,
    expectedRevision: f.revision,
    month: "2026-10",
  });
  const jobId = (
    await createJob(env.DB, env.INPUTS, company(), f.team, manager(), {
      operationId: crypto.randomUUID(),
      snapshotId,
      expectedRevision: f.revision,
    })
  ).job.id;
  // Real Workerd D1/R2, controlled solver/checker transport: persistence proof,
  // not proof that every native constraint is implemented.
  await executeJob(
    env,
    { version: 1, companyId: company(), teamId: f.team, jobId },
    async (path, payload) =>
      Response.json(
        path === "/solve"
          ? { ...payload, solverStatus: "FEASIBLE", assignments: assignments() }
          : validation,
      ),
    async () => {},
  );
  publicationId = crypto.randomUUID();
  await publishSchedule(
    env,
    company(),
    f.team,
    manager(),
    {
      operationId: publicationId,
      expectedRevision: f.revision,
      expectedDraftRevision: 0,
      expectedPublicationRevision: 0,
      source: { kind: "job", id: jobId },
      acknowledgeShortage: false,
    },
    check,
  );
});
it.each(['LEAVE_REQUEST','ABSENCE_REQUEST','ABSENCE_FACT'].flatMap(kind=>['record','audit','head','notice'].map(fault=>({kind:kind as 'LEAVE_REQUEST'|'ABSENCE_REQUEST'|'ABSENCE_FACT',fault}))))(
  'leave intake $kind silent $fault omission preserves publication and creates no partial request',async({kind,fault})=>{
    const c={...input(),kind},actor=kind==='ABSENCE_FACT'?manager():f.staffUser,r=await revision(),before=await readPublicationHead(env,company(),f.team,manager(),'2026-10');
    const target={record:'BEFORE INSERT ON leave_record',audit:"BEFORE INSERT ON product_audit WHEN NEW.kind='leave_intake'",head:'BEFORE INSERT ON leave_head',notice:'BEFORE INSERT ON leave_notice'}[fault];
    await env.DB.prepare(`CREATE TRIGGER intake_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
    try{
      await expect(submit(c,actor)).rejects.toThrow();expect(await revision()).toBe(r);expect(await readPublicationHead(env,company(),f.team,manager(),'2026-10')).toEqual(before);
      for(const [table,column] of [['leave_record','id'],['leave_head','request_id'],['leave_notice','event_id'],['product_audit','id']])expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND ${column}=?`).bind(company(),c.operationId).first()).toBeNull();
    }finally{await env.DB.prepare('DROP TRIGGER intake_silent_omission').run();}
    expect(await submit(c,actor)).toMatchObject({replayed:false,status:kind==='ABSENCE_FACT'?'REPORTED':'PENDING'});expect(await submit(c,actor)).toMatchObject({replayed:true});
    expect(await revision()).toBe(r);
  },
);
it.each(['LEAVE_REQUEST','ABSENCE_REQUEST'].flatMap(kind=>['fact','audit','head','notice'].map(fault=>({kind:kind as 'LEAVE_REQUEST'|'ABSENCE_REQUEST',fault}))))(
  'leave rejection $kind silent $fault omission preserves pending request with no result notice',async({kind,fault})=>{
    const c={...input(),kind};await submit(c);const decision={operationId:crypto.randomUUID(),expectedRequestRevision:1,reason:'架空の却下確認'},r=await revision();
    const target={fact:'BEFORE INSERT ON leave_rejection',audit:"BEFORE INSERT ON product_audit WHEN NEW.kind='leave_rejection'",head:'BEFORE UPDATE ON leave_head',notice:"BEFORE INSERT ON leave_notice WHEN NEW.kind='REJECTED'"}[fault];
    await env.DB.prepare(`CREATE TRIGGER rejection_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
    try{
      await expect(reject(c.operationId,decision)).rejects.toThrow();expect((await read(c.operationId)).record.status).toBe('PENDING');expect(await revision()).toBe(r);
      for(const [table,column] of [['leave_rejection','id'],['leave_notice','event_id'],['product_audit','id']])expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND ${column}=?`).bind(company(),decision.operationId).first()).toBeNull();
    }finally{await env.DB.prepare('DROP TRIGGER rejection_silent_omission').run();}
    expect(await reject(c.operationId,decision)).toMatchObject({replayed:false,status:'REJECTED'});expect(await reject(c.operationId,decision)).toMatchObject({replayed:true});expect(await revision()).toBe(r);
  },
);
it.each(['RECEIVED','REJECTED','APPROVED','CANCELLATION_CONFIRMED'])('leave notice %s silent read omission never returns fake read success',async kind=>{
  const c={...input(),kind:kind==='CANCELLATION_CONFIRMED'?'ABSENCE_FACT' as const:'LEAVE_REQUEST' as const};await submit(c,c.kind==='ABSENCE_FACT'?manager():f.staffUser);let id=c.operationId;
  if(kind==='REJECTED'){const d={operationId:crypto.randomUUID(),expectedRequestRevision:1,reason:'架空の却下理由'};await reject(c.operationId,d);id=d.operationId;}
  if(kind==='APPROVED'||kind==='CANCELLATION_CONFIRMED'){const d=await cancellationCommand(c.operationId);await commitCancellation(c.operationId,d);id=d.operationId;}
  const table=kind==='APPROVED'||kind==='CANCELLATION_CONFIRMED'?'leave_cancellation_notice':'leave_notice';
  await env.DB.prepare(`CREATE TRIGGER notice_silent_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`).run();
  try{
    await expect(readLeaveNotice(env.DB,company(),f.team,f.staffUser,id)).rejects.toThrow();
    expect(await env.DB.prepare(`SELECT read_at FROM ${table} WHERE company_id=? AND event_id=? AND user_id=?`).bind(company(),id,f.staffUser).first('read_at')).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER notice_silent_update').run();}
  expect(await readLeaveNotice(env.DB,company(),f.team,f.staffUser,id)).toEqual({read:true,changed:true});
  expect(await readLeaveNotice(env.DB,company(),f.team,f.staffUser,id)).toEqual({read:true,changed:false});
});
it('leave read HTTP returns a scoped retryable 503 without fake success',async()=>{
  const c=input();await submit(c);const app=createApp(),base=env.AUTH_BASE_URL;
  const email=await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(f.staffUser).first('email');
  const signed=await app.request(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email,password:f.staff.initialPassword})},env);
  expect(signed.status).toBe(200);const cookie=signed.headers.get('set-cookie')!.split(';')[0];
  const mark=()=>app.request(base+`/api/companies/${company()}/schedules/teams/${f.team}/leave/notices/${c.operationId}/read`,{method:'POST',headers:{origin:base,'content-type':'application/json',cookie},body:'{}'},env);
  await env.DB.prepare('CREATE TRIGGER notice_http_silent_update BEFORE UPDATE ON leave_notice BEGIN SELECT RAISE(IGNORE); END').run();
  try{
    const denied=await mark();expect(denied.status).toBe(503);expect(denied.headers.get('cache-control')).toBe('no-store');expect(await denied.json()).toEqual({error:'NOTICE_UPDATE_FAILED'});
  }finally{await env.DB.prepare('DROP TRIGGER notice_http_silent_update').run();}
  const accepted=await mark();expect(accepted.status).toBe(200);expect(await accepted.json()).toEqual({read:true,changed:true});
});
it("WP-08/Q121: pending leave and reported absence fact retain published work, input revision and current certificate", async () => {
  const before = await readPublicationHead(
      env,
      company(),
      f.team,
      manager(),
      "2026-10",
    ),
    r = await revision();
  const c = input();
  expect(await submit(c)).toMatchObject({
    requestId: c.operationId,
    status: "PENDING",
    requestRevision: 1,
    replayed: false,
  });
  const fact = {
    ...input(),
    kind: "ABSENCE_FACT" as const,
    reason: "架空の実欠勤",
  };
  expect(await submit(fact, manager())).toMatchObject({ status: "REPORTED" });
  expect((await read(fact.operationId)).record.status).toBe("REPORTED");
  expect((await read(c.operationId)).record).toMatchObject({
    start: 600,
    end: 1020,
    reason: c.reason,
    publicationId,
    requestRevision: 1,
  });
  expect(await revision()).toBe(r);
  expect(
    await readPublicationHead(env, company(), f.team, manager(), "2026-10"),
  ).toEqual(before);
  expect(
    (await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices,
  ).toHaveLength(2);
});
it("WP-08: same operation has one winner and one receipt; changed payload or another actor cannot impersonate/reuse it", async () => {
  const c = input(),
    r = await Promise.all([submit(c), submit(c)]);
  expect(r.filter((x) => x.replayed)).toHaveLength(1);
  expect(
    (await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices,
  ).toHaveLength(1);
  await expect(submit({ ...c, reason: "別の理由" })).rejects.toMatchObject({
    code: "OPERATION_ID_CONFLICT",
  });
  await expect(submit(c, manager())).rejects.toMatchObject({ status: 403 });
});
it("WP-08/Q94: disjoint morning/afternoon requests coexist; overlapping full-day request is atomically refused", async () => {
  const am = { ...input(), part: "AM" as const },
    pm = { ...input(), part: "PM" as const };
  await submit(am);
  await submit(pm);
  expect((await read(am.operationId)).record).toMatchObject({
    start: 600,
    end: 720,
  });
  expect((await read(pm.operationId)).record).toMatchObject({
    start: 720,
    end: 1020,
  });
  await expect(submit()).rejects.toMatchObject({ code: "LEAVE_OVERLAP" });
  const full = input();
  await reject(am.operationId);
  await reject(pm.operationId);
  await submit(full);
  expect(
    (await listLeaves(env.DB, company(), f.team, f.staffUser, "2026-10"))
      .records,
  ).toHaveLength(3);
});
it("WP-08: two different overlapping operations have one winner without duplicate audit or inbox", async () => {
  const results = await Promise.allSettled([submit(), submit()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    results.filter((r) => r.status === "rejected").map((r) => r.reason.code),
  ).toEqual(["LEAVE_OVERLAP"]);
  expect(
    (await listLeaves(env.DB, company(), f.team, f.staffUser, "2026-10"))
      .records,
  ).toHaveLength(1);
  expect(
    (await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices,
  ).toHaveLength(1);
});
it("WP-08: rejection stores reason and immutable request, exactly one result notice; facts cannot be rejected", async () => {
  const c = input();
  await submit(c);
  const decision = {
    operationId: crypto.randomUUID(),
    expectedRequestRevision: 1,
    reason: "架空の代替日を相談",
  };
  expect(await reject(c.operationId, decision)).toMatchObject({
    status: "REJECTED",
    requestRevision: 2,
    replayed: false,
  });
  expect(await reject(c.operationId, decision)).toMatchObject({
    replayed: true,
  });
  const r = (await read(c.operationId)).record;
  expect(r).toMatchObject({
    status: "REJECTED",
    reason: c.reason,
    decisionReason: decision.reason,
    requestRevision: 2,
  });
  expect(
    (await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices,
  ).toHaveLength(2);
  await expect(reject(c.operationId)).rejects.toMatchObject({
    code: "LEAVE_VERSION_CONFLICT",
  });
  const fact = { ...input(), kind: "ABSENCE_FACT" as const };
  await submit(fact, manager());
  await expect(reject(fact.operationId)).rejects.toMatchObject({
    code: "LEAVE_VERSION_CONFLICT",
  });
  for (const sql of [
    "UPDATE leave_record SET reason='改変' WHERE company_id=?",
    "DELETE FROM leave_rejection WHERE company_id=?",
    "UPDATE leave_head SET status='PENDING',revision=1,decision_id=NULL WHERE company_id=?",
  ])
    await expect(env.DB.prepare(sql).bind(company()).run()).rejects.toThrow();
});
it("WP-08: staff cannot read another staff request/reason or register a fact; manager access is scoped to its team/company", async () => {
  const c = input();
  await submit(c);
  const other = await createStaff(env.DB, company(), f.team, manager(), {
    operationId: crypto.randomUUID(),
    expectedRevision: (await revision())!,
    name: "架空別スタッフ",
    email: `${crypto.randomUUID()}@example.invalid`,
    staffNumber: "0002",
  });
  const user = (await env.DB.prepare(
    "SELECT user_id FROM staff WHERE company_id=? AND id=?",
  )
    .bind(company(), other.staffId)
    .first<string>("user_id"))!;
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(user)
    .run();
  expect(
    (await listLeaves(env.DB, company(), f.team, user, "2026-10")).records,
  ).toEqual([]);
  await expect(read(c.operationId, user)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    submit({ ...input(), kind: "ABSENCE_FACT" }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    reject(c.operationId, undefined, f.staffUser),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (await leaveIntakeContext(env.DB, company(), f.team, user, "2026-10"))
      .assignments,
  ).toEqual([]);
  const foreign = await inputFixture(env.DB);
  await expect(
    read(c.operationId, foreign.company.userId),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    listLeaves(env.DB, company(), foreign.team, manager(), "2026-10"),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (await leaveNotices(env.DB, company(), f.team, manager())).notices,
  ).toEqual([]);
  await expect(
    readLeaveNotice(env.DB, company(), f.team, manager(), c.operationId),
  ).rejects.toMatchObject({ status: 404 });
});
it("WP-08: initial-password/disabled users are denied, including replay; live revocation before D1 insert rolls back", async () => {
  const c = input();
  const racing: InputDatabase = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements) => {
      await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?")
        .bind(f.staffUser)
        .run();
      return env.DB.batch(statements);
    },
  };
  await expect(submit(c, f.staffUser, racing)).rejects.toMatchObject({
    code: "LEAVE_FORBIDDEN",
    status: 403,
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM leave_record WHERE company_id=?",
    )
      .bind(company())
      .first("n"),
  ).toBe(0);
  await env.DB.prepare(
    "UPDATE access_state SET enabled=1,must_change_password=1 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await expect(submit(c)).rejects.toMatchObject({ status: 403 });
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await submit(c);
  await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?")
    .bind(f.staffUser)
    .run();
  await expect(submit(c)).rejects.toMatchObject({ status: 403 });
});
it("WP-08: revoked team manager cannot reject even when API reads succeeded before the write", async () => {
  await env.DB.prepare(
    "UPDATE team_member SET role='team_admin' WHERE company_id=? AND user_id=?",
  )
    .bind(company(), f.staffUser)
    .run();
  const c = input();
  await submit(c);
  const racing: InputDatabase = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements) => {
      await env.DB.prepare(
        "UPDATE team_member SET role='staff' WHERE company_id=? AND user_id=?",
      )
        .bind(company(), f.staffUser)
        .run();
      return env.DB.batch(statements);
    },
  };
  await expect(
    reject(c.operationId, undefined, f.staffUser, racing),
  ).rejects.toMatchObject({ code: "LEAVE_FORBIDDEN" });
  expect((await read(c.operationId)).record.status).toBe("PENDING");
});
it("WP-08: audit failure rolls back request/head/notice, and rejection failure leaves original pending with no result notice", async () => {
  const c = input(),
    before = await revision();
  await env.DB.prepare(
    "CREATE TRIGGER leave_test_audit_failure BEFORE INSERT ON product_audit WHEN NEW.kind IN ('leave_intake','leave_rejection') BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END",
  ).run();
  try {
    await expect(submit(c)).rejects.toThrow("TEST_AUDIT_FAILURE");
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM leave_head WHERE company_id=?",
      )
        .bind(company())
        .first("n"),
    ).toBe(0);
    expect(
      (await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices,
    ).toHaveLength(0);
  } finally {
    await env.DB.prepare("DROP TRIGGER leave_test_audit_failure").run();
  }
  await submit(c);
  await env.DB.prepare(
    "CREATE TRIGGER leave_test_audit_failure BEFORE INSERT ON product_audit WHEN NEW.kind='leave_rejection' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END",
  ).run();
  try {
    await expect(reject(c.operationId)).rejects.toThrow("TEST_AUDIT_FAILURE");
    expect((await read(c.operationId)).record.status).toBe("PENDING");
    expect(
      (await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices,
    ).toHaveLength(1);
  } finally {
    await env.DB.prepare("DROP TRIGGER leave_test_audit_failure").run();
  }
  expect(await revision()).toBe(before);
});
it("WP-08: stale publication, stale calendar and empty half-day are refused by actual D1 guards", async () => {
  await expect(
    submit({ ...input(), expectedPublicationRevision: 2 }),
  ).rejects.toMatchObject({ code: "LEAVE_PUBLICATION_CONFLICT" });
  await expect(
    submit({ ...input(), date: "2026-10-02" }),
  ).rejects.toMatchObject({ code: "LEAVE_PUBLICATION_CONFLICT" });
  const racing: InputDatabase = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements) => {
      await saveCalendarSettings(env.DB, company(), manager(), {
        operationId: crypto.randomUUID(),
        expectedRevision: (await revision())!,
        effectiveFrom: "2026-10",
        settings: {
          weekStart: 0,
          deadlineDay: 20,
          halfDayDivider: 600,
          roleRounding: "floor",
        },
      });
      return env.DB.batch(statements);
    },
  };
  await expect(
    submit({ ...input(), part: "AM" }, f.staffUser, racing),
  ).rejects.toMatchObject({ code: "LEAVE_CALENDAR_CONFLICT" });
  await expect(submit({ ...input(), part: "AM" })).rejects.toMatchObject({
    code: "LEAVE_EMPTY_WORK",
  });
  const c = input();
  await submit(c);
  await expect(
    env.DB.prepare(
      `INSERT INTO leave_record SELECT company_id,?,team_id,staff_id,?,kind,date,part,reason,publication_id,publication_revision,calendar_id,start,end,fingerprint,recorded_at FROM leave_record WHERE company_id=? AND id=?`,
    )
      .bind(crypto.randomUUID(), manager(), company(), c.operationId)
      .run(),
  ).rejects.toThrow("LEAVE_FORBIDDEN");
  await expect(
    env.DB.prepare(
      `INSERT INTO leave_record SELECT company_id,?,team_id,staff_id,?,'ABSENCE_FACT','2099-01-01',part,reason,publication_id,publication_revision,calendar_id,start,end,fingerprint,recorded_at FROM leave_record WHERE company_id=? AND id=?`,
    )
      .bind(crypto.randomUUID(), manager(), company(), c.operationId)
      .run(),
  ).rejects.toThrow("LEAVE_FUTURE_FACT");
});
it("WP-08: history and own notifications use keyset pagination, including equal timestamps, without leaking other scope", async () => {
  const spy = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    for (let i = 0; i < 51; i++) {
      const c = input();
      await submit(c);
      await reject(c.operationId);
    }
  } finally {
    spy.mockRestore();
  }
  const first = await listLeaves(
    env.DB,
    company(),
    f.team,
    f.staffUser,
    "2026-10",
  );
  expect(first.records).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  const second = await listLeaves(
    env.DB,
    company(),
    f.team,
    f.staffUser,
    "2026-10",
    first.nextCursor!,
  );
  expect(second.records).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.records, ...second.records].map((r) => r.id)).size,
  ).toBe(51);
  let cursor: Parameters<typeof leaveNotices>[4],
    seen: string[] = [];
  do {
    const page = await leaveNotices(
      env.DB,
      company(),
      f.team,
      f.staffUser,
      cursor,
    );
    seen.push(...page.notices.map((n) => n.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(seen).size).toBe(102);
  expect(
    await readLeaveNotice(env.DB, company(), f.team, f.staffUser, seen[0]),
  ).toEqual({ read: true, changed: true });
  expect(
    await readLeaveNotice(env.DB, company(), f.team, f.staffUser, seen[0]),
  ).toEqual({ read: true, changed: false });
  await expect(
    env.DB.prepare(
      "UPDATE leave_notice SET read_at=NULL WHERE company_id=? AND event_id=?",
    )
      .bind(company(), seen[0])
      .run(),
  ).rejects.toThrow("IMMUTABLE_LEAVE_NOTICE");
});
it("WP-08 HTTP: no-origin/oversized/invalid date or reason rejected; approval route absent, initial password guarded", async () => {
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("identity", { userId: f.staffUser, mustChange: false });
    await next();
  });
  app.route("/api", leaveRoutes());
  const path = `/api/companies/${company()}/schedules/teams/${f.team}/leave`;
  const post = (body: unknown, origin = env.AUTH_BASE_URL) =>
    app.request(
      path,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  expect((await post(input(), "https://outside.invalid")).status).toBe(403);
  expect((await post({ ...input(), reason: " " })).status).toBe(400);
  expect((await post({ ...input(), date: "2026-02-30" })).status).toBe(400);
  expect((await post({ ...input(), reason: "x".repeat(9000) })).status).toBe(
    413,
  );
  expect((await post({ ...input(), kind: "APPROVED" })).status).toBe(400);
  const c = input();
  expect((await post(c)).status).toBe(200);
  expect(
    (
      await app.request(
        path + `/${c.operationId}/approve`,
        { method: "POST", headers: { origin: env.AUTH_BASE_URL }, body: "{}" },
        env,
      )
    ).status,
  ).toBe(404);
  const read = await app.request(path + "?month=2026-10", {}, env);
  expect(read.headers.get("cache-control")).toBe("no-store");
  const auth = await createApp().request(
    "/api/auth/sign-in/email",
    {
      method: "POST",
      headers: {
        origin: env.AUTH_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: f.email,
        password: f.company.initialPassword,
      }),
    },
    env,
  );
  const cookie = auth.headers.get("set-cookie")!.split(";")[0];
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=1 WHERE user_id=?",
  )
    .bind(manager())
    .run();
  expect(
    await (
      await createApp().request(
        path,
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.AUTH_BASE_URL,
            "content-type": "application/json",
          },
          body: JSON.stringify(input()),
        },
        env,
      )
    ).json(),
  ).toEqual({ error: "PASSWORD_CHANGE_REQUIRED" });
});
it("WP-08/Q128: part eligibility excludes rest and cancellation once, without moving published times", () => {
  const shift = {
    patternId: "day",
    start: 600,
    end: 1020,
    breakKind: "auto" as const,
    break: [720, 780],
    workedMinutes: 240,
    cancelled: [[600, 750]],
  };
  expect(requestedWork(shift, "AM", 720)).toBeNull();
  expect(requestedWork(shift, "PM", 720)).toEqual({ start: 720, end: 1020 });
  expect(
    requestedWork({ ...shift, break: [600, 720], cancelled: [] }, "AM", 720),
  ).toBeNull();
  expect(requestedWork(shift, "AM", null)).toBeNull();
});

// Cancellation preflight is read-only. Native constraint coverage is recorded
// separately; these tests exercise scoped source construction and I/O races.
it("cancellation preflight removes full-day work/events in a candidate and preserves all stored publication/request/input state", async () => {
  const { buildCancellationCandidate } =
    await import("../../apps/api/src/cancellation-candidate");
  const c = input();
  await submit(c);
  const command = {
    operationId: crypto.randomUUID(),
    companyId: company(),
    teamId: f.team,
    userId: manager(),
    requestId: c.operationId,
    expectedRevision: (await revision())!,
    expectedRequestRevision: 1,
    publicationId,
    expectedPublicationRevision: 1,
  };
  const before = await readPublicationHead(
    env,
    company(),
    f.team,
    manager(),
    "2026-10",
  );
  const candidate = await buildCancellationCandidate(env, command);
  const a = candidate.assignments.find((a) => a.date === "2026-10-01")!;
  expect(a.shift).toMatchObject({
    start: 600,
    end: 1020,
    breakKind: "fixed",
    break: [780, 840],
    cancelled: [[600, 1020]],
    workedMinutes: 0,
  });
  expect(a.blocks).toEqual([]);
  expect(a.roleIntervals).toEqual([]);
  expect(
    candidate.input.events.every(
      (e) => e.date !== "2026-10-01" || !e.staffIds.includes(f.staff.staffId),
    ),
  ).toBe(true);
  expect(
    candidate.input.published.find((a) => a.date === "2026-10-01")?.shift,
  ).toEqual(a.shift);
  expect(
    await readPublicationHead(env, company(), f.team, manager(), "2026-10"),
  ).toEqual(before);
  expect((await read(c.operationId)).record.status).toBe("PENDING");
  expect(await revision()).toBe(command.expectedRevision);
});
it("cancellation preflight is bound to manager, current request/input/publication/calendar and explicitly released fixed work", async () => {
  const { buildCancellationCandidate } =
    await import("../../apps/api/src/cancellation-candidate");
  const c = input();
  await submit(c);
  const command = {
    operationId: crypto.randomUUID(),
    companyId: company(),
    teamId: f.team,
    userId: manager(),
    requestId: c.operationId,
    expectedRevision: (await revision())!,
    expectedRequestRevision: 1,
    publicationId,
    expectedPublicationRevision: 1,
  };
  await expect(
    buildCancellationCandidate(env, { ...command, userId: f.staffUser }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    buildCancellationCandidate(env, { ...command, expectedRevision: 0 }),
  ).rejects.toThrow("VERSION_CONFLICT");
  await expect(
    buildCancellationCandidate(env, {
      ...command,
      publicationId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("LEAVE_PUBLICATION_CONFLICT");
  await reject(c.operationId);
  await expect(buildCancellationCandidate(env, command)).rejects.toThrow(
    "LEAVE_VERSION_CONFLICT",
  );
});
it("cancellation check returns INVALID unchanged and confirms stop; malformed/incomplete checker certificates are refused", async () => {
  const { checkCancellationCandidate } =
    await import("../../apps/api/src/cancellation-check");
  const c = input();
  await submit(c);
  const command = {
    operationId: crypto.randomUUID(),
    companyId: company(),
    teamId: f.team,
    userId: manager(),
    requestId: c.operationId,
    expectedRevision: (await revision())!,
    expectedRequestRevision: 1,
    publicationId,
    expectedPublicationRevision: 1,
  };
  let stopped = 0;
  const result = await checkCancellationCandidate(
    env,
    command,
    async () =>
      Response.json({
        ...validation,
        status: "INVALID",
        violations: ["MONTHLY_HOURS:fictional"],
      }),
    async () => {
      stopped++;
    },
  );
  expect(result).toMatchObject({
    approval: "NOT_COMMITTED",
    inputRevision: command.expectedRevision,
    validation: { status: "INVALID", violations: ["MONTHLY_HOURS:fictional"] },
  });
  expect(stopped).toBe(1);
  await expect(
    checkCancellationCandidate(
      env,
      command,
      async () =>
        Response.json({
          status: "VERIFIED",
          scope: "multi-task-v1",
          violations: [],
        }),
      async () => {
        stopped++;
      },
    ),
  ).rejects.toThrow();
  expect(stopped).toBe(2);
  expect((await read(c.operationId)).record.status).toBe("PENDING");
  expect(await revision()).toBe(command.expectedRevision);
});
it("input change or manager revocation during independent cancellation I/O rejects a stale VERIFIED response and confirms stop", async () => {
  const { checkCancellationCandidate } =
    await import("../../apps/api/src/cancellation-check");
  const c = input();
  await submit(c);
  const command = {
    operationId: crypto.randomUUID(),
    companyId: company(),
    teamId: f.team,
    userId: manager(),
    requestId: c.operationId,
    expectedRevision: (await revision())!,
    expectedRequestRevision: 1,
    publicationId,
    expectedPublicationRevision: 1,
  };
  let stops = 0;
  await expect(
    checkCancellationCandidate(
      env,
      command,
      async () => {
        await env.DB.prepare(
          "UPDATE company SET revision=revision+1 WHERE id=?",
        )
          .bind(company())
          .run();
        return Response.json(validation);
      },
      async () => {
        stops++;
      },
    ),
  ).rejects.toThrow("VERSION_CONFLICT");
  const updated = { ...command, expectedRevision: (await revision())! };
  await expect(
    checkCancellationCandidate(
      env,
      updated,
      async () => {
        await env.DB.prepare(
          "UPDATE access_state SET enabled=0 WHERE user_id=?",
        )
          .bind(manager())
          .run();
        return Response.json(validation);
      },
      async () => {
        stops++;
      },
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(stops).toBe(2);
});
it("half-day cancellation unions overlap once, keeps exact rest kind/time and clips minute roles without adding an automatic task", async () => {
  const { deriveCancellation } =
    await import("../../apps/api/src/cancellation-candidate");
  const { loadSources, compileInput } =
    await import("../../apps/api/src/input-snapshots");
  const sources = await loadSources(env.DB, company(), f.team, "2026-10");
  const current = compileInput(
    company(),
    f.team,
    "2026-10",
    crypto.randomUUID(),
    sources,
  ).input;
  const original = assignments();
  original[0].shift!.breakKind = "auto";
  original[0].shift!.cancelled = [[900, 960]];
  original[0].roleIntervals = [
    { start: 600, end: 637, roleId: "sv" },
    { start: 930, end: 990, roleId: "sv" },
  ];
  current.published = current.published.map((a) =>
    a.date === "2026-10-01" ? { ...a, shift: original[0].shift } : a,
  );
  const result = deriveCancellation(current, original, {
    staffId: f.staff.staffId,
    date: "2026-10-01",
    start: 900,
    end: 1020,
  });
  expect(result.assignments[0].shift).toMatchObject({
    start: 600,
    end: 1020,
    breakKind: "auto",
    break: [780, 840],
    cancelled: [[900, 1020]],
    workedMinutes: 240,
  });
  expect(result.assignments[0].roleIntervals).toEqual([
    { start: 600, end: 637, roleId: "sv" },
  ]);
  expect(result.assignments[0].blocks.every((b) => b.start < 900)).toBe(true);
  expect(original[0].shift?.cancelled).toEqual([[900, 960]]);
  expect(current.published[0].shift?.cancelled).toEqual([[900, 960]]);
});
it("overlapping event removal affects only the target participant and reveals the remaining gap instead of inventing a task", async () => {
  const { deriveCancellation } =
    await import("../../apps/api/src/cancellation-candidate");
  const { loadSources, compileInput } =
    await import("../../apps/api/src/input-snapshots");
  const current = compileInput(
    company(),
    f.team,
    "2026-10",
    crypto.randomUUID(),
    await loadSources(env.DB, company(), f.team, "2026-10"),
  ).input;
  const other = "fictional-other",
    e = {
      id: "crossing",
      kind: "meeting" as const,
      date: "2026-10-01",
      start: 690,
      end: 750,
      staffIds: [f.staff.staffId, other],
    };
  current.events = [e];
  const original = assignments();
  original[0].blocks = original[0].blocks.filter(
    (b) => b.start !== 690 && b.start !== 720,
  );
  const result = deriveCancellation(current, original, {
    staffId: f.staff.staffId,
    date: "2026-10-01",
    start: 600,
    end: 720,
  });
  expect(result.input.events[0].staffIds).toEqual([other]);
  expect(result.removedParticipations).toEqual([
    {
      eventId: "crossing",
      staffId: f.staff.staffId,
      date: e.date,
      start: 690,
      end: 750,
    },
  ]);
  expect(result.assignments[0].blocks.some((b) => b.start === 720)).toBe(false);
  expect(current.events[0].staffIds).toEqual([f.staff.staffId, other]);
});

it("cancellation DO shares the compute/manual-check fence and retains failed-stop evidence until old process termination", async () => {
  const { runInDurableObject } = await import("cloudflare:test");
  const c = input();
  await submit(c);
  const command = {
    operationId: crypto.randomUUID(),
    companyId: company(),
    teamId: f.team,
    userId: manager(),
    requestId: c.operationId,
    expectedRevision: (await revision())!,
    expectedRequestRevision: 1,
    publicationId,
    expectedPublicationRevision: 1,
  };
  const stub = env.SOLVER.getByName(
    "cancellation-fence:" + crypto.randomUUID(),
  );
  await runInDurableObject(stub, async (instance, state) => {
    let running = true,
      failStop = true,
      entered!: () => void,
      release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
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
    const transport = vi
      .spyOn(instance, "containerFetch")
      .mockImplementation(async () => {
        entered();
        await gate;
        return Response.json(validation);
      });
    try {
      const checking = instance.checkCancellation(command);
      await ready;
      expect(JSON.parse(await instance.checkCancellation(command))).toEqual({
        ok: false,
        error: "CHECK_BUSY",
        status: 409,
      });
      expect(await instance.diagnoseTransport()).toEqual({ busy: true });
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
        expect(running).toBe(false);
        running = true;
        return Response.json(validation);
      });
      const encoded = await instance.checkCancellation(command);
      expect(JSON.parse(encoded)).toMatchObject({
        ok: true,
        result: {
          approval: "NOT_COMMITTED",
          validation: { status: "VERIFIED" },
        },
      });
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
it("cancellation HTTP keeps RPC business conflicts distinct from an unconfirmed process stop", async () => {
  const { runInDurableObject } = await import("cloudflare:test");
  const c = input();
  await submit(c);
  const command = {
    operationId: crypto.randomUUID(),
    companyId: company(),
    teamId: f.team,
    userId: manager(),
    requestId: c.operationId,
    expectedRevision: (await revision())!,
    expectedRequestRevision: 1,
    publicationId,
    expectedPublicationRevision: 1,
  };
  const app = new Hono<ApiEnv>();
  app.use("*", async (ctx, next) => {
    ctx.set("identity", { userId: manager(), mustChange: false });
    await next();
  });
  app.route("/api", leaveRoutes());
  const post = () =>
    app.request(
      `/api/companies/${company()}/schedules/teams/${f.team}/leave/${c.operationId}/cancellation-check`,
      {
        method: "POST",
        headers: {
          origin: env.AUTH_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationId: command.operationId,
          expectedRevision: command.expectedRevision,
          expectedRequestRevision: 1,
          publicationId,
          expectedPublicationRevision: 1,
        }),
      },
      env,
    );
  const stub = env.SOLVER.getByName(`company:${company()}:team:${f.team}`);
  await runInDurableObject(stub, async (instance, state) => {
    let entered!: () => void,
      release!: () => void,
      running = false,
      failStop = false;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
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
    const transport = vi
      .spyOn(instance, "containerFetch")
      .mockImplementation(async () => {
        running = true;
        entered();
        await gate;
        return Response.json(validation);
      });
    try {
      const first = instance.checkCancellation(command);
      await ready;
      const busy = await post();
      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({ error: "CHECK_BUSY" });
      release();
      expect(JSON.parse(await first).ok).toBe(true);
      transport.mockImplementation(async () => {
        running = true;
        failStop = true;
        return Response.json(validation);
      });
      const failed = await post();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "INTERNAL_ERROR" });
      expect(instance.executionState()).toMatchObject({
        persistedCheckFence: true,
        processRunning: true,
      });
      failStop = false;
      transport.mockImplementation(async () => {
        running = true;
        await env.DB.prepare(
          "UPDATE access_state SET enabled=0 WHERE user_id=?",
        )
          .bind(manager())
          .run();
        return Response.json(validation);
      });
      const forbidden = await post();
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toEqual({ error: "FORBIDDEN" });
      expect(instance.executionState()).toMatchObject({
        persistedCheckFence: false,
        processRunning: false,
      });
      expect((await read(c.operationId)).record.status).toBe("PENDING");
      expect(
        (
          await readPublicationHead(
            env,
            company(),
            f.team,
            f.staffUser,
            "2026-10",
          )
        ).publication!.publicationId,
      ).toBe(publicationId);
    } finally {
      release();
      transport.mockRestore();
    }
  });
});
it("TS-API-03: concurrent fixed release and cancellation refuse the old version; fresh cancellation rechecks released work", async () => {
  const { saveDraft } = await import("../../apps/api/src/schedule-drafts");
  const { releaseFixed } = await import("../../apps/api/src/published-fixed");
  const { checkCancellationCandidate } =
    await import("../../apps/api/src/cancellation-check");
  const c = input();
  await submit(c);
  let r = (await revision())!;
  const snapshotId = crypto.randomUUID();
  await createInputSnapshot(env.DB, env.INPUTS, company(), f.team, manager(), {
    operationId: snapshotId,
    expectedRevision: r,
    month: "2026-10",
  });
  const job = (
    await createJob(env.DB, env.INPUTS, company(), f.team, manager(), {
      operationId: crypto.randomUUID(),
      snapshotId,
      expectedRevision: r,
    })
  ).job;
  await executeJob(
    env,
    { version: 1, companyId: company(), teamId: f.team, jobId: job.id },
    async (path, payload) =>
      Response.json(
        path === "/solve"
          ? { ...payload, solverStatus: "FEASIBLE", assignments: assignments() }
          : validation,
      ),
    async () => {},
  );
  const draftId = crypto.randomUUID();
  await saveDraft(
    env,
    company(),
    f.team,
    manager(),
    {
      operationId: draftId,
      expectedRevision: r,
      expectedDraftRevision: 0,
      sourceJobId: job.id,
      assignments: assignments(),
      locks: [
        {
          id: crypto.randomUUID(),
          staffId: f.staff.staffId,
          date: c.date,
          parts: ["pattern", "time", "break"],
          shift: assignments()[0].shift,
        },
      ],
      exceptions: [],
    },
    check,
  );
  const fixedPublication = crypto.randomUUID();
  await publishSchedule(
    env,
    company(),
    f.team,
    manager(),
    {
      operationId: fixedPublication,
      expectedRevision: r,
      expectedDraftRevision: 1,
      expectedPublicationRevision: 1,
      source: { kind: "draft", id: draftId },
      acknowledgeShortage: false,
    },
    check,
  );
  r = (await revision())!;
  let calls = 0,
    stops = 0;
  const command = {
    operationId: crypto.randomUUID(),
    companyId: company(),
    teamId: f.team,
    userId: manager(),
    requestId: c.operationId,
    expectedRevision: r,
    expectedRequestRevision: 1,
    publicationId: fixedPublication,
    expectedPublicationRevision: 2,
  };
  await expect(
    checkCancellationCandidate(
      env,
      command,
      async () => {
        calls++;
        return Response.json(validation);
      },
      async () => {
        stops++;
      },
    ),
  ).rejects.toThrow("LEAVE_FIXED_RELEASE_REQUIRED");
  expect(calls).toBe(0);
  expect(stops).toBe(1);
  const release = {
    operationId: crypto.randomUUID(),
    expectedRevision: r,
    publicationId: fixedPublication,
    expectedPublicationRevision: 2,
    staffId: f.staff.staffId,
    date: c.date,
    parts: ["pattern", "time", "break"] as ("pattern" | "time" | "break")[],
  };
  const cancellation = {
    operationId: crypto.randomUUID(),
    expectedRevision: r,
    expectedRequestRevision: 1,
    publicationId: fixedPublication,
    expectedPublicationRevision: 2,
    acknowledgeShortage: false,
  };
  let commitChecks = 0;
  const verify: typeof cancellationVerifier = async cmd => {
    commitChecks++;
    return cancellationVerifier(cmd);
  };
  // Both operations begin with exactly the same company/publication versions.
  // A release cannot make the already-issued cancellation command current.
  const raced = await Promise.allSettled([
    commitCancellation(c.operationId, cancellation, verify),
    releaseFixed(env, company(), f.team, manager(), release),
  ]);
  expect(raced[1].status).toBe("fulfilled");
  expect(raced[0].status).toBe("rejected");
  if (raced[0].status === "rejected") {
    expect(["LEAVE_FIXED_RELEASE_REQUIRED", "VERSION_CONFLICT"]).toContain(raced[0].reason.code);
  }
  expect(commitChecks).toBe(0);
  expect(await revision()).toBe(r + 1);
  expect((await read(c.operationId)).record.status).toBe("PENDING");
  expect((await readPublicationHead(env, company(), f.team, manager(), "2026-10"))
    .publication?.publicationId).toBe(fixedPublication);
  for (const table of ["leave_cancellation_operation", "schedule_publication_version"]) {
    expect(await env.DB.prepare(`SELECT count(*) n FROM ${table} WHERE company_id=? AND id=?`)
      .bind(company(), cancellation.operationId).first("n")).toBe(0);
  }
  const result = await checkCancellationCandidate(
    env,
    { ...command, expectedRevision: r + 1 },
    async () => {
      calls++;
      return Response.json(validation);
    },
    async () => {
      stops++;
    },
  );
  expect(result.approval).toBe("NOT_COMMITTED");
  expect(calls).toBe(1);
  expect(stops).toBe(2);
  const fresh = { ...cancellation, expectedRevision: r + 1 };
  const committed = await commitCancellation(c.operationId, fresh, verify);
  expect(committed.replayed).toBe(false);
  expect(commitChecks).toBe(1);
  expect(await revision()).toBe(r + 2);
  expect((await read(c.operationId)).record.status).toBe("APPROVED");
  expect((await readPublicationHead(env, company(), f.team, manager(), "2026-10"))
    .publication?.publicationId).toBe(cancellation.operationId);
  expect((await commitCancellation(c.operationId, fresh, verify)).replayed).toBe(true);
  expect(commitChecks).toBe(1);
  expect(await revision()).toBe(r + 2);
  expect((await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices
    .filter(n => n.id === cancellation.operationId)).toHaveLength(1);
});
it("split manual unavailable exceptions retain only previously authorized remaining minutes with bounded collision-free IDs", async () => {
  const { deriveCancellation } =
    await import("../../apps/api/src/cancellation-candidate");
  const { loadSources, compileInput } =
    await import("../../apps/api/src/input-snapshots");
  const current = compileInput(
    company(),
    f.team,
    "2026-10",
    crypto.randomUUID(),
    await loadSources(env.DB, company(), f.team, "2026-10"),
  ).input;
  current.exceptions = [
    {
      id: "x".repeat(128),
      staffId: f.staff.staffId,
      date: "2026-10-01",
      start: 700,
      end: 740,
      reason: "架空の許可済み区間",
      lockId: null,
    },
    {
      id: "cancellation-remaining:0:0:0",
      staffId: f.staff.staffId,
      date: "2026-10-02",
      start: 600,
      end: 620,
      reason: "架空の別日区間",
      lockId: null,
    },
  ];
  const result = deriveCancellation(current, assignments(), {
    staffId: f.staff.staffId,
    date: "2026-10-01",
    start: 600,
    end: 720,
  });
  expect(result.input.exceptions.map((e) => [e.date, e.start, e.end])).toEqual([
    ["2026-10-01", 720, 740],
    ["2026-10-02", 600, 620],
  ]);
  expect(new Set(result.input.exceptions.map((e) => e.id)).size).toBe(2);
  expect(result.input.exceptions.every((e) => e.id.length <= 128)).toBe(true);
  expect(current.exceptions[0].start).toBe(700);
});

// Atomic commit tests use controlled checker transport. Native checker/Container
// acceptance is measured separately; a forged VERIFIED stub is not that proof.
async function cancellationCommand(requestId: string) {
  return {
    operationId: crypto.randomUUID(),
    expectedRevision: (await revision())!,
    expectedRequestRevision: 1,
    publicationId,
    expectedPublicationRevision: 1,
    acknowledgeShortage: false,
  };
}
async function cancellationVerifier(
  command: import("../../apps/api/src/cancellation-contract").CancellationCandidateCommand,
  v: unknown = validation,
) {
  const { checkCancellationCandidate } =
    await import("../../apps/api/src/cancellation-check");
  return checkCancellationCandidate(
    env,
    command,
    async () => Response.json(v),
    async () => {},
  );
}
async function commitCancellation(
  requestId: string,
  c: Awaited<ReturnType<typeof cancellationCommand>>,
  verify = cancellationVerifier,
  e: Parameters<
    typeof import("../../apps/api/src/leave-cancellation").commitLeaveCancellation
  >[0] = env,
) {
  const { commitLeaveCancellation } =
    await import("../../apps/api/src/leave-cancellation");
  return commitLeaveCancellation(
    e,
    company(),
    f.team,
    manager(),
    requestId,
    c,
    verify,
  );
}
it.each(['audit','commit','head','revision','notice','participation','validation-head'])('cancellation silent %s omission preserves publication request and participation until same-ID repair',async fault=>{
  const {readPublicationHead}=await import('../../apps/api/src/schedule-publications');
  const request=input();await submit(request);const c=await cancellationCommand(request.operationId);
  const before=await readPublicationHead(env,company(),f.team,manager(),'2026-10'),r=await revision();
  const target={audit:"BEFORE INSERT ON product_audit WHEN NEW.kind='schedule:cancelled'",commit:'BEFORE INSERT ON schedule_publication_commit',head:'BEFORE UPDATE ON schedule_publication_head',revision:'BEFORE UPDATE ON company',notice:'BEFORE INSERT ON leave_cancellation_notice',participation:'BEFORE INSERT ON planning_participation_removal','validation-head':'BEFORE UPDATE ON publication_validation_head'}[fault];
  await env.DB.prepare(`CREATE TRIGGER cancellation_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
  try{
    await expect(commitCancellation(request.operationId,c)).rejects.toThrow();expect(await revision()).toBe(r);
    expect(await readPublicationHead(env,company(),f.team,manager(),'2026-10')).toEqual(before);
    expect((await readLeave(env.DB,company(),f.team,manager(),request.operationId)).record.status).toBe('PENDING');
    for(const [table,column] of [['leave_cancellation_operation','id'],['schedule_publication_version','id'],['schedule_publication_commit','publication_id'],['planning_participation_removal','operation_id'],['leave_cancellation_notice','event_id'],['product_audit','id']])
      expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND ${column}=?`).bind(company(),c.operationId).first()).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER cancellation_silent_omission').run();}
  expect(await commitCancellation(request.operationId,c)).toMatchObject({replayed:false,status:'APPROVED',publicationRevision:2});
  expect(await commitCancellation(request.operationId,c)).toMatchObject({replayed:true,status:'APPROVED',publicationRevision:2});
});
it("cancellation commit atomically changes current public work, effective participation, request and notices; old evidence and plan remain intact", async () => {
  const { readPublication, publicationHistory } =
    await import("../../apps/api/src/schedule-publications");
  const { loadSources, compileInput } =
    await import("../../apps/api/src/input-snapshots");
  const { resolveVersion } = await import("../../apps/api/src/input-versions");
  const request = input();
  await submit(request);
  const c = await cancellationCommand(request.operationId);
  const before = await readPublication(
    env,
    company(),
    f.team,
    manager(),
    publicationId,
  );
  const plan = await resolveVersion(
    env.DB,
    company(),
    "planning",
    f.team,
    "2026-10",
  );
  const result = await commitCancellation(request.operationId, c);
  const { inspectLeaveCancellation } =
    await import("../../apps/api/src/leave-cancellation");
  expect(
    await inspectLeaveCancellation(
      env.DB,
      company(),
      f.team,
      manager(),
      request.operationId,
      c.operationId,
    ),
  ).toMatchObject({
    found: true,
    result: { publicationId: c.operationId, replayed: true },
  });
  expect(
    await inspectLeaveCancellation(
      env.DB,
      company(),
      f.team,
      manager(),
      crypto.randomUUID(),
      c.operationId,
    ),
  ).toEqual({ found: false });
  await expect(
    inspectLeaveCancellation(
      env.DB,
      company(),
      f.team,
      f.staffUser,
      request.operationId,
      c.operationId,
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(result).toMatchObject({
    status: "APPROVED",
    revision: c.expectedRevision + 1,
    requestRevision: 2,
    publicationId: c.operationId,
    publicationRevision: 2,
    replayed: false,
  });
  const head = await readPublicationHead(
    env,
    company(),
    f.team,
    f.staffUser,
    "2026-10",
  );
  expect(head.publication?.assignments[0].shift).toMatchObject({
    start: 600,
    end: 1020,
    breakKind: "fixed",
    break: [780, 840],
    cancelled: [[600, 1020]],
    workedMinutes: 0,
  });
  expect(head.publication).not.toHaveProperty("cancellation");
  expect(
    (await readPublicationHead(env, company(), f.team, manager(), "2026-10"))
      .publication,
  ).toHaveProperty("cancellation");
  expect((await read(request.operationId)).record).toMatchObject({
    status: "APPROVED",
    requestRevision: 2,
    decidedAt: expect.any(Number),
  });
  const old = await readPublication(
    env,
    company(),
    f.team,
    manager(),
    publicationId,
  );
  expect(old.publication).toEqual(before.publication);
  expect(old.superseded).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT payload FROM work_input_version WHERE company_id=? AND operation_id=?",
    )
      .bind(company(), plan!.operation_id)
      .first("payload"),
  ).toBe(plan!.payload);
  const effective = await resolveVersion(
    env.DB,
    company(),
    "planning",
    f.team,
    "2026-10",
  );
  expect(JSON.parse(effective!.payload).events[0].staffIds).toEqual([]);
  const sources = await loadSources(env.DB, company(), f.team, "2026-10");
  const compiled = compileInput(
    company(),
    f.team,
    "2026-10",
    crypto.randomUUID(),
    sources,
  );
  expect(compiled.input.events[0].staffIds).toEqual([]);
  expect(compiled.input.published[0].shift?.workedMinutes).toBe(0);
  expect(
    compiled.lineage.some(
      (l) =>
        l.kind === "planning_participation_removal" &&
        l.version === c.operationId,
    ),
  ).toBe(true);
  expect(
    (await publicationHistory(env.DB, company(), f.team, manager(), "2026-10"))
      .versions[0].sourceKind,
  ).toBe("cancellation");
  const notices = await leaveNotices(env.DB, company(), f.team, f.staffUser);
  expect(notices.notices.filter((n) => n.id === c.operationId)).toHaveLength(1);
  expect(notices.notices.find((n) => n.id === c.operationId)?.kind).toBe(
    "APPROVED",
  );
  expect(
    await readLeaveNotice(
      env.DB,
      company(),
      f.team,
      f.staffUser,
      c.operationId,
    ),
  ).toMatchObject({ changed: true });
  expect(
    await readLeaveNotice(
      env.DB,
      company(),
      f.team,
      f.staffUser,
      c.operationId,
    ),
  ).toMatchObject({ changed: false });
  expect(
    await commitCancellation(request.operationId, c, async () => {
      throw Error("REPLAY_MUST_NOT_CHECK");
    }),
  ).toMatchObject({ replayed: true });
  expect(await revision()).toBe(c.expectedRevision + 1);
  await expect(
    commitCancellation(request.operationId, {
      ...c,
      acknowledgeShortage: true,
    }),
  ).rejects.toThrow("OPERATION_ID_CONFLICT");
  await expect(reject(request.operationId)).rejects.toThrow(
    "LEAVE_VERSION_CONFLICT",
  );
  expect(
    (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
});
it('TS-NEW-12: reallocation failure and same-job retry never undo an immediate cancellation or republish it',async()=>{
  const request={...input(),part:'AM' as const};await submit(request);
  const cancellation=await cancellationCommand(request.operationId);
  await commitCancellation(request.operationId,cancellation);
  const effects=async()=>({
    manager:await readPublicationHead(env,company(),f.team,manager(),'2026-10'),
    self:await readPublicationHead(env,company(),f.team,f.staffUser,'2026-10'),
    request:await read(request.operationId),
    notices:await leaveNotices(env.DB,company(),f.team,f.staffUser),
    revision:await revision(),
    removals:(await env.DB.prepare('SELECT * FROM planning_participation_removal WHERE company_id=? ORDER BY operation_id,event_id,staff_id').bind(company()).all()).results,
  });
  const before=await effects();
  expect(before.self.publication!.assignments[0].shift).toMatchObject({cancelled:[[600,720]],workedMinutes:240});
  const snapshotId=crypto.randomUUID();
  await createInputSnapshot(env.DB,env.INPUTS,company(),f.team,manager(),{operationId:snapshotId,expectedRevision:before.revision!,month:'2026-10'});
  const frozen=await readInputSnapshot(env.DB,env.INPUTS,company(),f.team,manager(),snapshotId,true);
  expect(frozen.input.mode).toBe('reallocation');
  expect(frozen.input.published[0].shift).toEqual(before.self.publication!.assignments[0].shift);
  const job=(await createJob(env.DB,env.INPUTS,company(),f.team,manager(),{operationId:crypto.randomUUID(),snapshotId,expectedRevision:before.revision!})).job;
  const message={version:1 as const,companyId:company(),teamId:f.team,jobId:job.id};
  expect(await executeJob(env,message,async()=>Response.json({error:'FICTIONAL_TEMPORARY_FAILURE'},{status:500}),async()=>{})).toBe('RETRY');
  expect(await env.DB.prepare('SELECT state,attempt,result_key FROM compute_job WHERE company_id=? AND id=?').bind(company(),job.id).first()).toEqual({state:'QUEUED',attempt:1,result_key:null});
  expect(await effects()).toEqual(before);
  expect(await executeJob(env,message,async(path,payload)=>Response.json(path==='/solve'?{...payload,solverStatus:'FEASIBLE',assignments:before.manager.publication!.assignments}:validation),async()=>{})).toBe('DONE');
  expect(await env.DB.prepare('SELECT state,attempt FROM compute_job WHERE company_id=? AND id=?').bind(company(),job.id).first()).toEqual({state:'SUCCEEDED',attempt:2});
  expect(await effects()).toEqual(before);
  expect(await commitCancellation(request.operationId,cancellation)).toMatchObject({replayed:true,status:'APPROVED'});
  expect(await effects()).toEqual(before);
});

it("absence fact confirmation is distinct from recorded fact; half cancellation keeps remaining public hours and rest", async () => {
  const request = {
    ...input(),
    kind: "ABSENCE_FACT" as const,
    part: "AM" as const,
  };
  await submit(request, manager());
  const c = await cancellationCommand(request.operationId);
  expect((await read(request.operationId)).record.status).toBe("REPORTED");
  expect(await commitCancellation(request.operationId, c)).toMatchObject({
    status: "CANCELLATION_CONFIRMED",
  });
  const head = await readPublicationHead(
    env,
    company(),
    f.team,
    f.staffUser,
    "2026-10",
  );
  expect(head.publication?.assignments[0].shift).toMatchObject({
    cancelled: [[600, 720]],
    workedMinutes: 240,
    start: 600,
    end: 1020,
    break: [780, 840],
    breakKind: "fixed",
  });
  expect((await read(request.operationId)).record.status).toBe(
    "CANCELLATION_CONFIRMED",
  );
});
it("mandatory violations, history gaps and unacknowledged shortages prevent cancellation; ordinary shortage can be explicitly acknowledged", async () => {
  const request = input();
  await submit(request);
  const c = await cancellationCommand(request.operationId);
  for (const v of [
    { ...validation, status: "INVALID", violations: ["MONTHLY_HOURS"] },
    {
      ...validation,
      status: "HISTORY_UNVERIFIED",
      missingHistory: [f.staff.staffId + ":2026-09-30"],
    },
  ])
    await expect(
      commitCancellation(request.operationId, c, (cmd) =>
        cancellationVerifier(cmd, v),
      ),
    ).rejects.toThrow("CANCELLATION_NOT_VERIFIED");
  const short = { ...validation, generalShortage: 30 };
  await expect(
    commitCancellation(request.operationId, c, (cmd) =>
      cancellationVerifier(cmd, short),
    ),
  ).rejects.toThrow("PUBLICATION_SHORTAGE_ACK_REQUIRED");
  expect((await read(request.operationId)).record.status).toBe("PENDING");
  expect(await revision()).toBe(c.expectedRevision);
  expect(
    await commitCancellation(
      request.operationId,
      { ...c, acknowledgeShortage: true },
      (cmd) => cancellationVerifier(cmd, short),
    ),
  ).toMatchObject({ status: "APPROVED" });
});
it("audit failure rolls back every cancellation fact, participant removal, request state and notice; concurrent same ID commits once", async () => {
  const request = input();
  await submit(request);
  const c = await cancellationCommand(request.operationId);
  await env.DB.exec(
    "CREATE TRIGGER cancellation_audit_failure BEFORE INSERT ON product_audit WHEN NEW.kind='schedule:cancelled' BEGIN SELECT RAISE(ABORT,'fictional failure'); END;",
  );
  try {
    await expect(commitCancellation(request.operationId, c)).rejects.toThrow(
      "fictional failure",
    );
  } finally {
    await env.DB.exec("DROP TRIGGER cancellation_audit_failure");
  }
  expect(await revision()).toBe(c.expectedRevision);
  expect((await read(request.operationId)).record.status).toBe("PENDING");
  expect(
    (await readPublicationHead(env, company(), f.team, manager(), "2026-10"))
      .publication?.publicationId,
  ).toBe(publicationId);
  for (const [table, key] of [
    ["leave_cancellation_operation", "id"],
    ["planning_participation_removal", "operation_id"],
    ["leave_cancellation_notice", "event_id"],
    ["schedule_publication_version", "id"],
  ] as const)
    expect(
      await env.DB.prepare(
        `SELECT count(*) n FROM ${table} WHERE company_id=? AND ${key}=?`,
      )
        .bind(company(), c.operationId)
        .first("n"),
    ).toBe(0);
  const results = await Promise.all([
    commitCancellation(request.operationId, c),
    commitCancellation(request.operationId, c),
  ]);
  expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  expect(await revision()).toBe(c.expectedRevision + 1);
  expect(
    (await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices.filter(
      (n) => n.id === c.operationId,
    ),
  ).toHaveLength(1);
});
it("input changes or permission loss after checker stop cannot commit an old cancellation proof", async () => {
  const request = input();
  await submit(request);
  const c = await cancellationCommand(request.operationId);
  await expect(
    commitCancellation(request.operationId, c, async (cmd) => {
      const v = await cancellationVerifier(cmd);
      await env.DB.prepare("UPDATE company SET revision=revision+1 WHERE id=?")
        .bind(company())
        .run();
      return v;
    }),
  ).rejects.toThrow("VERSION_CONFLICT");
  expect((await read(request.operationId)).record.status).toBe("PENDING");
  const updated = {
    ...c,
    operationId: crypto.randomUUID(),
    expectedRevision: (await revision())!,
  };
  const scoped: InputDatabase = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements) => {
      await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?")
        .bind(manager())
        .run();
      return env.DB.batch(statements);
    },
  };
  await expect(
    commitCancellation(request.operationId, updated, cancellationVerifier, {
      DB: scoped,
      INPUTS: env.INPUTS,
    }),
  ).rejects.toThrow("FORBIDDEN");
  expect((await read(request.operationId)).record.status).toBe("PENDING");
  expect(
    (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
});
it("cancellation rejects a mismatched checker certificate and D1 rejects changed public rest even within the same batch", async () => {
  const request = input();
  await submit(request);
  const c = await cancellationCommand(request.operationId);
  await expect(
    commitCancellation(request.operationId, c, async (cmd) => ({
      ...(await cancellationVerifier(cmd)),
      publicationId: crypto.randomUUID(),
    })),
  ).rejects.toThrow("IDENTITY_MISMATCH");
  const tampered: InputDatabase = {
    batch: env.DB.batch.bind(env.DB),
    prepare: (sql) => {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("INSERT INTO schedule_publication_assignment("))
        return statement;
      return new Proxy(statement, {
        get(target, key) {
          if (key === "bind")
            return (...args: unknown[]) => {
              const assignments = JSON.parse(args[3] as string);
              assignments[0].shift.break = [840, 900];
              args[3] = JSON.stringify(assignments);
              return target.bind(...args);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  await expect(
    commitCancellation(request.operationId, c, cancellationVerifier, {
      DB: tampered,
      INPUTS: env.INPUTS,
    }),
  ).rejects.toThrow("CANCELLATION_FACT_CONFLICT");
  expect(await revision()).toBe(c.expectedRevision);
  expect((await read(request.operationId)).record.status).toBe("PENDING");
  expect(
    (await readPublicationHead(env, company(), f.team, manager(), "2026-10"))
      .publication?.publicationId,
  ).toBe(publicationId);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM leave_cancellation_operation WHERE company_id=? AND id=?",
    )
      .bind(company(), c.operationId)
      .first("n"),
  ).toBe(0);
});

it('cancellation retains the parent roster after a published staff deletion and an inactive new registration',async()=>{
  const request=input();await submit(request);
  const extra=await createStaff(env.DB,company(),f.team,manager(),{operationId:crypto.randomUUID(),expectedRevision:(await revision())!,name:'架空未配置スタッフ',staffNumber:'0002',email:`${crypto.randomUUID()}@example.invalid`});
  const {changeStaffStatus}=await import('../../apps/api/src/staff-lifecycle');
  for(const [id,status] of [[extra.staffId,'inactive'],[f.staff.staffId,'deleted']] as const){
    await changeStaffStatus(env.DB,company(),f.team,id,manager(),{operationId:crypto.randomUUID(),expectedRevision:(await revision())!,status});
  }
  const c=await cancellationCommand(request.operationId);
  expect(await commitCancellation(request.operationId,c)).toMatchObject({status:'APPROVED',publicationRevision:2});
  expect(await env.DB.prepare('SELECT assignment_count FROM schedule_publication_version WHERE company_id=? AND id=?').bind(company(),c.operationId).first('assignment_count')).toBe(31);
  expect(await env.DB.prepare('SELECT count(*) n FROM schedule_publication_assignment WHERE company_id=? AND publication_id=? AND staff_id=?').bind(company(),c.operationId,extra.staffId).first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT status FROM staff WHERE company_id=? AND id=?').bind(company(),f.staff.staffId).first('status')).toBe('deleted');
});
