import { Alert, Button, Card, CardContent, Input, Loading, OperationBoundary, Table, TableCell, TableHead } from "./components/ui";
import { useUnsavedDraft, usePendingOperation } from "./unsaved-input";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  api,
  ApiError,
  employmentPolicy,
  companyPolicy,
  type teamConfig,
} from "./api";
import { Field } from "./contract-forms";
import {
  staffCsvColumns,
  staffCsvPreview,
  staffCsvResponse,
  type StaffCsvPreview,
} from "../../api/src/staff-csv-contract";
type Response = z.infer<typeof staffCsvResponse>;
type Command = {
  month: string;
  expectedRevision: number;
  csv: string;
  operationId: string;
  previewSha256: string;
};
const optionsSchema = z.object({
  policy: companyPolicy.nullable(),
  employment: z.array(z.object({ id: z.string(), payload: employmentPolicy })),
});
const messages: Record<string, string> = {
  INVALID_INPUT: "値の形式・範囲を確認してください",
  CSV_COLUMN_COUNT: "列数が見出しと一致しません",
  CSV_INVALID_INTEGER: "整数を入力してください",
  CSV_INVALID_TIME: "時刻はHH:MMで入力してください",
  CSV_TIME_NOT_ALIGNED: "出退勤時刻は30分単位で入力してください",
  STAFF_OUTSIDE_TEAM: "この番号は別チームに所属しています",
  STAFF_DELETED: "削除済みのスタッフ番号です。別の番号を使用してください",
  SHARED_ACCOUNT_REQUIRES_REVIEW:
    "ほかの担当範囲でも使うアカウントです。個別に確認してください",
  EMAIL_IN_USE: "このメールは別のアカウントで使用されています",
  DUPLICATE_STAFF_NUMBER: "番号がファイル内で重複しています",
  DUPLICATE_EMAIL: "メールがファイル内で重複しています",
  UNKNOWN_EMPLOYMENT_TYPE: "対象月の雇用区分がありません",
  UNKNOWN_SKILL_OR_ROLE: "業務・習熟度・対応可能な担当を確認してください",
  CONTRADICTORY_CONTRACT: "企業・雇用区分と勤務可能範囲が重なりません",
  CONTRADICTORY_RULE: "月最低時間が最大時間を超えています",
};
const quote = (s: unknown) => '"' + String(s).replaceAll('"', '""') + '"';
const clock = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
export function StaffCsvImport({
  company,
  team,
  month,
  revision,
  config,
  disabled,
  report,
  apply,
  dirty,
  discard,
}: {
  company: string;
  team: string;
  month: string;
  revision: number;
  config: z.infer<typeof teamConfig> | null;
  disabled: boolean;
  report: (e: unknown) => void;
  apply: (c: Command, done: (r: Response) => void) => Promise<void>;
  dirty: boolean;
  discard: () => void;
}) {
  const [optionsLoading, setOptionsLoading] = useState(true), [optionsError, setOptionsError] = useState(false);
  const [csv, setCsv] = useState(""),
    [name, setName] = useState(""),
    [preview, setPreview] = useState<StaffCsvPreview | null>(null),
    [result, setResult] = useState<Response | null>(null),
    [loading, setLoading] = useState(false),
    [options, setOptions] = useState<z.infer<typeof optionsSchema> | null>(
      null,
    ),
    [visible, setVisible] = useState(50);
  const csvInput = useUnsavedDraft(csv !== "");
  usePendingOperation(loading);
  const file = useRef<HTMLInputElement | null>(null),
    generation = useRef(0),
    lock = useRef(false);
  const base = `/companies/${company}/inputs/teams/${team}`;
  useEffect(() => {
    const own = ++generation.current,
      controller = new AbortController();
    setPreview(null);
    setCsv("");
    setName("");
    setResult(null);
    setOptions(null);
    setOptionsLoading(true); setOptionsError(false);
    api(
      base + "/contract-options/" + month,
      optionsSchema,
      undefined,
      controller.signal,
    )
      .then((x) => {
        if (own === generation.current) setOptions(x);
      })
      .catch((e) => {
        if (!controller.signal.aborted) { setOptionsError(true); report(e); }
      }).finally(() => { if (!controller.signal.aborted) setOptionsLoading(false); });
    return () => {
      ++generation.current;
      controller.abort();
    };
  }, [company, team, month]);
  useEffect(() => {
    setPreview(null);
  }, [revision]);
  const busy = disabled || loading || dirty;
  const clear = () => {
    setPreview(null);
    setCsv("");
    setName("");
    setVisible(50);
    if (file.current) file.current.value = "";
  };
  function template() {
    if (!config || !options?.policy || !options.employment.length) return;
    const e = options.employment[0],
      p = options.policy;
    const start = Math.max(p.contract.start, e.payload.contract.start),
      end = Math.min(p.contract.end, e.payload.contract.end);
    const values = [
      "新しいスタッフ番号",
      "架空スタッフ",
      "replace-me@example.invalid",
      e.id,
      p.contract.weekdays
        .filter((d) => e.payload.contract.weekdays.includes(d))
        .join(";"),
      clock(start),
      clock(end),
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      JSON.stringify(
        config.tasks.map((t) => ({ taskId: t.id, level: t.minimumLevel })),
      ),
      JSON.stringify([]),
    ];
    const blob = new Blob(
      [
        "\ufeff" +
          staffCsvColumns.join(",") +
          "\r\n" +
          values.map(quote).join(",") +
          "\r\n",
      ],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "staff-contract-template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <OperationBoundary busy={loading}>{(
    <Card className="panel" aria-labelledby="staff-csv-title">
      <h2 id="staff-csv-title">スタッフ・契約・スキルCSV</h2>
      <CardContent className="panel-body">
        {loading && <Loading label="CSVを読み込み・検証しています…" compact />}
        {optionsLoading && <Loading label="CSVの登録条件を読み込んでいます…" />}
        {optionsError && <p className="error" role="alert">CSVの登録条件を取得できませんでした。最新の入力を読み直してください。</p>}
        {dirty && (
          <Alert className="alert warning">
            <p>
              ほかのスタッフ・契約フォームに未保存の編集があります。先に保存するか、編集を破棄してからCSVを使ってください。
            </p>
            <Button disabled={disabled || loading} onClick={discard}>
              フォームの編集を破棄する
            </Button>
          </Alert>
        )}
        <p>
          企業内のスタッフ番号で照合します。既存スタッフの氏名・メールと、選択月からの契約・習熟度・対応可能な担当を更新します。別チームへの移動は行いません。
        </p>
        <p className="muted">
          メールを変更すると旧セッションと旧メール宛ての再設定リンクは失効します。既存パスワードと過去の契約は保持します。
        </p>
        <div className="form-actions">
          <Button
            type="button"
            disabled={busy || !options?.employment.length || !config}
            onClick={template}
          >
            CSVテンプレートを取得
          </Button>
        </div>
        <details>
          <summary>列の入力方法と登録済みの雇用区分</summary>
          <p>
            UTF-8、1MB・100行以内。列順は変更できます。テンプレートの架空氏名・メール・番号を置き換えてください。個人ルールの7列はすべて空欄なら追加ルールなし、指定する場合は全列を入力します。時間量は分、日数は整数です。
          </p>
          <p>
            weekdaysは0=日〜6=土を「;」で区切ります。skillsは業務IDと習熟度の配列、role_idsは対応可能な担当の担当区分IDの配列です。空の配列は[]と記入します。CSVでは引用符を二重にしてセルを囲みます。
          </p>
          <ul>
            {options?.employment.map((e) => (
              <li key={e.id}>
                {e.payload.name}：<code>{e.id}</code>
              </li>
            ))}
          </ul>
          <p>
            業務：{config?.tasks.map((t) => t.id).join("、")} ／ 対応可能な担当：
            {config?.roles.map((r) => r.id).join("、") || "なし"}
          </p>
        </details>
        <Field title="取り込みファイル">
          <Input
            ref={file}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={async (e) => {
              if (lock.current) return;
              lock.current = true;
              setLoading(true);
              setPreview(null);
              setResult(null);
              const own = generation.current;
              try {
                const selected = e.target.files?.[0];
                if (!selected) {
                  clear();
                  return;
                }
                if (selected.size > 1_000_000)
                  throw new ApiError("CSV_TOO_LARGE", 400);
                let text: string;
                try {
                  text = new TextDecoder("utf-8", { fatal: true }).decode(
                    await selected.arrayBuffer(),
                  );
                } catch {
                  throw new ApiError("CSV_INVALID_ENCODING", 400);
                }
                if (own === generation.current) {
                  setCsv(text);
                  setName(selected.name);
                }
              } catch (e) {
                if (own === generation.current) {
                  clear();
                  report(e);
                }
              } finally {
                lock.current = false;
                if (own === generation.current) setLoading(false);
              }
            }}
          />
        </Field>
        {name && <p>選択中：{name}</p>}
        <div className="form-actions">
          <Button
            disabled={busy || !csv || !!preview}
            onClick={async () => {
              if (lock.current) return;
              lock.current = true;
              setLoading(true);
              const own = generation.current;
              try {
                const p = await api(
                  base + "/staff-csv/preview",
                  staffCsvPreview,
                  { month, expectedRevision: revision, csv },
                );
                if (own === generation.current) {
                  setPreview(p);
                  setVisible(50);
                }
              } catch (e) {
                if (own === generation.current) report(e);
              } finally {
                lock.current = false;
                if (own === generation.current) setLoading(false);
              }
            }}
          >
            取り込み内容を確認
          </Button>
          {csv && (
            <Button disabled={busy} onClick={clear}>
              全件中止
            </Button>
          )}
        </div>
        {preview && (
          <>
            <h3>取り込みプレビュー</h3>
            <p role="status">
              追加 {preview.added}行 ／ 更新 {preview.updated}行 ／ エラー{" "}
              {preview.rows.filter((r) => r.errors.length).length}行
            </p>
            <div className="table-scroll">
              <Table className="staff-csv-preview">
                <thead>
                  <tr>
                    <TableHead>行</TableHead>
                    <TableHead>スタッフ番号・氏名</TableHead>
                    <TableHead>反映内容・診断</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, visible).map((r) => (
                    <tr key={r.line}>
                      <TableCell>{r.line}</TableCell>
                      <TableCell>
                        {r.person
                          ? `${r.person.staffNumber} · ${r.person.name}`
                          : "入力エラー"}
                      </TableCell>
                      <TableCell>
                        {r.errors.length
                          ? r.errors
                              .map(
                                (e) =>
                                  `${e.column}：${messages[e.code] ?? e.code}`,
                              )
                              .join(" ／ ")
                          : `${r.action === "ADD" ? "追加" : "更新"}：${r.person!.email} ／ 契約・スキル・対応可能な担当`}
                      </TableCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            {preview.rows.length > visible && (
              <Button onClick={() => setVisible((v) => v + 50)}>
                次の50行を表示
              </Button>
            )}
            <div className="form-actions">
              <Button
                className="primary"
                disabled={busy || preview.added + preview.updated === 0}
                onClick={() => csvInput.submit(async () => {
                  if (lock.current) return;
                  lock.current = true;
                  setLoading(true);
                  const own = generation.current;
                  try {
                    await apply(
                      {
                        month,
                        expectedRevision: revision,
                        csv,
                        operationId: crypto.randomUUID(),
                        previewSha256: preview.previewSha256,
                      },
                      (r) => {
                        if (own !== generation.current) return;
                        setResult(r);
                        clear();
                      },
                    );
                  } finally {
                    lock.current = false;
                    if (own === generation.current) setLoading(false);
                  }
                })}
              >
                正常行だけ反映
              </Button>
            </div>
          </>
        )}
        {result && (
          <>
            <h3>反映結果</h3>
            <p className="alert notice" role="status">
              追加 {result.receipt.added}行、更新 {result.receipt.updated}
              行。エラー {result.receipt.rejectedRows}
              行は反映していません。入力版 {result.receipt.revision}
            </p>
            {result.receipt.replayed && (
              <p>
                確定済みの同じ操作を読み直しました。初期パスワードは再表示しません。
              </p>
            )}
            <ul>
              {result.receipt.errors.map((r) => (
                <li key={r.line}>
                  {r.line}行：
                  {r.errors
                    .map((e) => `${e.column}：${messages[e.code] ?? e.code}`)
                    .join(" ／ ")}
                </li>
              ))}
            </ul>
            {result.initialPasswords.length > 0 && (
              <Alert className="alert">
                <div>
                  <h3>新規スタッフの初期パスワード</h3>
                  <p>
                    本人へ安全に渡してください。閉じると再表示できません。本人は初回変更が必要です。
                  </p>
                  {result.initialPasswords.map((p) => (
                    <div key={p.staffNumber} className="csv-credential">
                      <Field title={`スタッフ番号 ${p.staffNumber}`}>
                        <Input
                          type="password"
                          readOnly
                          autoComplete="off"
                          value={p.initialPassword}
                        />
                      </Field>
                      <div className="form-actions">
                        <Button
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(p.initialPassword)
                              .catch(() =>
                                report(new ApiError("COPY_FAILED", 0)),
                              )
                          }
                        >
                          パスワードをコピー
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <Button
                  onClick={() => setResult({ ...result, initialPasswords: [] })}
                >
                  パスワード表示を閉じる
                </Button>
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )}</OperationBoundary>;
}
