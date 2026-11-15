import { createContext, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../lib/utils";
export const OperationContext = createContext<{ busy: boolean; action?: string; start: (id: string) => void } | null>(null);
export function OperationBoundary({ busy, children }: { busy: boolean; children: ReactNode }) {
  const [action, start] = useState<string>();
  return <OperationContext.Provider value={{ busy, action, start }}>{children}</OperationContext.Provider>;
}
export function Spinner({ className, ...props }: ComponentProps<"span">) {
  return <span {...props} aria-hidden="true" className={cn("ui-spinner", className)} />;
}
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} aria-hidden="true" data-slot="skeleton" className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} />;
}
export function Loading({ label = "読み込んでいます…", rows = 3, compact = false }: { label?: string; rows?: number; compact?: boolean }) {
  return <div className="loading-region" aria-busy="true" data-slot="loading">
    <p className="loading-label" role="status"><Spinner />{label}</p>
    {!compact && <div className="grid gap-4" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className={i === 0 ? "h-5 w-2/3" : "h-11 w-full"} />)}</div>}
  </div>;
}
