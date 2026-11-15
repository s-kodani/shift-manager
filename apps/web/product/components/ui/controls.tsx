import { type ComponentProps } from "react";
import { cn } from "../../lib/utils";

const control = "box-border w-full min-w-0 max-w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";
export function Checkbox({ className, ...props }: ComponentProps<"input">) {
  // Native semantics retain FormData, validation, label activation and capture events.
  return <input {...props} type="checkbox" data-slot="checkbox" className={cn("size-4 shrink-0 rounded border-input accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50", className)} />;
}
export function Input({ className, ...props }: ComponentProps<"input">) {
  if (props.type === "checkbox") return <Checkbox {...props} className={className} />;
  // iOS's native date theme forces content-box/min-width after CSS resolution.
  // Disable its appearance so percentage widths include padding and borders.
  // The input type and native picker/validation semantics stay intact.
  const dateTime = ["date", "month", "week", "time", "datetime-local"].includes(props.type ?? "");
  return <input data-slot="input" {...props} className={cn(control, "min-h-11", dateTime && "appearance-none", props.type === "radio" && "size-4 min-h-0 w-auto accent-primary", className)} />;
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" {...props} className={cn(control, "min-h-24 resize-y", className)} />;
}
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  const single = !props.multiple && (!props.size || props.size === 1);
  return <select data-slot="native-select" {...props} className={cn(control, "min-h-11", single && "ui-native-select appearance-none pr-10", className)} />;
}
