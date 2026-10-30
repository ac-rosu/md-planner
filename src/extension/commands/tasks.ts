// Task commands: reveal, status changes, owners, estimates and ids. Every change is a WorkspaceEdit.
import * as vscode from "vscode";
import { parseDuration } from "../../core/duration";
import { isValidDate } from "../../core/dates";
import {
  isOpen,
  type Milestone,
  STATUS_LABEL,
  STATUSES,
  type Status,
  type Task,
} from "../../core/model";
import { blockedTasks, doneDateSuggestions, overdueTasks } from "../../core/queries";
import { type ParsedFile } from "../../core/model";
import {
  assignMissingIds,
  type FileEdit,
  markOpenDone,
  nextStatus,
  setAttr,
  setStatus,
} from "../../core/writer";
import { type PlanService } from "../planService";
import { toRange } from "../util";
import { cursorOnCodeCheckbox, findAgain, resolveTask, stringArg, type TaskArg } from "./args";
import { askPastDate } from "../ui/inputs";
import { offerUndo, resolveMilestone } from "./edit";
import { type StatusAnswers, statusEffects, SUBTASK_CHOICES } from "./status";

export function registerTaskCommands(service: PlanService): vscode.Disposable[] {
  const reg = vscode.commands.registerCommand;
  return [
    reg("planner.revealTask", (arg: TaskArg) => revealTask(service, arg)),
    reg("planner.revealMilestone", (arg: string | { milestone?: { id: string } }) =>
      revealMilestone(service, typeof arg === "string" ? arg : (arg?.milestone?.id ?? ""))
    ),
    // Menus may pass more tree nodes after the first: only strings are taken as values.
    // The answers to its questions may come as arguments: what happens to open subtasks
    // (`done`, `cancelled`, `keep`), and `true` to start even though an earlier milestone is open.
    // A sixth argument gives the date the change happened on (YYYY-MM-DD, not after today).
    reg(
      "planner.setStatus",
      (
        arg: TaskArg,
        status?: unknown,
        reason?: unknown,
        subtasks?: unknown,
        early?: unknown,
        date?: unknown
      ) =>
        changeStatus(
          service,
          arg,
          STATUSES.find((s) => s === status),
          stringArg(reason),
          {
            subtasks: SUBTASK_CHOICES.find((c) => c === subtasks),
            startEarly: early === true,
          },
          pastDateArg(date, service.today())
        )
    ),
    reg("planner.doneOn", (arg: TaskArg, date?: unknown) =>
      doneOn(service, arg, pastDateArg(date, service.today()))
    ),
    reg("planner.markOpenDone", (arg?: unknown, date?: unknown) =>
      markOpenDoneCommand(service, arg, pastDateArg(date, service.today()))
    ),
    ...STATUSES.map((s) =>
      reg(`planner.status.${s}`, (arg: TaskArg) => changeStatus(service, arg, s))
    ),
    reg("planner.cycleStatus", (arg: TaskArg) => cycleStatus(service, arg)),
    reg("planner.assignOwner", (arg: TaskArg, owner?: unknown) =>
      assignOwner(service, arg, stringArg(owner))
    ),
    reg("planner.addEstimate", (arg: TaskArg, value?: unknown) =>
      addEstimate(service, arg, stringArg(value))
    ),
    reg("planner.removeFixedStart", (arg: TaskArg) => removeFixedStart(service, arg)),
    reg("planner.assignIds", (scope?: unknown) => assignIds(service, stringArg(scope))),
    reg("planner.showAttention", () => showAttention(service)),
  ];
}

export async function revealTask(service: PlanService, arg: TaskArg): Promise<void> {
  const r = resolveTask(service, arg);
  if (!r) return;
  const t = r.task;
  const doc = await vscode.workspace.openTextDocument(service.uri(t.file));
  const range = t.titleRanges.length
    ? new vscode.Range(
        toRange(t.titleRanges[0]).start,
        toRange(t.titleRanges[t.titleRanges.length - 1]).end
      )
    : new vscode.Range(t.line, 0, t.line, 0);
  await vscode.window.showTextDocument(doc, {
    selection: range,
    preserveFocus: false,
    preview: true,
  });
}

export async function revealMilestone(service: PlanService, id: string): Promise<void> {
  const m = service.plan.milestoneById(id);
  if (!m) return;
  const doc = await vscode.workspace.openTextDocument(service.uri(m.file));
  const line = Math.max(0, m.headingLine);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(line, 0, line, 0),
    preview: true,
  });
}

function fileOf(service: PlanService, t: Task): ParsedFile {
  const f = service.plan.file(t.file);
  if (!f) throw new Error(`File not loaded: ${t.file}`);
  return f;
}

/**
 * The new status; `askDate` when the user wants to give the day it happened on (work entered
 * afterwards): "Done on…" and "In progress since…" next to the statuses, which mean today.
 */
async function pickStatus(
  current: Status,
  datable: boolean
): Promise<{ status: Status; askDate?: boolean } | undefined> {
  const items: Array<vscode.QuickPickItem & { status: Status; askDate?: boolean }> = [];
  for (const s of STATUSES) {
    items.push({
      label: STATUS_LABEL[s],
      description: s === current ? "current" : undefined,
      status: s,
    });
    if (!datable) continue;
    if (s === "doing")
      items.push({
        label: "$(calendar) In progress since…",
        description: "started on an earlier day",
        status: s,
        askDate: true,
      });
    if (s === "done")
      items.push({
        label: "$(calendar) Done on…",
        description: "finished on an earlier day",
        status: s,
        askDate: true,
      });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Set status" });
  return pick && { status: pick.status, askDate: pick.askDate };
}

/** A date argument that is a valid YYYY-MM-DD not after today, else undefined. */
function pastDateArg(value: unknown, today: string): string | undefined {
  return typeof value === "string" && isValidDate(value) && value <= today ? value : undefined;
}

export async function changeStatus(
  service: PlanService,
  arg: TaskArg,
  status?: Status,
  reason?: string,
  answers: StatusAnswers = {},
  givenDate?: string
): Promise<boolean> {
  const r = resolveTask(service, arg);
  if (!r) {
    // On a task line in a code block resolveTask said why.
    if (arg !== undefined || !cursorOnCodeCheckbox(service))
      void vscode.window.showWarningMessage(
        "Planner: put the cursor on a task or select one in a view."
      );
    return false;
  }
  const t = r.task;
  const picked = status ? { status } : await pickStatus(t.status, t.kind !== "step");
  if (!picked) return false;
  const next = picked.status;
  let date = givenDate;
  if (picked.askDate) {
    date = await askPastDate(
      next === "done" ? `Done on – ${t.id ?? t.title}` : `In progress since – ${t.id ?? t.title}`,
      service.today(),
      next === "done" ? doneDateSuggestions(service.plan, t, service.today()) : [],
      next === "done" ? t.done : t.started
    );
    if (!date) return false;
  }
  let blockedReason = reason;
  if (next === "blocked" && blockedReason === undefined && t.kind !== "step") {
    blockedReason = await vscode.window.showInputBox({
      prompt: "Why is this task blocked? (optional)",
      value: t.blocked ?? "",
    });
    if (blockedReason === undefined) return false;
    if (blockedReason === "") blockedReason = undefined;
  }
  const effects = await statusEffects(service.plan, t, next, answers);
  if (!effects) return false;
  // The questions take time: change the task as it is now, on its own line (a copy has its id).
  const current = findAgain(service.plan, t);
  if (!current) return false;
  const edits = setStatus(fileOf(service, current).lines, current, next, service.today(), {
    blockedReason,
    ...effects,
    // Only for the statuses that have a date; a date for another status means nothing.
    ...(date && (next === "done" || next === "doing" || next === "review") ? { date } : {}),
  });
  return service.apply([{ path: current.file, edits }], {
    source: r.fromEditor ? "editor" : "view",
  });
}

/**
 * Marks a task done on the day it was finished (work entered afterwards), or changes the date of
 * a task that is done already: the date is asked for, with its milestone target and the day its
 * dependencies finished among the choices.
 */
export async function doneOn(
  service: PlanService,
  arg: TaskArg,
  givenDate?: string
): Promise<boolean> {
  const r = resolveTask(service, arg);
  if (!r) {
    if (arg !== undefined || !cursorOnCodeCheckbox(service))
      void vscode.window.showWarningMessage(
        "Planner: put the cursor on a task or select one in a view."
      );
    return false;
  }
  const t = r.task;
  if (t.kind === "step") {
    void vscode.window.showWarningMessage("Planner: test steps have results, not done dates.");
    return false;
  }
  const date =
    givenDate ??
    (await askPastDate(
      `${t.status === "done" ? "Change the done date" : "Done on"} – ${t.id ?? t.title}`,
      service.today(),
      doneDateSuggestions(service.plan, t, service.today()),
      t.done
    ));
  if (!date) return false;
  return changeStatus(service, arg, "done", undefined, {}, date);
}

/**
 * "Mark open tasks done…" on a milestone or a section: every open task in it (subtasks included)
 * is done on one date, asked for with the milestone's target first when it has passed. For a
 * phase that finished before the plan was written down.
 */
export async function markOpenDoneCommand(
  service: PlanService,
  arg: unknown,
  givenDate?: string
): Promise<boolean> {
  const plan = service.plan;
  const m = resolveMilestone(service, arg);
  if (!m) {
    void vscode.window.showWarningMessage("Planner: choose a milestone or a section.");
    return false;
  }
  const section = sectionTitleOf(m, arg);
  const scope =
    section === undefined
      ? m.tasks
      : section === ""
        ? m.rootTasks
        : (m.sections.find((s) => s.title === section)?.tasks ?? []);
  const where = section ? `${m.id} › ${section}` : m.id;
  const open = scope
    .flatMap(function all(t: Task): Task[] {
      return [t, ...t.children.flatMap(all)];
    })
    .filter((t) => isOpen(t.status) && t.status !== "cancelled");
  if (open.length === 0) {
    void vscode.window.showInformationMessage(`Planner: ${where} has no open tasks.`);
    return false;
  }
  const today = service.today();
  let date = givenDate;
  if (!date) {
    date = await askPastDate(
      `Mark ${open.length} open task${open.length === 1 ? "" : "s"} of ${where} done on`,
      today,
      m.target && m.target <= today ? [{ label: `the ${m.id} target`, date: m.target }] : []
    );
    if (!date) return false;
    const go = `Mark ${open.length} Done`;
    const answer = await vscode.window.showWarningMessage(
      `Mark the ${open.length} open task${open.length === 1 ? "" : "s"} of ${where} done on ${date}?`,
      {
        modal: true,
        detail:
          "For work that was finished before it was entered in the plan. Each gets @done:" +
          `${date} (one started later gets its @started); done and cancelled tasks stay as they are. ` +
          "Cmd+Z in the file undoes it.",
      },
      go
    );
    if (answer !== go) return false;
  }
  const file = plan.file(m.file);
  if (!file) return false;
  const { edits, marked, startedLater } = markOpenDone(file.lines, scope, date, today);
  const ok = await service.apply([{ path: file.path, edits }], { source: "view" });
  if (ok)
    void vscode.window.setStatusBarMessage(
      `$(check) ${marked.length} task${marked.length === 1 ? "" : "s"} of ${where} done on ${date}` +
        (startedLater.length ? ` (${startedLater.length} on their later @started)` : ""),
      6000
    );
  return ok;
}

/** The section a milestone-or-section argument names: its title, "" for no section, else none. */
function sectionTitleOf(m: Milestone, arg: unknown): string | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const a = arg as { section?: { title: string } | string; key?: string };
  if (typeof a.section === "string") return a.section;
  if (a.section) return a.section.title;
  const k = typeof a.key === "string" ? /^section:[^:]+:(\d+|root)$/.exec(a.key) : null;
  if (k) return k[1] === "root" ? "" : m.sections.find((s) => s.line === Number(k[1]))?.title;
  return undefined;
}

export async function cycleStatus(service: PlanService, arg: TaskArg): Promise<boolean> {
  const r = resolveTask(service, arg);
  if (!r) return false;
  const t = r.task;
  const next = nextStatus(t.status);
  const effects = await statusEffects(service.plan, t, next);
  if (!effects) return false;
  const current = findAgain(service.plan, t);
  if (!current) return false;
  const edits = setStatus(fileOf(service, current).lines, current, next, service.today(), effects);
  return service.apply([{ path: current.file, edits }], {
    source: r.fromEditor ? "editor" : "view",
  });
}

export async function assignOwner(
  service: PlanService,
  arg: TaskArg,
  owner?: string
): Promise<boolean> {
  const r = resolveTask(service, arg);
  if (!r) return false;
  const t = r.task;
  let value: string | undefined = owner;
  if (value === undefined) {
    const items = [
      ...service.plan.people.map((p) => ({
        label: p.name,
        description: [p.id, p.role].filter(Boolean).join(" · "),
        detail: p.skills.length ? `Skills: ${p.skills.join(", ")}` : undefined,
        id: p.id as string | null,
      })),
      {
        label: "$(circle-slash) No owner",
        description: "remove @owner",
        detail: undefined,
        id: null,
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Owner of ${t.id ?? t.title}`,
    });
    if (!pick) return false;
    value = pick.id ?? "";
  }
  const current = findAgain(service.plan, t);
  if (!current) return false;
  const edits = setAttr(
    fileOf(service, current).lines,
    current,
    "owner",
    value === "" ? undefined : value
  );
  return service.apply([{ path: current.file, edits }], {
    source: r.fromEditor ? "editor" : "view",
  });
}

export async function addEstimate(
  service: PlanService,
  arg: TaskArg,
  value?: string
): Promise<boolean> {
  const r = resolveTask(service, arg);
  if (!r) return false;
  const t = r.task;
  const hpd = service.plan.project.hoursPerDay;
  const text =
    value ??
    (await vscode.window.showInputBox({
      prompt: `Estimate for ${t.id ?? t.title} (e.g. 4h, 1.5d, 1w)`,
      value: t.attrs.find((a) => a.key === "est")?.value ?? "",
      validateInput: (v) =>
        parseDuration(v, hpd) === undefined ? "Use a number with h, d or w" : undefined,
    }));
  if (!text || parseDuration(text, hpd) === undefined) return false;
  const current = findAgain(service.plan, t);
  if (!current) return false;
  const edits = setAttr(fileOf(service, current).lines, current, "est", text.trim());
  return service.apply([{ path: current.file, edits }], {
    source: r.fromEditor ? "editor" : "view",
  });
}

/** Removes `@start`, so the scheduler places the task again as early as it can. */
export async function removeFixedStart(service: PlanService, arg: TaskArg): Promise<boolean> {
  const r = resolveTask(service, arg);
  if (!r?.task.start) {
    void vscode.window.showInformationMessage("Planner: this task has no fixed start (@start).");
    return false;
  }
  const t = r.task;
  const edits = setAttr(fileOf(service, t).lines, t, "start", undefined);
  const revert = await service.applyRevertible([{ path: t.file, edits }], {
    source: r.fromEditor ? "editor" : "view",
  });
  if (!revert) return false;
  // From a menu the change is easy to miss: say what it did, with Undo.
  offerUndo(service, `${t.id ?? t.title}: fixed start ${t.start} removed.`, revert);
  return true;
}

/** Assigns ids in the active file (default), a given plan path, or all files (`"all"`). */
export async function assignIds(service: PlanService, scope?: string): Promise<number> {
  const plan = service.plan;
  let files: ParsedFile[];
  if (scope === "all") files = plan.files;
  else if (scope) files = [plan.file(scope)].filter((f): f is ParsedFile => !!f);
  else {
    const editor = vscode.window.activeTextEditor;
    const rel = editor ? service.relPath(editor.document.uri) : undefined;
    files = rel !== undefined ? [plan.file(rel)].filter((f): f is ParsedFile => !!f) : plan.files;
  }
  // Ids must stay unique across files: assign file by file against a growing reservation.
  const edits: FileEdit[] = [];
  let count = 0;
  const reserved = new Set<string>();
  for (const f of files) {
    const fileEdits = assignMissingIds(plan, f, reserved);
    count += fileEdits.length;
    if (fileEdits.length) edits.push({ path: f.path, edits: fileEdits });
  }
  if (count === 0) {
    void vscode.window.showInformationMessage("Planner: every task already has an id.");
    return 0;
  }
  await service.apply(edits, { source: scope ? "view" : "editor" });
  return count;
}

async function showAttention(service: PlanService): Promise<void> {
  const plan = service.plan;
  const today = service.today();
  const items = [
    ...overdueTasks(plan, today).map((t) => ({
      t,
      label: `$(warning) ${t.title}`,
      description: `${t.id ?? ""} overdue`,
    })),
    ...blockedTasks(plan).map((t) => ({
      t,
      label: `$(circle-slash) ${t.title}`,
      description: `${t.id ?? ""} blocked`,
      detail: t.blocked,
    })),
  ];
  if (items.length === 0) {
    void vscode.window.showInformationMessage("Planner: nothing overdue or blocked.");
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Overdue and blocked tasks",
  });
  if (pick) await revealTask(service, { task: pick.t });
}
