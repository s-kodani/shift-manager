import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/index";
import { inputFixture } from "../../apps/api/src/input-probes";
import { grantTeamAdmin } from "../../apps/api/src/product";
import { revokeTeamAdmin } from "../../apps/api/src/team-admin";
import {
  saveInputVersion,
  resolveVersion,
} from "../../apps/api/src/input-versions";
let f: Awaited<ReturnType<typeof inputFixture>>;
const app = createApp(),
  base = env.AUTH_BASE_URL;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  f = await inputFixture(env.DB);
});
const revision = async () =>
  (await env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(f.company.companyId)
    .first<number>("revision"))!;
const op = async () => ({
  operationId: crypto.randomUUID(),
  expectedRevision: await revision(),
  userId: f.staffUser,
});
const role = () =>
  env.DB.prepare(
    "SELECT role FROM team_member WHERE company_id=? AND team_id=? AND user_id=?",
  )
    .bind(f.company.companyId, f.team, f.staffUser)
    .first("role");
async function request(
  path: string,
  cookie: string,
  body?: object,
  origin = base,
) {
  return app.request(
    base + path,
    {
      method: body ? "POST" : "GET",
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}
async function cookie(email: string, password: string) {
  const r = await app.request(
    base + "/api/auth/sign-in/email",
    {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    env,
  );
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const path = (suffix: string) =>
  `/api/companies/${f.company.companyId}/teams/${f.team}${suffix}`;
const inputBase = () =>
  `/api/companies/${f.company.companyId}/inputs/teams/${f.team}`;
it.each(['audit','role','revision'])('team-admin revoke silent %s omission keeps role and revision until the same command is repaired',async fault=>{
  await grantTeamAdmin(env.DB,f.company.companyId,f.team,f.company.userId,await op());const c=await op();
  const write=()=>revokeTeamAdmin(env.DB,f.company.companyId,f.team,f.company.userId,c);
  const target=fault==='audit'?"BEFORE INSERT ON product_audit WHEN NEW.kind='revoke_team_admin'":fault==='role'?'BEFORE UPDATE ON team_member':'BEFORE UPDATE ON company';
  await env.DB.prepare(`CREATE TRIGGER revoke_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
  try{
    await expect(write()).rejects.toThrow();expect(await role()).toBe('team_admin');expect(await revision()).toBe(c.expectedRevision);
    for(const table of ['team_admin_revocation','product_audit'])expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND id=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER revoke_silent_omission').run();}
  expect(await write()).toMatchObject({replayed:false});expect(await write()).toMatchObject({replayed:true});expect(await role()).toBe('staff');expect(await revision()).toBe(c.expectedRevision+1);
});
it("WP-01: grant and revoke take effect in the same existing session; staff retains only own read and memberships", async () => {
  const admin = await cookie(f.email, f.company.initialPassword);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  const member = await cookie(
    (await env.DB.prepare("SELECT email FROM user WHERE id=?")
      .bind(f.staffUser)
      .first<string>("email"))!,
    f.staff.initialPassword!,
  );
  expect((await request(path("/staff"), member)).status).toBe(403);
  expect((await request(path("/admins"), admin, await op())).status).toBe(200);
  expect((await request(path("/staff"), member)).status).toBe(200);
  expect(
    (await request(inputBase() + "/planning/2026-10", member)).status,
  ).toBe(200);
  const command = await op(),
    r = await request(path("/admins/revoke"), admin, command);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await revision()).toBe(command.expectedRevision + 1);
  for (const p of [
    path("/staff"),
    inputBase() + "/planning/2026-10",
    inputBase() + "/contract-options/2026-10",
    `/api/companies/${f.company.companyId}/compute/teams/${f.team}/jobs`,
  ])
    expect((await request(p, member)).status).toBe(403);
  expect(
    (await request(path("/staff/" + f.staff.staffId), member)).status,
  ).toBe(200);
  const context = (await (await request("/api/context", member)).json()) as {
    companies: { role: string; teams: { role: string }[] }[];
  };
  expect(context.companies[0].role).toBe("staff");
  expect(context.companies[0].teams[0].role).toBe("staff");
  expect(
    await env.DB.prepare("SELECT enabled FROM access_state WHERE user_id=?")
      .bind(f.staffUser)
      .first("enabled"),
  ).toBe(1);
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
it("WP-01/02: concurrent identical revocations commit once; replay after a later promotion never demotes again", async () => {
  await grantTeamAdmin(
    env.DB,
    f.company.companyId,
    f.team,
    f.company.userId,
    await op(),
  );
  const command = await op(),
    outcomes = await Promise.all([
      revokeTeamAdmin(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        command,
      ),
      revokeTeamAdmin(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        command,
      ),
    ]);
  expect(outcomes.map((x) => x.replayed).sort()).toEqual([false, true]);
  expect(await role()).toBe("staff");
  expect(await revision()).toBe(command.expectedRevision + 1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM product_audit WHERE company_id=? AND id=?",
    )
      .bind(f.company.companyId, command.operationId)
      .first("n"),
  ).toBe(1);
  await grantTeamAdmin(
    env.DB,
    f.company.companyId,
    f.team,
    f.company.userId,
    await op(),
  );
  const current = await revision();
  expect(
    (
      await revokeTeamAdmin(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        command,
      )
    ).replayed,
  ).toBe(true);
  expect(await role()).toBe("team_admin");
  expect(await revision()).toBe(current);
  await expect(
    revokeTeamAdmin(env.DB, f.company.companyId, f.team, f.company.userId, {
      ...command,
      expectedRevision: current,
    }),
  ).rejects.toThrow("OPERATION_ID_CONFLICT");
});
it("WP-01/02: promotion and revocation at the same revision have one winner and match the resulting role", async () => {
  await grantTeamAdmin(
    env.DB,
    f.company.companyId,
    f.team,
    f.company.userId,
    await op(),
  );
  const grant = await op(),
    revoke = await op(),
    results = await Promise.allSettled([
      grantTeamAdmin(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        grant,
      ),
      revokeTeamAdmin(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        revoke,
      ),
    ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(results.find((x) => x.status === "rejected")).toMatchObject({
    reason: { code: "VERSION_CONFLICT" },
  });
  expect(await role()).toBe(
    results[0].status === "fulfilled" ? "team_admin" : "staff",
  );
  expect(await revision()).toBe(grant.expectedRevision + 1);
});
it("WP-01/02: actor revocation and missing target during the write are rejected transactionally", async () => {
  for (const which of ["actor", "target"]) {
    const x = await inputFixture(env.DB);
    await grantTeamAdmin(
      env.DB,
      x.company.companyId,
      x.team,
      x.company.userId,
      {
        operationId: crypto.randomUUID(),
        expectedRevision: x.revision,
        userId: x.staffUser,
      },
    );
    const command = {
      operationId: crypto.randomUUID(),
      expectedRevision: x.revision + 1,
      userId: x.staffUser,
    };
    const db = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        if (which === "actor")
          await env.DB.prepare(
            "DELETE FROM company_admin WHERE company_id=? AND user_id=?",
          )
            .bind(x.company.companyId, x.company.userId)
            .run();
        else
          await env.DB.prepare(
            "DELETE FROM team_member WHERE company_id=? AND team_id=? AND user_id=?",
          )
            .bind(x.company.companyId, x.team, x.staffUser)
            .run();
        return env.DB.batch<T>(statements);
      },
    };
    await expect(
      revokeTeamAdmin(
        db,
        x.company.companyId,
        x.team,
        x.company.userId,
        command,
      ),
    ).rejects.toThrow(which === "actor" ? "FORBIDDEN" : "INVALID_REFERENCE");
    expect(
      await env.DB.prepare("SELECT revision FROM company WHERE id=?")
        .bind(x.company.companyId)
        .first("revision"),
    ).toBe(command.expectedRevision);
    expect(
      await env.DB.prepare(
        "SELECT id FROM team_admin_revocation WHERE company_id=? AND id=?",
      )
        .bind(x.company.companyId, command.operationId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM product_audit WHERE company_id=? AND id=?",
      )
        .bind(x.company.companyId, command.operationId)
        .first(),
    ).toBeNull();
  }
});
it("WP-01/02: final audit failure rolls back role, company revision and command; successful commands remain immutable", async () => {
  await grantTeamAdmin(
    env.DB,
    f.company.companyId,
    f.team,
    f.company.userId,
    await op(),
  );
  const command = await op();
  await env.DB.prepare(
    "CREATE TRIGGER revoke_audit_failure BEFORE INSERT ON product_audit WHEN NEW.kind='revoke_team_admin' BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END",
  ).run();
  try {
    await expect(
      revokeTeamAdmin(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        command,
      ),
    ).rejects.toThrow("INJECTED_FAILURE");
    expect(await revision()).toBe(command.expectedRevision);
    expect(await role()).toBe("team_admin");
    expect(
      await env.DB.prepare(
        "SELECT id FROM team_admin_revocation WHERE company_id=? AND id=?",
      )
        .bind(f.company.companyId, command.operationId)
        .first(),
    ).toBeNull();
  } finally {
    await env.DB.prepare("DROP TRIGGER revoke_audit_failure").run();
  }
  await revokeTeamAdmin(
    env.DB,
    f.company.companyId,
    f.team,
    f.company.userId,
    command,
  );
  await expect(
    env.DB.prepare(
      "UPDATE team_admin_revocation SET fingerprint=? WHERE company_id=?",
    )
      .bind("{}", f.company.companyId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_OPERATION");
  await expect(
    env.DB.prepare("DELETE FROM team_admin_revocation WHERE company_id=?")
      .bind(f.company.companyId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_OPERATION");
});
it("WP-01: revocation invalidates a manager write already past its permission read", async () => {
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await grantTeamAdmin(
    env.DB,
    f.company.companyId,
    f.team,
    f.company.userId,
    await op(),
  );
  const command = await op();
  const db = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await revokeTeamAdmin(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        command,
      );
      return env.DB.batch<T>(statements);
    },
  };
  const write = {
    operationId: crypto.randomUUID(),
    expectedRevision: command.expectedRevision,
    effectiveFrom: "2026-10",
    payload: { ...f.plan, events: [] },
  };
  await expect(
    saveInputVersion(
      db,
      {
        company: f.company.companyId,
        team: f.team,
        staff: null,
        kind: "planning",
        entity: f.team,
      },
      f.staffUser,
      write,
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(await role()).toBe("staff");
  expect(await revision()).toBe(command.expectedRevision + 1);
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
  expect(
    await env.DB.prepare(
      "SELECT id FROM input_operation WHERE company_id=? AND id=?",
    )
      .bind(f.company.companyId, write.operationId)
      .first(),
  ).toBeNull();
});
it("WP-01: foreign companies, team managers, invalid target/body/origin and stale revisions cannot revoke", async () => {
  const other = await inputFixture(env.DB),
    admin = await cookie(f.email, f.company.initialPassword);
  await grantTeamAdmin(
    env.DB,
    f.company.companyId,
    f.team,
    f.company.userId,
    await op(),
  );
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  const member = await cookie(
    (await env.DB.prepare("SELECT email FROM user WHERE id=?")
      .bind(f.staffUser)
      .first<string>("email"))!,
    f.staff.initialPassword!,
  );
  const before = await revision();
  for (const [endpoint, c, body, origin, status] of [
    [path("/admins/revoke"), member, await op(), base, 403],
    [
      `/api/companies/${other.company.companyId}/teams/${other.team}/admins/revoke`,
      admin,
      { ...(await op()), userId: other.staffUser },
      base,
      403,
    ],
    [
      path("/admins/revoke"),
      admin,
      { ...(await op()), userId: other.staffUser },
      base,
      400,
    ],
    [
      path("/admins/revoke"),
      admin,
      { ...(await op()), role: "company_admin" },
      base,
      400,
    ],
    [path("/admins/revoke"), admin, await op(), "https://foreign.invalid", 403],
    [
      path("/admins/revoke"),
      admin,
      { ...(await op()), expectedRevision: before - 1 },
      base,
      409,
    ],
  ] as const) {
    expect((await request(endpoint, c, body, origin)).status).toBe(status);
    expect(await revision()).toBe(before);
    expect(await role()).toBe("team_admin");
  }
  const oldGrant = (await env.DB.prepare(
    "SELECT id,expected_revision FROM product_operation WHERE company_id=? AND kind='grant_team_admin'",
  )
    .bind(f.company.companyId)
    .first<{ id: string; expected_revision: number }>())!;
  await expect(
    revokeTeamAdmin(env.DB, f.company.companyId, f.team, f.company.userId, {
      operationId: oldGrant.id,
      expectedRevision: oldGrant.expected_revision,
      userId: f.staffUser,
    }),
  ).rejects.toThrow("OPERATION_ID_CONFLICT");
});
