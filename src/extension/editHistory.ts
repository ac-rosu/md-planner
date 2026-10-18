// Undo/redo for edits made from webviews. Each view edit is applied as a normal WorkspaceEdit (so
// Ctrl+Z in the text editor works as usual); this history additionally lets the webviews undo
// their own last edits by applying the exact inverse edits, after checking that the files were
// not changed in between.
import * as vscode from "vscode";
import { invertEdits } from "../core/text";
import { type FileEdit } from "../core/writer";
import { type PlanService } from "./planService";

interface Entry {
  label: string;
  forward: FileEdit[];
  inverse: FileEdit[];
  before: Map<string, string>;
  after: Map<string, string>;
}

const LIMIT = 100;

export class EditHistory implements vscode.Disposable {
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly service: PlanService) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Applies view edits through a WorkspaceEdit and records them. */
  async apply(edits: FileEdit[], label: string): Promise<boolean> {
    const nonEmpty = edits.filter((e) => e.edits.length > 0);
    if (nonEmpty.length === 0) return true;
    const entry: Entry = {
      label,
      forward: nonEmpty,
      inverse: [],
      before: new Map(),
      after: new Map(),
    };
    for (const fe of nonEmpty) {
      const before = this.currentText(fe.path);
      const { text, inverse } = invertEdits(before, fe.edits);
      entry.before.set(fe.path, before);
      entry.after.set(fe.path, text);
      entry.inverse.push({ path: fe.path, edits: inverse });
    }
    const ok = await this.service.apply(nonEmpty, { source: "view" });
    if (!ok) return false;
    this.undoStack.push(entry);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emitter.fire();
    return true;
  }

  async undo(): Promise<string | undefined> {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return undefined;
    this.assertUnchanged(entry.after, entry.label);
    this.undoStack.pop();
    await this.service.apply(entry.inverse, { source: "view" });
    this.redoStack.push(entry);
    this.emitter.fire();
    return entry.label;
  }

  async redo(): Promise<string | undefined> {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) return undefined;
    this.assertUnchanged(entry.before, entry.label);
    this.redoStack.pop();
    await this.service.apply(entry.forward, { source: "view" });
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

  private currentText(path: string): string {
    const file = this.service.index.get(path);
    if (!file) throw new Error(`Not a loaded plan file: ${path}`);
    // BOM-less, exactly as VS Code documents see it.
    return file.lines.text;
  }

  private assertUnchanged(expected: Map<string, string>, label: string): void {
    for (const [path, text] of expected) {
      if (this.currentText(path) !== text) {
        // Something else edited the file: the stored inverse no longer applies safely.
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.emitter.fire();
        throw new Error(
          `"${label}" cannot be undone here: ${path} changed since. Use Undo in the editor instead.`
        );
      }
    }
  }
}
