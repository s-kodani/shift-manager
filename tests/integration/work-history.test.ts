import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { inputFixture } from "../../apps/api/src/input-probes";
import { createApp } from "../../apps/api/src/index";
import {
  historyCommand,
  requiredHistory,
  relevantHistory,
} from "../../apps/api/src/history-contract";
import { readHistory, saveHistory } from "../../apps/api/src/work-history";
import {
  compileInput,
  loadSources,
  createInputSnapshot,
  readInputSnapshot,
} from "../../apps/api/src/input-snapshots";
import { grantTeamAdmin, createTeam } from "../../apps/api/src/product";
import type { InputDatabase } from "../../apps/api/src/input-versions";
let f: Awaited<ReturnType<typeof inputFixture>>;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  f = await inputFixture(env.DB, env.INPUTS);
});
const revision = async () =>
  (await env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(f.company.companyId)
    .first<number>("revision"))!;
const record = (date = "2026-09-30", workedMinutes = 0) => ({
  staffId: f.staff.staffId,
  date,
  workedMinutes,
  evidence: "架空の勤務記録を確認",
});
const command = async (records = [record()]) => ({
  operationId: crypto.randomUUID(),
  expectedRevision: await revision(),
  month: "2026-10",
  records,
});
const save = (
  c: Awaited<ReturnType<typeof command>>,
  user = f.company.userId,
  db: InputDatabase = env.DB,
) => saveHistory(db, f.company.companyId, f.team, user, c);
const read = () =>
  readHistory(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    "2026-10",
  );
const compile = async () =>
  compileInput(
    f.company.companyId,
    f.team,
    "2026-10",
    crypto.randomUUID(),
    await loadSources(env.DB, f.company.companyId, f.team, "2026-10"),
  );
it("Q81/98: required past dates stay missing, confirmed zero is a fact; unknown future does not become missing", async () => {
  const a = await read();
  expect(a.records).toEqual([]);
  expect(a.missing).toHaveLength(6);
  expect(a.required.map((x) => x.date)).toEqual([
    "2026-09-30",
    "2026-09-29",
    "2026-09-28",
    "2026-09-27",
    "2026-09-26",
    "2026-09-25",
  ]);
  expect((await compile()).input.history).toEqual([]);
  await save(await command([record()]));
  const b = await read();
  expect(b.missing).toHaveLength(5);
  expect(b.records[0]).toMatchObject(record());
  await save(await command(b.missing.map((x) => record(x.date))));
  expect((await read()).missing).toEqual([]);
  expect((await compile()).input.history).toHaveLength(6);
  expect(
    (await compile()).input.history.some((x) => x.date >= "2026-11-01"),
  ).toBe(false);
});
it("TS-RULE-06: necessary range respects each staff rule and week boundary, including leap years", async () => {
  const input = (await compile()).input;
  input.month = "2024-03";
  input.weekStart = 0;
  input.staff[0].rules = input.staff[0].rules.map((x) => ({
    ...x,
    maxConsecutive: 2,
  }));
  const other = { ...structuredClone(input.staff[0]), id: crypto.randomUUID() };
  other.rules[0].maxConsecutive = 10;
  input.staff.push(other);
  const r = requiredHistory(input);
  expect(
    r.filter((x) => x.staffId === f.staff.staffId).map((x) => x.date),
  ).toEqual(["2024-02-29", "2024-02-28", "2024-02-27", "2024-02-26"]);
  expect(r.filter((x) => x.staffId === other.id)).toHaveLength(10);
});
it("Q98: frozen input includes confirmed next boundary facts but omits irrelevant future and old history, with provenance", async () => {
  const c = await command([
    record("2026-09-01", 360),
    record("2026-11-01", 420),
    record("2026-11-06", 60),
    record("2026-11-07", 480),
  ]);
  await save(c);
  const result = await compile();
  expect(result.input.history).toEqual([
    expect.objectContaining({ date: "2026-11-01", workedMinutes: 420 }),
    expect.objectContaining({ date: "2026-11-06", workedMinutes: 60 }),
  ]);
  expect(result.lineage.filter((x) => x.kind === "work_history")).toHaveLength(
    2,
  );
  expect(
    result.lineage.find((x) => x.entity.endsWith(":2026-11-01")),
  ).toMatchObject({ version: c.operationId, revision: c.expectedRevision + 1 });
  expect(
    relevantHistory(
      {
        ...result.input,
        weekStart: 0,
        staff: result.input.staff.map((s) => ({
          ...s,
          rules: s.rules.map((r) => ({ ...r, maxConsecutive: 1 })),
        })),
      },
      result.input.history,
    ).map((x) => x.date),
  ).toEqual(["2026-11-01"]);
});
it("WP-02: history correction appends a new fact; old R2 input is immutable and becomes stale", async () => {
  const first = await command();
  await save(first);
  const old = await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    {
      operationId: crypto.randomUUID(),
      expectedRevision: await revision(),
      month: "2026-10",
    },
  );
  const c = await command([record("2026-09-30", 360)]);
  await save(c);
  expect((await read()).records[0]).toMatchObject({
    workedMinutes: 360,
    operationId: c.operationId,
  });
  const historical = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    old.snapshot!.id,
  );
  expect(historical.stale).toBe(true);
  expect(historical.input.history[0].workedMinutes).toBe(0);
  expect(
    (
      await env.DB.prepare(
        "SELECT worked_minutes FROM work_history_version WHERE company_id=? ORDER BY revision",
      )
        .bind(f.company.companyId)
        .all()
    ).results,
  ).toEqual([{ worked_minutes: 0 }, { worked_minutes: 360 }]);
  await expect(
    env.DB.prepare(
      "UPDATE work_history_version SET worked_minutes=60 WHERE company_id=?",
    )
      .bind(f.company.companyId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_HISTORY_VERSION");
  await expect(
    env.DB.prepare("DELETE FROM work_history_operation WHERE company_id=?")
      .bind(f.company.companyId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_HISTORY_OPERATION");
});
it("TS-API: same command replay preserves one version/revision/audit; changed command conflicts", async () => {
  const c = await command(),
    r = await Promise.all([save(c), save(c)]);
  expect(r.filter((x) => x.replayed)).toHaveLength(1);
  expect(await revision()).toBe(c.expectedRevision + 1);
  for (const table of [
    "work_history_operation",
    "work_history_version",
    "product_audit",
  ])
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS n FROM ${table} WHERE company_id=? AND ${table === "work_history_version" ? "operation_id" : "id"}=?`,
      )
        .bind(f.company.companyId, c.operationId)
        .first<number>("n"),
    ).toBe(1);
  await expect(
    save({ ...c, records: [record("2026-09-30", 60)] }),
  ).rejects.toThrow("OPERATION_ID_CONFLICT");
});
it("TS-API: two different commands compete on the same company revision, one wins without partial facts", async () => {
  const a = await command(),
    b = {
      ...a,
      operationId: crypto.randomUUID(),
      records: [record("2026-09-29", 360)],
    };
  const r = await Promise.allSettled([save(a), save(b)]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(r.find((x) => x.status === "rejected")).toMatchObject({
    reason: { code: "VERSION_CONFLICT" },
  });
  expect(await revision()).toBe(a.expectedRevision + 1);
  expect((await read()).records).toHaveLength(1);
});
it("TS-API: a failing final audit rolls back history, operation and company revision, and permits retry", async () => {
  const c = await command([record(), record("2026-09-29", 360)]);
  await env.DB.prepare(
    "CREATE TRIGGER history_audit_fault BEFORE INSERT ON product_audit WHEN NEW.kind='history:confirmed' BEGIN SELECT RAISE(ABORT,'INJECTED_HISTORY_AUDIT'); END",
  ).run();
  try {
    await expect(save(c)).rejects.toThrow("INJECTED_HISTORY_AUDIT");
    expect(await revision()).toBe(c.expectedRevision);
    expect((await read()).records).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT id FROM work_history_operation WHERE company_id=?",
      )
        .bind(f.company.companyId)
        .first(),
    ).toBeNull();
  } finally {
    await env.DB.prepare("DROP TRIGGER history_audit_fault").run();
  }
  expect((await save(c)).replayed).toBe(false);
  expect((await read()).records).toHaveLength(2);
});
it.each(['audit','record','revision'])('history silent %s omission refuses a partial two-row confirmation and repairs the same ID',async fault=>{
  const c=await command([record(),record('2026-09-29',360)]),before=(await read()).records;
  const target=fault==='audit'?"BEFORE INSERT ON product_audit WHEN NEW.kind='history:confirmed'":fault==='record'?"BEFORE INSERT ON work_history_version WHEN NEW.date='2026-09-29'":'BEFORE UPDATE ON company';
  await env.DB.prepare(`CREATE TRIGGER history_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
  try{
    await expect(save(c)).rejects.toThrow();expect(await revision()).toBe(c.expectedRevision);expect((await read()).records).toEqual(before);
    for(const [table,column] of [['work_history_operation','id'],['work_history_version','operation_id'],['product_audit','id']])expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND ${column}=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER history_silent_omission').run();}
  expect(await save(c)).toMatchObject({replayed:false});expect(await save(c)).toMatchObject({replayed:true});expect((await read()).records).toHaveLength(2);
});
it("WP-01: same session replay, read and write are rejected after manager revocation; staff and other scopes are refused", async () => {
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await expect(save(await command(), f.staffUser)).rejects.toThrow("FORBIDDEN");
  await grantTeamAdmin(env.DB, f.company.companyId, f.team, f.company.userId, {
    operationId: crypto.randomUUID(),
    expectedRevision: await revision(),
    userId: f.staffUser,
  });
  const c = await command();
  await save(c, f.staffUser);
  await env.DB.prepare(
    "UPDATE team_member SET role='staff' WHERE company_id=? AND user_id=?",
  )
    .bind(f.company.companyId, f.staffUser)
    .run();
  await expect(save(c, f.staffUser)).rejects.toThrow("FORBIDDEN");
  await expect(
    readHistory(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.staffUser,
      "2026-10",
    ),
  ).rejects.toThrow("FORBIDDEN");
  const other = await inputFixture(env.DB);
  await expect(
    saveHistory(
      env.DB,
      other.company.companyId,
      other.team,
      f.company.userId,
      await command(),
    ),
  ).rejects.toThrow("FORBIDDEN");
  const t = await createTeam(env.DB, f.company.companyId, f.company.userId, {
    operationId: crypto.randomUUID(),
    expectedRevision: await revision(),
    name: "別の架空チーム",
  });
  await expect(
    saveHistory(
      env.DB,
      f.company.companyId,
      t.teamId,
      f.company.userId,
      await command(),
    ),
  ).rejects.toThrow("UNKNOWN_STAFF");
});
it("WP-01: permission changes between API authorization and D1 batch, and inside the batch, prevent writes", async () => {
  const c = await command();
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T = unknown>(
      s: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> => {
      await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?")
        .bind(f.company.userId)
        .run();
      return env.DB.batch<T>(s);
    },
  };
  await expect(save(c, f.company.userId, db)).rejects.toThrow("FORBIDDEN");
  expect(await revision()).toBe(c.expectedRevision);
  await env.DB.prepare("UPDATE access_state SET enabled=1 WHERE user_id=?")
    .bind(f.company.userId)
    .run();
  await env.DB.prepare(
    "CREATE TRIGGER history_revoke_mid AFTER INSERT ON work_history_operation BEGIN UPDATE access_state SET enabled=0 WHERE user_id=NEW.actor_id; END",
  ).run();
  try {
    await expect(save(c)).rejects.toThrow("FORBIDDEN");
    expect(await revision()).toBe(c.expectedRevision);
    expect((await read()).records).toEqual([]);
  } finally {
    await env.DB.prepare("DROP TRIGGER history_revoke_mid").run();
  }
});
it("history registration rejects invalid dates, duplicates, unverifiable values and out-of-bound or current-month records", async () => {
  const c = await command();
  for (const row of [
    record("2026-02-30"),
    record("2026-09-30", -1),
    record("2026-09-30", 1441),
    { ...record(), evidence: "  " },
    { ...record(), workedMinutes: 0.5 },
    { ...record(), status: "VERIFIED" },
  ])
    expect(historyCommand.safeParse({ ...c, records: [row] }).success).toBe(
      false,
    );
  expect(
    historyCommand.safeParse({ ...c, records: [record(), record()] }).success,
  ).toBe(false);
  for (const date of ["2026-10-01", "2026-08-30", "2026-12-02"])
    await expect(save({ ...c, records: [record(date)] })).rejects.toThrow(
      "HISTORY_OUTSIDE_BOUNDARY",
    );
  await expect(
    save({ ...c, records: [{ ...record(), staffId: crypto.randomUUID() }] }),
  ).rejects.toThrow("UNKNOWN_STAFF");
  expect(await revision()).toBe(c.expectedRevision);
});
it("history HTTP keeps authentication/initial change/origin/strict inputs and no-store boundaries", async () => {
  const app = createApp(),
    base = env.AUTH_BASE_URL,
    path = `${base}/api/companies/${f.company.companyId}/inputs/teams/${f.team}/history`;
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
  const headers = {
      origin: base,
      "content-type": "application/json",
      cookie: login.headers.get("set-cookie")!.split(";")[0],
    },
    c = await command();
  expect((await app.request(path + "/2026-10", {}, env)).status).toBe(401);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=1 WHERE user_id=?",
  )
    .bind(f.company.userId)
    .run();
  expect(
    (
      await app.request(
        path,
        { method: "POST", headers, body: JSON.stringify(c) },
        env,
      )
    ).status,
  ).toBe(403);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.company.userId)
    .run();
  expect(
    (
      await app.request(
        path,
        {
          method: "POST",
          headers: { ...headers, origin: "https://invalid.example" },
          body: JSON.stringify(c),
        },
        env,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        path,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...c,
            records: [{ ...record(), status: "VERIFIED" }],
          }),
        },
        env,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(
        path,
        { method: "POST", headers, body: JSON.stringify(c) },
        env,
      )
    ).status,
  ).toBe(200);
  const r = await app.request(path + "/2026-10", { headers }, env);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(((await r.json()) as { missing: unknown[] }).missing).toHaveLength(5);
});
