import { SettingHeading, Button, Card, CardContent, CardHeader, Input, Loading, NativeSelect } from "./components/ui";
import { UnsavedForm, useUnsavedInput } from "./unsaved-input";
import { useEffect, useRef, useState } from "react";
import { api, type Staff } from "./api";
import { historyResponse } from "../../api/src/history-contract";
import {
  historyRecords,
  type History,
  type HistoryRecords,
  type HistoryEntry,
} from "./history-model";
import { Field } from "./contract-forms";
import type { HistoryTarget } from "./publication-guidance";
export function HistoryManagement({
  company,
  team,
  month,
  revision,
  staff,
  initialTarget,
  disabled,
  report,
  save,
  syncContext,
}: {
  company: string;
  team: string;
  month: string;
  revision: number;
  staff: Staff;
  initialTarget?: HistoryTarget;
  disabled: boolean;
  report: (e: unknown) => void;
  syncContext: () => Promise<unknown>;
  save: (
    records: HistoryRecords,
    expectedRevision: number,
    clear: () => void,
  ) => Promise<void>;
}) {
  const [data, setData] = useState<History | null>(null),
    [person, setPerson] = useState(initialTarget?.staffId ?? ""),
    [entries, setEntries] = useState<Record<string, HistoryEntry>>({}),
    [extra, setExtra] = useState<string[]>([]),
    [date, setDate] = useState(""),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const dirty = useRef(false);
  const targetRow = useRef<HTMLDivElement | null>(null);
  const focused = useRef(false);
  const unsaved = useUnsavedInput();
  const stale = !!data && data.inputRevision !== revision;
  useEffect(() => {
    if (dirty.current) return;
    const c = new AbortController();
    setLoading(true);
    setLoadError(false);
    api(
      `/companies/${company}/inputs/teams/${team}/history/${month}`,
      historyResponse,
      undefined,
      c.signal,
    )
      .then(async (value) => {
        if (c.signal.aborted) return;
        setData(value);
        if (value.inputRevision !== revision) await syncContext();
      })
      .catch((e) => {
        if (!c.signal.aborted) { setLoadError(true); report(e); }
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [company, team, month, revision, refresh]);
  const people = new Map(staff.map(person => [person.id, `${person.name}（${person.staff_number}）`]));
  for (const record of [...(data?.required ?? []), ...(data?.records ?? [])])
    if (!people.has(record.staffId)) people.set(record.staffId, `当時のスタッフ（ID: ${record.staffId}）`);
  const selected = person || staff[0]?.id || people.keys().next().value || "";
  const key = (staffId: string, date: string) => `${staffId}:${date}`;
  const known = new Map(
    (data?.records ?? []).map((r) => [key(r.staffId, r.date), r]),
  );
  const days = [
    ...new Set([
      ...(data?.required
        .filter((r) => r.staffId === selected)
        .map((r) => r.date) ?? []),
      ...(data?.records
        .filter((r) => r.staffId === selected)
        .map((r) => r.date) ?? []),
      ...extra
        .filter((x) => x.startsWith(selected + ":"))
        .map((x) => x.slice(selected.length + 1)),
    ]),
  ].sort();
  useEffect(() => {
    if (focused.current || loading || !data || selected !== initialTarget?.staffId || !targetRow.current) return;
    focused.current = true;
    targetRow.current.focus({ preventScroll: true });
    targetRow.current.scrollIntoView({ block: "center" });
  }, [data, loading, selected, initialTarget?.staffId, initialTarget?.date]);
  function change(day: string, field: "minutes" | "evidence", value: string) {
    dirty.current = true;
    setEntries((old) => ({
      ...old,
      [key(selected, day)]: {
        ...(old[key(selected, day)] ?? {
          staffId: selected,
          date: day,
          minutes: "",
          evidence: "",
        }),
        [field]: value,
      },
    }));
  }
  return (
    <Card className="panel">
      <CardHeader className="panel-header">
        <SettingHeading title="月境界の勤務履歴" level={2} />
        <span className="muted">
          {data ? `未確認 ${data.missing.length}日` : loadError ? "取得失敗" : "読み込み中"}
        </span>
      </CardHeader>
      <CardContent className="panel-body">
        <p>
          週の勤務時間と連続勤務の確認に使います。休憩・取消を除き、研修・会議・準備・移動を含めた勤務時間(分)を入力してください。確認済みの休日は0分、未確認の日は空欄です。
        </p>
        <p>
          翌月の勤務は確定分だけを登録してください。履歴登録後は最新条件で再計算が必要です。
        </p>
        {initialTarget && <p className="muted">公開前の履歴不足から移動しました。対象：{people.get(initialTarget.staffId) ?? `ID: ${initialTarget.staffId}`} ／ {initialTarget.date}。現在の登録状況を確認して入力してください。</p>}
        {stale && (
          <p role="alert">
            入力が更新されています。編集中の内容を控えてから、最新履歴を読み直してください。
          </p>
        )}
        <div className="toolbar">
          <Button
            type="button"
            disabled={disabled || loading}
            onClick={async () => {
              if (!await unsaved.allow()) return;
              dirty.current = false;
              setEntries({});
              setExtra([]);
              setRefresh((r) => r + 1);
            }}
          >
            編集中の内容を破棄して最新履歴を読み直す
          </Button>
        </div>
        {loading && <Loading label="勤務履歴を読み込んでいます…" compact={!!data} />}
        {loadError && <p className="error" role="alert">勤務履歴を取得できませんでした。再読込してください。</p>}
        {data && selected && !people.has(selected) && <p role="alert">対象スタッフは現在の履歴対象に含まれていません。スタッフの状態と最新条件を確認し、シフトを再計算してください。</p>}
        {data && (
          <UnsavedForm dirty={Object.keys(entries).length > 0}
            onSubmit={(e) => {
              e.preventDefault();
              try {
                const records = historyRecords(Object.values(entries));
                void save(records, data.inputRevision, () => {
                  dirty.current = false;
                  setEntries({});
                  setRefresh((r) => r + 1);
                });
              } catch (error) {
                report(error);
              }
            }}
          >
            <fieldset disabled={disabled || loading || stale}>
              <Field title="履歴を確認するスタッフ">
                <NativeSelect
                  value={selected}
                  onChange={(e) => setPerson(e.target.value)}
                >
                  {selected && !people.has(selected) && <option value={selected}>履歴対象外（ID: {selected}）</option>}
                  {[...people].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {days.map((day) => {
                const k = key(selected, day),
                  r = known.get(k),
                  draft = entries[k];
                return (
                  <div className="history-row" key={k} role="group" aria-label={`${day}の勤務履歴`}
                    ref={selected === initialTarget?.staffId && day === initialTarget.date ? targetRow : undefined}
                    tabIndex={selected === initialTarget?.staffId && day === initialTarget.date ? -1 : undefined}
                    data-history-date={day}>
                    <div>
                      <strong>{day}</strong>
                      <p>
                        {r
                          ? `確認済み ${r.workedMinutes}分 ／ 入力版${r.revision}`
                          : "未確認"}
                      </p>
                      {r && <p>{r.evidence}</p>}
                      {r?.source === "published" && (
                        <p>
                          公開済み勤務を参照しています。履歴入力からは変更できません。
                        </p>
                      )}
                    </div>
                    <Field title="勤務時間(分)">
                      <Input
                        aria-label="勤務時間(分)"
                        disabled={r?.source === "published"}
                        type="number"
                        min="0"
                        max="1440"
                        step="1"
                        placeholder={r ? `現在 ${r.workedMinutes}分` : "未確認"}
                        value={draft?.minutes ?? ""}
                        onChange={(e) => change(day, "minutes", e.target.value)}
                      />
                    </Field>
                    <Field title="確認の根拠">
                      <Input
                        aria-label="確認の根拠"
                        disabled={r?.source === "published"}
                        maxLength={1000}
                        value={draft?.evidence ?? ""}
                        onChange={(e) =>
                          change(day, "evidence", e.target.value)
                        }
                      />
                    </Field>
                  </div>
                );
              })}
              {!days.length && <p>表示する履歴はありません。</p>}
              <div className="actions">
                <Field title="一覧にない前月・翌月の勤務日を追加">
                  <Input
                    type="date"
                    min={data.window.previousFrom}
                    max={data.window.nextThrough}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </Field>
                <Button
                  type="button"
                  disabled={
                    !selected ||
                    !date ||
                    (date >= data.window.first && date <= data.window.last)
                  }
                  onClick={() => {
                    setExtra((old) => [
                      ...new Set([...old, key(selected, date)]),
                    ]);
                    setDate("");
                  }}
                >
                  選択した日付を一覧に追加
                </Button>
              </div>
              <p>
                入力した行だけを登録します。登録済みの値を訂正すると、新しい版と確認の根拠を残します。
              </p>
              <div className="form-actions">
                <Button className="primary" type="submit">
                  確認した履歴を保存
                </Button>
              </div>
            </fieldset>
          </UnsavedForm>
        )}
      </CardContent>
    </Card>
  );
}
