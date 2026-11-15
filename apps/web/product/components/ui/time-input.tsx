import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Input } from "./controls";
import { formatTimeInput, parseTimeInput, timeInputError, timeInputPattern } from "../../time-input-model";

type Props = Omit<ComponentProps<"input">, "value" | "defaultValue" | "onChange" | "type" | "step" | "min" | "max" | "pattern" | "maxLength" | "inputMode"> & {
  value: string;
  onValueChange: (value: string) => void;
  stepMinutes?: number;
  allowEndOfDay?: boolean;
  validationMessage?: string;
};
export function TimeInput({ value, onValueChange, stepMinutes = 1, allowEndOfDay = true, validationMessage = "", ...props }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const message = timeInputError(value, stepMinutes, allowEndOfDay) || validationMessage;
  useEffect(() => { ref.current?.setCustomValidity(message); }, [message]);
  return <Input {...props} ref={ref} type="text" inputMode="numeric" maxLength={4}
    pattern={allowEndOfDay ? timeInputPattern : "([01][0-9]|2[0-3])[0-5][0-9]"}
    placeholder="HHMM" title="数字4桁で入力（例：0930）" value={value}
    onChange={e => {
      const next = e.target.value;
      if (!/^[0-9]{0,4}$/.test(next)) return;
      e.target.setCustomValidity(timeInputError(next, stepMinutes, allowEndOfDay));
      onValueChange(next);
    }} />;
}

// Minute-based editors retain partial text without putting NaN or a partial hour into the draft.
export function MinuteTimeInput({ value, onMinutesChange, onEdit, ...props }: Omit<Props, "value" | "onValueChange" | "validationMessage"> & {
  value: number | null;
  onMinutesChange: (value: number | null) => void;
  onEdit: () => void;
}) {
  const [draft, setDraft] = useState({ value, text: value === null ? "" : formatTimeInput(value), error: "" });
  if (draft.value !== value) setDraft({ value, text: value === null ? "" : formatTimeInput(value), error: "" });
  return <TimeInput {...props} value={draft.text} validationMessage={draft.error} onValueChange={text => {
    onEdit();
    if (timeInputError(text, props.stepMinutes, props.allowEndOfDay) || text === "" && props.required) {
      setDraft({ value, text, error: "" }); return;
    }
    const next = text === "" ? null : parseTimeInput(text);
    try { onMinutesChange(next); setDraft({ value: next, text, error: "" }); }
    catch { setDraft({ value, text, error: "この時刻では変更できません。入力条件を確認してください。" }); }
  }} />;
}
