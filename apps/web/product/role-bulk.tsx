import { BulkDisclosure } from "./bulk-disclosure";
import { useState } from "react";
import { Button, Field, InfoHelp, Input, NativeSelect, TimeInput } from "./components/ui";
import { buildRoleBulk, emptyRoleBulk, RoleBulkOverlap, type RoleBulkInput } from "./role-bulk-model";
import type { RoleDraft } from "./planning-model";
import type { Config } from "./setup-model";
import { settingHelp } from "./setting-help";

const errors: Record<string, string> = {
  OUTSIDE_MONTH: "開始日・終了日は対象月の有効な日付を選択してください。",
  REVERSED_DATE_RANGE: "終了日は開始日以降を選択してください。",
  WEEKDAYS_REQUIRED: "対象の曜日を1つ以上選択してください。",
  NO_MATCHING_DAYS: "指定期間に対象の曜日がありません。期間または曜日を変更してください。",
  INVALID_TIME: "毎日の開始・終了を数字4桁のHHMMで入力してください。",
  EMPTY_OR_REVERSED_INTERVAL: "毎日の終了は開始より後にしてください。日付をまたぐ登録はできません。",
  INVALID_ROLE_TIME: "担当区分の条件の開始・終了は30分単位で入力してください。",
  ROLE_SCOPE_REQUIRED: "担当区分の条件の対象範囲を選択してください。",
  ROLE_REQUIRED: "担当区分を選択してください。",
  INTEGER_REQUIRED: "最低人数と比率は空欄にせず、非負の整数を入力してください。",
  INVALID_ROLE_COUNTS: "最低人数は0〜500、比率の分子は0〜10000、分母は1〜10000で入力してください。",
  INVALID_EXISTING_ROLE_TIME: "既存の担当区分の条件に不正な時間帯があります。個別入力を確認してください。",
};

export function RoleBulk({ rows, config, month, nameOf, apply, pending }: {
  rows: RoleDraft[]; config: Config; month: string; nameOf: (id: string) => string;
  apply: (rows: RoleDraft[]) => void; pending: (value: boolean) => void;
}) {
  const [input, setInput] = useState(() => emptyRoleBulk(month));
  const [preview, setPreview] = useState<{ source: RoleDraft[]; result: ReturnType<typeof buildRoleBulk> } | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const change = (patch: Partial<RoleBulkInput>) => {
    setInput(old => ({ ...old, ...patch })); setPreview(null); setError(""); setNotice(""); pending(true);
  };
  const result = preview?.source === rows ? preview.result : null;
  const reset = () => { setInput(emptyRoleBulk(month)); setPreview(null); setError(""); pending(false); };
  const weekdayHelp = settingHelp("担当区分一括入力 対象曜日");
  if (!config.roles.length || !config.rolePolicies.length) return null;
  return <section className="setup-row" aria-label="担当区分の条件の一括入力">
    <BulkDisclosure title="期間を指定して担当区分の条件を一括入力">
    <p className="muted">指定期間の各日へ、同じ対象範囲・担当区分・最低人数・比率を入力します。毎日の時間帯を1件の担当区分の条件として追加します。反映後に「担当区分の必要人数を保存」で登録してください。</p>
    <div className="form-grid">
      {(["from", "through"] as const).map(key => <Field key={key} title={key === "from" ? "担当区分一括入力 開始日" : "担当区分一括入力 終了日"}>
        <Input type="date" min={month + "-01"} max={emptyRoleBulk(month).through} value={input[key]} onChange={e => change({ [key]: e.target.value })} />
      </Field>)}
      <Field title="担当区分一括入力 毎日の開始"><TimeInput value={input.start} stepMinutes={30} allowEndOfDay={false} onValueChange={start => change({ start })} /></Field>
      <Field title="担当区分一括入力 毎日の終了"><TimeInput value={input.end} stepMinutes={30} onValueChange={end => change({ end })} /></Field>
      <Field title="担当区分一括入力 対象範囲"><NativeSelect value={input.scope} onChange={e => change({ scope: e.target.value })}>
        <option value="">選択してください</option>{config.rolePolicies.map(p => <option key={JSON.stringify(p.taskId)} value={JSON.stringify(p.taskId)}>{p.taskId === null ? "チーム全体" : nameOf(p.taskId)}</option>)}
      </NativeSelect></Field>
      <Field title="担当区分一括入力 担当区分"><NativeSelect value={input.roleId} onChange={e => change({ roleId: e.target.value })}>
        <option value="">選択してください</option>{config.roles.map(r => <option key={r.id} value={r.id}>{nameOf(r.id)}</option>)}
      </NativeSelect></Field>
      {([ ["minimum", "最低人数", 0, 500], ["numerator", "比率の分子", 0, 10000], ["denominator", "比率の分母", 1, 10000] ] as const).map(([key, title, min, max]) => <Field key={key} title={`担当区分一括入力 ${title}`}>
        <Input type="number" min={min} max={max} step={1} value={input[key]} onChange={e => change({ [key]: e.target.value })} />
      </Field>)}
      <Field title="担当区分一括入力 既存の条件"><NativeSelect value={input.existing} onChange={e => change({ existing: e.target.value as RoleBulkInput["existing"] })}>
        <option value="keep">同じ時間帯の条件を保持（未登録だけ追加）</option><option value="replace">同じ時間帯の最低人数・比率を上書き</option>
      </NativeSelect></Field>
    </div>
    <p className="muted">同じ対象範囲・担当区分で一部だけ時間が重なる既存条件は、個別編集で調整してください。比率を使わない場合は分子0・分母1を入力します。</p>
    <fieldset className="participant-options"><legend className="setting-heading">担当区分一括入力 対象曜日{weekdayHelp && <InfoHelp title="担当区分一括入力 対象曜日">{weekdayHelp}</InfoHelp>}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {["日", "月", "火", "水", "木", "金", "土"].map((label, day) => <label className="flex min-h-11 items-center gap-2" key={day}><Input type="checkbox" checked={input.weekdays.includes(day)} onChange={e => change({ weekdays: e.target.checked ? [...input.weekdays, day] : input.weekdays.filter(d => d !== day) })} />{label}曜日</label>)}
      </div>
    </fieldset>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="form-actions">
      <Button type="button" onClick={() => {
        setError(""); setNotice("");
        try { setPreview({ source: rows, result: buildRoleBulk(rows, input, config, month) }); }
        catch (e) {
          setPreview(null);
          setError(e instanceof RoleBulkOverlap ? `${e.date}の${e.start}〜${e.end}の既存条件と時間帯が重なります。同じ時間帯を指定するか、個別編集で調整してください。` : errors[e instanceof Error ? e.message : ""] ?? "担当区分の一括入力を確認してください。");
        }
      }}>担当区分一括入力の対象を確認</Button>
      <Button type="button" onClick={() => { reset(); setNotice(""); }}>担当区分一括入力をリセット</Button>
    </div>
    {result && <div role="status">
      <p>{input.from}〜{input.through}／{input.start}〜{input.end}／{input.scope === "null" ? "チーム全体" : nameOf(JSON.parse(input.scope))}／{nameOf(input.roleId)}／最低{input.minimum}人・比率{input.numerator}/{input.denominator}</p>
      <p>対象{result.days}日：追加{result.added}件、上書き{result.updated}件、保持{result.kept}件</p>
      <Button type="button" disabled={result.added + result.updated === 0} onClick={() => {
        apply(result.roles); reset(); setNotice(`担当区分の条件の追加${result.added}件、上書き${result.updated}件を入力に反映しました。「担当区分の必要人数を保存」で登録してください。`);
      }}>担当区分一括入力を反映</Button>
    </div>}
    </BulkDisclosure>
  </section>;
}
