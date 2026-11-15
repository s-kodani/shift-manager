import { z } from "zod";
import {
  optimizerInputSchema,
  optimizerAssignmentsSchema,
} from "../../../packages/contracts/optimizer-input.generated";
export {
  storedCompanyPolicy as companyPolicy,
  companyPolicy as companyPolicyInput,
  employmentPolicy,
  staffContract,
  teamConfig,
  planning,
} from "../../api/src/input-contracts";
const uuid = z.string().uuid();
export const contextSchema = z.object({
  userId: z.string(),
  companies: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      revision: z.number(),
      role: z.enum(["company_admin", "team_admin", "staff"]),
      teams: z.array(
        z.object({
          id: uuid,
          name: z.string(),
          role: z.enum(["team_admin", "staff"]).nullable(),
          staff_id: uuid.nullable(),
        }),
      ),
    }),
  ),
});
export type Context = z.infer<typeof contextSchema>;
export const staffSchema = z.object({
  staff: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      staff_number: z.string(),
      user_id: z.string(),
      role: z.enum(["team_admin", "staff"]).nullable(),
      status: z.enum(["active", "inactive"]).optional(),
      can_manage_status: z.union([z.literal(0), z.literal(1)]).optional(),
    }),
  ),
});
export type Staff = z.infer<typeof staffSchema>["staff"];
export const identitySchema = z.object({
  userId: z.string(),
  mustChange: z.boolean(),
});
export const jobSchema = z.object({
  id: uuid,
  state: z.enum([
    "QUEUED",
    "RUNNING",
    "CANCELLING",
    "SUCCEEDED",
    "NO_SOLUTION",
    "STALE",
    "FAILED",
    "CANCELLED",
  ]),
  attempt: z.number(),
  snapshot_id: uuid,
  input_revision: z.number(),
  solver_status: z.string().nullable(),
  validation_status: z.string().nullable(),
  failure_code: z.string().nullable(),
  stale: z.boolean().optional(),
  created_at: z.number(),
  attempts: z
    .array(
      z.object({
        attempt: z.number(),
        final_state: z.string().nullable(),
        failure_code: z.string().nullable(),
      }),
    )
    .optional(),
});
export type Job = z.infer<typeof jobSchema>;
export const resultSchema = z.object({
  stale: z.boolean(),
  publication: z.literal("BLOCKED_A1"),
  result: z.object({
    jobId: uuid,
    month: z.string(),
    solverStatus: z.string(),
    assignments: optimizerAssignmentsSchema.nullable(),
    validation: z.object({
      status: z.string(),
      violations: z.array(z.string()),
      missingHistory: z.array(z.string()).optional(),
      preferences: z.array(z.object({ fulfilled: z.boolean() })).optional(),
      generalShortage: z.number().optional(),
      roleSameShortage: z.number().optional(),
      roleRequirements: z
        .array(z.object({ id: z.string(), shortagePersonMinutes: z.number() }))
        .optional(),
      intervals: z
        .array(
          z.object({
            date: z.string(),
            start: z.number(),
            end: z.number(),
            taskId: z.string(),
            shortage: z.number(),
          }),
        )
        .optional(),
    }),
    stages: z.array(
      z.object({
        name: z.string(),
        status: z.string(),
        finalValue: z.number().optional(),
      }),
    ),
    publication: z.literal("BLOCKED_A1"),
  }),
});
export type Result = z.infer<typeof resultSchema>;
export type ScheduleView = {
  stale: boolean;
  publication: "BLOCKED_A1";
  manual?: boolean;
  result: Pick<Result["result"], "assignments" | "validation"> &
    Partial<Pick<Result["result"], "solverStatus" | "stages">>;
};
export const draftBodySchema = z.object({
  draftId: uuid,
  month: z.string(),
  sourceJobId: uuid,
  snapshotId: uuid,
  inputRevision: z.number().int(),
  draftRevision: z.number().int(),
  origin: z.literal("manual"),
  assignments: optimizerAssignmentsSchema,
  locks: optimizerInputSchema.shape.locks,
  exceptions: optimizerInputSchema.shape.exceptions,
  validation: resultSchema.shape.result.shape.validation,
  publication: z.literal("BLOCKED_A1"),
});
export const draftHeadSchema = z.object({
  draftRevision: z.number().int(),
  draft: draftBodySchema.nullable(),
  stale: z.boolean().optional(),
  superseded: z.boolean().optional(),
});
export type DraftHead = z.infer<typeof draftHeadSchema>;
export const frozenSchema = z.object({
  input: optimizerInputSchema,
  stale: z.boolean(),
  draftSource: z
    .object({ draftId: uuid, draftRevision: z.number().int() })
    .nullable()
    .optional(),
  publication: z.literal("NOT_EVALUATED"),
});
export type Frozen = z.infer<typeof frozenSchema>;
const messages: Record<string, string> = {
  CANCELLATION_NOT_VERIFIED:'履歴不足または必須条件違反のため、勤務取消を確定していません。条件・固定・勤務量・休憩を確認してください。',
  CANCELLATION_PUBLICATION_CONFLICT:'元の公開勤務または取消の版が変わっています。最新の公開勤務と受付を読み直してください。',
  CANCELLATION_COMMIT_CONFLICT:'取消の確定中に条件・権限・公開版が変わりました。最新の状態を読み直してください。',
  SUBMISSION_CLOSED: '勤務不可・希望の受付は終了しています。管理者が受付を再開した期間に変更してください。保存はしていません。',
  SUBMISSION_CALENDAR_CONFLICT: '提出期限の設定が変わりました。最新の受付情報を読み直してください。',
  SUBMISSION_WINDOW_CONFLICT: '別の受付再開・終了が記録されています。最新の受付情報を読み直してください。',
  SUBMISSION_WINDOW_EXPIRED: '受付終了日時は現在より後の日本時間で指定してください。',
  LEAVE_FIXED_RELEASE_REQUIRED:
    "対象勤務の明示固定が残っています。公開勤務の画面で管理者が解除してから確認してください。",
  LEAVE_FORBIDDEN:
    "本人の申請、または担当チームの欠勤事実だけを登録できます。現在の権限を確認してください。",
  LEAVE_PUBLICATION_CONFLICT:
    "対象の公開勤務が更新されています。最新の勤務を読み直してください。",
  LEAVE_CALENDAR_CONFLICT:
    "半日の区切りなどの企業設定が更新されています。最新の設定を読み直してください。",
  LEAVE_VERSION_CONFLICT:
    "申請はすでに処理されています。最新の受付履歴を読み直してください。",
  LEAVE_OVERLAP:
    "同じ勤務範囲の受付が残っています。受付履歴を確認してください。",
  LEAVE_EMPTY_WORK:
    "指定した範囲に残る勤務がありません。対象勤務と全日・午前・午後の選択を確認してください。",
  LEAVE_FUTURE_FACT:
    "欠勤事実には、実際に発生した日を指定してください。将来日の欠勤予定は本人申請として扱います。",
  PUBLICATION_NOT_VERIFIED:
    "履歴不足または必須条件違反のため公開していません。条件を確認して再計算してください。",
  PUBLICATION_SHORTAGE_ACK_REQUIRED:
    "必要人数・担当区分の不足が残っています。不足を確認してから公開してください。",
  PUBLICATION_VERSION_CONFLICT:
    "公開版が更新されています。最新の公開版を読み直してください。",
  PUBLICATION_SOURCE_NOT_READY:
    "公開対象の案が未完了または古くなっています。最新の入力・編集案で再計算してください。",
  PUBLISHED_HISTORY_READ_ONLY:
    "公開済み勤務は履歴入力から変更できません。公開済み勤務を参照してください。",
  PUBLISHED_PATTERN_MISSING:
    "公開済み勤務のパターンが現在の設定にありません。出退勤・休憩を維持できる設定を確認してください。",
  DRAFT_INVALID:
    "必須条件に違反しているため保存していません。下の検証結果を確認してください。",
  DRAFT_VERSION_CONFLICT:
    "別の編集・固定／解除が保存されています。最新の編集案を再読込してください。",
  DRAFT_SOURCE_REQUIRED: "保存済み編集案の固定を参照して再計算してください。",
  PUBLISHED_FIXED_RELEASE_REQUIRED:
    "公開勤務の固定が残っています。公開済み勤務の『明示固定』で解除してください。",
  PUBLISHED_FIXED_SOURCE_REQUIRED:
    "公開時の固定証跡を読み直してから操作してください。",
  FIXED_RELEASE_VERSION_CONFLICT:
    "入力が更新されています。最新の公開勤務・固定を読み直してください。",
  FIXED_RELEASE_PUBLICATION_CONFLICT:
    "公開版が更新されています。現在の公開版の固定を確認してください。",
  FIXED_RELEASE_PART_NOT_FIXED:
    "選択した対象は固定されていません。最新の固定を確認してください。",
  FIXED_RELEASE_COMMIT_CONFLICT:
    "固定解除が競合しました。最新の入力と公開版を読み直してください。",
  FIXED_RELEASE_FORBIDDEN: "このチームの固定を解除する権限がありません。",
  CHECK_BUSY:
    "このチームの計算・検証が進行中です。終了後に同じ操作を再試行してください。",
  CSV_TOO_LARGE: "CSVは1MB以内にしてください。",
  CSV_INVALID_ENCODING:
    "UTF-8のCSVを使用してください。文字コードを推測して変換しません。",
  CSV_INVALID_QUOTES:
    "CSVの引用符が不正です。閉じ忘れや引用符の位置を確認してください。",
  CSV_INVALID_HEADER:
    "CSVの列見出しをテンプレートに合わせてください。列順は変更できます。",
  CSV_EMPTY: "CSVが空です。",
  CSV_EMPTY_ROWS: "CSVに取り込み行がありません。",
  CSV_TOO_MANY_ROWS: "CSVのデータ行は10,000行以内にしてください。",
  CSV_TOO_MANY_COLUMNS: "CSVの列数を確認してください。",
  CSV_CELL_TOO_LONG: "CSVのセルが長すぎます。",
  CSV_PREVIEW_MISMATCH:
    "プレビューと反映内容が一致しません。ファイルを読み直してください。",
  CSV_NO_VALID_ROWS:
    "正常な取り込み行がありません。ファイルを修正してください。",
  STAFF_CSV_TOO_MANY_ROWS: "スタッフCSVは100行以内に分けてください。",
  CSV_PREVIEW_CHANGED: "プレビュー後に参照情報が変わりました。最新条件で確認し直してください。",
  COPY_FAILED: "コピーできませんでした。ブラウザのコピー許可を確認してください。",
  COMPANY_BREAK_RULE_NOT_CONFIGURED:
    "企業共通の休憩ルールが未設定です。企業管理者が対象月のルールを登録してください。",
  SNAPSHOT_REBUILD_REQUIRED:
    "企業共通の休憩ルールを反映するため、入力を再確認して新しい計算を開始してください。",
  UNAUTHENTICATED: "ログインしてください。",
  NO_ACTIVE_STAFF: "計算対象のアクティブなスタッフがいません。スタッフ管理で登録・再有効化してください。",
  USER_DISABLED: "このアカウントは停止されています。",
  BANNED_USER: "このアカウントは停止されています。",
  STAFF_STATUS_CONFLICT: "スタッフの状態が変更されています。再読込して確認してください。",
  STAFF_ACCOUNT_PROTECTED: "自分自身・企業管理者・他のチームと共有するアカウントは、この画面から停止・削除できません。",
  STAFF_DELETED: "削除済みのスタッフ番号です。別の番号を使用してください。",
  PASSWORD_CHANGE_REQUIRED: "初回パスワードを変更してください。",
  INVALID_EMAIL_OR_PASSWORD:
    "メールアドレスまたはパスワードを確認してください。",
  FORBIDDEN: "この操作の権限がありません。",
  NOTICE_UPDATE_FAILED: "お知らせを既読にできませんでした。もう一度お試しください。",
  VERSION_CONFLICT:
    "別の変更が保存されています。再読込して差分を確認してください。",
  TEAM_JOB_ACTIVE: "このチームは計算中です。終了までお待ちください。",
  ATTEMPT_CONFLICT: "計算の状態が変わりました。再読込してください。",
  INVALID_INPUT: "入力値・時刻・設定の組合せを確認してください。",
  INPUT_NOT_CONFIGURED:
    "対象月に必要な設定が未登録です。企業共通ルール、チーム設定、需要・予定、雇用区分、スタッフの契約を確認してください。",
  CALENDAR_NOT_CONFIGURED:
    "対象月に有効な企業カレンダーが未登録です。企業共通ルールで設定してください。",
  EVENT_ATTENDANCE_CONFLICT:
    "予定の全時間に参加できないスタッフがいます。勤務条件・勤務不可・固定休憩・取得可能な休憩時間を確認してください。入力は保存していません。",
  PUBLISHED_PATTERN_CONFLICT:
    "公開済み勤務と現在の勤務パターンの出退勤・休憩設定が一致していません。対象月の勤務パターンを公開時の設定に戻し、新しい設定は翌月以降に適用してください。公開後の再計算では出退勤・休憩を維持します。",
  OVERLAPPING_EVENT:
    "同じ参加者の研修・会議が重なっています。日時か参加者を調整してください。入力は保存していません。",
  OVERLAPPING_ROLE_REQUIREMENT:
    "同じ日・対象範囲・担当区分の条件が重なっています。時間帯を調整してください。入力は保存していません。",
  UNKNOWN_ROLE_REQUIREMENT_SCOPE:
    "担当区分または対象業務の設定が見つかりません。チーム設定を確認してください。",
  UNKNOWN_STAFF: "このチームに登録されたスタッフを選択してください。",
  HISTORY_OUTSIDE_BOUNDARY:
    "履歴の日付は対象月外の前後31日以内で指定してください。",
  INVALID_DEMAND_SLOT:
    "必要人数の開始時刻と長さをチームの配置枠に合わせてください。",
  DEMAND_UNSET:
    "直接必要人数と算出値が両方未設定の行があります。必要人数0は明示的に入力してください。",
  OUTSIDE_MONTH: "日付は対象月の範囲で指定してください。",
  DUPLICATE_INPUT:
    "同じ需要枠や同じ識別子の入力が重複しています。行を確認してください。",
  CONTRADICTORY_CONTRACT:
    "企業・雇用区分・個人の契約に共通する勤務曜日がありません。契約条件を確認してください。",
  EMPTY_OR_REVERSED_INTERVAL:
    "開始・終了の順序と、共通条件との時間帯の重なりを確認してください。",
  RESET_DELIVERY_NOT_CONFIGURED:
    "再設定メールの送信準備ができていません。管理者へお問い合わせください。",
  EXPLANATION_SOURCE_CONFLICT: "説明の根拠が更新されています。最新の根拠を確認してください。",
  NETWORK_UNCERTAIN:
    "応答を確認できませんでした。保存や受付が済んだ可能性があります。同じ操作を確認してください。",
  INTERNAL_ERROR:
    "サーバーで処理に失敗しました。保存・受付の結果を確認してから再試行してください。",
  INVALID_RESPONSE:
    "サーバーの応答形式を確認できませんでした。保存・受付の結果を確認してください。",
  MAINTENANCE_UNAVAILABLE:
    "保守作業中のため受付を停止しています。入力を保持したまま、再開後に同じ操作を確認してください。",
};
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    public violations: string[] = [],
    location?: { line?: number; column?: number },
    public retryAfter?:number,
  ) {
    super(
      (status===429?`操作の回数が上限に達しました。${retryAfter?`${retryAfter}秒後に`:"少し待ってから"}再試行してください。`:(messages[code] ??
        "処理を完了できませんでした。エラー情報を確認してください。")) +
        (status !== 429 && (!messages[code] || ["INTERNAL_ERROR", "INVALID_RESPONSE"].includes(code))
          ? `（エラーコード：${/^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "UNKNOWN"}／HTTP ${status}）`
          : "") +
        (location?.line
          ? `（${location.line}行${location.column ? `・${location.column}列` : ""}）`
          : ""),
    );
  }
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError("NETWORK_UNCERTAIN", 0);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError("NETWORK_UNCERTAIN", 0);
  }
  // A menu change can cancel a read after its body has already arrived.
  // Never validate or publish a response belonging to that cancelled read.
  signal?.throwIfAborted();
  if (!response.ok) {
    const retry=Number(response.headers.get('retry-after')??response.headers.get('x-retry-after'));
    const err = z
      .object({
        error: z.string().optional(),
        code: z.string().optional(),
        violations: z.array(z.string()).optional(),
        line: z.number().int().positive().optional(),
        column: z.number().int().positive().optional(),
      })
      .safeParse(data);
    throw new ApiError(
      err.success ? (err.data.error ?? err.data.code ?? "UNKNOWN") : "UNKNOWN",
      response.status,
      err.success ? (err.data.violations ?? []) : [],
      err.success
        ? { line: err.data.line, column: err.data.column }
        : undefined,
      response.status===429&&Number.isSafeInteger(retry)&&retry>0&&retry<=3600?retry:undefined,
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError("INVALID_RESPONSE", response.status);
  return parsed.data;
}
export const accepted = z.object({ job: jobSchema, replayed: z.boolean() });
export const mutationResult = z
  .object({
    revision: z.number(),
    initialPassword: z.string().nullable().optional(),
  })
  .passthrough();
export const snapshotResult = z
  .object({ snapshot: z.object({ id: uuid }).passthrough() })
  .passthrough();
