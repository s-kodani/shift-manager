import { SectionSettingsForm, SettingsSection, type SectionSave } from "./section-settings";
import { SettingHeading, InfoHelp, Button, Card, CardContent, Input, TimeInput, Loading, NativeSelect, TableCell, Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui";
import { UnsavedForm } from "./unsaved-input";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from 'react-dom';
import { z } from "zod";
import { api, ApiError, type Staff } from "./api";
import { Field } from "./contract-forms";
import { coefficient, type Config } from "./setup-model";
import {
  buildPlanning,
  emptyDemand,
  emptyEvent,
  emptyRole,
  planningDraft,
  type Plan,
  type DemandDraft,
  type EventDraft,
  type RoleDraft,
} from "./planning-model";
import { DemandCsvImport } from "./demand-csv";
import { DemandBulk } from "./demand-bulk";
import { RoleBulk } from "./role-bulk";
import { PlanningDataTable } from "./planning-data-table";
import { demandCsvApply } from "../../api/src/demand-csv-contract";

const endOfMonth = (month: string) =>
  month +
  "-" +
  new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
const messages: Record<string, string> = {
  INVALID_TIME: "時刻を数字4桁のHHMMで入力してください（例：0930）。2400は当日の終了です。",
  EMPTY_OR_REVERSED_INTERVAL:
    "開始より後の終了時刻を入力してください。日付をまたぐ予定は登録できません。",
  OUTSIDE_MONTH: "日付は対象月の中で選択してください。",
  INVALID_DEMAND_SLOT: "需要はチームの配置枠に合わせて入力してください。",
  INVALID_PRECISION:
    "必要人数は指定精度で正確に表せる非負の数、または分数で入力してください。",
  DEMAND_UNSET:
    "直接必要人数と算出値が両方未設定の行があります。0人は明示的に0を入力してください。",
  INTEGER_REQUIRED:
    "最低人数と比率は空欄にせず、非負の整数を入力してください。",
  EVENT_PARTICIPANTS_REQUIRED: "研修・会議の参加者を選択してください。",
  ROLE_SCOPE_REQUIRED: "担当区分の条件の対象範囲を選択してください。",
};
function Period({
  title,
  month,
  row,
  change,
}: {
  title: string;
  month: string;
  row: { date: string; start: string; end: string };
  change: (key: "date" | "start" | "end", value: string) => void;
}) {
  return (
    <>
      <Field title={title + " 日付"}>
        <Input
          type="date"
          required
          min={month + "-01"}
          max={endOfMonth(month)}
          value={row.date}
          onChange={(e) => change("date", e.target.value)}
        />
      </Field>
      {(["start", "end"] as const).map((key) => (
        <Field key={key} title={title + (key === "start" ? " 開始" : " 終了")}>
          <TimeInput
            required
            value={row[key]}
            onValueChange={(value) => change(key, value)}
          />
        </Field>
      ))}
    </>
  );
}
function TablePeriod({ title, month, row, change }: {
  title: string; month: string; row: { date: string; start: string; end: string };
  change: (key: "date" | "start" | "end", value: string) => void;
}) {
  return <>
    <TableCell><Input type="date" required aria-label={`${title} 日付`} min={`${month}-01`} max={endOfMonth(month)} value={row.date} onChange={e => change("date", e.target.value)} /></TableCell>
    {(["start", "end"] as const).map(key => <TableCell key={key}><TimeInput required aria-label={`${title} ${key === "start" ? "開始" : "終了"}`} value={row[key]} onValueChange={value => change(key, value)} /></TableCell>)}
  </>;
}
const selected = (
  value: string,
  values: [string, string][],
  change: (v: string) => void,
  label?: string,
) => (
  <NativeSelect required aria-label={label} value={value} onChange={(e) => change(e.target.value)}>
    <option value="">選択してください</option>
    {values.map(([id, name]) => (
      <option key={id} value={id}>
        {name}
      </option>
    ))}
  </NativeSelect>
);
export function PlanningManagement({
  initial,
  config,
  staff,
  company,
  team,
  month,
  revision,
  disabled,
  save,
  report,
  nameOf,
  applyCsv,
  csvOpen = false,
  onCsvOpenChange,
  csvFeedback,
}: {
  initial: Plan | null;
  config: Config | null;
  staff: Staff;
  company: string;
  team: string;
  month: string;
  revision: number;
  disabled: boolean;
  save: SectionSave<Plan>;
  report: (error: unknown) => void;
  nameOf: (id: string) => string;
  csvOpen?: boolean;
  onCsvOpenChange?: (open: boolean) => void;
  csvFeedback?: ReactNode;
  applyCsv: (
    command: z.infer<typeof demandCsvApply>,
    done: () => void,
  ) => Promise<void>;
}) {
  const [rounding, setRounding] = useState<"ceil" | "floor" | null>(null),
    [loaded, setLoaded] = useState("");
  const [failedFor, setFailedFor] = useState("");
  const key = [company, team, month, revision].join(":");
  useEffect(() => {
    const controller = new AbortController();
    setLoaded("");
    setFailedFor("");

    if (team)
      void api(
        `/companies/${company}/inputs/teams/${team}/contract-options/${month}`,
        z.object({
          revision: z.number().int(),
          roleRounding: z.enum(["ceil", "floor"]).nullable(),
        }),
        undefined,
        controller.signal,
      )
        .then((r) => {
          if (controller.signal.aborted) return;
          if (r.revision !== revision)
            throw new ApiError("VERSION_CONFLICT", 409);
          setRounding(r.roleRounding);
          setLoaded(key);
        })
        .catch((e) => {
          if (!controller.signal.aborted) { setFailedFor(key); report(e); }
        });
    return () => controller.abort();
  }, [key]);
  if (!team || !config)
    return (
      <Card className="panel">
        <SettingHeading title="月別の需要・予定・担当区分の条件" level={2} />
        <CardContent className="panel-body">
          先にチームと業務・勤務パターンを登録してください。
        </CardContent>
      </Card>
    );
  if (loaded !== key && rounding === null)
    return (
      <Card className="panel">
        <SettingHeading title="月別の需要・予定・担当区分の条件" level={2} />
        <CardContent className="panel-body">{failedFor === key ? <p className="error" role="alert">設定を取得できませんでした。最新の入力を読み直してください。</p> : <Loading label="企業の端数処理設定を確認しています…" />}</CardContent>
      </Card>
    );
  return (
    <>
    {loaded !== key && failedFor !== key && <Loading label="最新の需要設定を確認しています…" compact />}
    <PlanningForm
      initial={initial}
      config={config}
      staff={staff}
      month={month}
      rounding={rounding}
      disabled={disabled || loaded !== key}
      save={save}
      nameOf={nameOf}
      company={company}
      team={team}
      revision={revision}
      report={report}
      applyCsv={applyCsv}
      csvOpen={csvOpen}
      onCsvOpenChange={onCsvOpenChange}
      csvFeedback={csvFeedback}
    />
    </>
  );
}
function PlanningForm({
  initial,
  config,
  staff,
  month,
  rounding,
  disabled,
  save,
  nameOf,
  company,
  team,
  revision,
  report,
  applyCsv,
  csvOpen = false,
  onCsvOpenChange,
  csvFeedback,
}: {
  initial: Plan | null;
  config: Config;
  staff: Staff;
  month: string;
  rounding: "ceil" | "floor" | null;
  disabled: boolean;
  save: SectionSave<Plan>;
  nameOf: (id: string) => string;
  company: string;
  team: string;
  revision: number;
  report: (e: unknown) => void;
  csvOpen?: boolean;
  onCsvOpenChange?: (open: boolean) => void;
  csvFeedback?: ReactNode;
  applyCsv: (
    command: z.infer<typeof demandCsvApply>,
    done: () => void,
  ) => Promise<void>;
}) {
  const [d, set] = useState(() => planningDraft(initial, config.capacityScale)),
    [bulkPending, setBulkPending] = useState(false),
    [roleBulkPending, setRoleBulkPending] = useState(false),
    [bulkReset, setBulkReset] = useState(0),
    [error, setError] = useState(""),
    [revealDemand, setRevealDemand] = useState(""),
    [revealRole, setRevealRole] = useState("");
  const [activeTab, setActiveTab] = useState("demand");
  const savedDraft = useRef(d), ownSave = useRef(''), lastInitial = useRef(initial);
  const [resetKey, setResetKey] = useState(0);
  useEffect(() => {
    if (lastInitial.current === initial) return;
    lastInitial.current = initial;
    if (JSON.stringify(initial) === ownSave.current) return;
    const fresh = planningDraft(initial, config.capacityScale);
    set(fresh); savedDraft.current = fresh;
    setError(''); setRevealDemand(''); setRevealRole(''); setBulkPending(false); setRoleBulkPending(false);
    setBulkReset(n => n + 1); setResetKey(n => n + 1);
  }, [initial, config.capacityScale]);
  const demand = (id: string, patch: Partial<DemandDraft>) =>
    set({
      ...d,
      demand: d.demand.map((r) => (r.key === id ? { ...r, ...patch } : r)),
    });
  const event = (id: string, patch: Partial<EventDraft>) =>
    set({
      ...d,
      events: d.events.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  const role = (id: string, patch: Partial<RoleDraft>) =>
    set({
      ...d,
      roles: d.roles.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  const fingerprint = (draft: typeof d) =>
    JSON.stringify({
      ...draft,
      demand: draft.demand.map(({ key: _, ...row }) => row),
    });
  const dirty = fingerprint(d) !== fingerprint(savedDraft.current);
  return (
    <>
      <DemandCsvImport
        open={csvOpen} onOpenChange={onCsvOpenChange ?? (() => {})}
        feedback={csvFeedback}
        company={company}
        team={team}
        month={month}
        revision={revision}
        config={config}
        disabled={disabled}
        dirty={dirty || bulkPending || roleBulkPending}
        report={report}
        apply={applyCsv}
      />
      <Card className="panel">
        <SettingHeading title="月別の需要・予定・担当区分の条件" level={2} />
        <CardContent className="panel-body">
          <p className="muted">
            日本時間で対象月の入力を管理します。各見出しの保存ボタンで、その範囲だけを保存します。時刻はコロンなしの数字4桁（例：0930）で入力してください。未保存の変更は計算に使いません。
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <SectionSettingsForm key={resetKey} initial={initial ?? {demand: [], events: [], roleRequirements: []}} disabled={disabled} save={save}
            allLabel="すべての需要・予定・担当区分を保存"
            revealSection={setActiveTab}
            fingerprints={{demand: JSON.stringify([d.demand, bulkPending]), events: JSON.stringify(d.events), roles: JSON.stringify([d.roles, roleBulkPending])}}
            build={(_, scope) => {
              if ((scope === 'all' || scope === 'demand') && bulkPending || (scope === 'all' || scope === 'roles') && roleBulkPending) {
                flushSync(() => setActiveTab((scope === 'all' || scope === 'demand') && bulkPending ? 'demand' : 'roles'));
                throw Error('BULK_NOT_APPLIED');
              }
              const candidate = {...savedDraft.current};
              for (const key of scope === 'all' ? ['demand', 'events', 'roles'] as const : [scope as keyof typeof d]) {
                try { buildPlanning({demand: [], events: [], roles: [], [key]: d[key]}, config, month); }
                catch (error) {
                  flushSync(() => {
                    setActiveTab(key);
                    setError(messages[error instanceof Error ? error.message : ''] ?? '入力内容を確認してください。保存していません。');
                    // A domain error can belong to a filtered or paginated row.
                    for (const row of d[key]) {
                      try { buildPlanning({demand: [], events: [], roles: [], [key]: [row]}, config, month); }
                      catch {
                        if (key === 'demand') setRevealDemand((row as DemandDraft).key);
                        if (key === 'roles') setRevealRole((row as RoleDraft).id);
                        break;
                      }
                    }
                  });
                  throw error;
                }
                Object.assign(candidate, {[key]: d[key]});
              }
              setError('');
              return buildPlanning(candidate, config, month);
            }}
            onSaved={(scope, payload) => {
              ownSave.current = JSON.stringify(payload);
              const baseline = {...savedDraft.current};
              for (const key of scope === 'all' ? ['demand', 'events', 'roles'] as const : [scope as keyof typeof d])
                Object.assign(baseline, {[key]: d[key]});
              savedDraft.current = baseline;
            }}>
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList aria-label="需要管理の表示"><TabsTrigger value="demand">必要人数</TabsTrigger><TabsTrigger value="events">研修・会議</TabsTrigger><TabsTrigger value="roles">担当区分の必要人数</TabsTrigger></TabsList>
                <TabsContent value="demand" forceMount hidden={activeTab !== 'demand'}>
              <SettingsSection scope="demand" title="必要人数" actions={<Button
                type="button"
                onClick={() => {
                  const row = emptyDemand(month);
                  set({ ...d, demand: [...d.demand, row] }); setRevealDemand(row.key);
                }}
              >
                需要を追加
              </Button>}>
              <DemandBulk key={`${month}:${config.capacityScale}:${bulkReset}`} rows={d.demand} config={config} month={month} nameOf={nameOf}
                pending={setBulkPending} apply={rows => { set({ ...d, demand: rows }); setError(""); }} />
              <p className="muted">
                空欄は未設定、0は必要人数0です。直接入力を優先し、算出値は保持します。必要人数は処理能力換算で、0.29や1/3のように指定精度で正確に表せる値を使えます。
              </p>
              <PlanningDataTable title="必要人数" month={month} rows={d.demand} rowKey={r => r.key} revealKey={revealDemand}
                filters={[{ title: "業務", options: config.tasks.filter(t => t.kind === "general").map(t => [t.id, nameOf(t.id)]), value: r => r.taskId }]}
                columns={["日付", "開始", "終了", "業務", "直接必要人数", "算出値（人相当）", "操作"]}
                render={(r, i) => <>
                  <TablePeriod title={`需要 ${i + 1}`} month={month} row={r} change={(key, value) => demand(r.key, { [key]: value })} />
                  <TableCell>{selected(r.taskId, config.tasks.filter(t => t.kind === "general").map(t => [t.id, nameOf(t.id)]), v => demand(r.key, { taskId: v }), `需要 ${i + 1} 業務`)}</TableCell>
                  <TableCell><Input aria-label={`需要 ${i + 1} 直接必要人数（空欄＝未設定）`} inputMode="decimal" value={r.direct} onChange={e => demand(r.key, { direct: e.target.value })} /></TableCell>
                  <TableCell>{r.calculated === null ? "未設定" : coefficient(r.calculated, config.capacityScale)}</TableCell>
                  <TableCell><Button type="button" aria-label={`需要 ${i + 1} を削除`} onClick={() => set({ ...d, demand: d.demand.filter(v => v.key !== r.key) })}>削除</Button></TableCell>
                </>} />

              </SettingsSection>
              </TabsContent>
              <TabsContent value="events" forceMount hidden={activeTab !== 'events'}>
              <SettingsSection scope="events" title="研修・会議" actions={<Button
                type="button"
                onClick={() =>
                  set({ ...d, events: [...d.events, emptyEvent(month)] })
                }
              >
                研修・会議を追加
              </Button>}>
              <p className="muted">
                日時と参加者を指定します。全時間参加が必要です。勤務条件・固定休憩との衝突、参加者の予定重複は保存時に検査します。時刻は分単位で入力できます。
              </p>
              {d.events.map((r, i) => (
                <section
                  className="setup-row"
                  key={r.id}
                  aria-label={`予定 ${i + 1}`}
                >
                  <h4>予定 {i + 1}</h4>
                  <div className="form-grid">
                    <Period
                      title={`予定 ${i + 1}`}
                      month={month}
                      row={r}
                      change={(key, value) => event(r.id, { [key]: value })}
                    />
                    <Field title={`予定 ${i + 1} 種別`}>
                      {selected(
                        r.kind,
                        [
                          ["training", "研修"],
                          ["meeting", "会議"],
                        ],
                        (v) => event(r.id, { kind: v }),
                      )}
                    </Field>
                  </div>
                  <fieldset className="participant-options">
                    <legend className="setting-heading">予定 {i + 1} の参加者<InfoHelp title={`予定 ${i + 1} の参加者`}>この研修・会議に全時間参加するスタッフを選びます。参加できる勤務・休憩の組み合わせが必要です。</InfoHelp></legend>
                    {staff.map((s) => (
                      <label className="check-row" key={s.id}>
                        <Input
                          type="checkbox"
                          checked={r.staffIds.includes(s.id)}
                          onChange={(e) =>
                            event(r.id, {
                              staffIds: e.target.checked
                                ? [...r.staffIds, s.id]
                                : r.staffIds.filter((id) => id !== s.id),
                            })
                          }
                        />
                        {s.staff_number} {s.name}
                      </label>
                    ))}
                    {!staff.length && (
                      <p>このチームにスタッフが登録されていません。</p>
                    )}
                    {r.staffIds.some(
                      (id) => !staff.some((s) => s.id === id),
                    ) && (
                      <p role="alert">
                        参照できない参加者がいます。所属と予定を確認してください。
                      </p>
                    )}
                  </fieldset>
                  <Button
                    type="button"
                    onClick={() =>
                      set({
                        ...d,
                        events: d.events.filter((v) => v.id !== r.id),
                      })
                    }
                  >
                    予定 {i + 1} を削除
                  </Button>
                </section>
              ))}
              {!d.events.length && <p>研修・会議の入力はありません。</p>}

              </SettingsSection>
              </TabsContent>
              <TabsContent value="roles" forceMount hidden={activeTab !== 'roles'}>
              <SettingsSection scope="roles" title="担当区分の必要人数" actions={<Button
                  type="button"
                  disabled={!config.roles.length}
                  onClick={() => {
                    const row = emptyRole(month);
                    set({ ...d, roles: [...d.roles, row] }); setRevealRole(row.id);
                  }}
                >
                  担当区分の条件を追加
                </Button>}>
              <p className="muted">
                チーム全体・業務別に、最低人数と比率から求める人数の大きい方を使います。比率の分母は兼任中のSV・リーダーを除く一般業務の実稼働人数です。比率を使わない場合は分子0・分母1を明示入力します。
              </p>
              <p>
                企業の端数処理:{" "}
                {rounding === null
                  ? "未設定"
                  : rounding === "ceil"
                    ? "切り上げ"
                    : "切り捨て"}
                。評価順序はチーム／業務設定を参照します。
              </p>
              <RoleBulk key={`${month}:${bulkReset}`} rows={d.roles} config={config} month={month} nameOf={nameOf}
                pending={setRoleBulkPending} apply={rows => { set({ ...d, roles: rows }); setError(""); }} />
              <PlanningDataTable title="担当区分の必要人数" month={month} rows={d.roles} rowKey={r => r.id} revealKey={revealRole}
                filters={[
                  { title: "対象範囲", options: config.rolePolicies.map(p => [JSON.stringify(p.taskId), p.taskId === null ? "チーム全体" : nameOf(p.taskId)]), value: r => r.scope },
                  { title: "担当区分", options: config.roles.map(r => [r.id, nameOf(r.id)]), value: r => r.roleId },
                ]}
                columns={["日付", "開始", "終了", "対象範囲", "担当区分", "最低人数", "比率の分子", "比率の分母", "評価", "操作"]}
                render={(r, i) => <>
                  <TablePeriod title={`担当区分の条件 ${i + 1}`} month={month} row={r} change={(key, value) => role(r.id, { [key]: value })} />
                  <TableCell>{selected(r.scope, config.rolePolicies.map(p => [JSON.stringify(p.taskId), p.taskId === null ? "チーム全体" : nameOf(p.taskId)]), v => role(r.id, { scope: v }), `担当区分の条件 ${i + 1} 対象範囲`)}</TableCell>
                  <TableCell>{selected(r.roleId, config.roles.map(r => [r.id, nameOf(r.id)]), v => role(r.id, { roleId: v }), `担当区分の条件 ${i + 1} 担当区分`)}</TableCell>
                  {([["minimum", "最低人数", 0, 500], ["numerator", "比率の分子", 0, 10000], ["denominator", "比率の分母", 1, 10000]] as const).map(([key, title, min, max]) =>
                    <TableCell key={key}><Input aria-label={`担当区分の条件 ${i + 1} ${title}`} type="number" min={min} max={max} step={1} required value={r[key]} onChange={e => role(r.id, { [key]: e.target.value })} /></TableCell>)}
                  <TableCell>{r.scope === "" ? "対象範囲を選択してください" : config.rolePolicies.find(p => JSON.stringify(p.taskId) === r.scope)?.priority === "first" ? "担当区分先行" : "一般業務と同段階"}</TableCell>
                  <TableCell><Button type="button" aria-label={`担当区分の条件 ${i + 1} を削除`} onClick={() => set({ ...d, roles: d.roles.filter(v => v.id !== r.id) })}>削除</Button></TableCell>
                </>} />
              {!config.roles.length && (
                <p>
                  担当区分を使う場合は、先にチーム設定で担当区分と対象業務を登録してください。
                </p>
              )}

              </SettingsSection>
              </TabsContent>
              </Tabs>
          </SectionSettingsForm>
        </CardContent>
      </Card>
    </>
  );
}
