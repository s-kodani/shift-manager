import type { DemandDraft } from "./planning-model";
import { planning } from "../../api/src/input-contracts";
import { coefficient, parseCoefficient, type Config } from "./setup-model";
import { formatTimeInput, parseTimeInput } from "./time-input-model";
import { bulkDates, emptyBulkDates } from "./bulk-period-model";

export type DemandBulkInput = {
  from: string;
  through: string;
  weekdays: number[];
  start: string;
  end: string;
  taskId: string;
  direct: string;
  existing: "keep" | "replace";
};
export const emptyDemandBulk = (month: string): DemandBulkInput => ({
  ...emptyBulkDates(month),
  start: "", end: "", taskId: "", direct: "", existing: "keep",
});

/** Expand only within the selected month; keep the existing monthly save/version boundary. */
export function buildDemandBulk(rows: DemandDraft[], input: DemandBulkInput, config: Config, month: string) {
  const dates = bulkDates(input, month);
  const start = parseTimeInput(input.start), end = parseTimeInput(input.end);
  if (start >= end) throw new Error("EMPTY_OR_REVERSED_INTERVAL");
  if (start % config.slotMinutes || end % config.slotMinutes)
    throw new Error("INVALID_DEMAND_SLOT");
  if (!config.tasks.some(t => t.id === input.taskId && t.kind === "general"))
    throw new Error("INVALID_DEMAND_TASK");
  if (input.direct === "") throw new Error("DEMAND_UNSET");
  const scaled = parseCoefficient(input.direct, config.capacityScale);
  if (!planning.shape.demand.element.shape.direct.safeParse(scaled).success)
    throw new Error("DEMAND_OUT_OF_RANGE");
  const direct = coefficient(scaled, config.capacityScale);
  if (input.existing !== "keep" && input.existing !== "replace") throw new Error("INVALID_EXISTING_MODE");
  const targets = new Map<string, { date: string; start: string; end: string }>();
  const key = (r: Pick<DemandDraft, "date" | "start" | "end" | "taskId">) =>
    JSON.stringify([r.date, r.start, r.taskId]);
  for (const date of dates) {
    for (let minute = start; minute < end; minute += config.slotMinutes) {
      const interval = { date, start: formatTimeInput(minute), end: formatTimeInput(minute + config.slotMinutes) };
      targets.set(key({ ...interval, taskId: input.taskId }), interval);
    }
  }
  let updated = 0, kept = 0;
  const demand = rows.map(row => {
    if (!targets.delete(key(row))) return row;
    if (input.existing === "keep") { kept++; return row; }
    updated++;
    return { ...row, direct }; // Preserve the calculated reference, identity, and all other fields.
  });
  const added = targets.size;
  for (const interval of targets.values())
    demand.push({ ...interval, key: crypto.randomUUID(), taskId: input.taskId, direct, calculated: null });
  return { demand, days: dates.length, total: dates.length * (end - start) / config.slotMinutes, added, updated, kept };
}
