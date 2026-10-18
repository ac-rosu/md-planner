// Task commands: reveal, status changes, owners, estimates and ids. Every change is a WorkspaceEdit.
import * as vscode from "vscode";
import { parseDuration } from "../../core/duration";
import { STATUS_LABEL, STATUSES, type Status, type Task } from "../../core/model";
import { blockedTasks, overdueTasks } from "../../core/queries";
import { type ParsedFile } from "../../core/model";
import { assignMissingIds, type FileEdit, nextStatus, setAttr, setStatus } from "../../core/writer";
import { type PlanService } from "../planService";
import { toRange } from "../util";
import { resolveTask, stringArg, type TaskArg } from "./args";

export function registerTaskCommands(service: PlanService): vscode.Disposable[] {
  const reg = vscode.commands.registerCommand;
  return [
    reg("planner.revealTask", (arg: TaskArg) => revealTask(service, arg)),
    reg("planner.revealMilestone", (arg: string | { milestone?: { id: string } }) =>
      revealMilestone(service, typeof arg === "string" ? arg : (arg?.milestone?.id ?? ""))
    ),
    // Menus may pass more tree nodes after the first: only strings are taken as values.
    reg("planner.setStatus", (arg: TaskArg, status?: unknown, reason?: unknown) =>
      changeStatus(
        service,
        arg,
        STATUSES.find((s) => s === status),
        stringArg(reason)
      )
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

async function pickStatus(current: Status): Promise<Status | undefined> {
  const pick = await vscode.window.showQuickPick(
    STATUSES.map((s) => ({
      label: STATUS_LABEL[s],
      description: s === current ? "current" : undefined,
      status: s,
    })),
    { placeHolder: "Set status" }
  );
  return pick?.status;
}

export async function changeStatus(
  service: PlanService,
  arg: TaskArg,
  status?: Status,
  reason?: string
): Promise<boolean> {
  const r = resolveTask(service, arg);
  if (!r) {
    void vscode.window.showWarningMessage(
      "Planner: put the cursor on a task or select one in a view."
    );
    return false;
  }
  const t = r.task;
  const next = status ?? (await pickStatus(t.status));
  if (!next) return false;
  let blockedReason = reason;
  if (next === "blocked" && blockedReason === undefined && t.kind !== "step") {
    blockedReason = await vscode.window.showInputBox({
      prompt: "Why is this task blocked? (optional)",
      value: t.blocked ?? "",
    });
    if (blockedReason === undefined) return false;
    if (blockedReason === "") blockedReason = undefined;
  }
  const edits = setStatus(fileOf(service, t).lines, t, next, service.today(), { blockedReason });
  return service.apply([{ path: t.file, edits }], { source: r.fromEditor ? "editor" : "view" });
}

export async function cycleStatus(service: PlanService, arg: TaskArg): Promise<boolean> {
  const r = resolveTask(service, arg);
  if (!r) return false;
  const t = r.task;
  const edits = setStatus(fileOf(service, t).lines, t, nextStatus(t.status), service.today());
  return service.apply([{ path: t.file, edits }], { source: r.fromEditor ? "editor" : "view" });
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
  const edits = setAttr(fileOf(service, t).lines, t, "owner", value === "" ? undefined : value);
  return service.apply([{ path: t.file, edits }], { source: r.fromEditor ? "editor" : "view" });
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
  const edits = setAttr(fileOf(service, t).lines, t, "est", text.trim());
  return service.apply([{ path: t.file, edits }], { source: r.fromEditor ? "editor" : "view" });
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
  if (pick) await revealTask(service, pick.t.id ?? { file: pick.t.file, line: pick.t.line });
}
