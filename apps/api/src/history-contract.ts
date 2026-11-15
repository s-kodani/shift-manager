import { z } from "zod";
import {
  optimizerInputSchema,
  type OptimizerInput,
} from "../../../packages/contracts/optimizer-input.generated";

export const historyRecord = optimizerInputSchema.shape.history.element
  .extend({
    staffId: z.string().uuid(),
    evidence: z.string().trim().min(1).max(1000),
  })
  .strict();
export const historyCommand = z
  .object({
    operationId: z.string().uuid(),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    month: z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/),
    records: z
      .array(historyRecord)
      .min(1)
      .max(500)
      .refine(
        (rows) =>
          new Set(rows.map((r) => `${r.staffId}:${r.date}`)).size ===
          rows.length,
        "DUPLICATE_HISTORY",
      ),
  })
  .strict();
const historyDay = historyRecord.pick({ staffId: true, date: true });
export const historyResponse = z.object({
  month: historyCommand.shape.month,
  inputRevision: z.number().int().nonnegative(),
  window: z.object({
    first: z.string(),
    last: z.string(),
    previousFrom: z.string(),
    nextThrough: z.string(),
  }),
  records: z.array(
    historyRecord.extend({
      source: z.enum(["manual", "published"]).optional(),
      operationId: z.string().uuid(),
      revision: z.number().int().nonnegative(),
    }),
  ),
  required: z.array(historyDay),
  missing: z.array(historyDay),
});
const day = 86_400_000;
export function historyWindow(month: string) {
  const first = Date.parse(month + "-01T00:00:00Z"),
    last = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0);
  const date = (value: number) => new Date(value).toISOString().slice(0, 10);
  return {
    first: date(first),
    last: date(last),
    previousFrom: date(first - 31 * day),
    nextThrough: date(last + 31 * day),
  };
}
export function requiredHistory(
  input: Pick<OptimizerInput, "month" | "weekStart" | "staff">,
) {
  const first = Date.parse(input.month + "-01T00:00:00Z"),
    weekday = (new Date(first).getUTCDay() + 6) % 7;
  return input.staff.flatMap((s) =>
    Array.from(
      {
        length: Math.max(
          (weekday - input.weekStart + 7) % 7,
          ...s.rules.map((r) => r.maxConsecutive),
        ),
      },
      (_, n) => ({
        staffId: s.id,
        date: new Date(first - (n + 1) * day).toISOString().slice(0, 10),
      }),
    ),
  );
}
export function relevantHistory(
  input: Pick<OptimizerInput, "month" | "weekStart" | "staff">,
  rows: OptimizerInput["history"],
) {
  const required = new Set(
    requiredHistory(input).map((r) => `${r.staffId}:${r.date}`),
  );
  const w = historyWindow(input.month),
    last = Date.parse(w.last + "T00:00:00Z"),
    weekday = (new Date(last).getUTCDay() + 6) % 7;
  return rows.filter(
    (r) =>
      required.has(`${r.staffId}:${r.date}`) ||
      input.staff.some(
        (s) =>
          s.id === r.staffId &&
          r.date > w.last &&
          Date.parse(r.date + "T00:00:00Z") <=
            last +
              day *
                Math.max(
                  (input.weekStart + 6 - weekday + 7) % 7,
                  ...s.rules.map((rule) => rule.maxConsecutive),
                ),
      ),
  );
}
