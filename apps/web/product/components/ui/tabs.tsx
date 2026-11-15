import * as Primitive from "@radix-ui/react-tabs";
import { type ComponentProps } from "react";
import { cn } from "../../lib/utils";
export const Tabs = Primitive.Root;
export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return <Primitive.List {...props} className={cn("inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1", className)} />;
}
export function TabsTrigger({ className, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger {...props} className={cn("min-h-10 rounded-md px-4 py-2 text-sm font-medium text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs", className)} />;
}
export const TabsContent = Primitive.Content;
