import * as Dialog from "@radix-ui/react-alert-dialog";
import { MoreHorizontal, ShieldCheck, ShieldOff, UserCheck, UserX, Trash2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./components/ui";
import type { Staff } from "./api";

export function StaffActions({ staff, companyAdmin, disabled, changeRole, changeStatus }: {
  staff: Staff[number]; companyAdmin: boolean; disabled: boolean;
  changeRole: () => void; changeStatus: (status: "active" | "inactive" | "deleted") => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<"active" | "inactive" | "deleted" | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last">("first");
  const inactive = staff.status === "inactive";
  const protectedAccount = staff.can_manage_status === 0;
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const place = () => {
      if (!trigger.current || !menu.current) return;
      const rect = trigger.current.getBoundingClientRect(), popup = menu.current.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(rect.right - popup.width, document.documentElement.clientWidth - popup.width - 8)),
        top: rect.bottom + popup.height + 8 > innerHeight ? Math.max(8, rect.top - popup.height - 4) : rect.bottom + 4 });
    };
    place();
    const items = menu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    (items[initialFocus.current === "last" ? items.length - 1 : 0] ?? menu.current).focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("pointerdown", outside); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const statusTitle = confirmation === "deleted" ? "削除" : confirmation === "inactive" ? "非アクティブ化" : "再有効化";
  return <>
    <Button ref={trigger} variant="ghost" size="icon" type="button" disabled={disabled}
      aria-label={`${staff.name}の操作メニュー`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => { initialFocus.current = "first"; setOpen(!open); }}
      onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); initialFocus.current = event.key === "ArrowUp" ? "last" : "first"; setOpen(true); } }}>
      <MoreHorizontal aria-hidden="true" />
    </Button>
    {open && createPortal(<div ref={menu} id={menuId} tabIndex={-1} role="menu" aria-label={`${staff.name}の操作`} className="staff-action-menu"
      style={position} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === "Tab") { close(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
      }}>
      {companyAdmin && <button type="button" role="menuitem" disabled={staff.role === null || inactive} onClick={() => { close(); changeRole(); }}>
        {staff.role === "team_admin" ? <ShieldOff aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
        {staff.role === "team_admin" ? "管理者を解除" : "管理者を付与"}
      </button>}
      <button type="button" role="menuitem" disabled={protectedAccount} onClick={() => { close(); setConfirmation(inactive ? "active" : "inactive"); }}>
        {inactive ? <UserCheck aria-hidden="true" /> : <UserX aria-hidden="true" />}{inactive ? "再有効化" : "非アクティブ化"}
      </button>
      <div role="separator" />
      <button type="button" role="menuitem" className="destructive" disabled={protectedAccount} onClick={() => { close(); setConfirmation("deleted"); }}>
        <Trash2 aria-hidden="true" />削除
      </button>
      {protectedAccount && <p className="staff-action-help">自分自身・企業管理者・他チームと共有するアカウントは停止・削除できません。</p>}
    </div>, document.body)}
    <Dialog.Root open={confirmation !== null} onOpenChange={value => { if (!value) setConfirmation(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
          <Dialog.Title className="text-lg font-semibold">{staff.name}を{statusTitle}しますか？</Dialog.Title>
          <Dialog.Description className="text-sm leading-relaxed text-muted-foreground">
            {confirmation === "deleted" ? "スタッフ一覧から除外し、ログインと新規の計算対象から外します。この操作は取り消せません。過去の勤務・監査履歴と公開済みシフトは保持します。" :
              confirmation === "inactive" ? "ログインと新規の計算対象から外します。後で再有効化できます。過去の勤務・監査履歴と公開済みシフトは保持します。" :
              "ログインと新規の計算対象に戻します。保存済みの契約・勤務条件を引き継ぎます。"}
          </Dialog.Description>
          <div className="dialog-actions">
            <Dialog.Cancel asChild><Button>キャンセル</Button></Dialog.Cancel>
            <Dialog.Action asChild><Button variant={confirmation === "active" ? "default" : "destructive"} onClick={() => { if (confirmation) changeStatus(confirmation); }}>{statusTitle}する</Button></Dialog.Action>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
