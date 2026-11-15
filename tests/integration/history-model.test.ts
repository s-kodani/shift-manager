import { expect, it } from "vitest";
import { historyRecords } from "../../apps/web/product/history-model";
const entry = {
  staffId: "f6898a9d-83c6-4dfe-bfcf-fab3d351357d",
  date: "2026-09-30",
  minutes: "",
  evidence: "",
};
it("history UI: untouched rows are absent, confirmed zero is explicit and corrections require new evidence", () => {
  expect(
    historyRecords([
      { ...entry, minutes: "0", evidence: "架空の休日を確認" },
      { ...entry, date: "2026-09-29" },
    ]),
  ).toEqual([
    {
      staffId: entry.staffId,
      date: entry.date,
      workedMinutes: 0,
      evidence: "架空の休日を確認",
    },
  ]);
  for (const rows of [
    [entry],
    [{ ...entry, minutes: "0" }],
    [{ ...entry, evidence: "確認" }],
    [{ ...entry, minutes: "1.5", evidence: "確認" }],
    [{ ...entry, minutes: "1441", evidence: "確認" }],
    [{ ...entry, minutes: "1e2", evidence: "確認" }],
  ])
    expect(() => historyRecords(rows)).toThrow();
  expect(
    historyRecords([
      { ...entry, minutes: "367", evidence: "  架空の分単位記録  " },
    ])[0],
  ).toMatchObject({ workedMinutes: 367, evidence: "架空の分単位記録" });
});
