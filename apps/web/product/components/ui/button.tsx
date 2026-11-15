import { type ComponentProps, useContext, useId } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";
import { OperationContext } from "./loading";

export const buttonVariants = cva(
  "relative inline-flex max-w-full min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4",
  { variants: { variant: {
    default: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
    outline: "border-input bg-background text-foreground hover:bg-accent",
    ghost: "border-transparent bg-transparent hover:bg-accent",
    destructive: "border-destructive bg-destructive text-white hover:bg-destructive/90",
  }, size: { default: "px-4 py-2", sm: "min-h-9 px-3 py-1", icon: "size-11 p-2" } },
  defaultVariants: { variant: "outline", size: "default" } },
);

export function Button({ className, variant, size, asChild = false, loading = false,
  children, disabled, onClick, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean; loading?: boolean }) {
  const operation = useContext(OperationContext);
  const id = useId();
  const pending = loading || !!(operation?.busy && operation.action === id);
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" {...props} onClick={event => { operation?.start(id); onClick?.(event); }} disabled={disabled || pending} aria-busy={pending || undefined}
    className={cn(buttonVariants({ variant: variant ?? (className?.split(" ").includes("primary") ? "default" : "outline"), size }), className)}>
    {asChild ? children : <>
      <span className={pending ? "invisible" : undefined} aria-hidden={pending || undefined}>{children}</span>
      {pending && <span className="absolute inset-0 flex items-center justify-center gap-2 px-2"><span className="ui-spinner" aria-hidden="true" />{typeof children === "string" && /中|しています/.test(children) ? children : typeof children === "string" && children.includes("保存") ? "保存中…" : "処理中…"}</span>}
    </>}
  </Comp>;
}
