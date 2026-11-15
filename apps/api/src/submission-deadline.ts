import { z } from "zod";

const targetMonth = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const configuredDay = z.number().int().min(1).max(31);
const jstOffset = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

// Q88/108, user decision 2026-10-11: previous month, clamp to month end.
// closesAt is exclusive: the whole displayed 23:59 minute is accepted.
// Reopening, authority and atomic save-time checks belong to the API/DB layer.
export function submissionDeadline(month: string, deadlineDay: number) {
  targetMonth.parse(month);
  configuredDay.parse(deadlineDay);
  const [year, monthNumber] = month.split("-").map(Number);
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1));
  const previousYear = previous.getUTCFullYear();
  const previousIndex = previous.getUTCMonth();
  const daysInPreviousMonth = new Date(Date.UTC(year, monthNumber - 1, 0)).getUTCDate();
  const day = Math.min(deadlineDay, daysInPreviousMonth);
  return {
    month,
    configuredDay: deadlineDay,
    deadlineDate: `${previousYear}-${pad(previousIndex + 1)}-${pad(day)}`,
    timeZone: "Asia/Tokyo" as const,
    closesAt: Date.UTC(previousYear, previousIndex, day + 1) - jstOffset,
  };
}

export function beforeSubmissionDeadline(now: number, deadline: ReturnType<typeof submissionDeadline>) {
  if (!Number.isSafeInteger(now)) throw new RangeError("Invalid server timestamp");
  return now < deadline.closesAt;
}
