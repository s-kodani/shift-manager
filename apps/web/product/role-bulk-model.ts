import { planning } from "../../api/src/input-contracts";
import { bulkDates, emptyBulkDates, type BulkDates } from "./bulk-period-model";
import type { RoleDraft } from "./planning-model";
import type { Config } from "./setup-model";
import { formatTimeInput, parseTimeInput } from "./time-input-model";

export type RoleBulkInput = BulkDates & Omit<RoleDraft, "id" | "date"> & { existing: "keep" | "replace" };
export const emptyRoleBulk = (month: string): RoleBulkInput => ({
  ...emptyBulkDates(month), start: "", end: "", scope: "", roleId: "",
  minimum: "", numerator: "", denominator: "", existing: "keep",
});

export class RoleBulkOverlap extends Error {
  constructor(public date: string, public start: string, public end: string) { super("ROLE_BULK_OVERLAP"); }
}
const integer = (value: string) => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("INTEGER_REQUIRED");
  return Number(value);
};

/** A role requirement spans the daily interval; it is not split into demand slots. */
export function buildRoleBulk(rows: RoleDraft[], input: RoleBulkInput, config: Config, month: string) {
  const dates = bulkDates(input, month);
  const start = parseTimeInput(input.start), end = parseTimeInput(input.end);
  if (start >= end) throw new Error("EMPTY_OR_REVERSED_INTERVAL");
  if (start % 30 || end % 30) throw new Error("INVALID_ROLE_TIME");
  if (!config.rolePolicies.some(p => JSON.stringify(p.taskId) === input.scope)) throw new Error("ROLE_SCOPE_REQUIRED");
  if (!config.roles.some(r => r.id === input.roleId)) throw new Error("ROLE_REQUIRED");
  const minimum = integer(input.minimum), numerator = integer(input.numerator), denominator = integer(input.denominator);
  const checked = planning.shape.roleRequirements.element.safeParse({
    id: "preview", date: dates[0], start, end, taskId: JSON.parse(input.scope), roleId: input.roleId,
    minimum, ratioNumerator: numerator, ratioDenominator: denominator,
  });
  if (!checked.success) throw new Error("INVALID_ROLE_COUNTS");
  if (input.existing !== "keep" && input.existing !== "replace") throw new Error("INVALID_EXISTING_MODE");
  const patch = { minimum: String(minimum), numerator: String(numerator), denominator: String(denominator) };
  const targetDays = new Set(dates), existing = new Map<string, RoleDraft>();
  for (const row of rows) {
    if (!targetDays.has(row.date) || row.roleId !== input.roleId || row.scope !== input.scope) continue;
    const a = parseTimeInput(row.start), b = parseTimeInput(row.end);
    if (a >= b || a % 30 || b % 30) throw new Error("INVALID_EXISTING_ROLE_TIME");
    if (a >= end || b <= start) continue;
    if (a !== start || b !== end || existing.has(row.date)) throw new RoleBulkOverlap(row.date, row.start, row.end);
    existing.set(row.date, row);
  }
  const updatedRows = new Set(existing.values());
  const roles = rows.map(row => input.existing === "replace" && updatedRows.has(row) ? { ...row, ...patch } : row);
  for (const date of dates) if (!existing.has(date)) roles.push({
    ...patch, id: crypto.randomUUID(), date, start: formatTimeInput(start), end: formatTimeInput(end), scope: input.scope, roleId: input.roleId,
  });
  return { roles, days: dates.length, added: dates.length - existing.size,
    updated: input.existing === "replace" ? existing.size : 0, kept: input.existing === "keep" ? existing.size : 0 };
}
