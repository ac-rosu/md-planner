// Owns the PlanIndex inside VS Code: finds the plan folder, keeps the index in sync with open
// editors (including unsaved changes) and the file system, and applies writer edits as undoable
// WorkspaceEdits. It also keeps the line changes of open plan documents, to find items of earlier
// parses again (lineIn, addedAfter).
// A plan file that cannot be read (no permission, an offline cloud file) is left out with a
// warning; a file that is not UTF-8 or has git merge conflict markers is not edited without asking.
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import { localToday } from "../core/dates";
import { PlanIndex } from "../core/index";
import { EditLog, followLine, lineBefore } from "../core/lineHistory";
import { type ParsedFile, type Task } from "../core/model";
import { SAVE_AS_UTF8 } from "../core/parser/files";
import { type Plan } from "../core/resolve";
import { invertEdits } from "../core/text";
import { type FileEdit } from "../core/writer";
import {
  config,
  decodeChecked,
  encode,
  exists,
  ignoresPathCase,
  isInside,
  openDocument,
  planFolderSetting,
  planFolderUri,
  toRange,
  uriKey,
  workspaceFolderOf,
} from "./util";

const REFRESH_DELAY_MS = 300;

/** The plan files of a folder, and the plan files and folders that could not be read. */
interface FolderScan {
  files: string[];
  unreadable: Array<{ path: string; error: unknown; folder: boolean }>;
}

/** True for the errors of a file that is not there (also a broken symbolic link) or is a folder. */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === "FileNotFound" ||
    code === "FileIsADirectory" ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EISDIR"
  );
}

/** Whether a plan-relative folder can hold plan files ("" is the plan folder). */
function holdsPlanFiles(rel: string): boolean {
  return rel === "" || PlanIndex.isPlanPath(`${rel}/x.md`);
}

/**
 * What a candidate plan folder holds: "plan" with a project.md (in any casing), "folder" without
 * one (or when it cannot be read: loading it then says why), undefined when there is no folder
 * there (also when it is a file).
 */
async function planFolderState(uri: vscode.Uri): Promise<"plan" | "folder" | undefined> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries.some(
      ([n, t]) => n.toLowerCase() === "project.md" && !(t & vscode.FileType.Directory)
    )
      ? "plan"
      : "folder";
  } catch {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type & vscode.FileType.Directory ? "folder" : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A key that is the same for every path of a folder: its real path, where there is one. */
async function folderKey(uri: vscode.Uri): Promise<string> {
  if (uri.scheme !== "file") return uri.toString();
  try {
    return await realpath(uri.fsPath);
  } catch {
    return uri.toString();
  }
}

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
      vscode.workspace.onDidOpenTextDocument((d) => {
        this.syncDocument(d);
        void this.dropIfGone(d);
      }),
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

  /** The plan folder of each workspace folder (`planner.planFolder`), each folder once. */
  private candidates(): vscode.Uri[] {
    const setting = planFolderSetting();
    const all = (vscode.workspace.workspaceFolders ?? []).map((wf) =>
      planFolderUri(wf.uri, setting)
    );
    return all.filter((u, i) => all.findIndex((x) => uriKey(x) === uriKey(u)) === i);
  }

  private async doLocate(): Promise<void> {
    const candidates = this.candidates();
    // The first plan folder with a project.md; else the first plan folder there is.
    let found: vscode.Uri | undefined;
    for (const candidate of candidates) {
      const state = await planFolderState(candidate);
      if (state === "plan") {
        found = candidate;
        break;
      }
      if (state === "folder") found ??= candidate;
    }
    const changed = found?.toString() !== this._root?.toString();
    this._root = found;
    for (const d of this.rootWatchers) d.dispose();
    this.rootWatchers = [];
    this.index.clear();
    if (found) {
      this.watch(found);
      await this.loadAll();
      this.log.info(`Plan folder: ${found.fsPath} (${this.index.paths.length} files)`);
    } else {
      this.watchForCreation(candidates);
    }
    await this.updateHasPlan();
    if (changed) this.rootEmitter.fire(found);
    this.fireNow();
  }

  /**
   * Whether the plan folder has a project.md (in any casing; also one that cannot be read): a
   * plan, not just a folder.
   */
  get hasPlan(): boolean {
    return !!this._root && this.index.pathsUnder("").some((p) => p.toLowerCase() === "project.md");
  }

  private hasPlanContext: boolean | undefined;

  /**
   * The `planner.hasPlan` context: true with a project.md. An empty plan folder (or one whose
   * project.md is gone) keeps New project and the welcome text in the Milestones view.
   */
  private async updateHasPlan(): Promise<void> {
    const has = this.hasPlan;
    if (has === this.hasPlanContext) return;
    this.hasPlanContext = has;
    await vscode.commands.executeCommand("setContext", "planner.hasPlan", has);
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

  /**
   * "Saved X" when the changed files are saved, else "Changed X (not saved yet)": with
   * `planner.autoSave` off, or when VS Code did not save one (it changed on disk meanwhile), the
   * change is only in the editor, and "Saved" would say otherwise.
   */
  savedMessage(what: string, paths: string[]): string {
    const unsaved = paths.some((p) => openDocument(this.uri(p))?.isDirty);
    return unsaved ? `Changed ${what} (not saved yet)` : `Saved ${what}`;
  }

  /**
   * Why a quick fix or an id added on save should leave a file alone, without asking (they edit as
   * you type): it is not UTF-8, or it has git merge conflict markers. Undefined when it may change.
   */
  untouchable(path: string): string | undefined {
    if (this.index.notUtf8(path)) return "not UTF-8";
    if (this.index.conflictLines(path).length > 0) return "git merge conflict markers";
    return undefined;
  }

  /** Applies writer edits as one WorkspaceEdit (undoable). Returns false if VS Code refused it. */
  async apply(edits: FileEdit[], options: ApplyOptions = {}): Promise<boolean> {
    const deleted = options.deleteFiles ?? [];
    const nonEmpty = edits.filter((e) => e.edits.length > 0 && !deleted.includes(e.path));
    if (nonEmpty.length === 0 && deleted.length === 0) return true;
    if (
      !(await this.mayChange(
        nonEmpty.map((e) => e.path),
        deleted
      ))
    )
      return false;
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
   * Whether files may be changed: never a file that is not UTF-8 (writing it would replace its
   * accented letters; so would bringing a deleted one back with Undo), and a file with git merge
   * conflict markers only when the user says so (the change could land inside the conflict).
   * Also asked by the edits that do not come through `apply` (F2 rename, TODO promotion).
   */
  async mayChange(edited: string[], deleted: string[] = []): Promise<boolean> {
    // Known from the last read of the file (the watcher reads it again when it is saved).
    for (const path of [...edited, ...deleted]) {
      if (!this.index.notUtf8(path)) continue;
      void vscode.window.showErrorMessage(
        `Planner: ${path} is not UTF-8, so the planner does not change it (accented letters would be lost). ${SAVE_AS_UTF8}`
      );
      return false;
    }
    const conflicted = [...edited, ...deleted].filter(
      (p) => this.index.conflictLines(p).length > 0
    );
    if (conflicted.length === 0) return true;
    let what: string;
    if (conflicted.length === 1) {
      const lines = this.index.conflictLines(conflicted[0]).map((l) => l + 1);
      const where = `line${lines.length > 1 ? "s" : ""} ${lines.slice(0, 6).join(", ")}${lines.length > 6 ? " …" : ""}`;
      what = `${conflicted[0]} has git merge conflict markers (${where})`;
    } else {
      what = `${conflicted.join(", ")} have git merge conflict markers`;
    }
    const anyway = "Change Anyway";
    const answer = await vscode.window.showWarningMessage(
      `${what}. Resolve the conflict first: the change could land inside it.`,
      { modal: true },
      anyway
    );
    return answer === anyway;
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
  async createFiles(requested: Array<{ path: string; text: string }>): Promise<boolean> {
    if (requested.length === 0) return true;
    // Into the folders as they are spelled on disk: `Milestones/` when that is the folder.
    const files = requested.map((f) => ({ ...f, path: this.index.canonicalPath(f.path) }));
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

  /**
   * Saves the open documents of plan files. Returns false (after telling the user) when VS Code
   * did not save one: it changed on disk since it was read ("File Modified Since"), or could not
   * be written. The change then stays in the editor, unsaved.
   */
  async save(paths: string[]): Promise<boolean> {
    const failed: string[] = [];
    for (const path of paths) {
      const doc = openDocument(this.uri(path));
      if (doc?.isDirty && !(await doc.save())) failed.push(path);
    }
    if (failed.length === 0) return true;
    this.log.warn(`Not saved: ${failed.join(", ")}`);
    void vscode.window.showWarningMessage(
      `Planner: ${failed.join(", ")} not saved: the file changed on disk or could not be written. The change is in the editor, unsaved: compare it with the file on disk and save it, or revert it.`
    );
    return false;
  }

  /** Re-fires the change event after the debounce delay. */
  scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fireNow(), REFRESH_DELAY_MS);
  }

  fireNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.updateHasPlan();
    this.changeEmitter.fire();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of [...this.disposables, ...this.rootWatchers]) d.dispose();
  }

  /** Parses an open document's text; `utf8` says whether its file on disk is UTF-8, when known. */
  private syncDocument(document: vscode.TextDocument, utf8?: boolean): void {
    const rel = this.relPath(document.uri);
    if (rel === undefined || !PlanIndex.isPlanPath(rel)) return;
    if (this.index.update(rel, document.getText(), { utf8 })) this.scheduleRefresh();
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

  /**
   * Reads a plan file again after it changed on disk (or its editor was closed). An open document
   * keeps its text; the file on disk then only tells whether it is UTF-8.
   */
  private async reloadFromDisk(uri: vscode.Uri): Promise<void> {
    const rel = this.relPath(uri);
    if (rel === undefined || !PlanIndex.isPlanPath(rel)) return;
    // Unsaved changes at once; any other open document once its file is known to be there.
    const open = openDocument(uri);
    if (open && !open.isClosed && open.isDirty) this.syncDocument(open);
    if (await this.loadFile(rel, uri)) this.scheduleRefresh();
  }

  /**
   * An open document whose file is not on disk (and that has no unsaved changes) is not part of
   * the plan: VS Code keeps a hidden copy of a renamed file open for a while, and with it the plan
   * would have the file twice when it is renamed back.
   */
  private async dropIfGone(document: vscode.TextDocument): Promise<void> {
    const rel = this.relPath(document.uri);
    if (rel === undefined || !PlanIndex.isPlanPath(rel) || document.isDirty) return;
    if (await exists(document.uri)) return;
    if (document.isDirty || openDocument(document.uri) !== document) return;
    if (this.index.remove(rel)) this.scheduleRefresh();
  }

  /**
   * Reads one plan file into the index: the open document's text if there is one, else the file on
   * disk. A file that is gone is removed; one that cannot be read is left out with a warning.
   * Returns true when the index changed.
   */
  private async loadFile(rel: string, uri = this.uri(rel)): Promise<boolean> {
    let disk: { text: string; utf8: boolean } | undefined;
    let error: unknown;
    try {
      disk = decodeChecked(await vscode.workspace.fs.readFile(uri));
    } catch (err) {
      error = err;
    }
    const open = openDocument(uri);
    // A document whose file is gone counts only with unsaved changes (see dropIfGone).
    const gone = !disk && isNotFound(error);
    if (open && !open.isClosed && !(gone && !open.isDirty)) {
      const changed = this.index.update(rel, open.getText(), { utf8: disk?.utf8 });
      this.parsedFrom(rel, open);
      return changed;
    }
    if (!disk)
      return isNotFound(error) ? this.index.remove(rel) : this.index.markUnreadable(rel, error);
    const changed = this.index.update(rel, disk.text, { utf8: disk.utf8 });
    this.readFromDisk(rel);
    return changed;
  }

  private async loadAll(): Promise<void> {
    if (!this._root) return;
    const { files, unreadable } = await this.listMarkdown(this._root, "");
    for (const u of unreadable) this.index.markUnreadable(u.path, u.error, u.folder);
    await Promise.all(files.map((rel) => this.loadFile(rel)));
  }

  /** Notes when a parse of a file that is not open was read (see addedAfter). */
  private readFromDisk(rel: string): void {
    const file = this.index.get(rel);
    if (file && !this.readAt.has(file)) this.readAt.set(file, ++this.clock);
  }

  /**
   * The plan files below a folder (`rel` is its plan-relative path, "" the plan folder). A folder
   * that cannot be read is reported, not thrown; a folder seen before (a symbolic link back into
   * the plan) is not read again.
   */
  private async listMarkdown(
    dir: vscode.Uri,
    rel: string,
    out: FolderScan = { files: [], unreadable: [] },
    seen = new Set<string>()
  ): Promise<FolderScan> {
    let entries: Array<[string, vscode.FileType]>;
    try {
      const key = await folderKey(dir);
      if (seen.has(key)) return out;
      seen.add(key);
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch (error) {
      if (holdsPlanFiles(rel)) out.unreadable.push({ path: rel, error, folder: true });
      return out;
    }
    for (const [name, type] of entries) {
      if (name.startsWith(".")) continue;
      const path = rel ? `${rel}/${name}` : name;
      if (type & vscode.FileType.Directory) {
        if (path === "reports" || path === "baselines") continue;
        await this.listMarkdown(vscode.Uri.joinPath(dir, name), path, out, seen);
      } else if (PlanIndex.isPlanPath(path)) {
        out.files.push(path);
      }
    }
    return out;
  }

  /**
   * A file or folder created in the plan folder. A folder (moved or copied in, or renamed) may come
   * as this one event, without events for its files: they are read now.
   */
  private async created(uri: vscode.Uri): Promise<void> {
    const rel = this.relPath(uri);
    if (rel === undefined) return;
    if (PlanIndex.isPlanPath(rel)) return this.reloadFromDisk(uri);
    if (!holdsPlanFiles(rel)) return;
    try {
      if (!((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory)) return;
    } catch {
      return;
    }
    const { files, unreadable } = await this.listMarkdown(uri, rel);
    let changed = false;
    for (const u of unreadable)
      changed = this.index.markUnreadable(u.path, u.error, u.folder) || changed;
    for (const path of files) changed = (await this.loadFile(path)) || changed;
    if (changed) this.scheduleRefresh();
  }

  /**
   * A file or folder deleted (or moved away) from the plan folder: a folder comes as one event, so
   * every file below it is dropped. A file that is open with unsaved changes stays as the editor
   * shows it (git may delete a file you are editing) until it is saved again or closed.
   */
  private deleted(uri: vscode.Uri): void {
    const rel = this.relPath(uri);
    if (rel === undefined) return;
    let changed = false;
    for (const path of this.index.pathsUnder(rel, ignoresPathCase(uri))) {
      const open = openDocument(this.uri(path));
      if (open && !open.isClosed && open.isDirty) this.syncDocument(open);
      else changed = this.index.remove(path) || changed;
    }
    if (changed) this.scheduleRefresh();
  }

  private watch(root: vscode.Uri): void {
    // Every path, not only `*.md`: a folder deleted, renamed or moved in comes as one event.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "**")
    );
    this.rootWatchers.push(
      watcher,
      watcher.onDidCreate((uri) => void this.created(uri)),
      watcher.onDidChange((uri) => void this.reloadFromDisk(uri)),
      watcher.onDidDelete((uri) => this.deleted(uri))
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

  /**
   * Watches for a plan folder to be created (or anything in it): below its workspace folder by its
   * path from there, else (an absolute or `../` plan folder) in the folder above it.
   */
  private watchForCreation(candidates: vscode.Uri[]): void {
    for (const candidate of candidates) {
      const wf = workspaceFolderOf(candidate);
      const inWorkspace =
        wf && candidate.path.length > wf.uri.path.length && isInside(candidate, wf.uri);
      const base = inWorkspace ? wf.uri : vscode.Uri.joinPath(candidate, "..");
      const rel = inWorkspace
        ? candidate.path.slice(wf.uri.path.replace(/\/+$/, "").length + 1)
        : (candidate.path.split("/").pop() ?? "plan");
      for (const pattern of [rel, `${rel}/**`]) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(base, pattern)
        );
        this.rootWatchers.push(
          watcher,
          watcher.onDidCreate(() => void this.locate())
        );
      }
    }
  }
}
