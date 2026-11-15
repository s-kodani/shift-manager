import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ComponentPropsWithRef, type ReactNode } from 'react';
import { UnsavedState } from './unsaved-state';
import { notify, useConfirmation } from './components/ui';

const Context = createContext<UnsavedState | null>(null);
const discardMessage = '未保存の入力があります。変更を破棄して進みますか？';
const pendingMessage = '処理中、または応答が未確認の操作があります。同じ操作の結果を確認してから移動してください。';

export function UnsavedInputProvider({ children }: { children: ReactNode }) {
  const [state] = useState(() => new UnsavedState());
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!state.shouldWarnOnUnload) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [state]);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}

export function useUnsavedInput() {
  const state = useContext(Context);
  const confirm = useConfirmation();
  const allow = async (except?: symbol, preserveOtherInputs = false) => {
    if (state?.blocked) { notify.warning(pendingMessage); return false; }
    const accepted = preserveOtherInputs || !state?.hasDirty(except) || await confirm(discardMessage);
    if (accepted && state?.blocked) { notify.warning(pendingMessage); return false; }
    return accepted;
  };
  return {
    allow,
    async navigate(action: () => void) { if (await allow()) action(); },
    // A form submission already confirmed loss of other forms in capture phase.
    async allowMutation() { return (state?.submission !== null && state?.submission !== undefined) || allow(); },
    get submission() { return state?.submission ?? undefined; },
    acknowledge(id?: symbol) { state?.acknowledge(id); },
  };
}

/** Pending commands stay mounted so their original operation ID can be retried. */
export function usePendingOperation(pending: boolean) {
  const state = useContext(Context), id = useRef(Symbol());
  useLayoutEffect(() => { state?.setPending(id.current, pending); }, [state, pending]);
  useLayoutEffect(() => () => state?.remove(id.current), [state]);
}

/** Non-form inputs such as CSV previews use the same loss and submit boundary. */
export function useUnsavedDraft(dirty: boolean) {
  const state = useContext(Context), id = useRef(Symbol()), guard = useUnsavedInput();
  useLayoutEffect(() => { state?.setDirty(id.current, dirty); });
  useLayoutEffect(() => () => state?.remove(id.current), [state]);
  return {
    async submit<T>(action: () => T): Promise<T | undefined> {
      if (!await guard.allow(id.current)) return;
      const previous = state?.submission ?? null;
      if (state) state.submission = id.current;
      try { return action(); }
      finally { if (state) state.submission = previous; }
    },
  };
}

type Props = ComponentPropsWithRef<'form'> & {
  /** Controlled drafts include structural edits; filters need not mark the form. */
  dirty?: boolean;
  /** Structural edits in an otherwise uncontrolled form. */
  extraDirty?: boolean;
  /** A section save keeps all other mounted drafts intact. */
  preserveOtherInputs?: boolean;
};
export function UnsavedForm({ dirty, extraDirty = false, preserveOtherInputs = false, onInputCapture, onChangeCapture,
  onReset, onSubmitCapture, onSubmit, ...props }: Props) {
  const state = useContext(Context), id = useRef(Symbol()), [edited, setEdited] = useState(false);
  const guard = useUnsavedInput();
  const approved = useRef(false), confirming = useRef(false);
  useLayoutEffect(() => { state?.setDirty(id.current, dirty ?? (edited || extraDirty)); });
  useLayoutEffect(() => {
    state?.registerReceipt(id.current, () => {
      // Controlled drafts are reset by their authoritative response/baseline.
      if (dirty === undefined) { setEdited(false); state?.setDirty(id.current, extraDirty); }
    });
  });
  useLayoutEffect(() => () => state?.remove(id.current), [state]);
  const mark = () => {
    if (dirty !== undefined) return;
    state?.setDirty(id.current, true);
    setEdited(true);
  };
  return <form {...props}
    onInputCapture={event => { mark(); onInputCapture?.(event); }}
    onChangeCapture={event => { mark(); onChangeCapture?.(event); }}
    onReset={event => { onReset?.(event); if (!event.defaultPrevented) { setEdited(false); state?.setDirty(id.current, false); } }}
    onSubmitCapture={event => {
      if (approved.current) { approved.current = false; return; }
      onSubmitCapture?.(event);
      if (event.defaultPrevented) return;
      const form = event.currentTarget;
      const submitter = (event.nativeEvent as SubmitEvent).submitter;
      event.preventDefault(); event.stopPropagation();
      if (confirming.current) return;
      confirming.current = true;
      void guard.allow(id.current, preserveOtherInputs).then(allowed => {
        if (!allowed || !form.isConnected) { confirming.current = false; return; }
        // A microtask may run before the original submit algorithm has finished.
        // Browsers ignore nested requestSubmit during that algorithm; replay on a new task.
        setTimeout(() => {
          confirming.current = false;
          if (!form.isConnected) return;
          if (state?.blocked) { notify.warning(pendingMessage); return; }
          approved.current = true;
          try {
            form.requestSubmit(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : undefined);
          } finally { approved.current = false; }
        }, 0);
      });
    }}
    onSubmit={event => {
      // Browser microtasks can run between native capture and bubble listeners.
      // Scope authorization to the actual React submit handler, not a microtask.
      const previous = state?.submission ?? null;
      if (state) state.submission = id.current;
      try { onSubmit?.(event); }
      finally { if (state) state.submission = previous; }
    }} />;
}
