import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { contractOptions } from "../../apps/api/src/input-catalogs";
import {
  inputFixture,
  probeEmployment,
  probePolicy,
  probeRule,
} from "../../apps/api/src/input-probes";
import { createApp } from "../../apps/api/src/index";
import { createTeam, grantTeamAdmin } from "../../apps/api/src/product";
import { saveInputVersion } from "../../apps/api/src/input-versions";
import {
  createInputSnapshot,
  readInputSnapshot,
} from "../../apps/api/src/input-snapshots";
let f: Awaited<ReturnType<typeof inputFixture>>;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  f = await inputFixture(env.DB);
});
const options = (user = f.company.userId, team = f.team, month = "2026-10") =>
  contractOptions(env.DB, f.company.companyId, team, user, month);
const op = () => ({ operationId: crypto.randomUUID(), expectedRevision: 0 });
async function revision() {
  return (await env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(f.company.companyId)
    .first<number>("revision"))!;
}
async function request(path: string, body?: object) {
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
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  return app.request(
    base + path,
    {
      method: body ? "POST" : "GET",
      headers: { cookie, origin: base, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}
it("WP-02/Q118: catalog resolves effective month before latest revision, scopes company and excludes future choices", async () => {
  await f.save(
    "employment_policy",
    { ...probeEmployment, name: "架空12月区分" },
    f.employment,
    "2026-12",
  );
  await f.save(
    "employment_policy",
    { ...probeEmployment, name: "架空10月区分" },
    f.employment,
    "2026-10",
  );
  const future = crypto.randomUUID();
  await f.save("employment_policy", probeEmployment, future, "2026-12");
  await inputFixture(env.DB);
  const october = await options(),
    december = await options(f.company.userId, f.team, "2026-12");
  expect(october.employment).toHaveLength(1);
  expect(october.employment[0].payload.name).toBe("架空10月区分");
  expect(december.employment).toHaveLength(2);
  expect(
    december.employment.find((e) => e.id === f.employment)!.payload.name,
  ).toBe("架空12月区分");
  expect(october.policy).toEqual(probePolicy);
  expect(october.revision).toBe(await revision());
  expect(october.employment[0]).not.toHaveProperty("actor_id");
  expect(october.employment[0]).not.toHaveProperty("fingerprint");
});
it("WP-01/02/Q99: own team managers read shared choices, staff/other teams cannot; company mutations remain restricted", async () => {
  await expect(options(f.staffUser)).rejects.toThrow("FORBIDDEN");
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await expect(options(f.staffUser)).rejects.toThrow("FORBIDDEN");
  await grantTeamAdmin(env.DB, f.company.companyId, f.team, f.company.userId, {
    ...op(),
    expectedRevision: await revision(),
    userId: f.staffUser,
  });
  expect((await options(f.staffUser)).employment).toHaveLength(1);
  const other = await createTeam(
    env.DB,
    f.company.companyId,
    f.company.userId,
    { ...op(), expectedRevision: await revision(), name: "架空別チーム" },
  );
  await expect(options(f.staffUser, other.teamId)).rejects.toThrow("FORBIDDEN");
  await expect(
    saveInputVersion(
      env.DB,
      {
        company: f.company.companyId,
        team: null,
        staff: null,
        kind: "employment_policy",
        entity: f.employment,
      },
      f.staffUser,
      {
        ...op(),
        expectedRevision: await revision(),
        effectiveFrom: "2026-10",
        payload: probeEmployment,
      },
    ),
  ).rejects.toThrow("FORBIDDEN");
  await env.DB.prepare(
    "DELETE FROM team_member WHERE company_id=? AND team_id=? AND user_id=?",
  )
    .bind(f.company.companyId, f.team, f.staffUser)
    .run();
  await expect(options(f.staffUser)).rejects.toThrow("FORBIDDEN");
});
it("WP-01/02: revocation or revision change during catalog read never returns a mixed editable choice set", async () => {
  const database = {
    prepare: (sql: string) => {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("SELECT entity_id")) return statement;
      return {
        bind: (...values: Parameters<D1PreparedStatement["bind"]>) => ({
          all: async () => {
            await env.DB.prepare(
              "UPDATE access_state SET enabled=0 WHERE user_id=?",
            )
              .bind(f.company.userId)
              .run();
            return statement.bind(...values).all();
          },
        }),
      } as D1PreparedStatement;
    },
    batch: env.DB.batch.bind(env.DB),
  };
  await expect(
    contractOptions(
      database,
      f.company.companyId,
      f.team,
      f.company.userId,
      "2026-10",
    ),
  ).rejects.toThrow("FORBIDDEN");
  await env.DB.prepare("UPDATE access_state SET enabled=1 WHERE user_id=?")
    .bind(f.company.userId)
    .run();
  const changed = {
    prepare: (sql: string) => {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("SELECT entity_id")) return statement;
      return {
        bind: (...values: Parameters<D1PreparedStatement["bind"]>) => ({
          all: async () => {
            await f.save("company_policy", probePolicy);
            return statement.bind(...values).all();
          },
        }),
      } as D1PreparedStatement;
    },
    batch: env.DB.batch.bind(env.DB),
  };
  await expect(
    contractOptions(
      changed,
      f.company.companyId,
      f.team,
      f.company.userId,
      "2026-10",
    ),
  ).rejects.toThrow("VERSION_CONFLICT");
});
it("WP-02/Q119: HTTP contract editing preserves common rules, skill eligibility and per-task capacity in frozen input", async () => {
  const path = `/api/companies/${f.company.companyId}/inputs/teams/${f.team}/staff/${f.staff.staffId}/contract`;
  const r = await request(path, {
    ...op(),
    expectedRevision: await revision(),
    effectiveFrom: "2026-10",
    payload: {
      ...f.profile,
      rule: null,
      skills: [
        { taskId: "phone", level: 0 },
        { taskId: "supervision", level: 1 },
      ],
      roleIds: [],
    },
  });
  expect(r.status).toBe(200);
  const id = crypto.randomUUID();
  await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    { operationId: id, expectedRevision: await revision(), month: "2026-10" },
  );
  const frozen = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    id,
  );
  expect(frozen.input.staff[0].rules.map((r) => r.dailyMax)).toEqual([
    probeRule.dailyMax,
    probeEmployment.rule.dailyMax,
  ]);
  expect(frozen.input.staff[0].skills).toContainEqual({
    taskId: "phone",
    level: 0,
    capacity: 50,
  });
  expect(frozen.input.tasks.find((t) => t.id === "phone")!.minimumLevel).toBe(
    1,
  );
  expect(frozen.input.staff[0].roleIds).toEqual([]);
});
it("WP-02: HTTP choices are no-store, malformed scope is rejected and invalid contract never advances revision", async () => {
  const root = `/api/companies/${f.company.companyId}/inputs/teams/${f.team}`;
  const catalog = await request(root + "/contract-options/2026-10");
  expect(catalog.status).toBe(200);
  expect(catalog.headers.get("cache-control")).toBe("no-store");
  expect((await request(root + "/contract-options/2026-13")).status).toBe(400);
  expect(
    (
      await request(
        root.replace(f.team, "invalid") + "/contract-options/2026-10",
      )
    ).status,
  ).toBe(400);
  const before = await revision();
  for (const contract of [
    { ...f.profile.contract, start: 601 },
    { ...f.profile.contract, start: 1080, end: 1140 },
    { ...f.profile.contract, weekdays: [6] },
  ]) {
    expect(
      (
        await request(root + "/staff/" + f.staff.staffId + "/contract", {
          ...op(),
          expectedRevision: before,
          effectiveFrom: "2026-10",
          payload: { ...f.profile, contract },
        })
      ).status,
    ).toBe(400);
    expect(await revision()).toBe(before);
  }
});
