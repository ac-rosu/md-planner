// Checks of proposed new tasks against the plan they go into: a dependency the AI proposes may be
// valid on its own (a known id) and still break the plan once written (a dependency on the task's
// own parent, a cycle). Such dependencies are dropped with a warning, using the same new-errors
// check as the MCP server and the editor's moves.
import { PlanIndex } from "../core/index";
import { newErrors, type PlanErrors, planErrors } from "../core/newErrors";
import { type Plan } from "../core/resolve";
import { applyEdits } from "../core/text";
import { type FileEdit, type NewTask } from "../core/writer";

/** The plan's files, parsed again with edits applied: the validation errors after a change. */
class StagedPlan {
  private readonly index = new PlanIndex();
  private readonly texts = new Map<string, string>();
  private touched = new Set<string>();

  constructor(plan: Plan) {
    for (const f of plan.files) {
      this.texts.set(f.path, f.lines.text);
      this.index.update(f.path, f.lines.text);
    }
  }

  errors(edits: FileEdit[]): PlanErrors {
    const byPath = new Map<string, FileEdit["edits"]>();
    for (const e of edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), ...e.edits]);
    for (const path of new Set([...this.touched, ...byPath.keys()])) {
      const text = this.texts.get(path);
      if (text === undefined) continue;
      const own = byPath.get(path);
      this.index.update(path, own?.length ? applyEdits(text, own) : text);
    }
    this.touched = new Set(byPath.keys());
    return planErrors(this.index.plan);
  }
}

function depsOf(t: NewTask): string[] {
  const dep = t.attrs?.find(([k]) => k === "dep")?.[1];
  return dep ? dep.split(",") : [];
}

function setDeps(t: NewTask, deps: string[]): void {
  const attrs = (t.attrs ?? []).filter(([k]) => k !== "dep");
  if (deps.length) attrs.push(["dep", deps.join(",")]);
  t.attrs = attrs;
}

/**
 * Drops the `@dep`s of new tasks that would add validation errors to the plan, with a warning
 * each. `edits` writes the tasks as they are when it is called. A reply whose dependencies add no
 * errors is left as it is (one check); otherwise the dependencies are added back task by task, in
 * the order of the reply, and each one that adds an error is left out (of two tasks that wait for
 * each other, the second one's dependency goes).
 */
export function dropErrorDeps(
  plan: Plan,
  tasks: NewTask[],
  edits: () => FileEdit[],
  warnings: string[]
): void {
  const staged = new StagedPlan(plan);
  let current = staged.errors([]);
  if (newErrors(current, staged.errors(edits())).length === 0) return;
  const wanted = tasks.map((t) => ({ t, deps: depsOf(t) })).filter((w) => w.deps.length);
  for (const { t } of wanted) setDeps(t, []);
  current = staged.errors(edits());
  for (const { t, deps } of wanted) {
    setDeps(t, deps);
    const all = staged.errors(edits());
    if (newErrors(current, all).length === 0) {
      current = all;
      continue;
    }
    const kept: string[] = [];
    for (const d of deps) {
      setDeps(t, [...kept, d]);
      const after = staged.errors(edits());
      const added = newErrors(current, after);
      if (added.length === 0) {
        kept.push(d);
        current = after;
      } else
        warnings.push(
          `"${t.title}": dependency on ${d} dropped, as it would add an error: ${added[0]}`
        );
    }
    setDeps(t, kept);
  }
}
