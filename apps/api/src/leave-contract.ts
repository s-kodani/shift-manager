import { z } from "zod";
import { optimizerInputSchema } from "../../../packages/contracts/optimizer-input.generated";

const uuid = z.string().uuid();
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const leaveKind = z.enum([
  "LEAVE_REQUEST",
  "ABSENCE_REQUEST",
  "ABSENCE_FACT",
]);
export const leavePart = z.enum(["FULL", "AM", "PM"]);
export const leaveSubmission = z
  .object({
    operationId: uuid,
    staffId: uuid,
    date: optimizerInputSchema.shape.history.element.shape.date,
    kind: leaveKind,
    part: leavePart,
    reason: z.string().trim().min(1).max(1000),
    publicationId: uuid,
    expectedPublicationRevision: revision.refine((n) => n > 0),
  })
  .strict();
export const leaveRejection = z
  .object({
    operationId: uuid,
    expectedRequestRevision: revision.refine((n) => n > 0),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export const leaveStatus = z.enum(["PENDING", "REPORTED", "REJECTED", "APPROVED", "CANCELLATION_CONFIRMED"]);
export const leaveRecord = z.object({
  id: uuid,
  staffId: uuid,
  staffName: z.string(),
  staffNumber: z.string(),
  date: leaveSubmission.shape.date,
  kind: leaveKind,
  part: leavePart,
  reason: z.string(),
  publicationId: uuid,
  publicationRevision: revision,
  start: z.number().int(),
  end: z.number().int(),
  status: leaveStatus,
  requestRevision: revision,
  recordedAt: z.number().int(),
  decisionReason: z.string().nullable(),
  decidedAt: z.number().int().nullable(),
});
export const leaveCursor = z
  .object({ recordedAt: z.number().int().nonnegative(), id: uuid })
  .strict();
export const leaveList = z.object({
  records: z.array(leaveRecord),
  nextCursor: leaveCursor.nullable(),
});
export const leaveContext = z.object({
  publicationId: uuid.nullable(),
  publicationRevision: revision,
  halfDayDivider: z.number().int().nullable(),
  staff: z.array(
    z.object({ id: uuid, name: z.string(), staffNumber: z.string() }),
  ),
  assignments: z.array(optimizerInputSchema.shape.published.element),
});
export type LeaveRecord = z.infer<typeof leaveRecord>;
// Only count remaining working minutes; rest/cancellation overlap is excluded once.
export function requestedWork(
  shift: z.infer<
    typeof optimizerInputSchema.shape.published.element.shape.shift
  >,
  part: z.infer<typeof leavePart>,
  divider: number | null,
) {
  if (!shift || (part !== "FULL" && divider === null)) return null;
  const start = Math.max(shift.start, part === "PM" ? divider! : shift.start);
  const end = Math.min(shift.end, part === "AM" ? divider! : shift.end);
  const blocked = [...shift.cancelled, ...(shift.break ? [shift.break] : [])];
  const worked = Array.from(
    { length: Math.max(0, end - start) },
    (_, n) => start + n,
  ).filter((n) => !blocked.some(([a, b]) => a <= n && n < b)).length;
  return worked ? { start, end } : null;
}
