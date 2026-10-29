// PlanIndex: the parsed plan folder, updated incrementally one file at a time.
import { type Issue, type ParsedFile } from "./model";
import { classifyPlanPath, notUtf8Issue, parsePlanFile, unreadableFileIssue } from "./parser/files";
import { type Plan, resolvePlan } from "./resolve";

export interface UpdateOptions {
  /**
   * Whether the file's bytes on disk are valid UTF-8. False marks the file `not-utf8` (the text is
   * then the lenient decoding, for display), true clears that; undefined keeps what is known (an
   * editor buffer does not say).
   */
  utf8?: boolean;
}

export class PlanIndex {
  private readonly files = new Map<string, ParsedFile>();
  /** Plan files (and folders of plan files) that could not be read, with their warning. */
  private readonly unreadable = new Map<string, Issue>();
  /** Plan files whose bytes on disk are not valid UTF-8. */
  private readonly notUtf8Paths = new Set<string>();
  private cached: Plan | undefined;
  private _version = 0;

  /** Increments on every change; consumers use it to skip redundant work. */
  get version(): number {
    return this._version;
  }

  /** True when the plan-relative path is a plan file (project, team, milestone, test …). */
  static isPlanPath(relPath: string): boolean {
    return classifyPlanPath(relPath) !== undefined;
  }

  /**
   * Parses (or re-parses) one file. Returns false when the path is not a plan file or the text is
   * unchanged, so callers can skip re-scheduling.
   */
  update(relPath: string, text: string, options: UpdateOptions = {}): boolean {
    const path = normalize(relPath);
    const wasUnreadable = this.unreadable.delete(path);
    const marked = this.notUtf8Paths.has(path);
    const mark = options.utf8 === undefined ? marked : !options.utf8;
    const encodingChanged = mark !== marked;
    if (mark) this.notUtf8Paths.add(path);
    else this.notUtf8Paths.delete(path);
    const existing = this.files.get(path);
    if (existing && !wasUnreadable && !encodingChanged && existing.lines.serialize() === text)
      return false;
    const parsed = parsePlanFile(path, text);
    if (!parsed) {
      const removed = this.remove(path);
      if (wasUnreadable && !removed) this.invalidate();
      return removed || wasUnreadable;
    }
    if (this.notUtf8Paths.has(path)) parsed.issues.unshift(notUtf8Issue(path));
    this.files.set(path, parsed);
    this.invalidate();
    return true;
  }

  /**
   * Notes that a plan file (or a folder that holds plan files) could not be read: it is left out
   * of the plan, with an `unreadable-file` warning. Returns false when nothing changed.
   */
  markUnreadable(relPath: string, error: unknown, folder = false): boolean {
    const path = normalize(relPath);
    const issue = unreadableFileIssue(path, error, folder);
    const parsed = this.files.delete(path);
    this.notUtf8Paths.delete(path);
    if (!parsed && this.unreadable.get(path)?.message === issue.message) return false;
    this.unreadable.set(path, issue);
    this.invalidate();
    return true;
  }

  remove(relPath: string): boolean {
    const path = normalize(relPath);
    this.notUtf8Paths.delete(path);
    const parsed = this.files.delete(path);
    const unreadable = this.unreadable.delete(path);
    if (parsed || unreadable) this.invalidate();
    return parsed || unreadable;
  }

  clear(): void {
    this.files.clear();
    this.unreadable.clear();
    this.notUtf8Paths.clear();
    this.invalidate();
  }

  has(relPath: string): boolean {
    return this.files.has(normalize(relPath));
  }

  get(relPath: string): ParsedFile | undefined {
    return this.files.get(normalize(relPath));
  }

  /** True when the file's bytes on disk are not valid UTF-8: the planner must not edit it. */
  notUtf8(relPath: string): boolean {
    return this.notUtf8Paths.has(normalize(relPath));
  }

  /** The lines of git merge conflict markers in a file (see conflictMarkerLines), 0-based. */
  conflictLines(relPath: string): number[] {
    const file = this.files.get(normalize(relPath));
    if (!file) return [];
    return file.issues.filter((i) => i.code === "merge-conflict").map((i) => i.range.start.line);
  }

  get paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /**
   * Every known path at or below a folder (plan-relative, "" is the plan folder): parsed files and
   * unreadable ones. `ignoreCase` where the file system ignores the case of names.
   */
  pathsUnder(folder: string, ignoreCase = false): string[] {
    const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
    const dir = fold(normalize(folder).replace(/\/+$/, ""));
    const prefix = dir === "" ? "" : dir + "/";
    return [...this.files.keys(), ...this.unreadable.keys()]
      .filter((p) => fold(p) === dir || fold(p).startsWith(prefix))
      .sort();
  }

  /**
   * The path a new or changed file should use so that it matches the casing on disk: the path of an
   * indexed file that differs only in case (`Team.md` for `team.md`), else the path with its folders
   * spelled as indexed files spell them (`Milestones/M2-x.md` for `milestones/M2-x.md`). A path the
   * index knows exactly, or has no other casing of, stays as it is.
   */
  canonicalPath(relPath: string): string {
    const path = normalize(relPath);
    if (this.files.has(path) || this.unreadable.has(path)) return path;
    const known = [...this.files.keys(), ...this.unreadable.keys()];
    const lower = path.toLowerCase();
    const same = known.find((p) => p.toLowerCase() === lower);
    if (same) return same;
    const segments = path.split("/");
    for (let i = segments.length - 1; i > 0; i--) {
      const dir = segments.slice(0, i).join("/");
      if (known.some((p) => p.startsWith(dir + "/"))) return path;
      const dirLower = dir.toLowerCase() + "/";
      const match = known.find((p) => p.toLowerCase().startsWith(dirLower));
      if (match) return match.slice(0, dir.length) + path.slice(dir.length);
    }
    return path;
  }

  /** Ids used outside the plan files (saved baselines), set by the loaders; see `Plan.usedIds`. */
  setUsedIds(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (next.size === this.usedIds.size && [...next].every((id) => this.usedIds.has(id))) return;
    this.usedIds = next;
    this.invalidate();
  }

  private usedIds = new Set<string>();

  get plan(): Plan {
    if (!this.cached) {
      const plan = resolvePlan(this.files.values());
      plan.usedIds = this.usedIds;
      plan.issues.push(...[...this.unreadable.values()].sort((a, b) => (a.file < b.file ? -1 : 1)));
      // `plan.file("team.md")` finds `Team.md` too, so writers edit the file that is there.
      const exact = plan.file;
      plan.file = (p) => {
        const found = exact(p);
        if (found) return found;
        const lower = normalize(p).toLowerCase();
        return plan.files.find((f) => f.path.toLowerCase() === lower);
      };
      this.cached = plan;
    }
    return this.cached;
  }

  private invalidate(): void {
    this.cached = undefined;
    this._version++;
  }
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export { classifyPlanPath };
