import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmationProvider, Loading, Table, TableCell, TableHead } from "./components/ui";
import { UnsavedInputProvider, useUnsavedInput } from "./unsaved-input";
import { PublishedFixed } from "./published-fixed";
import type { ScheduleView } from "./api";
import type { OptimizerAssignments } from "../../../packages/contracts/optimizer-input.generated";
import { indexMonthlyAssignments } from "./monthly-index";

export type PublishedScheduleSource = {
  base: string; month: string; current: boolean; loading: boolean; error: string;
  publication: { publicationId: string; publicationRevision: number; recordedAt: number; assignments: OptimizerAssignments } | null;
  refresh: () => void;
};
type Props = {
  staffId: string; month: string; initialTab: "candidate" | "published";
  nameOf: (id: string) => string; label: (value: string) => string; candidate: ScheduleView | null; candidateLabel: string;
  published: PublishedScheduleSource | null; base: string; revision: number;
  report: (error: unknown) => void; onReleased: () => Promise<unknown>; onClose: () => void;
};
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

// Isolate fixed-release drafts from background forms, which remain mounted.
export function StaffScheduleDialog(props: Props) {
  return <ConfirmationProvider><UnsavedInputProvider><StaffScheduleContent {...props} /></UnsavedInputProvider></ConfirmationProvider>;
}
function StaffScheduleContent({ staffId, month, initialTab, nameOf, label, candidate, candidateLabel, published, base, revision, report, onReleased, onClose }: Props) {
  const [tab, setTab] = useState(initialTab);
  const guard = useUnsavedInput(), closing = useRef(false);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const initialPublication = useRef(published?.publication?.publicationId);
  useEffect(() => {
    const next = published?.publication?.publicationId;
    if (initialPublication.current && next && initialPublication.current !== next) onClose();
    if (next) initialPublication.current = next;
  }, [published?.publication?.publicationId]);
  async function close() {
    if (closing.current) return;
    closing.current = true;
    try { if (await guard.allow()) onClose(); } finally { closing.current = false; }
  }
  const assignments = tab === "candidate" ? candidate?.result.assignments : published?.publication?.assignments;
  const people = useMemo(() => indexMonthlyAssignments(assignments ?? null), [assignments]);
  const days = people.get(staffId);
  const dates = useMemo(() => Array.from({ length: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate() },
    (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`), [month]);
  return <Dialog.Root open onOpenChange={open => { if (!open) void close(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="staff-dialog-overlay" />
      <Dialog.Content onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }} className="staff-dialog-content" onEscapeKeyDown={event => { event.preventDefault(); void close(); }}>
        <div className="staff-dialog-heading">
          <div><Dialog.Title>{nameOf(staffId)}の勤務一覧</Dialog.Title><Dialog.Description>{month} ／ 選択したスタッフの勤務を表示します。</Dialog.Description></div>
          <Button type="button" onClick={() => void close()} aria-label="勤務一覧を閉じる">閉じる</Button>
        </div>
        <div className="form-actions" role="group" aria-label="勤務一覧の表示元">
          {([['candidate', '表示中の案'], ['published', '公開済み勤務']] as const).map(([value, label]) =>
            <Button type="button" key={value} aria-pressed={tab === value} onClick={async () => { if (tab !== value && await guard.allow()) setTab(value); }}>{label}</Button>)}
        </div>
        <div className="staff-dialog-body">
          <p role="status">{tab === "candidate" ? candidateLabel : published?.loading ? '公開版を読み込んでいます…' : published?.error ? '公開版を取得できませんでした。' : published?.publication ? `公開版${published.publication.publicationRevision}${published.current ? '（現在の公開版）' : '（過去の公開版・閲覧のみ）'}` : '公開済み勤務はありません。'}</p>
          {tab === "candidate" && candidate?.stale && <p className="warning">この案には最新の変更が反映されていません。</p>}
          {tab === "published" && published?.loading && <Loading label="公開版を更新しています…" compact />}
          {tab === "published" && published?.error && <p role="alert" className="error">{published.error}</p>}
          {!assignments ? <p>{tab === "candidate" ? '表示できる勤務案がありません。' : 'この月はまだ公開されていないか、公開版を取得できていません。'}</p> : <>
            <div className="table-scroll" role="region" tabIndex={0} aria-label="スタッフの月間勤務一覧">
              <Table className="staff-schedule-table"><thead><tr>{['日付', '勤務', '出退勤', '休憩', '勤務時間', '取消', '業務・担当区分'].map(title => <TableHead key={title} scope="col">{title}</TableHead>)}</tr></thead>
                <tbody>{dates.map(date => {
                  const row = days?.get(date), shift = row?.shift;
                  return <tr key={date}>
                    <TableHead scope="row">{date}</TableHead><TableCell>{row ? shift ? '勤務' : '休日' : '記録なし'}</TableCell>
                    <TableCell>{shift ? `${clock(shift.start)}〜${clock(shift.end)}` : '—'}</TableCell>
                    <TableCell>{shift ? shift.break ? shift.break.map(clock).join('〜') : 'なし' : '—'}</TableCell>
                    <TableCell>{shift ? `${shift.workedMinutes}分` : '—'}</TableCell>
                    <TableCell>{shift ? shift.cancelled.length ? shift.cancelled.map(interval => interval.map(clock).join('〜')).join('、') : 'なし' : '—'}</TableCell>
                    <TableCell>{row?.blocks.map((block, index) => <p key={index}>{clock(block.start)}〜{clock(block.end)}：{label(block.taskId)}{block.roleId ? ` ／ ${label(block.roleId)}` : ''}</p>)}
                      {row?.roleIntervals?.map((role, index) => <p key={`role:${index}`}>{clock(role.start)}〜{clock(role.end)}：{label(role.roleId)}</p>)}</TableCell>
                  </tr>;
                })}</tbody>
              </Table>
            </div>
            {tab === "published" && published?.publication && published.current && !published.loading && !published.error && <PublishedFixed
              key={published.publication.publicationId} base={base} id={published.publication.publicationId} revision={revision}
              person={staffId} nameOf={nameOf} report={report} onReleased={async () => { await onReleased(); published.refresh(); }} />}
          </>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
