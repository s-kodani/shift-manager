import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/index";
import { contractOptions } from "../../apps/api/src/input-catalogs";
import {
  inputFixture,
  probeConfig,
  probePolicy,
} from "../../apps/api/src/input-probes";
import {
  commitInput,
  resolveVersion,
  saveInputVersion,
  type ResourceTarget,
} from "../../apps/api/src/input-versions";
import {
  compileInput,
  createInputSnapshot,
  loadSources,
  readInputSnapshot,
  sha256,
} from "../../apps/api/src/input-snapshots";
import { createJob } from "../../apps/api/src/compute-jobs";
import {
  createStaff,
  createTeam,
  grantTeamAdmin,
} from "../../apps/api/src/product";

let f: Awaited<ReturnType<typeof inputFixture>>;
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
const operation = async () => ({
  operationId: crypto.randomUUID(),
  expectedRevision: await revision(),
});
const companyTarget = (): ResourceTarget => ({
  company: f.company.companyId,
  team: null,
  staff: null,
  kind: "company_policy",
  entity: f.company.companyId,
});
const teamTarget = (team = f.team): ResourceTarget => ({
  company: f.company.companyId,
  team,
  staff: null,
  kind: "team_config",
  entity: team,
});
async function save(
  t: ResourceTarget,
  payload: unknown,
  effectiveFrom = "2026-10",
  user = f.company.userId,
) {
  return saveInputVersion(env.DB, t, user, {
    ...(await operation()),
    effectiveFrom,
    payload,
  });
}
async function freeze(team = f.team, month = "2026-10") {
  const s = await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    team,
    f.company.userId,
    { ...(await operation()), month },
  );
  return readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    team,
    f.company.userId,
    s.snapshot!.id,
    true,
  );
}
// Emulate an immutable pre-upgrade row through the same D1 transaction guards.
// The product write API never accepts these old payloads.
async function legacy(t: ResourceTarget, payload: unknown) {
  const o = await operation(),
    raw = JSON.stringify(payload);
  await commitInput(
    env.DB,
    t,
    f.company.userId,
    o.operationId,
    o.expectedRevision,
    "legacy-test:" + o.operationId,
    [
      env.DB.prepare(
        "INSERT INTO work_input_version(company_id,operation_id,team_id,staff_id,kind,entity_id,effective_from,revision,payload) VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind(
        t.company,
        o.operationId,
        t.team,
        t.staff,
        t.kind,
        t.entity,
        "2026-10",
        o.expectedRevision + 1,
        raw,
      ),
    ],
  );
  return { id: o.operationId, raw };
}
async function http(path: string, body?: object) {
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
  return app.request(
    base + path,
    {
      method: body ? "POST" : "GET",
      headers: {
        origin: base,
        cookie: login.headers.get("set-cookie")!.split(";")[0],
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}

it("Q70: two teams use the company rule, ignoring differing legacy team rules without rewriting their versions", async () => {
  const old = await legacy(teamTarget(), {
    ...probeConfig,
    breakRule: {
      ...probePolicy.breakRule,
      basis: "worked",
      requiredMinutes: 30,
    },
  });
  const team = (
    await createTeam(env.DB, f.company.companyId, f.company.userId, {
      ...(await operation()),
      name: "架空第二チーム",
    })
  ).teamId;
  const staff = await createStaff(
    env.DB,
    f.company.companyId,
    team,
    f.company.userId,
    {
      ...(await operation()),
      name: "架空第二担当者",
      staffNumber: "0002",
      email: crypto.randomUUID() + "@example.invalid",
    },
  );
  await legacy(teamTarget(team), {
    ...probeConfig,
    breakRule: { ...probePolicy.breakRule, threshold: 240 },
  });
  await save(
    {
      ...teamTarget(team),
      staff: staff.staffId,
      kind: "staff_contract",
      entity: staff.staffId,
    },
    f.profile,
  );
  await save(
    { ...teamTarget(team), kind: "planning" },
    { demand: [], events: [], roleRequirements: [] },
  );
  const a = await freeze(),
    b = await freeze(team);
  expect(a.input.breakRule).toEqual(probePolicy.breakRule);
  expect(b.input.breakRule).toEqual(a.input.breakRule);
  expect(a.input.patterns[0].breakKind).toBe("fixed");
  const lineage = JSON.parse(a.snapshot.lineage);
  const policy = lineage.find(
    (v: { kind: string }) => v.kind === "company_policy",
  );
  expect(lineage).toContainEqual({ ...policy, kind: "company_break_rule" });
  expect(
    (await resolveVersion(
      env.DB,
      f.company.companyId,
      "team_config",
      f.team,
      "2026-10",
    ))!.payload,
  ).toBe(old.raw);
  const r = await http(
    `/api/companies/${f.company.companyId}/inputs/teams/${f.team}/config/2026-10`,
  );
  expect(r.status).toBe(200);
  expect(
    ((await r.json()) as { version: { payload: object } }).version.payload,
  ).not.toHaveProperty("breakRule");
});
it("Q70/Q118: effective-month company edits preserve historical bytes, invalidate old current input and retain earlier-month rules", async () => {
  const first = await freeze();
  const next = {
    ...probePolicy,
    breakRule: {
      basis: "worked",
      threshold: 390,
      requiredMinutes: 30,
      afterStart: 7,
      beforeEnd: 11,
    },
  };
  await save(companyTarget(), next, "2026-12");
  await save(
    { ...teamTarget(), kind: "planning" },
    { demand: [], events: [], roleRequirements: [] },
    "2026-12",
  );
  expect((await freeze()).input.breakRule).toEqual(probePolicy.breakRule);
  expect((await freeze(f.team, "2026-12")).input.breakRule).toEqual(
    next.breakRule,
  );
  const old = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    first.snapshot.id,
  );
  expect(old.stale).toBe(true);
  expect(old.input.breakRule).toEqual(probePolicy.breakRule);
  expect(old.snapshot.sha256).toBe(first.snapshot.sha256);
  await expect(
    readInputSnapshot(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      first.snapshot.id,
      true,
    ),
  ).rejects.toThrow("VERSION_CONFLICT");
});
it("Q70: missing company rule is readable for setup but blocks freezing; a legacy team rule is never a fallback", async () => {
  const { breakRule: _, ...oldPolicy } = probePolicy;
  await legacy(companyTarget(), oldPolicy);
  const old = await legacy(teamTarget(), {
    ...probeConfig,
    breakRule: probePolicy.breakRule,
  });
  const r = await http(
    `/api/companies/${f.company.companyId}/inputs/company-policy/2026-10`,
  );
  expect(r.status).toBe(200);
  expect(
    ((await r.json()) as { version: { payload: object } }).version.payload,
  ).not.toHaveProperty("breakRule");
  expect(
    (
      await contractOptions(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        "2026-10",
      )
    ).policy,
  ).toEqual(oldPolicy);
  await expect(freeze()).rejects.toThrow("COMPANY_BREAK_RULE_NOT_CONFIGURED");
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM input_snapshot WHERE company_id=?",
    )
      .bind(f.company.companyId)
      .first("n"),
  ).toBe(0);
  await save(companyTarget(), probePolicy);
  expect((await freeze()).input.breakRule).toEqual(probePolicy.breakRule);
  expect(
    (await resolveVersion(
      env.DB,
      f.company.companyId,
      "team_config",
      f.team,
      "2026-10",
    ))!.payload,
  ).toBe(old.raw);
});
it("Q70: HTTP refuses absent company rules and team overrides without revision, operation or audit writes", async () => {
  const { breakRule: _, ...missing } = probePolicy,
    rev = await revision();
  for (const [path, payload] of [
    [`company-policy`, missing],
    [
      `teams/${f.team}/config`,
      { ...probeConfig, breakRule: probePolicy.breakRule },
    ],
  ] as const) {
    const o = await operation();
    const response = await http(
      `/api/companies/${f.company.companyId}/inputs/${path}`,
      { ...o, effectiveFrom: "2026-10", payload },
    );
    expect(response.status).toBe(400);
    expect(await revision()).toBe(rev);
    for (const table of ["input_operation", "product_audit"])
      expect(
        await env.DB.prepare(
          `SELECT id FROM ${table} WHERE company_id=? AND id=?`,
        )
          .bind(f.company.companyId, o.operationId)
          .first(),
      ).toBeNull();
  }
});
it("Q70/Q99: team managers can read shared rules but cannot change them; revoked company permission is rejected atomically", async () => {
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await grantTeamAdmin(env.DB, f.company.companyId, f.team, f.company.userId, {
    ...(await operation()),
    userId: f.staffUser,
  });
  expect(
    (
      await contractOptions(
        env.DB,
        f.company.companyId,
        f.team,
        f.staffUser,
        "2026-10",
      )
    ).policy?.breakRule,
  ).toEqual(probePolicy.breakRule);
  const rev = await revision();
  await expect(
    save(companyTarget(), probePolicy, "2026-10", f.staffUser),
  ).rejects.toThrow("FORBIDDEN");
  const o = await operation(),
    db = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        await env.DB.prepare(
          "DELETE FROM company_admin WHERE company_id=? AND user_id=?",
        )
          .bind(f.company.companyId, f.company.userId)
          .run();
        return env.DB.batch<T>(statements);
      },
    };
  await expect(
    saveInputVersion(db, companyTarget(), f.company.userId, {
      ...o,
      effectiveFrom: "2026-10",
      payload: {
        ...probePolicy,
        breakRule: { ...probePolicy.breakRule, basis: "worked" },
      },
    }),
  ).rejects.toThrow("FORBIDDEN");
  expect(await revision()).toBe(rev);
  expect(
    await env.DB.prepare(
      "SELECT id FROM input_operation WHERE company_id=? AND id=?",
    )
      .bind(f.company.companyId, o.operationId)
      .first(),
  ).toBeNull();
});
it("Q70: an untagged legacy frozen input remains verifiable history but cannot start a job even at the current revision", async () => {
  const o = await operation(),
    compiled = compileInput(
      f.company.companyId,
      f.team,
      "2026-10",
      o.operationId,
      await loadSources(env.DB, f.company.companyId, f.team, "2026-10"),
    );
  const bytes = new TextEncoder().encode(JSON.stringify(compiled.input)),
    digest = await sha256(bytes),
    key = `legacy-test/${o.operationId}.json`;
  await env.INPUTS.put(key, bytes);
  const lineage = compiled.lineage.filter(
    (v) => v.kind !== "company_break_rule",
  );
  await commitInput(
    env.DB,
    { ...teamTarget(), kind: "snapshot", entity: o.operationId },
    f.company.userId,
    o.operationId,
    o.expectedRevision,
    "legacy-snapshot:" + o.operationId,
    [
      env.DB.prepare(
        "INSERT INTO input_snapshot(company_id,id,team_id,month,input_revision,object_key,sha256,byte_length,lineage,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        f.company.companyId,
        o.operationId,
        f.team,
        "2026-10",
        o.expectedRevision,
        key,
        digest,
        bytes.length,
        JSON.stringify(lineage),
        Date.now(),
      ),
    ],
  );
  const historical = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    o.operationId,
  );
  expect(historical.stale).toBe(true);
  expect(historical.input).toEqual(compiled.input);
  expect(historical.snapshot.sha256).toBe(digest);
  await expect(
    createJob(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      { ...(await operation()), snapshotId: o.operationId },
    ),
  ).rejects.toThrow("SNAPSHOT_REBUILD_REQUIRED");
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM compute_job WHERE company_id=?",
    )
      .bind(f.company.companyId)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM compute_outbox WHERE company_id=?",
    )
      .bind(f.company.companyId)
      .first("n"),
  ).toBe(0);
});
