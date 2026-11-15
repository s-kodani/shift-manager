import { SectionSettingsForm, SettingsSection } from "./section-settings";
import { Button, Card, CardContent, Input, Loading, NativeSelect, Field, SettingHeading, InfoHelp } from "./components/ui";
import { UnsavedForm, useUnsavedInput } from "./unsaved-input";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import {
  api,
  ApiError,
  companyPolicy,
  employmentPolicy,
  staffContract,
  teamConfig,
  type Staff,
} from "./api";

type Rule = z.infer<typeof companyPolicy>["rule"];
type Contract = z.infer<typeof companyPolicy>["contract"];
type Profile = z.infer<typeof staffContract>;
const optionsSchema = z.object({
  revision: z.number().int(),
  policy: companyPolicy.nullable(),
  employment: z.array(
    z.object({
      id: z.string().uuid(),
      version: z.string().uuid(),
      effectiveFrom: z.string(),
      revision: z.number(),
      payload: employmentPolicy,
    }),
  ),
});
type Options = z.infer<typeof optionsSchema>;
const profileSchema = z.object({
  version: z
    .object({
      id: z.string(),
      effectiveFrom: z.string(),
      revision: z.number(),
      payload: staffContract,
    })
    .nullable(),
});
const ruleFields = [
  ["dailyMax", "日最大勤務（分）", 1440],
  ["weeklyMax", "週最大勤務（分）", 44640],
  ["monthlyMin", "月最低勤務（分）", 44640],
  ["monthlyMax", "月最大勤務（分）", 44640],
  ["minDays", "月最低勤務日数", 31],
  ["minOff", "月最低休日数", 31],
  ["maxConsecutive", "最大連続勤務日数", 31],
] as const;
const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
const clock = (n: number) =>
  String(Math.floor(n / 60)).padStart(2, "0") +
  ":" +
  String(n % 60).padStart(2, "0");
export { Field } from "./components/ui";
export function RuleFields({
  initial,
  prefix = "",
}: {
  initial?: Rule;
  prefix?: string;
}) {
  return (
    <div className="form-grid">
      {ruleFields.map(([key, name, max]) => (
        <Field key={key} title={name}>
          <Input
            name={prefix + key}
            type="number"
            min={key === "maxConsecutive" ? 1 : 0}
            max={max}
            step="1"
            required
            defaultValue={initial?.[key]}
          />
        </Field>
      ))}
    </div>
  );
}
export function ContractFields({
  initial,
  prefix = "",
}: {
  initial?: Contract;
  prefix?: string;
}) {
  return (
    <>
      <SettingHeading title="勤務可能な曜日" level={4} />
      <div className="weekday-options" role="group" aria-label="契約曜日">
        {weekdays.map((name, i) => (
          <label key={i}>
            <Input
              name={prefix + "weekday"}
              type="checkbox"
              value={i}
              defaultChecked={initial?.weekdays.includes(i) ?? false}
            />
            {name}
          </label>
        ))}
      </div>
      <div className="form-grid">
        {(["start", "end"] as const).map((key) => (
          <Field
            key={key}
            title={
              key === "start" ? "勤務可能な開始時刻" : "勤務可能な終了時刻"
            }
          >
            <NativeSelect
              name={prefix + key}
              defaultValue={initial?.[key] ?? ""}
              required
            >
              <option value="">選択してください</option>
              {Array.from({ length: 49 }, (_, i) => (
                <option key={i} value={i * 30}>
                  {clock(i * 30)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ))}
      </div>
    </>
  );
}
export const readRule = (f: FormData, prefix = "") =>
  Object.fromEntries(
    ruleFields.map(([key]) => [key, Number(f.get(prefix + key))]),
  );
export const readContract = (f: FormData, prefix = "") => ({
  weekdays: f.getAll(prefix + "weekday").map(Number),
  start: Number(f.get(prefix + "start")),
  end: Number(f.get(prefix + "end")),
});
function limits(rule: Rule) {
  return ruleFields.map(([key, name]) => name + " " + rule[key]).join(" ／ ");
}
export function ContractManagement({
  company,
  team,
  month,
  revision,
  config,
  staff,
  companyAdmin,
  disabled,
  refresh,
  save,
  report,
  nameOf,
  markEditing,
}: {
  company: string;
  team: string;
  month: string;
  revision: number;
  config: z.infer<typeof teamConfig> | null;
  staff: Staff;
  companyAdmin: boolean;
  disabled: boolean;
  refresh: number;
  save: (path: string, payload: unknown, saved?: () => void) => Promise<void>;
  report: (error: unknown) => void;
  nameOf: (id: string) => string;
  markEditing?: () => void;
}) {
  const [options, setOptions] = useState<Options | null>(null),
    [selected, setSelected] = useState(staff[0]?.id ?? ""),
    [profile, setProfile] = useState<Profile | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<{ kind: "employment" | "contract"; message: string } | null>(null);
  const generation = useRef(0);
  const unsaved = useUnsavedInput();
  const loadKey = [company, team, month, selected, refresh, revision].join(":");
  const [loadedFor, setLoadedFor] = useState("");
  const contentScope = [company, team, month, selected].join(":");
  const [availableFor, setAvailableFor] = useState("");
  const [failedFor, setFailedFor] = useState("");
  useEffect(() => {
    if (!staff.some((s) => s.id === selected)) setSelected(staff[0]?.id ?? "");
  }, [staff, selected]);
  useEffect(() => {
    const own = ++generation.current,
      controller = new AbortController();
    setLoadedFor("");
    setFailedFor("");
    setLoading(true);

    const base = `/companies/${company}/inputs/teams/${team}`;
    void Promise.all([
      api(
        base + "/contract-options/" + month,
        optionsSchema,
        undefined,
        controller.signal,
      ),
      selected
        ? api(
            base + "/staff/" + selected + "/contract/" + month,
            profileSchema,
            undefined,
            controller.signal,
          )
        : Promise.resolve({ version: null }),
    ])
      .then(([o, p]) => {
        if (own === generation.current && !controller.signal.aborted) {
          if (o.revision !== revision)
            throw new ApiError("VERSION_CONFLICT", 409);
          setOptions(o);
          setProfile(p.version?.payload ?? null);
          setLoadedFor(loadKey);
          setAvailableFor(contentScope);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) { setFailedFor(loadKey); report(e); }
      })
      .finally(() => {
        if (own === generation.current) setLoading(false);
      });
    return () => controller.abort();
  }, [company, team, month, selected, refresh, revision]);
  const locked = disabled || loading || loadedFor !== loadKey;
  const submit = (
    form: HTMLFormElement,
    kind: "employment" | "contract",
    entity: string,
    saved?: () => void,
  ) => {
    setError(null);
    const f = new FormData(form);
    try {
      const payload =
        kind === "employment"
          ? employmentPolicy.parse({
              name: f.get("name"),
              rule: readRule(f),
              contract: readContract(f),
            })
          : staffContract.parse({
              employmentTypeId: f.get("employment"),
              contract: readContract(f),
              rule: f.get("ownRule") ? readRule(f, "personal-") : null,
              skills: (config?.tasks ?? []).flatMap((task) => {
                const level = f.get("skill-" + task.id);
                return level === ""
                  ? []
                  : [{ taskId: task.id, level: Number(level) }];
              }),
              roleIds: f.getAll("role"),
            });
      void save(
        kind === "employment"
          ? `/companies/${company}/inputs/employment/${entity}`
          : `/companies/${company}/inputs/teams/${team}/staff/${entity}/contract`,
        payload,
        saved,
      );
    } catch {
      setError({ kind, message: "入力値・契約曜日・時刻を確認してください。保存していません。" });
    }
  };
  const waiting = (loading || loadedFor !== loadKey && failedFor !== loadKey) && availableFor !== contentScope;
  return (
    <div
      onChangeCapture={(e) => {
        if (e.target instanceof HTMLElement && e.target.closest("form"))
          markEditing?.();
      }}
    >
      {availableFor === contentScope && loadedFor !== loadKey && failedFor !== loadKey && <Loading label="最新の契約設定を確認しています…" compact />}
      <Card className="panel" aria-label="企業共通ルール・雇用区分">
        <SettingHeading title="企業共通ルール・雇用区分" level={2} />
        <CardContent className="panel-body">
          <p className="muted">
            企業共通ルールの参照と、雇用区分ごとの勤務条件を管理します。対象月 {month} からの条件を表示しています。スタッフ個別の契約は下のカードで設定してください。
          </p>
          {!companyAdmin && <p className="muted">雇用区分の編集・追加は企業管理者が行います。</p>}
          {error?.kind === "employment" && <p className="error" role="alert">{error.message}</p>}
          {waiting ? <Loading label="企業共通ルール・雇用区分を取得しています…" /> : failedFor === loadKey && availableFor !== contentScope ? (
            <p className="error" role="alert">企業共通ルール・雇用区分を取得できませんでした。最新の入力を読み直してください。</p>
          ) : options && <>
              {options.policy ? (
                <>
                  <SettingHeading title="企業共通ルール（参照）" level={3} />
                  <p>{limits(options.policy.rule)}</p>
                  <p>
                    契約範囲 {clock(options.policy.contract.start)}〜
                    {clock(options.policy.contract.end)} ／{" "}
                    {options.policy.contract.weekdays
                      .map((d) => weekdays[d])
                      .join("・")}
                  </p>
                </>
              ) : (
                <p className="warning">
                  企業共通ルールを先に登録してください。
                </p>
              )}
              {options.employment.map((e) => (
                <details key={e.id}>
                  <summary>
                    {e.payload.name}（適用開始 {e.effectiveFrom}）
                  </summary>
                  <p>{limits(e.payload.rule)}</p>
                  <p>
                    契約範囲 {clock(e.payload.contract.start)}〜
                    {clock(e.payload.contract.end)} ／{" "}
                    {e.payload.contract.weekdays
                      .map((d) => weekdays[d])
                      .join("・")}
                  </p>
                  {companyAdmin && (
                    <UnsavedForm preserveOtherInputs
                      key={e.version}
                      onSubmit={(event) => {
                        event.preventDefault();
                        submit(event.currentTarget, "employment", e.id);
                      }}
                    >
                      <fieldset disabled={locked}>
                        <Field title="雇用区分名">
                          <Input
                            name="name"
                            required
                            maxLength={120}
                            defaultValue={e.payload.name}
                          />
                        </Field>
                        <RuleFields initial={e.payload.rule} />
                        <ContractFields initial={e.payload.contract} />
                        <Button>この雇用区分を対象月から保存</Button>
                      </fieldset>
                    </UnsavedForm>
                  )}
                </details>
              ))}
              {companyAdmin && options.policy && (
                <NewEmployment
                  key={company + month}
                  policy={options.policy}
                  disabled={locked}
                  submit={submit}
                />
              )}
          </>}
        </CardContent>
      </Card>
      <Card className="panel" aria-label="勤務契約とスキル">
        <SettingHeading title="勤務契約・習熟度・対応可能な担当" level={2} />
        <CardContent className="panel-body">
          <p className="muted">
            選択したスタッフの勤務契約・習熟度・対応可能な担当を対象月 {month} から設定します。企業・雇用区分・個人のルールをすべて満たす必要があり、個人設定で共通条件は緩和できません。過去に凍結した計算入力は保持します。
          </p>
          {error?.kind === "contract" && <p className="error" role="alert">{error.message}</p>}
        <Field title="契約を編集するスタッフ">
          <NativeSelect
            value={selected}
            disabled={locked || staff.length === 0}
            onChange={async (e) => { const inputValue = e.target.value;
              if (inputValue !== selected && !await unsaved.allow()) return;
              setError(null);
              setSelected(inputValue);
            }}
          >
            <option value="">選択してください</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.staff_number} · {s.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
          {waiting ? <Loading label="契約条件を取得しています…" /> : failedFor === loadKey && availableFor !== contentScope ? (
            <p className="error" role="alert">契約条件を取得できませんでした。最新の入力を読み直してください。</p>
          ) : options && <>
              {selected &&
              config &&
              options.policy &&
              options.employment.length > 0 ? (
                <ProfileForm
                  key={
                    selected + month
                  }
                  initial={profile}
                  options={options}
                  config={config}
                  disabled={locked}
                  submit={(payload, saved) => save(`/companies/${company}/inputs/teams/${team}/staff/${selected}/contract`, payload, saved)}
                  nameOf={nameOf}
                />
              ) : (
                selected && (
                  <p className="warning">
                    個人契約の登録には企業共通ルール、雇用区分、チーム設定が必要です。
                  </p>
                )
              )}
            {staff.length === 0 && <p className="muted">スタッフを登録すると、個別の勤務契約・習熟度・対応可能な担当を設定できます。</p>}
          </>}
        </CardContent>
      </Card>
    </div>
  );
}

function NewEmployment({
  policy,
  disabled,
  submit,
}: {
  policy: z.infer<typeof companyPolicy>;
  disabled: boolean;
  submit: (f: HTMLFormElement, kind: "employment", id: string, saved?: () => void) => void;
}) {
  const [id, setId] = useState(() => crypto.randomUUID());
  return (
    <details>
      <summary>雇用区分を追加</summary>
      <p className="muted">
        企業共通条件を初期表示します。内容を確認して登録してください。
      </p>
      <UnsavedForm preserveOtherInputs key={id}
        onSubmit={(e) => {
          e.preventDefault();
          submit(e.currentTarget, "employment", id, () => setId(crypto.randomUUID()));
        }}
      >
        <fieldset disabled={disabled}>
          <Field title="雇用区分名">
            <Input name="name" required maxLength={120} />
          </Field>
          <RuleFields initial={policy.rule} />
          <ContractFields initial={policy.contract} />
          <Button>雇用区分を登録</Button>
        </fieldset>
      </UnsavedForm>
    </details>
  );
}
function ProfileForm({
  initial,
  options,
  config,
  disabled,
  submit,
  nameOf,
}: {
  initial: Profile | null;
  options: Options;
  config: z.infer<typeof teamConfig>;
  disabled: boolean;
  submit: (payload: Profile, saved?: () => void) => Promise<void>;
  nameOf: (id: string) => string;
}) {
  const employment =
    options.employment.find((e) => e.id === initial?.employmentTypeId) ??
    options.employment[0];
  const [own, setOwn] = useState(
    initial?.rule !== null && initial?.rule !== undefined,
  );
  return (
    <SectionSettingsForm initial={initial} disabled={disabled} save={submit}
      allLabel={initial ? "勤務契約・習熟度・対応可能な担当をすべて保存" : "勤務契約・習熟度・対応可能な担当を登録"}
      fingerprints={{contract: String(own)}}
      build={(f, scope, base) => staffContract.parse({
        ...base,
        ...((scope === 'all' || scope === 'contract') && {employmentTypeId: f.get('employment'), contract: readContract(f), rule: f.get('ownRule') ? readRule(f, 'personal-') : null}),
        ...((scope === 'all' || scope === 'skills') && {skills: config.tasks.flatMap(task => {
          const value = f.get('skill-' + task.id);
          return value === '' ? [] : [{taskId: task.id, level: Number(value)}];
        })}),
        ...((scope === 'all' || scope === 'roles') && {roleIds: f.getAll('role')}),
      })}>
        <SettingsSection scope="contract" title="勤務契約・個人ルール">
        <Field title="適用する雇用区分">
          <NativeSelect
            name="employment"
            defaultValue={initial?.employmentTypeId ?? employment.id}
          >
            {options.employment.map((e) => (
              <option key={e.id} value={e.id}>
                {e.payload.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <ContractFields
          initial={initial?.contract ?? employment.payload.contract}
        />
        <div className="field-heading"><label className="check-row">
          <Input
            name="ownRule"
            type="checkbox"
            checked={own}
            onChange={(e) => setOwn(e.target.checked)}
          />
          個人の追加勤務ルールを設定する
        </label>
        <InfoHelp title="個人の追加勤務ルールを設定する">企業・雇用区分の条件に加えて、この人だけの条件を登録します。共通の上限や下限を緩めることはできません。</InfoHelp>
        </div>
        {own && (
          <RuleFields
            prefix="personal-"
            initial={initial?.rule ?? employment.payload.rule}
          />
        )}
        </SettingsSection>
        <SettingsSection scope="skills" title="業務ごとの習熟度">
        <p className="muted">
          最低習熟度による業務の適格性と、処理能力の換算係数は別の設定です。係数は業務設定から取得します。
        </p>
        <div className="form-grid">
          {config.tasks.map((task) => (
            <Field
              key={task.id}
              title={
                nameOf(task.id) + "（最低習熟度 " + task.minimumLevel + "）"
              }
            >
              <NativeSelect
                name={"skill-" + task.id}
                defaultValue={
                  initial?.skills.find((s) => s.taskId === task.id)?.level ?? ""
                }
              >
                <option value="">未登録（この業務の配置対象に含めない）</option>
                {options.policy!.skillLevels.map((l) => (
                  <option key={l.level} value={l.level}>
                    {l.name} ／ 換算{" "}
                    {(task.capacities.find((c) => c.level === l.level)
                      ?.capacity ?? 0) / config.capacityScale}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ))}
        </div>
        </SettingsSection>
        <SettingsSection scope="roles" title="対応可能な担当">
        {config.roles.map((role) => (
          <label className="check-row" key={role.id}>
            <Input
              name="role"
              type="checkbox"
              value={role.id}
              defaultChecked={initial?.roleIds.includes(role.id) ?? false}
            />
            {nameOf(role.id)}
          </label>
        ))}
        <p className="muted">
          対応可能な担当は複数選べます。同じ時刻に配置・計数できる担当区分は1つです。
        </p>
        </SettingsSection>
    </SectionSettingsForm>
  );
}
