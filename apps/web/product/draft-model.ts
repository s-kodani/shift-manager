import type {
  OptimizerInput,
  OptimizerAssignments,
} from "../../../packages/contracts/optimizer-input.generated";
export type EditingDraft = {
  assignments: OptimizerAssignments;
  locks: OptimizerInput["locks"];
  exceptions: OptimizerInput["exceptions"];
};
export function workedMinutes(
  shift: NonNullable<OptimizerAssignments[number]["shift"]>,
) {
  let minutes = 0;
  for (let m = shift.start; m < shift.end; m++)
    if (
      !(shift.break && shift.break[0] <= m && m < shift.break[1]) &&
      !shift.cancelled.some(([a, b]) => a <= m && m < b)
    )
      minutes++;
  return minutes;
}
function rebuildBlocks(a: OptimizerAssignments[number], input: OptimizerInput) {
  if (!a.shift) {
    a.blocks = [];
    return;
  }
  const old = a.blocks;
  a.blocks = Array.from(
    {
      length:
        Math.ceil(a.shift.end / input.slotMinutes) -
        Math.floor(a.shift.start / input.slotMinutes),
    },
    (_, i) => {
      const start =
        (Math.floor(a.shift!.start / input.slotMinutes) + i) * input.slotMinutes;
      return (
        old.find(
          (b) => b.start === start && b.end === start + input.slotMinutes,
        ) ?? {
          start,
          end: start + input.slotMinutes,
          taskId: input.tasks[0].id,
          roleId: null,
        }
      );
    },
  ).filter((b) => {
    for (
      let m = Math.max(b.start, a.shift!.start);
      m < Math.min(b.end, a.shift!.end);
      m++
    ) {
      if (
        !(a.shift!.break && a.shift!.break[0] <= m && m < a.shift!.break[1]) &&
        !a.shift!.cancelled.some(([start, end]) => start <= m && m < end) &&
        !input.events.some(
          (e) =>
            e.date === a.date &&
            e.staffIds.includes(a.staffId) &&
            e.start <= m &&
            m < e.end,
        )
      )
        return true;
    }
    return false;
  });
}
export function changeBreak(
  draft: EditingDraft,
  index: number,
  interval: [number, number] | null,
  input: OptimizerInput,
): EditingDraft {
  const next = structuredClone(draft),
    a = next.assignments[index];
  if (!a.shift) throw new Error("勤務がありません。");
  if (
    a.shift.breakKind === "fixed" ||
    next.locks.some(
      (l) => l.staffId === a.staffId && l.date === a.date && l.parts.includes("break"),
    )
  )
    throw new Error("固定された休憩は変更できません。");
  a.shift.break = interval ? [...interval] : null;
  a.shift.workedMinutes = workedMinutes(a.shift);
  rebuildBlocks(a, input);
  return next;
}
export function changePattern(
  draft: EditingDraft,
  index: number,
  id: string,
  input: OptimizerInput,
): EditingDraft {
  const next = structuredClone(draft),
    a = next.assignments[index];
  if (next.locks.some((l) => l.staffId === a.staffId && l.date === a.date))
    throw new Error("固定を解除してから勤務を変更してください。");
  const pattern = input.patterns.find((p) => p.id === id);
  if (!pattern) {
    a.shift = null;
    a.blocks = [];
    a.roleIntervals = [];
    next.exceptions = next.exceptions.filter(
      (e) => e.staffId !== a.staffId || e.date !== a.date,
    );
    return next;
  }
  const previous = a.shift;
  a.shift = {
    patternId: pattern.id,
    start: pattern.start,
    end: pattern.end,
    breakKind: pattern.breakKind,
    break:
      pattern.breakKind === "fixed"
        ? (pattern.fixedBreak ?? null)
        : (previous?.break ?? null),
    cancelled: [],
    workedMinutes: 0,
  };
  a.shift.workedMinutes = workedMinutes(a.shift);
  rebuildBlocks(a, input);
  return next;
}
export function setFixed(
  draft: EditingDraft,
  index: number,
  parts: OptimizerInput["locks"][number]["parts"],
): EditingDraft {
  const next = structuredClone(draft),
    a = next.assignments[index];
  const old = next.locks.find(
      (l) => l.staffId === a.staffId && l.date === a.date,
    ),
    id = old?.id ?? crypto.randomUUID();
  next.locks = next.locks.filter(
    (l) => l.staffId !== a.staffId || l.date !== a.date,
  );
  if (parts.length)
    next.locks.push({
      id,
      staffId: a.staffId,
      date: a.date,
      parts,
      shift: structuredClone(a.shift),
    });
  next.exceptions = next.exceptions.map((e) =>
    e.staffId === a.staffId &&
    e.date === a.date &&
    e.lockId !== null &&
    (e.lockId !== id ||
      !["pattern", "time", "break"].every((p) =>
        parts.includes(p as (typeof parts)[number]),
      ))
      ? { ...e, lockId: null }
      : e,
  );
  return next;
}
export function violationText(value: string, nameOf: (id: string) => string) {
  const names: Record<string, string> = {
    WORKED_MINUTES: "勤務量と出退勤・休憩が一致していません",
    MONTHLY_HOURS: "月の最低／最大勤務時間を満たしていません",
    MONTHLY_DAYS: "月の勤務日数・休日数を満たしていません",
    UNAVAILABLE: "勤務不可と重なっています。手動配置には理由が必要です",
    LOCK: "固定内容と一致していません",
    PATTERN: "勤務パターンと時刻が一致していません",
    BREAK_QUANTITY: "必要な休憩量と一致していません",
    BREAK_INTERVAL: "休憩の区間を確認してください",
    BREAK_RANGE: "休憩が取得可能範囲外です",
    FIXED_BREAK: "勤務パターンの固定休憩と一致していません",
    EVENT_FULL_ATTENDANCE: "予定に全時間参加できません",
    EVENT_OVERLAP: "予定と休憩・取消が重なっています",
    CONTRACT: "契約の勤務曜日・時間帯を満たしていません",
    DAILY_HOURS: "日の最大勤務時間を超えています",
    WEEKLY_HOURS: "週の最大勤務時間を超えています",
    CONSECUTIVE: "最大連続勤務日数を超えています",
    TASK_SLOT: "業務配置の時間枠を確認してください",
    PHANTOM_TASK: "休憩・予定だけの枠に業務が配置されています",
    TASK_ELIGIBILITY: "業務の必要習熟度を満たしていません",
    TASK_OVERLAP: "業務配置が重なっています",
    ROLE_ELIGIBILITY: "対応可能な担当を満たしていません",
    ROLE_INTERVAL: "担当区分の時間区間を確認してください",
    ROLE_OVERLAP: "担当区分が重なっています",
    ROLE_OUTSIDE_PROCESSING: "業務処理外に担当区分が配置されています",
    DUPLICATE_ROLE_SOURCE: "時間枠と分単位の担当区分が重なっています",
    WAITING: "勤務中に業務未割当の時間があります",
    TRANSITION_NOT_AT_SLOT_START:
      "業務切替は配置枠の開始時刻に合わせてください",
    PREPARATION_INTERRUPTED: "準備・移動が休憩・予定と重なっています",
    MINIMUM_RUN: "業務の最低継続時間を満たしていません",
    DRAFT_CANCELLATION: "未公開の案に取消は設定できません",
    CANCELLATION_INTERVAL: "取消の時間区間を確認してください",
    PUBLISHED_MAINTENANCE: "公開済みの出退勤・休憩を維持してください",
    ASSIGNMENT_KEYS: "スタッフ・日付の配置が不足または重複しています",
    MANUAL_EXCEPTION_PLACEMENT: "例外の区間が実際の勤務内にありません",
  };
  const [code, id, date] = value.split(":");
  return [names[code] ?? code, id ? nameOf(id) : "", date ?? ""]
    .filter(Boolean)
    .join(" · ");
}
