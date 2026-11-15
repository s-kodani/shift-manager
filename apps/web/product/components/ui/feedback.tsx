import { type ComponentProps } from "react";
import { cn } from "../../lib/utils";
export function Badge({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="badge" {...props} className={cn("inline-flex items-center rounded-md border border-border bg-secondary px-2 py-1 text-xs font-medium", className)} />;
}
export function Alert({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert" {...props} className={cn("rounded-lg border border-border bg-card p-4 text-sm", className)} />;
}
