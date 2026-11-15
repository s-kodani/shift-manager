import { z } from "zod";
import { planning } from "../../api/src/input-contracts";
import { coefficient, parseCoefficient, type Config } from "./setup-model";
import { formatTimeInput } from "./time-input-model";
export { parseTimeInput as minute } from "./time-input-model";
import { parseTimeInput as minute } from "./time-input-model";

export type Plan = z.infer<typeof planning>;
export type DemandDraft = {
  key: string;
  date: string;
  start: string;
  end: string;
  taskId: string;
  direct: string;
  calculated: number | null;
};
export type EventDraft = {
  id: string;
  date: string;
  start: string;
  end: string;
  kind: string;
  staffIds: string[];
};
export type RoleDraft = {
  id: string;
  date: string;
  start: string;
  end: string;
  scope: string;
  roleId: string;
  minimum: string;
  numerator: string;
  denominator: string;
};
export type PlanningDraft = {
  demand: DemandDraft[];
  events: EventDraft[];
  roles: RoleDraft[];
};
export const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const integer = (value: string) => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("INTEGER_REQUIRED");
  return Number(value);
};
export const emptyDemand = (month: string): DemandDraft => ({
  key: crypto.randomUUID(),
  date: month + "-01",
  start: "",
  end: "",
  taskId: "",
  direct: "",
  calculated: null,
});
export const emptyEvent = (month: string): EventDraft => ({
  id: crypto.randomUUID(),
  date: month + "-01",
  start: "",
  end: "",
  kind: "",
  staffIds: [],
});
export const emptyRole = (month: string): RoleDraft => ({
  id: crypto.randomUUID(),
  date: month + "-01",
  start: "",
  end: "",
  scope: "",
  roleId: "",
  minimum: "",
  numerator: "",
  denominator: "",
});
export function planningDraft(plan: Plan | null, scale: number): PlanningDraft {
  return {
    demand: (plan?.demand ?? []).map((d) => ({
      ...d,
      key: crypto.randomUUID(),
      start: formatTimeInput(d.start),
      end: formatTimeInput(d.end),
      direct: d.direct === null ? "" : coefficient(d.direct, scale),
    })),
    events: (plan?.events ?? []).map((e) => ({
      ...e,
      start: formatTimeInput(e.start),
      end: formatTimeInput(e.end),
      staffIds: [...e.staffIds],
    })),
    roles: (plan?.roleRequirements ?? []).map((r) => ({
      id: r.id,
      date: r.date,
      start: formatTimeInput(r.start),
      end: formatTimeInput(r.end),
      scope: JSON.stringify(r.taskId),
      roleId: r.roleId,
      minimum: String(r.minimum),
      numerator: String(r.ratioNumerator),
      denominator: String(r.ratioDenominator),
    })),
  };
}
export function buildPlanning(
  d: PlanningDraft,
  config: Config,
  month: string,
): Plan {
  const range = (date: string, start: string, end: string) => {
    if (date.slice(0, 7) !== month) throw new Error("OUTSIDE_MONTH");
    const a = minute(start),
      b = minute(end);
    if (a >= b) throw new Error("EMPTY_OR_REVERSED_INTERVAL");
    return { date, start: a, end: b };
  };
  return planning.parse({
    demand: d.demand.map((r) => {
      const interval = range(r.date, r.start, r.end);
      if (
        interval.end - interval.start !== config.slotMinutes ||
        interval.start % config.slotMinutes
      )
        throw new Error("INVALID_DEMAND_SLOT");
      const direct =
        r.direct === ""
          ? null
          : parseCoefficient(r.direct, config.capacityScale);
      if (direct === null && r.calculated === null)
        throw new Error("DEMAND_UNSET");
      return {
        ...interval,
        taskId: r.taskId,
        direct,
        calculated: r.calculated,
      };
    }),
    events: d.events.map((e) => {
      if (!e.staffIds.length) throw new Error("EVENT_PARTICIPANTS_REQUIRED");
      return {
        id: e.id,
        ...range(e.date, e.start, e.end),
        kind: e.kind,
        staffIds: [...e.staffIds],
      };
    }),
    roleRequirements: d.roles.map((r) => {
      if (r.scope === "") throw new Error("ROLE_SCOPE_REQUIRED");
      return {
        id: r.id,
        ...range(r.date, r.start, r.end),
        taskId: JSON.parse(r.scope),
        roleId: r.roleId,
        minimum: integer(r.minimum),
        ratioNumerator: integer(r.numerator),
        ratioDenominator: integer(r.denominator),
      };
    }),
  });
}
