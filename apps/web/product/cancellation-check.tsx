import { Button, Input, OperationBoundary } from "./components/ui";
import { useUnsavedInput, usePendingOperation } from "./unsaved-input";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, contextSchema } from "./api";
import { leaveContext, type LeaveRecord } from "../../api/src/leave-contract";
import {
  cancellationOwnerKey,
  readCancellationOwner,
  persistCancellationOwner,
  clearCancellationOwner,
} from "./cancellation-owner";
import {
  cancellationCheckCommand,
  cancellationCheckResult,
  type CancellationCheckResult,
  cancellationCommitCommand,
  cancellationCommitResult,
  cancellationInspection,
  type CancellationCommitCommand,
} from "../../api/src/cancellation-contract";

const explanations: Record<string, string> = {
  MONTHLY_HOURS: "月の勤務時間の上下限",
  MONTHLY_DAYS: "月の勤務日数の下限",
  MONTHLY_HOLIDAYS: "月の休日数の下限",
  BREAK_QUANTITY: "取消後の必要休憩量と公開休憩の不一致",
  WAITING: "残る勤務時間の業務未割当",
  EVENT_FULL_ATTENDANCE: "研修・会議への全時間参加",
  MINIMUM_CONTINUITY: "業務の最低継続時間",
  MINIMUM_RUN: "業務の最低継続時間",
  PREPARATION_INTERRUPTED: "準備・移動の連続区間",
};
export function CancellationCheck({
  base,
  company,
  record,
  report,
  committed,
}: {
  base: string;
  company: string;
  record: LeaveRecord;
  report: (error: unknown) => void;
  committed: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<CancellationCheckResult | null>(null);
  const controller = useRef<AbortController | null>(null),
    lock = useRef(false);
  const [acknowledge, setAcknowledge] = useState(false),
    [pending, setPending] = useState<CancellationCommitCommand | null>(null),
    [message, setMessage] = useState("");
  const unsaved = useUnsavedInput();
  usePendingOperation(busy || !!pending);
  const [ownerError, setOwnerError] = useState(false),
    ownerKey = cancellationOwnerKey(company, record.id);
  useEffect(() => {
    try {
      setPending(readCancellationOwner(sessionStorage, ownerKey));
    } catch (e) {
      setOwnerError(true);
      report(e);
    }
    return () => controller.current?.abort();
  }, [ownerKey]);
  useEffect(() => () => controller.current?.abort(), []);
  const check = async () => {
    if (lock.current || pending || ownerError) return;
    lock.current = true;
    setBusy(true);
    setResult(null);
    setAcknowledge(false);
    setMessage("");
    const c = new AbortController();
    controller.current = c;
    try {
      const [ctx, published] = await Promise.all([
        api("/context", contextSchema, undefined, c.signal),
        api(
          base + "/context?month=" + record.date.slice(0, 7),
          leaveContext,
          undefined,
          c.signal,
        ),
      ]);
      const revision = ctx.companies.find((x) => x.id === company)?.revision;
      if (revision === undefined || !published.publicationId)
        throw new Error("公開勤務を読み直してください。");
      const command = cancellationCheckCommand.parse({
        operationId: crypto.randomUUID(),
        expectedRevision: revision,
        expectedRequestRevision: record.requestRevision,
        publicationId: published.publicationId,
        expectedPublicationRevision: published.publicationRevision,
      });
      const checked = await api(
        base + "/" + record.id + "/cancellation-check",
        cancellationCheckResult,
        command,
        c.signal,
      );
      if (!c.signal.aborted) setResult(checked);
    } catch (e) {
      if (!c.signal.aborted) report(e);
    } finally {
      lock.current = false;
      if (!c.signal.aborted) setBusy(false);
    }
  };
  const commit = async () => {
    if (lock.current || pending || ownerError || !result) return;
    if (!await unsaved.allow()) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    const command = cancellationCommitCommand.parse({
      operationId: crypto.randomUUID(),
      expectedRevision: result.inputRevision,
      expectedRequestRevision: result.requestRevision,
      publicationId: result.publicationId,
      expectedPublicationRevision: result.publicationRevision,
      acknowledgeShortage: acknowledge,
    });
    let dispatched = false;
    try {
      persistCancellationOwner(sessionStorage, ownerKey, command);
      setPending(command);
      dispatched = true;
      const r = await api(
        base + "/" + record.id + "/cancellation-commit",
        cancellationCommitResult,
        command,
        controller.current?.signal,
      );
      assertReceipt(command, r);
      clearCancellationOwner(sessionStorage, ownerKey, command.operationId);
      setPending(null);
      setResult(null);
      await committed();
    } catch (e) {
      if (!dispatched) {
        setOwnerError(true);
        setMessage(
          "操作記録を保存できなかったため、確定要求は送信していません。",
        );
      } else if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        try {
          clearCancellationOwner(sessionStorage, ownerKey, command.operationId);
          setPending(null);
          setResult(null);
        } catch (storageError) {
          setOwnerError(true);
          report(storageError);
        }
      } else
        setMessage(
          "確定結果を確認できません。同じ操作の結果を確認してください。新しい確定操作は開始しません。",
        );
      report(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const inspect = async () => {
    if (lock.current || !pending) return;
    lock.current = true;
    setBusy(true);
    try {
      const observed = await api(
        base +
          "/" +
          record.id +
          "/cancellation-operations/" +
          pending.operationId,
        cancellationInspection,
        undefined,
        controller.current?.signal,
      );
      if (observed.found) {
        assertReceipt(pending, observed.result);
        clearCancellationOwner(sessionStorage, ownerKey, pending.operationId);
        setPending(null);
        setResult(null);
        await committed();
      } else
        setMessage(
          "確定記録はまだ確認できません。元の処理の停止・結果を確認するまで、再送せずこの操作を保留してください。",
        );
    } catch (e) {
      report(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const assertReceipt = (
    c: CancellationCommitCommand,
    r: import("zod").infer<typeof cancellationCommitResult>,
  ) => {
    if (
      r.operationId !== c.operationId ||
      r.publicationId !== c.operationId ||
      r.requestId !== record.id ||
      r.requestRevision !== c.expectedRequestRevision + 1 ||
      r.revision !== c.expectedRevision + 1 ||
      r.publicationRevision !== c.expectedPublicationRevision + 1 ||
      r.status !==
        (record.kind === "ABSENCE_FACT" ? "CANCELLATION_CONFIRMED" : "APPROVED")
    )
      throw new Error("確定結果の識別情報が一致しません。");
  };
  const valid =
    result?.validation.status === "VERIFIED" &&
    !result.validation.violations.length &&
    !result.validation.missingHistory.length;
  const shortage =
    !!result &&
    (result.validation.generalShortage > 0 ||
      result.validation.roleSameShortage > 0 ||
      result.validation.roleRequirements.some(
        (r) => r.shortagePersonMinutes > 0,
      ));
  const open = ["PENDING", "REPORTED"].includes(record.status);
  if (!open && !pending && !ownerError) return null;
  return <OperationBoundary busy={busy}>{(
    <section
      className="setup-row cancellation-check"
      aria-label="取消後の条件確認"
    >
      <p className="muted">
        {pending
          ? "送信した取消操作の結果を確認してください。確定済みの可能性があるため、新しい操作は開始しません。"
          : "公開済みの出退勤・休憩を保持して取消後の条件を確認します。この確認だけでは勤務取消・申請の承認は確定しません。"}
      </p>
      {open && (
        <div className="form-actions">
          <Button
            disabled={busy || !!pending || ownerError}
            onClick={() => void check()}
          >
            {busy ? "取消後の条件を検証しています…" : "取消後の条件を確認"}
          </Button>
        </div>
      )}
      {message && (
        <p className="alert warning" role="status">
          {message}
        </p>
      )}
      {pending && (
        <div className="form-actions">
          <Button disabled={busy} onClick={() => void inspect()}>
            同じ取消操作の確定結果を確認
          </Button>
        </div>
      )}
      {result && !pending && (
        <div
          className={
            "alert " +
            (result.validation.status === "VERIFIED" ? "info" : "warning")
          }
          role="status"
        >
          <strong>
            {result.validation.status === "VERIFIED"
              ? "確認した取消候補は検証済み・未確定"
              : result.validation.status === "HISTORY_UNVERIFIED"
                ? "履歴不足のため取消確定不可"
                : "取消候補に必須条件の違反があります"}
          </strong>
          <p>
            入力版{result.inputRevision}・公開版{result.publicationRevision}
            での確認です。確定前に最新条件で再検証します。
          </p>
          {result.validation.violations.length > 0 && (
            <ul>
              {result.validation.violations.slice(0, 10).map((v) => (
                <li key={v}>{explanations[v.split(":")[0]] ?? v}</li>
              ))}
            </ul>
          )}
          {result.validation.missingHistory.length > 0 && (
            <p>未確認の履歴：{result.validation.missingHistory.length}件</p>
          )}
          {result.validation.violations.some((v) => v.split(":")[0] === "WAITING") && (
            <p>
              残る勤務に未割当があるため、取消を確定できません。管理者が先に予定参加と業務配置を整えて公開し、この申請の「取消後の条件を確認」を再実行してください。
            </p>
          )}
          <p>
            取消に伴う参加解除の対象：{result.removedParticipations.length}件
          </p>
          <p>
            一般不足 {result.validation.generalShortage / result.capacityScale}{" "}
            ／ 同段階の担当区分不足{" "}
            {result.validation.roleSameShortage / result.capacityScale}
            （人・分）
          </p>
          <p>公開勤務と受付状態は変更していません。</p>
          {result.validation.roleRequirements.some(
            (r) => r.shortagePersonMinutes > 0,
          ) && (
            <ul>
              {result.validation.roleRequirements
                .filter((r) => r.shortagePersonMinutes > 0)
                .map((r) => (
                  <li key={r.id}>
                    担当区分の条件 {r.id} の不足：{r.shortagePersonMinutes} 人・分
                  </li>
                ))}
            </ul>
          )}
          {valid && (
            <div className="form-actions">
              {shortage && (
                <label>
                  <Input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(e) => setAcknowledge(e.target.checked)}
                    disabled={busy || !!pending}
                  />
                  必要人数・担当区分の不足を確認し、この取消を確定する
                </label>
              )}
              <Button
                disabled={
                  busy || !!pending || ownerError || (shortage && !acknowledge)
                }
                onClick={() => void commit()}
              >
                {busy
                  ? "最新条件を再検証して確定しています…"
                  : record.status === "REPORTED"
                    ? "欠勤取消を確定"
                    : "申請を承認して勤務取消を確定"}
              </Button>
              <p className="muted">
                確定すると公開勤務と参加解除へ即時反映します。その後の業務再配置と公開は別の管理者操作です。
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  )}</OperationBoundary>;
}
