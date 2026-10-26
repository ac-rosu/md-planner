// Which validation errors a change adds: the MCP server refuses such writes, the extension asks
// before a move that would add them. Errors are compared by what they say, not where they are,
// so an existing error that moves with its task is not new, and neither is one that names a
// renamed id.
import { buildDepGraph } from "./graph";
import { type Plan } from "./resolve";
import { validatePlan } from "./validate";

/** The validation errors of a plan, kept to compare a changed plan with (see newErrors). */
export interface PlanErrors {
  /** Every error but the cycles. */
  issues: Array<{ code: string; message: string; file: string }>;
  /** Every dependency cycle, as the ids (or titles) of its tasks. */
  cycles: string[][];
}

export function planErrors(plan: Plan | undefined): PlanErrors {
  if (!plan) return { issues: [], cycles: [] };
  const graph = buildDepGraph(plan);
  const issues = validatePlan(plan, { graph })
    .filter((i) => i.severity === "error" && i.code !== "circular-dep")
    .map(({ code, message, file }) => ({ code, message, file }));
  return { issues, cycles: graph.cycles.map((c) => c.map((t) => t.id ?? t.title)) };
}

/** A word of a message that may be an id (`T12`, `api-2`). */
const WORD = /(?<![\w-])[A-Za-z][\w-]*/g;

/**
 * Errors `after` has and `before` does not. The old and the new name of each pair in `renamed`, in
 * the order of the renames, are the same in messages and in cycles: a renamed id, or the title of a
 * task without an id (cycles name it by its title) that was changed or that got an id. A cycle is
 * its set of tasks.
 */
export function newErrors(
  before: PlanErrors,
  after: PlanErrors,
  renamed: Array<[from: string, to: string]> = []
): string[] {
  const same = new Map(renamed.map(([from, to]) => [to, from]));
  const name = (n: string) => {
    let first = n;
    const seen = new Set<string>();
    while (same.has(first) && !seen.has(first)) {
      seen.add(first);
      first = same.get(first)!;
    }
    return first;
  };
  const issueKey = (i: { code: string; message: string }) =>
    `${i.code}: ${i.message.replace(WORD, name)}`;
  const cycleKey = (names: string[]) => names.map(name).sort().join("\n");
  /** The keys `now` has more often than `was`, each with the message of its first occurrence. */
  const added = <T>(was: T[], now: T[], key: (x: T) => string, message: (x: T) => string) => {
    const known = new Map<string, number>();
    for (const x of was) {
      const k = key(x);
      known.set(k, (known.get(k) ?? 0) + 1);
    }
    const found = new Map<string, { message: string; count: number }>();
    for (const x of now) {
      const k = key(x);
      const f = found.get(k);
      found.set(k, { message: f?.message ?? message(x), count: (f?.count ?? 0) + 1 });
    }
    return [...found].filter(([k, e]) => e.count > (known.get(k) ?? 0)).map(([, e]) => e.message);
  };
  return [
    ...added(before.issues, after.issues, issueKey, (i) => `${i.file}: ${i.message}`),
    ...added(
      before.cycles,
      after.cycles,
      cycleKey,
      (c) => `Circular dependency: ${c.join(" → ")}.`
    ),
  ];
}
