// Staged changes to a plan folder. An MCP tool computes every step against the staged plan (so
// later steps see earlier ones: a new person can own a new task, a new milestone can get tasks),
// and nothing reaches the disk until `commit`. A tool that throws halfway writes nothing.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { editRefusal, isMissing, loadPlanIndex, readText } from "../core/fsLoader";
import { PlanIndex } from "../core/index";
import { describeReadError } from "../core/parser/files";
import { type Plan } from "../core/resolve";
import { applyEdits, type TextEdit } from "../core/text";
import { type FileEdit } from "../core/writer";

/** An error a tool reports to the agent as its result (re-exported by tools.ts). */
export class ToolError extends Error {}

export interface ChangedLines {
  file: string;
  /** 1-based first changed line in the new text. */
  line: number;
  before: string[];
  after: string[];
  /** Set when the file was created or deleted. */
  created?: boolean;
  deleted?: boolean;
}

/** The changed region of a text, line by line (common prefix and suffix removed). */
export function changedLines(
  file: string,
  before: string,
  after: string
): ChangedLines | undefined {
  if (before === after) return undefined;
  const a = before.split(/\r\n|\n|\r/);
  const b = after.split(/\r\n|\n|\r/);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { file, line: p + 1, before: a.slice(p, a.length - s), after: b.slice(p, b.length - s) };
}

export class Staging {
  private readonly index: PlanIndex;
  /** Text on disk before the first change (undefined = the file did not exist). */
  private readonly original = new Map<string, string | undefined>();
  /** Staged text (undefined = deleted). */
  private readonly staged = new Map<string, string | undefined>();

  /** `root` is the plan folder; paths are relative to it (`../src/x.ts` reaches the workspace). */
  constructor(private readonly root: string) {
    this.index = existsSync(root) ? loadPlanIndex(root) : new PlanIndex();
  }

  get plan(): Plan {
    return this.index.plan;
  }

  /**
   * The path of a file as it is spelled on disk: `Team.md` for `team.md`, `Milestones/M2-x.md` for
   * a new `milestones/M2-x.md` when the folder is `Milestones/` (see PlanIndex.canonicalPath).
   */
  private onDisk(path: string): string {
    return this.index.canonicalPath(path);
  }

  /** A file's text on disk; undefined when it does not exist. */
  private read(path: string): { text: string; utf8: boolean } | undefined {
    try {
      return readText(join(this.root, path));
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw new ToolError(`Cannot read ${path}: ${describeReadError(err)}.`);
    }
  }

  /**
   * Current text of a file (staged, else on disk); undefined when it does not exist. A file that
   * is not UTF-8 reads with U+FFFD for what does not decode (it cannot be changed, see `set`).
   */
  text(path: string): string | undefined {
    const p = this.onDisk(path);
    if (this.staged.has(p)) return this.staged.get(p);
    return this.read(p)?.text;
  }

  exists(path: string): boolean {
    return this.text(path) !== undefined;
  }

  /** Applies edits computed against the current staged plan. Edits of one path are combined. */
  apply(edits: FileEdit[] | FileEdit | undefined): void {
    if (!edits) return;
    const byPath = new Map<string, TextEdit[]>();
    for (const fe of Array.isArray(edits) ? edits : [edits]) {
      if (fe.edits.length === 0) continue;
      const path = this.onDisk(fe.path);
      byPath.set(path, [...(byPath.get(path) ?? []), ...fe.edits]);
    }
    for (const [path, list] of byPath) {
      const before = this.text(path);
      if (before === undefined) throw new Error(`${path} does not exist.`);
      this.set(path, applyEdits(before, list));
    }
  }

  create(path: string, text: string, options: { overwrite?: boolean } = {}): void {
    if (!options.overwrite && this.exists(path)) throw new Error(`${path} already exists.`);
    this.set(path, text);
  }

  delete(path: string): void {
    if (!this.exists(path)) throw new Error(`${path} does not exist.`);
    this.set(path, undefined);
  }

  /**
   * Stages the text of a file (undefined deletes it). Refuses to change a file that is not UTF-8
   * (its accented letters would be lost) or has git merge conflict markers (the change would land
   * inside the conflict): a ToolError naming the file, and nothing is written.
   */
  set(path: string, text: string | undefined): void {
    const p = this.onDisk(path);
    if (!this.original.has(p)) {
      const disk = this.read(p);
      const refusal = disk && editRefusal(p, disk.text, disk.utf8);
      if (refusal) throw new ToolError(`Nothing was written: ${refusal}`);
      this.original.set(p, disk?.text);
    }
    this.staged.set(p, text);
    if (!PlanIndex.isPlanPath(p)) return;
    if (text === undefined) this.index.remove(p);
    else this.index.update(p, text);
  }

  /** The staged changes, as changed lines per file (nothing written). */
  changes(): ChangedLines[] {
    const out: ChangedLines[] = [];
    for (const [path, after] of this.staged) {
      const before = this.original.get(path);
      if (before === after) continue;
      const strip = (s: string | undefined) => (s ?? "").replace(/^\uFEFF/, "");
      const c = changedLines(path, strip(before), strip(after));
      if (!c) continue;
      if (before === undefined) c.created = true;
      if (after === undefined) c.deleted = true;
      out.push(c);
    }
    return out;
  }

  /** Writes every staged change to disk; returns what changed. */
  commit(): ChangedLines[] {
    const changes = this.changes();
    for (const [path, after] of this.staged) {
      if (this.original.get(path) === after) continue;
      const full = join(this.root, path);
      if (after === undefined) rmSync(full, { force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, after, "utf8");
      }
    }
    this.original.clear();
    this.staged.clear();
    return changes;
  }
}
