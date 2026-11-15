import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/index";
import { inputFixture, probeConfig } from "../../apps/api/src/input-probes";
import { planning, teamConfig } from "../../apps/api/src/input-contracts";
import { buildDemandBulk, emptyDemandBulk } from "../../apps/web/product/demand-bulk-model";
import { buildRoleBulk, emptyRoleBulk } from "../../apps/web/product/role-bulk-model";
import { buildPlanning, planningDraft } from "../../apps/web/product/planning-model";
import {
  createInputSnapshot,
  readInputSnapshot,
} from "../../apps/api/src/input-snapshots";
import { resolveVersion } from "../../apps/api/src/input-versions";
import { contractOptions } from "../../apps/api/src/input-catalogs";
import {
  grantTeamAdmin,
  saveCalendarSettings,
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
const op = async () => ({
  operationId: crypto.randomUUID(),
  expectedRevision: await revision(),
});
async function request(body: object) {
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
    base +
      `/api/companies/${f.company.companyId}/inputs/teams/${f.team}/planning`,
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
}
it("period bulk demand: 496 slots save in one revision, preserve existing conditions, replay once and reject stale or invalid saves atomically", async () => {
  const config = teamConfig.parse(probeConfig);
  const draft = planningDraft(planning.parse(f.plan), config.capacityScale);
  const bulk = buildDemandBulk(draft.demand, {
    ...emptyDemandBulk("2026-10"), start: "0900", end: "1700", taskId: "phone", direct: "3",
  }, config, "2026-10");
  expect(bulk).toMatchObject({ total: 496, added: 494, kept: 2 });
  const payload = buildPlanning({ ...draft, demand: bulk.demand }, config, "2026-10");
  const command = { ...(await op()), effectiveFrom: "2026-10", payload };
  expect((await request(command)).status).toBe(200);
  expect((await request(command)).status).toBe(200);
  expect(await revision()).toBe(command.expectedRevision + 1);
  const read = async () => JSON.parse((await resolveVersion(env.DB, f.company.companyId, "planning", f.team, "2026-10"))!.payload);
  expect(await read()).toEqual(payload);
  expect(payload.demand.slice(0, 2)).toEqual(f.plan.demand);
  expect(payload.events).toEqual(f.plan.events);
  expect(payload.roleRequirements).toEqual(f.plan.roleRequirements);
  const stale = await request({ ...command, operationId: crypto.randomUUID() });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "VERSION_CONFLICT" });
  const invalid = { ...(await op()), effectiveFrom: "2026-10", payload: {
    ...payload, demand: payload.demand.map((row, index) => index === 495 ? { ...row, end: row.end - 1 } : row),
  } };
  expect((await request(invalid)).status).toBe(400);
  expect(await revision()).toBe(command.expectedRevision + 1);
  expect(await read()).toEqual(payload);
  expect(await env.DB.prepare("SELECT id FROM input_operation WHERE company_id=? AND id=?").bind(f.company.companyId, invalid.operationId).first()).toBeNull();
});
it("period bulk roles/Q61-63: 31 intervals save once with demand/events intact; stale and overlapping saves preserve the entire version", async () => {
  const config = teamConfig.parse(probeConfig), draft = planningDraft(planning.parse(f.plan), 100);
  const bulk = buildRoleBulk(draft.roles, { ...emptyRoleBulk("2026-10"), start: "1000", end: "1030", scope: JSON.stringify("phone"), roleId: "sv", minimum: "2", numerator: "1", denominator: "5", existing: "replace" }, config, "2026-10");
  expect(bulk).toMatchObject({ days: 31, added: 30, updated: 1, kept: 0 });
  const payload = buildPlanning({ ...draft, roles: bulk.roles }, config, "2026-10");
  const command = { ...(await op()), effectiveFrom: "2026-10", payload };
  expect((await request(command)).status).toBe(200);
  expect((await request(command)).status).toBe(200);
  expect(await revision()).toBe(command.expectedRevision + 1);
  const read = async () => JSON.parse((await resolveVersion(env.DB, f.company.companyId, "planning", f.team, "2026-10"))!.payload);
  expect(await read()).toEqual(payload);
  expect(payload.demand).toEqual(f.plan.demand); expect(payload.events).toEqual(f.plan.events);
  expect(payload.roleRequirements[0]).toEqual({ ...f.plan.roleRequirements[0], minimum: 2 });
  const stale = await request({ ...command, operationId: crypto.randomUUID() });
  expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: "VERSION_CONFLICT" });
  const invalid = { ...(await op()), effectiveFrom: "2026-10", payload: { ...payload, roleRequirements: [...payload.roleRequirements, { ...payload.roleRequirements[1], id: "overlap", end: 660 }] } };
  const rejected = await request(invalid);
  expect(rejected.status).toBe(400); expect(await rejected.json()).toEqual({ error: "OVERLAPPING_ROLE_REQUIREMENT" });
  expect(await revision()).toBe(command.expectedRevision + 1); expect(await read()).toEqual(payload);
  expect(await env.DB.prepare("SELECT id FROM input_operation WHERE company_id=? AND id=?").bind(f.company.companyId, invalid.operationId).first()).toBeNull();
});
it("monthly planning/Q76/99: own team managers read effective company rounding without obtaining mutation permission", async () => {
  const settings = {
    weekStart: 0,
    deadlineDay: 20,
    halfDayDivider: 720,
    roleRounding: "floor" as const,
  };
  await saveCalendarSettings(env.DB, f.company.companyId, f.company.userId, {
    ...(await op()),
    effectiveFrom: "2026-12",
    settings,
  });
  await saveCalendarSettings(env.DB, f.company.companyId, f.company.userId, {
    ...(await op()),
    effectiveFrom: "2026-10",
    settings: { ...settings, roleRounding: "ceil" },
  });
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await grantTeamAdmin(env.DB, f.company.companyId, f.team, f.company.userId, {
    ...(await op()),
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
    ).roleRounding,
  ).toBe("ceil");
  expect(
    (
      await contractOptions(
        env.DB,
        f.company.companyId,
        f.team,
        f.staffUser,
        "2026-12",
      )
    ).roleRounding,
  ).toBe("floor");
  await expect(
    saveCalendarSettings(env.DB, f.company.companyId, f.staffUser, {
      ...(await op()),
      effectiveFrom: "2026-10",
      settings,
    }),
  ).rejects.toThrow("FORBIDDEN");
});
it("monthly planning/Q83/110/122: combined HTTP save freezes exact events, demand zero and shared role policies together; one edit preserves the rest", async () => {
  const plan = {
    ...f.plan,
    events: [
      ...f.plan.events,
      {
        id: "meeting",
        date: "2026-10-01",
        start: 690,
        end: 697,
        kind: "meeting",
        staffIds: [f.staff.staffId],
      },
    ],
    roleRequirements: [
      ...f.plan.roleRequirements,
      {
        ...f.plan.roleRequirements[0],
        id: "team-role",
        taskId: null,
        minimum: 0,
        ratioNumerator: 0,
        ratioDenominator: 1,
      },
    ],
  };
  const command = { ...(await op()), effectiveFrom: "2026-10", payload: plan };
  expect((await request(command)).status).toBe(200);
  expect((await request(command)).status).toBe(200);
  expect(await revision()).toBe(command.expectedRevision + 1);
  const saved = await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    { ...(await op()), month: "2026-10" },
  );
  const frozen = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    saved.snapshot!.id,
  );
  expect(frozen.input.events).toEqual(plan.events);
  expect(frozen.input.demand).toEqual(plan.demand);
  expect(
    frozen.input.roleRequirements.map((r) => [
      r.taskId,
      r.rounding,
      r.priority,
    ]),
  ).toEqual([
    ["phone", "floor", "same"],
    [null, "floor", "first"],
  ]);
  expect(
    (
      await request({
        ...(await op()),
        effectiveFrom: "2026-10",
        payload: {
          ...plan,
          events: plan.events.filter((e) => e.id !== "meeting"),
        },
      })
    ).status,
  ).toBe(200);
  const current = JSON.parse(
    (await resolveVersion(
      env.DB,
      f.company.companyId,
      "planning",
      f.team,
      "2026-10",
    ))!.payload,
  );
  expect(current.demand).toEqual(plan.demand);
  expect(current.roleRequirements).toEqual(plan.roleRequirements);
  expect(current.events).toEqual(f.plan.events);
  expect(
    await resolveVersion(
      env.DB,
      f.company.companyId,
      "planning",
      f.team,
      "2026-11",
    ),
  ).toBeNull();
});
it("monthly planning: conflicting attendance, overlapping rules and foreign participants reject the entire save and keep revision/operation/audit unchanged", async () => {
  const other = await inputFixture(env.DB),
    before = await revision();
  const cases = [
    [
      { ...f.plan, events: [{ ...f.plan.events[0], start: 810, end: 840 }] },
      "EVENT_ATTENDANCE_CONFLICT",
    ],
    [
      {
        ...f.plan,
        events: [...f.plan.events, { ...f.plan.events[0], id: "overlap" }],
      },
      "OVERLAPPING_EVENT",
    ],
    [
      {
        ...f.plan,
        roleRequirements: [
          ...f.plan.roleRequirements,
          { ...f.plan.roleRequirements[0], id: "overlap" },
        ],
      },
      "OVERLAPPING_ROLE_REQUIREMENT",
    ],
    [
      {
        ...f.plan,
        events: [{ ...f.plan.events[0], staffIds: [other.staff.staffId] }],
      },
      "UNKNOWN_STAFF",
    ],
    [
      {
        ...f.plan,
        roleRequirements: [{ ...f.plan.roleRequirements[0], rounding: "ceil" }],
      },
      "INVALID_INPUT",
    ],
  ] as const;
  for (const [payload, error] of cases) {
    const command = { ...(await op()), effectiveFrom: "2026-10", payload };
    const response = await request(command);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(await revision()).toBe(before);
    expect(
      await env.DB.prepare(
        "SELECT id FROM input_operation WHERE company_id=? AND id=?",
      )
        .bind(f.company.companyId, command.operationId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM product_audit WHERE company_id=? AND id=?",
      )
        .bind(f.company.companyId, command.operationId)
        .first(),
    ).toBeNull();
  }
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
