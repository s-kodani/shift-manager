import { describe, expect, it } from "vitest";
import { buildDemandBulk, emptyDemandBulk } from "../../apps/web/product/demand-bulk-model";
import { buildPlanning, planningDraft } from "../../apps/web/product/planning-model";
import { teamConfig } from "../../apps/api/src/input-contracts";

const config = teamConfig.parse({
  slotMinutes: 30, priority: "coverage", capacityScale: 100,
  patterns: [{ id: "day", start: 540, end: 1080, breakKind: "auto" }],
  tasks: [{ id: "phone", kind: "general", minimumLevel: 1, minimumMinutes: 30, capacities: [{ level: 1, capacity: 100 }] }],
  roles: [{ id: "sv", allowedTasks: ["phone"] }], transitions: [], rolePolicies: [{ taskId: null, priority: "first" }],
}), month = "2026-10";
const input = { ...emptyDemandBulk(month), from: "2026-10-01", through: "2026-10-04", start: "0900", end: "1000", taskId: "phone", direct: "0" };

describe("period demand input", () => {
  it("expands inclusive dates into configured slots; weekdays and explicit zero survive monthly save", () => {
    const result = buildDemandBulk([], { ...input, weekdays: [1, 2, 3, 4, 5] }, config, month);
    expect(result).toMatchObject({ days: 2, total: 4, added: 4, updated: 0, kept: 0 });
    const plan = buildPlanning({ demand: result.demand, events: [], roles: [] }, config, month);
    expect(plan.demand).toEqual([1, 2].flatMap(day => [540, 570].map(start => ({ date: `2026-10-0${day}`, start, end: start + 30, taskId: "phone", direct: 0, calculated: null }))));
    expect(new Set(result.demand.map(r => r.key)).size).toBe(4);
  });

  it("keeps existing targets by default; replace preserves calculated zero and other tasks, dates, events and roles", () => {
    const initial = { demand: [
      { date: "2026-10-01", start: 540, end: 570, taskId: "phone", direct: null, calculated: 0 },
      { date: "2026-10-01", start: 540, end: 570, taskId: "other", direct: 500, calculated: 600 },
      { date: "2026-10-05", start: 540, end: 570, taskId: "phone", direct: 200, calculated: null },
    ], events: [{ id: "event", date: "2026-10-01", start: 607, end: 617, kind: "training" as const, staffIds: ["staff"] }],
    roleRequirements: [{ id: "role", date: "2026-10-01", start: 540, end: 570, taskId: null, roleId: "sv", minimum: 1, ratioNumerator: 0, ratioDenominator: 1 }] };
    const draft = planningDraft(initial, 100), before = structuredClone(draft);
    const kept = buildDemandBulk(draft.demand, input, config, month);
    expect(kept).toMatchObject({ total: 8, added: 7, kept: 1, updated: 0 });
    expect(kept.demand[0]).toEqual(draft.demand[0]);
    const replaced = buildDemandBulk(draft.demand, { ...input, direct: "0.29", existing: "replace" }, config, month);
    expect(replaced).toMatchObject({ total: 8, added: 7, kept: 0, updated: 1 });
    expect(replaced.demand[0]).toEqual({ ...draft.demand[0], direct: "0.29" });
    expect(replaced.demand.slice(1, 3)).toEqual(draft.demand.slice(1));
    expect(draft).toEqual(before);
    const plan = buildPlanning({ ...draft, demand: replaced.demand }, config, month);
    expect(plan.events).toEqual(initial.events);
    expect(plan.roleRequirements).toEqual(initial.roleRequirements);
    expect(plan.demand[0]).toMatchObject({ direct: 29, calculated: 0 });
    expect(buildDemandBulk(replaced.demand, input, config, month)).toMatchObject({ added: 0, kept: 8 });
  });

  it("uses 60 minute slots, exact fractions, leap dates, month end and 2400 without rollover", () => {
    const c = { ...config, slotMinutes: 60 as const, capacityScale: 3 };
    const result = buildDemandBulk([], { ...input, from: "2028-02-28", through: "2028-02-29", start: "2200", end: "2400", direct: "1/3" }, c, "2028-02");
    expect(result).toMatchObject({ days: 2, added: 4 });
    expect(result.demand.at(-1)).toMatchObject({ date: "2028-02-29", start: "2300", end: "2400", direct: "1/3" });
    expect(buildPlanning({ demand: result.demand, events: [], roles: [] }, c, "2028-02").demand.at(-1)).toMatchObject({ end: 1440, direct: 1 });
    expect(emptyDemandBulk("2028-02").through).toBe("2028-02-29");
    expect(() => buildDemandBulk([], { ...input, direct: "0.333" }, c, month)).toThrow("INVALID_PRECISION");
  });

  it.each([
    [{ from: "2026-09-30" }, "OUTSIDE_MONTH"],
    [{ through: "2026-11-01" }, "OUTSIDE_MONTH"],
    [{ through: "2026-10-32" }, "OUTSIDE_MONTH"],
    [{ from: "2026-10-04", through: "2026-10-01" }, "REVERSED_DATE_RANGE"],
    [{ weekdays: [] }, "WEEKDAYS_REQUIRED"],
    [{ through: "2026-10-01", weekdays: [0] }, "NO_MATCHING_DAYS"],
    [{ start: "0931" }, "INVALID_DEMAND_SLOT"],
    [{ end: "1001" }, "INVALID_DEMAND_SLOT"],
    [{ end: "0900" }, "EMPTY_OR_REVERSED_INTERVAL"],
    [{ end: "0000" }, "EMPTY_OR_REVERSED_INTERVAL"],
    [{ start: "930" }, "INVALID_TIME"],
    [{ taskId: "unknown" }, "INVALID_DEMAND_TASK"],
    [{ direct: "" }, "DEMAND_UNSET"],
    [{ direct: "-1" }, "INVALID_PRECISION"],
    [{ direct: "50000.01" }, "DEMAND_OUT_OF_RANGE"],
  ])("rejects invalid input %j before any rows change", (patch, error) => {
    expect(() => buildDemandBulk([], { ...input, ...patch }, config, month)).toThrow(error);
  });
});
