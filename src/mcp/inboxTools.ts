// Inbox and punch list tools: capture ideas, plan an inbox item into a milestone, list and add punch
// items (optionally raised from a failed test step and linked to it).
import { isValidDate } from "../core/dates";
import { type Status, STATUSES } from "../core/model";
import { taskKey } from "../core/scheduler";
import { addPunchItem as addPunchItemEdits, caseOfStep, linkStepToPunch } from "../core/testRun";
import { type InsertLocation, moveTask, nextId } from "../core/writer";
import { captureInbox as captureInboxEdits } from "../core/writer/entities";
import { milestoneOf } from "./milestoneTools";
import { type Staging } from "./staging";
import { personOf } from "./taskSpecs";
import { findTask, type PlannerTools, ToolError } from "./tools";

export function listInbox(tools: PlannerTools) {
  const plan = tools.load();
  return plan.inbox
    .filter((t) => !t.parent)
    .map((t, i) => ({
      item: i + 1,
      ref: `inbox:${i + 1}`,
      id: t.id,
      title: t.title,
      status: t.status,
      owner: t.owner,
      tags: t.tags.map((x) => x.tag),
      notes: t.notes.map((n) => n.text),
    }));
}

/** Stages inbox lines (inbox.md is created when missing). */
export function stageInbox(st: Staging, items: string[]): void {
  for (const text of items) {
    if (!text?.trim()) continue;
    const c = captureInboxEdits(st.plan, text.replace(/\s+/g, " ").trim());
    if (c.create) st.create(c.create.path, c.create.text);
    st.apply(c.edits);
  }
}

export function captureInbox(tools: PlannerTools, args: { items: string[] }) {
  if (!args.items?.some((x) => x?.trim())) throw new ToolError("Nothing to capture.");
  const st = tools.stage();
  stageInbox(st, args.items);
  return { captured: args.items.filter((x) => x?.trim()).length, changed: tools.commit(st) };
}

/** Moves an inbox item into a milestone (section) as a task with a new id. */
export function planInboxItem(
  tools: PlannerTools,
  args: { item: string | number; milestone: string; section?: string }
) {
  const st = tools.stage();
  const plan = st.plan;
  const ref = typeof args.item === "number" ? `inbox:${args.item}` : args.item;
  const item =
    findTask(plan, ref) ??
    plan.inbox.find((t) => !t.parent && t.title.toLowerCase() === String(ref).trim().toLowerCase());
  if (!item || item.kind !== "inbox")
    throw new ToolError(
      `Unknown inbox item "${args.item}" (a number from list_inbox, or its title).`
    );
  const m = milestoneOf(plan, args.milestone);
  if (!m) throw new ToolError(`Unknown milestone "${args.milestone}".`);
  const location: InsertLocation = args.section?.trim()
    ? { kind: "section", title: args.section.trim() }
    : { kind: "root" };
  const id = item.id ?? nextId(plan, "T");
  st.apply(
    moveTask(plan.file(item.file)!, item, plan.file(m.file)!, location, (first) =>
      item.id ? first : `${first.replace(/\s+$/, "")} ^${id}`
    )
  );
  return { id, milestone: m.id, changed: tools.commit(st) };
}

export function listPunchItems(
  tools: PlannerTools,
  args: { status?: Status[]; sev?: string; owner?: string; includeClosed?: boolean }
) {
  const plan = tools.load();
  const owner = args.owner ? (personOf(plan, args.owner) ?? args.owner) : undefined;
  return plan.punch
    .filter((t) => !t.parent)
    .filter(
      (t) => args.includeClosed || args.status?.length || !["done", "cancelled"].includes(t.status)
    )
    .filter((t) => !args.status?.length || args.status.includes(t.status))
    .filter((t) => !args.sev || (t.sev ?? "").toUpperCase() === args.sev.toUpperCase())
    .filter((t) => !owner || t.owner?.toLowerCase() === owner.toLowerCase())
    .map((t) => ({
      id: t.id ?? taskKey(t),
      title: t.title,
      status: t.status,
      sev: t.sev,
      owner: t.owner,
      due: t.due,
      from: t.from,
      tags: t.tags.map((x) => x.tag),
      blocked: t.blocked,
    }));
}

export interface PunchInput {
  title: string;
  sev?: "A" | "B" | "C";
  owner?: string;
  due?: string;
  /** Where it was found, e.g. UAT-01/TC-01 (set automatically with step). */
  from?: string;
  tags?: string[];
  status?: Status;
  /** Raise it from a failed test step: links the step to the item with @punch. */
  step?: { test: string; case: string; step: number };
}

/** Stages punch items (punchlist.md is created when missing); returns their ids. */
export function stagePunchItems(st: Staging, items: PunchInput[], today: string): string[] {
  const ids: string[] = [];
  for (const [i, p] of items.entries()) {
    const label = `Punch item ${i + 1} "${p.title ?? ""}"`;
    if (!p.title?.trim()) throw new ToolError(`${label}: a title is needed.`);
    if (p.sev && !["A", "B", "C"].includes(p.sev))
      throw new ToolError(`${label}: severity is A, B or C.`);
    if (p.due && !isValidDate(p.due)) throw new ToolError(`${label}: invalid due date "${p.due}".`);
    if (p.status && !STATUSES.includes(p.status))
      throw new ToolError(`${label}: invalid status "${p.status}".`);
    const plan = st.plan;
    const owner = p.owner ? personOf(plan, p.owner) : undefined;
    if (p.owner && !owner) throw new ToolError(`${label}: unknown owner "${p.owner}".`);
    let link: { file: string; line: number } | undefined;
    let from = p.from;
    if (p.step) {
      const located = findStep(plan, p.step.test, p.step.case, p.step.step);
      from ??= `${located.tp.id}/${located.tc.id}`;
      link = { file: located.tp.file, line: located.step.line };
    }
    const c = addPunchItemEdits(plan, {
      title: p.title.trim(),
      sev: p.sev,
      owner,
      due: p.due,
      from,
      tags: p.tags,
      status: p.status,
      today,
    });
    if (c.create) st.create(c.create.path, c.create.text);
    st.apply(c.edits);
    if (link) {
      const file = st.plan.file(link.file)!;
      const step = file.items.find((x) => x.line === link!.line)!;
      st.apply({ path: file.path, edits: linkStepToPunch(file, step, c.id) });
    }
    ids.push(c.id);
  }
  return ids;
}

export function addPunchItems(tools: PlannerTools, args: { items: PunchInput[] }) {
  if (!args.items?.length) throw new ToolError("No punch items given.");
  const st = tools.stage();
  const ids = stagePunchItems(st, args.items, tools.today);
  return { created: ids, changed: tools.commit(st) };
}

/** A test step by test plan, case and 1-based step number (subtasks count as steps). */
export function findStep(plan: PlannerTools["plan"], test: string, caseId: string, step: number) {
  const tp = plan.testById(test);
  if (!tp)
    throw new ToolError(`Unknown test plan "${test}" (${plan.tests.map((t) => t.id).join(", ")}).`);
  const tc = tp.cases.find((x) => x.id.toLowerCase() === caseId.toLowerCase());
  if (!tc)
    throw new ToolError(
      `Unknown case "${caseId}" in ${tp.id} (${tp.cases.map((x) => x.id).join(", ")}).`
    );
  const steps = tc.steps.flatMap((s) => [s, ...s.children]);
  const s = steps[step - 1];
  if (!s)
    throw new ToolError(
      `${tp.id}/${tc.id} has ${steps.length} step(s); step ${step} does not exist.`
    );
  if (caseOfStep(tp, s) !== tc) throw new ToolError(`Step ${step} is not in ${tc.id}.`);
  return { tp, tc, step: s };
}
