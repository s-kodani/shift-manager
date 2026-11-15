import { SectionSettingsForm, SettingsSection, type SectionSave } from "./section-settings";
import { Minus } from "lucide-react";
import { SettingHeading, Button, Card, CardContent, Input, Loading, NativeSelect } from "./components/ui";
import { UnsavedForm } from "./unsaved-input";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import {
  api,
  ApiError,
  companyPolicy,
  companyPolicyInput,
  type Context,
} from "./api";
import {
  Field,
  RuleFields,
  ContractFields,
  readRule,
  readContract,
} from "./contract-forms";
import {
  readBreakRule,
  buildTeam,
  teamDraft,
  emptyTask,
  emptyPattern,
  pairKey,
  rowKey,
  type Config,
} from "./setup-model";
export { calendarSettings } from "../../api/src/calendar-contract";
import { calendarSettings } from "../../api/src/calendar-contract";
export type Calendar = z.infer<typeof calendarSettings>;
type Policy = z.infer<typeof companyPolicy>;
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="panel">
      <SettingHeading title={title} level={2} />
      <CardContent className="panel-body">{children}</CardContent>
    </Card>
  );
}
const clock = (n: number) =>
  String(Math.floor(n / 60)).padStart(2, "0") +
  ":" +
  String(n % 60).padStart(2, "0");
function Select({
  title,
  value,
  change,
  options,
}: {
  title: string;
  value: string;
  change: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <Field title={title}>
      <NativeSelect required value={value} onChange={(e) => change(e.target.value)}>
        <option value="">選択してください</option>
        {options.map(([v, n]) => (
          <option key={v} value={v}>
            {n}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}
function Integer({
  title,
  value,
  change,
  max = 1440,
  min = 0,
  step = 1,
}: {
  title: string;
  value: string;
  change: (v: string) => void;
  max?: number;
  min?: number;
  step?: number;
}) {
  return (
    <Field title={title}>
      <Input
        type="number"
        required
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => change(e.target.value)}
      />
    </Field>
  );
}
const priorities: [string, string][] = [
  ["first", "担当区分先行"],
  ["same", "一般業務と同段階"],
];
function Name({
  title,
  value,
  existing,
  change,
  nameOf,
}: {
  title: string;
  value: string;
  existing: boolean;
  change: (v: string) => void;
  nameOf: (v: string) => string;
}) {
  return existing ? (
    <Field title={title}>
      <Input readOnly value={nameOf(value)} />
    </Field>
  ) : (
    <Field title={title}>
      <Input
        required
        maxLength={128}
        value={value}
        onChange={(e) => change(e.target.value)}
      />
    </Field>
  );
}
function BreakFields({ initial }: { initial?: Policy["breakRule"] }) {
  return (
    <div className="form-grid">
      <Field title="必要休憩の算定基準">
        <NativeSelect name="breakBasis" required defaultValue={initial?.basis ?? ""}>
          <option value="">選択してください</option>
          <option value="elapsed">出勤から退勤まで</option>
          <option value="worked">休憩を除く実働</option>
        </NativeSelect>
      </Field>
      {(
        [
          ["threshold", "休憩が必要になる勤務時間（分・超過時）", 1],
          ["requiredMinutes", "必要休憩（分）", 30],
          ["afterStart", "勤務開始から取得可能になるまで（分）", 1],
          ["beforeEnd", "勤務終了までに残す時間（分）", 1],
        ] as const
      ).map(([key, title, step]) => (
        <Field title={title} key={key}>
          <Input
            name={key}
            type="number"
            min={0}
            max={1440}
            step={step}
            required
            defaultValue={initial?.[key] ?? ""}
          />
        </Field>
      ))}
    </div>
  );
}
export function PolicySettings({
  initial,
  disabled,
  save,
}: {
  initial: Policy | null;
  disabled: boolean;
  save: SectionSave<Policy>;
}) {
  const [levels, setLevels] = useState(
      (
        initial?.skillLevels ?? [{ level: "" as string | number, name: "" }]
      ).map((l) => ({ ...l, key: rowKey() })),
    );
  return (
    <Panel title="企業共通の勤務ルール">
      <SectionSettingsForm initial={initial} disabled={disabled} save={save}
        allLabel={initial ? "すべての企業共通設定を保存" : "企業共通設定をすべて登録"}
        fingerprints={{levels: JSON.stringify(levels)}}
        build={(f, scope, base) => companyPolicyInput.parse({
          ...base,
          ...((scope === 'all' || scope === 'rules') && {rule: readRule(f)}),
          ...((scope === 'all' || scope === 'contract') && {contract: readContract(f)}),
          ...((scope === 'all' || scope === 'break') && {breakRule: readBreakRule(f)}),
          ...((scope === 'all' || scope === 'levels') && {skillLevels: levels.map(l => {
            if (String(l.level) === '') throw Error('EMPTY_LEVEL');
            return {level: Number(l.level), name: l.name};
          })}),
        })}>
          <p className="muted">
            企業・雇用区分・個人の条件をすべて満たして計算します。個人設定で共通ルールを緩めません。
          </p>
          <SettingsSection scope="rules" title="勤務時間・休日のルール"><RuleFields initial={initial?.rule} /></SettingsSection>
          <SettingsSection scope="contract" title="企業共通の勤務可能曜日・時間帯">
          <ContractFields initial={initial?.contract} />
          </SettingsSection>
          <SettingsSection scope="break" title="企業共通の休憩ルール">
          <p className="muted">
            対象月から全チームに適用します。チームごとに基準を変更できません。
          </p>
          <BreakFields initial={initial?.breakRule} />
          </SettingsSection>
          <SettingsSection scope="levels" title="習熟度の段階" actions={<Button
              type="button"
              disabled={levels.length >= 100}
              onClick={() =>
                setLevels([...levels, { key: rowKey(), level: "", name: "" }])
              }
            >
              段階を追加
            </Button>}>
          <p className="muted">
            番号が大きいほど高い習熟度です。能力係数はチームの各業務で設定します。
          </p>
          {levels.map((l, i) => (
            <div className="skill-level-row" key={l.key}>
              <Button type="button" variant="ghost" size="icon" className="skill-level-remove"
                aria-label={`段階 ${i + 1} を削除`} title={`段階 ${i + 1} を削除`}
                disabled={levels.length === 1}
                onClick={() => setLevels(levels.filter((x) => x.key !== l.key))}>
                <Minus aria-hidden="true" />
              </Button>
              <div className="form-grid">
                <Integer
                  title={`段階 ${i + 1} の番号`}
                  value={String(l.level)}
                  max={10000}
                  change={(v) =>
                    setLevels(
                      levels.map((x) =>
                        x.key === l.key ? { ...x, level: v } : x,
                      ),
                    )
                  }
                />
                <Field title={`段階 ${i + 1} の名称`}>
                  <Input
                    required
                    maxLength={120}
                    value={l.name}
                    onChange={(e) =>
                      setLevels(
                        levels.map((x) =>
                          x.key === l.key ? { ...x, name: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
              </div>
            </div>
          ))}

          </SettingsSection>
      </SectionSettingsForm>
    </Panel>
  );
}
export function CalendarSettings({
  initial,
  disabled,
  save,
}: {
  initial: Calendar | null;
  disabled: boolean;
  save: (p: Calendar) => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <Panel title="企業共通のカレンダー設定">
      <UnsavedForm preserveOtherInputs
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          try {
            const f = new FormData(e.currentTarget);
            void save(
              calendarSettings.parse({
                weekStart: Number(f.get("weekStart")),
                deadlineDay: Number(f.get("deadlineDay")),
                halfDayDivider: Number(f.get("halfDayDivider")),
                roleRounding: f.get("roleRounding"),
              }),
            );
          } catch {
            setError("カレンダー設定の入力を確認してください。");
          }
        }}
      >
        <fieldset disabled={disabled}>
          <div className="form-grid">
            <Field title="週の開始曜日">
              <NativeSelect
                name="weekStart"
                defaultValue={initial?.weekStart ?? ""}
                required
              >
                <option value="">選択してください</option>
                {["日", "月", "火", "水", "木", "金", "土"].map((n, i) => (
                  <option value={i} key={i}>
                    {n}曜日
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field title="毎月の希望締切日">
              <Input
                name="deadlineDay"
                type="number"
                min={1}
                max={31}
                step={1}
                required
                defaultValue={initial?.deadlineDay}
              />
            </Field>
            <Field title="午前・午後の境界時刻">
              <NativeSelect
                name="halfDayDivider"
                required
                defaultValue={initial?.halfDayDivider ?? ""}
              >
                <option value="">選択してください</option>
                {Array.from({ length: 47 }, (_, i) => (
                  <option key={i} value={(i + 1) * 30}>
                    {clock((i + 1) * 30)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field title="担当区分人数の端数処理">
              <NativeSelect
                name="roleRounding"
                required
                defaultValue={initial?.roleRounding ?? ""}
              >
                <option value="">選択してください</option>
                <option value="ceil">切り上げ</option>
                <option value="floor">切り捨て</option>
              </NativeSelect>
            </Field>
          </div>
          <p className="muted">
            勤務不可・希望の提出期限は、対象シフト月の前月の指定日23:59（日本時間）です。指定日がない月は月末に補正します。
          </p>
          {error && (
            <p role="alert" className="alert error">
              {error}
            </p>
          )}
          <Button className="primary">カレンダー設定を保存</Button>
        </fieldset>
      </UnsavedForm>
    </Panel>
  );
}
export function TeamCreation({
  teams,
  disabled,
  create,
}: {
  teams: Context["companies"][number]["teams"];
  disabled: boolean;
  create: (name: string) => Promise<void>;
}) {
  return (
    <Panel title="チームの登録">
      <p>
        {teams.length
          ? teams.map((t) => t.name).join(" ／ ")
          : "チームはまだ登録されていません。"}
      </p>
      <UnsavedForm
        onSubmit={(e) => {
          e.preventDefault();
          void create(String(new FormData(e.currentTarget).get("name")));
        }}
      >
        <fieldset disabled={disabled}>
          <Field title="新しいチーム名">
            <Input name="name" required maxLength={120} />
          </Field>
          <Button className="primary">チームを作成</Button>
        </fieldset>
      </UnsavedForm>
    </Panel>
  );
}
export function TeamSettings({
  initial,
  company,
  team,
  month,
  revision,
  disabled,
  save,
  report,
  nameOf,
  onCompanySettings,
}: {
  initial: Config | null;
  company: string;
  team: string;
  month: string;
  revision: number;
  disabled: boolean;
  save: SectionSave<Config>;
  report: (e: unknown) => void;
  nameOf: (id: string) => string;
  onCompanySettings?: () => void;
}) {
  const [policy, setPolicy] = useState<Policy | null>(null),
    [loaded, setLoaded] = useState("");
  const [failedFor, setFailedFor] = useState("");
  const key = [company, team, month, revision].join(":");
  useEffect(() => {
    const controller = new AbortController();
    setLoaded("");
    setFailedFor("");

    if (!team) return;
    void api(
      `/companies/${company}/inputs/teams/${team}/contract-options/${month}`,
      z.object({ revision: z.number(), policy: companyPolicy.nullable() }),
      undefined,
      controller.signal,
    )
      .then((r) => {
        if (controller.signal.aborted) return;
        if (r.revision !== revision)
          throw new ApiError("VERSION_CONFLICT", 409);
        setPolicy(r.policy);
        setLoaded(key);
      })
      .catch((e) => {
        if (!controller.signal.aborted) { setFailedFor(key); report(e); }
      });
    return () => controller.abort();
  }, [key]);
  if (!team)
    return (
      <Panel title="チーム設定">
        <p>企業共通ルールでチームを登録してください。</p>
      </Panel>
    );
  if (loaded !== key && !policy)
    return (
      <Panel title="チーム設定">
        {failedFor === key ? <p className="error" role="alert">設定を取得できませんでした。最新の入力を読み直してください。</p> : <Loading label="企業の習熟度を確認しています…" />}
      </Panel>
    );
  if (!policy)
    return (
      <Panel title="チーム設定">
        <p>先に企業共通の勤務ルールと習熟度を登録してください。</p>
      </Panel>
    );
  return (
    <>
    {loaded !== key && failedFor !== key && <Loading label="最新のチーム設定を確認しています…" compact />}
    <TeamForm
      key={company + team + month}
      initial={initial}
      levels={policy.skillLevels}
      breakRule={policy.breakRule}
      disabled={disabled || loaded !== key}
      save={save}
      nameOf={nameOf}
      onCompanySettings={onCompanySettings}
    />
    </>
  );
}
function TeamForm({
  initial,
  levels,
  breakRule,
  disabled,
  save,
  nameOf,
  onCompanySettings,
}: {
  initial: Config | null;
  levels: Policy["skillLevels"];
  breakRule: Policy["breakRule"];
  disabled: boolean;
  save: SectionSave<Config>;
  nameOf: (id: string) => string;
  onCompanySettings?: () => void;
}) {
  const [d, set] = useState(() => teamDraft(initial));
  const savedDraft = useRef(d);
  const sectionKeys: Record<string, (keyof typeof d)[]> = {
    basic: ['slot', 'priority', 'scale', 'rolePriority'], tasks: ['tasks'], patterns: ['patterns'], roles: ['roles'], transitions: ['transitions'],
  };
  const scalar = (key: keyof typeof d) => (v: string) =>
    set({ ...d, [key]: v });
  const task = (key: string, field: string, value: unknown) =>
    set({
      ...d,
      tasks: d.tasks.map((t) => (t.key === key ? { ...t, [field]: value } : t)),
    });
  const pattern = (key: string, field: string, value: string) =>
    set({
      ...d,
      patterns: d.patterns.map((p) =>
        p.key === key ? { ...p, [field]: value } : p,
      ),
    });
  const times = Array.from(
    { length: 49 },
    (_, i) => [String(i * 30), clock(i * 30)] as [string, string],
  );
  return (
    <Panel title="チーム設定">
      <SectionSettingsForm initial={initial} disabled={disabled} save={save}
        allLabel={initial ? "すべてのチーム設定を保存" : "チーム設定をすべて登録"}
        fingerprints={Object.fromEntries(Object.entries(sectionKeys).map(([scope, keys]) => [scope, JSON.stringify(keys.map(key => d[key]))]))}
        build={(_, scope) => {
          const candidate = {...savedDraft.current};
          for (const key of scope === 'all' ? Object.keys(d) as (keyof typeof d)[] : sectionKeys[scope])
            Object.assign(candidate, {[key]: d[key]});
          return buildTeam(candidate, levels);
        }}
        onSaved={(scope) => {
          const next = {...d};
          for (const key of ['tasks', 'patterns', 'roles'] as const)
            if (scope === 'all' || scope === key) Object.assign(next, {[key]: next[key].map(row => ({...row, existing: true}))});
          const baseline = {...savedDraft.current};
          for (const key of scope === 'all' ? Object.keys(next) as (keyof typeof next)[] : sectionKeys[scope])
            Object.assign(baseline, {[key]: next[key]});
          savedDraft.current = baseline; set(next);
        }}>
          <SettingsSection scope="basic" title="チームの計算設定">
          <div className="form-grid">
            <Select
              title="業務配置枠"
              value={d.slot}
              change={scalar("slot")}
              options={[
                ["30", "30分"],
                ["60", "60分"],
              ]}
            />
            <Select
              title="計算全体の優先方式"
              value={d.priority}
              change={scalar("priority")}
              options={[
                ["coverage", "充足優先"],
                ["preference", "希望優先"],
              ]}
            />
            <Integer
              title="能力係数の精度（100なら0.01刻み）"
              value={d.scale}
              change={scalar("scale")}
              min={1}
              max={10000}
            />
            <Select
              title="チーム全体の担当区分評価"
              value={d.rolePriority}
              change={scalar("rolePriority")}
              options={priorities}
            />
          </div>
          </SettingsSection>
          <SettingHeading title="企業共通の休憩ルール" level={3} />
          {breakRule ? (
            <p className="muted">
              算定基準:{" "}
              {breakRule.basis === "elapsed"
                ? "出勤から退勤まで"
                : "休憩を除く実働"}{" "}
              ／ {breakRule.threshold}分超で休憩{breakRule.requiredMinutes}
              分。開始{breakRule.afterStart}分後から終了{breakRule.beforeEnd}
              分前までに連続取得します。変更は企業管理者が企業共通設定で行います。
            </p>
          ) : (
            <p role="alert">
              企業共通の休憩ルールが未設定です。計算前に企業管理者が登録してください。
            </p>
          )}
          <div className="form-actions mb-6">
            <Button type="button" disabled={!onCompanySettings} onClick={onCompanySettings}
              title={!onCompanySettings ? "企業共通設定の変更は企業管理者のみ可能です。" : undefined}>
              企業設定へ移動
            </Button>
          </div>
          <SettingsSection scope="tasks" title="業務" actions={<Button
            type="button"
            disabled={d.tasks.length >= 5}
            onClick={() => set({ ...d, tasks: [...d.tasks, emptyTask()] })}
          >
            業務を追加
          </Button>}>
          {d.tasks.map((t, i) => (
            <section className="setup-row" key={t.key}>
              <h4>業務 {i + 1}</h4>
              <div className="form-grid">
                <Name
                  title="業務名"
                  value={t.id}
                  existing={t.existing}
                  change={(v) => task(t.key, "id", v)}
                  nameOf={nameOf}
                />
                <Select
                  title="業務種別"
                  value={t.kind}
                  change={(v) => task(t.key, "kind", v)}
                  options={[
                    ["general", "一般業務"],
                    ["dedicated", "専任業務"],
                  ]}
                />
                <Select
                  title="最低習熟度"
                  value={t.minimumLevel}
                  change={(v) => task(t.key, "minimumLevel", v)}
                  options={levels.map((l) => [String(l.level), l.name])}
                />
                <Integer
                  title="最低継続時間（分）"
                  value={t.minimumMinutes}
                  change={(v) => task(t.key, "minimumMinutes", v)}
                />
                {t.kind === "general" && (
                  <Select
                    title="この業務の担当区分評価"
                    value={t.rolePriority}
                    change={(v) => task(t.key, "rolePriority", v)}
                    options={priorities}
                  />
                )}
              </div>
              {t.kind === "general" && (
                <div className="form-grid">
                  {levels.map((l) => (
                    <Field key={l.level} title={`${l.name} の能力係数`}>
                      <Input
                        required
                        inputMode="decimal"
                        value={t.capacities[l.level] ?? ""}
                        onChange={(e) =>
                          task(t.key, "capacities", {
                            ...t.capacities,
                            [l.level]: e.target.value,
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
              )}
              {t.kind === "dedicated" && (
                <p className="muted">
                  専任業務の一般業務処理能力は0として扱います。
                </p>
              )}
              <Button
                type="button"
                disabled={d.tasks.length === 1}
                onClick={() =>
                  set({
                    ...d,
                    tasks: d.tasks.filter((x) => x.key !== t.key),
                    roles: d.roles.map((r) => ({
                      ...r,
                      allowed: r.allowed.filter((k) => k !== t.key),
                    })),
                  })
                }
              >
                業務を削除
              </Button>
            </section>
          ))}

          </SettingsSection>
          <SettingsSection scope="patterns" title="勤務パターン" actions={<Button
            type="button"
            disabled={d.patterns.length >= 10}
            onClick={() =>
              set({ ...d, patterns: [...d.patterns, emptyPattern()] })
            }
          >
            勤務パターンを追加
          </Button>}>
          {d.patterns.map((p, i) => (
            <section className="setup-row" key={p.key}>
              <h4>勤務パターン {i + 1}</h4>
              <div className="form-grid">
                <Name
                  title="勤務パターン名"
                  value={p.id}
                  existing={p.existing}
                  change={(v) => pattern(p.key, "id", v)}
                  nameOf={nameOf}
                />
                <Select
                  title="出勤時刻"
                  value={p.start}
                  change={(v) => pattern(p.key, "start", v)}
                  options={times}
                />
                <Select
                  title="退勤時刻"
                  value={p.end}
                  change={(v) => pattern(p.key, "end", v)}
                  options={times}
                />
                <Select
                  title="休憩の決め方"
                  value={p.breakKind}
                  change={(v) => pattern(p.key, "breakKind", v)}
                  options={[
                    ["auto", "自動休憩"],
                    ["fixed", "固定休憩"],
                  ]}
                />
                {p.breakKind === "fixed" && (
                  <>
                    <Select
                      title="固定休憩の開始"
                      value={p.breakStart}
                      change={(v) => pattern(p.key, "breakStart", v)}
                      options={times}
                    />
                    <Select
                      title="固定休憩の終了"
                      value={p.breakEnd}
                      change={(v) => pattern(p.key, "breakEnd", v)}
                      options={times}
                    />
                  </>
                )}
              </div>
              <Button
                type="button"
                disabled={d.patterns.length === 1}
                onClick={() =>
                  set({
                    ...d,
                    patterns: d.patterns.filter((x) => x.key !== p.key),
                  })
                }
              >
                勤務パターンを削除
              </Button>
            </section>
          ))}

          </SettingsSection>
          <SettingsSection scope="roles" title="担当区分" actions={<Button
            type="button"
            disabled={d.roles.length >= 2}
            onClick={() =>
              set({
                ...d,
                roles: [
                  ...d.roles,
                  { key: rowKey(), id: "", existing: false, allowed: [] },
                ],
              })
            }
          >
            担当区分を追加
          </Button>}>
          {d.roles.length === 0 && <p>担当区分は未登録です。</p>}
          {d.roles.map((r, i) => (
            <section className="setup-row" key={r.key}>
              <h4>担当区分 {i + 1}</h4>
              <Name
                title="担当区分名"
                value={r.id}
                existing={r.existing}
                nameOf={nameOf}
                change={(v) =>
                  set({
                    ...d,
                    roles: d.roles.map((x) =>
                      x.key === r.key ? { ...x, id: v } : x,
                    ),
                  })
                }
              />
              <SettingHeading title="兼任を認める一般業務" level={4} help="この担当区分で配置された人が、兼任できる一般業務を選びます。同じ人を、複数の業務や担当区分へ同時に数えることはできません。" />
              <div className="weekday-options">
                {d.tasks
                  .filter((t) => t.kind === "general")
                  .map((t) => (
                    <label key={t.key}>
                      <Input
                        type="checkbox"
                        checked={r.allowed.includes(t.key)}
                        onChange={(e) =>
                          set({
                            ...d,
                            roles: d.roles.map((x) =>
                              x.key === r.key
                                ? {
                                    ...x,
                                    allowed: e.target.checked
                                      ? [...x.allowed, t.key]
                                      : x.allowed.filter((k) => k !== t.key),
                                  }
                                : x,
                            ),
                          })
                        }
                      />
                      {nameOf(t.id) || "名称未入力"}
                    </label>
                  ))}
              </div>
              <Button
                type="button"
                onClick={() =>
                  set({ ...d, roles: d.roles.filter((x) => x.key !== r.key) })
                }
              >
                担当区分を削除
              </Button>
            </section>
          ))}

          </SettingsSection>
          <SettingsSection scope="transitions" title="切替時の準備・移動">
          <p className="muted">
            不要な組合せには0を入力します。整数分で、業務配置1枠以内を設定してください。勤務開始時の初回準備は不要です。
          </p>
          <div className="form-grid">
            {d.tasks.flatMap((from) =>
              d.tasks
                .filter((to) => to.key !== from.key)
                .map((to) => (
                  <Integer
                    key={pairKey(from.key, to.key)}
                    title={`${nameOf(from.id) || "名称未入力"} → ${nameOf(to.id) || "名称未入力"}（分）`}
                    value={d.transitions[pairKey(from.key, to.key)] ?? ""}
                    max={d.slot ? Number(d.slot) : 60}
                    change={(v) =>
                      set({
                        ...d,
                        transitions: {
                          ...d.transitions,
                          [pairKey(from.key, to.key)]: v,
                        },
                      })
                    }
                  />
                )),
            )}
          </div>
          </SettingsSection>
      </SectionSettingsForm>
    </Panel>
  );
}
