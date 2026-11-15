import * as Dialog from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";
import { Button } from "./components/ui";

export function ScheduleActionDialog({ title, description, compact = false, closeLabel = `${title}を閉じる`, onClose, children }: {
  title: string; description: string; compact?: boolean; closeLabel?: string; onClose: () => void; children: ReactNode;
}) {
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const content = useRef<HTMLDivElement>(null);
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="staff-dialog-overlay" />
      <Dialog.Content ref={content} data-info-help-host className={`staff-dialog-content schedule-action-dialog${compact ? " schedule-publish-dialog" : ""}`} onEscapeKeyDown={event => {
        // InfoHelp consumes Escape in its document listener after Radix's
        // capture listener. Leave the results open while that help is visible.
        if (content.current?.querySelector('.solver-help-popup:not([hidden])')) event.preventDefault();
      }} onCloseAutoFocus={event => {
        event.preventDefault();
        if (returnFocus.current?.isConnected) returnFocus.current.focus();
      }}>
        <div className="staff-dialog-heading">
          <div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
          <Button type="button" aria-label={closeLabel} onClick={onClose}>閉じる</Button>
        </div>
        <div className="staff-dialog-body">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
