import { Alert, Button, Input, Loading, NativeSelect, OperationBoundary } from "./components/ui";
import { UnsavedForm, useUnsavedInput, usePendingOperation } from "./unsaved-input";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api, ApiError } from "./api";
import { Field } from "./contract-forms";
import {
  publishedFixedState,
  releasePublishedFixed,
  fixedPart,
} from "../../api/src/published-fixed-contract";

const names = { pattern: "勤務パターン", time: "出退勤", break: "休憩" };
const receipt = z.object({
  releaseId: z.string().uuid(),
  revision: z.number().int(),
  replayed: z.boolean(),
});
export function PublishedFixed({
  base,
  id,
  revision,
  person,
  nameOf,
  report,
  onReleased,
}: {
  base: string;
  id: string;
  revision: number;
  person: string | undefined;
  nameOf: (id: string) => string;
  report: (e: unknown) => void;
  onReleased: () => Promise<unknown>;
}) {
  const [state, setState] = useState<z.infer<
      typeof publishedFixedState
    > | null>(null),
    [day, setDay] = useState(""),
    [parts, setParts] = useState<z.infer<typeof fixedPart>[]>([]),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<z.infer<
      typeof releasePublishedFixed
    > | null>(null);
  const [loadError, setLoadError] = useState(false);
  const unsaved = useUnsavedInput();
  usePendingOperation(busy || !!pending);
  const controller = useRef<AbortController | null>(null),
    lock = useRef(false);
  useEffect(() => {
    setDay("");
    setParts([]);
  }, [person]);
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    setBusy(false);
    setState(null);
    setLoadError(false);
    setParts([]);
    setDay("");
    void api(
      base + "/" + id + "/fixed",
      publishedFixedState,
      undefined,
      c.signal,
    )
      .then((s) => {
        if (!c.signal.aborted) setState(s);
      })
      .catch((e) => {
        if (!c.signal.aborted) { setLoadError(true); report(e); }
      });
    return () => c.abort();
  }, [base, id, revision]);
  const run = async (command: z.infer<typeof releasePublishedFixed>) => {
    if (lock.current) return;
    lock.current = true;
    const signal = controller.current?.signal;
    setBusy(true);
    setPending(command);
    try {
      await api(base + "/" + id + "/fixed/release", receipt, command, signal);
      if (signal?.aborted) return;
      setPending(null);
      setParts([]);
      await onReleased();
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof ApiError && e.status >= 400 && e.status < 500)
        setPending(null);
      report(e);
    } finally {
      lock.current = false;
      if (!signal?.aborted) setBusy(false);
    }
  };
  const dates = [
      ...new Set(
        state?.locks.filter((l) => l.staffId === person).map((l) => l.date) ??
          [],
      ),
    ].sort(),
    selected = dates.includes(day) ? day : (dates[0] ?? "");
  const available = new Set(
    state?.locks
      .filter((l) => l.staffId === person && l.date === selected)
      .flatMap((l) => l.parts) ?? [],
  );
  return <OperationBoundary busy={busy}>{(
    <section className="setup-row" aria-labelledby="published-fixed-heading">
      <h4 id="published-fixed-heading">公開勤務の明示固定</h4>
      <p className="muted">
        休暇承認・欠勤取消の確定前に、対象勤務の固定を管理者が解除します。解除しても公開済みの出退勤・休憩は維持します。
      </p>
      {!state ? (
        loadError ? <p className="error" role="alert">固定を取得できませんでした。最新の入力を読み直してください。</p> : <Loading label="固定を確認しています…" />
      ) : !dates.length ? (
        <p>このスタッフの現在の公開版に、明示固定はありません。</p>
      ) : (
        <UnsavedForm dirty={parts.length > 0}
          onSubmit={(e) => {
            e.preventDefault();
            if (!person || !selected || !parts.length) return;
            void run(
              releasePublishedFixed.parse({
                operationId: crypto.randomUUID(),
                expectedRevision: state.inputRevision,
                publicationId: id,
                expectedPublicationRevision: state.publicationRevision,
                staffId: person,
                date: selected,
                parts,
              }),
            );
          }}
        >
          <fieldset disabled={busy || !!pending}>
            <Field title="固定を解除する勤務日">
              <NativeSelect
                value={selected}
                onChange={async (e) => { const inputValue = e.target.value;
                  if (inputValue !== selected && !await unsaved.allow()) return;
                  setDay(inputValue);
                  setParts([]);
                }}
              >
                {dates.map((d) => (
                  <option key={d} value={d}>
                    {d} ／ {person && nameOf(person)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <p>解除する対象を選択してください。</p>
            <div
              className="weekday-options"
              role="group"
              aria-label="解除する固定"
            >
              {fixedPart.options
                .filter((p) => available.has(p))
                .map((p) => (
                  <label key={p}>
                    <Input
                      type="checkbox"
                      checked={parts.includes(p)}
                      onChange={(e) =>
                        setParts((old) =>
                          e.target.checked
                            ? [...old, p]
                            : old.filter((v) => v !== p),
                        )
                      }
                    />
                    {names[p]}の固定を解除
                  </label>
                ))}
            </div>
            <div className="form-actions">
              <Button disabled={!parts.length}>選択した固定を解除</Button>
            </div>
          </fieldset>
        </UnsavedForm>
      )}
      {pending && (
        <Alert className="alert warning">
          <p>
            解除の応答を確認できていません。同じ操作の結果を確認してください。
          </p>
          <Button disabled={busy} onClick={() => void run(pending)}>
            同じ固定解除を確認
          </Button>
        </Alert>
      )}
      {!!state?.releases.filter((r) => r.staffId === person).length && (
        <details>
          <summary>この公開版での解除履歴</summary>
          {state.releases
            .filter((r) => r.staffId === person)
            .map((r) => (
              <p key={r.id}>
                {r.date}：{r.parts.map((p) => names[p]).join("・")}を解除 ／{" "}
                {new Date(r.recordedAt).toLocaleString("ja-JP", {
                  timeZone: "Asia/Tokyo",
                })}
              </p>
            ))}
        </details>
      )}
    </section>
  )}</OperationBoundary>;
}
