import { Button, Loading, OperationBoundary, Spinner } from "./components/ui";
import React, { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api } from "./api";
import type { publicationValidation } from "../../api/src/checker-contract";
import { violationText } from "./draft-model";
import {
  revalidationCertificate,
  revalidationSummary,
} from "../../api/src/revalidation-contract";
const detail = z.object({
  certificate: revalidationCertificate,
  adopted: z.boolean(),
});
const labels: Record<string, string> = {
  ORIGINAL_VERIFIED: "公開時の条件で検証済み",
  PENDING: "最新条件での再検証待ち",
  RUNNING: "最新条件で再検証中",
  FAILED: "再検証処理に失敗",
  VERIFIED: "最新の適用条件で検証済み",
  HISTORY_UNVERIFIED: "履歴不足・未検証",
  INVALID: "最新条件に必須条件違反あり",
  INPUT_INVALID: "現在の条件に不整合あり",
  PROCESS_INTERRUPTED: "処理が中断されました",
};
export const revalidationLabel = (status: string) => labels[status] ?? status;
export function PublicationRevalidation({
  base,
  publicationId,
  summary,
  revision,
  report,
  refresh,
  nameOf,
  originalValidation,
}: {
  base: string;
  publicationId: string;
  summary: z.infer<typeof revalidationSummary>;
  revision: number;
  report: (e: unknown) => void;
  refresh: () => void;
  nameOf: (id: string) => string;
  originalValidation?: z.infer<typeof publicationValidation>;
}) {
  const [sending, setSending] = useState(false);
  const id = ["PENDING", "RUNNING"].includes(summary.status) ? null : summary.validationId;
  const certificateKey = JSON.stringify([base, publicationId, id, summary.status, summary.inputRevision, summary.requiredRevision, summary.attempt]);
  const certificateRead = useValidationRead(id ? base + "/validations/" + id : null, detail, certificateKey, report);
  const raw = certificateRead.data;
  const certificateMatches = !raw || raw.adopted && raw.certificate.id === id && raw.certificate.publicationId === publicationId
    && raw.certificate.requiredRevision === summary.requiredRevision && raw.certificate.inputRevision === summary.inputRevision
    && raw.certificate.status === summary.status;
  const certificate = certificateMatches ? raw?.certificate : undefined;
  const retry = useRef<{
    key: string;
    command: { operationId: string; expectedRevision: number; expectedAttempt: number; requiredRevision: number };
  } | null>(null);
  async function redeliver() {
    if (!summary.requestId) return;
    const key = [
      summary.requestId,
      summary.attempt,
      summary.requiredRevision,
      revision,
    ].join(":");
    if (retry.current?.key !== key)
      retry.current = {
        key,
        command: {
          operationId: crypto.randomUUID(),
          expectedRevision: revision,
          expectedAttempt: summary.attempt,
          requiredRevision: summary.requiredRevision,
        },
      };
    setSending(true);
    try {
      await api(
        base + "/revalidation/" + summary.requestId + "/retry",
        z.object({ queued: z.literal(true), replayed: z.boolean() }),
        retry.current.command,
      );
      refresh();
    } catch (e) {
      report(e);
    } finally {
      setSending(false);
    }
  }
  const v = summary.status === "ORIGINAL_VERIFIED" ? originalValidation : certificate?.validation;
  const good = ["VERIFIED", "ORIGINAL_VERIFIED"].includes(summary.status);
  const waiting = ["PENDING", "RUNNING"].includes(summary.status);
  const unavailable = waiting ? "再検証の完了待ち" : certificateRead.error || !certificateMatches ? "検証記録を取得できません" : "検証結果を取得できていません";
  function shortageTile(title: string, amount: unknown) {
    const available = typeof amount === "number" && Number.isFinite(amount) && amount >= 0;
    return <div className={"validation-tile " + (certificateRead.loading ? "validation-neutral" : available && amount === 0 ? "validation-good" : "validation-danger")}>
      <span>{title}</span><strong>{certificateRead.loading ? "読込中…" : available ? `${amount}人分・分` : unavailable}</strong>
    </div>;
  }
  return <OperationBoundary busy={sending}>
    <section className="publication-validation" aria-label="現在の公開版の判定">
      <h3>現在の公開版の判定</h3>
      <div className="validation-tiles">
        <div className={"validation-tile " + (good ? "validation-good" : "validation-danger")}>
          <span>検証状態</span><strong role="status">{waiting && <Spinner />}{revalidationLabel(summary.status)}</strong>
        </div>
        {shortageTile("一般業務不足", v?.generalShortage)}
        {shortageTile("同段階の担当区分不足", v?.roleSameShortage)}
      </div>
      {certificateRead.loading && <Loading label="検証記録を読み込んでいます…" compact />}
      {(certificateRead.error || !certificateMatches) && <div role="alert"><p className="error">検証記録を取得できませんでした。</p><Button onClick={certificateRead.retry}>検証記録を再読込</Button></div>}
      {summary.status === "FAILED" && <Button type="button" disabled={sending} onClick={() => void redeliver()}>再検証を再試行</Button>}
      {v?.violations.length ? <ul className="error">{v.violations.map((reason, i) => <li key={i}>
        {violationText(reason.split(":").slice(0, 2).concat(reason.split(":").slice(2, 3).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))).join(":"), nameOf)}
      </li>)}</ul> : null}
      {Array.isArray(v?.missingHistory) && v.missingHistory.length > 0 && <p className="warning">未確認履歴：{v.missingHistory.map(value => {
        const [staff, date] = String(value).split(":"); return `${nameOf(staff)} ${date ?? ""}`;
      }).join("、")}</p>}
      {certificate?.failureCode && <p>処理結果：{certificate.failureCode}</p>}
    </section>
  </OperationBoundary>;
}

// State belongs to an explicit resource key: old responses and old errors must
// never become the current publication's record during polling or selection.
function useValidationRead<T>(path: string | null, schema: z.ZodType<T>, key: string, report: (error: unknown) => void) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; data?: T; loading: boolean; error: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!path) { setState({ key, loading: false, error: false }); return; }
    setState({ key, loading: true, error: false });
    void api(path, schema, undefined, controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ key, data, loading: false, error: false });
    }).catch(error => {
      if (!controller.signal.aborted) { setState({ key, loading: false, error: true }); report(error); }
    });
    return () => controller.abort();
    // Schemas are module constants; report must not restart reads on rerender.
  }, [path, key, attempt]);
  const current = state?.key === key ? state : null;
  return { data: current?.data, loading: !!path && (!current || current.loading), error: !!current?.error, retry: () => setAttempt(value => value + 1) };
}
