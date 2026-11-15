import { describe, expect, it } from "vitest";
import { teamConfig } from "../../apps/api/src/input-contracts";
import { buildRoleBulk, emptyRoleBulk, RoleBulkOverlap } from "../../apps/web/product/role-bulk-model";
import { buildPlanning, planningDraft, type RoleDraft } from "../../apps/web/product/planning-model";

const config = teamConfig.parse({
  slotMinutes: 60, priority: "coverage", capacityScale: 100,
  patterns: [{ id: "day", start: 540, end: 1080, breakKind: "auto" }],
  tasks: ["phone", "null"].map(id => ({ id, kind: "general", minimumLevel: 1, minimumMinutes: 30, capacities: [{ level: 1, capacity: 100 }] })),
  roles: ["sv", "leader"].map(id => ({ id, allowedTasks: ["phone", "null"] })), transitions: [],
  rolePolicies: [null, "phone", "null"].map(taskId => ({ taskId, priority: "first" })),
}), month = "2026-10";
const input = { ...emptyRoleBulk(month), from: "2026-10-01", through: "2026-10-04", start: "0900", end: "1700", scope: "null", roleId: "sv", minimum: "2", numerator: "1", denominator: "5" };
const row: RoleDraft = { id: "existing", date: "2026-10-01", start: "0900", end: "1700", scope: "null", roleId: "sv", minimum: "0", numerator: "0", denominator: "1" };

describe("bulk role requirements", () => {
  it("creates one interval per selected day, independent of demand slot size, preserving minimum and ratio", () => {
    const result = buildRoleBulk([], { ...input, weekdays: [1, 2, 3, 4, 5] }, config, month);
    expect(result).toMatchObject({ days: 2, added: 2, updated: 0, kept: 0 });
    expect(result.roles.map(r => ({ ...r, id: "test" }))).toEqual(["2026-10-01", "2026-10-02"].map(date => ({ ...row, id: "test", date, minimum: "2", numerator: "1", denominator: "5" })));
    expect(new Set(result.roles.map(r => r.id)).size).toBe(2);
    expect(buildPlanning({ demand: [], events: [], roles: result.roles }, config, month).roleRequirements[0]).toMatchObject({ taskId: null, start: 540, end: 1020, minimum: 2, ratioNumerator: 1, ratioDenominator: 5 });
  });

  it("keeps exact existing conditions by default and replaces only their counts while preserving identities and unrelated scopes, roles, times and dates", () => {
    const rows = [row, { ...row, id: "task", scope: JSON.stringify("phone") }, { ...row, id: "literal", scope: JSON.stringify("null") },
      { ...row, id: "leader", roleId: "leader" }, { ...row, id: "outside", date: "2026-10-05" }, { ...row, id: "adjacent", start: "1700", end: "1800" }];
    const before = structuredClone(rows);
    const kept = buildRoleBulk(rows, input, config, month);
    expect(kept).toMatchObject({ added: 3, updated: 0, kept: 1 });
    expect(kept.roles.slice(0, rows.length)).toEqual(rows);
    const updated = buildRoleBulk(rows, { ...input, existing: "replace" }, config, month);
    expect(updated).toMatchObject({ added: 3, updated: 1, kept: 0 });
    expect(updated.roles[0]).toEqual({ ...row, minimum: "2", numerator: "1", denominator: "5" });
    expect(updated.roles.slice(1, rows.length)).toEqual(rows.slice(1));
    expect(rows).toEqual(before);
    expect(buildRoleBulk(updated.roles, input, config, month)).toMatchObject({ added: 0, kept: 4 });
  });

  it.each([ ["0800", "1000"], ["1000", "1800"], ["0800", "1800"], ["1000", "1600"], ["0900", "1000"] ])("rejects partial overlaps %s-%s atomically in either mode with the conflicting date", (start, end) => {
    const rows = [{ ...row, date: "2026-10-02", start, end }], before = structuredClone(rows);
    for (const existing of ["keep", "replace"] as const) {
      expect(() => buildRoleBulk(rows, { ...input, existing }, config, month)).toThrow(RoleBulkOverlap);
      try { buildRoleBulk(rows, { ...input, existing }, config, month); } catch (e) { expect(e).toMatchObject({ date: "2026-10-02", start, end }); }
    }
    expect(rows).toEqual(before);
  });

  it("rejects duplicate exact conditions rather than manufacturing ambiguous replacements", () => {
    expect(() => buildRoleBulk([row, { ...row, id: "duplicate" }], input, config, month)).toThrow(RoleBulkOverlap);
  });

  it("supports 30-minute boundaries in a 60-minute team, leap days and 2400, with explicit zero counts", () => {
    const result = buildRoleBulk([], { ...input, from: "2028-02-28", through: "2028-02-29", start: "2330", end: "2400", minimum: "0", numerator: "0", denominator: "1" }, config, "2028-02");
    expect(result).toMatchObject({ days: 2, added: 2 });
    expect(buildPlanning({ demand: [], events: [], roles: result.roles }, config, "2028-02").roleRequirements.at(-1)).toMatchObject({ date: "2028-02-29", start: 1410, end: 1440, minimum: 0, ratioNumerator: 0, ratioDenominator: 1 });
  });

  it("preserves demand, calculated0 and minute-precision events through a monthly save with 31 role intervals", () => {
    const initial = { demand: [{ date: "2026-10-01", start: 540, end: 600, taskId: "phone", direct: null, calculated: 0 }],
      events: [{ id: "event", date: "2026-10-01", start: 607, end: 617, kind: "training" as const, staffIds: ["staff"] }], roleRequirements: [] };
    const draft = planningDraft(initial, 100);
    const result = buildRoleBulk(draft.roles, { ...input, through: "2026-10-31" }, config, month);
    const plan = buildPlanning({ ...draft, roles: result.roles }, config, month);
    expect(plan.roleRequirements).toHaveLength(31);
    expect(plan.demand).toEqual(initial.demand); expect(plan.events).toEqual(initial.events);
  });

  it.each([
    [{ from: "2026-09-30" }, "OUTSIDE_MONTH"], [{ through: "2026-10-32" }, "OUTSIDE_MONTH"],
    [{ from: "2026-10-04", through: "2026-10-01" }, "REVERSED_DATE_RANGE"],
    [{ weekdays: [] }, "WEEKDAYS_REQUIRED"], [{ weekdays: [7] }, "WEEKDAYS_REQUIRED"],
    [{ through: "2026-10-01", weekdays: [0] }, "NO_MATCHING_DAYS"],
    [{ start: "0931" }, "INVALID_ROLE_TIME"], [{ end: "1701" }, "INVALID_ROLE_TIME"],
    [{ start: "930" }, "INVALID_TIME"], [{ end: "0900" }, "EMPTY_OR_REVERSED_INTERVAL"],
    [{ scope: "" }, "ROLE_SCOPE_REQUIRED"], [{ scope: JSON.stringify("unknown") }, "ROLE_SCOPE_REQUIRED"],
    [{ roleId: "unknown" }, "ROLE_REQUIRED"], [{ minimum: "" }, "INTEGER_REQUIRED"],
    [{ minimum: "-1" }, "INTEGER_REQUIRED"], [{ minimum: "0.5" }, "INTEGER_REQUIRED"],
    [{ minimum: "501" }, "INVALID_ROLE_COUNTS"], [{ numerator: "10001" }, "INVALID_ROLE_COUNTS"],
    [{ denominator: "0" }, "INVALID_ROLE_COUNTS"], [{ denominator: "10001" }, "INVALID_ROLE_COUNTS"],
  ])("rejects invalid conditions %j before producing a draft", (patch, error) => {
    expect(() => buildRoleBulk([row], { ...input, ...patch }, config, month)).toThrow(error);
  });
});
