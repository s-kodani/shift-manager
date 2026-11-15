import { Alert, Button, Card, CardContent, Input, InfoHelp, Loading, NativeSelect } from "./components/ui";
import { useUnsavedInput } from "./unsaved-input";
import React, { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { PublishedMonthly } from "./published-monthly";
import { optimizerAssignmentsSchema, optimizerInputSchema } from "../../../packages/contracts/optimizer-input.generated";
import { api, type ScheduleView } from "./api";
import {PublicationHistory,PublicationNotices} from "./publication-browsing";
import { historyTarget, publicationEligibility, violationAdvice, type HistoryTarget, type PublicationFix } from "./publication-guidance";
import { publicationValidation } from "../../api/src/checker-contract";
import { revalidationSummary } from "../../api/src/revalidation-contract";
import {
  PublicationRevalidation,
  revalidationLabel,
} from "./publication-revalidation";
const body = z.object({
  publicationId: z.string().uuid(),
  month: z.string(),
  publicationRevision: z.number().int(),
  recordedAt: z.number(),
  publication: z.literal("PUBLISHED"),
  inputRevision:z.number().int().optional(),
  validation:publicationValidation.optional(),
  snapshotId:z.string().uuid().optional(),
  locks:optimizerInputSchema.shape.locks.optional(),
  actorId:z.string().uuid().optional(),
  source:z.object({kind:z.enum(["job","draft"]),id:z.string().uuid()}).optional(),
  cancellation:z.object({operationId:z.string().uuid(),parentPublicationId:z.string().uuid(),input:optimizerInputSchema.optional()}).optional(),
  assignments: optimizerAssignmentsSchema,
});
const headSchema = z.object({
  publicationRevision: z.number().int(),
  publication: body.nullable(),
  revalidationRequired: z.boolean().optional(),
  revalidation: revalidationSummary
    .partial()
    .required({ status: true })
    .nullable()
    .optional(),
});
const readSchema=z.object({publication:body,superseded:z.boolean(),revalidationRequired:z.boolean()});
const clock = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
export function PublicationView({
  base,
  inputBase,
  label,
  month,
  revision,
  manager,
  nameOf,
  report,
  onHead,
  onReleased,
  initialPublicationId,
  onOpenNotice,
  navigationDisabled,
  self,
  onSource,
  onStaff,
}: {
  base: string;
  inputBase: string;
  label: (id: string) => string;
  month: string;
  revision: number;
  manager: boolean;
  nameOf: (id: string) => string;
  report: (e: unknown) => void;
  onHead: (revision: number | null) => void;
  onReleased: () => Promise<unknown>;
  initialPublicationId:string|null;
  onOpenNotice:(month:string,id:string)=>void;
  navigationDisabled:boolean;
  self:string|null;
  onSource?: (source: import("./staff-schedule-dialog").PublishedScheduleSource | null) => void;
  onStaff?: (id: string) => void;
}) {
  const [head, setHead] = useState<z.infer<typeof headSchema> | null>(null),
    [refresh, setRefresh] = useState(0),
    [selectedId,setSelectedId]=useState<string|null>(initialPublicationId),
    [historical,setHistorical]=useState<z.infer<typeof readSchema>|null>(null),
    [viewError,setViewError]=useState("");
  const [headLoading, setHeadLoading] = useState(true), [headError, setHeadError] = useState(false);
  const unsaved=useUnsavedInput();
  const reading=useRef<AbortController|null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setHeadLoading(true); setHeadError(false);
    onHead(null);
    api(base + "?month=" + month, headSchema, undefined, controller.signal)
      .then(h => {
        if (controller.signal.aborted) return;
        setHead(h);
        onHead(h.publicationRevision);
      })
      .catch((e) => {
        if (!controller.signal.aborted) { setHeadError(true); report(e); }
      }).finally(() => { if (!controller.signal.aborted) setHeadLoading(false); });
    return () => controller.abort();
  }, [base, month, revision, manager, refresh]);
  useEffect(() => {
    if (
      !head?.revalidation ||
      !["PENDING", "RUNNING"].includes(head.revalidation.status)
    )
      return;
    const controller = new AbortController();
    let active = false;
    const timer = setInterval(() => {
      if (active) return;
      active = true;
      api(base + "?month=" + month, headSchema, undefined, controller.signal)
        .then((h) => {
          if (!controller.signal.aborted) { setHead(h); onHead(h.publicationRevision); }
        })
        .catch((e) => {
          if (!controller.signal.aborted) report(e);
        })
        .finally(() => {
          active = false;
        });
    }, 3000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [base, month, head?.revalidation?.status]);
  useEffect(()=>{
    const c=new AbortController();reading.current?.abort();reading.current=c;setHistorical(null);setViewError('');
    if(selectedId)api(base+'/'+selectedId,readSchema,undefined,c.signal).then(r=>{
      if(r.publication.publicationId!==selectedId||r.publication.month!==month)throw new Error('公開版の対象月・参照先が一致しません。');
      if(!c.signal.aborted)setHistorical(r);
    }).catch(e=>{if(!c.signal.aborted){setViewError('選択した公開版を取得できませんでした。');report(e);}});
    return()=>c.abort();
  },[base,month,selectedId,refresh,manager,self]);
  const displayed=selectedId?historical?.publication??null:head?.publication??null;
  const current=displayed!==null&&head?.publication?.publicationId===displayed.publicationId&&(!selectedId||historical?.superseded===false);
  const shown = displayed?.assignments.filter(a => a.staffId === self) ?? [];
  useEffect(() => {
    onSource?.({ base, month, publication: displayed, current, loading: headLoading || !!selectedId && !historical && !viewError,
      error: viewError || (headError ? "公開版を取得できませんでした。" : ""), refresh: () => setRefresh(r => r + 1) });
  }, [base, month, displayed, current, headLoading, headError, viewError]);
  useEffect(() => () => onSource?.(null), [base, month]);
  return (
    <>
    <PublicationNotices base={base} disabled={navigationDisabled} report={report} onOpen={(m,id)=>{if(m===month)unsaved.navigate(()=>setSelectedId(id));else onOpenNotice(m,id);}}/>
    <Card className="panel">
      <h2 className="publication-heading">{manager ? "公開済みのシフト" : "自分の公開済みシフト"}
        {displayed && <InfoHelp title="公開済みシフトの情報">
          <p>公開版{displayed.publicationRevision} ／ {new Date(displayed.recordedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
          {manager && displayed.inputRevision !== undefined && <p>当時の入力版{displayed.inputRevision}・公開元：{displayed.cancellation ? '休暇・欠勤による勤務取消' : displayed.source?.kind === 'draft' ? '保存済み編集案' : '計算した案'}</p>}
          {current && head?.revalidation && <p>{revalidationLabel(head.revalidation.status)}{manager && <> ／ 対象入力版{head.revalidation.requiredRevision}{head.revalidation.inputRevision != null ? `・検証入力版${head.revalidation.inputRevision}` : ''}</>}</p>}
          {!current && <p>当時の公開版です。現在の判定は最新の公開版で確認してください。</p>}
        </InfoHelp>}
      </h2>
      <CardContent className="panel-body">
        {selectedId&&<div className="form-actions"><Button onClick={()=>unsaved.navigate(()=>{setSelectedId(null);setRefresh(r=>r+1);})}>最新の公開版へ戻る</Button></div>}
        {viewError&&<p className="warning" role="alert">{viewError}</p>}
        {headLoading && head && <Loading label="公開版を更新しています…" compact />}
        {!head && !headError || selectedId&&!historical&&!viewError ? (
          <Loading label="公開版を読み込んでいます…" rows={4} />
        ) : headError && !head ? (
          <div className="alert error"><p>公開版を取得できませんでした。</p><Button onClick={() => setRefresh(r => r + 1)}>もう一度読み込む</Button></div>
        ) : !displayed ? (
          <p>{selectedId?"選択した公開版は表示できません。最新の公開版へ戻って確認してください。":"この月はまだ公開されていません。"}</p>
        ) : (
          <>
            {!current&&<p className="warning">当時の公開版を表示しています。現在の勤務ではありません。固定の操作・最新勤務の出力は「最新の公開版へ戻る」から行ってください。</p>}
            {current&&head.revalidationRequired && (
              <p className="alert warning">
                {head.revalidation &&
                  revalidationLabel(head.revalidation.status)}
                。表示は保存済みの公開勤務です。勤務時刻・休憩は維持されます。
              </p>
            )}
            {manager && current&&head.revalidation && (
              <PublicationRevalidation
                key={base + ":" + displayed.publicationId}
                base={base}
                publicationId={displayed.publicationId}
                summary={revalidationSummary.parse(head.revalidation)}
                revision={revision}
                originalValidation={displayed.validation}
                report={report}
                nameOf={nameOf}
                refresh={() => setRefresh((r) => r + 1)}
              />
            )}
            {manager && current&& (
              <p>
                <a href={"/api" + base + "/export?month=" + month}>
                  公開済み勤務のCSVをダウンロード
                </a>
              </p>
            )}
            {manager && <PublishedMonthly key={displayed.publicationId} publication={displayed} current={current}
              base={base} inputBase={inputBase} revision={revision} nameOf={nameOf} label={label} onStaff={id => onStaff?.(id)} />}
            {!manager && <div className="published-days">
              {shown.map((a) => (
                <article
                  className="published-day"
                  key={a.staffId + ":" + a.date}
                >
                  <strong>
                    {a.date}
                    {manager ? " ／ " + nameOf(a.staffId) : ""}
                  </strong>
                  <p>
                    {a.shift
                      ? `${clock(a.shift.start)}〜${clock(a.shift.end)} ／ 休憩 ${a.shift.break ? a.shift.break.map(clock).join("〜") : "なし"}`
                      : "休日"}
                  </p>
                  {a.shift && a.shift.cancelled.length > 0 && (
                    <p>
                      取消：
                      {a.shift.cancelled
                        .map((c) => c.map(clock).join("〜"))
                        .join("、")}
                    </p>
                  )}
                  {a.blocks.length > 0 && (
                    <details>
                      <summary>業務配置を見る</summary>
                      {a.blocks.map((b, i) => (
                        <p key={i}>
                          {clock(b.start)}〜{clock(b.end)}：
                          {(
                            { phone: "電話", supervision: "監督" } as Record<
                              string,
                              string
                            >
                          )[b.taskId] ?? b.taskId}
                          {b.roleId ? " ／ " + b.roleId : ""}
                        </p>
                      ))}
                      {a.roleIntervals?.map((r, i) => (
                        <p key={"r" + i}>
                          {clock(r.start)}〜{clock(r.end)}：{r.roleId}
                        </p>
                      ))}
                    </details>
                  )}
                </article>
              ))}
            </div>}
          </>
        )}
        {manager&&<PublicationHistory base={base} month={month} selectedId={displayed?.publicationId??null} onSelect={id=>{if(id!==selectedId)unsaved.navigate(()=>setSelectedId(id));}} report={report}/>}
      </CardContent>
    </Card>

    </>
  );
}
export function PublicationGuidance({
  view,
  navigationDisabled,
  inputStale,
  staleInfo,
  staffIds,
  nameOf,
  onHistory,
  onFix,
}: {
  view: ScheduleView;
  navigationDisabled: boolean;
  inputStale: boolean;
  staleInfo?: React.ReactNode;
  staffIds: readonly string[];
  nameOf: (id: string) => string;
  onHistory: (target?: HistoryTarget) => void;
  onFix: (target: PublicationFix) => void;
}) {
  const v = view.result.validation;
  const { blockers, ready } = publicationEligibility(view, inputStale);
  const issues = [...new Set(v.violations)].map(value => violationAdvice(value, staffIds));
  const missing = new Map<string, string[]>();
  const unknown: string[] = [];
  for (const value of new Set(v.missingHistory ?? [])) {
    const target = historyTarget(value);
    if (target) missing.set(target.staffId, [...(missing.get(target.staffId) ?? []), target.date]);
    else unknown.push(value);
  }
  if (ready) return null;
  return (
    <Alert className="alert warning publication-guidance" aria-label="公開前の確認と対応">
      <p><strong>この案は公開できません。</strong></p>
      <details className="publication-disclosure">
        <summary>公開できない理由・対応を確認</summary>
        {blockers.history && <section aria-label="履歴不足への対応">
          <h3>月境界の勤務履歴が不足しています</h3>
          <p>対象スタッフの勤務時間(分)と確認の根拠を「勤務履歴」で保存し、シフト画面に戻って再計算してください。確認済みの休日は0分、未確認の日は空欄にします。履歴の保存だけでは、この案は公開可能になりません。</p>
          <p className="muted">以下はこの案の計算時点で未確認だった履歴です。すでに登録済みの場合は、最新条件で再計算してください。</p>
          {!!missing.size && <ul className="publication-issues">
            {[...missing].map(([staffId, dates]) => <li key={staffId}>
              <strong>{nameOf(staffId)}</strong>
              <p>未確認の日付：{dates.sort().join("、")}</p>
              <Button type="button" disabled={navigationDisabled} aria-label={`${nameOf(staffId)}の勤務履歴を修正`}
                onClick={() => onHistory({ staffId, date: dates[0]! })}>このスタッフの勤務履歴を修正</Button>
            </li>)}
          </ul>}
          {(!missing.size || !!unknown.length) && <>
            <p>不足している対象を一部またはすべて特定できません。「勤務履歴」で最新の未確認日を確認してください。</p>
            {!!unknown.length && <p className="muted">確認情報：{unknown.join("、")}</p>}
            <Button type="button" disabled={navigationDisabled} onClick={() => onHistory()}>勤務履歴を確認</Button>
          </>}
        </section>}
        {blockers.invalid && <section aria-label="必須条件違反への対応">
          <h3>必須条件の違反を検出しました</h3>
          {issues.length ? <ul className="publication-issues">{issues.map(issue => {
            return <li key={issue.raw}>
              <strong>{issue.title}</strong>
              {(issue.staffId || issue.date) && <p>{issue.staffId && nameOf(issue.staffId)}{issue.date && ` ／ ${issue.date}`}</p>}
              <p>{issue.steps}</p>
              <p className="muted">確認コード：{issue.raw}</p>
              {issue.fix !== "recompute" && <Button type="button" disabled={navigationDisabled} onClick={() => onFix(issue.fix)}>{issue.button}</Button>}
            </li>;
          })}</ul> : <>
            <p>検証結果が違反ありのため公開できません。違反の詳細は取得できていないため、最新条件で再計算してください。</p>
          </>}
        </section>}
        {blockers.stale && <section aria-label="古い案への対応">
          <div className="stale-heading"><h3>入力条件または編集版が更新された古い案です</h3>{staleInfo}</div>
          <p>この案には最新の変更が反映されていません。最新条件で再計算してください。</p>
        </section>}
        {blockers.unverified && <section aria-label="未検証への対応">
          <h3>独立検証の完了を確認できません</h3>
          <p>検証状態：{v.status}。計算が完了しているか確認し、画面を再読み込みしてください。完了後も未検証の場合は再計算し、新しい案の検証結果を確認してください。</p>
        </section>}
      </details>
    </Alert>
  );
}

export function PublishConfirmation({ view, inputStale, disabled, onPublish }: {
  view: ScheduleView; inputStale: boolean; disabled: boolean; onPublish: (ack: boolean) => Promise<void>;
}) {
  const [ack, setAck] = useState(false), [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const { ready, shortage } = publicationEligibility(view, inputStale);
  return <>
    <p>公開時に現在の条件で再検証します。</p>
    {shortage && <label className="field">
      <span>必要人数・担当区分の不足が残っています。</span>
      <span><Input type="checkbox" checked={ack} disabled={disabled || sending}
        onChange={event => setAck(event.target.checked)} /> 不足を確認し、この案を公開する</span>
    </label>}
    <div className="form-actions"><Button className="primary" loading={sending}
      disabled={disabled || sending || !ready || (shortage && !ack)}
      onClick={async () => {
        if (submitting.current || disabled || !ready || (shortage && !ack)) return;
        submitting.current = true; setSending(true);
        try { await onPublish(ack); }
        finally { submitting.current = false; setSending(false); }
      }}>再検証して公開</Button></div>
  </>;
}
