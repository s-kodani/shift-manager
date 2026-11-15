import type { OptimizerInput } from "../../../packages/contracts/optimizer-input.generated";
import { z } from "zod";
import type { InputDatabase } from "./input-versions";
import { ProductError, requireManager } from "./product";
import { readPublicationHead } from "./schedule-publications";
const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const cell = (value: string) =>
  '"' +
  (/^[=+@\-\t\r\n]/.test(value) ? "'" + value : value).replaceAll('"', '""') +
  '"';
type Shift = OptimizerInput["published"][number]["shift"];
export function csvWork(shift: Shift) {
  if (!shift) return ["休日", "", "", "", "", ""];
  let intervals: number[][] = [[shift.start, shift.end]];
  for (const [a, b] of shift.cancelled)
    intervals = intervals.flatMap(([start, end]) =>
      b <= start || end <= a
        ? [[start, end]]
        : [
            [start, Math.min(end, a)],
            [Math.max(start, b), end],
          ].filter(([x, y]) => x < y),
    );
  const rests = shift.break
    ? intervals
        .map(([a, b]) => [
          Math.max(a, shift.break![0]),
          Math.min(b, shift.break![1]),
        ])
        .filter(([a, b]) => a < b)
    : [];
  return [
    !intervals.length
      ? "全日取消"
      : shift.cancelled.length
        ? "一部取消"
        : "勤務",
    intervals.map(([a]) => clock(a)).join(" / "),
    intervals.map(([, b]) => clock(b)).join(" / "),
    rests.map(([a]) => clock(a)).join(" / "),
    rests.map(([, b]) => clock(b)).join(" / "),
    shift.cancelled.map(([a, b]) => clock(a) + "〜" + clock(b)).join(" / "),
  ];
}
export async function publicationCsv(
  env: { DB: InputDatabase; INPUTS: R2Bucket },
  company: string,
  team: string,
  user: string,
  month: string,
) {
  await requireManager(env.DB, company, team, user);
  const head = await readPublicationHead(env, company, team, user, month);
  if (!head.publication) throw new ProductError("NOT_FOUND", 404);
  const rows = await env.DB.prepare(
    "SELECT staff_id,staff_number,staff_name FROM schedule_publication_assignment WHERE company_id=? AND team_id=? AND publication_id=? GROUP BY staff_id,staff_number,staff_name",
  )
    .bind(company, team, head.publication.publicationId)
    .all();
  const names = new Map(
    z
      .array(
        z.object({
          staff_id: z.string(),
          staff_number: z.string(),
          staff_name: z.string(),
        }),
      )
      .parse(rows.results)
      .map((r) => [r.staff_id, r]),
  );
  const csv =
    [
      [
        "スタッフ番号",
        "スタッフ名",
        "勤務日",
        "状態",
        "出勤",
        "退勤",
        "休憩開始",
        "休憩終了",
        "取消区間",
      ],
      ...head.publication.assignments.map((a) => {
        const person = names.get(a.staffId);
        if (!person) throw new Error("PUBLICATION_STAFF_IDENTITY_MISSING");
        return [
          person.staff_number,
          person.staff_name,
          a.date,
          ...csvWork(a.shift),
        ];
      }),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n") + "\r\n";
  await requireManager(env.DB, company, team, user);
  return {
    csv: "\uFEFF" + csv,
    filename: `schedule-${month}-v${head.publicationRevision}.csv`,
  };
}
