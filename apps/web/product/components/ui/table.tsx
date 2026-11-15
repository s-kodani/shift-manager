import { type ComponentProps } from "react";
import { cn } from "../../lib/utils";
export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table data-slot="table" {...props} className={cn("w-full caption-bottom text-sm", className)} />;
}
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th data-slot="table-head" {...props} className={cn("border-b bg-muted/50 px-4 py-3 text-left align-middle text-xs font-medium text-muted-foreground", className)} />;
}
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td data-slot="table-cell" {...props} className={cn("border-b px-4 py-3 align-middle", className)} />;
}
