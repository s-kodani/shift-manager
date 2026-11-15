import * as Dialog from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";
import { Button, Card, CardContent, Field, Input } from "./components/ui";
import type { OptimizerAssignments, OptimizerInput } from "../../../packages/contracts/optimizer-input.generated";
import { timeline } from "./view-model";

const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Read-only details never navigate away from or reset background edits. */
export function ScheduleDetailDialog({ title, sourceLabel, stale, onClose, children }: {
  title: string; sourceLabel: string; stale: boolean; onClose: () => void; children: ReactNode;
}) {
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="staff-dialog-overlay" />
      <Dialog.Content className="staff-dialog-content schedule-detail-dialog" onCloseAutoFocus={event => {
        event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus();
      }}>
        <div className="staff-dialog-heading">
          <div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{sourceLabel} ／ 閲覧用の詳細です。</Dialog.Description></div>
          <Button type="button" aria-label="詳細を閉じる" onClick={onClose}>閉じる</Button>
        </div>
        <div className="staff-dialog-body">
          {stale && <p className="warning">この案には最新の変更が反映されていません。</p>}
          {children}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

type TimelineInput = Pick<OptimizerInput, "events" | "transitions">;

export function AssignmentTimeline({ assignment, input, label }: {
  assignment: OptimizerAssignments[number]; input: TimelineInput | null; label: (id: string) => string;
}) {
  const segments = input ? timeline(assignment, input) : [
    ...assignment.blocks.map(block => ({ ...block, kind: "task", title: block.taskId })),
    ...(assignment.shift?.break ? [{ start: assignment.shift.break[0], end: assignment.shift.break[1], kind: "break", title: "休憩", roleId: null }] : []),
    ...(assignment.shift?.cancelled ?? []).map(([start, end]) => ({ start, end, kind: "cancel", title: "取消", roleId: null })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  return <div className="timeline">{segments.map((block, index) => <div className={block.kind + '-block'} key={index}>
    <time>{time(block.start)}〜{time(block.end)}</time><strong>{label(block.title)}</strong>{block.roleId && <span>{label(block.roleId)}</span>}
  </div>)}</div>;
}

export function DailySchedule({ assignments, input, month, date, setDate, onStaff, nameOf, label, published = false }: {
  assignments: OptimizerAssignments | null; input: TimelineInput | null; month: string; date: string; setDate: (date: string) => void;
  onStaff: (id: string) => void; nameOf: (id: string) => string; label: (id: string) => string; published?: boolean;
}) {
  const rows = assignments?.filter(row => row.date === date) ?? [];
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  return <Card className="panel"><h2>{published ? "日別業務配置（公開済み）" : "日別業務配置（参考案）"}</h2><CardContent className="panel-body">
    <Field title="対象日"><Input type="date" value={date} min={month + "-01"} max={`${month}-${String(last).padStart(2, "0")}`}
      onChange={event => { const value = event.target.value; if (value >= month + '-01' && value <= `${month}-${String(last).padStart(2, "0")}`) setDate(value); }} /></Field>
    {rows.map(row => <section className="daily-person" key={row.staffId}>
      <h3><Button type="button" variant="ghost" className="staff-name-button" onClick={() => onStaff(row.staffId)}>{nameOf(row.staffId)}</Button> · {row.shift ? `${time(row.shift.start)}〜${time(row.shift.end)}` : "休日"}</h3>
      {row.shift && <><p className="muted">勤務量 {row.shift.workedMinutes}分 ／ 休憩 {row.shift.break ? row.shift.break.map(time).join('〜') : 'なし'}</p>
        <AssignmentTimeline assignment={row} input={input} label={label} /></>}
    </section>)}
    {!rows.length && <p>この日の配置はありません。</p>}
    {input && <p className="muted">準備・移動は整数分で計算し、業務枠へ丸めません。業務と準備・移動を分けて表示しています。</p>}
  </CardContent></Card>;
}

export function StaffDayDetails({ assignment, input, locks, label }: {
  assignment: OptimizerAssignments[number]; input: TimelineInput | null; locks: OptimizerInput["locks"] | undefined; label: (id: string) => string;
}) {
  const shift = assignment.shift;
  const parts = [...new Set((locks ?? []).filter(lock => lock.staffId === assignment.staffId && lock.date === assignment.date).flatMap(lock => lock.parts))];
  const fixedNames = { pattern: "勤務パターン", time: "出退勤", break: "休憩" };
  return <section className="staff-day-details">
    <dl>
      <dt>勤務</dt><dd>{shift ? '勤務' : '休日'}</dd>
      <dt>勤務パターン</dt><dd>{shift ? label(shift.patternId) : '—'}</dd>
      <dt>出退勤</dt><dd>{shift ? `${time(shift.start)}〜${time(shift.end)}` : '—'}</dd>
      <dt>休憩</dt><dd>{shift ? `${shift.break ? shift.break.map(time).join('〜') : 'なし'}（${shift.breakKind === 'fixed' ? '固定' : '自動'}）` : '—'}</dd>
      <dt>勤務時間</dt><dd>{shift ? `${shift.workedMinutes}分` : '—'}</dd>
      <dt>取消</dt><dd>{shift?.cancelled.length ? shift.cancelled.map(interval => interval.map(time).join('〜')).join('、') : 'なし'}</dd>
      <dt>明示固定</dt><dd>{!locks ? '取得できていません' : parts.length ? parts.map(part => fixedNames[part]).join('、') : 'なし'}</dd>
    </dl>
    <h3>業務・担当区分</h3>
    <AssignmentTimeline assignment={assignment} input={input} label={label} />
    {assignment.roleIntervals?.map((role, index) => <p key={index}>{time(role.start)}〜{time(role.end)}：{label(role.roleId)}</p>)}
    {!shift && <p>この日は勤務がありません。</p>}
  </section>;
}
