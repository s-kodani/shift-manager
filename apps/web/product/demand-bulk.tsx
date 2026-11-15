import { BulkDisclosure } from "./bulk-disclosure";
import { useState } from "react";
import { Button, Field, InfoHelp, Input, NativeSelect, TimeInput } from "./components/ui";
import { buildDemandBulk, emptyDemandBulk, type DemandBulkInput } from "./demand-bulk-model";
import type { DemandDraft } from "./planning-model";
import type { Config } from "./setup-model";
import { settingHelp } from "./setting-help";

const errors: Record<string, string> = {
  OUTSIDE_MONTH: "開始日・終了日は対象月の有効な日付を選択してください。",
  REVERSED_DATE_RANGE: "終了日は開始日以降を選択してください。",
  WEEKDAYS_REQUIRED: "対象の曜日を1つ以上選択してください。",
  NO_MATCHING_DAYS: "指定期間に対象の曜日がありません。期間または曜日を変更してください。",
  INVALID_TIME: "毎日の開始・終了を数字4桁のHHMMで入力してください。",
  EMPTY_OR_REVERSED_INTERVAL: "毎日の終了は開始より後にしてください。日付をまたぐ登録はできません。",
  INVALID_DEMAND_SLOT: "開始・終了をチームの配置枠に合わせてください。",
  INVALID_DEMAND_TASK: "対象の業務を選択してください。",
  DEMAND_UNSET: "必要人数を入力してください。不要な枠は0を入力します。",
  INVALID_PRECISION: "必要人数は指定精度で正確に表せる非負の数、または分数で入力してください。",
  DEMAND_OUT_OF_RANGE: "必要人数が入力できる上限を超えています。",
};

export function DemandBulk({ rows, config, month, nameOf, apply, pending }: {
  rows: DemandDraft[]; config: Config; month: string; nameOf: (id: string) => string;
  apply: (rows: DemandDraft[]) => void; pending: (value: boolean) => void;
}) {
  const [input, setInput] = useState(() => emptyDemandBulk(month));
  const [preview, setPreview] = useState<{ source: DemandDraft[]; result: ReturnType<typeof buildDemandBulk> } | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const change = (patch: Partial<DemandBulkInput>) => {
    setInput(old => ({ ...old, ...patch })); setPreview(null); setError(""); setNotice(""); pending(true);
  };
  const result = preview?.source === rows ? preview.result : null;
  const reset = () => { setInput(emptyDemandBulk(month)); setPreview(null); setError(""); pending(false); };
  const weekdayHelp = settingHelp("一括入力 対象曜日");
  return <section className="setup-row" aria-label="需要の一括入力">
    <BulkDisclosure title="期間を指定して必要人数の一括入力">
    <p className="muted">指定期間の各日へ同じ必要人数を入力します。毎日の時間帯は{config.slotMinutes}分の配置枠に分けます。反映後に「必要人数を保存」で登録してください。</p>
    <div className="form-grid">
      {(["from", "through"] as const).map(key => <Field key={key} title={key === "from" ? "一括入力 開始日" : "一括入力 終了日"}>
        <Input type="date" min={month + "-01"} max={emptyDemandBulk(month).through} value={input[key]} onChange={e => change({ [key]: e.target.value })} />
      </Field>)}
      <Field title="一括入力 毎日の開始"><TimeInput value={input.start} stepMinutes={config.slotMinutes} allowEndOfDay={false} onValueChange={start => change({ start })} /></Field>
      <Field title="一括入力 毎日の終了"><TimeInput value={input.end} stepMinutes={config.slotMinutes} onValueChange={end => change({ end })} /></Field>
      <Field title="一括入力 業務"><NativeSelect value={input.taskId} onChange={e => change({ taskId: e.target.value })}>
        <option value="">選択してください</option>{config.tasks.filter(t => t.kind === "general").map(t => <option key={t.id} value={t.id}>{nameOf(t.id)}</option>)}
      </NativeSelect></Field>
      <Field title="一括入力 直接必要人数"><Input inputMode="decimal" value={input.direct} onChange={e => change({ direct: e.target.value })} /></Field>
      <Field title="一括入力 既存の枠"><NativeSelect value={input.existing} onChange={e => change({ existing: e.target.value as DemandBulkInput["existing"] })}>
        <option value="keep">既存の枠を保持（未登録だけ追加）</option><option value="replace">直接必要人数を上書き（算出値は保持）</option>
      </NativeSelect></Field>
    </div>
    <fieldset className="participant-options"><legend className="setting-heading">一括入力 対象曜日{weekdayHelp && <InfoHelp title="一括入力 対象曜日">{weekdayHelp}</InfoHelp>}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {["日", "月", "火", "水", "木", "金", "土"].map((label, day) => <label className="flex min-h-11 items-center gap-2" key={day}><Input type="checkbox" checked={input.weekdays.includes(day)} onChange={e => change({ weekdays: e.target.checked ? [...input.weekdays, day] : input.weekdays.filter(d => d !== day) })} />{label}曜日</label>)}
      </div>
    </fieldset>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="actions">
      <Button type="button" onClick={() => {
        setError(""); setNotice("");
        try { setPreview({ source: rows, result: buildDemandBulk(rows, input, config, month) }); }
        catch (e) { setPreview(null); setError(errors[e instanceof Error ? e.message : ""] ?? "一括入力の条件を確認してください。"); }
      }}>一括入力の対象を確認</Button>
      <Button type="button" onClick={() => { reset(); setNotice(""); }}>一括入力をリセット</Button>
    </div>
    {result && <div role="status">
      <p>{input.from}〜{input.through}／{input.start}〜{input.end}／{nameOf(input.taskId)}／{input.direct}人相当</p>
      <p>対象{result.days}日・{result.total}枠：追加{result.added}件、上書き{result.updated}件、保持{result.kept}件</p>
      <Button type="button" disabled={result.added + result.updated === 0} onClick={() => {
        apply(result.demand); reset(); setNotice(`追加${result.added}件、上書き${result.updated}件を入力に反映しました。「必要人数を保存」で登録してください。`);
      }}>一括入力を反映</Button>
    </div>}
    </BulkDisclosure>
  </section>;
}
