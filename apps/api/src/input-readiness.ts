import { z } from "zod";
import { calendarSettings, ProductError, requireManager } from "./product";
import { companyPolicy, employmentPolicy, planning, staffContract, staffMonth, storedTeamConfig } from "./input-contracts";
import { inputMonth, validateResourcePayload, type InputDatabase, type VersionRow } from "./input-versions";
import { compileInput, loadSources, validateCompiledInput } from "./input-snapshots";
import { requiredHistory } from "./history-contract";
import { readDraft } from "./schedule-drafts";
import { fixedDraftInput } from "./draft-recalculation";
import { readinessResponse, readinessBlocksCompute, type ReadinessItem } from "./readiness-contract";
import { demandCoverage } from "./demand-coverage";

type Environment = { DB: InputDatabase; INPUTS: R2Bucket };
const messages: Record<string, string> = {
  COMPANY_BREAK_RULE_NOT_CONFIGURED: "企業共通の休憩ルールが未登録です。企業管理者に設定を依頼してください。",
  CONTRADICTORY_CONTRACT: "企業・雇用区分・個人の勤務可能曜日・時間帯が重なっていません。",
  CONTRADICTORY_RULE: "最低勤務量と上限・休日数の条件が矛盾しています。",
  EVENT_ATTENDANCE_CONFLICT: "研修・会議に全時間参加できる勤務・休憩の組み合わせがありません。",
  OVERLAPPING_EVENT: "同じ参加者の研修・会議が重なっています。",
  UNKNOWN_SKILL_OR_ROLE: "習熟度・対応可能な担当と現在のチーム設定を確認してください。",
  CAPACITY_NOT_CONFIGURED: "習熟度と能力係数の対応を確認してください。",
  INVALID_TASK_CAPACITY_LEVEL: "業務の最低習熟度・段階別の能力係数を確認してください。",
  INVALID_DEMAND_SLOT: "需要の時間帯をチームの配置枠に合わせてください。",
  DEMAND_UNSET: "必要人数が未設定の需要があります。不要な枠は0を明示してください。",
  PUBLISHED_PATTERN_MISSING: "公開済み勤務で使う勤務パターンが見つかりません。",
  PUBLISHED_PATTERN_CONFLICT: "公開済み勤務と、現在の勤務パターンの出退勤・休憩設定が一致していません。対象月の勤務パターンを公開時の設定に戻してください。公開後の再計算では出退勤・休憩を維持します。新しい設定は翌月以降に適用してください。",
  UNKNOWN_STAFF: "需要・予定で指定するスタッフを確認してください。",
  ROLE_POLICY_NOT_CONFIGURED: "担当区分の必要人数に対応する評価方式をチーム設定で確認してください。",
  EMPTY_OR_REVERSED_INTERVAL: "勤務可能時間帯・予定の開始と終了を確認してください。",
};
function settingError(error: unknown): { code: string; message: string } {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return { code: "INVALID_INPUT", message: "保存済みの入力値・時刻・参照先を確認してください。" };
  if (error instanceof ProductError && error.status === 400)
    return { code: error.code, message: messages[error.code] ?? "登録した条件の組み合わせを確認してください。" };
  // Storage, transport, permission and version failures are never settings errors.
  throw error;
}
export async function readInputReadiness(env: Environment, company: string, team: string, user: string, month: string) {
  inputMonth.parse(month);
  await requireManager(env.DB, company, team, user);
  const db = env.DB;
  const head = () => db.prepare("SELECT revision,draft_id FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?")
    .bind(company, team, month).first<{ revision: number; draft_id: string | null }>();
  const initialHead = await head();
  const sources = await loadSources(db, company, team, month, { allowIncomplete: true, bucket: env.INPUTS });
  const items: ReadinessItem[] = [];
  const selected = new Map(sources.versions.map(row => [row.kind + ":" + row.entity_id, row]));
  const row = (kind: VersionRow["kind"], entity: string) => selected.get(kind + ":" + entity);
  const payload = (value: VersionRow | undefined) => value ? JSON.parse(value.payload) : undefined;
  function item(id: ReadinessItem["id"], section: ReadinessItem["section"], required = true) {
    const next: ReadinessItem = { id, section, required, status: "unconfirmed", message: "前提となる設定を登録すると確認できます。" };
    items.push(next); return next;
  }
  function check(next: ReadinessItem, exists: boolean, validate: () => void, success: string, missing: string) {
    if (!exists) { next.status = "missing"; next.message = missing; return; }
    try { validate(); next.status = "complete"; next.message = success; }
    catch (error) { Object.assign(next, { status: "invalid", ...settingError(error) }); }
  }
  const target = { company, team: null, staff: null, kind: "company_policy" as const, entity: company };
  const calendar = item("calendar", "company");
  check(calendar, !!sources.calendar, () => calendarSettings.parse(JSON.parse(sources.calendar!.payload)), "対象月に有効なカレンダーがあります。", "対象月に有効な企業カレンダーが未登録です。");
  const policy = item("company_policy", "company");
  check(policy, !!row("company_policy", company), () => {
    const value = payload(row("company_policy", company));
    if (value && !value.breakRule) throw new ProductError("COMPANY_BREAK_RULE_NOT_CONFIGURED", 400);
    companyPolicy.parse(value); validateResourcePayload(target, month, value, {});
  }, "共通の勤務条件・休憩ルールがあります。", "企業共通ルールが未登録です。");
  const config = item("team_config", "team");
  const configRow = row("team_config", team);
  if (!configRow) { config.status = "missing"; config.message = "チームの業務・勤務パターンが未登録です。"; }
  else if (policy.status === "complete") check(config, true, () => {
    storedTeamConfig.parse(payload(configRow));
    validateResourcePayload({ ...target, team, kind: "team_config", entity: team }, month, payload(configRow), { policy: payload(row("company_policy", company)) });
  }, "業務・勤務パターン・能力係数を確認しました。", "");
  const staff = item("staff", "staff");
  staff.count = sources.staff.length;
  staff.status = sources.staff.length ? "complete" : "missing";
  staff.message = sources.staff.length ? `${sources.staff.length}名が計算対象です。公開済み勤務の維持対象を含みます。` : "計算対象のスタッフがいません。登録または再有効化してください。";
  const contracts = item("contracts", "staff");
  let missingContracts = 0, invalidContracts = 0, uncheckedContracts = 0;
  const contractIssues = new Set<string>();
  for (const person of sources.staff) {
    const profileRow = row("staff_contract", person.id);
    if (!profileRow) { missingContracts++; continue; }
    try {
      const profile = staffContract.parse(payload(profileRow));
      const employmentRow = row("employment_policy", profile.employmentTypeId);
      if (!employmentRow) { missingContracts++; continue; }
      const employment = employmentPolicy.parse(payload(employmentRow));
      validateResourcePayload({ ...target, kind: "employment_policy", entity: profile.employmentTypeId }, month, employment, {});
      if (policy.status !== "complete" || config.status !== "complete") { uncheckedContracts++; continue; }
      validateResourcePayload({ ...target, team, staff: person.id, kind: "staff_contract", entity: person.id }, month, profile, {
        policy: payload(row("company_policy", company)), employment, config: payload(configRow),
      });
    } catch (error) { const issue = settingError(error); contracts.code = issue.code; contractIssues.add(issue.message); invalidContracts++; }
  }
  contracts.count = missingContracts + invalidContracts;
  contracts.status = invalidContracts ? "invalid" : missingContracts ? "missing" : !sources.staff.length || uncheckedContracts ? "unconfirmed" : "complete";
  contracts.message = missingContracts || invalidContracts ? `${sources.staff.length}名中、契約または雇用区分が未登録の方が${missingContracts}名、要修正が${invalidContracts}名います。` : contracts.status === "complete" ? "計算対象者全員の契約・雇用区分を確認しました。" : "共通ルール・チーム設定・スタッフを登録すると確認できます。";
  if (contractIssues.size) contracts.message += " " + [...contractIssues].join(" ");
  const plan = item("planning", "demand");
  const planRow = row("planning", team);
  if (!planRow) { plan.status = "missing"; plan.message = "対象月の需要・予定が未保存です。入力がない場合も保存してください。"; }
  else if (config.status === "complete") check(plan, true, () => {
    const value = planning.parse(payload(planRow));
    validateResourcePayload({ ...target, team, kind: "planning", entity: team }, month, value, {
      config: payload(configRow), members: [...sources.staff.map(s => s.id), ...(sources.inactiveStaff ?? [])],
    });
    plan.count = value.demand.length;
  }, "対象月の需要・予定を保存済みです。", "");
  if (plan.status === "complete") {
    const coverage = demandCoverage(month, companyPolicy.parse(payload(row("company_policy", company))).contract,
      storedTeamConfig.parse(payload(configRow)), planning.parse(payload(planRow)).demand);
    plan.demandCoverage = coverage;
    if (coverage.missingSlots) {
      plan.status = "warning"; plan.code = "DEMAND_COVERAGE_MISSING";
      plan.message = `企業共通の勤務可能曜日・時間帯に対応する需要${coverage.expectedSlots}枠中、${coverage.missingSlots}枠が未登録です。不要な枠も0人を明示してください。計算は可能ですが、入力漏れを確認してください。`;
    } else plan.message = "企業共通の勤務可能曜日・時間帯に対応する全一般業務の需要と予定を確認しました。";
  }
  const consistency = item("consistency", "schedule");
  const history = item("history", "history", false);
  history.message = "入力条件を組み立てられると、必要な勤務履歴を確認できます。他の未登録・要修正項目を確認してください。";
  const preferences = item("preferences", "submission", false);
  let submitted = 0;
  for (const person of sources.staff) {
    const monthly = row("staff_month", person.id);
    if (monthly) {
      try { staffMonth.parse(payload(monthly)); submitted++; }
      catch (error) { settingError(error); /* The compiler classifies this below. */ }
    }
  }
  preferences.status = "complete";
  preferences.message = `${sources.staff.length}名中${submitted}名が勤務不可・希望を保存済みです。未提出だけでは計算を止めません。`;
  const prerequisites = items.filter(next => next.required && next.id !== "consistency");
  if (!prerequisites.some(readinessBlocksCompute) && sources.calendar) {
    let fixed: Parameters<typeof compileInput>[5];
    let fixedRevision: number | undefined;
    if (initialHead?.draft_id) {
      const saved = await readDraft(env, company, team, user, initialHead.draft_id);
      if (saved.superseded || saved.draft.draftRevision !== initialHead.revision || saved.draft.month !== month)
        throw new ProductError("DRAFT_VERSION_CONFLICT");
      fixed = fixedDraftInput(saved.draft); fixedRevision = saved.draft.inputRevision;
    }
    try {
      const compiled = compileInput(company, team, month, crypto.randomUUID(), { ...sources, calendar: sources.calendar }, fixed, { fixedRevision, registrationValidation: false });
      const known = new Set((sources.history ?? []).map(h => h.staffId + ":" + h.date));
      const missing = requiredHistory(compiled.input).filter(h => !known.has(h.staffId + ":" + h.date));
      history.count = missing.length; history.status = missing.length ? "missing" : "complete";
      history.message = missing.length ? `${missing.length}人日が未確認です。参考案の計算は可能ですが、公開前に確認・再計算が必要です。` : "月境界の必要な勤務履歴を確認済みです。";
      validateCompiledInput(compiled.input, { fixedDays: true });
      consistency.status = "complete"; consistency.message = "計算入力の組み立てと既知の条件矛盾の確認が完了しました。";
    } catch (error) {
      const issue = settingError(error); Object.assign(consistency, { status: "invalid", ...issue });
      if (issue.code === "EVENT_ATTENDANCE_CONFLICT" || issue.code === "OVERLAPPING_EVENT" || issue.code === "UNKNOWN_STAFF") consistency.section = "demand";
      else if (["CONTRADICTORY_CONTRACT", "CONTRADICTORY_RULE", "UNKNOWN_SKILL_OR_ROLE", "CAPACITY_NOT_CONFIGURED"].includes(issue.code)) consistency.section = "staff";
      else if (["ROLE_POLICY_NOT_CONFIGURED", "PUBLISHED_PATTERN_MISSING", "PUBLISHED_PATTERN_CONFLICT"].includes(issue.code)) consistency.section = "team";
    }
  }
  const finalHead = await head();
  await requireManager(db, company, team, user);
  if ((await db.prepare("SELECT revision FROM company WHERE id=?").bind(company).first<number>("revision")) !== sources.revision)
    throw new ProductError("VERSION_CONFLICT");
  if ((finalHead?.revision ?? 0) !== (initialHead?.revision ?? 0) || (finalHead?.draft_id ?? null) !== (initialHead?.draft_id ?? null))
    throw new ProductError("DRAFT_VERSION_CONFLICT");
  return readinessResponse.parse({ companyId: company, teamId: team, month, inputRevision: sources.revision,
    draftRevision: initialHead?.revision ?? 0, canCompute: !items.some(readinessBlocksCompute), items });
}
