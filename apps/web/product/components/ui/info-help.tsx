import { Info, X } from "lucide-react";
import { useId, useLayoutEffect, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Text help remains available even inside a disabled settings fieldset. */
export function InfoHelp({ title, children, wide = false, keepMounted = false, variant = "default" }: {
  title: string; children: ReactNode | ((open: boolean) => ReactNode); wide?: boolean; keepMounted?: boolean;
  variant?: "default" | "result";
}) {
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), popup = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState(false), [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 8, top: 8 });
  const pinned = useRef(false), ignoreFocus = useRef(false), ignorePointer = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Keep result help inside the modal's focus/scroll boundary. Its transformed
  // content is also the containing block for the popup's fixed coordinates.
  const portalHost = variant === "result" ? trigger.current?.closest<HTMLElement>("[data-info-help-host]") ?? document.body : document.body;
  const cancel = () => { clearTimeout(timer.current); };
  const show = () => {
    cancel(); document.dispatchEvent(new CustomEvent("setting-help-open", { detail: id })); setOpened(true); setOpen(true);
  };
  const dismiss = (restore = false) => {
    cancel(); pinned.current = false; ignorePointer.current = true; setOpen(false);
    if (restore) { ignoreFocus.current = true; trigger.current?.focus(); }
  };
  const leave = () => {
    cancel();
    if (!pinned.current) timer.current = setTimeout(() => {
      if (!trigger.current?.contains(document.activeElement) && !popup.current?.contains(document.activeElement)) setOpen(false);
    }, 160);
  };
  const toggle = () => { if (pinned.current) dismiss(); else { pinned.current = true; show(); } };
  useEffect(() => () => cancel(), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = trigger.current?.getBoundingClientRect(), p = popup.current?.getBoundingClientRect();
      if (!a || !p) return;
      if (!wide && (a.bottom < 0 || a.top > innerHeight)) { dismiss(); return; }
      const margin = variant === "result" ? 16 : 8;
      const left = Math.max(margin, Math.min(a.left, innerWidth - p.width - margin));
      const top = Math.max(margin, Math.min(a.bottom + 8 + p.height <= innerHeight - margin ? a.bottom + 8 : a.top - p.height - 8, innerHeight - p.height - margin));
      const host = portalHost === document.body ? null : portalHost.getBoundingClientRect();
      setPosition({ left: left - (host ? host.left + portalHost.clientLeft : 0), top: top - (host ? host.top + portalHost.clientTop : 0) });
    };
    const observer = new ResizeObserver(place); if (popup.current) observer.observe(popup.current);
    if (portalHost !== document.body) observer.observe(portalHost);
    place();window.addEventListener("resize", place);window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, title, wide, variant, portalHost]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(true); }
    };
    const another = (event: Event) => { if ((event as CustomEvent).detail !== id) dismiss(); };
    document.addEventListener("pointerdown", outside);document.addEventListener("keydown", escape);document.addEventListener("setting-help-open", another);
    return () => { document.removeEventListener("pointerdown", outside);document.removeEventListener("keydown", escape);document.removeEventListener("setting-help-open", another); };
  }, [open, id]);
  const blur = (next: EventTarget | null) => {
    // Async controls can temporarily disable/remove the focused element. Keep
    // an interactive comparison open until focus actually moves outside it.
    if (wide && next === null) return;
    if (next instanceof Node && (trigger.current?.contains(next) || popup.current?.contains(next))) return;
    ignoreFocus.current = false;
    dismiss();
  };
  return <>
    <span ref={trigger} className="setting-info-trigger" role="button" tabIndex={0}
      aria-label={`${title}の説明`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-describedby={open ? id + "-description" : undefined}
      onPointerEnter={event => { if (event.pointerType !== "touch" && !ignorePointer.current) show(); }} onPointerLeave={() => { ignorePointer.current = false; leave(); }}
      onFocus={() => { if (!ignoreFocus.current) show(); }} onBlur={event => blur(event.relatedTarget)}
      onClick={event => { event.preventDefault(); toggle(); }}
      onKeyDown={event => {
        if (variant === "result" && open && event.key === "Tab" && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation(); popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
        } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
      }}>
      <Info size={16} aria-hidden="true" />
    </span>
    {(open || keepMounted && opened) && createPortal(<div hidden={!open} ref={popup} id={id} role="dialog" aria-modal="false" aria-labelledby={id + "-title"}
      className={"setting-help-popup" + (wide ? " setting-help-popup-wide" : "") + (variant === "result" ? " solver-help-popup" : "")} style={position} onPointerDown={() => { if (wide || variant === "result") pinned.current = true; }} onPointerEnter={cancel} onPointerLeave={leave} onBlur={event => blur(event.relatedTarget)}
      onKeyDown={event => {
        if (variant === "result" && event.key === "Tab" && event.shiftKey && event.target === popup.current?.querySelector("button")) {
          event.preventDefault(); event.stopPropagation(); trigger.current?.focus();
        }
      }}>
      <div className="setting-help-popup-heading"><strong id={id + "-title"}>{variant === "result" && <Info size={18} aria-hidden="true" />}{title}{variant === "result" && "の説明"}</strong>
        <button type="button" aria-label="説明を閉じる" onClick={() => dismiss(true)}><X size={16} aria-hidden="true" /></button></div>
      {typeof children === "string" ? <p id={id + "-description"}>{children}</p> : <div id={id + "-description"}>{typeof children === "function" ? children(open) : children}</div>}
    </div>, portalHost)}
  </>;
}
