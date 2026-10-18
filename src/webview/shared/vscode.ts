// Typed access to the VS Code webview API.

interface VsCodeApi<S> {
  postMessage(message: unknown): void;
  getState(): S | undefined;
  setState(state: S): void;
}

declare function acquireVsCodeApi<S>(): VsCodeApi<S>;

let api: VsCodeApi<unknown> | undefined;

function vscode<S>(): VsCodeApi<S> {
  if (!api) api = acquireVsCodeApi<unknown>();
  return api as VsCodeApi<S>;
}

export function post<M>(message: M): void {
  vscode().postMessage(message);
}

export function getState<S>(): S | undefined {
  return vscode<S>().getState();
}

export function setState<S>(state: S): void {
  vscode<S>().setState(state);
}

/** Subscribes to messages from the extension host. */
export function onMessage<M>(handler: (message: M) => void): () => void {
  const listener = (e: MessageEvent) => handler(e.data as M);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

/** Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) inside the webview → host undo/redo. */
export function bindUndoKeys(): void {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    )
      return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      post({ type: "undo" });
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      post({ type: "redo" });
    }
  });
}

export function isoDate(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}
