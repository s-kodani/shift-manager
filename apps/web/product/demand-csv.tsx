import { Button, Card, CardContent, Input, Loading, OperationBoundary, Table, TableCell, TableHead } from "./components/ui";
import { useUnsavedDraft, usePendingOperation } from "./unsaved-input";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from '@radix-ui/react-dialog';
import { z } from "zod";
import { api, ApiError } from "./api";
import { Field } from "./contract-forms";
import { coefficient, type Config } from "./setup-model";
import { clock } from "./planning-model";
import {
  demandCsvApply,
  demandCsvPreview,
  type DemandCsvPreview,
  type DemandCsvReceipt,
} from "../../api/src/demand-csv-contract";

const rowErrors: Record<string, string> = {
  CSV_COLUMN_COUNT: "列数が見出しと一致しません",
  CSV_INVALID_TIME: "HH:MMで入力してください",
  CSV_INVALID_DATE: "存在する日付をYYYY-MM-DDで入力してください",
  OUTSIDE_MONTH: "対象月の日付ではありません",
  INVALID_DEMAND_TASK: "対象チームの一般業務IDではありません",
  INVALID_DEMAND_SLOT: "チームの配置枠と一致しません",
  CSV_INVALID_NUMBER: "非負の整数・小数・分数で入力してください",
  CSV_INVALID_PRECISION: "指定精度で正確に表せません",
  CSV_NUMBER_OUT_OF_RANGE: "人数が入力上限を超えています",
  DEMAND_UNSET: "直接人数と算出値が両方未入力です",
  DUPLICATE_DEMAND: "日付・開始・業務がファイル内で重複しています",
};
export function DemandCsvResult({
  receipt,
}: {
  receipt: DemandCsvReceipt | null;
}) {
  const [visible, setVisible] = useState(50);
  useEffect(() => setVisible(50), [receipt?.id]);
  if (!receipt) return null;
  return (
    <Card className="panel" aria-labelledby="demand-csv-result-heading">
      <h2 id="demand-csv-result-heading">CSVの反映結果</h2>
      <CardContent className="panel-body">
        <p className="alert notice" role="status">
          正常 {receipt.importedRows}行を反映しました（追加 {receipt.added}
          ／置換 {receipt.replaced}）。エラー {receipt.rejectedRows}
          行は反映していません。
        </p>
        {receipt.errors.length > 0 && (
          <>
            <h3>反映しなかった行</h3>
            <ul>
              {receipt.errors.slice(0, visible).map((row) => (
                <li key={row.line}>
                  {row.line}行：
                  {row.errors
                    .map((e) => `${e.column}：${rowErrors[e.code] ?? e.code}`)
                    .join("、")}
                </li>
              ))}
            </ul>
            {receipt.errors.length > visible && (
              <Button onClick={() => setVisible((v) => v + 50)}>
                次の50行を表示
              </Button>
            )}
          </>
        )}
        <p className="muted">反映時の入力版 {receipt.revision}</p>
      </CardContent>
    </Card>
  );
}
export function DemandCsvImport({
  company,
  team,
  month,
  revision,
  config,
  disabled,
  dirty,
  report,
  apply,
  open,
  onOpenChange,
  feedback,
}: {
  company: string;
  team: string;
  month: string;
  revision: number;
  config: Config;
  disabled: boolean;
  dirty: boolean;
  report: (e: unknown) => void;
  apply: (
    command: z.infer<typeof demandCsvApply>,
    done: () => void,
  ) => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  feedback?: ReactNode;
}) {
  const [csv, setCsv] = useState(""),
    [name, setName] = useState(""),
    [preview, setPreview] = useState<DemandCsvPreview | null>(null),
    [loading, setLoading] = useState(false),
    [visible, setVisible] = useState(50),
    [error, setError] = useState(''),
    [applying, setApplying] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const csvInput = useUnsavedDraft(csv !== "");
  usePendingOperation(loading || applying);
  const controller = useRef<AbortController | null>(null),
    fileInput = useRef<HTMLInputElement | null>(null),
    lock = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  const clear = () => {
    setCsv("");
    setName("");
    setPreview(null);
    setError('');
    setVisible(50);
    if (fileInput.current) fileInput.current.value = "";
  };
  const read = async (file: File) => {
    if (lock.current) return;
    lock.current = true;
    setLoading(true);
    setError('');
    setPreview(null);
    const c = new AbortController();
    controller.current = c;
    try {
      if (file.size > 1_000_000) throw new ApiError("CSV_TOO_LARGE", 400);
      let text: string;
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(await file.arrayBuffer());
      } catch {
        throw new ApiError("CSV_INVALID_ENCODING", 400);
      }
      if (c.signal.aborted) return;
      const result = await api(
        `/companies/${company}/inputs/teams/${team}/demand-csv/preview`,
        demandCsvPreview,
        { month, expectedRevision: revision, csv: text },
        c.signal,
      );
      if (!c.signal.aborted) {
        setCsv(text);
        setName(file.name);
        setPreview(result);
        setVisible(50);
      }
    } catch (e) {
      if (!c.signal.aborted) {
        if (fileInput.current) fileInput.current.value = '';
        setError(e instanceof Error ? e.message : 'CSVを確認できませんでした。ファイルを確認して再試行してください。'); report(e);
      }
    } finally {
      lock.current = false;
      if (!c.signal.aborted) setLoading(false);
    }
  };
  const stale = !!preview && preview.inputRevision !== revision;
  const processing = loading || applying;
  return <Dialog.Root open={open} onOpenChange={value => { if (!processing && !disabled) onOpenChange(value); }}><Dialog.Portal>
    <Dialog.Overlay className="staff-dialog-overlay" />
    <Dialog.Content className="staff-dialog-content demand-csv-dialog" onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}>
    <div className="staff-dialog-heading"><div><Dialog.Title>需要CSVの取り込み</Dialog.Title><Dialog.Description>対象月 {month} の必要人数を、確認してから取り込みます。</Dialog.Description></div><Button type="button" aria-label="需要CSVの取り込みを閉じる" disabled={processing || disabled} onClick={() => onOpenChange(false)}>閉じる</Button></div>
    <div className="staff-dialog-body">{feedback}<OperationBoundary busy={processing}>{(
    <Card className="panel" aria-labelledby="demand-csv-heading">
      <h3 id="demand-csv-heading" className="sr-only">CSVの確認と反映</h3>
      <CardContent className="panel-body">
        <p className="form-intro">
          ファイルの内容を確認し、全件中止か正常行だけの反映を選びます。同じ日付・開始・業務の需要を置き換え、ほかの需要・研修・会議・担当区分の条件を保持します。
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <details>
          <summary>CSVの形式と業務ID</summary>
          <p>
            UTF-8、カンマ区切り、最大1MB・10,000行。時刻は日本時間のHH:MMです。30分／60分の配置枠を合わせてください。
          </p>
          <p>
            <code>date,start,end,task_id,direct,calculated</code>
          </p>
          <p>
            directは直接必要人数、calculatedは外部で算出した人数（どちらも人相当）。空欄は未設定、0は明示0です。両方ある場合はdirectを優先します。業務量からの人数算出は、この取り込みでは行いません。
          </p>
          <p>
            業務ID：
            {config.tasks
              .filter((t) => t.kind === "general")
              .map((t) => t.id)
              .join("、")}
          </p>
          <Button
            type="button"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  ["\ufeffdate,start,end,task_id,direct,calculated\r\n"],
                  { type: "text/csv;charset=utf-8" },
                ),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "demand-template.csv";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            列見出しのテンプレートを保存
          </Button>
        </details>
        {dirty && (
          <p className="alert warning">
            需要・予定フォームに未保存の変更があります。保存してからCSVを取り込んでください。
          </p>
        )}
        <Field title="需要CSVファイル">
          <Input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            disabled={disabled || dirty || processing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void read(file);
            }}
          />
        </Field>
        {loading && <Loading label="CSVを検証しています…" compact />}
        {preview && (
          <>
            <p role="status">
              {name}：正常 {preview.added + preview.replaced}行（追加{" "}
              {preview.added}／置換 {preview.replaced}）、エラー{" "}
              {preview.rows.length - preview.added - preview.replaced}
              行。まだ反映していません。
            </p>
            {stale && (
              <p className="alert warning">
                入力が更新されています。全件中止して同じファイルを読み直してください。
              </p>
            )}
            <div className="table-scroll">
              <Table aria-label="需要CSVプレビュー">
                <thead>
                  <tr>
                    <TableHead>行</TableHead>
                    <TableHead>日付・時刻・業務</TableHead>
                    <TableHead>直接／算出（人相当）</TableHead>
                    <TableHead>結果</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, visible).map((row) => (
                    <tr key={row.line}>
                      <TableHead scope="row">{row.line}</TableHead>
                      <TableCell>
                        {row.demand
                          ? `${row.demand.date} ${clock(row.demand.start)}〜${clock(row.demand.end)} ${row.demand.taskId}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {row.demand
                          ? [row.demand.direct, row.demand.calculated]
                              .map((v) =>
                                v === null
                                  ? "未設定"
                                  : coefficient(v, preview.capacityScale),
                              )
                              .join(" ／ ")
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {row.errors.length
                          ? row.errors.map((e) => (
                              <p key={e.column + e.code}>
                                {e.column}：{rowErrors[e.code] ?? e.code}
                              </p>
                            ))
                          : row.action === "ADD"
                            ? "追加"
                            : "置換"}
                      </TableCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            {preview.rows.length > visible && (
              <Button type="button" onClick={() => setVisible((v) => v + 50)}>
                次の50行を表示
              </Button>
            )}
            <div className="form-actions">
              <Button type="button" disabled={disabled || processing} onClick={clear}>全件中止</Button>
              <Button
                type="button"
                className="primary"
                disabled={
                  disabled ||
                  dirty ||
                  processing ||
                  stale ||
                  preview.added + preview.replaced === 0
                }
                onClick={() => csvInput.submit(() => {
                  if (lock.current) return;
                  lock.current = true;
                  const command = demandCsvApply.parse({
                    operationId: crypto.randomUUID(),
                    month,
                    expectedRevision: preview.inputRevision,
                    previewSha256: preview.previewSha256,
                    csv,
                  });
                  setApplying(true); setError('');
                  let completed = false;
                  void apply(command, () => { completed = true; clear(); }).then(() => {
                    if (!completed) setError('CSVの反映を確認できませんでした。画面のエラーを確認して再試行してください。');
                  }).catch(e => { setError('CSVの反映を確認できませんでした。再試行してください。'); report(e); }).finally(() => {
                    lock.current = false;
                    setApplying(false);
                  });
                })}
              >
                正常行だけ反映
              </Button>
            </div>
          </>
        )}
        {!preview && (csv || error) && <div className="form-actions"><Button type="button" disabled={disabled || processing} onClick={clear}>全件中止</Button></div>}
      </CardContent>
    </Card>
  )}</OperationBoundary></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
