import {
  historyCommand,
  type historyResponse,
} from "../../api/src/history-contract";
import type { z } from "zod";
export type History = z.infer<typeof historyResponse>;
export type HistoryRecords = z.infer<typeof historyCommand>["records"];
export type HistoryEntry = {
  staffId: string;
  date: string;
  minutes: string;
  evidence: string;
};
export function historyRecords(entries: HistoryEntry[]): HistoryRecords {
  const edited = entries.filter(
    (e) => e.minutes !== "" || e.evidence.trim() !== "",
  );
  if (!edited.length)
    throw new Error(
      "確認した履歴の勤務時間(分)と根拠を入力してください。休日は0を明示してください。",
    );
  if (
    edited.some(
      (e) =>
        !/^\d+$/.test(e.minutes) ||
        !e.evidence.trim() ||
        Number(e.minutes) > 1440,
    )
  )
    throw new Error(
      "勤務時間(分)は0〜1440の整数で入力し、確認の根拠を記録してください。未確認の日は空欄のままにしてください。",
    );
  return historyCommand.shape.records.parse(
    edited.map((e) => ({
      staffId: e.staffId,
      date: e.date,
      workedMinutes: Number(e.minutes),
      evidence: e.evidence.trim(),
    })),
  );
}
