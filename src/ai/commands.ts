// The AI commands as pure functions: build the request (only the context that is needed), then
// validate the JSON reply and turn it into writer edits. The AI never produces dates; numbers
// that can be computed (calibration factors, schedules) are computed here, not by the model.
import { type Baseline } from "../core/baseline";
import { formatDate } from "../core/dates";
import { formatHours, formatNumber, parseDuration } from "../core/duration";
import { weekLoadAt } from "../core/load";
import {
  attentionLists,
  effectiveTags,
  estimateAccuracy,
  type EstimateAccuracy,
} from "../core/metrics";
import { type Milestone, type Task } from "../core/model";
import { type Plan } from "../core/resolve";
import { estimateHours, isLeaf, ownerOf } from "../core/rollup";
import { findTaskByKey, type Schedule, taskKey } from "../core/scheduler";
import { buildDashboardModel } from "../core/views/dashboard";
import { buildResourcesModel, overloadedWeeks } from "../core/views/resources";
import { type FileEdit, insertTasks, type NewTask, nextIds, setAttr } from "../core/writer";
import { type AiRequest } from "./provider";
import {
  BREAKDOWN_SCHEMA,
  CALIBRATE_SCHEMA,
  ESTIMATE_SCHEMA,
  OWNERS_SCHEMA,
  PLAN_FROM_TEXT_SCHEMA,
  REVIEW_SCHEMA,
  SUMMARY_SCHEMA,
} from "./schemas";

export interface Proposal {
  title: string;
  edits: FileEdit[];
  /** One line per change (with the AI's rationale), shown with the diff. */
  notes: string[];
  /** Parts of the reply that were rejected or corrected. */
  warnings: string[];
}

export const SYSTEM_PROMPT = `You are the planning assistant of Markdown Project Planner, used by a project lead who plans the work of a small team.
Rules:
- Reply with one JSON object that matches the given JSON schema, and nothing else.
- Never invent or compute dates: a deterministic scheduler places all work on the calendar.
- Use only person ids from the team list and only task ids that appear in the input.
- Durations are written as hours (6h), days (1.5d, one day = the project's hours per day) or weeks (1w = 5 days).
- Be specific and concise; titles are short imperative phrases in the language of the plan.`;

/**
 * Reference skeleton of a project (the phases of the built-in template), used as context for
 * breakdowns; the plan's own milestones and tasks come first.
 */
const PROJECT_SKELETON =
  "Typical project work (adapt it to this plan): kick-off, research and interviews, integration inventory, domain model, user stories and acceptance criteria, architecture and API design, UX concept, specification review and sign-off; repository and CI setup, shared libraries, data model, services and endpoints, notifications, security, unit and integration tests; design system, components, pages and flows, dashboards, roles and permissions; acceptance test plan, staging environment, internal test round, acceptance test with key users, bug fixing; production environment, load and security tests, data migration, pilot, training, go-live, release notes and runbook.";

// ---------------------------------------------------------------------------------------------
// Context helpers

function taskSummary(plan: Plan, t: Task, schedule?: Schedule): string {
  const parts = [taskKey(t), t.title, t.status];
  const est = estimateHours(t);
  if (est !== undefined) parts.push(`est ${formatHours(est)}`);
  if (t.act !== undefined) parts.push(`act ${formatHours(t.act)}`);
  const owner = ownerOf(t);
  if (owner) parts.push(`owner ${owner}`);
  if (t.deps.length) parts.push(`after ${t.deps.map((d) => d.raw).join(",")}`);
  const tags = effectiveTags(t);
  if (tags.length) parts.push(`tags ${tags.join(",")}`);
  const ts = schedule?.tasks.get(t);
  if (ts?.start !== undefined && ts.finish !== undefined && !ts.done)
    parts.push(`scheduled ${formatDate(ts.start)}..${formatDate(ts.finish)}`);
  return parts.join(" | ");
}

function milestoneOutline(plan: Plan, m: Milestone, schedule?: Schedule): string {
  const lines = [`Milestone ${m.id}: ${m.title}${m.target ? ` (target ${m.target})` : ""}`];
  if (m.description.length) lines.push(`Scope: ${m.description.join(" ")}`);
  const add = (t: Task, depth: number) => {
    lines.push(`${"  ".repeat(depth)}- ${taskSummary(plan, t, schedule)}`);
    for (const c of t.children) add(c, depth + 1);
  };
  for (const t of m.rootTasks) add(t, 0);
  for (const s of m.sections) {
    if (!s.tasks.length) continue;
    lines.push(`Section: ${s.title}`);
    for (const t of s.tasks) add(t, 1);
  }
  return lines.join("\n");
}

function teamSummary(plan: Plan, schedule?: Schedule): string {
  const today = schedule?.today;
  return plan.people
    .map((p) => {
      const parts = [
        `${p.id} (${p.name}${p.role ? `, ${p.role}` : ""})`,
        `capacity ${p.capacityHours}h/${p.capacityPer}`,
      ];
      if (p.skills.length) parts.push(`skills ${p.skills.join(", ")}`);
      if (today !== undefined) {
        const off = p.off
          .filter(([, b]) => b >= today)
          .map(([a, b]) => (a === b ? formatDate(a) : `${formatDate(a)}..${formatDate(b)}`));
        if (off.length) parts.push(`time off ${off.join(", ")}`);
        const span = (a: number, b: number) =>
          a === b ? formatDate(a) : `${formatDate(a)}..${formatDate(b)}`;
        const overtime = p.overtime
          .filter((o) => o.to >= today)
          .map((o) => `${span(o.from, o.to)} +${o.hours}h/${o.per}`);
        if (overtime.length) parts.push(`overtime ${overtime.join(", ")}`);
        const extra = p.workdays
          .filter((w) => w.to >= today)
          .map((w) => `${span(w.from, w.to)}${w.hours !== undefined ? ` ${w.hours}h` : ""}`);
        if (extra.length) parts.push(`extra working days ${extra.join(", ")}`);
        if (schedule) {
          const loads = [0, 1, 2, 3, 4, 5].map((w) => {
            const l = weekLoadAt(schedule, p.id, today + w * 7);
            return `${l.week} ${Math.round(l.hours)}/${Math.round(l.capacity)}h`;
          });
          parts.push(`scheduled load ${loads.join("; ")}`);
        }
      }
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
}

function accuracyText(acc: EstimateAccuracy, plan: Plan): string {
  const row = (r: EstimateAccuracy["overall"], label: string) =>
    `${label}: actual/estimate ${formatNumber(r.ratio)} (n = ${r.n})`;
  const lines = [row(acc.overall, "all done tasks")];
  for (const r of acc.byPerson) lines.push(row(r, `person ${plan.personById(r.key)?.id ?? r.key}`));
  for (const r of acc.byTag) lines.push(row(r, `#${r.key}`));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Validation helpers

type Obj = Record<string, unknown>;

function asObject(v: unknown, what: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error(`The AI reply has no ${what}.`);
  return v as Obj;
}

function asArray(v: unknown): Obj[] {
  return Array.isArray(v)
    ? v.filter((x): x is Obj => !!x && typeof x === "object" && !Array.isArray(x))
    : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function cleanTag(t: string): string {
  return t
    .replace(/^#/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_/-]/gu, "");
}

/** Valid duration text (normalised), or undefined. */
function duration(plan: Plan, text: string): string | undefined {
  const t = text.replace(/\s+/g, "");
  return t && parseDuration(t, plan.project.hoursPerDay) !== undefined ? t : undefined;
}

interface NewTaskSpec {
  ref: string;
  title: string;
  estimate: string;
  tags: string[];
  owner: string;
  dependsOn: string[];
  notes: string;
  parent?: string;
}

/** Validates new tasks from a reply and converts them to writer tasks with fresh ids. */
function buildNewTasks(
  plan: Plan,
  specs: NewTaskSpec[],
  warnings: string[]
): { roots: NewTask[]; all: Array<{ id: string; task: NewTask }> } {
  const valid = specs.filter((s) => {
    if (!s.title) warnings.push("A task without a title was dropped.");
    return !!s.title;
  });
  const ids = nextIds(plan, "T", valid.length);
  const byRef = new Map<string, string>();
  valid.forEach((s, i) => {
    if (s.ref) byRef.set(s.ref.toLowerCase(), ids[i]);
  });
  const nodes = valid.map((s, i): { spec: NewTaskSpec; id: string; task: NewTask } => {
    const attrs: Array<[string, string]> = [];
    const est = duration(plan, s.estimate);
    if (s.estimate && !est)
      warnings.push(`"${s.title}": invalid estimate "${s.estimate}" dropped.`);
    if (est) attrs.push(["est", est]);
    if (s.owner) {
      const person = plan.personById(s.owner);
      if (person) attrs.push(["owner", person.id]);
      else warnings.push(`"${s.title}": unknown owner "${s.owner}" dropped.`);
    }
    const deps: string[] = [];
    for (const d of s.dependsOn) {
      const mapped = byRef.get(d.toLowerCase()) ?? (plan.taskById(d) ? d : undefined);
      if (mapped && mapped !== ids[i]) deps.push(mapped);
      else if (!mapped) warnings.push(`"${s.title}": unknown dependency "${d}" dropped.`);
    }
    if (deps.length) attrs.push(["dep", [...new Set(deps)].join(",")]);
    return {
      spec: s,
      id: ids[i],
      task: {
        title: s.title,
        attrs,
        tags: [...new Set(s.tags.map(cleanTag).filter(Boolean))],
        id: ids[i],
        notes: s.notes ? [s.notes] : [],
        children: [],
      },
    };
  });
  const roots: NewTask[] = [];
  for (const n of nodes) {
    const parentRef = n.spec.parent?.toLowerCase();
    const parent = parentRef
      ? nodes.find((p) => p.spec.ref.toLowerCase() === parentRef && p !== n)
      : undefined;
    if (parent && !parent.spec.parent) parent.task.children!.push(n.task);
    else {
      if (parentRef && !parent)
        warnings.push(
          `"${n.spec.title}": unknown parent "${n.spec.parent}"; added at the top level.`
        );
      roots.push(n.task);
    }
  }
  return { roots, all: nodes.map((n) => ({ id: n.id, task: n.task })) };
}

function readTaskSpecs(items: Obj[]): NewTaskSpec[] {
  return items.map((o) => ({
    ref: asString(o.ref),
    title: asString(o.title),
    estimate: asString(o.estimate),
    tags: asStrings(o.tags),
    owner: asString(o.owner),
    dependsOn: asStrings(o.dependsOn),
    notes: asString(o.notes),
    parent: asString(o.parent) || undefined,
  }));
}

function describeNew(t: NewTask): string {
  const attrs = (t.attrs ?? []).map(([k, v]) => `@${k}:${v}`).join(" ");
  return `${t.id} ${t.title}${attrs ? ` ${attrs}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Break down task

export function breakDownRequest(
  plan: Plan,
  schedule: Schedule | undefined,
  task: Task
): AiRequest {
  const m = plan.milestoneById(task.milestoneId);
  const siblings = (
    task.parent?.children ?? (m ? [...m.rootTasks, ...m.sections.flatMap((s) => s.tasks)] : [])
  ).filter((t) => t !== task);
  return {
    purpose: "break down task",
    system: SYSTEM_PROMPT,
    schema: BREAKDOWN_SCHEMA,
    prompt: [
      `Break down task ${taskKey(task)} "${task.title}" into 3–10 concrete subtasks with estimates, tags and dependencies between them (refs N1, N2 …).`,
      `The sum of the subtask estimates is the new effort for the task${estimateHours(task) !== undefined ? `; the current estimate is ${formatHours(estimateHours(task)!)}` : ""}.`,
      "Only assign an owner when the task's owner should not do the subtask.",
      "",
      `Task: ${taskSummary(plan, task, schedule)}`,
      task.notes.length ? `Task notes:\n${task.notes.map((n) => n.text).join("\n")}` : "",
      task.children.length
        ? `Existing subtasks:\n${task.children.map((c) => `- ${taskSummary(plan, c)}`).join("\n")}`
        : "",
      siblings.length
        ? `Sibling tasks (for context):\n${siblings
            .slice(0, 30)
            .map((s) => `- ${taskSummary(plan, s)}`)
            .join("\n")}`
        : "",
      m ? `\n${milestoneOutline(plan, m)}` : "",
      `\nTeam:\n${teamSummary(plan)}`,
      `\nHours per day: ${plan.project.hoursPerDay}`,
      `\n${PROJECT_SKELETON}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function breakDownProposal(plan: Plan, task: Task, reply: unknown): Proposal {
  const o = asObject(reply, "subtasks");
  const warnings: string[] = [];
  const specs = readTaskSpecs(asArray(o.subtasks)).map((s) => ({ ...s, parent: undefined }));
  if (specs.length === 0) throw new Error("The AI proposed no subtasks.");
  const { roots, all } = buildNewTasks(plan, specs, warnings);
  const file = plan.file(task.file)!;
  const notes = [asString(o.rationale), ...all.map((n) => `+ ${describeNew(n.task)}`)].filter(
    Boolean
  );
  return {
    title: `Break down ${task.id ?? task.title}`,
    edits: [{ path: file.path, edits: insertTasks(file, { kind: "child", task }, roots) }],
    notes,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Estimate

export function estimateRequest(plan: Plan, tasks: Task[]): AiRequest {
  const examples = plan.tasks
    .filter((t) => isLeaf(t) && t.est !== undefined && !tasks.includes(t))
    .slice(0, 60);
  return {
    purpose: "estimate",
    system: SYSTEM_PROMPT,
    schema: ESTIMATE_SCHEMA,
    prompt: [
      "Estimate the effort of each task below (one estimate per id, a one-line rationale each).",
      "Base the estimates on similar tasks in this plan and on the historical accuracy of estimates.",
      "",
      "Tasks to estimate:",
      ...tasks.map((t) => {
        const m = plan.milestoneById(t.milestoneId);
        return `- ${taskSummary(plan, t)}${m ? ` | milestone ${m.id} ${m.title}` : ""}${t.section ? ` | section ${t.section}` : ""}${t.notes.length ? ` | notes: ${t.notes.map((n) => n.text).join(" ")}` : ""}`;
      }),
      "",
      "Estimated tasks in this plan (reference):",
      ...examples.map((t) => `- ${taskSummary(plan, t)}`),
      "",
      `Accuracy of past estimates:\n${accuracyText(estimateAccuracy(plan), plan)}`,
      `Hours per day: ${plan.project.hoursPerDay}`,
    ].join("\n"),
  };
}

export function estimateProposal(plan: Plan, tasks: Task[], reply: unknown): Proposal {
  const o = asObject(reply, "estimates");
  const warnings: string[] = [];
  const notes: string[] = [];
  const byFile = new Map<string, FileEdit>();
  const wanted = new Map(tasks.map((t) => [taskKey(t), t]));
  for (const e of asArray(o.estimates)) {
    const id = asString(e.id);
    const t = wanted.get(id);
    if (!t) {
      warnings.push(`Estimate for unknown or unrequested task "${id}" ignored.`);
      continue;
    }
    wanted.delete(id);
    const est = duration(plan, asString(e.estimate));
    if (!est) {
      warnings.push(`${id}: invalid estimate "${asString(e.estimate)}" ignored.`);
      continue;
    }
    const file = plan.file(t.file)!;
    const fe = byFile.get(t.file) ?? { path: t.file, edits: [] };
    fe.edits.push(...setAttr(file.lines, t, "est", est));
    byFile.set(t.file, fe);
    notes.push(`${id} ${t.title}: @est:${est} — ${asString(e.rationale) || "no rationale"}`);
  }
  for (const id of wanted.keys()) warnings.push(`${id}: no estimate proposed.`);
  return {
    title: `Estimate ${notes.length} task(s)`,
    edits: [...byFile.values()],
    notes,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Calibrate

export interface CalibrationRow {
  key: string;
  task: Task;
  raw: number;
  calibrated: number;
  factor: number;
  basis: string;
  /** New `@est` text. */
  value: string;
}

/**
 * Deterministic calibration of open estimates from past accuracy: the person's ratio when they
 * have at least `minSamples` completed tasks, else the best-sampled tag ratio. Factors are clamped
 * to 0.5–2.5 and differences under 10 % are ignored.
 */
export function calibrationRows(
  plan: Plan,
  minSamples = 3
): { rows: CalibrationRow[]; accuracy: EstimateAccuracy } {
  const accuracy = estimateAccuracy(plan);
  const byPerson = new Map(
    accuracy.byPerson.filter((r) => r.n >= minSamples).map((r) => [r.key, r])
  );
  const byTag = new Map(accuracy.byTag.filter((r) => r.n >= minSamples).map((r) => [r.key, r]));
  const hpd = plan.project.hoursPerDay;
  const rows: CalibrationRow[] = [];
  for (const t of plan.tasks) {
    if (
      !isLeaf(t) ||
      t.est === undefined ||
      t.status === "done" ||
      t.status === "cancelled" ||
      t.act !== undefined
    )
      continue;
    const owner = ownerOf(t)?.toLowerCase();
    const person = owner ? byPerson.get(owner) : undefined;
    const tag = effectiveTags(t)
      .map((x) => byTag.get(x))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .sort((a, b) => b.n - a.n)[0];
    const source =
      person && (!tag || person.n >= tag.n)
        ? { r: person, label: plan.personById(owner)?.name ?? owner }
        : tag
          ? { r: tag, label: `#${tag.key}` }
          : undefined;
    if (!source) continue;
    const factor = Math.min(2.5, Math.max(0.5, source.r.ratio));
    if (Math.abs(factor - 1) < 0.1) continue;
    const calibrated = Math.max(0.5, Math.round(t.est * factor * 2) / 2);
    if (calibrated === t.est) continue;
    const rawText = t.attrs.find((a) => a.key === "est")?.value ?? "";
    const days = calibrated / hpd;
    const value =
      /d$/i.test(rawText) && Number.isInteger(days * 2)
        ? `${formatNumber(days)}d`
        : formatHours(calibrated);
    rows.push({
      key: taskKey(t),
      task: t,
      raw: t.est,
      calibrated,
      factor,
      basis: `${source.label} ×${formatNumber(factor)} (n = ${source.r.n})`,
      value,
    });
  }
  return { rows, accuracy };
}

export function calibrateRequest(
  plan: Plan,
  rows: CalibrationRow[],
  accuracy: EstimateAccuracy
): AiRequest {
  return {
    purpose: "calibrate",
    system: SYSTEM_PROMPT,
    schema: CALIBRATE_SCHEMA,
    prompt: [
      "The planner computed how actual hours compared to estimates for completed tasks, and calibrated the open estimates with these factors (computed, not yours to change).",
      "Write 2–6 short insight lines for the team lead (e.g. '#frontend tasks: you underestimate by 28% (n = 14)'), and list tasks where the calibration should not be applied (for example fixed-length meetings or work whose scope differs from the history) with a reason.",
      "",
      `Accuracy of past estimates:\n${accuracyText(accuracy, plan)}`,
      "",
      "Proposed calibrations:",
      ...rows.map(
        (r) =>
          `- ${r.key} ${r.task.title}: ${formatHours(r.raw)} → ${formatHours(r.calibrated)} (${r.basis})`
      ),
    ].join("\n"),
  };
}

export function calibrateProposal(plan: Plan, rows: CalibrationRow[], reply: unknown): Proposal {
  const o = asObject(reply, "insights");
  const warnings: string[] = [];
  const skip = new Map<string, string>();
  for (const s of asArray(o.skip)) {
    const id = asString(s.id);
    if (rows.some((r) => r.key === id)) skip.set(id, asString(s.reason));
    else warnings.push(`Skip for unknown task "${id}" ignored.`);
  }
  const byFile = new Map<string, FileEdit>();
  const notes = [...asStrings(o.insights)];
  for (const r of rows) {
    if (skip.has(r.key)) {
      notes.push(`${r.key} ${r.task.title}: kept at ${formatHours(r.raw)} — ${skip.get(r.key)}`);
      continue;
    }
    const file = plan.file(r.task.file)!;
    const fe = byFile.get(r.task.file) ?? { path: r.task.file, edits: [] };
    fe.edits.push(...setAttr(file.lines, r.task, "est", r.value));
    byFile.set(r.task.file, fe);
    notes.push(
      `${r.key} ${r.task.title}: ${formatHours(r.raw)} → ${formatHours(r.calibrated)} (${r.basis})`
    );
  }
  return {
    title: `Calibrate ${rows.length - skip.size} estimate(s)`,
    edits: [...byFile.values()],
    notes,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Suggest owners

/** Open leaf tasks without an owner (own or inherited). */
export function unassignedTasks(plan: Plan): Task[] {
  return plan.tasks.filter(
    (t) => isLeaf(t) && t.status !== "done" && t.status !== "cancelled" && !ownerOf(t)
  );
}

export function ownersRequest(plan: Plan, schedule: Schedule, tasks: Task[]): AiRequest {
  return {
    purpose: "suggest owners",
    system: SYSTEM_PROMPT,
    schema: OWNERS_SCHEMA,
    prompt: [
      "Suggest an owner for each unassigned task. Consider skills, the scheduled load in the coming weeks and time off. Explain every choice in one sentence.",
      "",
      "Unassigned tasks:",
      ...tasks.map((t) => {
        const m = plan.milestoneById(t.milestoneId);
        return `- ${taskSummary(plan, t, schedule)}${m ? ` | milestone ${m.id}${m.target ? ` target ${m.target}` : ""}` : ""}`;
      }),
      "",
      `Team:\n${teamSummary(plan, schedule)}`,
    ].join("\n"),
  };
}

export function ownersProposal(plan: Plan, tasks: Task[], reply: unknown): Proposal {
  const o = asObject(reply, "assignments");
  const warnings: string[] = [];
  const notes: string[] = [];
  const byFile = new Map<string, FileEdit>();
  const wanted = new Map(tasks.map((t) => [taskKey(t), t]));
  for (const a of asArray(o.assignments)) {
    const id = asString(a.id);
    const t = wanted.get(id);
    const person = plan.personById(asString(a.owner));
    const reason = asString(a.reason);
    if (!t) {
      warnings.push(`Assignment for unknown or unrequested task "${id}" ignored.`);
      continue;
    }
    if (!person) {
      warnings.push(`${id}: unknown owner "${asString(a.owner)}" ignored.`);
      continue;
    }
    if (!reason) {
      warnings.push(`${id}: assignment to ${person.id} without an explanation ignored.`);
      continue;
    }
    wanted.delete(id);
    const file = plan.file(t.file)!;
    const fe = byFile.get(t.file) ?? { path: t.file, edits: [] };
    fe.edits.push(...setAttr(file.lines, t, "owner", person.id));
    byFile.set(t.file, fe);
    notes.push(`${id} ${t.title} → ${person.name}: ${reason}`);
  }
  for (const id of wanted.keys()) warnings.push(`${id}: no owner proposed.`);
  return { title: `Assign ${notes.length} owner(s)`, edits: [...byFile.values()], notes, warnings };
}

// ---------------------------------------------------------------------------------------------
// Plan from text

export function planFromTextRequest(plan: Plan, milestone: Milestone, text: string): AiRequest {
  return {
    purpose: "plan from text",
    system: SYSTEM_PROMPT,
    schema: PLAN_FROM_TEXT_SCHEMA,
    prompt: [
      `Turn the scope description below into a new section of milestone ${milestone.id} with concrete tasks (refs N1, N2 …), estimates, tags, dependencies and, where useful, subtasks (parent = ref of the parent task).`,
      "Do not repeat work that already exists in the milestone; you may depend on existing task ids.",
      "",
      "Scope description:",
      "<<<",
      text.trim(),
      ">>>",
      "",
      milestoneOutline(plan, milestone),
      "",
      `Team:\n${teamSummary(plan)}`,
      `Hours per day: ${plan.project.hoursPerDay}`,
      PROJECT_SKELETON,
    ].join("\n"),
  };
}

export function planFromTextProposal(plan: Plan, milestone: Milestone, reply: unknown): Proposal {
  const o = asObject(reply, "tasks");
  const warnings: string[] = [];
  const section = asString(o.section) || "Planned from text";
  const specs = readTaskSpecs(asArray(o.tasks));
  if (specs.length === 0) throw new Error("The AI proposed no tasks.");
  const { roots, all } = buildNewTasks(plan, specs, warnings);
  const file = plan.file(milestone.file)!;
  return {
    title: `Plan "${section}" into ${milestone.id}`,
    edits: [
      { path: file.path, edits: insertTasks(file, { kind: "section", title: section }, roots) },
    ],
    notes: [
      `New section "${section}" with ${all.length} task(s):`,
      ...all.map((n) => `+ ${describeNew(n.task)}`),
    ],
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Status summary and schedule review (text output, nothing is written to the plan)

export function statusSummaryRequest(
  plan: Plan,
  schedule: Schedule,
  baseline: Baseline | undefined,
  periodDays: number
): AiRequest {
  const d = buildDashboardModel(plan, schedule, baseline);
  const today = schedule.today;
  const periodStart = formatDate(today - periodDays + 1);
  const doneInPeriod = plan.tasks.filter(
    (t) => isLeaf(t) && t.status === "done" && t.done && t.done >= periodStart && t.done <= d.today
  );
  const lines = [
    `Write a 5–8 sentence status summary for the project manager of "${plan.project.name}" as of ${d.today}, from the metrics below only. Mention progress, the forecast against the targets, slips since the baseline, blocked items, tests and punch items. No headings, no bullet points.`,
    "",
    `Overall: ${Math.round(d.progress * 100)}% complete (hours-weighted); forecast finish ${d.forecastFinish ?? "unknown"}${d.end ? `, planned end ${d.end}` : ""}${d.endVariance !== undefined ? ` (${d.endVariance > 0 ? `${d.endVariance} working days late` : d.endVariance < 0 ? `${-d.endVariance} working days early` : "on time"})` : ""}; ${Math.round(d.remainingHours)} hours of work remaining.`,
    "Milestones:",
    ...d.milestones.map(
      (m) =>
        `- ${m.title}: ${Math.round(m.progress * 100)}% done, target ${m.target ?? "none"}, forecast ${m.forecast ?? "unknown"}${m.variance !== undefined ? ` (${m.variance > 0 ? `${m.variance} d late` : `${-m.variance} d ahead`})` : ""}${m.trend?.slip ? `, ${m.trend.slip > 0 ? "+" : ""}${m.trend.slip} d since baseline "${m.trend.baseline}"` : ""}`
    ),
    `Completed in the last ${periodDays} days: ${doneInPeriod.length} task(s)${
      doneInPeriod.length
        ? ` (${doneInPeriod
            .map((t) => t.title)
            .slice(0, 8)
            .join("; ")})`
        : ""
    }.`,
    `Blocked: ${d.lists.blocked.length ? d.lists.blocked.map((b) => `${b.title} (${b.detail})`).join("; ") : "none"}.`,
    `Overdue: ${d.lists.overdue.length}. Unassigned: ${d.lists.unassigned.length}. Unestimated: ${d.lists.unestimated.length}.`,
    `Tests: ${d.tests.map((t) => `${t.id} ${t.pass} pass / ${t.fail} fail / ${t.open} open`).join("; ") || "none"}.`,
    `Open punch items: ${d.punch.open} (A ${d.punch.bySeverity.A}, B ${d.punch.bySeverity.B}, C ${d.punch.bySeverity.C}).`,
  ];
  return {
    purpose: "status summary",
    system: SYSTEM_PROMPT,
    schema: SUMMARY_SCHEMA,
    prompt: lines.join("\n"),
    maxTokens: 4000,
  };
}

export function readSummary(reply: unknown): string {
  const s = asString(asObject(reply, "summary").summary);
  if (!s) throw new Error("The AI returned an empty summary.");
  return s;
}

export function scheduleReviewRequest(plan: Plan, schedule: Schedule, demand: Schedule): AiRequest {
  const d = buildDashboardModel(plan, schedule);
  const lists = attentionLists(plan, schedule);
  const res = buildResourcesModel(plan, demand, {
    from: schedule.today,
    to: schedule.today + 12 * 7,
  });
  const over = [...overloadedWeeks(res)].map(([p, w]) => `${p}: ${w.join(", ")}`);
  const critical = schedule.criticalPath.map((t) => {
    const ts = schedule.tasks.get(t)!;
    return `${taskKey(t)} ${t.title} ${formatDate(ts.start!)}..${formatDate(ts.finish!)} (${ownerOf(t) ?? "unassigned"})`;
  });
  const late = [...schedule.tasks.values()]
    .filter((ts) => ts.late && !ts.done)
    .map(
      (ts) =>
        `${ts.key} ${ts.task.title} finishes ${formatDate(ts.finish!)} after ${formatDate(ts.deadline!)}`
    );
  return {
    purpose: "schedule review",
    system: SYSTEM_PROMPT,
    schema: REVIEW_SCHEMA,
    prompt: [
      "Review this computed schedule and list the main risks: overloaded people, long critical chains, tasks without estimates or owners, milestones with little or no buffer, dependencies that look wrong. Be concrete; reference ids. Do not propose new dates.",
      "",
      "Milestones:",
      ...d.milestones.map(
        (m) =>
          `- ${m.id} ${m.title}: target ${m.target ?? "none"}, forecast ${m.forecast ?? "unknown"}, variance ${m.variance ?? "n/a"} working days, ${Math.round(m.progress * 100)}% done, ${m.remaining} h left`
      ),
      `Critical path:\n${critical.map((c) => `- ${c}`).join("\n") || "- none"}`,
      `Tasks finishing after their deadline:\n${late.map((l) => `- ${l}`).join("\n") || "- none"}`,
      `Over capacity if everything started as early as possible (person: ISO weeks):\n${over.map((o) => `- ${o}`).join("\n") || "- none"}`,
      `Unestimated open tasks: ${lists.unestimated.map((t) => taskKey(t)).join(", ") || "none"}`,
      `Unassigned open tasks: ${lists.unassigned.map((t) => taskKey(t)).join(", ") || "none"}`,
      `Blocked: ${lists.blocked.map((t) => `${taskKey(t)} (${t.blocked ?? "no reason"})`).join(", ") || "none"}`,
      `\nTeam:\n${teamSummary(plan, schedule)}`,
    ].join("\n"),
  };
}

export function reviewMarkdown(plan: Plan, reply: unknown, today: string, model: string): string {
  const risks = asArray(asObject(reply, "risks").risks);
  const order = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  risks.sort((a, b) => (order[asString(a.severity)] ?? 3) - (order[asString(b.severity)] ?? 3));
  const link = (id: string) => {
    const t = findTaskByKey(plan, id);
    return t ? `\`${id}\` ${t.title}` : `\`${id}\``;
  };
  const lines = [
    `# Schedule review – ${plan.project.name}`,
    "",
    `As of ${today}. Written by ${model} from the computed schedule; dates come from the planner.`,
    "",
  ];
  if (risks.length === 0) lines.push("No risks were identified.");
  for (const r of risks) {
    lines.push(
      `## ${asString(r.severity).toUpperCase() || "RISK"}: ${asString(r.title)}`,
      "",
      asString(r.detail),
      ""
    );
    const ids = asStrings(r.tasks);
    if (ids.length) lines.push(...ids.map((id) => `- ${link(id)}`), "");
  }
  return lines.join("\n");
}
