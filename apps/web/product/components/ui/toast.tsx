import * as ToastPrimitive from "@radix-ui/react-toast";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

type Kind = "success" | "info" | "warning" | "error";
type Notice = { id: number; message: string; kind: Kind; key: string };
let notices: Notice[] = [], sequence = 0;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(fn => fn());
function add(kind: Kind, message: string, key = kind + ":" + message) {
  if (!message) return;
  const existing = notices.find(n => n.key === key);
  if (existing) return existing.id;
  const id = ++sequence;
  notices = [...notices, { id, message, kind, key }]; publish(); return id;
}
export const notify = {
  success: (message: string, key?: string) => add("success", message, key),
  info: (message: string, key?: string) => add("info", message, key),
  warning: (message: string, key?: string) => add("warning", message, key),
  error: (message: string, key?: string) => add("error", message, key),
  dismiss(id: number) { notices = notices.filter(n => n.id !== id); publish(); },
  clear() { notices = []; publish(); },
};
export function useNotification(message: string, kind: Kind = "success") {
  useEffect(() => { if (message) add(kind, message); }, [message, kind]);
}
export function Notification({ children, kind = "success" }: { children: ReactNode; kind?: Kind }) {
  useNotification(typeof children === "string" ? children : "", kind); return null;
}
export function Toaster() {
  const items = useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => notices);
  return <ToastPrimitive.Provider swipeDirection="right">
    {items.map(n => <ToastPrimitive.Root key={n.id} open onOpenChange={open => { if (!open) notify.dismiss(n.id); }}
      duration={5000}
      type={n.kind === "error" ? "foreground" : "background"}
      className={cn("toast-item", "toast-" + n.kind)}>
      <ToastPrimitive.Description className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{n.message}</ToastPrimitive.Description>
      <ToastPrimitive.Close className="toast-close" aria-label="通知を閉じる"><X size={16} /></ToastPrimitive.Close>
    </ToastPrimitive.Root>)}
    <ToastPrimitive.Viewport className="toast-viewport" aria-label="通知" />
  </ToastPrimitive.Provider>;
}
