import { Alert, Badge, Button, Card, CardContent, CardHeader, Loading, NativeSelect, OperationBoundary, Textarea, useNotification } from "./components/ui";
import { UnsavedForm, useUnsavedInput, usePendingOperation } from "./unsaved-input";
import React, { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api, ApiError } from "./api";
import { Field } from "./contract-forms";
import { CancellationCheck } from "./cancellation-check";
import {
  leaveContext,
  leaveList,
  leaveSubmission,
  leaveRejection,
  leaveCursor,
  requestedWork,
  type LeaveRecord,
} from "../../api/src/leave-contract";

const statusLabel = {
  PENDING: "申請受付・承認待ち",
  REPORTED: "欠勤事実を記録・取消未確定",
  REJECTED: "却下",
  APPROVED: "承認・勤務取消を反映済み",
  CANCELLATION_CONFIRMED: "欠勤取消を確定・反映済み",
};
const kindLabel = {
  LEAVE_REQUEST: "休暇申請",
  ABSENCE_REQUEST: "欠勤申請",
  ABSENCE_FACT: "欠勤事実",
};
const partLabel = { FULL: "全日", AM: "午前", PM: "午後" };
const receipt = z.object({
  requestId: z.string().uuid(),
  requestRevision: z.number().int(),
  status: z.string(),
  replayed: z.boolean(),
});
const inbox = z.object({
  notices: z.array(
    z.object({
      id: z.string().uuid(),
      requestId: z.string().uuid(),
      kind: z.enum([
        "RECEIVED",
        "REJECTED",
        "APPROVED",
        "CANCELLATION_CONFIRMED",
      ]),
      recordedAt: z.number(),
      readAt: z.number().nullable(),
      date: z.string(),
      part: leaveSubmission.shape.part,
      requestKind: leaveSubmission.shape.kind,
      decisionReason: z.string().nullable(),
    }),
  ),
  nextCursor: leaveCursor.nullable(),
});
const clock = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const pageQuery = (c: z.infer<typeof leaveCursor> | null) =>
  c ? `&cursorTime=${c.recordedAt}&cursorId=${encodeURIComponent(c.id)}` : "";
type Pending = {
  path: string;
  body: z.infer<typeof leaveSubmission> | z.infer<typeof leaveRejection>;
};

export function LeaveManagement({
  base,
  company,
  month,
  manager,
  self,
  report,
  changed,
}: {
  base: string;
  company: string;
  month: string;
  manager: boolean;
  self: string | null;
  report: (e: unknown) => void;
  changed: () => Promise<void>;
}) {
  const [context, setContext] = useState<z.infer<typeof leaveContext> | null>(
      null,
    ),
    [records, setRecords] = useState<LeaveRecord[]>([]),
    [next, setNext] = useState<z.infer<typeof leaveCursor> | null>(null);
  const [notices, setNotices] = useState<z.infer<typeof inbox>["notices"]>([]),
    [noticeNext, setNoticeNext] = useState<z.infer<typeof leaveCursor> | null>(
      null,
    );
  const [kind, setKind] = useState<z.infer<typeof leaveSubmission.shape.kind>>(
      manager ? "ABSENCE_FACT" : "LEAVE_REQUEST",
    ),
    [staff, setStaff] = useState(self ?? ""),
    [date, setDate] = useState(""),
    [part, setPart] =
      useState<z.infer<typeof leaveSubmission.shape.part>>("FULL"),
    [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Pending | null>(null),
    [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(false);
  useNotification(message);
  const unsaved = useUnsavedInput();
  usePendingOperation(busy || !!pending);
  const submissionFingerprint = JSON.stringify([kind, staff, date, part, reason]);
  const savedSubmission = useRef(submissionFingerprint);
  const mounted = useRef(true),
    lock = useRef(false),
    request = useRef<AbortController | null>(null);
  const load = async (signal?: AbortSignal) => {
    setLoading(true); setLoadError(false);
    try {
    const [c, r, n] = await Promise.all([
      api(base + "/context?month=" + month, leaveContext, undefined, signal),
      api(base + "?month=" + month, leaveList, undefined, signal),
      api(base + "/notices", inbox, undefined, signal),
    ]);
    if (!mounted.current || signal?.aborted) return;
    setContext(c);
    setRecords(r.records);
    setNext(r.nextCursor);
    setNotices(n.notices);
    setNoticeNext(n.nextCursor);
    } catch (e) { if (!signal?.aborted) setLoadError(true); throw e; }
    finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    request.current = controller;
    void load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) report(e);
    });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [base, month]);
  const run = async (action: Pending) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setPending(action);
    setMessage("");
    try {
      const accepted = await api(
        action.path,
        receipt,
        action.body,
        request.current?.signal,
      );
      if (!mounted.current) return;
      setPending(null);
      if (action.path === base) {
        savedSubmission.current = JSON.stringify([kind, staff, date, part, ""]);
        setReason("");
      }
      setMessage(
        accepted.status === "REJECTED"
          ? "理由を記録して却下しました。公開勤務は変更していません。"
          : accepted.status === "REPORTED"
            ? "欠勤事実を記録しました。勤務取消は未確定です。"
            : "申請を受け付けました。承認までは公開勤務を維持します。",
      );
      await load(request.current?.signal);
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiError && e.status >= 400 && e.status < 500)
        setPending(null);
      report(e);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    selected = kind === "ABSENCE_FACT" ? staff : self;
  const eligible =
    context?.assignments.filter(
      (a) =>
        a.staffId === selected && (kind !== "ABSENCE_FACT" || a.date <= today),
    ) ?? [];
  const assignment = eligible.find((a) => a.date === date),
    interval = requestedWork(
      assignment?.shift ?? null,
      part,
      context?.halfDayDivider ?? null,
    );
  return <OperationBoundary busy={busy}>{(
    <>
      <Card className="panel" aria-labelledby="leave-heading">
        <CardHeader className="panel-header">
          <h2 id="leave-heading">
            {manager ? "休暇・欠勤の受付" : "休暇・欠勤を申請"}
          </h2>
          <Button
            type="button"
            disabled={busy || !!pending}
            onClick={() => unsaved.navigate(() => { void load(request.current?.signal).catch(report); })}
          >
            最新の受付を読み直す
          </Button>
        </CardHeader>
        <CardContent className="panel-body">
          <p className="form-intro">
            申請・欠勤事実の受付と勤務取消の確定を分けて記録します。管理者は固定を解除し、取消後の条件を検証してから承認・取消を確定します。
          </p>
          {loading && <Loading label="受付と勤務条件を読み込んでいます…" compact={!!context} />}
          {loadError && <p className="error" role="alert">受付を取得できませんでした。再読込してください。</p>}
          {pending && (
            <Alert className="alert">
              <p>
                応答を確認できていない操作があります。内容を変えず、同じ操作の結果を確認してください。
              </p>
              <Button disabled={busy} onClick={() => void run(pending)}>
                同じ受付・却下操作を確認
              </Button>
            </Alert>
          )}
          {!context ? (
            loadError ? <p className="error">受付条件を取得できませんでした。</p> : null
          ) : !context.publicationId ? (
            <p className="muted">
              対象月の公開勤務がありません。公開後に申請できます。
            </p>
          ) : (
            <UnsavedForm dirty={submissionFingerprint !== savedSubmission.current}
              onSubmit={(e) => {
                e.preventDefault();
                if (!selected || !context.publicationId || !interval) return;
                try {
                  const body = leaveSubmission.parse({
                    operationId: crypto.randomUUID(),
                    staffId: selected,
                    date,
                    kind,
                    part,
                    reason,
                    publicationId: context.publicationId,
                    expectedPublicationRevision: context.publicationRevision,
                  });
                  void run({ path: base, body });
                } catch (e) {
                  report(e);
                }
              }}
            >
              <fieldset disabled={busy || !!pending}>
                <div className="form-grid">
                  <Field title="受付の種類">
                    <NativeSelect
                      value={kind}
                      onChange={(e) => {
                        setKind(
                          leaveSubmission.shape.kind.parse(e.target.value),
                        );
                        setDate("");
                      }}
                    >
                      {self && (
                        <>
                          <option value="LEAVE_REQUEST">自分の休暇申請</option>
                          <option value="ABSENCE_REQUEST">
                            自分の欠勤申請
                          </option>
                        </>
                      )}
                      {manager && (
                        <option value="ABSENCE_FACT">欠勤事実の直接登録</option>
                      )}
                    </NativeSelect>
                  </Field>
                  {kind === "ABSENCE_FACT" && (
                    <Field title="欠勤したスタッフ">
                      <NativeSelect
                        value={staff}
                        onChange={(e) => {
                          setStaff(e.target.value);
                          setDate("");
                        }}
                        required
                      >
                        <option value="">スタッフを選択</option>
                        {context.staff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}（{s.staffNumber}）
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  )}
                  <Field title="対象の公開勤務">
                    <NativeSelect
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      required
                    >
                      <option value="">勤務日を選択</option>
                      {eligible.map((a) => (
                        <option key={a.date} value={a.date}>
                          {a.date} {clock(a.shift!.start)}〜
                          {clock(a.shift!.end)}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field title="対象範囲">
                    <NativeSelect
                      value={part}
                      onChange={(e) =>
                        setPart(
                          leaveSubmission.shape.part.parse(e.target.value),
                        )
                      }
                    >
                      {Object.entries(partLabel).map(([v, n]) => (
                        <option key={v} value={v}>
                          {n}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
                <p className="muted">
                  半日の区切り：
                  {context.halfDayDivider === null
                    ? "未設定"
                    : clock(context.halfDayDivider)}
                  。
                  {interval
                    ? `対象 ${clock(interval.start)}〜${clock(interval.end)}`
                    : "対象範囲に残る勤務がある日を選択してください。"}
                </p>
                <Field title="申請・記録の理由">
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    required
                    maxLength={1000}
                    rows={3}
                  />
                </Field>
                <div className="form-actions">
                  <Button
                    className="primary"
                    disabled={!interval || !selected || !reason.trim()}
                  >
                    {kind === "ABSENCE_FACT" ? "欠勤事実を記録" : "申請を送信"}
                  </Button>
                </div>
              </fieldset>
            </UnsavedForm>
          )}
        </CardContent>
      </Card>
      <Card className="panel" aria-labelledby="leave-history-heading">
        <h2 id="leave-history-heading">
          {manager ? "チームの受付履歴" : "自分の受付履歴"}
        </h2>
        <CardContent className="panel-body">
          {!loading && !loadError && !records.length && (
            <p className="muted">対象月の受付はありません。</p>
          )}
          <div className="published-days leave-records">
            {records.map((r) => (
              <article className="published-day" key={r.id}>
                <h4>
                  {r.date} · {partLabel[r.part]} · {kindLabel[r.kind]}
                </h4>
                {manager && (
                  <p>
                    {r.staffName}（{r.staffNumber}）
                  </p>
                )}
                <p>
                  <Badge className={"status-badge " + r.status.toLowerCase()}>
                    {statusLabel[r.status]}
                  </Badge>
                </p>
                <p>{r.reason}</p>
                <p className="muted">
                  申請・記録時の公開版 {r.publicationRevision} · 対象{" "}
                  {clock(r.start)}〜{clock(r.end)}
                </p>
                <p className="muted">
                  受付日時：
                  {new Date(r.recordedAt).toLocaleString("ja-JP", {
                    timeZone: "Asia/Tokyo",
                  })}
                </p>
                {r.decisionReason && <p>却下理由：{r.decisionReason}</p>}
                {manager && (
                  <CancellationCheck
                    base={base}
                    company={company}
                    record={r}
                    report={report}
                    committed={async () => {
                      setMessage(
                        "勤務取消と参加解除を公開勤務へ反映しました。業務再配置とその公開は別の管理者操作です。",
                      );
                      await load(request.current?.signal);
                      await changed();
                    }}
                  />
                )}
                {manager && r.status === "PENDING" && (
                  <UnsavedForm
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      try {
                        void run({
                          path: base + "/" + r.id + "/reject",
                          body: leaveRejection.parse({
                            operationId: crypto.randomUUID(),
                            expectedRequestRevision: r.requestRevision,
                            reason: f.get("reason"),
                          }),
                        });
                      } catch (e) {
                        report(e);
                      }
                    }}
                  >
                    <fieldset disabled={busy || !!pending}>
                      <Field title="却下理由">
                        <Textarea
                          name="reason"
                          required
                          maxLength={1000}
                          rows={2}
                        />
                      </Field>
                      <div className="form-actions">
                        <Button>理由を記録して却下</Button>
                      </div>
                    </fieldset>
                  </UnsavedForm>
                )}
              </article>
            ))}
          </div>
          {next && (
            <div className="form-actions">
              <Button
                disabled={busy || !!pending}
                onClick={() => {
                  if (lock.current) return;
                  lock.current = true;
                  setBusy(true);
                  void api(
                    base + "?month=" + month + pageQuery(next),
                    leaveList,
                    undefined,
                    request.current?.signal,
                  )
                    .then((r) => {
                      if (mounted.current) {
                        setRecords((old) => [
                          ...old,
                          ...r.records.filter(
                            (n) => !old.some((o) => o.id === n.id),
                          ),
                        ]);
                        setNext(r.nextCursor);
                      }
                    })
                    .catch((e) => {
                      if (mounted.current) report(e);
                    })
                    .finally(() => {
                      lock.current = false;
                      if (mounted.current) setBusy(false);
                    });
                }}
              >
                続きの受付履歴を表示
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      {(!!notices.length || noticeNext) && (
        <Card className="panel" aria-labelledby="leave-notices-heading">
          <h2 id="leave-notices-heading">自分への受付・結果のお知らせ</h2>
          <CardContent className="panel-body">
            {notices.map((n) => (
              <div className="notice-card" key={n.id}>
                <p>
                  {n.date} {partLabel[n.part]} {kindLabel[n.requestKind]}：
                  {n.kind === "REJECTED"
                    ? "却下しました"
                    : n.kind === "APPROVED"
                      ? "承認し、勤務取消を反映しました"
                      : n.kind === "CANCELLATION_CONFIRMED"
                        ? "欠勤取消を確定し、公開勤務へ反映しました"
                        : "受け付けました（受付時点では勤務取消は未確定）"}
                </p>
                <p className="muted">通知日時：{new Date(n.recordedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}</p>
                {n.decisionReason && <p>{n.decisionReason}</p>}
                {n.readAt === null ? (
                  <Button
                    disabled={busy || !!pending}
                    onClick={() => {
                      if (lock.current) return;
                      lock.current = true;
                      setBusy(true);
                      void api(
                        base + "/notices/" + n.id + "/read",
                        z.object({ read: z.boolean() }),
                        {},
                        request.current?.signal,
                      )
                        .then(() => load(request.current?.signal))
                        .catch((e) => {
                          if (mounted.current) report(e);
                        })
                        .finally(() => {
                          lock.current = false;
                          if (mounted.current) setBusy(false);
                        });
                    }}
                  >
                    既読にする
                  </Button>
                ) : (
                  <span className="muted">既読</span>
                )}
              </div>
            ))}
            {noticeNext && (
              <div className="form-actions">
                <Button
                  disabled={busy || !!pending}
                  onClick={() => {
                    if (lock.current) return;
                    lock.current = true;
                    setBusy(true);
                    void api(
                      base + "/notices?" + pageQuery(noticeNext).slice(1),
                      inbox,
                      undefined,
                      request.current?.signal,
                    )
                      .then((n) => {
                        if (mounted.current) {
                          setNotices((old) => [
                            ...old,
                            ...n.notices.filter(
                              (x) => !old.some((o) => o.id === x.id),
                            ),
                          ]);
                          setNoticeNext(n.nextCursor);
                        }
                      })
                      .catch((e) => {
                        if (mounted.current) report(e);
                      })
                      .finally(() => {
                        lock.current = false;
                        if (mounted.current) setBusy(false);
                      });
                  }}
                >
                  続きのお知らせを表示
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  )}</OperationBoundary>;
}
