import { expect, it } from "vitest";
import { submissionDeadline, beforeSubmissionDeadline } from "../../apps/api/src/submission-deadline";

it("Q88/108: October shifts close after September 20 23:59 JST, without depending on host timezone", () => {
  const d = submissionDeadline("2026-10", 20);
  expect(d).toMatchObject({ deadlineDate: "2026-09-20", timeZone: "Asia/Tokyo", configuredDay: 20 });
  expect(new Date(d.closesAt).toISOString()).toBe("2026-09-20T15:00:00.000Z");
  expect(beforeSubmissionDeadline(Date.parse("2026-09-20T23:59:00+09:00"), d)).toBe(true);
  expect(beforeSubmissionDeadline(Date.parse("2026-09-20T23:59:59.999+09:00"), d)).toBe(true);
  expect(beforeSubmissionDeadline(Date.parse("2026-09-21T00:00:00+09:00"), d)).toBe(false);
  expect(beforeSubmissionDeadline(d.closesAt + 1, d)).toBe(false);
});
it("missing days clamp in the previous month, preserving the configured day and leap years", () => {
  expect(submissionDeadline("2026-03", 31).deadlineDate).toBe("2026-02-28");
  expect(submissionDeadline("2024-03", 31).deadlineDate).toBe("2024-02-29");
  expect(submissionDeadline("2000-03", 30).deadlineDate).toBe("2000-02-29");
  expect(submissionDeadline("2026-05", 31).deadlineDate).toBe("2026-04-30");
  expect(submissionDeadline("2026-03", 1).deadlineDate).toBe("2026-02-01");
  expect(submissionDeadline("2026-03", 31).configuredDay).toBe(31);
});
it("January deadlines use December of the preceding year, including the input contract's lower year boundary", () => {
  const d = submissionDeadline("2027-01", 31);
  expect(d.deadlineDate).toBe("2026-12-31");
  expect(new Date(d.closesAt).toISOString()).toBe("2026-12-31T15:00:00.000Z");
  expect(submissionDeadline("2000-01", 20).deadlineDate).toBe("1999-12-20");
});
it("invalid month/day/server time is refused rather than silently normalized", () => {
  for (const month of ["2026-00", "2026-13", "2026-1", "2100-01", "bad"])
    expect(() => submissionDeadline(month, 20)).toThrow();
  for (const day of [0, 32, 1.5, NaN]) expect(() => submissionDeadline("2026-10", day)).toThrow();
  const d = submissionDeadline("2026-10", 20);
  for (const time of [NaN, Infinity, 1.5]) expect(() => beforeSubmissionDeadline(time, d)).toThrow("Invalid server timestamp");
});
