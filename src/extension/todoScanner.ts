// Scans the workspace for TODO / FIXME / HACK comments (patterns and globs configurable) and keeps
// the result up to date as files change.
import * as vscode from "vscode";
import {
  DEFAULT_TODO_EXCLUDE,
  DEFAULT_TODO_INCLUDE,
  DEFAULT_TODO_KEYWORDS,
  globMatch,
  scanTodos,
  type TodoItem,
} from "../core/todos";
import { type PlanService } from "./planService";
import { config, decode, openDocument, uriKey } from "./util";

export interface TodoFile {
  uri: vscode.Uri;
  /** Workspace-relative POSIX path. */
  path: string;
  items: TodoItem[];
}

export { DEFAULT_TODO_EXCLUDE, DEFAULT_TODO_INCLUDE, globMatch } from "../core/todos";

export class TodoScanner implements vscode.Disposable {
  private readonly files = new Map<string, TodoFile>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private scanning: Promise<void> | undefined;

  constructor(private readonly service: PlanService) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables.push(
      this.emitter,
      watcher,
      watcher.onDidCreate((u) => this.queue(u)),
      watcher.onDidChange((u) => this.queue(u)),
      watcher.onDidDelete((u) => {
        if (this.files.delete(uriKey(u))) this.emitter.fire();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.queue(e.document.uri);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("planner.todos")) void this.scanAll();
      })
    );
  }

  get all(): TodoFile[] {
    return [...this.files.values()]
      .filter((f) => f.items.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  get count(): number {
    return this.all.reduce((n, f) => n + f.items.length, 0);
  }

  /** Full workspace scan. */
  scanAll(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      try {
        const c = config();
        const uris = await vscode.workspace.findFiles(
          c.get<string>("todos.include", DEFAULT_TODO_INCLUDE) || DEFAULT_TODO_INCLUDE,
          c.get<string>("todos.exclude", DEFAULT_TODO_EXCLUDE) || null,
          c.get<number>("todos.maxFiles", 2000)
        );
        this.files.clear();
        await Promise.all(uris.map((u) => this.scanFile(u, false)));
      } finally {
        this.scanning = undefined;
        this.emitter.fire();
      }
    })();
    return this.scanning;
  }

  private queue(uri: vscode.Uri): void {
    if (!this.matches(uri)) return;
    const key = uriKey(uri);
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.scanFile(uri, true);
      }, 400)
    );
  }

  private matches(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file" || this.service.relPath(uri) !== undefined) return false;
    const c = config();
    const include = c.get<string>("todos.include", DEFAULT_TODO_INCLUDE) || DEFAULT_TODO_INCLUDE;
    const exclude = c.get<string>("todos.exclude", DEFAULT_TODO_EXCLUDE) || "";
    const rel = vscode.workspace.asRelativePath(uri, false);
    return globMatch(include, rel) && !(exclude && globMatch(exclude, rel));
  }

  /** Scans one file; files in the plan folder are skipped (their checkboxes are the plan). */
  async scanFile(uri: vscode.Uri, notify: boolean): Promise<void> {
    if (this.service.relPath(uri) !== undefined) return;
    const open = openDocument(uri);
    let text: string;
    try {
      text = open ? open.getText() : decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      this.files.delete(uriKey(uri));
      if (notify) this.emitter.fire();
      return;
    }
    const keywords = config().get<string[]>("todos.keywords", DEFAULT_TODO_KEYWORDS);
    const items = scanTodos(text, keywords);
    this.files.set(uriKey(uri), {
      uri,
      path: vscode.workspace.asRelativePath(uri, false),
      items,
    });
    if (notify) this.emitter.fire();
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
