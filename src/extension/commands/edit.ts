// Create and edit plan items from the user interface: tasks, subtasks, sections, milestones, inbox
// and punch items. Each command shows a form (see ui/form.ts) and writes minimal, undoable edits.
// Every command also accepts its values as an argument, which skips the form (tests, automation).
import * as vscode from "vscode";
import { UNASSIGNED } from "../../core/calendar";
import { wouldCreateCycle } from "../../core/graph";
import {
  isOpen,
  STATUS_LABEL,
  type Milestone,
  type Section,
  type Status,
  type Task,
} from "../../core/model";
import { type Plan } from "../../core/resolve";
import { findTaskByKey } from "../../core/scheduler";
import { addPunchItem } from "../../core/testRun";
import { type InsertLocation, moveTask, nextId, statusDateAttrs } from "../../core/writer";
import {
  addTask,
  appendSectionTo,
  changeMilestone,
  changeTask,
  createMilestone,
  deleteMilestoneLinks,
  deleteTaskWithLinks,
  dependentsOf,
  type MilestoneChange,
  milestoneDependents,
  type NewMilestone,
  type NewTaskFields,
  nextMilestoneId,
  splitMilestoneTitle,
  type TaskChange,
  taskAndDescendants,
  captureInbox,
  type Creation,
} from "../../core/writer/entities";
import { type PlannerState } from "../state";
import { type PlanService } from "../planService";
import { type FormField, showForm } from "../ui/form";
import {
  askChoice,
  askDate,
  askDuration,
  askMilestones,
  askPerson,
  askPriority,
  askProgress,
  askStatus,
  askTasks,
  askText,
  askValues,
} from "../ui/inputs";
import { pickMilestoneLocation, type PlanIntoTarget } from "./inbox";
import { resolveTask, stringArg, type TaskArg, valuesArg } from "./args";

/** Where a new task goes, from a tree node, a Kanban column, a Gantt row or the editor. */
export interface AddTaskTarget {
  milestone?: string | Milestone;
  /** Section title, a Section, or "" for no section. */
  section?: string | Section;
  /** Initial status (Kanban column) and owner (owner lane or filter). */
  status?: Status;
  owner?: string;
  /** Gantt row key: `milestone:M2` or `section:M2:<line>`. */
  key?: string;
  kind?: string;
  /** Reveal the new task in the Milestones view (default true). */
  reveal?: boolean;
}

/** Values that skip the form. */
export interface TaskValues {
  title: string;
  status?: Status;
  owner?: string;
  est?: string;
  deps?: string[];
  start?: string;
  due?: string;
  prio?: string;
  tags?: string[];
  note?: string;
}

interface TaskForm {
  title: string;
  status: Status;
  owner: string;
  est: string;
  act: string;
  deps: string[];
  start: string;
  due: string;
  prio: string;
  progress: string;
  tags: string[];
  blocked: string;
  note: string;
}

export function registerEditCommands(state: PlannerState): vscode.Disposable[] {
  const service = state.service;
  const reg = vscode.commands.registerCommand;
  return [
    // Menus and toolbars pass tree nodes or view contexts where tests and other commands pass
    // values: only well-formed values skip the forms.
    reg("planner.addTask", (target?: unknown, values?: unknown) =>
      addTaskCommand(state, taskTarget(target), valuesArg(values, TASK_VALUES, ["title"]))
    ),
    reg("planner.addSubtask", (arg?: TaskArg, values?: unknown) =>
      addSubtaskCommand(state, arg, valuesArg(values, TASK_VALUES, ["title"]))
    ),
    reg("planner.editTask", (arg?: TaskArg, change?: unknown) =>
      editTaskCommand(state, arg, valuesArg(change, TASK_CHANGE))
    ),
    reg("planner.moveTask", (arg?: TaskArg, target?: unknown) =>
      moveTaskCommand(service, arg, valuesArg(target, ["milestone", "section"], ["milestone"]))
    ),
    reg("planner.deleteTask", (arg?: TaskArg, options?: unknown) =>
      deleteTaskCommand(service, arg, valuesArg(options, ["confirm"]))
    ),
    reg("planner.addSection", (arg?: unknown, title?: unknown) =>
      addSectionCommand(service, arg, stringArg(title))
    ),
    reg("planner.addMilestone", (values?: unknown) =>
      addMilestoneCommand(state, valuesArg(values, NEW_MILESTONE, ["id", "name"]))
    ),
    reg("planner.editMilestone", (arg?: unknown, change?: unknown) =>
      editMilestoneCommand(state, arg, valuesArg(change, MILESTONE_CHANGE))
    ),
    reg("planner.deleteMilestone", (arg?: unknown, options?: unknown) =>
      deleteMilestoneCommand(state, arg, valuesArg(options, ["confirm"]))
    ),
    reg("planner.captureInbox", (text?: unknown) => captureInboxCommand(service, stringArg(text))),
    reg("planner.addPunchItem", (target?: unknown, values?: unknown) =>
      addPunchItemCommand(state, punchTarget(target), valuesArg(values, PUNCH_VALUES, ["title"]))
    ),
  ];
}

const TASK_VALUES = [
  "title",
  "status",
  "owner",
  "est",
  "deps",
  "start",
  "due",
  "prio",
  "tags",
  "note",
];
const TASK_CHANGE = ["title", "status", "blockedReason", "attrs", "addTags", "removeTags"];
const NEW_MILESTONE = ["id", "name", "target", "status", "depends"];
const MILESTONE_CHANGE = ["name", "target", "status", "depends"];
const PUNCH_VALUES = ["title", "sev", "owner", "due", "from", "tags", "status"];
const ADD_TARGET = ["milestone", "section", "status", "owner", "key", "kind", "reveal"];

/**
 * Where a new task goes, from the argument of planner.addTask: a target object, a Milestones tree
 * node (milestone, section, placeholder, or a task: next to it), a Team node (its owner), or a Gantt
 * row's context menu (`{ webviewSection, key }`).
 */
function taskTarget(arg: unknown): AddTaskTarget | undefined {
  const target = valuesArg<AddTaskTarget>(arg, ADD_TARGET);
  if (target) return target;
  if (!arg || typeof arg !== "object") return undefined;
  const node = arg as {
    kind?: string;
    milestone?: Milestone;
    section?: Section;
    task?: Task;
    id?: string;
    webviewSection?: string;
    key?: string;
  };
  if (node.webviewSection && typeof node.key === "string") return { key: node.key };
  switch (node.kind) {
    case "milestone":
      return node.milestone ? { milestone: node.milestone.id } : undefined;
    case "section":
    case "add":
      return node.milestone
        ? { milestone: node.milestone.id, section: node.section?.title ?? "" }
        : undefined;
    case "task":
      return node.task?.kind === "task"
        ? { milestone: node.task.milestoneId, section: node.task.section ?? "" }
        : undefined;
    case "person":
      return node.id && node.id !== UNASSIGNED ? { owner: node.id } : undefined;
  }
  return undefined;
}

/** Defaults for a new punch item: a target object, or a Punch List group (severity, owner). */
function punchTarget(arg: unknown): { status?: Status; owner?: string; sev?: string } | undefined {
  const target = valuesArg<{ status?: Status; owner?: string; sev?: string }>(arg, [
    "status",
    "owner",
    "sev",
  ]);
  if (target) return target;
  const node = arg as { kind?: string; sev?: string; owner?: string } | undefined;
  if (node?.kind === "severity" || node?.kind === "owner")
    return {
      sev: node.sev || undefined,
      owner: node.owner && node.owner !== UNASSIGNED ? node.owner : undefined,
    };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers

/** The milestone an argument refers to (tree node, id, Gantt key), else the active editor's. */
export function resolveMilestone(service: PlanService, arg: unknown): Milestone | undefined {
  const plan = service.plan;
  if (typeof arg === "string") return plan.milestoneById(arg);
  if (arg && typeof arg === "object") {
    const a = arg as { milestone?: string | Milestone; key?: string; id?: string };
    if (a.milestone)
      return plan.milestoneById(typeof a.milestone === "string" ? a.milestone : a.milestone.id);
    if (typeof a.key === "string") {
      const m = /^(?:milestone|section):([^:]+)/.exec(a.key);
      if (m) return plan.milestoneById(m[1]);
    }
    if (typeof a.id === "string" && plan.milestoneById(a.id)) return plan.milestoneById(a.id);
  }
  const editor = vscode.window.activeTextEditor;
  const rel = editor ? service.relPath(editor.document.uri) : undefined;
  return rel ? plan.milestones.find((m) => m.file === rel) : undefined;
}

/** Section title from a target (Section, title, or Gantt key `section:M2:<line>`). */
function sectionOf(m: Milestone, target: AddTaskTarget | undefined): string | undefined {
  if (!target) return undefined;
  if (typeof target.section === "string") return target.section;
  if (target.section) return target.section.title;
  const k = target.key ? /^section:[^:]+:(\d+|root)$/.exec(target.key) : null;
  if (k) return k[1] === "root" ? "" : m.sections.find((s) => s.line === Number(k[1]))?.title;
  return undefined;
}

/** Applies edits and new files as one step (new files first). */
async function applyCreation(service: PlanService, creation: Creation): Promise<boolean> {
  if (creation.create && !(await service.createFiles([creation.create]))) return false;
  if (creation.edits && !(await service.apply(creation.edits, { source: "view" }))) return false;
  service.fireNow();
  return true;
}

function message(text: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${text}`, 5000);
}

function rawAttr(t: Task, key: string): string {
  return t.attrs.find((a) => a.key === key)?.value ?? "";
}

function locationLabel(m: Milestone, section: string | undefined, parent?: Task): string {
  if (parent) return `${parent.id ?? ""} ${parent.title}`.trim();
  return section ? `${m.id} › ${section}` : m.title;
}

/** The fields of the task form; `self` is the task being edited (none when creating). */
function taskFields(
  state: PlannerState,
  self: Task | undefined,
  original?: TaskForm
): Array<FormField<TaskForm>> {
  const plan = state.plan;
  const today = state.today;
  const hpd = plan.project.hoursPerDay;
  const changed = (k: keyof TaskForm) => (s: TaskForm) =>
    original !== undefined && JSON.stringify(s[k]) !== JSON.stringify(original[k]);
  const milestone = self ? plan.milestoneById(self.milestoneId) : undefined;
  const block = self ? new Set(taskAndDescendants(self)) : new Set<Task>();
  const graph = state.schedule.graph;
  const inherited = self?.parent ? ownerName(plan, inheritedOwner(self.parent)) : undefined;
  const fields: Array<FormField<TaskForm>> = [
    {
      icon: "edit",
      label: "Title",
      value: (s) => s.title,
      changed: changed("title"),
      edit: async (s) => {
        const v = await askText({ title: "Title", value: s.title, required: true });
        if (v) s.title = v;
      },
    },
    {
      icon: "circle-large-outline",
      label: "Status",
      value: (s) => STATUS_LABEL[s.status],
      changed: changed("status"),
      edit: async (s) => {
        const v = await askStatus("Status", s.status);
        if (!v) return;
        s.status = v;
        if (v === "blocked" && self?.kind !== "step") {
          const reason = await askText({
            title: "Why is it blocked? (optional)",
            value: s.blocked,
            placeHolder: "e.g. waiting for the customer's API keys",
          });
          if (reason !== undefined) s.blocked = reason;
        }
      },
    },
    {
      icon: "circle-slash",
      label: "Blocked reason",
      value: (s) => s.blocked,
      visible: (s) => s.status === "blocked",
      changed: changed("blocked"),
      edit: async (s) => {
        const v = await askText({ title: "Why is it blocked?", value: s.blocked });
        if (v !== undefined) s.blocked = v;
      },
    },
    {
      icon: "person",
      label: "Owner",
      value: (s) =>
        s.owner
          ? ownerName(plan, s.owner)
          : inherited
            ? `${inherited} (from the parent task)`
            : undefined,
      changed: changed("owner"),
      edit: async (s) => {
        const v = await askPerson(
          plan,
          "Owner",
          s.owner,
          inherited ? `No owner (use ${inherited}, from the parent)` : "No owner"
        );
        if (v !== undefined) s.owner = v;
      },
    },
    {
      icon: "watch",
      label: "Estimate",
      value: (s) => s.est,
      detail: self?.children.length ? "Leave empty to use the sum of the subtasks" : undefined,
      changed: changed("est"),
      edit: async (s) => {
        const v = await askDuration("Estimate", s.est, hpd);
        if (v !== undefined) s.est = v;
      },
    },
    {
      icon: "history",
      label: "Actual hours",
      value: (s) => s.act,
      visible: () => self !== undefined,
      changed: changed("act"),
      edit: async (s) => {
        const v = await askDuration("Actual hours spent", s.act, hpd);
        if (v !== undefined) s.act = v;
      },
    },
    {
      icon: "references",
      label: "Depends on",
      value: (s) => (s.deps.length ? s.deps.join(", ") : undefined),
      changed: changed("deps"),
      edit: async (s) => {
        const v = await askTasks(plan, "Depends on – tasks that must finish first", s.deps, (t) =>
          self ? !block.has(t) && !wouldCreateCycle(graph, t, self) : true
        );
        if (v !== undefined) s.deps = v;
      },
    },
    {
      icon: "debug-start",
      label: "Fixed start",
      value: (s) => s.start,
      detail: "Not before this date",
      changed: changed("start"),
      edit: async (s) => {
        const v = await askDate("Fixed start – not before", s.start, today);
        if (v !== undefined) s.start = v;
      },
    },
    {
      icon: "calendar",
      label: "Due date",
      value: (s) => s.due,
      changed: changed("due"),
      edit: async (s) => {
        const extra = milestone?.target
          ? [{ label: "milestone target", date: milestone.target }]
          : [];
        const v = await askDate("Due date", s.due, today, extra);
        if (v !== undefined) s.due = v;
      },
    },
    {
      icon: "arrow-up",
      label: "Priority",
      value: (s) => (s.prio === "med" ? "medium" : s.prio),
      changed: changed("prio"),
      edit: async (s) => {
        const v = await askPriority("Priority", s.prio);
        if (v !== undefined) s.prio = v;
      },
    },
    {
      icon: "pie-chart",
      label: "Progress",
      value: (s) => s.progress,
      visible: () => self !== undefined,
      changed: changed("progress"),
      edit: async (s) => {
        const v = await askProgress("Progress", s.progress);
        if (v !== undefined) s.progress = v;
      },
    },
    {
      icon: "tag",
      label: "Tags",
      value: (s) => (s.tags.length ? s.tags.map((t) => `#${t}`).join(" ") : undefined),
      changed: changed("tags"),
      edit: async (s) => {
        const v = await askValues("Tags", plan.tags, s.tags, { prefix: "#", noun: "tag" });
        if (v !== undefined) s.tags = v;
      },
    },
  ];
  if (!self)
    fields.push({
      icon: "note",
      label: "Note",
      value: (s) => s.note,
      detail: "A line of description under the task",
      edit: async (s) => {
        const v = await askText({ title: "Note (optional)", value: s.note });
        if (v !== undefined) s.note = v;
      },
    });
  return fields;
}

function inheritedOwner(t: Task | undefined): string | undefined {
  for (let p = t; p; p = p.parent) if (p.owner) return p.owner;
  return undefined;
}

function ownerName(plan: Plan, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return plan.personById(id)?.name ?? id;
}

function newTaskFields(s: TaskForm, today: string): NewTaskFields {
  const dates = Object.fromEntries(statusDateAttrs(s.status, today));
  return {
    title: s.title,
    status: s.status,
    attrs: {
      est: s.est,
      owner: s.owner,
      dep: s.deps.join(","),
      start: s.start,
      due: s.due,
      prio: s.prio,
      ...dates,
      blocked: s.status === "blocked" && s.blocked ? s.blocked : undefined,
    },
    tags: s.tags,
    notes: s.note ? [s.note] : undefined,
  };
}

function formFromValues(v: TaskValues | undefined, target: AddTaskTarget | undefined): TaskForm {
  return {
    title: v?.title ?? "",
    status: v?.status ?? target?.status ?? "todo",
    owner: v?.owner ?? target?.owner ?? "",
    est: v?.est ?? "",
    act: "",
    deps: v?.deps ?? [],
    start: v?.start ?? "",
    due: v?.due ?? "",
    prio: v?.prio ?? "med",
    progress: "",
    tags: v?.tags ?? [],
    blocked: "",
    note: v?.note ?? "",
  };
}

// ---------------------------------------------------------------------------------------------
// Add task / subtask

async function chooseLocation(
  service: PlanService,
  target: AddTaskTarget | undefined
): Promise<{ milestone: Milestone; section: string | undefined } | undefined> {
  const plan = service.plan;
  const m = target?.milestone || target?.key ? resolveMilestone(service, target) : undefined;
  if (m) {
    const section = sectionOf(m, target);
    if (section !== undefined) return { milestone: m, section: section || undefined };
    if (m.sections.length === 0) return { milestone: m, section: undefined };
    const pick = await pickSection(m, "Add task – which section?");
    return pick === undefined ? undefined : { milestone: m, section: pick || undefined };
  }
  const fromEditor = resolveMilestone(service, undefined);
  if (fromEditor && !target?.status) {
    const pick = fromEditor.sections.length
      ? await pickSection(fromEditor, "Add task – which section?")
      : "";
    return pick === undefined ? undefined : { milestone: fromEditor, section: pick || undefined };
  }
  if (plan.milestones.length === 0) {
    const create = await vscode.window.showInformationMessage(
      "Planner: there are no milestones yet. Add one first.",
      "Add milestone…"
    );
    if (create) await vscode.commands.executeCommand("planner.addMilestone");
    return undefined;
  }
  const loc = await pickMilestoneLocation(service, "Add task – to which milestone?");
  if (!loc) return undefined;
  const milestone = plan.milestoneById(loc.milestone);
  return milestone ? { milestone, section: loc.section } : undefined;
}

/** Existing section, no section, or a new one; "" = no section, undefined = cancelled. */
async function pickSection(m: Milestone, title: string): Promise<string | undefined> {
  const pick = await askChoice(
    title,
    [
      ...m.sections.map((s) => ({ label: `$(list-tree) ${s.title}`, value: s.title })),
      { label: "$(list-flat) No section", value: "", description: "directly under the milestone" },
      { label: "$(add) New section…", value: "\u0000new" },
    ],
    undefined,
    m.title
  );
  if (!pick) return undefined;
  if (pick.value !== "\u0000new") return pick.value;
  return askText({
    title: "New section title",
    placeHolder: "e.g. Unit 400 – Packaging",
    required: true,
  });
}

export async function addTaskCommand(
  state: PlannerState,
  target?: AddTaskTarget,
  values?: TaskValues
): Promise<string | undefined> {
  const service = state.service;
  const where = await chooseLocation(service, target);
  if (!where) return undefined;
  const location: InsertLocation = where.section
    ? { kind: "section", title: where.section }
    : { kind: "root" };
  return createTasks(
    state,
    where.milestone,
    location,
    locationLabel(where.milestone, where.section),
    target,
    values
  );
}

export async function addSubtaskCommand(
  state: PlannerState,
  arg?: TaskArg,
  values?: TaskValues
): Promise<string | undefined> {
  const r = resolveTask(state.service, arg);
  if (!r || r.task.kind !== "task") {
    void vscode.window.showWarningMessage("Planner: select a task to add a subtask to.");
    return undefined;
  }
  const m = state.plan.milestoneById(r.task.milestoneId);
  if (!m) return undefined;
  return createTasks(
    state,
    m,
    { kind: "child", task: r.task },
    `subtask of ${locationLabel(m, undefined, r.task)}`,
    undefined,
    values
  );
}

/** Shows the task form (repeatedly with "Create and add another") and inserts the tasks. */
async function createTasks(
  state: PlannerState,
  milestone: Milestone,
  location: InsertLocation,
  where: string,
  target: AddTaskTarget | undefined,
  values: TaskValues | undefined
): Promise<string | undefined> {
  const service = state.service;
  let lastId: string | undefined;
  for (;;) {
    const form = formFromValues(values, target);
    let another = false;
    if (!values) {
      const title = await askText({
        title: `Add task – ${where}`,
        prompt: "Press Enter to continue to the details (owner, estimate, dependencies …)",
        placeHolder: "What needs to be done?",
        required: true,
      });
      if (!title) return lastId;
      form.title = title;
      const fields = taskFields(state, undefined).filter(
        (f) => f.label !== "Status" || target?.status
      );
      const action = await showForm({
        title: `Add task – ${where}`,
        state: form,
        actions: [
          { id: "create", icon: "check", label: "Create task", description: "Enter" },
          { id: "another", icon: "add", label: "Create and add another" },
        ],
        fields,
        placeholder: "Press Enter to create the task, or choose a field to fill in first",
      });
      if (!action) return lastId;
      another = action === "another";
    }
    const plan = service.plan;
    const file = plan.file(milestone.file);
    if (!file) return lastId;
    // A subtask's parent may have moved since the form opened: find it again by key.
    const loc =
      location.kind === "child" || location.kind === "after"
        ? (() => {
            const t = location.task.id
              ? plan.taskById(location.task.id)
              : findTaskByKey(plan, `${location.task.file}#${location.task.line + 1}`);
            return t ? { ...location, task: t } : location;
          })()
        : location;
    const id = nextId(plan, "T");
    const ok = await applyCreation(service, {
      edits: [addTask(file, loc, newTaskFields(form, state.today), id)],
    });
    if (!ok) return lastId;
    lastId = id;
    message(`Added ${id} · ${form.title}`);
    if (target?.reveal !== false)
      await vscode.commands
        .executeCommand("planner.revealInTree", { task: id })
        .then(undefined, () => undefined);
    if (!another) return id;
  }
}

// ---------------------------------------------------------------------------------------------
// Edit task

function formFromTask(t: Task): TaskForm {
  return {
    title: t.title,
    status: t.status,
    owner: t.owner ?? "",
    est: rawAttr(t, "est"),
    act: rawAttr(t, "act"),
    deps: t.deps.map((d) => d.raw),
    start: rawAttr(t, "start"),
    due: rawAttr(t, "due"),
    prio: t.prio,
    progress: rawAttr(t, "progress"),
    tags: t.tags.map((x) => x.tag),
    blocked: t.blocked ?? "",
    note: "",
  };
}

/** The TaskChange between the original form and the edited one. */
function diffTask(a: TaskForm, b: TaskForm): TaskChange {
  const change: TaskChange = { attrs: {} };
  if (a.title !== b.title) change.title = b.title;
  if (a.status !== b.status) change.status = b.status;
  if (b.status === "blocked" && (a.blocked !== b.blocked || a.status !== b.status))
    change.blockedReason = b.blocked;
  const attr = (key: string, x: string, y: string) => {
    if (x !== y) change.attrs![key] = y || undefined;
  };
  attr("est", a.est, b.est);
  attr("act", a.act, b.act);
  attr("owner", a.owner, b.owner);
  attr("dep", a.deps.join(","), b.deps.join(","));
  attr("start", a.start, b.start);
  attr("due", a.due, b.due);
  attr("prio", a.prio, b.prio === "med" ? "" : b.prio);
  attr("progress", a.progress, b.progress);
  change.removeTags = a.tags.filter((t) => !b.tags.includes(t));
  change.addTags = b.tags.filter((t) => !a.tags.includes(t));
  return change;
}

export async function editTaskCommand(
  state: PlannerState,
  arg?: TaskArg,
  change?: TaskChange
): Promise<boolean> {
  const service = state.service;
  const r = resolveTask(service, arg);
  if (!r || (r.task.kind !== "task" && r.task.kind !== "punch")) {
    void vscode.window.showWarningMessage("Planner: select a task to edit.");
    return false;
  }
  const t = r.task;
  if (t.kind === "punch") return editPunchItem(state, t, change);
  let edit = change;
  if (!edit) {
    const original = formFromTask(t);
    const form: TaskForm = { ...original, deps: [...original.deps], tags: [...original.tags] };
    const action = await showForm({
      title: `Edit ${t.id ?? "task"} · ${t.title}`,
      state: form,
      actions: [{ id: "save", icon: "check", label: "Save changes", description: "Enter" }],
      fields: taskFields(state, t, original),
      more: [
        { id: "subtask", icon: "add", label: "Add subtask…" },
        { id: "move", icon: "arrow-swap", label: "Move to another milestone or section…" },
        {
          id: "open",
          icon: "go-to-file",
          label: "Open in editor",
          description: "notes and free text",
        },
        { id: "delete", icon: "trash", label: "Delete task…" },
      ],
      placeholder: "Choose a field to change; ● marks changed fields; Enter saves",
    });
    if (!action) return false;
    if (action === "subtask")
      return !!(await addSubtaskCommand(state, t.id ?? { file: t.file, line: t.line }));
    if (action === "move")
      return !!(await moveTaskCommand(service, t.id ?? { file: t.file, line: t.line }));
    if (action === "delete")
      return deleteTaskCommand(service, t.id ?? { file: t.file, line: t.line });
    if (action === "open") {
      await vscode.commands.executeCommand(
        "planner.revealTask",
        t.id ?? { file: t.file, line: t.line }
      );
      return false;
    }
    edit = diffTask(original, form);
  }
  const current = resolveTask(service, t.id ?? { file: t.file, line: t.line })?.task ?? t;
  const file = service.plan.file(current.file);
  if (!file) return false;
  const edits = changeTask(file.lines, current, edit, state.today);
  if (edits.length === 0) return false;
  const ok = await service.apply([{ path: current.file, edits }], {
    source: r.fromEditor ? "editor" : "view",
  });
  if (ok) message(`Saved ${current.id ?? current.title}`);
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Move / delete

export async function moveTaskCommand(
  service: PlanService,
  arg?: TaskArg,
  target?: PlanIntoTarget
): Promise<string | undefined> {
  const r = resolveTask(service, arg);
  if (!r || r.task.kind !== "task") {
    void vscode.window.showWarningMessage("Planner: select a task to move.");
    return undefined;
  }
  const t = r.task;
  const chosen = target ?? (await pickMilestoneLocation(service, `Move ${t.id ?? t.title} to…`));
  if (!chosen) return undefined;
  const plan = service.plan;
  const m = plan.milestoneById(chosen.milestone);
  const source = plan.file(t.file);
  const dest = m ? plan.file(m.file) : undefined;
  if (!m || !source || !dest) return undefined;
  const location: InsertLocation = chosen.section
    ? { kind: "section", title: chosen.section }
    : { kind: "root" };
  const ok = await service.apply(moveTask(source, t, dest, location), { source: "view" });
  if (!ok) return undefined;
  service.fireNow();
  message(`Moved ${t.id ?? t.title} to ${locationLabel(m, chosen.section)}`);
  if (t.id)
    await vscode.commands
      .executeCommand("planner.revealInTree", { task: t.id })
      .then(undefined, () => undefined);
  return t.id;
}

export async function deleteTaskCommand(
  service: PlanService,
  arg?: TaskArg,
  options?: { confirm?: boolean }
): Promise<boolean> {
  const r = resolveTask(service, arg);
  if (!r || (r.task.kind !== "task" && r.task.kind !== "punch" && r.task.kind !== "inbox")) {
    void vscode.window.showWarningMessage("Planner: select a task to delete.");
    return false;
  }
  const t = r.task;
  const plan = service.plan;
  if (options?.confirm !== false) {
    const subtasks = taskAndDescendants(t).length - 1;
    const dependents = dependentsOf(plan, t);
    const notes = t.endLine > (t.children.length ? t.children[0].line - 1 : t.line);
    const detail = [
      subtasks
        ? `Its ${subtasks} subtask${subtasks === 1 ? " is" : "s are"} deleted too.`
        : notes
          ? "Its notes are deleted too."
          : "",
      dependents.length
        ? `${dependents.length} task${dependents.length === 1 ? " depends" : "s depend"} on it (${dependents.map((d) => d.id).join(", ")}); ${dependents.length === 1 ? "that dependency is" : "those dependencies are"} removed.`
        : "",
      "You can undo this with Edit → Undo in the file.",
    ]
      .filter(Boolean)
      .join("\n");
    const pick = await vscode.window.showWarningMessage(
      `Delete ${t.id ?? ""} "${t.title}"?`.replace("  ", " "),
      { modal: true, detail },
      "Delete"
    );
    if (pick !== "Delete") return false;
  }
  const ok = await service.apply(deleteTaskWithLinks(plan, t), { source: "view" });
  if (ok) {
    service.fireNow();
    message(`Deleted ${t.id ?? t.title}`);
  }
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Sections and milestones

export async function addSectionCommand(
  service: PlanService,
  arg?: unknown,
  title?: string
): Promise<string | undefined> {
  const m =
    resolveMilestone(service, arg) ??
    (await pickMilestone(service, "Add section – to which milestone?"));
  if (!m) return undefined;
  const name =
    title ??
    (await askText({
      title: `Add section to ${m.title}`,
      prompt: "Sections group the tasks of a milestone, for example per unit or area.",
      placeHolder: "e.g. Unit 400 – Packaging",
      required: true,
      validate: (v) =>
        m.sections.some((s) => s.title.toLowerCase() === v.toLowerCase())
          ? "This section already exists"
          : undefined,
    }));
  if (!name) return undefined;
  const file = service.plan.file(m.file);
  if (!file) return undefined;
  const ok = await service.apply([appendSectionTo(file, name)], { source: "view" });
  if (!ok) return undefined;
  service.fireNow();
  message(`Added section ${name} to ${m.id} – add its first task from the Milestones view`);
  await vscode.commands
    .executeCommand("planner.revealInTree", { milestone: m.id })
    .then(undefined, () => undefined);
  return name;
}

async function pickMilestone(service: PlanService, title: string): Promise<Milestone | undefined> {
  const plan = service.plan;
  const pick = await askChoice(
    title,
    plan.milestones.map((m) => ({
      label: m.title,
      value: m.id,
      description: m.target ? `target ${m.target}` : undefined,
    })),
    undefined
  );
  return pick ? plan.milestoneById(pick.value) : undefined;
}

interface MilestoneForm {
  id: string;
  name: string;
  target: string;
  status: string;
  depends: string[];
}

function milestoneFields(
  state: PlannerState,
  creating: boolean,
  original?: MilestoneForm
): Array<FormField<MilestoneForm>> {
  const plan = state.plan;
  const changed = (k: keyof MilestoneForm) => (s: MilestoneForm) =>
    original !== undefined && JSON.stringify(s[k]) !== JSON.stringify(original[k]);
  return [
    {
      icon: "edit",
      label: "Name",
      value: (s) => s.name,
      changed: changed("name"),
      edit: async (s) => {
        const v = await askText({ title: "Milestone name", value: s.name, required: true });
        if (v) s.name = v;
      },
    },
    {
      icon: "symbol-number",
      label: "Id",
      value: (s) => s.id,
      visible: () => creating,
      detail: "Used in other milestones' depends and in test plans",
      edit: async (s) => {
        const v = await askText({
          title: "Milestone id",
          value: s.id,
          required: true,
          validate: (x) =>
            !/^[A-Za-z][\w-]*$/.test(x)
              ? "Letters, digits and dashes, e.g. M6"
              : plan.milestoneById(x)
                ? "This id is already in use"
                : undefined,
        });
        if (v) s.id = v;
      },
    },
    {
      icon: "milestone",
      label: "Target date",
      value: (s) => s.target,
      changed: changed("target"),
      edit: async (s) => {
        const extra = plan.project.end ? [{ label: "project end", date: plan.project.end }] : [];
        const v = await askDate("Target date", s.target, state.today, extra);
        if (v !== undefined) s.target = v;
      },
    },
    {
      icon: "pulse",
      label: "Status",
      value: (s) => s.status,
      changed: changed("status"),
      edit: async (s) => {
        const v = await askChoice(
          "Milestone status",
          [
            { label: "planned", value: "planned" },
            { label: "active", value: "active", description: "work is going on" },
            { label: "done", value: "done" },
            { label: "cancelled", value: "cancelled", description: "its tasks are cancelled too" },
          ],
          s.status
        );
        if (v) s.status = v.value;
      },
    },
    {
      icon: "references",
      label: "Depends on",
      value: (s) => (s.depends.length ? s.depends.join(", ") : undefined),
      detail: "Its tasks start after these milestones are finished",
      changed: changed("depends"),
      edit: async (s) => {
        const v = await askMilestones(
          plan,
          "Depends on – milestones that must finish first",
          s.depends,
          s.id
        );
        if (v !== undefined) s.depends = v;
      },
    },
  ];
}

export async function addMilestoneCommand(
  state: PlannerState,
  values?: NewMilestone
): Promise<string | undefined> {
  const service = state.service;
  if (!service.root) {
    void vscode.window.showWarningMessage(
      "Planner: create a project first (Planner: New project…)."
    );
    return undefined;
  }
  let m = values;
  if (!m) {
    const name = await askText({
      title: "Add milestone",
      prompt: "Press Enter to continue to the target date, status and dependencies",
      placeHolder: "Name, e.g. Documentation",
      required: true,
    });
    if (!name) return undefined;
    const form: MilestoneForm = {
      id: nextMilestoneId(state.plan),
      name,
      target: "",
      status: "planned",
      depends: [],
    };
    const action = await showForm({
      title: `Add milestone ${form.id} – ${name}`,
      state: form,
      actions: [{ id: "create", icon: "check", label: "Create milestone", description: "Enter" }],
      fields: milestoneFields(state, true),
      placeholder: "Press Enter to create the milestone, or choose a field first",
    });
    if (!action) return undefined;
    m = {
      id: form.id,
      name: form.name,
      target: form.target || undefined,
      status: form.status as NewMilestone["status"],
      depends: form.depends,
    };
  }
  let creation;
  try {
    creation = createMilestone(service.plan, m);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Planner: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
  if (!(await applyCreation(service, { create: creation }))) return undefined;
  message(`Added milestone ${m.id} – add its first task from the Milestones view`);
  await vscode.commands
    .executeCommand("planner.revealInTree", { milestone: m.id })
    .then(undefined, () => undefined);
  return m.id;
}

export async function editMilestoneCommand(
  state: PlannerState,
  arg?: unknown,
  change?: MilestoneChange
): Promise<boolean> {
  const service = state.service;
  const m =
    resolveMilestone(service, arg) ?? (await pickMilestone(service, "Edit which milestone?"));
  if (!m) return false;
  let edit = change;
  if (!edit) {
    const original: MilestoneForm = {
      id: m.id,
      name: splitMilestoneTitle(m.id, m.title).name,
      target: m.target ?? "",
      status: m.status,
      depends: [...m.depends],
    };
    const form: MilestoneForm = { ...original, depends: [...original.depends] };
    const action = await showForm({
      title: `Edit ${m.title}`,
      state: form,
      actions: [{ id: "save", icon: "check", label: "Save changes", description: "Enter" }],
      fields: milestoneFields(state, false, original),
      more: [
        { id: "task", icon: "add", label: "Add task…" },
        { id: "section", icon: "list-tree", label: "Add section…" },
        {
          id: "open",
          icon: "go-to-file",
          label: "Open milestone file",
          description: "description and notes",
        },
        { id: "delete", icon: "trash", label: "Delete milestone…" },
      ],
    });
    if (!action) return false;
    if (action === "delete") return deleteMilestoneCommand(state, m.id);
    if (action === "task") return !!(await addTaskCommand(state, { milestone: m.id }));
    if (action === "section") return !!(await addSectionCommand(service, m.id));
    if (action === "open") {
      await vscode.commands.executeCommand("planner.revealMilestone", m.id);
      return false;
    }
    edit = {
      name: form.name !== original.name ? form.name : undefined,
      target: form.target !== original.target ? form.target : undefined,
      status: form.status !== original.status ? form.status : undefined,
      depends: form.depends.join(",") !== original.depends.join(",") ? form.depends : undefined,
    };
  }
  const file = service.plan.file(m.file);
  const fresh = service.plan.milestoneById(m.id);
  if (!file || !fresh) return false;
  const edits = changeMilestone(file.lines, fresh, edit);
  if (edits.length === 0) return false;
  const ok = await service.apply([{ path: file.path, edits }], { source: "view" });
  if (ok) message(`Saved ${m.id}`);
  return ok;
}

/**
 * Deletes a milestone file and every dependency on it or its tasks, after a confirmation that says
 * what goes; with open tasks it offers to cancel the milestone instead (keeps the work on record).
 */
export async function deleteMilestoneCommand(
  state: PlannerState,
  arg?: unknown,
  options?: { confirm?: boolean }
): Promise<boolean> {
  const service = state.service;
  const m =
    resolveMilestone(service, arg) ?? (await pickMilestone(service, "Delete which milestone?"));
  if (!m) return false;
  const plan = service.plan;
  if (options?.confirm !== false) {
    const tasks = plan.tasks.filter((t) => t.milestoneId === m.id);
    const open = tasks.filter((t) => isOpen(t.status)).length;
    const dependents = milestoneDependents(plan, m);
    const tests = plan.tests.filter((tp) => tp.milestone?.toLowerCase() === m.id.toLowerCase());
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const ids = (items: Array<{ id?: string; title: string }>) =>
      items.map((x) => x.id ?? x.title).join(", ");
    const detail = [
      tasks.length
        ? `${m.file} is deleted with its ${n(tasks.length, "task")}${open ? ` (${open} open)` : ""}.`
        : `${m.file} is deleted.`,
      dependents.tasks.length
        ? `${n(dependents.tasks.length, "task")} of other milestones depend on its tasks (${ids(dependents.tasks)}); those dependencies are removed.`
        : "",
      dependents.milestones.length
        ? `${ids(dependents.milestones)} ${dependents.milestones.length === 1 ? "depends" : "depend"} on it; ${m.id} is removed from their depends.`
        : "",
      tests.length
        ? `${ids(tests)} keep${tests.length === 1 ? "s" : ""} "milestone: ${m.id}".`
        : "",
      open ? "To keep the work on record instead, set the milestone to cancelled." : "",
      "The message afterwards has an Undo button.",
    ]
      .filter(Boolean)
      .join("\n");
    const pick = await vscode.window.showWarningMessage(
      `Delete milestone ${m.title}?`,
      { modal: true, detail },
      ...(open ? ["Delete", "Set to cancelled"] : ["Delete"])
    );
    if (pick === "Set to cancelled")
      return editMilestoneCommand(state, m.id, { status: "cancelled" });
    if (pick !== "Delete") return false;
  }
  const revert = await service.applyRevertible(deleteMilestoneLinks(plan, m), {
    source: "view",
    deleteFiles: [m.file],
  });
  if (!revert) return false;
  service.fireNow();
  offerUndo(service, `Deleted milestone ${m.title}.`, revert);
  return true;
}

/** A message with an Undo button that runs `revert` (not awaited: the command returns at once). */
export function offerUndo(
  service: PlanService,
  text: string,
  revert: () => Promise<boolean>
): void {
  void vscode.window.showInformationMessage(`Planner: ${text}`, "Undo").then(async (pick) => {
    if (pick === "Undo" && (await revert())) service.fireNow();
  });
}

// ---------------------------------------------------------------------------------------------
// Inbox and punch items

export async function captureInboxCommand(service: PlanService, text?: string): Promise<boolean> {
  if (!service.root) return false;
  const value =
    text ??
    (await askText({
      title: "Capture to inbox",
      prompt: "Write it down now, plan it later with Plan into milestone…",
      placeHolder: "Idea, request or reminder – #tags allowed",
      required: true,
    }));
  if (!value) return false;
  const ok = await applyCreation(service, captureInbox(service.plan, value));
  if (ok) message("Added to the inbox");
  return ok;
}

export interface PunchValues {
  title: string;
  sev?: "A" | "B" | "C";
  owner?: string;
  due?: string;
  from?: string;
  tags?: string[];
  status?: Status;
}

interface PunchForm {
  title: string;
  sev: string;
  owner: string;
  due: string;
  from: string;
  tags: string[];
  status: Status;
}

function punchFields(
  state: PlannerState,
  editing: boolean,
  original?: PunchForm
): Array<FormField<PunchForm>> {
  const plan = state.plan;
  const changed = (k: keyof PunchForm) => (s: PunchForm) =>
    original !== undefined && JSON.stringify(s[k]) !== JSON.stringify(original[k]);
  return [
    {
      icon: "edit",
      label: "Title",
      value: (s) => s.title,
      changed: changed("title"),
      edit: async (s) => {
        const v = await askText({ title: "Title", value: s.title, required: true });
        if (v) s.title = v;
      },
    },
    {
      icon: "circle-large-outline",
      label: "Status",
      value: (s) => STATUS_LABEL[s.status],
      visible: () => editing,
      changed: changed("status"),
      edit: async (s) => {
        const v = await askStatus("Status", s.status);
        if (v) s.status = v;
      },
    },
    {
      icon: "bug",
      label: "Severity",
      value: (s) => (s.sev ? `${s.sev} – ${SEVERITY[s.sev]}` : undefined),
      changed: changed("sev"),
      edit: async (s) => {
        const v = await askChoice(
          "Severity",
          [
            { label: "A", value: "A", description: SEVERITY.A },
            { label: "B", value: "B", description: SEVERITY.B },
            { label: "C", value: "C", description: SEVERITY.C },
            { label: "None", value: "" },
          ],
          s.sev
        );
        if (v) s.sev = v.value;
      },
    },
    {
      icon: "person",
      label: "Owner",
      value: (s) => ownerName(plan, s.owner),
      changed: changed("owner"),
      edit: async (s) => {
        const v = await askPerson(plan, "Owner", s.owner);
        if (v !== undefined) s.owner = v;
      },
    },
    {
      icon: "calendar",
      label: "Due date",
      value: (s) => s.due,
      changed: changed("due"),
      edit: async (s) => {
        const v = await askDate("Due date", s.due, state.today);
        if (v !== undefined) s.due = v;
      },
    },
    {
      icon: "beaker",
      label: "Found in test case",
      value: (s) => s.from,
      changed: changed("from"),
      edit: async (s) => {
        const v = await askChoice(
          "Found in test case",
          [
            { label: "None", value: "" },
            ...plan.tests.flatMap((tp) =>
              tp.cases.map((c) => ({
                label: `${tp.id}/${c.id}`,
                value: `${tp.id}/${c.id}`,
                description: c.title,
              }))
            ),
          ],
          s.from
        );
        if (v) s.from = v.value;
      },
    },
    {
      icon: "tag",
      label: "Tags",
      value: (s) => (s.tags.length ? s.tags.map((t) => `#${t}`).join(" ") : undefined),
      changed: changed("tags"),
      edit: async (s) => {
        const v = await askValues("Tags", plan.tags, s.tags, { prefix: "#", noun: "tag" });
        if (v !== undefined) s.tags = v;
      },
    },
  ];
}

const SEVERITY: Record<string, string> = {
  A: "blocks acceptance",
  B: "fix before go-live",
  C: "may wait until after launch",
};

export async function addPunchItemCommand(
  state: PlannerState,
  target?: { status?: Status; owner?: string; sev?: string },
  values?: PunchValues
): Promise<string | undefined> {
  const service = state.service;
  if (!service.root) return undefined;
  let v = values;
  if (!v) {
    const title = await askText({
      title: "Add punch item",
      prompt: "Press Enter to continue to severity, owner and due date",
      placeHolder: "What is wrong or still open?",
      required: true,
    });
    if (!title) return undefined;
    const form: PunchForm = {
      title,
      sev: target?.sev ?? "B",
      owner: target?.owner ?? "",
      due: "",
      from: "",
      tags: [],
      status: target?.status ?? "todo",
    };
    const action = await showForm({
      title: "Add punch item",
      state: form,
      actions: [{ id: "create", icon: "check", label: "Create punch item", description: "Enter" }],
      fields: punchFields(state, false),
    });
    if (!action) return undefined;
    v = {
      title: form.title,
      sev: (form.sev || undefined) as PunchValues["sev"],
      owner: form.owner || undefined,
      due: form.due || undefined,
      from: form.from || undefined,
      tags: form.tags,
      status: form.status,
    };
  }
  const creation = addPunchItem(service.plan, {
    ...v,
    status: v.status ?? target?.status,
    today: state.today,
  });
  const ok = await applyCreation(service, {
    create: creation.create,
    edits: creation.edits ? [creation.edits] : undefined,
  });
  if (!ok) return undefined;
  message(`Added punch item ${creation.id}`);
  return creation.id;
}

async function editPunchItem(state: PlannerState, t: Task, change?: TaskChange): Promise<boolean> {
  const service = state.service;
  let edit = change;
  if (!edit) {
    const original: PunchForm = {
      title: t.title,
      sev: t.sev ?? "",
      owner: t.owner ?? "",
      due: rawAttr(t, "due"),
      from: t.from ?? "",
      tags: t.tags.map((x) => x.tag),
      status: t.status,
    };
    const form: PunchForm = { ...original, tags: [...original.tags] };
    const action = await showForm({
      title: `Edit ${t.id ?? "punch item"} · ${t.title}`,
      state: form,
      actions: [{ id: "save", icon: "check", label: "Save changes", description: "Enter" }],
      fields: punchFields(state, true, original),
      more: [
        { id: "open", icon: "go-to-file", label: "Open in editor" },
        { id: "delete", icon: "trash", label: "Delete punch item…" },
      ],
    });
    if (!action) return false;
    if (action === "delete")
      return deleteTaskCommand(service, t.id ?? { file: t.file, line: t.line });
    if (action === "open") {
      await vscode.commands.executeCommand(
        "planner.revealTask",
        t.id ?? { file: t.file, line: t.line }
      );
      return false;
    }
    edit = {
      title: form.title !== original.title ? form.title : undefined,
      status: form.status !== original.status ? form.status : undefined,
      attrs: {
        ...(form.sev !== original.sev ? { sev: form.sev || undefined } : {}),
        ...(form.owner !== original.owner ? { owner: form.owner || undefined } : {}),
        ...(form.due !== original.due ? { due: form.due || undefined } : {}),
        ...(form.from !== original.from ? { from: form.from || undefined } : {}),
      },
      removeTags: original.tags.filter((x) => !form.tags.includes(x)),
      addTags: form.tags.filter((x) => !original.tags.includes(x)),
    };
  }
  const file = service.plan.file(t.file);
  const fresh = resolveTask(service, t.id ?? { file: t.file, line: t.line })?.task ?? t;
  if (!file) return false;
  const edits = changeTask(file.lines, fresh, edit, state.today);
  if (edits.length === 0) return false;
  const ok = await service.apply([{ path: t.file, edits }], { source: "view" });
  if (ok) message(`Saved ${t.id ?? t.title}`);
  return ok;
}
