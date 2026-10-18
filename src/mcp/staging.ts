// Staged changes to a plan folder. An MCP tool computes every step against the staged plan (so
// later steps see earlier ones: a new person can own a new task, a new milestone can get tasks),
// and nothing reaches the disk until `commit`. A tool that throws halfway writes nothing.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPlanIndex } from "../core/fsLoader";
import { PlanIndex } from "../core/index";
import { type Plan } from "../core/resolve";
import { applyEdits, type TextEdit } from "../core/text";
import { type FileEdit } from "../core/writer";

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

  /** Current text of a file (staged, else on disk); undefined when it does not exist. */
  text(path: string): string | undefined {
    if (this.staged.has(path)) return this.staged.get(path);
    const full = join(this.root, path);
    return existsSync(full) ? readFileSync(full, "utf8") : undefined;
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
      byPath.set(fe.path, [...(byPath.get(fe.path) ?? []), ...fe.edits]);
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

  set(path: string, text: string | undefined): void {
    if (!this.original.has(path)) {
      const full = join(this.root, path);
      this.original.set(path, existsSync(full) ? readFileSync(full, "utf8") : undefined);
    }
    this.staged.set(path, text);
    if (!PlanIndex.isPlanPath(path)) return;
    if (text === undefined) this.index.remove(path);
    else this.index.update(path, text);
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
