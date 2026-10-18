// Diagnostics for a plan. Parse/value problems come from the resolver; this module adds the
// cross-reference checks. Schedule-based checks live in scheduleDiagnostics() (see schedule.ts).
import { UNASSIGNED } from "./calendar";
import { buildDepGraph, cycleDeclarations, type DepGraph } from "./graph";
import { type Issue, isOpen, type Task, TEST_TYPES } from "./model";
import { type Plan } from "./resolve";
import { isEffectivelyDone, isLeaf } from "./rollup";
import { range, type Range } from "./text";

export interface ValidateOptions {
  /** Report tasks without an id (hint level, used for the "assign id" quick fix). */
  missingIds?: boolean;
  /** A dependency graph that was already built for this plan. */
  graph?: DepGraph;
}

export function validatePlan(plan: Plan, options: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [...plan.issues];
  const graph = options.graph ?? buildDepGraph(plan);

  checkDuplicateIds(plan, issues);

  for (const t of plan.tasks) {
    checkOwner(plan, t, issues);
    if (isLeaf(t) && isOpen(t.status) && !isEffectivelyDone(t) && t.est === undefined) {
      issues.push({
        file: t.file,
        range: lineContentRange(plan, t),
        severity: "info",
        code: "missing-estimate",
        message: "Leaf task without an estimate (@est); it is scheduled with 0 hours.",
      });
    }
    if (t.status === "blocked" && !t.blocked) {
      issues.push({
        file: t.file,
        range: statusRange(t),
        severity: "info",
        code: "missing-blocked-reason",
        message: 'Blocked task without a reason; add @blocked:"…".',
      });
    }
    if (t.test && !plan.testById(t.test)) {
      issues.push(
        attrIssue(t, "test", "warning", "unknown-test", `Unknown test plan "${t.test}".`)
      );
    }
    if (options.missingIds && !t.id) {
      issues.push({
        file: t.file,
        range: lineContentRange(plan, t),
        severity: "hint",
        code: "missing-id",
        message: "Task has no id (^T…).",
      });
    }
  }

  for (const u of graph.unknown) {
    issues.push({
      file: u.task.file,
      range: depIdRange(u.task, u.id),
      severity: "error",
      code: "unknown-dep",
      message: `Unknown dependency "${u.id}".`,
      data: { depId: u.id },
    });
  }

  if (graph.cycles.length > 0) {
    const declarations = cycleDeclarations(graph);
    const label = (cycle: Task[]) => cycle.map((t) => t.id ?? t.title).join(" → ");
    for (const cycle of graph.cycles) {
      const message = `Circular dependency: ${label(cycle)}. These tasks are not scheduled.`;
      for (const d of declarations.tasks) {
        if (!cycle.includes(d) && !cycle.some((c) => isAncestor(d, c))) continue;
        issues.push({
          file: d.file,
          range: d.attrs.find((a) => a.key === "dep")?.range ?? lineContentRange(plan, d),
          severity: "error",
          code: "circular-dep",
          message,
        });
      }
      for (const id of declarations.milestones) {
        const m = plan.milestoneById(id);
        if (!m || !cycle.some((c) => c.milestoneId === m.id)) continue;
        const entry = m.props.entries.find((e) => e.key.toLowerCase() === "depends");
        if (!entry) continue;
        issues.push({
          file: m.file,
          range: entry.valueRange,
          severity: "error",
          code: "circular-dep",
          message,
        });
      }
    }
  }

  for (const m of plan.milestones) {
    for (const dep of m.depends) {
      if (!plan.milestoneById(dep)) {
        const entry = m.props.entries.find((e) => e.key.toLowerCase() === "depends")!;
        issues.push({
          file: m.file,
          range: entry.valueRange,
          severity: "error",
          code: "unknown-milestone",
          message: `Unknown milestone "${dep}".`,
        });
      }
    }
  }

  checkTests(plan, issues);
  checkPunch(plan, issues);
  return dedupe(issues);
}

function isAncestor(a: Task, b: Task): boolean {
  for (let t = b.parent; t; t = t.parent) if (t === a) return true;
  return false;
}

function checkDuplicateIds(plan: Plan, issues: Issue[]): void {
  const seen = new Map<string, Task[]>();
  for (const t of [...plan.tasks, ...plan.punch, ...plan.inbox]) {
    if (!t.id) continue;
    const list = seen.get(t.id);
    if (list) list.push(t);
    else seen.set(t.id, [t]);
  }
  for (const [id, list] of seen) {
    if (list.length < 2) continue;
    for (const t of list) {
      issues.push({
        file: t.file,
        range: t.idRange!,
        severity: "error",
        code: "duplicate-id",
        message: `Duplicate id "${id}" (${list.length} items).`,
        data: { id },
      });
    }
  }
}

function checkOwner(plan: Plan, t: Task, issues: Issue[]): void {
  if (!t.owner || t.owner.toLowerCase() === UNASSIGNED) return;
  if (plan.personById(t.owner)) return;
  issues.push(
    attrIssue(
      t,
      "owner",
      "warning",
      "unknown-owner",
      `Unknown owner "${t.owner}"; not in team.md.`,
      {
        owner: t.owner,
      }
    )
  );
}

function checkTests(plan: Plan, issues: Issue[]): void {
  const seen = new Map<string, string>();
  for (const tp of plan.tests) {
    const idEntry = tp.props.entries.find((e) => e.key === "id");
    const headRange = idEntry?.valueRange ?? headingRange(plan, tp.file, tp.headingLine);
    if (seen.has(tp.id.toLowerCase())) {
      issues.push({
        file: tp.file,
        range: headRange,
        severity: "error",
        code: "duplicate-id",
        message: `Duplicate test plan id "${tp.id}" (also in ${seen.get(tp.id.toLowerCase())}).`,
      });
    }
    seen.set(tp.id.toLowerCase(), tp.file);
    if (tp.milestone && !plan.milestoneById(tp.milestone)) {
      const e = tp.props.entries.find((x) => x.key === "milestone")!;
      issues.push({
        file: tp.file,
        range: e.valueRange,
        severity: "warning",
        code: "unknown-milestone",
        message: `Unknown milestone "${tp.milestone}".`,
      });
    }
    if (tp.type && !(TEST_TYPES as readonly string[]).includes(tp.type)) {
      const e = tp.props.entries.find((x) => x.key === "type")!;
      issues.push({
        file: tp.file,
        range: e.valueRange,
        severity: "warning",
        code: "invalid-value",
        message: `Unknown test type "${tp.type}" (${TEST_TYPES.join(" | ")}).`,
      });
    }
    for (const c of tp.cases) {
      for (const s of c.steps) {
        if (s.punch && !plan.punchById(s.punch)) {
          issues.push(
            attrIssue(s, "punch", "warning", "unknown-punch", `Unknown punch item "${s.punch}".`)
          );
        }
      }
    }
  }
}

function checkPunch(plan: Plan, issues: Issue[]): void {
  for (const p of plan.punch) {
    checkOwner(plan, p, issues);
    if (!p.from) continue;
    const [planId, caseId] = p.from.split("/");
    const tp = plan.testById(planId);
    if (!tp) {
      issues.push(
        attrIssue(p, "from", "warning", "unknown-test", `Unknown test plan "${planId}".`)
      );
    } else if (caseId && !tp.cases.some((c) => c.id.toLowerCase() === caseId.toLowerCase())) {
      issues.push(
        attrIssue(
          p,
          "from",
          "warning",
          "unknown-test",
          `Unknown test case "${caseId}" in ${tp.id}.`
        )
      );
    }
  }
}

function attrIssue(
  t: Task,
  key: string,
  severity: Issue["severity"],
  code: string,
  message: string,
  data?: Record<string, string>
): Issue {
  const a = t.attrs.find((x) => x.key === key);
  return {
    file: t.file,
    range: a?.range ?? statusRange(t),
    severity,
    code,
    message,
    data: { key, ...data },
  };
}

function statusRange(t: Task): Range {
  return range(t.line, t.statusCol - 1, t.statusCol + 2);
}

/** Range of the task text after the checkbox. */
export function lineContentRange(plan: Plan, t: Task): Range {
  const text = plan.file(t.file)?.lines.line(t.line) ?? "";
  return range(t.line, Math.min(t.statusCol + 2, text.length), text.replace(/\s+$/, "").length);
}

function headingRange(plan: Plan, file: string, line: number): Range {
  const text = plan.file(file)?.lines.line(Math.max(0, line)) ?? "";
  return range(Math.max(0, line), 0, text.length);
}

/** Precise range of one id inside a task's `@dep` value. */
export function depIdRange(t: Task, id: string): Range {
  const a = t.attrs.find((x) => x.key === "dep");
  if (!a) return statusRange(t);
  if (!a.quoted) {
    const re = new RegExp(`(^|,)\\s*(${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=\\+|,|\\s*$)`);
    const m = re.exec(a.value);
    if (m) {
      const offset = m.index + m[0].length - m[2].length;
      const start = a.valueRange.start.character + offset;
      return range(a.range.start.line, start, start + id.length);
    }
  }
  return a.valueRange;
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.file}:${i.range.start.line}:${i.range.start.character}:${i.code}:${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
