import { createContext, useContext, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, SettingHeading } from './components/ui';
import { UnsavedForm } from './unsaved-input';
import { SettingsInputError } from './settings-input-error';
import { flushSync } from 'react-dom';

export type SectionSave<T> = (payload: T, saved?: () => void) => Promise<void>;
const Context = createContext<{ registered: boolean; stale: boolean; dirty: Set<string>; errors: Record<string,string>; saved: string } | null>(null);
const all = 'all';

/** One resource/version, with explicit section payloads and independent dirty receipts. */
export function SectionSettingsForm<T>({ initial, disabled, save, build, allLabel, fingerprints = {}, onSaved, revealSection, children }: {
  initial: T | null; disabled: boolean; save: SectionSave<T>;
  build: (form: FormData, section: string, saved: T | null) => T;
  allLabel: string; fingerprints?: Record<string,string>;
  onSaved?: (section: string, payload: T) => void; children: ReactNode;
  revealSection?: (section: string) => void;
}) {
  const form = useRef<HTMLFormElement | null>(null), resource = useRef(initial), source = useRef(JSON.stringify(initial));
  const baselines = useRef<Record<string,string>>({}), receipt = useRef<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set()), [errors, setErrors] = useState<Record<string,string>>({}), [saved, setSaved] = useState(''), [stale, setStale] = useState(false);
  const read = () => Object.fromEntries([...form.current!.querySelectorAll<HTMLElement>('[data-settings-section]')].map(section => {
    const key = section.dataset.settingsSection!;
    // Paginated controlled editors supply the full draft through fingerprints.
    // Their mounted cells and view controls must not change the dirty baseline.
    const values = [...section.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')].filter(input => !input.closest('[data-settings-virtual]')).map(input => [input.name, input.type, input.value, input instanceof HTMLInputElement ? input.checked : null]);
    return [key, JSON.stringify([values, fingerprints[key]])];
  }));
  useLayoutEffect(() => {
    if (!form.current) return;
    const current = read();
    if (!Object.keys(baselines.current).length) baselines.current = current;
    if (receipt.current) {
      for (const key of Object.keys(current)) if (receipt.current === all || key === receipt.current) baselines.current[key] = current[key];
      receipt.current = null;
    }
    const next = new Set(Object.keys(current).filter(key => current[key] !== baselines.current[key]));
    setDirty(previous => [...previous].join('|') === [...next].join('|') ? previous : next);
  });
  useLayoutEffect(() => {
    const next = JSON.stringify(initial);
    if (source.current === next) return;
    source.current = next;
    // Own receipts update resource before the parent refresh. External changes
    // must be reviewed, never merged into an old full-resource submission.
    if (next !== JSON.stringify(resource.current)) setStale(true);
  }, [initial]);
  const changed = () => {
    const current = read();
    setDirty(new Set(Object.keys(current).filter(key => current[key] !== baselines.current[key])));
    setSaved('');
  };
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || stale) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const scope = submitter instanceof HTMLButtonElement ? submitter.value || all : all;
    if (scope !== all && !Object.hasOwn(baselines.current, scope)) return;
    const section = scope === all ? event.currentTarget : [...event.currentTarget.querySelectorAll<HTMLElement>('[data-settings-section]')].find(el => el.dataset.settingsSection === scope)!;
    for (const input of section.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) {
      if (input.closest('[data-settings-view]') || input.validity.valid) continue;
      const scope = input.closest<HTMLElement>('[data-settings-section]')?.dataset.settingsSection;
      if (scope && revealSection) flushSync(() => revealSection(scope));
      const disclosure = input.closest<HTMLElement>('[data-bulk-disclosure]');
      if (disclosure?.hidden) {
        const trigger = form.current?.querySelector<HTMLButtonElement>(`button[aria-controls="${CSS.escape(disclosure.id)}"]`);
        flushSync(() => trigger?.click());
      }
      input.reportValidity();
      return;
    }
    setErrors(previous => ({...previous, [scope]: ''})); setSaved('');
    try {
      if (scope !== all && resource.current === null) throw Error('INITIAL_REGISTRATION_REQUIRED');
      const payload = build(new FormData(event.currentTarget), scope, resource.current);
      void save(payload, () => {
        resource.current = payload;
        onSaved?.(scope, payload);
        receipt.current = scope;
        setErrors(previous => scope === all ? {} : {...previous, [scope]: ''});
        setSaved(scope);
      });
    } catch (error) {
      setErrors(previous => ({...previous, [scope]: error instanceof SettingsInputError ? error.explanation
        : error instanceof Error && error.message === 'INITIAL_REGISTRATION_REQUIRED'
        ? '初回は必要な設定を入力して、すべての設定を登録してください。'
        : error instanceof Error && error.message === 'BULK_NOT_APPLIED' ? 'この見出しの一括入力を反映するか、リセットしてから保存してください。'
        : error instanceof Error && error.message === 'PREPARATION_EXCEEDS_SLOT' ? '準備・移動は業務配置1枠以内で入力してください。保存していません。'
        : 'この見出しの入力と保存済みの関連設定を確認してください。複数の見出しに関係する変更は、すべての設定をまとめて保存してください。保存していません。'}));
    }
  }
  return <Context.Provider value={{registered: resource.current !== null, stale, dirty, errors, saved}}>
    <UnsavedForm ref={form} noValidate preserveOtherInputs dirty={dirty.size > 0} onInputCapture={changed} onChangeCapture={changed} onSubmit={submit}
      onKeyDown={event => {
        if (event.target instanceof HTMLElement && event.target.closest('[data-settings-view]')) {
          if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
          return;
        }
        if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || ['button','submit','checkbox','radio'].includes(event.target.type)) return;
        const section = event.target.closest('[data-settings-section]');
        const button = section?.querySelector<HTMLButtonElement>('button[name="saveSection"]');
        if (button) { event.preventDefault(); if (!button.disabled) event.currentTarget.requestSubmit(button); }
      }}>
      <fieldset disabled={disabled || stale}>
        {children}
        <div className="form-actions"><Button type="submit" name="saveSection" value={all}>{allLabel}</Button></div>
        {errors[all] && <p role="alert" className="error">{errors[all]}</p>}
        {saved === all && <p role="status">すべての設定を保存しました。</p>}
      </fieldset>
      {stale && <p className="error" role="alert">保存元の設定が更新されました。未保存の内容を確認し、ページを再読み込みして最新の設定を読み直してください。</p>}
    </UnsavedForm>
  </Context.Provider>;
}

export function SettingsSection({ scope, title, actions, children }: { scope: string; title: string; actions?: ReactNode; children: ReactNode }) {
  const context = useContext(Context)!;
  return <section data-settings-section={scope} aria-label={title} className="settings-section">
    <SettingHeading title={title} level={3} />
    {children}
    <div className="form-actions">{actions}<Button className="primary" type="submit" name="saveSection" value={scope} disabled={!context.registered}>{title}を保存</Button>
      <span className="muted">{!context.registered ? '初回は末尾のボタンですべての設定を登録してください。' : context.dirty.has(scope) ? 'この見出しに未保存の変更があります。' : 'この見出し内だけを保存します。'}</span>
    </div>
    {context.errors[scope] && <p role="alert" className="error">{context.errors[scope]}</p>}
    {context.saved === scope && <p role="status">{title}を保存しました。</p>}
  </section>;
}
