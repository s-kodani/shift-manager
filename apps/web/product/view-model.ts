import type { OptimizerInput } from "../../../packages/contracts/optimizer-input.generated";
type Assignment = {
  staffId: string;
  date: string;
  shift: {
    start: number;
    end: number;
    break: number[] | null;
    cancelled: number[][];
  } | null;
  blocks: {
    start: number;
    end: number;
    taskId: string;
    roleId: string | null;
  }[];
  roleIntervals?: { start: number; end: number; roleId: string }[];
};
type Segment = {
  start: number;
  end: number;
  kind: "task" | "prep" | "event" | "break" | "cancel";
  title: string;
  roleId?: string | null;
};

// Convert a displayed coefficient exactly to its declared integer precision.
// Decimal string arithmetic avoids rounding a forbidden value or float error.
export function scaledCount(value: string, scale: number): number | null {
  if (value === "") return null;
  if (
    !/^\d+(?:\.\d+)?$/.test(value) ||
    !Number.isSafeInteger(scale) ||
    scale < 1
  )
    throw new Error("INVALID_PRECISION");
  const [whole, fraction = ""] = value.split("."),
    denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * BigInt(scale);
  if (numerator % denominator !== 0n) throw new Error("INVALID_PRECISION");
  const result = Number(numerator / denominator);
  if (!Number.isSafeInteger(result)) throw new Error("INVALID_PRECISION");
  return result;
}
export function timeline(
  a: Assignment,
  input: Pick<OptimizerInput, "transitions" | "events">,
): Segment[] {
  const segments: Segment[] = [],
    events = input.events.filter(
      (e) => e.date === a.date && e.staffIds.includes(a.staffId),
    );
  let previous: string | null = null,
    preparationEnd = 0;
  const contains = (m: number, interval: number[]) =>
    interval[0] <= m && m < interval[1];
  for (let m = a.shift?.start ?? 0; m < (a.shift?.end ?? 0); m++) {
    if (
      (a.shift?.break && contains(m, a.shift.break)) ||
      a.shift?.cancelled.some((i) => contains(m, i)) ||
      events.some((e) => e.start <= m && m < e.end)
    )
      continue;
    const block = a.blocks.find((b) => b.start <= m && m < b.end);
    if (!block) continue;
    if (previous !== block.taskId) {
      preparationEnd =
        m +
        (previous
          ? (input.transitions.find(
              (t) => t.fromTaskId === previous && t.toTaskId === block.taskId,
            )?.minutes ?? 0)
          : 0);
      previous = block.taskId;
    }
    const roleId =
      a.roleIntervals?.find((r) => r.start <= m && m < r.end)?.roleId ??
      block.roleId;
    const kind = m < preparationEnd ? "prep" : "task",
      title = kind === "prep" ? "準備・移動" : block.taskId,
      last = segments.at(-1);
    if (
      last?.end === m &&
      last.kind === kind &&
      last.title === title &&
      last.roleId === (kind === "prep" ? undefined : roleId)
    )
      last.end = m + 1;
    else
      segments.push({
        start: m,
        end: m + 1,
        kind,
        title,
        ...(kind === "task" ? { roleId } : {}),
      });
  }
  for (const e of events)
    segments.push({
      start: e.start,
      end: e.end,
      kind: "event",
      title: e.kind === "training" ? "研修" : "会議",
    });
  if (a.shift?.break)
    segments.push({
      start: a.shift.break[0],
      end: a.shift.break[1],
      kind: "break",
      title: "休憩",
    });
  for (const [start, end] of a.shift?.cancelled ?? [])
    segments.push({ start, end, kind: "cancel", title: "取消" });
  return segments.sort((x, y) => x.start - y.start || x.end - y.end);
}
