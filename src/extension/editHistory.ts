// Undo/redo for edits made from webviews. Each view edit is applied as a normal WorkspaceEdit (so
// Ctrl+Z in the text editor works as usual); this history additionally lets the webviews undo
// their own last edits by applying the exact inverse edits, after checking that the files were
// not changed in between.
import * as vscode from "vscode";
import { invertEdits, type TextEdit, TextLines } from "../core/text";
import { type FileEdit } from "../core/writer";
import { type PlanService } from "./planService";
import { openDocument } from "./util";

/** One file of an entry: its text before and after the edit, as they were once it was done. */
interface FileStep {
  path: string;
  before: string;
  after: string;
  /**
   * The edits from `before` to `after` (redo) and back (undo). Undefined when saving changed the
   * file as well (ids added to tasks without one, a formatter): then the texts are compared.
   */
  forward?: TextEdit[];
  inverse?: TextEdit[];
}

interface Entry {
  /** Identifies the entry for an Undo button on the notice that reports the edit. */
  id: number;
  label: string;
  files: FileStep[];
}

const LIMIT = 100;

export class EditHistory implements vscode.Disposable {
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  private nextId = 1;
  readonly onDidChange = this.emitter.event;

  constructor(private readonly service: PlanService) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Applies view edits through a WorkspaceEdit and records them. False when they were refused. */
  async apply(edits: FileEdit[], label: string): Promise<boolean> {
    return (await this.record(edits, label)).applied;
  }

  /**
   * Like `apply`, with the id of the entry recorded for the edits (none when there was nothing to
   * change), for an Undo button that undoes this edit and no other (see `undo`).
   */
  async record(edits: FileEdit[], label: string): Promise<{ applied: boolean; id?: number }> {
    const nonEmpty = edits.filter((e) => e.edits.length > 0);
    if (nonEmpty.length === 0) return { applied: true };
    const files: FileStep[] = nonEmpty.map((fe) => {
      const before = this.currentText(fe.path);
      if (before === undefined) throw new Error(`Not a loaded plan file: ${fe.path}`);
      const { text, inverse } = invertEdits(before, fe.edits);
      return { path: fe.path, before, after: text, forward: fe.edits, inverse };
    });
    if (!(await this.service.apply(nonEmpty, { source: "view" }))) return { applied: false };
    // The text once saved: a save adds ids to tasks without one, and the history has to match it.
    for (const f of files) this.settle(f, "after");
    const entry: Entry = { id: this.nextId++, label, files };
    this.undoStack.push(entry);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emitter.fire();
    return { applied: true, id: entry.id };
  }

  /**
   * Undoes the last edit; with `id`, only when that is still the last edit (an Undo button on the
   * notice of an edit must not undo another panel's later one). Returns its label, undefined when
   * there is nothing to undo; throws with the reason when it is not undone.
   */
  async undo(id?: number): Promise<string | undefined> {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (id !== undefined && entry?.id !== id) throw new Error(this.notLast(id, entry));
    if (!entry) return undefined;
    this.assertUnchanged(entry, "after");
    const index = this.undoStack.length - 1;
    this.undoStack.pop();
    const edits = entry.files.map((f) => ({
      path: f.path,
      edits: f.inverse ?? diffEdits(f.after, f.before),
    }));
    if (!(await this.service.apply(edits, { source: "view" }))) {
      this.restore(this.undoStack, index, entry);
      throw new Error(`"${entry.label}" was not undone: the files were not changed.`);
    }
    for (const f of entry.files) this.settle(f, "before");
    this.redoStack.push(entry);
    this.emitter.fire();
    return entry.label;
  }

  async redo(): Promise<string | undefined> {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) return undefined;
    this.assertUnchanged(entry, "before");
    const index = this.redoStack.length - 1;
    this.redoStack.pop();
    const edits = entry.files.map((f) => ({
      path: f.path,
      edits: f.forward ?? diffEdits(f.before, f.after),
    }));
    if (!(await this.service.apply(edits, { source: "view" }))) {
      this.restore(this.redoStack, index, entry);
      throw new Error(`"${entry.label}" was not redone: the files were not changed.`);
    }
    for (const f of entry.files) this.settle(f, "after");
    this.undoStack.push(entry);
    this.emitter.fire();
    return entry.label;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /**
   * The text of a plan file as VS Code has it now (BOM-less, from its document when open: that is
   * what the edits apply to); undefined when it is no longer a plan file (renamed or deleted).
   */
  private currentText(path: string): string | undefined {
    const file = this.service.index.get(path);
    if (!file) return undefined;
    const doc = openDocument(this.service.uri(path));
    return doc && !doc.isClosed ? doc.getText() : file.lines.text;
  }

  /**
   * After applying (and saving) one side of an entry: when the file is not exactly as that side's
   * text (the save added ids), the file is what undo and redo compare with from now on, and the
   * stored edits from the other side no longer fit it.
   */
  private settle(f: FileStep, side: "before" | "after"): void {
    const now = this.currentText(f.path);
    if (now === undefined || now === f[side]) return;
    f[side] = now;
    if (side === "after") f.inverse = undefined;
    else f.forward = undefined;
  }

  /** An entry that could not be undone or redone goes back where it was. */
  private restore(stack: Entry[], index: number, entry: Entry): void {
    if (this.undoStack.includes(entry) || this.redoStack.includes(entry)) return;
    stack.splice(Math.min(index, stack.length), 0, entry);
  }

  private notLast(id: number, last: Entry | undefined): string {
    const undone = this.redoStack.find((e) => e.id === id);
    if (undone) return `"${undone.label}" is undone already.`;
    const older = this.undoStack.find((e) => e.id === id);
    if (older && last)
      return `"${older.label}" was not undone: "${last.label}" came after it. Undo in the toolbar undoes the last edit first.`;
    return "That edit can no longer be undone here. Use Undo in the editor instead.";
  }

  /** Throws (and clears the history) when a file is not as the entry left it, or is gone. */
  private assertUnchanged(entry: Entry, side: "before" | "after"): void {
    for (const f of entry.files) {
      const now = this.currentText(f.path);
      if (now === f[side]) continue;
      // Something else edited, renamed or deleted the file: the stored edits no longer apply.
      this.undoStack.length = 0;
      this.redoStack.length = 0;
      this.emitter.fire();
      throw new Error(
        `"${entry.label}" cannot be ${side === "after" ? "undone" : "redone"} here: ${f.path} ${now === undefined ? "was renamed or deleted" : "changed"} since. Use Undo in the editor instead.`
      );
    }
  }
}

/**
 * Edits that turn `from` into `to`, touching only what differs: lines that differ in place each
 * get the characters between their common start and end; when lines were added or removed, the
 * span between the first and the last difference is replaced. Never splits a surrogate pair or a
 * CRLF line break.
 */
export function diffEdits(from: string, to: string): TextEdit[] {
  if (from === to) return [];
  const a = splitLines(from);
  const b = splitLines(to);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  let offset = a.slice(0, head).reduce((n, l) => n + l.length, 0);
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const add = (x: string, y: string, at: number) => {
    const s = charSpan(x, y);
    spans.push({ start: at + s.start, end: at + s.end, text: s.text });
  };
  if (midA.length === midB.length) {
    midA.forEach((x, i) => {
      if (x !== midB[i]) add(x, midB[i], offset);
      offset += x.length;
    });
  } else add(midA.join(""), midB.join(""), offset);
  const lines = TextLines.parse(from);
  return spans.map((s) => ({
    range: { start: lines.positionAt(s.start), end: lines.positionAt(s.end) },
    newText: s.text,
  }));
}

/** Lines with their line endings. */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** The part of `x` to replace (and with what) to get `y`, without their common start and end. */
function charSpan(x: string, y: string): { start: number; end: number; text: string } {
  const max = Math.min(x.length, y.length);
  let head = 0;
  while (head < max && x[head] === y[head]) head++;
  while (head > 0 && splitsPair(x, head)) head--;
  let tail = 0;
  while (tail < max - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  while (tail > 0 && (splitsPair(x, x.length - tail) || splitsPair(y, y.length - tail))) tail--;
  return { start: head, end: x.length - tail, text: y.slice(head, y.length - tail) };
}

/** True when offset `i` falls inside a surrogate pair or a CRLF. */
function splitsPair(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return false;
  const before = s.charCodeAt(i - 1);
  const after = s.charCodeAt(i);
  return (
    (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) ||
    (before === 13 && after === 10)
  );
}
