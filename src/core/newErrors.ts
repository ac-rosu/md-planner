// Which validation errors a change adds: the MCP server refuses such writes, the extension asks
// before a move that would add them. Errors are compared by what they say, not where they are,
// so an existing error that moves with its task is not new.
import { buildDepGraph } from "./graph";
import { type Plan } from "./resolve";
import { validatePlan } from "./validate";

/** The validation errors of a plan, kept to compare a changed plan with (see newErrors). */
export interface PlanErrors {
  /** `code: message` → the message with the file of its first occurrence, and the count. */
  issues: Map<string, { message: string; count: number }>;
  /** Every dependency cycle, as the ids (or titles) of its tasks. */
  cycles: string[][];
}

export function planErrors(plan: Plan | undefined): PlanErrors {
  const issues = new Map<string, { message: string; count: number }>();
  if (!plan) return { issues, cycles: [] };
  const graph = buildDepGraph(plan);
  for (const i of validatePlan(plan, { graph }))
    if (i.severity === "error" && i.code !== "circular-dep") {
      const key = `${i.code}: ${i.message}`;
      const found = issues.get(key);
      issues.set(key, { message: `${i.file}: ${i.message}`, count: (found?.count ?? 0) + 1 });
    }
  return { issues, cycles: graph.cycles.map((c) => c.map((t) => t.id ?? t.title)) };
}

/**
 * Errors `after` has and `before` does not. A cycle is its set of tasks, with the ids in `renamed`
 * (old → new) mapped first.
 */
export function newErrors(
  before: PlanErrors,
  after: PlanErrors,
  renamed: Record<string, string> = {}
): string[] {
  const cycleKey = (names: string[]) => [...names].sort().join("\n");
  const known = new Map<string, number>();
  for (const c of before.cycles) {
    const k = cycleKey(c.map((n) => renamed[n] ?? n));
    known.set(k, (known.get(k) ?? 0) + 1);
  }
  const cycles = new Map<string, { message: string; count: number }>();
  for (const c of after.cycles) {
    const k = cycleKey(c);
    const message = `Circular dependency: ${c.join(" → ")}.`;
    cycles.set(k, { message, count: (cycles.get(k)?.count ?? 0) + 1 });
  }
  return [
    ...[...after.issues]
      .filter(([k, e]) => e.count > (before.issues.get(k)?.count ?? 0))
      .map(([, e]) => e.message),
    ...[...cycles].filter(([k, e]) => e.count > (known.get(k) ?? 0)).map(([, e]) => e.message),
  ];
}
