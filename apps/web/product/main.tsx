import { Field, Alert, Button, Card, CardContent, ConfirmationProvider, Input, Loading, NativeSelect, OperationBoundary, Spinner, Table, TableCell, TableHead, Toaster, useNotification } from "./components/ui";
import { CircleCheck, CircleHelp, CircleX, TriangleAlert } from "lucide-react";
import { UnsavedInputProvider, UnsavedForm, useUnsavedInput, usePendingOperation } from "./unsaved-input";
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { InputChanges } from "./input-changes";
import { z } from "zod";
import {
  api,
  ApiError,
  accepted,
  contextSchema,
  staffSchema,
  identitySchema,
  jobSchema,
  resultSchema,
  frozenSchema,
  snapshotResult,
  mutationResult,
  teamConfig,
  planning,
  companyPolicy,
  type Context,
  type Job,
  type Result,
  type Frozen,
  type Staff,
  draftHeadSchema,
  type DraftHead,
  type ScheduleView,
} from "./api";
import { ScheduleActionDialog } from "./schedule-action-dialog";
import { SolverResultHelp } from "./solver-result-help";
import { ScheduleDetailDialog, StaffDayDetails, DailySchedule } from "./schedule-detail-dialog";
import {MonthlyTable} from './monthly-table';
import {indexStaffNames} from './monthly-index';
import { DraftEditor } from "./draft-editor";
import { violationText, type EditingDraft } from "./draft-model";
import "./style.css";
import { ContractManagement } from "./contract-forms";
import { StaffCsvImport } from "./staff-csv";
import { StaffActions } from "./staff-actions";
import { StaffScheduleDialog, type PublishedScheduleSource } from "./staff-schedule-dialog";
import { publicationBlockers, publicationEligibility } from "./publication-guidance";
import { InfoHelp } from "./components/ui/info-help";
import { ReadinessPanel, useReadiness } from "./readiness";
import { staffCsvResponse } from "../../api/src/staff-csv-contract";
import { PlanningManagement } from "./planning-forms";
import { PublicationView, PublicationGuidance, PublishConfirmation } from "./publication-view";
import type { HistoryTarget } from "./publication-guidance";
import { HistoryManagement } from "./history-forms";
import { LeaveManagement } from "./leave-management";
import { StaffSubmission } from './staff-submission';
import { ExplanationView } from './explanation-view';
import {
  demandCsvReceipt,
  type DemandCsvReceipt,
} from "../../api/src/demand-csv-contract";
import { DemandCsvResult } from "./demand-csv";
import {
  TeamSettings,
  PolicySettings,
  TeamCreation,
  CalendarSettings,
  calendarSettings,
  type Calendar,
} from "./setup-forms";

const active = (job: Job) =>
  ["QUEUED", "RUNNING", "CANCELLING"].includes(job.state);
const labels: Record<string, string> = {
  QUEUED: "計算待ち",
  RUNNING: "計算中",
  CANCELLING: "取消処理中",
  SUCCEEDED: "計算完了",
  NO_SOLUTION: "案なし",
  STALE: "入力が変更されています",
  FAILED: "計算失敗",
  CANCELLED: "取消済み",
  OPTIMAL: "最良値を確認済み",
  FEASIBLE: "有効案あり・最良値は未証明",
  INFEASIBLE: "解なしを証明",
  UNKNOWN: "探索内で案を発見できませんでした",
  MODEL_INVALID: "モデルの検査に失敗",
  HISTORY_UNVERIFIED: "履歴不足・参考案",
  VERIFIED: "対象条件の検証済み",
  NOT_RUN: "検証未実行",
  INVALID: "制約違反",
  phone: "電話",
  supervision: "監督",
  day: "日勤",
  sv: "SV",
};
const label = (value: string) => Object.hasOwn(labels, value) ? labels[value] : value;
const time = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
}).format(new Date());
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="panel">
      <h2>{title}</h2>
      <CardContent className="panel-body">{children}</CardContent>
    </Card>
  );
}
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <header className="brand">
        <img className="brand-mark" src="/app-assets/assets/app-icon-192.png" alt="" width="32" height="32" /> シフト管理
      </header>
      <main className="auth-card">{children}</main>
    </div>
  );
}
function Auth({ changed }: { changed: () => void }) {
  const [mode, setMode] = useState<"login" | "reset" | "change">("login"),
    [session, setSession] = useState<"checking" | "ready" | "failed">("checking"),
    [checkAttempt, setCheckAttempt] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api("/access", identitySchema, undefined, controller.signal)
      .then((i) => {
        if (controller.signal.aborted) return;
        if (i.mustChange) {
          setMode("change");
          setSession("ready");
        } else changed();
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.code === "UNAUTHENTICATED") {
          setSession("ready");
        } else if (e instanceof ApiError && e.code === "USER_DISABLED") {
          setError(e.message);
          setSession("ready");
        } else {
          setError(e instanceof Error ? e.message : "通信状態を確認してください。");
          setSession("failed");
        }
      });
    return () => controller.abort();
  }, [checkAttempt]);
  useNotification(error, "error");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form);
    setBusy(true);
    setError("");
    try {
      if (mode === "reset") {
        await api("/auth/request-password-reset", z.unknown(), {
          email: f.get("email"),
        });
        setDone(true);
      } else if (mode === "change") {
        if (f.get("newPassword") !== f.get("confirm"))
          throw new Error("新しいパスワードが一致しません。");
        await api("/password", z.unknown(), {
          currentPassword: f.get("currentPassword"),
          newPassword: f.get("newPassword"),
        });
        form.reset();
        changed();
      } else {
        await api("/auth/sign-in/email", z.unknown(), {
          email: f.get("email"),
          password: f.get("password"),
        });
        form.reset();
        const i = await api("/access", identitySchema);
        if (i.mustChange) setMode("change");
        else changed();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理できませんでした。");
    } finally {
      setBusy(false);
    }
  }
  if (session !== "ready") return (
    <AuthFrame>
      <h1>{session === "checking" ? "読み込み中" : "ログイン状態を確認できませんでした"}</h1>
      {session === "checking" ? (
        <Loading label="ログイン状態を確認しています…" compact />
      ) : (
        <>
          <p className="error" role="alert">{error}</p>
          <Button className="primary wide" onClick={() => {
            setError("");
            setSession("checking");
            setCheckAttempt(n => n + 1);
          }}>もう一度確認する</Button>
        </>
      )}
    </AuthFrame>
  );
  return <OperationBoundary busy={busy}>{(
    <AuthFrame>
        <p className="eyebrow">チームの勤務を、ひとつの場所で</p>
        <h1>
          {mode === "login"
            ? "ログイン"
            : mode === "change"
              ? "初回パスワードの変更"
              : "パスワードを再設定"}
        </h1>
        <p className="muted">
          {mode === "change"
            ? "管理者から受け取った初期パスワードを変更してから利用を開始してください。"
            : mode === "reset"
              ? "登録したメールアドレスへ再設定リンクを送ります。"
              : "管理者が発行したアカウントでログインしてください。"}
        </p>
        {done ? (
          <p role="status">
            登録が確認できた場合はメールを送信します。受信箱をご確認ください。
          </p>
        ) : (
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              {mode === "change" ? (
                <>
                  <Field help={null} title="現在のパスワード">
                    <Input
                      name="currentPassword"
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={128}
                    />
                  </Field>
                  <Field help={null} title="新しいパスワード（12〜128文字）">
                    <Input
                      name="newPassword"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={128}
                    />
                  </Field>
                  <Field help={null} title="新しいパスワードをもう一度">
                    <Input
                      name="confirm"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={128}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field help={null} title="メールアドレス">
                    <Input
                      name="email"
                      type="email"
                      autoComplete="username"
                      required
                      maxLength={254}
                    />
                  </Field>
                  {mode === "login" && (
                    <Field help={null} title="パスワード">
                      <Input
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                        maxLength={128}
                      />
                    </Field>
                  )}
                </>
              )}
              <Button className="primary wide">
                {busy
                  ? "処理しています…"
                  : mode === "login"
                    ? "ログイン"
                    : mode === "change"
                      ? "変更して利用を開始"
                      : "再設定メールを送る"}
              </Button>
            </fieldset>
          </form>
        )}
        <p className="error" role="alert">
          {error}
        </p>
        {mode !== "change" && (
          <Button
            className="text-button"
            onClick={() => {
              setMode(mode === "login" ? "reset" : "login");
              setDone(false);
              setError("");
            }}
          >
            {mode === "login" ? "パスワードをお忘れですか？" : "ログインへ戻る"}
          </Button>
        )}
    </AuthFrame>
  )}</OperationBoundary>;
}

type Config = z.infer<typeof teamConfig>;
type Plan = z.infer<typeof planning>;
type Policy = z.infer<typeof companyPolicy>;
type Version<T> = {
  id: string;
  effectiveFrom: string;
  revision: number;
  payload: T;
};
type Mutation = {
  inputOwner?: symbol;
  successMessage?: string;
  path: string;
  body: unknown;
  after: (r: unknown) => Promise<void> | void;
};
const workspaceSections = [
  ["readiness", "シフト計算の準備"],
  ["schedule", "シフト・計算結果"],
  ["demand", "需要管理"],
  ["history", "勤務履歴"],
  ["leave", "休暇・欠勤"],
  ["submission", "勤務不可・希望"],
  ["team", "チーム設定"],
  ["staff", "スタッフ管理"],
  ["company", "企業共通ルール"],
] as const;

function Workspace({ logout }: { logout: () => void }) {
  const unsaved = useUnsavedInput();
  const [staffEditing, setStaffEditing] = useState(false);
  const staffRegistration = useRef<HTMLFormElement | null>(null);
  const [csvReceipt, setCsvReceipt] = useState<{
    company: string;
    team: string;
    month: string;
    result: DemandCsvReceipt;
  } | null>(null);
  const [publicationRevision, setPublicationRevision] = useState<number | null>(
    null,
  );
  const [contractRefresh, setContractRefresh] = useState(0);
  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [context, setContext] = useState<Context | null>(null),
    [companyId, setCompanyId] = useState(""),
    [teamId, setTeamId] = useState("");
  const [month, setMonth] = useState(today.slice(0, 7)),
    [requestedSection, setSection] = useState("");
  const [staff, setStaff] = useState<Staff>([]),
    [config, setConfig] = useState<Config | null>(null),
    [plan, setPlan] = useState<Plan | null>(null),
    [policy, setPolicy] = useState<Policy | null>(null);
  const [historyFocus, setHistoryFocus] = useState<{ scope: string; target?: HistoryTarget } | null>(null);
  const scopeKey = [companyId, teamId, month].join(":");
  const [scope, setScope] = useState<{ key: string; status: "loading" | "ready" | "error" }>({ key: "", status: "loading" });
  const [loadAttempt, setLoadAttempt] = useState(0), [contextFailed, setContextFailed] = useState(false);
  const [resultError, setResultError] = useState(false);
  const staffNames=useMemo(()=>indexStaffNames(staff),[staff]);
  const [job, setJob] = useState<Job | null>(null),
    [jobs, setJobs] = useState<(Job & { month: string })[]>([]),
    [result, setResult] = useState<Result | null>(null),
    [frozen, setFrozen] = useState<Frozen | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [selectedPublicationId,setSelectedPublicationId]=useState<string|null>(null),
    [secret, setSecret] = useState<string | null>(null),
    [pending, setPending] = useState<Mutation | null>(null);
  const [draftHead, setDraftHead] = useState<DraftHead>({
      draftRevision: 0,
      draft: null,
    }),
    [manualFrozen, setManualFrozen] = useState<Frozen | null>(null),
    [showManual, setShowManual] = useState(false),
    [violations, setViolations] = useState<string[]>([]);
  useNotification(error, "error");
  useNotification(notice);
  const generation = useRef(0),
    loader = useRef<AbortController | null>(null),
    command = useRef<{
      snapshotId: string;
      jobId: string;
      revision: number;
      month: string;
      draftId?: string;
      draftRevision?: number;
    } | null>(null);
  const company = context?.companies.find((c) => c.id === companyId),
    team = company?.teams.find((t) => t.id === teamId),
    manager = company?.role === "company_admin" || team?.role === "team_admin";
  const visibleSections = workspaceSections.filter(([key]) =>
    manager
      ? key !== "company" || company?.role === "company_admin"
      : ["schedule", "leave", "submission"].includes(key),
  );
  // URL state never grants access: resolve it against the current membership.
  const section = visibleSections.some(([key]) => key === requestedSection)
    ? requestedSection
    : company?.role === "company_admin" && !company.teams.length ? "company" : "schedule";
  const base = `/companies/${companyId}`,
    inputBase = base + `/inputs/teams/${teamId}`,
    jobBase = base + `/compute/teams/${teamId}/jobs`,
    draftBase = base + `/schedules/teams/${teamId}/drafts`,
    publicationBase = base + `/schedules/teams/${teamId}/publications`;
  useEffect(
    () => setStaffEditing(false),
    [companyId, teamId, month, section, company?.revision],
  );
  const versionSchema = <T,>(schema: z.ZodType<T>) =>
    z.object({
      version: z
        .object({
          id: z.string(),
          effectiveFrom: z.string(),
          revision: z.number(),
          payload: schema,
        })
        .nullable(),
    });
  function report(e: unknown) {
    if (
      e instanceof ApiError &&
      ["UNAUTHENTICATED", "USER_DISABLED", "PASSWORD_CHANGE_REQUIRED"].includes(
        e.code,
      )
    ) {
      logout();
      return;
    }
    setError(e instanceof Error ? e.message : "処理できませんでした。");
    setViolations(e instanceof ApiError ? e.violations : []);
  }
  async function refreshContext(signal?: AbortSignal) {
    const c = await api("/context", contextSchema, undefined, signal);
    if (!signal?.aborted) setContext(c);
    return c;
  }
  const readiness = useReadiness({
    company: companyId, team: teamId, month, revision: company?.revision ?? 0,
    draftRevision: draftHead.draftRevision,
    view: section,
    enabled: !!manager && ["schedule", "readiness"].includes(section) && !!team && scope.key === scopeKey && scope.status === "ready",
    report,
  });
  async function recheckReadiness() {
    readiness.recheck();
    try { await refreshContext(); setLoadAttempt(value => value + 1); }
    catch (error) { report(error); }
  }
  useEffect(() => {
    const controller = new AbortController();
    refreshContext(controller.signal)
      .then((c) => {
        if (controller.signal.aborted) return;
        const q = new URLSearchParams(location.search),
          selected =
            c.companies.find((x) => x.id === q.get("company")) ??
            c.companies[0];
        if (selected) {
          setCompanyId(selected.id);
          setSection(q.get("section") ?? "");
          setTeamId(
            selected.teams.find((t) => t.id === q.get("team"))?.id ??
              selected.teams[0]?.id ??
              "",
          );
        }
        const m = q.get("month");
        if (m && /^20\d\d-(0[1-9]|1[0-2])$/.test(m)) {
          setMonth(m);
        }
      })
      .catch(e => { if (!controller.signal.aborted) { setContextFailed(true); report(e); } });
    return () => { controller.abort(); loader.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!company) return;
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({ company: companyId, team: teamId, month, section }))
      url.searchParams.set(key, value);
    url.searchParams.delete("tab");
    // Replacing the current entry preserves the existing navigation behavior.
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }, [company, companyId, teamId, month, section]);
  useEffect(() => {
    const own = ++generation.current;
    setScope({ key: scopeKey, status: "loading" });
    loader.current?.abort();
    const controller = new AbortController();
    loader.current = controller;
    setResult(null);
    setResultError(false);
    setFrozen(null);
    setDraftHead({ draftRevision: 0, draft: null });
    setManualFrozen(null);
    setShowManual(false);
    setViolations([]);
    setJob(null);
    setJobs([]);
    setStaff([]);
    setPlan(null);
    setConfig(null);
    setPolicy(null);
    setCalendar(null);
    setSecret(null);
    setPending(null);
    command.current = null;
    if (!company) {
      setScope({ key: scopeKey, status: "ready" });
      setBusy(false);
      return;
    }
    if (!manager) {
      setScope({ key: scopeKey, status: "ready" });
      setBusy(false);
      return;
    }
    setBusy(true);
    setError("");
    Promise.all([
      team
        ? api(
            base + `/teams/${teamId}/staff`,
            staffSchema,
            undefined,
            controller.signal,
          )
        : Promise.resolve({ staff: [] }),
      team
        ? api(
            inputBase + `/config/${month}`,
            versionSchema(teamConfig),
            undefined,
            controller.signal,
          )
        : Promise.resolve({ version: null }),
      team
        ? api(
            inputBase + `/planning/${month}`,
            versionSchema(planning),
            undefined,
            controller.signal,
          )
        : Promise.resolve({ version: null }),
      team
        ? api(
            jobBase,
            z.object({
              jobs: z.array(jobSchema.extend({ month: z.string() })),
            }),
            undefined,
            controller.signal,
          )
        : Promise.resolve({ jobs: [] }),
      company.role === "company_admin"
        ? api(
            base + `/inputs/company-policy/${month}`,
            versionSchema(companyPolicy),
            undefined,
            controller.signal,
          )
        : Promise.resolve({ version: null }),
      company.role === "company_admin"
        ? api(
            base + `/calendar-settings/${month}`,
            z.object({
              version: z.object({ settings: calendarSettings }).nullable(),
            }),
            undefined,
            controller.signal,
          )
        : Promise.resolve({ version: null }),
      team
        ? api(
            draftBase + "?month=" + month,
            draftHeadSchema,
            undefined,
            controller.signal,
          )
        : Promise.resolve({ draftRevision: 0, draft: null }),
    ])
      .then(([people, c, p, j, pol, cal, head]) => {
        if (own !== generation.current) return;
        setScope({ key: scopeKey, status: "ready" });
        setStaff(people.staff);
        setConfig(c.version?.payload ?? null);
        setPlan(p.version?.payload ?? null);
        setPolicy(pol.version?.payload ?? null);
        setCalendar(cal.version?.settings ?? null);
        setJobs(j.jobs);
        setDraftHead(head);
        setShowManual(!!head.draft);
        const chosen = j.jobs.find((x) => x.month === month);
        if (chosen) setJob(chosen);
      })
      .catch((e) => {
        if (!controller.signal.aborted) { setScope({ key: scopeKey, status: "error" }); report(e); }
      })
      .finally(() => {
        if (own === generation.current) setBusy(false);
      });
  }, [companyId, teamId, month, manager, loadAttempt]);
  useEffect(() => {
    if (!job) return;
    const own = generation.current,
      controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const updated = await api(
          jobBase + "/" + job!.id,
          jobSchema,
          undefined,
          controller.signal,
        );
        if (own !== generation.current || controller.signal.aborted) return;
        setJob(updated);
        setJobs((old) =>
          old.map((j) => (j.id === updated.id ? { ...j, ...updated } : j)),
        );
        if (active(updated)) {
          timer = setTimeout(poll, 2500);
          return;
        }
        if (["SUCCEEDED", "NO_SOLUTION"].includes(updated.state)) {
          const [r, f] = await Promise.all([
            api(
              jobBase + "/" + updated.id + "/result",
              resultSchema,
              undefined,
              controller.signal,
            ),
            api(
              inputBase + "/snapshots/" + updated.snapshot_id,
              frozenSchema,
              undefined,
              controller.signal,
            ),
          ]);
          if (own === generation.current && !controller.signal.aborted) {
            setResultError(false);
            setResult(r);
            setFrozen(f);
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setResultError(true);
          report(e);
          timer = setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [job?.id, companyId, teamId, company?.revision, draftHead.draftRevision]);
  // Keep the frozen input inspectable while running or after a stale/failed
  // result. This read is tied to identity/version changes, not every job poll.
  useEffect(() => {
    setFrozen(null);
    if (!manager || !job?.snapshot_id) return;
    const controller = new AbortController();
    void api(inputBase + "/snapshots/" + job.snapshot_id, frozenSchema, undefined, controller.signal)
      .then(f => { if (!controller.signal.aborted) setFrozen(f); })
      .catch(e => { if (!controller.signal.aborted) report(e); });
    return () => controller.abort();
  }, [job?.snapshot_id, companyId, teamId, company?.revision, draftHead.draftRevision, manager]);
  // Keep the team lock status fresh even while viewing a past job or another month.
  useEffect(() => {
    setManualFrozen(null);
    const controller = new AbortController();
    if (draftHead.draft)
      void api(
        inputBase + "/snapshots/" + draftHead.draft.snapshotId,
        frozenSchema,
        undefined,
        controller.signal,
      )
        .then((f) => {
          if (!controller.signal.aborted) setManualFrozen(f);
        })
        .catch((e) => {
          if (!controller.signal.aborted) report(e);
        });
    return () => controller.abort();
  }, [draftHead.draft?.draftId, companyId, teamId]);
  useEffect(() => {
    if (!manager || !jobs.some(active)) return;
    const own = generation.current,
      controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await api(
          jobBase,
          z.object({ jobs: z.array(jobSchema.extend({ month: z.string() })) }),
          undefined,
          controller.signal,
        );
        if (own !== generation.current || controller.signal.aborted) return;
        setJobs(response.jobs);
        if (response.jobs.some(active)) timer = setTimeout(poll, 2500);
      } catch (e) {
        if (!controller.signal.aborted) {
          report(e);
          timer = setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [companyId, teamId, manager, jobs.some(active)]);
  usePendingOperation(busy || !!pending || !!command.current);
  async function mutate(m: Mutation) {
    const permission = m === pending ? Promise.resolve(true) : unsaved.allowMutation();
    m.inputOwner ??= unsaved.submission;
    if (!await permission) return;
    setBusy(true);
    setError("");
    setNotice("");
    setPending(m);
    setViolations([]);
    try {
      const r = await api(m.path, z.unknown(), m.body);
      await m.after(r);
      unsaved.acknowledge(m.inputOwner);
      setPending(null);
      setNotice(m.successMessage ?? "保存しました。");
    } catch (e) {
      if (e instanceof ApiError && e.status>=400 && e.status<500)
        setPending(null);
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function save(
    kind: "config" | "planning" | "company-policy",
    payload: unknown,
    saved?: () => void,
  ) {
    const revision = company!.revision;
    const path =
      kind === "company-policy"
        ? base + "/inputs/company-policy"
        : inputBase + "/" + kind;
    await mutate({
      path,
      body: {
        operationId: crypto.randomUUID(),
        expectedRevision: revision,
        effectiveFrom: month,
        payload,
      },
      after: async () => {
        await refreshContext();
        if (kind === "config") setConfig(teamConfig.parse(payload));
        if (kind === "planning") setPlan(planning.parse(payload));
        if (kind === "company-policy") setPolicy(companyPolicy.parse(payload));
        saved?.();
      },
    });
  }
  async function compute() {
    if (!command.current && !await unsaved.allow()) return;
    setBusy(true);
    setError("");
    setNotice("");
    if (!command.current)
      command.current = {
        snapshotId: crypto.randomUUID(),
        jobId: crypto.randomUUID(),
        revision: company!.revision,
        month,
        ...(draftHead.draft
          ? {
              draftId: draftHead.draft.draftId,
              draftRevision: draftHead.draftRevision,
            }
          : {}),
      };
    const c = command.current;
    try {
      await api(
        c.draftId
          ? draftBase + "/" + c.draftId + "/snapshots"
          : inputBase + "/snapshots",
        snapshotResult,
        {
          operationId: c.snapshotId,
          expectedRevision: c.revision,
          ...(c.draftId
            ? { expectedDraftRevision: c.draftRevision }
            : { month: c.month }),
        },
      );
      const acceptedJob = await api(jobBase, accepted, {
        operationId: c.jobId,
        snapshotId: c.snapshotId,
        expectedRevision: c.revision,
      });
      setJob(acceptedJob.job);
      setShowManual(false);
      setJobs((old) => [
        { ...acceptedJob.job, month: c.month },
        ...old.filter((j) => j.id !== acceptedJob.job.id),
      ]);
      setResult(null);
      setFrozen(null);
      setSection("schedule");
      command.current = null;
    } catch (e) {
      if (e instanceof ApiError && e.status>=400 && e.status<500)
        command.current = null;
      report(e);
    } finally {
      setBusy(false);
    }
  }
  const anyActive = jobs.some((j) => active(j.id === job?.id ? job : j));
  const computedEditable =
    !draftHead.draft ||
    (frozen?.draftSource?.draftId === draftHead.draft.draftId &&
      frozen.draftSource.draftRevision === draftHead.draftRevision);
  const [staffDialog, setStaffDialog] = useState<{ key: string; staffId: string; tab: "candidate" | "published" } | null>(null);
  const [dayDialog, setDayDialog] = useState<{ key: string; date: string; staffId?: string } | null>(null);
  const [publishedSource, setPublishedSource] = useState<PublishedScheduleSource | null>(null);
  const staffDialogKey = JSON.stringify([scopeKey, section, showManual, showManual ? draftHead.draft?.draftId : job?.id, draftHead.draftRevision]);
  useEffect(() => { setStaffDialog(null); setDayDialog(null); }, [staffDialogKey]);
  function openStaff(staffId: string, tab: "candidate" | "published" = "candidate") {
    setStaffDialog({ key: staffDialogKey, staffId, tab });
  }
  const shownFrozen = showManual
    ? manualFrozen
      ? { ...manualFrozen, stale: !!draftHead.stale }
      : null
    : frozen;
  const shownResult: ScheduleView | null =
    showManual && draftHead.draft
      ? {
          stale: !!draftHead.stale,
          publication: "BLOCKED_A1",
          manual: true,
          result: {
            assignments: draftHead.draft.assignments,
            validation: draftHead.draft.validation,
          },
        }
      : result;
  const [demandCsvOpen, setDemandCsvOpen] = useState(false);
  useEffect(() => setDemandCsvOpen(false), [companyId, teamId, month, section]);
  const [publishDialog, setPublishDialog] = useState<string | null>(null);
  const [resultsDialog, setResultsDialog] = useState<string | null>(null);
  const actionDialogKey = JSON.stringify([staffDialogKey, company?.revision, shownFrozen?.input.inputVersion, publicationRevision]);
  useEffect(() => { setPublishDialog(null); setResultsDialog(null); }, [actionDialogKey]);
  const inputStale = !!shownFrozen && (shownFrozen.stale || company?.revision !== shownFrozen.input.inputVersion);
  const shownStale = shownResult ? publicationBlockers(shownResult, inputStale).stale : inputStale;
  const inputChangesInfo = shownStale && shownFrozen && company ? <InfoHelp title="計算時からの変更" wide keepMounted>
    {open => <InputChanges base={inputBase} snapshotId={shownFrozen.input.jobId}
      revision={company.revision} draftRevision={draftHead.draftRevision}
      nameOf={nameOf} report={report} enabled={open} embedded />}
  </InfoHelp> : undefined;
  async function saveManual(edit: EditingDraft) {
    const source = showManual ? draftHead.draft?.sourceJobId : job?.id;
    if (!source || !shownFrozen) return;
    await mutate({
      path: draftBase,
      body: {
        operationId: crypto.randomUUID(),
        expectedRevision: shownFrozen.input.inputVersion,
        expectedDraftRevision: draftHead.draftRevision,
        sourceJobId: source,
        ...edit,
      },
      after: async () => {
        const head = await api(draftBase + "?month=" + month, draftHeadSchema);
        setDraftHead(head);
        setShowManual(true);
      },
    });
  }

  const nameOf = (id: string) =>
    staffNames.get(id) ?? "当時のスタッフ";
  const publishDisabled = busy || !!pending || !!command.current || anyActive || publicationRevision === null ||
    !shownFrozen || !shownResult || !company || company.revision !== shownFrozen.input.inputVersion ||
    !(showManual ? draftHead.draft : job) || !shownResult.result.assignments ||
    !publicationEligibility(shownResult, inputStale).ready;
  async function publishCandidate(acknowledgeShortage: boolean) {
    if (publishDisabled || !shownFrozen) return;
    const source =
      showManual && draftHead.draft
        ? { kind: "draft", id: draftHead.draft.draftId }
        : job
          ? { kind: "job", id: job.id }
          : null;
    if (!source || publicationRevision === null) return;
    await mutate({
      path: publicationBase,
      successMessage:
        "シフトを公開しました。公開版とアプリ内のお知らせを保存しています。",
      body: {
        operationId: crypto.randomUUID(),
        expectedRevision: shownFrozen.input.inputVersion,
        expectedDraftRevision: draftHead.draftRevision,
        expectedPublicationRevision: publicationRevision,
        source,
        acknowledgeShortage,
      },
      after: async () => {
        await refreshContext();
        setPublishDialog(null);
      },
    });
  }
  return <OperationBoundary busy={busy}>{(
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/app-assets/assets/app-icon-192.png" alt="" width="32" height="32" />シフト管理
        </div>
        <p className="side-label">WORKSPACE</p>
        {visibleSections.map(([k, n]) => (
            <Button
              key={k}
              className={section === k ? "selected" : ""}
              onClick={() => {
                if (k !== section) unsaved.navigate(() => {
                  setError("");
                  setViolations([]);
                  setNotice("");
                  setSection(k);
                });
              }}
            >
              {n}
            </Button>
          ))}
        <p className="sidebar-foot">
          勤務時間・業務配置
          <br />
          チームの条件を守って作成
        </p>
      </aside>
      <div className="main">
        <header className="topbar">
          <span>シフト管理 ／ {company?.name ?? "準備中"}</span>
          <Button
            disabled={busy}
            onClick={async () => {
              if (!await unsaved.allow()) return;
              void api("/auth/sign-out", z.unknown(), {})
                .then(logout)
                .catch(report);
            }}
          >
            ログアウト
          </Button>
        </header>
        {manager && section === "schedule" && resultsDialog === actionDialogKey && shownResult && shownFrozen &&
          <ScheduleActionDialog key={actionDialogKey} title="計算結果" description={showManual ? "保存済みの編集案の検証結果" : "計算した案の検証結果"} onClose={() => setResultsDialog(null)}>
            {shownStale && <p className="warning">この案には最新の変更が反映されていません。</p>}
            <Results result={shownResult} frozen={shownFrozen} />
            {company && team && (showManual ? draftHead.draft : job) && <ExplanationView
              company={company.id} team={team.id} Panel={Panel}
              source={showManual && draftHead.draft ? {kind:'draft',id:draftHead.draft.draftId} : {kind:'job',id:job!.id}} />}
          </ScheduleActionDialog>}
        {manager && section === "schedule" && publishDialog === actionDialogKey && shownResult && shownFrozen &&
          <ScheduleActionDialog key={actionDialogKey} compact title="シフトを公開" closeLabel="公開確認を閉じる" description={showManual ? "保存済みの編集案を確認して公開します。" : "計算した案を確認して公開します。"} onClose={() => setPublishDialog(null)}>
            {error && <Alert className="alert error" role="alert">{error}</Alert>}
            {pending && <Alert className="alert">応答が不明な操作があります。<Button disabled={busy} onClick={() => { void mutate(pending); }}>同じ操作を確認</Button></Alert>}
            <PublishConfirmation view={shownResult} inputStale={inputStale} disabled={publishDisabled}
              onPublish={publishCandidate}
            />
          </ScheduleActionDialog>}
        {manager && dayDialog?.key === staffDialogKey && shownResult && shownFrozen && <ScheduleDetailDialog
          key={staffDialogKey} title={dayDialog.staffId ? `${nameOf(dayDialog.staffId)} ${dayDialog.date}の勤務詳細` : `${dayDialog.date}の日別業務配置`}
          sourceLabel={showManual ? "保存済みの編集案" : "計算した案"} stale={shownStale} onClose={() => setDayDialog(null)}>
          {dayDialog.staffId ? (() => {
            const assignment = shownResult.result.assignments?.find(row => row.staffId === dayDialog.staffId && row.date === dayDialog.date);
            return assignment ? <StaffDayDetails assignment={assignment} input={shownFrozen.input}
              locks={showManual ? draftHead.draft!.locks : shownFrozen.input.locks} label={label} /> : <p>この日の勤務記録はありません。</p>;
          })() : <DailySchedule assignments={shownResult.result.assignments} input={shownFrozen.input} month={month} label={label} date={dayDialog.date}
            setDate={date => setDayDialog(current => current ? { ...current, date } : current)} onStaff={openStaff} nameOf={nameOf} />}
        </ScheduleDetailDialog>}
        {manager && staffDialog?.key === staffDialogKey && <StaffScheduleDialog
          key={staffDialogKey + ":" + staffDialog.staffId} staffId={staffDialog.staffId} month={month} nameOf={nameOf}
          initialTab={staffDialog.tab} label={label} candidate={shownResult ? { ...shownResult, stale: shownStale } : null} candidateLabel={showManual ? "保存済みの編集案" : "計算した案"}
          published={publishedSource?.base === publicationBase && publishedSource.month === month ? publishedSource : null}
          base={publicationBase} revision={company?.revision ?? 0} report={report}
          onReleased={async () => { setNotice("選択した固定を解除しました。公開済みの勤務時刻・休憩は維持しています。"); await refreshContext(); }}
          onClose={() => setStaffDialog(null)}
        />}
        <main className="content">
          <div className="page-head">
            <div>
              <p className="eyebrow">TEAM WORKSPACE</p>
              <h1>
                {!manager
                  ? section === "leave"
                    ? "休暇・欠勤"
                    : section === 'submission' ? '勤務不可・希望' : "自分のシフト"
                  : section === "schedule"
                    ? "シフト・計算結果"
                    : label(
                        {
                          readiness: "シフト計算の準備",
                          demand: "需要管理",
                          history: "勤務履歴",
                          leave: "休暇・欠勤",
                          submission: '勤務不可・希望',
                          team: "チーム設定",
                          staff: "スタッフ管理",
                          company: "企業共通ルール",
                        }[section] ?? section,
                      )}
              </h1>
            </div>
            <div className="controls">
              <NativeSelect
                aria-label="企業"
                value={companyId}
                disabled={busy || !!pending || !!command.current}
                onChange={async (e) => { const inputValue = e.target.value;
                  const next = context!.companies.find(
                    (c) => c.id === inputValue,
                  )!;
                  if (next.id === companyId || !await unsaved.allow()) return;
                  setSelectedPublicationId(null);
                  setCompanyId(next.id);
                  setTeamId(next.teams[0]?.id ?? "");
                  if (!next.teams.length && next.role === "company_admin")
                    setSection("company");
                }}
              >
                {context?.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="チーム"
                value={teamId}
                disabled={busy || !!pending || !!command.current}
                onChange={async (e) => { const inputValue = e.target.value; if (inputValue === teamId || !await unsaved.allow()) return;setSelectedPublicationId(null);setTeamId(inputValue);}}
              >
                {company?.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
              <Input
                aria-label="対象月"
                type="month"
                value={month}
                min="2000-01"
                max="2099-12"
                disabled={busy || !!pending || !!command.current}
                onChange={async (e) => { const inputValue = e.target.value;
                  if (inputValue && inputValue !== month) {
                    if (!await unsaved.allow()) return;
                    setSelectedPublicationId(null);
                    setMonth(inputValue);
                  }
                }}
              />
              {manager && section === 'demand' && <Button type="button" disabled={busy || !!pending || !!command.current || !team || !config} onClick={() => setDemandCsvOpen(true)}>需要CSVの取り込み</Button>}
            </div>
          </div>
          {manager && section === "readiness" && <ReadinessPanel {...readiness}
            teamSelected={!!team} companyAdmin={company?.role === "company_admin"}
            disabled={busy || !!pending || !!command.current}
            navigate={target => { unsaved.navigate(() => setSection(target)); }}
            refresh={() => { void recheckReadiness(); }}
          />}
          {manager && section === "readiness" && <div className="form-actions"><Button onClick={() => unsaved.navigate(() => setSection("schedule"))}>シフト・計算結果へ</Button></div>}
          {error && (
            <Alert className="alert error" role="alert">
              {error}{" "}
              <Button onClick={() => unsaved.navigate(() => location.reload())}>
                最新の入力を読み直す（未保存の入力は破棄）
              </Button>
            </Alert>
          )}

          {pending && (
            <Alert className="alert">
              応答が不明な操作があります。
              <Button
                disabled={busy}
                onClick={() => {
                  void mutate(pending);
                }}
              >
                同じ操作を確認
              </Button>
            </Alert>
          )}
          {!context && !contextFailed || context && company && (scope.key !== scopeKey || scope.status === "loading") ? (
            <Card className="panel"><CardContent className="panel-body"><Loading label="画面のデータを読み込んでいます…" rows={5} /></CardContent></Card>
          ) : scope.status === "error" ? (
            <Alert className="alert error"><p>画面のデータを取得できませんでした。</p><Button onClick={() => setLoadAttempt(n => n + 1)}>もう一度読み込む</Button></Alert>
          ) : <>
          {team && section === "schedule" && (
            <PublicationView
              key={publicationBase + ":" + month}
              base={publicationBase}
              inputBase={inputBase}
              label={label}
              month={month}
              revision={company?.revision ?? 0}
              manager={manager}
              nameOf={nameOf}
              report={report}
              onHead={setPublicationRevision}
              initialPublicationId={selectedPublicationId}
              self={team.staff_id}
              onSource={setPublishedSource}
              onStaff={id => openStaff(id, "published")}
              navigationDisabled={busy||!!pending||!!command.current}
              onOpenNotice={async (target,id)=>{if (!await unsaved.allow()) return;setSelectedPublicationId(id);setMonth(target);}}
              onReleased={async () => {
                setNotice(
                  "選択した固定を解除しました。公開済みの勤務時刻・休憩は維持しています。",
                );
                await refreshContext();
              }}
            />
          )}
          {team && section === "leave" && (
            <LeaveManagement
              key={
                companyId +
                teamId +
                month +
                String(manager) +
                (team.staff_id ?? "")
              }
              base={base + `/schedules/teams/${teamId}/leave`}
              company={companyId}
              month={month}
              manager={manager}
              self={team.staff_id}
              report={report}
              changed={async()=>{await refreshContext();}}
            />
          )}
          {section === 'submission' && team && <StaffSubmission key={companyId+teamId+month+String(manager)+(team.staff_id??'')} base={inputBase} month={month} manager={manager} self={team.staff_id!==null} report={report} changed={refreshContext}/>}
          {!manager ? (
            section === "schedule" && (
              <Panel title="アカウント">
                <p>{team?.name ?? "所属チームは未設定です。"}</p>
                <p className="muted">
                  公開済みの勤務は上のシフトで確認できます。勤務不可・希望は専用画面から提出してください。
                </p>
              </Panel>
            )
          ) : (
            <>
              {section === "schedule" && (
                <Panel title="シフト計算">
                  <div className="readiness-brief" aria-label="計算準備の状態">
                    <p role="status">{readiness.error ?? (readiness.loading ? "計算準備を確認しています…" : readiness.canCompute ? "計算を開始できます。警告の有無は準備画面で確認できます。" : "計算前に設定の確認・修正が必要です。")}</p>
                    <Button onClick={() => unsaved.navigate(() => setSection("readiness"))}>シフト計算の準備を確認</Button>
                  </div>
                  <div className="actions">
                    <Button
                      id="schedule-compute-action"
                      className="primary"
                      disabled={
                        busy ||
                        (!command.current && !readiness.canCompute) ||
                        (!command.current && anyActive) ||
                        !!pending ||
                        !config ||
                        !plan
                      }
                      onClick={() => {
                        void compute();
                      }}
                    >
                      {command.current ? "同じ計算受付を確認" : "シフトを計算"}
                    </Button>
                    <Button disabled={publishDisabled} onClick={() => setPublishDialog(actionDialogKey)}>シフトを公開</Button>
                    {job && active(job) && (
                      <Button
                        disabled={busy || job.state === "CANCELLING"}
                        onClick={() => {
                          void mutate({
                            path: jobBase + "/" + job.id + "/cancel",
                            body: {
                              operationId: crypto.randomUUID(),
                              expectedAttempt: job.attempt,
                            },
                            after: (r) =>
                              setJob(z.object({ job: jobSchema }).parse(r).job),
                          });
                        }}
                      >
                        計算を取り消す
                      </Button>
                    )}
                    <NativeSelect
                      aria-label="計算履歴"
                      disabled={busy || !!command.current || !!pending}
                      value={job?.id ?? ""}
                      onChange={async (e) => { const inputValue = e.target.value;
                        const chosen = jobs.find(
                          (j) => j.id === inputValue,
                        );
                        if (chosen && chosen.id !== job?.id) {
                          if (!await unsaved.allow()) return;
                          setResult(null);
                          setFrozen(null);
                          setJob(chosen);
                        }
                      }}
                    >
                      <option value="">計算履歴</option>
                      {jobs
                        .filter((j) => j.month === month)
                        .map((j) => (
                          <option value={j.id} key={j.id}>
                            {new Date(j.created_at).toLocaleString("ja-JP", {
                              timeZone: "Asia/Tokyo",
                            })}{" "}
                            · {label(j.state)}
                          </option>
                        ))}
                    </NativeSelect>
                  </div>
                  {job && active(job) && <Alert className="alert" aria-busy><Spinner />{label(job.state)}</Alert>}
                  {draftHead.draft && (
                    <div className="toolbar">
                      <Button
                        onClick={() => { if (showManual) unsaved.navigate(() => setShowManual(false)); }}
                        aria-pressed={!showManual}
                      >
                        計算した案
                      </Button>
                      <Button
                        onClick={() => { if (!showManual) unsaved.navigate(() => setShowManual(true)); }}
                        aria-pressed={showManual}
                      >
                        保存済みの編集案（版{draftHead.draftRevision}）
                      </Button>
                    </div>
                  )}
                  {shownResult && shownFrozen ? (
                    <>
                      <Monthly
                          result={shownResult}
                          guidance={<PublicationGuidance
                            key={staffDialogKey}
                            view={shownResult}
                            inputStale={inputStale}
                            staleInfo={inputChangesInfo}
                            navigationDisabled={busy || !!pending || !!command.current}
                            staffIds={shownFrozen.input.staff.map(person => person.id)}
                            nameOf={id => {
                              const person = staff.find(person => person.id === id);
                              return person ? `${person.name}（${person.staff_number}）` : `${nameOf(id)}（ID: ${id}）`;
                            }}
                            onHistory={target => { void unsaved.navigate(() => {
                              setHistoryFocus({ scope: scopeKey, target });
                              setSection("history");
                            }); }}
                            onFix={target => { void unsaved.navigate(() => {
                              if (target === "recompute") {
                                document.getElementById("schedule-compute-action")?.focus();
                                document.getElementById("schedule-compute-action")?.scrollIntoView({ block: "center" });
                              } else if (target === "draft") {
                                if (draftHead.draft) setShowManual(true);
                                requestAnimationFrame(() => {
                                  const editor = document.getElementById("schedule-draft-editor");
                                  const disclosure = editor?.querySelector("details");
                                  if (disclosure) disclosure.open = true;
                                  editor?.scrollIntoView({ block: "start" });
                                });
                              } else setSection(target);
                            }); }}
                          />}
                          onResults={() => setResultsDialog(actionDialogKey)}
                          frozen={shownFrozen}
                          nameOf={nameOf}
                          onStaff={openStaff}
                          choose={date => setDayDialog({ key: staffDialogKey, date })}
                          onCell={(staffId, date) => setDayDialog({ key: staffDialogKey, date, staffId })}
                        />
                      {shownResult.result.assignments && (
                        <>
                          {!showManual && !computedEditable && (
                            <p className="warning">
                              編集は「保存済みの編集案」を選んで続けてください。固定／解除を反映した新しい計算案からも編集できます。
                            </p>
                          )}
                          <div id="schedule-draft-editor"><DraftEditor
                            key={
                              (showManual
                                ? draftHead.draft?.draftId
                                : job?.id) +
                              ":" +
                              draftHead.draftRevision
                            }
                            initial={{
                              assignments: shownResult.result.assignments,
                              locks: showManual
                                ? draftHead.draft!.locks
                                : shownFrozen.input.locks,
                              exceptions: showManual
                                ? draftHead.draft!.exceptions
                                : shownFrozen.input.exceptions,
                            }}
                            input={shownFrozen.input}
                            nameOf={nameOf}
                            label={label}
                            disabled={
                              busy ||
                              !!pending ||
                              !!command.current ||
                              anyActive ||
                              (!showManual && !computedEditable) ||
                              shownResult.stale ||
                              shownFrozen.input.inputVersion !==
                                company?.revision
                            }
                            save={saveManual}
                          /></div>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="candidate-monthly" role="region" aria-label="案の月間表"><Panel title={month + " 月間シフト（参考案）"}>
                      {shownStale && <Alert className="alert warning publication-guidance"><p><strong>この案は公開できません。</strong></p><details className="publication-disclosure" key={staffDialogKey}><summary>公開できない理由・対応を確認</summary><section aria-label="古い案への対応"><div className="stale-heading"><h3>入力条件または編集版が更新された古い案です</h3>{inputChangesInfo}</div><p>この案には最新の変更が反映されていません。最新条件で再計算してください。</p></section></details></Alert>}
                      {job && !resultError && (active(job) || ["SUCCEEDED", "NO_SOLUTION"].includes(job.state)) ? <Loading label={active(job) ? "計算・独立検証の完了を待っています…" : "計算結果を読み込んでいます…"} rows={4} /> : <p className="muted">
                        {resultError ? "計算結果を取得できませんでした。再取得を試みています。" : busy || (!!job && active(job))
                          ? "計算・独立検証の完了を待っています。"
                          : "この月の計算結果はまだありません。"}
                        {job?.failure_code &&
                          ` 処理の失敗が記録されています。履歴から確認し、条件を変えずに再計算できます。`}
                      </p>}
                      <div className="form-actions"><Button disabled>計算結果</Button></div>
                    </Panel></div>
                  )}
                </Panel>
              )}
              {section === "demand" && (
                <>
                  <DemandCsvResult
                    receipt={
                      csvReceipt?.company === companyId &&
                      csvReceipt.team === teamId &&
                      csvReceipt.month === month
                        ? csvReceipt.result
                        : null
                    }
                  />
                  <PlanningManagement
                    csvOpen={demandCsvOpen} onCsvOpenChange={setDemandCsvOpen}
                    csvFeedback={<>
                      {error && <Alert className="alert error" role="alert">{error}</Alert>}
                      {pending && <Alert className="alert">応答が不明な操作があります。<Button disabled={busy} onClick={() => { void mutate(pending); }}>同じ操作を確認</Button></Alert>}
                    </>}
                    key={companyId + teamId + month}
                    config={config}
                    initial={plan}
                    staff={staff}
                    company={companyId}
                    team={teamId}
                    revision={company!.revision}
                    report={report}
                    nameOf={label}
                    month={month}
                    disabled={busy || !!pending || !!command.current}
                    save={(p, saved) => save("planning", p, saved)}
                    applyCsv={(c, done) =>
                      mutate({
                        path: inputBase + "/demand-csv/apply",
                        body: c,
                        successMessage:
                          "CSVの正常行を反映しました。エラー行は反映していません。",
                        after: async (value) => {
                          const result = demandCsvReceipt.parse(value);
                          setCsvReceipt({
                            company: companyId,
                            team: teamId,
                            month,
                            result,
                          });
                          const saved = await api(
                            inputBase + "/planning/" + month,
                            versionSchema(planning),
                          );
                          await refreshContext();
                          setPlan(saved.version?.payload ?? null);
                          done();
                        },
                      })
                    }
                  />
                </>
              )}
              {section === "history" && team && (
                <HistoryManagement
                  key={companyId + teamId + month}
                  company={companyId}
                  team={teamId}
                  month={month}
                  revision={company!.revision}
                  staff={staff}
                  initialTarget={historyFocus?.scope === scopeKey ? historyFocus.target : undefined}
                  disabled={busy || !!pending || !!command.current}
                  report={report}
                  syncContext={refreshContext}
                  save={(records, expectedRevision, clear) =>
                    mutate({
                      path: inputBase + "/history",
                      body: {
                        operationId: crypto.randomUUID(),
                        expectedRevision,
                        month,
                        records,
                      },
                      after: async () => {
                        clear();
                        await refreshContext();
                      },
                    })
                  }
                />
              )}
              {section === "team" && (
                <TeamSettings
                  key={companyId + teamId + month}
                  initial={config}
                  company={companyId}
                  team={teamId}
                  month={month}
                  revision={company!.revision}
                  report={report}
                  nameOf={label}
                  disabled={busy || !!pending || !!command.current}
                  save={(c, saved) => save("config", c, saved)}
                  onCompanySettings={company?.role === "company_admin" ? () => {
                    void unsaved.navigate(() => {
                      setError("");
                      setViolations([]);
                      setNotice("");
                      setSection("company");
                      window.scrollTo(0, 0);
                    });
                  } : undefined}
                />
              )}
              {section === "company" && (
                <>
                  <TeamCreation key={JSON.stringify(company!.teams.map(t => t.id))}
                    teams={company!.teams}
                    disabled={busy || !!pending || !!command.current}
                    create={async (name) => {
                      await mutate({
                        path: base + "/teams",
                        body: {
                          operationId: crypto.randomUUID(),
                          expectedRevision: company!.revision,
                          name,
                        },
                        after: async (raw) => {
                          const r = z
                            .object({ teamId: z.string().uuid() })
                            .parse(raw);
                          await refreshContext();
                          setTeamId(r.teamId);
                        },
                      });
                    }}
                  />
                  <CalendarSettings
                    key={
                      "calendar:" + companyId + month + JSON.stringify(calendar)
                    }
                    initial={calendar}
                    disabled={busy || !!pending || !!command.current}
                    save={async (settings) => {
                      await mutate({
                        path: base + "/calendar-settings",
                        body: {
                          operationId: crypto.randomUUID(),
                          expectedRevision: company!.revision,
                          effectiveFrom: month,
                          settings,
                        },
                        after: async () => {
                          await refreshContext();
                          setCalendar(settings);
                        },
                      });
                    }}
                  />
                  <PolicySettings
                    key={"policy:" + companyId + month}
                    initial={policy}
                    disabled={busy || !!pending || !!command.current}
                    save={(p, saved) => save("company-policy", p, saved)}
                  />
                </>
              )}
              {section === "staff" && !!team && (
                <>
                  <Panel title="スタッフ一覧">
                    <div className="table-scroll">
                      <Table>
                        <thead>
                          <tr>
                            <TableHead>スタッフ番号</TableHead>
                            <TableHead>氏名</TableHead>
                            <TableHead>権限</TableHead>
                            <TableHead>状態</TableHead>
                            <TableHead className="w-16 text-right">操作</TableHead>
                          </tr>
                        </thead>
                        <tbody>
                          {staff.map((s) => (
                            <tr key={s.id}>
                              <TableCell>{s.staff_number}</TableCell>
                              <TableCell>{s.name}</TableCell>
                              <TableCell>
                                {s.role === "team_admin"
                                  ? "チーム管理者"
                                  : s.role === null ? "チーム権限未設定" : "スタッフ"}
                              </TableCell>
                              <TableCell><span className="status-badge">{s.status === "inactive" ? "非アクティブ" : "アクティブ"}</span></TableCell>
                              <TableCell className="text-right">
                                <StaffActions staff={s} companyAdmin={company?.role === "company_admin"}
                                  disabled={busy || !!pending || !!command.current}
                                  changeRole={() => void mutate({
                                    path: base + `/teams/${teamId}/admins${s.role === "team_admin" ? "/revoke" : ""}`,
                                    body: { operationId: crypto.randomUUID(), expectedRevision: company!.revision, userId: s.user_id },
                                    after: async () => {
                                      await refreshContext();
                                      setStaff((await api(base + `/teams/${teamId}/staff`, staffSchema)).staff);
                                    },
                                  })}
                                  changeStatus={status => void mutate({
                                    path: base + `/teams/${teamId}/staff/${s.id}/status`,
                                    body: { operationId: crypto.randomUUID(), expectedRevision: company!.revision, status },
                                    successMessage: status === "deleted" ? "スタッフを削除しました。" : status === "inactive" ? "スタッフを非アクティブ化しました。" : "スタッフを再有効化しました。",
                                    after: async () => {
                                      await refreshContext();
                                      setStaff((await api(base + `/teams/${teamId}/staff`, staffSchema)).staff);
                                    },
                                  })}
                                />
                              </TableCell>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </div>
                    {company?.role === "company_admin" && (
                      <p className="muted">
                        チーム管理者はこのチームの管理操作を行えます。解除後はスタッフとして本人の情報を確認できます。
                      </p>
                    )}
                    <UnsavedForm
                      ref={staffRegistration}
                      onChange={() => setStaffEditing(true)}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void mutate({
                          path: base + `/teams/${teamId}/staff`,
                          body: {
                            operationId: crypto.randomUUID(),
                            expectedRevision: company!.revision,
                            name: f.get("name"),
                            staffNumber: f.get("staffNumber"),
                            email: f.get("email"),
                          },
                          after: async (raw) => {
                            const r = mutationResult.parse(raw);
                            staffRegistration.current?.reset();
                            setStaffEditing(false);
                            setSecret(r.initialPassword ?? null);
                            await refreshContext();
                            setStaff(
                              (
                                await api(
                                  base + `/teams/${teamId}/staff`,
                                  staffSchema,
                                )
                              ).staff,
                            );
                          },
                        });
                      }}
                    >
                      <fieldset
                        disabled={busy || !!pending || !!command.current}
                      >
                        <h3>スタッフを登録</h3>
                        <div className="form-grid">
                          <Field title="スタッフ番号">
                            <Input name="staffNumber" required maxLength={64} />
                          </Field>
                          <Field title="氏名">
                            <Input name="name" required maxLength={120} />
                          </Field>
                          <Field title="メールアドレス">
                            <Input
                              name="email"
                              type="email"
                              required
                              maxLength={254}
                            />
                          </Field>
                        </div>
                        <Button className="primary">
                          登録・初期パスワード発行
                        </Button>
                      </fieldset>
                    </UnsavedForm>
                    {secret && (
                      <Alert className="alert">
                        <div>
                          <strong>初期パスワード</strong>
                          <p>
                            本人へ安全な方法で渡してください。閉じると再表示できません。
                          </p>
                          <Input
                            readOnly
                            type="text"
                            value={secret}
                            aria-label="発行した初期パスワード"
                            autoComplete="off"
                          />
                        </div>
                        <Button onClick={() => setSecret(null)}>閉じる</Button>
                      </Alert>
                    )}
                    <p className="muted">
                      登録後に勤務契約・習熟度・対応可能な担当を設定してください。未設定のスタッフは計算開始時に検出します。
                    </p>
                  </Panel>
                  <StaffCsvImport
                    key={"csv:" + companyId + teamId + month}
                    company={companyId}
                    team={teamId}
                    month={month}
                    revision={company!.revision}
                    config={config}
                    disabled={busy || !!pending || !!command.current}
                    report={report}
                    dirty={staffEditing}
                    discard={() => {
                      staffRegistration.current?.reset();
                      setContractRefresh((n) => n + 1);
                      setStaffEditing(false);
                    }}
                    apply={(c, done) =>
                      mutate({
                        path: inputBase + "/staff-csv/apply",
                        body: c,
                        successMessage: "スタッフCSVの正常行を反映しました。",
                        after: async (raw) => {
                          done(staffCsvResponse.parse(raw));
                          await refreshContext();
                          setStaff(
                            (
                              await api(
                                base + `/teams/${teamId}/staff`,
                                staffSchema,
                              )
                            ).staff,
                          );
                        },
                      })
                    }
                  />
                  <ContractManagement
                    key={companyId + teamId + month}
                    company={companyId}
                    team={teamId}
                    month={month}
                    revision={company!.revision}
                    config={config}
                    staff={staff}
                    companyAdmin={company?.role === "company_admin"}
                    disabled={busy || !!pending || !!command.current}
                    refresh={contractRefresh}
                    report={report}
                    markEditing={() => setStaffEditing(true)}
                    nameOf={label}
                    save={(path, payload, saved) =>
                      mutate({
                        path,
                        body: {
                          operationId: crypto.randomUUID(),
                          expectedRevision: company!.revision,
                          effectiveFrom: month,
                          payload,
                        },
                        after: async () => {
                          await refreshContext();
                          setContractRefresh((value) => value + 1);
                          saved?.();
                        },
                      })
                    }
                  />
                </>
              )}
            </>
          )}
          {violations.length > 0 && (
            <Alert className="alert warning" role="alert">
              <ul>
                {violations.map((v, i) => (
                  <li key={i}>{violationText(v, nameOf)}</li>
                ))}
              </ul>
            </Alert>
          )}
          </>}
          <p className="footer-note">
            時刻は日本時間。保存・計算は現在の入力版を照合します。
          </p>
        </main>
      </div>
    </div>
  )}</OperationBoundary>;
}

function Monthly({
  guidance,
  onResults,
  result,
  frozen,
  nameOf,
  choose,
  onStaff,
  onCell,
}: {
  guidance: ReactNode;
  onResults: () => void;
  result: ScheduleView;
  frozen: Frozen;
  onCell: (staffId: string, date: string) => void;
  nameOf: (id: string) => string;
  choose: (d: string) => void;
  onStaff: (id: string) => void;
}) {
  return (
    <div className="candidate-monthly" role="region" aria-label="案の月間表"><Panel title={frozen.input.month + " 月間シフト（参考案）"}>
      {guidance}
      <MonthlyTable month={frozen.input.month} staff={frozen.input.staff}
        assignments={result.result.assignments} nameOf={nameOf} choose={choose} onStaff={onStaff} onCell={onCell}/>
      <div className="form-actions"><Button onClick={onResults}>計算結果</Button></div>
    </Panel></div>
  );
}
function Results({ result, frozen }: { result: ScheduleView; frozen: Frozen }) {
  const r = result.result,
    v = r.validation,
    preferences = v.preferences ?? [],
    fulfilled = preferences.filter((p) => p.fulfilled).length,
    scale = frozen.input.capacityScale,
    solverLabel = r.solverStatus ? label(r.solverStatus) : "手動編集案・最適性は未証明",
    shortages = v.intervals?.filter((c) => c.shortage > 0),
    verified = v.status === "VERIFIED";
  return (
    <>
      <div className="stats">
        <div>
          <span>探索の結果</span>
          <div className="solver-result-value">
            <strong>{solverLabel}</strong>
            <SolverResultHelp key={JSON.stringify([frozen.input.jobId, r.solverStatus, frozen.input.inputVersion])} status={r.solverStatus} label={solverLabel} />
          </div>
        </div>
        <div>
          <span>制約検証</span>
          <strong>{label(v.status)}</strong>
        </div>
        <div>
          <span>希望充足</span>
          <strong>
            {v.preferences === undefined
              ? "未検証"
              : preferences.length
                ? `${fulfilled} / ${preferences.length} 件`
                : "希望なし"}
          </strong>
        </div>
        <div>
          <span>一般業務・同段階の担当区分不足</span>
          <strong>
            {v.generalShortage === undefined || v.roleSameShortage === undefined
              ? "未検証"
              : `${(v.generalShortage + v.roleSameShortage) / scale} 人分`}
          </strong>
        </div>
      </div>
      {v.violations.length > 0 && (
        <Alert className="alert error">必須条件の違反を検出しました。</Alert>
      )}
      {(v.missingHistory?.length ?? 0) > 0 && (
        <Alert className="alert warning">
          履歴未確認 {v.missingHistory!.length} 件。連続勤務などを完全に検証できないため公開不可です。
        </Alert>
      )}
      <Panel title="不足人数">
        <p>需要不足は必須条件違反と分けて表示します。</p>
        <div className="table-scroll result-table-scroll" tabIndex={0} role="region" aria-label="不足人数の表">
          <Table aria-label="不足人数" className="result-shortage-table">
            <thead>
              <tr>
                <TableHead>日付</TableHead>
                <TableHead>時間</TableHead>
                <TableHead>業務</TableHead>
                <TableHead>不足人数</TableHead>
              </tr>
            </thead>
            <tbody>
              {shortages?.map((c, i) => (
                  <tr key={i}>
                    <TableCell>{c.date}</TableCell>
                    <TableCell>
                      {time(c.start)}〜{time(c.end)}
                    </TableCell>
                    <TableCell>{label(c.taskId)}</TableCell>
                    <TableCell>{c.shortage / scale}</TableCell>
                  </tr>
                ))}
              {!shortages?.length && <tr><TableCell colSpan={4}>
                {verified && shortages !== undefined
                  ? "不足はありません。"
                  : "不足人数の検証データを取得できていません。"}
              </TableCell></tr>}
            </tbody>
          </Table>
        </div>
      </Panel>
      <Panel title="担当区分の不足">
        <p>先行・同段階の両方を表示します。不足量は人数と時間の積算で、1人が30分不足すると30人分です。</p>
        <div className="table-scroll result-table-scroll" tabIndex={0} role="region" aria-label="担当区分の不足の表">
          <Table aria-label="担当区分の不足" className="result-role-table">
            <thead><tr>
              <TableHead>日付</TableHead><TableHead>時間</TableHead><TableHead>業務</TableHead>
              <TableHead>担当区分</TableHead><TableHead>評価順序</TableHead><TableHead>不足量（人分）</TableHead>
            </tr></thead>
            <tbody>
              {v.roleRequirements?.map((row) => {
                const condition = frozen.input.roleRequirements.find((c) => c.id === row.id);
                return <tr key={row.id}>
                  <TableCell>{condition?.date ?? "不明"}</TableCell>
                  <TableCell>{condition ? `${time(condition.start)}〜${time(condition.end)}` : "不明"}</TableCell>
                  <TableCell>{condition ? condition.taskId ? label(condition.taskId) : "全業務" : "不明"}</TableCell>
                  <TableCell>{condition ? label(condition.roleId) : `条件を特定できません（${row.id}）`}</TableCell>
                  <TableCell>{condition ? condition.priority === "first" ? "先行" : "同段階" : "不明"}</TableCell>
                  <TableCell>{row.shortagePersonMinutes}</TableCell>
                </tr>;
              })}
              {!v.roleRequirements?.length && <tr><TableCell colSpan={6}>
                {verified && v.roleRequirements !== undefined && !frozen.input.roleRequirements.length
                  ? "担当区分の検証対象はありません。"
                  : "担当区分の検証データを取得できていません。"}
              </TableCell></tr>}
            </tbody>
          </Table>
        </div>
      </Panel>
      <Panel title="段階別の最適化">
        {r.stages?.length ? <div className="optimization-stages">
          {r.stages.map((s, i) => {
            const Icon = s.status === "OPTIMAL" ? CircleCheck : s.status === "INFEASIBLE" ? CircleX : s.status === "MODEL_INVALID" ? TriangleAlert : CircleHelp;
            const tone = s.status === "OPTIMAL" ? "confirmed" : s.status === "MODEL_INVALID" ? "error" : ["FEASIBLE", "UNKNOWN", "INFEASIBLE"].includes(s.status) ? "unproven" : "neutral";
            const names: Record<string, string> = { roleFirst: "担当区分先行", combined: "一般・同段階担当区分の不足", missed: "希望未充足", surplus: "余剰" };
            return <div className={`optimization-stage optimization-stage-${tone}`} data-status={s.status} key={i}>
              <div className="optimization-stage-icon"><Icon aria-hidden="true" size={20} /></div>
              <div className="optimization-stage-text">
                <h3>{Object.hasOwn(names, s.name) ? names[s.name] : s.name}</h3>
                <p>{label(s.status)}</p>
              </div>
            </div>;
          })}
        </div> : <p>段階別の最適化情報はありません</p>}
      </Panel>
    </>
  );
}
function App() {
  const [signedIn, setSignedIn] = useState(false);
  return signedIn ? (
    <UnsavedInputProvider><Workspace logout={() => setSignedIn(false)} /></UnsavedInputProvider>
  ) : (
    <Auth changed={() => setSignedIn(true)} />
  );
}
createRoot(document.getElementById("root")!).render(<ConfirmationProvider><App /><Toaster /></ConfirmationProvider>);
