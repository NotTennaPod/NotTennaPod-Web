// Small building blocks in Android's Material style: the screen toolbar, an
// overflow menu, empty states and confirmation dialogs.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.ts";
import type { IconName } from "../generated/icons.ts";
import { Icon } from "./Icon.tsx";
import { failureText, track } from "./progress.ts";
import { useValue } from "../app/useView.ts";
import { ActionModeBar, actionMode } from "./selection.tsx";

export function Toolbar({ title, children }: { title: string; children?: ComponentChildren }) {
  useEffect(() => {
    document.title = title ? `${title} · NotTennaPod` : "NotTennaPod";
  }, [title]);
  const mode = useValue(actionMode);
  if (mode) return <ActionModeBar mode={mode} />;
  return (
    <header class="toolbar">
      <h1>{title}</h1>
      <div class="toolbar-actions">{children}</div>
    </header>
  );
}

export function IconButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button class="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  );
}

export interface MenuItem {
  label: string;
  run: () => void | Promise<void>;
  checked?: boolean;
  disabled?: boolean;
}

/** A point in the window where a context menu opens (a right-click, or the menu key). */
export interface MenuPoint {
  x: number;
  y: number;
}

/**
 * Menu is an overflow menu: a button that opens a list of actions,
 * keyboard-operable. Given `at`, the same list opens there as the row's
 * context menu (Android's long-press menu; a right-click in a browser), and
 * `onDismiss` hears when it closes.
 */
export function Menu({ label, items, icon, at, onDismiss, contextOnly }: {
  label: string;
  items: MenuItem[];
  icon?: ComponentChildren;
  at?: MenuPoint | null;
  onDismiss?: () => void;
  /** contextOnly: no button, only the context menu (what Android opens by a long press). */
  contextOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const shown = open || !!at;
  const close = (refocus: boolean) => {
    setOpen(false);
    onDismiss?.();
    if (refocus) button.current?.focus();
  };
  useLayoutEffect(() => {
    if (!shown) return;
    const outside = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", outside);
    // A context menu stays in the window: it opens towards the room there is.
    const l = list.current;
    if (at && l) {
      const r = l.getBoundingClientRect();
      l.style.left = `${Math.max(8, at.x + r.width > innerWidth - 8 ? at.x - r.width : at.x)}px`;
      l.style.top = `${Math.max(8, at.y + r.height > innerHeight - 8 ? at.y - r.height : at.y)}px`;
    }
    ref.current?.querySelector<HTMLElement>("[role=menuitem], [role=menuitemcheckbox]")?.focus();
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", outside);
    };
  }, [shown, at]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && shown) {
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
  };
  return (
    <div class="menu" ref={ref} onKeyDown={onKey}>
      {!contextOnly && (
        <button ref={button} class="icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={shown} onClick={() => (shown ? close(false) : setOpen(true))}>
          {icon ?? <MoreIcon />}
        </button>
      )}
      {shown && (
        <ul ref={list} class={`menu-list${at ? " context" : ""}`} role="menu" aria-label={label}>
          {items.map((item, i) => (
            <li key={i} role="none">
              <button
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked}
                disabled={item.disabled}
                onClick={() => {
                  close(false);
                  void track(item.run());
                }}
              >
                {item.checked !== undefined && <span class="check" aria-hidden="true">{item.checked ? "✓" : ""}</span>}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * contextPoint is where a context menu opens for a contextmenu event: the
 * pointer, or below the element for the keyboard's menu key.
 */
export function contextPoint(e: MouseEvent): MenuPoint {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const r = (e.currentTarget as Element).getBoundingClientRect();
  return { x: r.left + 16, y: r.top + 16 };
}

/** The overflow icon (Material's more_vert, which Android's menus show). */
export function MoreIcon() {
  return (
    <svg class="icon" width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12,8c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM12,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2zM12,16c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2z" fill="currentColor" />
    </svg>
  );
}

export function Empty({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div class="empty">
      <Icon name={icon} size={48} />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

/**
 * Confirm is Android's confirmation dialog: a title, a message, Cancel and
 * Confirm. An action that reads the server first keeps the dialog open, with
 * progress, until it is journaled; the caller closes it then. A failure is
 * shown in the dialog.
 */
export function Confirm({ title, message, confirm, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirm?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const run = async () => {
    setBusy(true);
    setFailed(undefined);
    try {
      await onConfirm();
    } catch (e) {
      setFailed(failureText(e));
    } finally {
      if (ref.current?.isConnected) setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="confirm-title"
      aria-busy={busy}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p>{message}</p>
      {busy && <progress class="dialog-progress" aria-label={t("please_wait")} />}
      {failed && (
        <p class="dialog-error" role="alert" dir="auto">
          {failed}
        </p>
      )}
      <div class="dialog-buttons">
        <button class="text-button" onClick={onCancel} disabled={busy}>
          {t("cancel_label")}
        </button>
        <button class="text-button" onClick={() => void run()} disabled={busy}>
          {confirm ?? t("confirm_label")}
        </button>
      </div>
    </dialog>
  );
}

export function Loading() {
  return <div class="loading" role="progressbar" aria-busy="true" />;
}
