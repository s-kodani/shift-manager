import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, CircleDashed } from "lucide-react";
import { api } from "./api";
import { Button, Card, CardContent, Loading } from "./components/ui";
import { readinessLabels, readinessResponse, readinessBlocksCompute, type Readiness, type ReadinessItem } from "../../api/src/readiness-contract";

export function useReadiness({ company, team, month, revision, draftRevision, enabled, view, report }: {
  company: string; team: string; month: string; revision: number; draftRevision: number; enabled: boolean; view?: string;
  report: (error: unknown) => void;
}) {
  const key = JSON.stringify([company, team, month, revision, draftRevision]);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; status: "loading" | "ready" | "error"; data?: Readiness; message?: string } | null>(null);
  useEffect(() => {
    if (!enabled) { setState(null); return; }
    const controller = new AbortController();
    setState(old => ({ key, status: "loading", data: old?.key === key ? old.data : undefined }));
    void api(`/companies/${company}/inputs/teams/${team}/readiness/${month}`, readinessResponse, undefined, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        if (data.companyId !== company || data.teamId !== team || data.month !== month || data.inputRevision !== revision || data.draftRevision !== draftRevision) {
          setState({ key, status: "error", message: "入力または編集の版が変わっています。最新の条件を読み直して再確認してください。" }); return;
        }
        setState({ key, status: "ready", data });
      }).catch(error => {
        if (controller.signal.aborted) return;
        setState({ key, status: "error", message: "準備状況を確認できませんでした。最新の条件を読み直して再確認してください。" });
        report(error);
      });
    return () => controller.abort();
    // report is owned by Workspace; do not restart requests on every render.
  }, [key, enabled, retry, view]);
  useEffect(() => {
    if (!enabled) return;
    const recheck = () => { if (document.visibilityState === "visible") setRetry(value => value + 1); };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [enabled]);
  const current = enabled && state?.key === key ? state : null;
  return {
    data: current?.data,
    loading: !current || current.status === "loading",
    error: current?.status === "error" ? current.message : undefined,
    canCompute: current?.status === "ready" && current.data?.canCompute === true,
    recheck: () => {
      setState(old => old?.key === key ? { ...old, status: "loading" } : null);
      setRetry(value => value + 1);
    },
  };
}

const statusLabels = { complete: "完了", missing: "未設定", invalid: "要修正", unconfirmed: "未確認", warning: "警告" };
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export function ReadinessPanel({ data, loading, error, teamSelected, companyAdmin, disabled, navigate, refresh }: {
  data?: Readiness; loading: boolean; error?: string; teamSelected: boolean; companyAdmin: boolean; disabled: boolean;
  navigate: (section: ReadinessItem["section"]) => void; refresh: () => void;
}) {
  const requiredRemaining = data?.items.filter(readinessBlocksCompute).length ?? 0;
  const warnings = data?.items.filter(item => item.status === "warning").length ?? 0;
  const renderItem = (item: ReadinessItem) => <li key={item.id} className="readiness-item">
    <div className="readiness-item-copy">
      <div className="readiness-item-title">
        {item.status === "complete" ? <CheckCircle2 aria-hidden="true" /> : item.status === "unconfirmed" ? <CircleDashed aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
        <strong>{readinessLabels[item.id]}</strong>
        <span className="status-badge">{statusLabels[item.status]}</span>
        {(!item.required || item.status === "warning") && <span className="muted">計算を妨げません</span>}
      </div>
      <p>{item.message}</p>
      {!!item.demandCoverage?.missingSlots && <div className="readiness-demand-examples">
        <p>未登録の需要枠（先頭{item.demandCoverage.examples.length}件／全{item.demandCoverage.missingSlots}件）</p>
        <ul>{item.demandCoverage.examples.map(slot => <li key={`${slot.date}:${slot.start}:${slot.taskId}`}>
          {slot.date} {clock(slot.start)}〜{clock(slot.end)} ／ 業務：{slot.taskId}
        </li>)}</ul>
      </div>}
      {item.code && <p className="muted">確認コード：{item.code}</p>}
      {item.section === "company" && !companyAdmin && item.status !== "complete" && <p>企業管理者に設定を依頼してください。</p>}
    </div>
    {!(item.section === "company" && !companyAdmin) && <Button type="button" disabled={disabled || loading}
      aria-label={`${readinessLabels[item.id]}の設定を確認`}
      onClick={() => item.section === "schedule" ? refresh() : navigate(item.section)}>設定を確認</Button>}
  </li>;
  return <Card className="panel readiness-panel" aria-label="シフト計算の準備" aria-busy={teamSelected && loading || undefined}>
    <h2>シフト計算の準備</h2>
    <CardContent className="panel-body">
      {!teamSelected ? <>
        <p>計算するチームを選択してください。チームがない場合は、企業管理者が登録してください。</p>
        {companyAdmin && <Button disabled={disabled} onClick={() => navigate("company")}>チームの登録へ</Button>}
      </> : <>
        <p role="status" className="readiness-summary">{error ? "準備状況は未確認です。" : loading ? "準備状況を確認しています…" : requiredRemaining ? `計算前に対応が必要な項目が${requiredRemaining}件あります。` : warnings ? `警告が${warnings}件あります。内容を確認のうえ計算できます。` : "計算を開始できます。"}</p>
        <p className="muted">保存済みの条件を確認します。有効な案が生成されることや、公開可能であることを保証する表示ではありません。</p>
        {error && <p role="alert" className="alert error">{error}</p>}
        {loading && <Loading label={data ? "最新の準備状況を再確認しています…" : "必要な設定を確認しています…"} rows={3} compact={!!data} />}
        {data && <div aria-label={loading ? "前回の確認結果" : "準備チェック結果"}>
          {loading && <p className="muted">以下は前回の確認結果です。再確認中は新しい計算を開始できません。</p>}
          <ul className="readiness-list">{data.items.map(renderItem)}</ul>
        </div>}
        <div className="form-actions"><Button type="button" disabled={disabled || loading} onClick={refresh}>最新の条件で再確認</Button></div>
      </>}
    </CardContent>
  </Card>;
}
