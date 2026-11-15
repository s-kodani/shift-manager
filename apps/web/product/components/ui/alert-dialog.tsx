import * as Primitive from "@radix-ui/react-alert-dialog";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";

type Request = { message: string; settle: (answer: boolean) => void; trigger: HTMLElement | null };
const Context = createContext<(message: string) => Promise<boolean>>(async () => false);
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const active = useRef<Request | null>(null);
  const lastTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => () => { active.current?.settle(false); active.current = null; }, []);
  const finish = (answer: boolean) => {
    const current = active.current; active.current = null; setRequest(null);
    current?.settle(answer);
  };
  return <Context.Provider value={message => {
    if (active.current) return Promise.resolve(false);
    return new Promise(resolve => {
      const next = { message, settle: resolve, trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null };
      lastTrigger.current = next.trigger;
      active.current = next; setRequest(next);
    });
  }}>
    {children}
    <Primitive.Root open={request !== null} onOpenChange={open => { if (!open) finish(false); }}>
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content className="dialog-content" onCloseAutoFocus={event => {
          event.preventDefault(); if (lastTrigger.current?.isConnected) lastTrigger.current.focus();
        }}>
          <Primitive.Title className="text-lg font-semibold">変更を破棄しますか？</Primitive.Title>
          <Primitive.Description className="text-sm leading-relaxed text-muted-foreground">{request?.message}</Primitive.Description>
          <div className="dialog-actions">
            <Primitive.Cancel asChild><Button onClick={() => finish(false)}>編集を続ける</Button></Primitive.Cancel>
            <Primitive.Action asChild><Button variant="destructive" onClick={() => finish(true)}>変更を破棄して進む</Button></Primitive.Action>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  </Context.Provider>;
}
export function useConfirmation() { return useContext(Context); }
