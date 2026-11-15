export type BulkDates = { from: string; through: string; weekdays: number[] };

export const emptyBulkDates = (month: string): BulkDates => ({
  from: month + "-01",
  through: month + "-" + new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate(),
  weekdays: [0, 1, 2, 3, 4, 5, 6],
});

function day(value: string, month: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !value.startsWith(month + "-"))
    throw new Error("OUTSIDE_MONTH");
  const result = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value)
    throw new Error("OUTSIDE_MONTH");
  return result;
}

/** Inclusive calendar dates; UTC arithmetic avoids host timezone and DST changes. */
export function bulkDates(input: BulkDates, month: string): string[] {
  const first = day(input.from, month), last = day(input.through, month);
  if (first > last) throw new Error("REVERSED_DATE_RANGE");
  if (!input.weekdays.length || input.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6))
    throw new Error("WEEKDAYS_REQUIRED");
  const dates: string[] = [];
  for (const date = new Date(first); date <= last; date.setUTCDate(date.getUTCDate() + 1))
    if (input.weekdays.includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10));
  if (!dates.length) throw new Error("NO_MATCHING_DAYS");
  return dates;
}
