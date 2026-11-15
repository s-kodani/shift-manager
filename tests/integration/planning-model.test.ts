import { expect, it } from "vitest";
import { planning, teamConfig } from "../../apps/api/src/input-contracts";
import { probeConfig } from "../../apps/api/src/input-probes";
import {
  buildPlanning,
  planningDraft,
  emptyEvent,
  emptyRole,
  minute,
} from "../../apps/web/product/planning-model";
const config = teamConfig.parse(probeConfig),
  month = "2026-10";
const plan = planning.parse({
  demand: [
    {
      date: month + "-01",
      start: 600,
      end: 630,
      taskId: "phone",
      direct: 0,
      calculated: 0,
    },
    {
      date: month + "-01",
      start: 630,
      end: 660,
      taskId: "phone",
      direct: null,
      calculated: 29,
    },
  ],
  events: [
    {
      id: "event",
      date: month + "-01",
      start: 667,
      end: 677,
      kind: "training",
      staffIds: ["one", "two"],
    },
  ],
  roleRequirements: [
    {
      id: "role",
      date: month + "-01",
      start: 600,
      end: 630,
      taskId: null,
      roleId: "sv",
      minimum: 0,
      ratioNumerator: 0,
      ratioDenominator: 1,
    },
  ],
});
it("monthly planning: loaded input preserves calculated zero, unset/zero direct demand, exact event minutes and role identities", () => {
  const d = planningDraft(plan, 100);
  expect(d.demand.map((r) => r.direct)).toEqual(["0", ""]);
  expect(d.events[0].start).toBe("1107");
  expect(buildPlanning(d, config, month)).toEqual(plan);
  d.events[0].staffIds.pop();
  expect(plan.events[0].staffIds).toEqual(["one", "two"]);
});
it("monthly planning: editing or deleting one section never drops the other two sections or their calculated values", () => {
  const d = planningDraft(plan, 100);
  d.demand[0].direct = "0.29";
  d.events[0].kind = "meeting";
  const changed = buildPlanning(d, config, month);
  expect(changed.demand[0]).toMatchObject({ direct: 29, calculated: 0 });
  expect(changed.events[0]).toMatchObject({
    id: "event",
    kind: "meeting",
    start: 667,
    end: 677,
  });
  expect(changed.roleRequirements).toEqual(plan.roleRequirements);
  d.roles = [];
  expect(buildPlanning(d, config, month)).toEqual({
    ...changed,
    roleRequirements: [],
  });
});
it("monthly planning: exact nondecimal demand precision survives editing and cannot be replaced with an approximation", () => {
  const p = {
      ...plan,
      demand: [{ ...plan.demand[0], direct: 1, calculated: null }],
    },
    c = { ...config, capacityScale: 3 },
    d = planningDraft(p, 3);
  expect(d.demand[0].direct).toBe("1/3");
  expect(buildPlanning(d, c, month).demand[0].direct).toBe(1);
  d.demand[0].direct = "0.333";
  expect(() => buildPlanning(d, c, month)).toThrow("INVALID_PRECISION");
  d.demand[0].direct = "";
  expect(() => buildPlanning(d, c, month)).toThrow("DEMAND_UNSET");
  d.demand[0].direct = "0";
  expect(buildPlanning(d, c, month).demand[0].direct).toBe(0);
});
it("monthly planning: new events and role rules have no manufactured participants, kind, minimum or ratio values", () => {
  const event = emptyEvent(month),
    role = emptyRole(month);
  expect(event).toMatchObject({ kind: "", staffIds: [], start: "", end: "" });
  expect(role).toMatchObject({
    scope: "",
    minimum: "",
    numerator: "",
    denominator: "",
  });
  expect(() =>
    buildPlanning(
      { ...planningDraft(plan, 100), events: [event] },
      config,
      month,
    ),
  ).toThrow("EVENT_PARTICIPANTS_REQUIRED");
  const d = planningDraft(plan, 100);
  d.roles[0].minimum = "";
  expect(() => buildPlanning(d, config, month)).toThrow("INTEGER_REQUIRED");
  d.roles[0].minimum = "0";
  d.roles[0].denominator = "0";
  expect(() => buildPlanning(d, config, month)).toThrow();
});
it("monthly planning: 24:00 is the same day end; invalid, reversed and out-of-month dates are rejected without rounding", () => {
  expect(minute("2400")).toBe(1440);
  for (const value of ["2401", "930", "1060", "", "10:30:01"])
    expect(() => minute(value)).toThrow("INVALID_TIME");
  const d = planningDraft(plan, 100);
  d.events[0].start = "2357";
  d.events[0].end = "2400";
  expect(buildPlanning(d, config, month).events[0]).toMatchObject({
    start: 1437,
    end: 1440,
  });
  d.events[0].end = "0000";
  expect(() => buildPlanning(d, config, month)).toThrow(
    "EMPTY_OR_REVERSED_INTERVAL",
  );
  d.events[0].end = "2400";
  d.events[0].date = "2026-11-01";
  expect(() => buildPlanning(d, config, month)).toThrow("OUTSIDE_MONTH");
});
it("monthly planning: demand uses the configured slot and role times stay aligned; events keep minute precision", () => {
  const d = planningDraft(plan, 100);
  d.roles[0].start = "1007";
  expect(() => buildPlanning(d, config, month)).toThrow();
  d.roles[0].start = "1000";
  d.demand[0].end = "1100";
  expect(() => buildPlanning(d, config, month)).toThrow("INVALID_DEMAND_SLOT");
  d.demand[0].end = "1030";
  expect(buildPlanning(d, config, month).events[0].start).toBe(667);
});
it("monthly planning: the literal task name null stays distinct from team-wide scope", () => {
  const d = planningDraft(plan, 100);
  d.roles.push({ ...d.roles[0], id: "literal", scope: JSON.stringify("null") });
  expect(
    buildPlanning(d, config, month).roleRequirements.map((r) => r.taskId),
  ).toEqual([null, "null"]);
});
