// PlanIndex: the parsed plan folder, updated incrementally one file at a time.
import { type ParsedFile } from "./model";
import { classifyPlanPath, parsePlanFile } from "./parser/files";
import { type Plan, resolvePlan } from "./resolve";

export class PlanIndex {
  private readonly files = new Map<string, ParsedFile>();
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
  update(relPath: string, text: string): boolean {
    const path = normalize(relPath);
    const existing = this.files.get(path);
    if (existing && existing.lines.serialize() === text) return false;
    const parsed = parsePlanFile(path, text);
    if (!parsed) return this.remove(path);
    this.files.set(path, parsed);
    this.invalidate();
    return true;
  }

  remove(relPath: string): boolean {
    const removed = this.files.delete(normalize(relPath));
    if (removed) this.invalidate();
    return removed;
  }

  clear(): void {
    this.files.clear();
    this.invalidate();
  }

  has(relPath: string): boolean {
    return this.files.has(normalize(relPath));
  }

  get(relPath: string): ParsedFile | undefined {
    return this.files.get(normalize(relPath));
  }

  get paths(): string[] {
    return [...this.files.keys()].sort();
  }

  get plan(): Plan {
    if (!this.cached) this.cached = resolvePlan(this.files.values());
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
