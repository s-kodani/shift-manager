import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { Hono } from "hono";
import { inputFixture, probeConfig } from "../../apps/api/src/input-probes";
import {
  buildDemandCsvPreview,
  applyDemandCsv,
  readDemandCsvReceipt,
} from "../../apps/api/src/demand-csv";
import { resolveVersion } from "../../apps/api/src/input-versions";
import { parseCsv } from "../../apps/api/src/csv";
import { inputRoutes } from "../../apps/api/src/input-routes";
import { createApp } from "../../apps/api/src/index";
import { type ApiEnv } from "../../apps/api/src/product";

let f: Awaited<ReturnType<typeof inputFixture>>;
const company = () => f.company.companyId,
  manager = () => f.company.userId;
const header = "date,start,end,task_id,direct,calculated\n";
const csv =
  header +
  "2026-10-01,10:00,10:30,phone,0,2.75\n2026-10-02,11:30,12:00,phone,,1.23\n2026-11-01,10:00,10:30,phone,1,\n";
const revision = async () =>
  (await env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(company())
    .first<number>("revision"))!;
const plan = async () =>
  JSON.parse(
    (await resolveVersion(env.DB, company(), "planning", f.team, "2026-10"))!
      .payload,
  );
const command = async (text = csv) => ({
  month: "2026-10",
  expectedRevision: await revision(),
  csv: text,
});
const preview = async (text = csv, user = manager(), team = f.team) =>
  buildDemandCsvPreview(env, company(), team, user, await command(text));
async function applyCommand(text = csv) {
  const c = await command(text);
  return {
    ...c,
    operationId: crypto.randomUUID(),
    previewSha256: (
      await buildDemandCsvPreview(env, company(), f.team, manager(), c)
    ).preview.previewSha256,
  };
}
const apply = (c: Awaited<ReturnType<typeof applyCommand>>, user = manager()) =>
  applyDemandCsv(env, company(), f.team, user, c);
const absent = async (id: string) => {
  for (const [table, column] of [
    ["input_operation", "id"],
    ["work_input_version", "operation_id"],
    ["demand_csv_receipt", "operation_id"],
    ["product_audit", "id"],
  ])
    expect(
      await env.DB.prepare(
        `SELECT 1 FROM ${table} WHERE company_id=? AND ${column}=?`,
      )
        .bind(company(), id)
        .first(),
    ).toBeNull();
};
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  f = await inputFixture(env.DB, env.INPUTS);
});

it("CSV preview/abort changes no business state; valid rows upsert demand with exact zero/precision and preserve all other planning", async () => {
  const r = await revision(),
    original = await plan();
  const p = await preview();
  expect(p.preview).toMatchObject({
    added: 1,
    replaced: 1,
    inputRevision: r,
    capacityScale: 100,
  });
  expect(
    p.preview.rows.map((r) => [
      r.line,
      r.action,
      r.demand?.direct,
      r.demand?.calculated,
    ]),
  ).toEqual([
    [2, "REPLACE", 0, 275],
    [3, "ADD", null, 123],
    [4, null, undefined, undefined],
  ]);
  expect(p.preview.rows[2].errors).toContainEqual({
    column: "date",
    code: "OUTSIDE_MONTH",
  });
  expect(await revision()).toBe(r);
  expect(await plan()).toEqual(original);
  const c = await applyCommand();
  expect(await apply(c)).toMatchObject({
    id: c.operationId,
    revision: r + 1,
    importedRows: 2,
    rejectedRows: 1,
    added: 1,
    replaced: 1,
    replayed: false,
  });
  const saved = await plan();
  const receipt = await apply(c);
  expect(
    await readDemandCsvReceipt(
      env.DB,
      company(),
      f.team,
      manager(),
      c.operationId,
    ),
  ).toEqual({ ...receipt, replayed: false });
  expect(receipt.errors).toEqual([
    { line: 4, errors: [{ column: "date", code: "OUTSIDE_MONTH" }] },
  ]);
  expect(saved.events).toEqual(original.events);
  expect(saved.roleRequirements).toEqual(original.roleRequirements);
  expect(saved.demand).toHaveLength(3);
  expect(saved.demand[0]).toEqual({
    ...original.demand[0],
    direct: 0,
    calculated: 275,
  });
  expect(saved.demand[1]).toEqual(original.demand[1]);
  expect(saved.demand[2]).toMatchObject({
    date: "2026-10-02",
    start: 690,
    end: 720,
    direct: null,
    calculated: 123,
  });
  expect(await revision()).toBe(r + 1);
  expect(
    (
      await env.DB.prepare(
        "SELECT kind FROM product_audit WHERE company_id=? AND id=?",
      )
        .bind(company(), c.operationId)
        .first()
    )?.kind,
  ).toBe("input:planning");
});
it("CSV row errors identify fields without rounding, guessing dates, accepting formulas or partially choosing duplicate keys", async () => {
  const text =
    header +
    [
      "2026-10-03,10:00,10:30,phone,1,",
      "2026-10-03,10:00,10:30,phone,2,",
      "2026-10-04,10:07,10:37,phone,1,",
      "2026-10-05,10:00,10:30,supervision,1,",
      "2026-10-06,10:00,10:30,other-team-task,1,",
      "2026-10-07,10:00,10:30,phone,,",
      "2026-10-08,10:00,10:30,phone,-1,",
      "2026-10-09,10:00,10:30,phone,0.001,",
      "2026-10-10,10:00,10:30,phone,=1+1,",
      "2026-10-32,10:00,10:30,phone,1,",
      "2026-10-11,10:00,10:30,phone,1",
      "2026-10-12,23:30,24:00,phone,0,",
    ].join("\n");
  const p = await preview(text);
  expect(p.preview.rows.map((r) => r.errors.map((e) => e.code))).toEqual([
    ["DUPLICATE_DEMAND"],
    ["DUPLICATE_DEMAND"],
    ["INVALID_DEMAND_SLOT"],
    ["INVALID_DEMAND_TASK"],
    ["INVALID_DEMAND_TASK"],
    ["DEMAND_UNSET"],
    ["CSV_INVALID_NUMBER"],
    ["CSV_INVALID_PRECISION"],
    ["CSV_INVALID_NUMBER"],
    ["CSV_INVALID_DATE"],
    ["CSV_COLUMN_COUNT"],
    [],
  ]);
  expect(p.preview.rows.at(-1)?.demand).toMatchObject({
    start: 1410,
    end: 1440,
    direct: 0,
    calculated: null,
  });
  const onlyBad = header + "2026-10-01,10:00,10:30,phone,,";
  const c = await applyCommand(onlyBad);
  await expect(apply(c)).rejects.toThrow("CSV_NO_VALID_ROWS");
  await absent(c.operationId);
});
it("CSV handles BOM, CRLF, column order, escaped quotes and physical row lines; malformed structure fails the whole file", async () => {
  expect(parseCsv('\ufeffa,b\r\n"x,""y""",z\r\n"two\nlines",w\n')).toEqual([
    { line: 1, cells: ["a", "b"] },
    { line: 2, cells: ['x,"y"', "z"] },
    { line: 3, cells: ["two\nlines", "w"] },
  ]);
  const text =
    '\ufeffcalculated,task_id,end,start,date,direct\r\n2.75,"phone",10:30,10:00,2026-10-01,0\r\n';
  expect((await preview(text)).preview.rows[0].demand).toMatchObject({
    direct: 0,
    calculated: 275,
  });
  const multi =
    header +
    '2026-10-01,10:00,10:30,"phone\nx",1,\n2026-10-02,10:00,10:30,phone,1,';
  expect((await preview(multi)).preview.rows.map((r) => r.line)).toEqual([
    2, 4,
  ]);
  for (const bad of ['a,b\n"unterminated,z', 'a,b\n"x"suffix,z', 'a,b\nx"y,z'])
    expect(() => parseCsv(bad)).toThrow("CSV_INVALID_QUOTES");
  for (const bad of [
    "",
    header,
    "date,start,end,task_id,direct,unknown\n",
    "date,start,end,task_id,direct,direct\n",
  ])
    await expect(preview(bad)).rejects.toThrow(/CSV_EMPTY|CSV_INVALID_HEADER/);
  expect(() => parseCsv("a\u0000b")).toThrow("CSV_INVALID_ENCODING");
  expect(() => parseCsv("\ufffd")).toThrow("CSV_INVALID_ENCODING");
  expect(() => parseCsv("x".repeat(1_000_001))).toThrow("CSV_TOO_LARGE");
  expect(() => parseCsv("a\n" + "x\n".repeat(10_001))).toThrow(
    "CSV_TOO_MANY_ROWS",
  );
});
it("CSV fractional capacity scales require exact integers and never silently round", async () => {
  await f.save("team_config", { ...probeConfig, capacityScale: 3 });
  const p = await preview(
    header +
      [
        "2026-10-02,10:00,10:30,phone,1/3,",
        "2026-10-03,10:00,10:30,phone,0.1,",
        "2026-10-04,10:00,10:30,phone,1/0,",
        "2026-10-05,10:00,10:30,phone,99999999999999999999,",
      ].join("\n"),
  );
  expect(p.preview.rows[0].demand?.direct).toBe(1);
  expect(p.preview.rows.slice(1).map((r) => r.errors[0].code)).toEqual([
    "CSV_INVALID_PRECISION",
    "CSV_INVALID_PRECISION",
    "CSV_NUMBER_OUT_OF_RANGE",
  ]);
});
it("CSV binds preview to exact source/user/team/input; stale or tampered preview cannot change planning", async () => {
  const c = await applyCommand(),
    original = await plan();
  await expect(apply({ ...c, previewSha256: "0".repeat(64) })).rejects.toThrow(
    "CSV_PREVIEW_MISMATCH",
  );
  await expect(
    apply({ ...c, csv: c.csv.replace("2.75", "3.75") }),
  ).rejects.toThrow("CSV_PREVIEW_MISMATCH");
  await absent(c.operationId);
  expect(await plan()).toEqual(original);
  await f.save("planning", f.plan);
  await expect(apply(c)).rejects.toThrow("VERSION_CONFLICT");
  await absent(c.operationId);
});
it("CSV same-operation/concurrent receipts are atomic and immutable; another intent/actor cannot reuse the ID", async () => {
  const c = await applyCommand(),
    r = await revision();
  const outcomes = await Promise.all([apply(c), apply(c)]);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await expect(
    readDemandCsvReceipt(
      env.DB,
      company(),
      f.team,
      f.staffUser,
      outcomes[0].id,
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(outcomes.map((r) => r.replayed).sort()).toEqual([false, true]);
  expect(await revision()).toBe(r + 1);
  expect((await apply(c)).replayed).toBe(true);
  await expect(apply({ ...c, csv: c.csv + "\n" })).rejects.toThrow(
    "OPERATION_ID_CONFLICT",
  );
  await expect(
    env.DB.prepare("UPDATE demand_csv_receipt SET added=0 WHERE company_id=?")
      .bind(company())
      .run(),
  ).rejects.toThrow("IMMUTABLE_CSV_RECEIPT");
  await expect(
    env.DB.prepare("DELETE FROM demand_csv_receipt WHERE company_id=?")
      .bind(company())
      .run(),
  ).rejects.toThrow("IMMUTABLE_CSV_RECEIPT");
});
it("CSV different operations on the same input revision have exactly one winner", async () => {
  const c = await applyCommand(),
    r = await revision();
  const outcomes = await Promise.allSettled([
    apply(c),
    apply({ ...c, operationId: crypto.randomUUID() }),
  ]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "VERSION_CONFLICT" },
  });
  expect(await revision()).toBe(r + 1);
});
it("CSV reconciles the same operation if its winner commits after the retry's initial receipt lookup", async () => {
  const c = await applyCommand(),
    r = await revision();
  let injected = false;
  const db = {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property) {
            if (property === "bind")
              return (...values: unknown[]) => wrap(target.bind(...values));
            if (
              property === "first" &&
              sql === "SELECT revision FROM company WHERE id=?"
            )
              return async (
                ...args: Parameters<D1PreparedStatement["first"]>
              ) => {
                if (!injected) {
                  injected = true;
                  await apply(c);
                }
                return target.first(...args);
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(env.DB.prepare(sql));
    },
    batch: <T>(statements: D1PreparedStatement[]) =>
      env.DB.batch<T>(statements),
  };
  expect(
    await applyDemandCsv(
      { DB: db, INPUTS: env.INPUTS },
      company(),
      f.team,
      manager(),
      c,
    ),
  ).toMatchObject({ replayed: true, revision: r + 1 });
  expect(injected).toBe(true);
  expect(await revision()).toBe(r + 1);
});
it("CSV rejects staff, another company, an unconfigured/foreign team and late permission revocation before any commit", async () => {
  const c = await applyCommand(),
    r = await revision();
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await expect(preview(csv, f.staffUser)).rejects.toThrow("FORBIDDEN");
  await expect(apply(c, f.staffUser)).rejects.toThrow("FORBIDDEN");
  const other = await inputFixture(env.DB, env.INPUTS);
  await expect(
    buildDemandCsvPreview(
      env,
      company(),
      other.team,
      manager(),
      await command(),
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    buildDemandCsvPreview(env, other.company.companyId, other.team, manager(), {
      ...(await command()),
    }),
  ).rejects.toThrow("FORBIDDEN");
  const db = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await env.DB.prepare(
        "DELETE FROM company_admin WHERE company_id=? AND user_id=?",
      )
        .bind(company(), manager())
        .run();
      return env.DB.batch<T>(statements);
    },
  };
  await expect(
    applyDemandCsv({ ...env, DB: db }, company(), f.team, manager(), c),
  ).rejects.toThrow("FORBIDDEN");
  await absent(c.operationId);
  expect(await revision()).toBe(r);
});
it("CSV audit failure rolls back receipt, input version, operation and company revision", async () => {
  const c = await applyCommand(),
    r = await revision(),
    original = await plan();
  await env.DB.prepare(
    "CREATE TRIGGER csv_audit_failure BEFORE INSERT ON product_audit WHEN NEW.kind='input:planning' BEGIN SELECT RAISE(ABORT,'INJECTED_CSV_FAILURE'); END",
  ).run();
  try {
    await expect(apply(c)).rejects.toThrow("INJECTED_CSV_FAILURE");
    await absent(c.operationId);
    expect(await revision()).toBe(r);
    expect(await plan()).toEqual(original);
  } finally {
    await env.DB.prepare("DROP TRIGGER csv_audit_failure").run();
  }
});
it.each(["audit", "receipt"])("demand CSV silent %s omission rolls back planning and preserves the same operation for repair", async fault => {
  const c=await applyCommand(),r=await revision(),original=await plan();
  const target=fault==='audit'?"BEFORE INSERT ON product_audit WHEN NEW.kind='input:planning'":"BEFORE INSERT ON demand_csv_receipt";
  await env.DB.exec(`CREATE TRIGGER demand_csv_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END;`);
  try {await expect(apply(c)).rejects.toThrow();await absent(c.operationId);expect(await revision()).toBe(r);expect(await plan()).toEqual(original);}
  finally {await env.DB.exec('DROP TRIGGER demand_csv_silent_omission');}
  expect(await apply(c)).toMatchObject({importedRows:2,replayed:false});
  expect(await apply(c)).toMatchObject({importedRows:2,replayed:true});
});
it("CSV HTTP preserves origin/body/first-password guards and reports malformed-file positions", async () => {
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("identity", { userId: manager(), mustChange: false });
    await next();
  });
  app.route("/api", inputRoutes());
  const path = `/api/companies/${company()}/inputs/teams/${f.team}/demand-csv/preview`;
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
  expect((await post(await command(), "https://outside.invalid")).status).toBe(
    403,
  );
  const broken = await post(
    await command(header + '2026-10-01,10:00,10:30,"phone,1,'),
  );
  expect(broken.status).toBe(400);
  expect(await broken.json()).toMatchObject({
    error: "CSV_INVALID_QUOTES",
    line: 2,
    column: 4,
  });
  expect(
    (await post({ ...(await command()), csv: "x".repeat(2_000_001) })).status,
  ).toBe(413);
  const valid = await post(await command());
  expect(valid.status).toBe(200);
  expect(valid.headers.get("cache-control")).toBe("no-store");
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
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=1 WHERE user_id=?",
  )
    .bind(manager())
    .run();
  const denied = await createApp().request(
    path,
    {
      method: "POST",
      headers: {
        origin: env.AUTH_BASE_URL,
        "content-type": "application/json",
        cookie: auth.headers.get("set-cookie")!.split(";")[0],
      },
      body: JSON.stringify(await command()),
    },
    env,
  );
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "PASSWORD_CHANGE_REQUIRED" });
});
