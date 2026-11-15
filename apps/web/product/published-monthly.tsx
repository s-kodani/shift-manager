import { useEffect, useMemo, useState } from "react";
import type { OptimizerAssignments, OptimizerInput } from "../../../packages/contracts/optimizer-input.generated";
import { publishedFixedState } from "../../api/src/published-fixed-contract";
import { api, frozenSchema } from "./api";
import { Button, Loading } from "./components/ui";
import { MonthlyTable } from "./monthly-table";
import { DailySchedule, ScheduleDetailDialog, StaffDayDetails } from "./schedule-detail-dialog";

type Publication = {
  publicationId: string; publicationRevision: number; month: string; assignments: OptimizerAssignments;
  inputRevision?: number; snapshotId?: string; locks?: OptimizerInput["locks"]; cancellation?: { input?: OptimizerInput };
};
type Detail = { date: string; staffId?: string };
type Context = { key: string; input: OptimizerInput | null; locks: OptimizerInput["locks"] | undefined; error: string; loading: boolean };

export function PublishedMonthly({ publication, current, base, inputBase, revision, nameOf, label, onStaff }: {
  publication: Publication; current: boolean; base: string; inputBase: string; revision: number;
  nameOf: (id: string) => string; label: (id: string) => string; onStaff: (id: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null), [context, setContext] = useState<Context | null>(null), [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([base, publication.publicationId, current, revision]);
  const people = useMemo(() => [...new Set(publication.assignments.map(row => row.staffId))].map(id => ({ id })), [publication.assignments]);
  useEffect(() => { setDetail(null); }, [publication.publicationId, current]);
  const opened = detail !== null;
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    setContext({ key, input: null, locks: current ? undefined : publication.locks, error: "", loading: true });
    void (async () => {
      // Use the immutable publication context, never today's planning settings.
      const [inputRead, fixedRead] = await Promise.allSettled([
        publication.cancellation?.input ? Promise.resolve(publication.cancellation.input) : publication.snapshotId
          ? api(inputBase + '/snapshots/' + publication.snapshotId, frozenSchema, undefined, controller.signal).then(value => {
            if (value.input.month !== publication.month || value.input.jobId !== publication.snapshotId || publication.inputRevision !== undefined && value.input.inputVersion !== publication.inputRevision) throw Error('PUBLICATION_INPUT_MISMATCH');
            return value.input;
          }) : Promise.reject(Error('PUBLICATION_INPUT_UNAVAILABLE')),
        current ? api(base + '/' + publication.publicationId + '/fixed', publishedFixedState, undefined, controller.signal).then(value => {
          if (value.publicationId !== publication.publicationId || value.publicationRevision !== publication.publicationRevision) throw Error('PUBLICATION_FIXED_MISMATCH');
          return value.locks;
        }) : Promise.resolve(publication.locks),
      ]);
      if (controller.signal.aborted) return;
      setContext({ key, input: inputRead.status === 'fulfilled' ? inputRead.value : null,
        locks: fixedRead.status === 'fulfilled' ? fixedRead.value : undefined, loading: false,
        error: [inputRead.status === 'rejected' ? '公開時の予定・準備情報を取得できません。保存済みの業務・休憩・取消を表示します。' : '', fixedRead.status === 'rejected' ? '現在の明示固定を取得できませんでした。' : ''].filter(Boolean).join(' ') });
    })();
    return () => controller.abort();
  }, [opened, key, attempt, inputBase]);
  const shown = context?.key === key ? context : null;
  const assignment = detail?.staffId ? publication.assignments.find(row => row.staffId === detail.staffId && row.date === detail.date) : null;
  return <div className="published-monthly" role="region" aria-label="公開済みシフトの月間表">
    <MonthlyTable month={publication.month} staff={people} assignments={publication.assignments} nameOf={nameOf}
      choose={date => setDetail({ date })} onCell={(staffId, date) => setDetail({ staffId, date })} onStaff={onStaff} />
    {detail && <ScheduleDetailDialog title={detail.staffId ? `${nameOf(detail.staffId)} ${detail.date}の勤務詳細` : `${detail.date}の日別業務配置`}
      sourceLabel={`公開版${publication.publicationRevision}${current ? '（現在の公開版）' : '（過去の公開版・閲覧のみ）'}`} stale={false} onClose={() => setDetail(null)}>
      {!current && <p className="warning">当時の公開版です。現在の勤務ではありません。明示固定は公開時の記録です。</p>}
      {(!shown || shown.loading) && <Loading label="公開時の情報を読み込んでいます…" compact />}
      {shown?.error && <div role="alert"><p className="warning">{shown.error}</p><Button type="button" onClick={() => setAttempt(value => value + 1)}>公開時の情報を再読込</Button></div>}
      {detail.staffId ? assignment && <><StaffDayDetails assignment={assignment} input={shown?.input ?? null} locks={shown?.locks} label={label} />
        <div className="form-actions"><Button type="button" onClick={() => onStaff(detail.staffId!)}>このスタッフの月間勤務を見る</Button></div></> :
        <DailySchedule assignments={publication.assignments} month={publication.month} input={shown?.input ?? null} date={detail.date}
          setDate={date => setDetail({ date })} nameOf={nameOf} label={label} onStaff={onStaff} published />}
    </ScheduleDetailDialog>}
  </div>;
}
