import type { ScheduleView } from "./api";
import { violationText } from "./draft-model";

export type PublicationFix = "staff" | "team" | "demand" | "submission" | "draft" | "recompute";
export type HistoryTarget = { staffId: string; date: string };
export function historyTarget(value: string): HistoryTarget | null {
  const match = /^([^:]+):(20\d{2}-\d{2}-\d{2})$/.exec(value);
  if (!match) return null;
  const day = new Date(match[2] + "T00:00:00Z");
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[2]) return null;
  return { staffId: match[1]!, date: match[2]! };
}
export function publicationBlockers(view: ScheduleView, inputStale = false) {
  const v = view.result.validation;
  const history = !!v.missingHistory?.length || v.status === "HISTORY_UNVERIFIED";
  const invalid = !!v.violations.length || v.status === "INVALID";
  return {
    history, invalid, stale: view.stale || inputStale,
    unverified: !["VERIFIED", "HISTORY_UNVERIFIED", "INVALID"].includes(v.status),
  };
}

export function publicationEligibility(view: ScheduleView, inputStale = false) {
  const blockers = publicationBlockers(view, inputStale), validation = view.result.validation;
  return {
    blockers,
    ready: !Object.values(blockers).some(Boolean),
    shortage: (validation.generalShortage ?? 0) > 0 || (validation.roleSameShortage ?? 0) > 0 ||
      !!validation.roleRequirements?.some(row => row.shortagePersonMinutes > 0),
  };
}

type Advice = { title: string; steps: string; fix: PublicationFix; button: string };
const contracts: Advice = { title: "勤務契約の曜日・時間帯との不一致", steps: "個人契約・雇用区分・企業共通ルールと配置を照合し、誤入力や配置の矛盾を修正して再計算してください。", fix: "staff", button: "勤務契約を確認" };
const hours: Advice = { title: "勤務時間・勤務日数・連続勤務の条件違反", steps: "対象者の勤務量・休日・月境界の実績と登録した勤務条件を照合し、誤入力や配置の矛盾を修正して再計算してください。", fix: "staff", button: "勤務契約を確認" };
const breaks: Advice = { title: "休憩の長さ・時間帯・固定条件の違反", steps: "勤務パターンと実際の休憩を照合してください。企業共通の休憩ルールに誤入力がある場合は企業管理者に修正を依頼し、再計算してください。", fix: "team", button: "勤務パターンを確認" };
const allocation: Advice = { title: "業務・担当区分の配置条件違反", steps: "対象日の業務配置と、重複・未割当・担当区分の条件を確認してください。誤った配置や設定を修正し、再計算してください。", fix: "draft", button: "業務配置・編集案を確認" };
const advice: Record<string, Advice> = {
  CONTRACT: contracts,
  MONTHLY_HOURS: { ...hours, title: "月間勤務時間が条件の範囲外" },
  MONTHLY_DAYS: { ...hours, title: "月間勤務日数・休日数の条件違反" },
  DAILY_HOURS: { ...hours, title: "1日の勤務時間の上限超過" },
  WEEKLY_HOURS: { ...hours, title: "週の勤務時間の上限超過" },
  CONSECUTIVE: { ...hours, title: "連続勤務日数の上限超過" },
  BREAK_INTERVAL: breaks, FIXED_BREAK: breaks, BREAK_QUANTITY: breaks, BREAK_RANGE: breaks,
  UNAVAILABLE: { title: "勤務不可の時間帯への配置", steps: "対象者の勤務不可と配置を確認し、許可済みの理由付き例外を除いて重ならないよう修正して再計算してください。", fix: "submission", button: "勤務不可・希望を確認" },
  EVENT_FULL_ATTENDANCE: { title: "研修・会議に全時間参加できない配置", steps: "対象者の参加予定と勤務・休憩を照合し、予定または配置の矛盾を修正して再計算してください。", fix: "demand", button: "研修・会議を確認" },
  EVENT_OVERLAP: { title: "研修・会議の重複", steps: "対象者の研修・会議の時間と参加者を確認し、重複を修正して再計算してください。", fix: "demand", button: "研修・会議を確認" },
  LOCK: { title: "固定した勤務との不一致", steps: "保存済み編集案の勤務パターン・出退勤・休憩の固定を確認し、最新の固定を引き継いで再計算してください。", fix: "draft", button: "固定・編集案を確認" },
  PUBLISHED_MAINTENANCE: { title: "公開済み勤務の維持条件との不一致", steps: "公開済みの出退勤・休憩・取消と照合し、それらを維持した業務再配置を再計算してください。", fix: "draft", button: "業務配置・編集案を確認" },
  PATTERN: { title: "勤務パターンとの不一致", steps: "勤務パターンの登録値と案の出退勤・休憩を照合し、誤入力や配置を修正して再計算してください。", fix: "team", button: "勤務パターンを確認" },
  TASK_ELIGIBILITY: { title: "業務の習熟度条件との不一致", steps: "対象者の習熟度と業務の最低習熟度を照合し、誤入力や配置を修正して再計算してください。", fix: "staff", button: "習熟度・対応可能な担当を確認" },
  ROLE_ELIGIBILITY: { title: "対応可能な担当・対象業務との不一致", steps: "対象者の対応可能な担当と、担当区分の対象業務を照合し、誤入力や配置を修正して再計算してください。", fix: "staff", button: "習熟度・対応可能な担当を確認" },
  MINIMUM_RUN: { title: "業務の最低継続時間の不足", steps: "対象日の配置と業務の最低継続時間を確認し、配置の矛盾を修正して再計算してください。", fix: "draft", button: "業務配置・編集案を確認" },
  WORKED_MINUTES: { title: "勤務時間の集計不一致", steps: "出退勤・休憩・取消と勤務時間(分)の集計が一致していません。最新条件で再計算し、同じ問題が続く場合は確認コードを添えて調査を依頼してください。", fix: "recompute", button: "計算ボタンへ" },
  ASSIGNMENT_KEYS: { title: "スタッフ・日付の不足または重複", steps: "配置対象のスタッフ・日付に不足または重複があります。最新条件で再計算し、同じ問題が続く場合は確認コードを添えて調査を依頼してください。", fix: "recompute", button: "計算ボタンへ" },
  OUTPUT_SHAPE: { title: "配置データの形式に不整合があります", steps: "配置データを検証できません。最新条件で再計算し、同じ問題が続く場合は確認コードを添えて調査を依頼してください。", fix: "recompute", button: "計算ボタンへ" },
};
for (const code of ["TASK_SLOT", "PHANTOM_TASK", "TASK_OVERLAP", "ROLE_INTERVAL", "ROLE_OVERLAP", "WAITING", "DUPLICATE_ROLE_SOURCE", "TRANSITION_NOT_AT_SLOT_START", "PREPARATION_INTERRUPTED", "ROLE_OUTSIDE_PROCESSING", "DRAFT_CANCELLATION", "CANCELLATION_INTERVAL", "MANUAL_EXCEPTION_PLACEMENT"])
  advice[code] = allocation;

export function violationAdvice(value: string, staffIds: readonly string[]) {
  const [code = "", person, ...rest] = value.split(":");
  return {
    ...(advice[code] ?? { title: "検証器が報告した問題（確認コードを参照）", steps: "下の確認コードを確認し、最新条件で再計算してください。同じ問題が続く場合は、このコードを添えて管理者へ調査を依頼してください。", fix: "recompute" as const, button: "計算ボタンへ" }),
    ...(advice[code] && code !== "OUTPUT_SHAPE" ? { title: violationText(code, () => "") } : {}),
    raw: value,
    staffId: person && staffIds.includes(person) ? person : undefined,
    date: rest.find(part => /^20\d{2}-\d{2}-\d{2}$/.test(part)),
  };
}
