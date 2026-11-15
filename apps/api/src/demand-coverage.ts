import type { z } from "zod";
import type { companyPolicy, planning, teamConfig } from "./input-contracts";

// Only general tasks accept demand. Dedicated roles are configured separately.
export function demandCoverage(month: string, contract: z.infer<typeof companyPolicy>["contract"],
  config: Pick<z.infer<typeof teamConfig>, "slotMinutes" | "tasks">, demand: z.infer<typeof planning>["demand"]) {
  const known = new Set(demand.filter(d => d.direct !== null || d.calculated !== null)
    .map(d => `${d.date}:${d.start}:${d.end}:${d.taskId}`));
  const examples: { date: string; start: number; end: number; taskId: string }[] = [];
  const tasks = config.tasks.filter(t => t.kind === "general");
  let expectedSlots = 0, missingSlots = 0;
  const first = new Date(`${month}-01T00:00:00Z`);
  for (const date = new Date(first); date.getUTCMonth() === first.getUTCMonth(); date.setUTCDate(date.getUTCDate() + 1)) {
    // Stored contracts use Sunday=0, matching Date; Monday=0 is solver-only.
    if (!contract.weekdays.includes(date.getUTCDay())) continue;
    const day = date.toISOString().slice(0, 10);
    // Demand uses clock-aligned slots; include slots that overlap opening hours.
    for (let start = Math.floor(contract.start / config.slotMinutes) * config.slotMinutes; start < contract.end; start += config.slotMinutes) {
      for (const task of tasks) {
        expectedSlots++;
        const end = start + config.slotMinutes;
        if (known.has(`${day}:${start}:${end}:${task.id}`)) continue;
        missingSlots++;
        if (examples.length < 12) examples.push({ date: day, start, end, taskId: task.id });
      }
    }
  }
  return { expectedSlots, missingSlots, examples };
}
