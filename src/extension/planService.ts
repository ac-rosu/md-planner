// Owns the PlanIndex inside VS Code: finds the plan folder, keeps the index in sync with open
// editors (including unsaved changes) and the file system, and applies writer edits as undoable
// WorkspaceEdits. It also keeps the line changes of open plan documents, to find items of earlier
// parses again (lineIn, addedAfter).
import * as vscode from "vscode";
import { localToday } from "../core/dates";
import { PlanIndex } from "../core/index";
import { EditLog, followLine, lineBefore } from "../core/lineHistory";
import { type ParsedFile, type Task } from "../core/model";
import { type Plan } from "../core/resolve";
import { invertEdits } from "../core/text";
import { type FileEdit } from "../core/writer";
import { config, decode, encode, exists, ignoresPathCase, openDocument, toRange } from "./util";

const REFRESH_DELAY_MS = 300;

export interface ApplyOptions {
  /** Save the touched documents afterwards (defaults to `planner.autoSave` for view edits). */
  save?: boolean;
  /** Where the edit comes from; only "view" edits are auto-saved. */
  source?: "view" | "editor";
  /** Plan files deleted in the same WorkspaceEdit, after the text edits. */
  deleteFiles?: string[];
}

/** Where a parse of an open document comes from: its log, and the version it was last the text of. */
interface Origin {
  log: EditLog;
  version: number;
  /** When it was last the document's text, on the clock of the logs. */
  time: number;
}

/** The service each plan comes from (see serviceOf). */
const services = new WeakMap<Plan, PlanService>();

/** The PlanService a plan comes from: it knows how the lines of its files moved since. */
export function serviceOf(plan: Plan): PlanService | undefined {
  return services.get(plan);
}

export class PlanService implements vscode.Disposable {
  readonly index = new PlanIndex();
  private _root: vscode.Uri | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires (debounced) after the plan changed. */
  readonly onDidChange = this.changeEmitter.event;
  private readonly rootEmitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeRoot = this.rootEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private rootWatchers: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private todayOverride: string | undefined;
  private locating: Promise<void> | undefined;
  private relocateAgain = false;
  /** The line changes of each open plan document; a document opened again starts a new log. */
  private readonly logs = new WeakMap<vscode.TextDocument, EditLog>();
  /** Where each parse of an open document comes from: the file and each of its items. */
  private readonly origins = new WeakMap<ParsedFile | Task, Origin>();
  /** When a parse of a file that is not open was read from disk, on the same clock. */
  private readonly readAt = new WeakMap<ParsedFile, number>();
  /** Orders the changes and parses of all documents (see EditLog). */
  private clock = 0;

  constructor(readonly log: vscode.LogOutputChannel) {
    this.disposables.push(
      this.changeEmitter,
      this.rootEmitter,
      vscode.workspace.onDidChangeTextDocument((e) => {
        this.logs.get(e.document)?.record(e.document.version, ++this.clock, e.contentChanges);
        if (e.contentChanges.length > 0) this.syncDocument(e.document);
      }),
      vscode.workspace.onDidOpenTextDocument((d) => this.syncDocument(d)),
      vscode.workspace.onDidCloseTextDocument((d) => void this.reloadFromDisk(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("planner.planFolder")) void this.locate();
        else if (e.affectsConfiguration("planner")) this.scheduleRefresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.locate())
    );
  }

  get root(): vscode.Uri | undefined {
    return this._root;
  }

  get plan(): Plan {
    const plan = this.index.plan;
    services.set(plan, this);
    return plan;
  }

  /** Today as an ISO date. Tests can pin it with setToday(). */
  today(): string {
    return this.todayOverride ?? localToday();
  }

  setToday(date: string | undefined): void {
    this.todayOverride = date;
    this.scheduleRefresh();
  }

  /** Finds the plan folder in the workspace and (re)loads it. Concurrent calls are coalesced. */
  locate(): Promise<void> {
    if (this.locating) {
      this.relocateAgain = true;
      return this.locating;
    }
    this.locating = (async () => {
      try {
        do {
          this.relocateAgain = false;
          await this.doLocate();
        } while (this.relocateAgain);
      } finally {
        this.locating = undefined;
      }
    })();
    return this.locating;
  }

  private async doLocate(): Promise<void> {
    const folderSetting = config().get<string>("planFolder", "plan") || "plan";
    let found: vscode.Uri | undefined;
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const candidate =
        folderSetting.startsWith("/") || /^[A-Za-z]:[\\/]/.test(folderSetting)
          ? vscode.Uri.file(folderSetting)
          : vscode.Uri.joinPath(wf.uri, ...folderSetting.split(/[\\/]/));
      if (await exists(candidate)) {
        found = candidate;
        break;
      }
    }
    const changed = found?.toString() !== this._root?.toString();
    this._root = found;
    for (const d of this.rootWatchers) d.dispose();
    this.rootWatchers = [];
    this.index.clear();
    await vscode.commands.executeCommand("setContext", "planner.hasPlan", !!found);
    if (found) {
      this.watch(found);
      await this.loadAll();
      this.log.info(`Plan folder: ${found.fsPath} (${this.index.paths.length} files)`);
    } else {
      this.watchForCreation(folderSetting);
    }
    if (changed) this.rootEmitter.fire(found);
    this.fireNow();
  }

  /**
   * Plan-relative POSIX path of a URI inside the plan folder. Where paths are case-insensitive
   * (Windows, macOS) any casing matches, and a file already in the index keeps its indexed path.
   */
  relPath(uri: vscode.Uri): string | undefined {
    if (!this._root || uri.scheme !== this._root.scheme) return undefined;
    const root = this._root.path.endsWith("/") ? this._root.path : this._root.path + "/";
    const prefix = uri.path.slice(0, root.length);
    if (!ignoresPathCase(uri)) return prefix === root ? uri.path.slice(root.length) : undefined;
    if (prefix.toLowerCase() !== root.toLowerCase()) return undefined;
    const rel = uri.path.slice(root.length);
    if (this.index.has(rel)) return rel;
    const lower = rel.toLowerCase();
    return this.index.paths.find((p) => p.toLowerCase() === lower) ?? rel;
  }

  uri(relPath: string): vscode.Uri {
    if (!this._root) throw new Error("No plan folder");
    return vscode.Uri.joinPath(this._root, ...relPath.split("/"));
  }

  /** The parsed plan file behind a document, if it is one. */
  fileFor(document: vscode.TextDocument | vscode.Uri): ParsedFile | undefined {
    const uri = "uri" in document ? document.uri : document;
    const rel = this.relPath(uri);
    return rel === undefined ? undefined : this.index.get(rel);
  }

  /**
   * Where an item of an earlier parse of an open document is in a later parse of its file: its
   * line followed through the changes since (see followLine), or null when its line was deleted or
   * replaced. Undefined when that is not known: the file changed on disk while it was closed, the
   * document was opened again, too many changes since, or a copy of its line went in next to it.
   */
  lineIn(file: ParsedFile, t: Task): number | null | undefined {
    const then = this.origins.get(t);
    const now = this.origins.get(file);
    if (!then || !now || then.log !== now.log || then.version > now.version) return undefined;
    const changes = now.log.changes(then.time, now.version);
    return changes && followLine(t.line, t.title, changes);
  }

  /**
   * Whether a line of a parse of an open document was added after an item (of that file or another)
   * was parsed: then it may hold that item, moved there. Undefined when that is not known.
   */
  addedAfter(file: ParsedFile, line: number, t: Task): boolean | undefined {
    const then = this.origins.get(t);
    const now = this.origins.get(file);
    if (then && !now) {
      // Read from disk: when not read again since the item was parsed, the line was there before.
      const read = this.readAt.get(file);
      return read !== undefined && read < then.time ? false : undefined;
    }
    const changes = then && now?.log.changes(then.time, now.version);
    return changes && lineBefore(line, changes) === undefined;
  }

  isPlanDocument(document: vscode.TextDocument): boolean {
    const rel = this.relPath(document.uri);
    return rel !== undefined && PlanIndex.isPlanPath(rel);
  }

  /** Applies writer edits as one WorkspaceEdit (undoable). Returns false if VS Code refused it. */
  async apply(edits: FileEdit[], options: ApplyOptions = {}): Promise<boolean> {
    const deleted = options.deleteFiles ?? [];
    const nonEmpty = edits.filter((e) => e.edits.length > 0 && !deleted.includes(e.path));
    if (nonEmpty.length === 0 && deleted.length === 0) return true;
    const we = new vscode.WorkspaceEdit();
    for (const fe of nonEmpty) {
      const uri = this.uri(fe.path);
      for (const e of fe.edits) we.replace(uri, toRange(e.range), e.newText);
    }
    for (const path of deleted) we.deleteFile(this.uri(path), { ignoreIfNotExists: true });
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) {
      this.log.warn("WorkspaceEdit was rejected");
      return false;
    }
    for (const path of deleted) this.index.remove(path);
    // Keep the index exactly in sync even before change events arrive.
    for (const fe of nonEmpty) {
      const doc = openDocument(this.uri(fe.path));
      if (doc) this.syncDocument(doc);
    }
    const save =
      options.save ??
      ((options.source ?? "view") === "view" && config().get<boolean>("autoSave", true));
    if (save) await this.save(nonEmpty.map((e) => e.path));
    return true;
  }

  /**
   * Applies edits and file deletions like `apply`, and returns a function that reverts exactly
   * them: deleted files are created again with their text and the inverse edits are applied. The
   * revert is refused (with a message) when a touched file changed in between. VS Code's own undo
   * cannot reliably bring back a file deleted by an extension, so deletions offer this instead.
   */
  async applyRevertible(
    edits: FileEdit[],
    options: ApplyOptions = {}
  ): Promise<(() => Promise<boolean>) | undefined> {
    const deleted = (options.deleteFiles ?? []).map((path) => ({
      path,
      text: this.index.get(path)?.lines.serialize() ?? "",
    }));
    const changed = edits
      .filter((e) => e.edits.length > 0 && !options.deleteFiles?.includes(e.path))
      .map((fe) => {
        const before = this.index.get(fe.path)?.lines.text ?? "";
        const { text, inverse } = invertEdits(before, fe.edits);
        return { path: fe.path, after: text, inverse };
      });
    if (!(await this.apply(edits, options))) return undefined;
    return async () => {
      const moved = changed.find((c) => this.index.get(c.path)?.lines.text !== c.after);
      const back = deleted.find((d) => this.index.has(d.path));
      if (moved || back) {
        void vscode.window.showErrorMessage(
          `Planner: cannot undo, ${(moved ?? back)!.path} changed since. Use Undo in the editor or git instead.`
        );
        return false;
      }
      if (!(await this.createFiles(deleted))) return false;
      return this.apply(
        changed.map((c) => ({ path: c.path, edits: c.inverse })),
        { source: options.source }
      );
    };
  }

  /**
   * Creates plan files in one undoable WorkspaceEdit (refusing to overwrite) and adds them to the
   * index at once, so views and commands see them without waiting for the file watcher.
   */
  async createFiles(files: Array<{ path: string; text: string }>): Promise<boolean> {
    if (files.length === 0) return true;
    const we = new vscode.WorkspaceEdit();
    for (const f of files) we.createFile(this.uri(f.path), { contents: encode(f.text) });
    if (!(await vscode.workspace.applyEdit(we))) {
      this.log.warn(`Could not create ${files.map((f) => f.path).join(", ")}`);
      return false;
    }
    for (const f of files) {
      this.index.update(f.path, f.text);
      this.readFromDisk(f.path);
    }
    this.fireNow();
    return true;
  }

  async save(paths: string[]): Promise<void> {
    for (const path of paths) {
      const doc = openDocument(this.uri(path));
      if (doc?.isDirty) await doc.save();
    }
  }

  /** Re-fires the change event after the debounce delay. */
  scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fireNow(), REFRESH_DELAY_MS);
  }

  fireNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.changeEmitter.fire();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of [...this.disposables, ...this.rootWatchers]) d.dispose();
  }

  private syncDocument(document: vscode.TextDocument): void {
    const rel = this.relPath(document.uri);
    if (rel === undefined || !PlanIndex.isPlanPath(rel)) return;
    if (this.index.update(rel, document.getText())) this.scheduleRefresh();
    this.parsedFrom(rel, document);
  }

  /** Notes that the file's parse is the document's text now (see lineIn). */
  private parsedFrom(rel: string, document: vscode.TextDocument): void {
    const file = this.index.get(rel);
    if (!file) return;
    let log = this.logs.get(document);
    if (!log) this.logs.set(document, (log = new EditLog(document.version, ++this.clock)));
    const origin = this.origins.get(file);
    if (origin?.log === log) {
      // The parse was kept (the same text): it is the text of this version too.
      origin.version = document.version;
      origin.time = ++this.clock;
      return;
    }
    const parsed: Origin = { log, version: document.version, time: ++this.clock };
    for (const x of [file, ...file.items]) this.origins.set(x, parsed);
  }

  private async reloadFromDisk(uri: vscode.Uri): Promise<void> {
    const rel = this.relPath(uri);
    if (rel === undefined || !PlanIndex.isPlanPath(rel)) return;
    const open = openDocument(uri);
    if (open && !open.isClosed) {
      this.syncDocument(open);
      return;
    }
    try {
      const text = decode(await vscode.workspace.fs.readFile(uri));
      if (this.index.update(rel, text)) this.scheduleRefresh();
      this.readFromDisk(rel);
    } catch {
      if (this.index.remove(rel)) this.scheduleRefresh();
    }
  }

  private async loadAll(): Promise<void> {
    if (!this._root) return;
    const files = await this.listMarkdown(this._root, "");
    await Promise.all(
      files.map(async (rel) => {
        const uri = this.uri(rel);
        const open = openDocument(uri);
        const text = open ? open.getText() : decode(await vscode.workspace.fs.readFile(uri));
        this.index.update(rel, text);
        if (open) this.parsedFrom(rel, open);
        else this.readFromDisk(rel);
      })
    );
  }

  /** Notes when a parse of a file that is not open was read (see addedAfter). */
  private readFromDisk(rel: string): void {
    const file = this.index.get(rel);
    if (file && !this.readAt.has(file)) this.readAt.set(file, ++this.clock);
  }

  private async listMarkdown(dir: vscode.Uri, prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
      if (name.startsWith(".")) continue;
      const rel = prefix + name;
      if (type & vscode.FileType.Directory) {
        if (rel === "reports" || rel === "baselines") continue;
        out.push(...(await this.listMarkdown(vscode.Uri.joinPath(dir, name), rel + "/")));
      } else if (PlanIndex.isPlanPath(rel)) {
        out.push(rel);
      }
    }
    return out;
  }

  private watch(root: vscode.Uri): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "**/*.md")
    );
    const onDisk = (uri: vscode.Uri) => void this.reloadFromDisk(uri);
    this.rootWatchers.push(
      watcher,
      watcher.onDidCreate(onDisk),
      watcher.onDidChange(onDisk),
      watcher.onDidDelete((uri) => {
        const rel = this.relPath(uri);
        if (rel !== undefined && this.index.remove(rel)) this.scheduleRefresh();
      })
    );
    // The plan folder itself may be deleted or renamed.
    const parent = vscode.Uri.joinPath(root, "..");
    const name = root.path.split("/").pop() ?? "plan";
    const folderWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parent, name)
    );
    this.rootWatchers.push(
      folderWatcher,
      folderWatcher.onDidDelete(() => void this.locate())
    );
  }

  private watchForCreation(folderSetting: string): void {
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(wf, `${folderSetting.replace(/\\/g, "/")}/**`)
      );
      this.rootWatchers.push(
        watcher,
        watcher.onDidCreate(() => void this.locate())
      );
    }
  }
}
