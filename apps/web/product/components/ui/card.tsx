import { type ComponentProps } from "react";
import { cn } from "../../lib/utils";
export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section data-slot="card" {...props} className={cn("rounded-xl border border-border bg-card text-card-foreground shadow-xs", className)} />;
}
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" {...props} className={cn("flex flex-wrap items-center justify-between gap-3 border-b p-4 md:p-6", className)} />;
}
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" {...props} className={cn("min-w-0 p-4 md:p-6", className)} />;
}
