// Base class for the planner webview panels: strict CSP with a per-load nonce, typed messages,
// one bundle per webview (dist/webview/<name>.js|.css).
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { type EditHistory } from "../editHistory";
import { type PlannerState } from "../state";

export interface PanelContext {
  extensionUri: vscode.Uri;
  state: PlannerState;
  history: EditHistory;
  memento: vscode.Memento;
}

export abstract class WebviewPanelHost<HostMessage, WebviewMessage extends { type: string }>
  implements vscode.Disposable
{
  readonly panel: vscode.WebviewPanel;
  protected readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  /** Messages are queued until the webview reports "ready". */
  private ready = false;
  private queue: HostMessage[] = [];
  /** The webview message being handled; the next one waits for it (`receive` never rejects). */
  private handling: Promise<void> = Promise.resolve();

  protected constructor(
    protected readonly ctx: PanelContext,
    viewType: string,
    title: string,
    private readonly bundle: string,
    column: vscode.ViewColumn = vscode.ViewColumn.Active
  ) {
    const distUri = vscode.Uri.joinPath(ctx.extensionUri, "dist", "webview");
    this.panel = vscode.window.createWebviewPanel(viewType, title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [distUri],
    });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "planner.svg");
    this.panel.webview.html = this.html(title);
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      // One message at a time: two quick gestures (a drag right after another) must each work out
      // their edit on the text the one before left, not both on the same old text.
      this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => {
        this.handling = this.handling.then(() => this.receive(m));
      }),
      ctx.history.onDidChange(() => this.postHistory())
    );
  }

  /** Sends a message (queued until the webview has loaded). */
  post(message: HostMessage): void {
    if (this.disposed) return;
    if (!this.ready) {
      this.queue.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  /** Test hook and message entry point: handles one webview message. */
  async receive(message: WebviewMessage): Promise<void> {
    try {
      if (message.type === "ready") {
        this.ready = true;
        const queued = this.queue;
        this.queue = [];
        for (const m of queued) void this.panel.webview.postMessage(m);
        this.postHistory();
      }
      if (message.type === "undo" || message.type === "redo") {
        const label =
          message.type === "undo" ? await this.ctx.history.undo() : await this.ctx.history.redo();
        if (label) this.notice("info", `${message.type === "undo" ? "Undid" : "Redid"}: ${label}`);
        return;
      }
      await this.onMessage(message);
    } catch (err) {
      this.notice("error", err instanceof Error ? err.message : String(err));
    }
  }

  protected abstract onMessage(message: WebviewMessage): Promise<void> | void;

  /**
   * Reports an edit made from the view, with an Undo button, so an accidental drag is noticed.
   * Only after an edit was written: the button undoes the last entry of the history all panels
   * share, which after a gesture that changed nothing is someone else's edit (say so with notice).
   */
  protected changed(message: string): void {
    this.post({ type: "notice", level: "info", message, undo: true } as HostMessage);
  }

  protected notice(level: "info" | "error", message: string): void {
    this.post({ type: "notice", level, message } as HostMessage);
    if (level === "error") this.ctx.state.service.log.warn(message);
  }

  private postHistory(): void {
    this.post({
      type: "history",
      canUndo: this.ctx.history.canUndo,
      canRedo: this.ctx.history.canRedo,
    } as HostMessage);
  }

  /** Column for revealing editors next to this panel. */
  protected editorColumn(): vscode.ViewColumn {
    return this.panel.viewColumn === vscode.ViewColumn.One
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;
  }

  private html(title: string): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const base = vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, `${this.bundle}.js`));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, `${this.bundle}.css`));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
