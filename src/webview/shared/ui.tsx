// Small shared UI pieces for the webviews.
import { useEffect, useState } from "preact/hooks";
import { type CommonHostMessage } from "./protocol";

/** A transient notice at the bottom of the webview (errors from the host, confirmations). */
export function Notice({
  notice,
  onUndo,
}: {
  /** `undo`: the edit the notice reports (its id in the history). */
  notice?: { level: "info" | "error"; message: string; at: number; undo?: number };
  /** Shown as an Undo button on notices that report an edit; undoes that edit. */
  onUndo?: (entry: number) => void;
}) {
  const [visible, setVisible] = useState(false);
  const entry = notice?.undo;
  const undo = entry !== undefined && onUndo;
  useEffect(() => {
    if (!notice) return;
    setVisible(true);
    // Edits stay long enough to be noticed and undone.
    const ms = notice.level === "error" ? 6000 : notice.undo !== undefined ? 10000 : 3000;
    const timer = setTimeout(() => setVisible(false), ms);
    return () => clearTimeout(timer);
  }, [notice?.at]);
  if (!notice || !visible) return null;
  return (
    <div class={`notice ${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
      {notice.message}
      {undo && (
        <button
          class="btn notice-action"
          onClick={() => {
            setVisible(false);
            if (entry !== undefined) undo(entry);
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}

export function noticeFrom(
  m: CommonHostMessage
): { level: "info" | "error"; message: string; at: number; undo?: number } | undefined {
  return m.type === "notice"
    ? { level: m.level, message: m.message, at: Date.now(), undo: m.undo }
    : undefined;
}

/** Imperative tooltip, so that hovering does not re-render large charts. */
export class Tooltip {
  private readonly el: HTMLDivElement;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "tooltip";
    this.el.setAttribute("role", "tooltip");
    document.body.appendChild(this.el);
  }

  show(lines: string[], x: number, y: number): void {
    this.el.replaceChildren();
    lines.forEach((line, i) => {
      if (i === 0) {
        const b = document.createElement("b");
        b.textContent = line;
        this.el.appendChild(b);
      } else {
        this.el.appendChild(document.createTextNode(`\n${line}`));
      }
    });
    this.el.classList.add("visible");
    this.move(x, y);
  }

  move(x: number, y: number): void {
    const pad = 14;
    const rect = this.el.getBoundingClientRect();
    const left = Math.min(x + pad, window.innerWidth - rect.width - 4);
    const top = y + pad + rect.height > window.innerHeight ? y - rect.height - pad : y + pad;
    this.el.style.left = `${Math.max(4, left)}px`;
    this.el.style.top = `${Math.max(4, top)}px`;
  }

  hide(): void {
    this.el.classList.remove("visible");
  }
}

export function UndoRedo({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <>
      <button
        class="icon-btn"
        title="Undo last edit (Ctrl/Cmd+Z)"
        aria-label="Undo"
        disabled={!canUndo}
        onClick={onUndo}
      >
        <span class="codicon codicon-discard" />
      </button>
      <button
        class="icon-btn"
        title="Redo (Ctrl/Cmd+Shift+Z)"
        aria-label="Redo"
        disabled={!canRedo}
        onClick={onRedo}
      >
        <span class="codicon codicon-redo" />
      </button>
    </>
  );
}

/**
 * For dialogs (call it first in the component, before the dialog moves focus): remembers the
 * element that had focus when the dialog opened and gives focus back when it closes. When a
 * re-render replaced that element (a card that moved column), the element with the same
 * `data-key` / `data-row` gets focus instead.
 */
export function useReturnFocus(): void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const key = opener?.dataset.key ?? opener?.dataset.row;
    return () => {
      requestAnimationFrame(() => {
        const target = opener?.isConnected
          ? opener
          : key
            ? document.querySelector<HTMLElement>(
                `[data-key="${CSS.escape(key)}"], [data-row="${CSS.escape(key)}"]`
              )
            : null;
        target?.focus();
      });
    };
  }, []);
}
