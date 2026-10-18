// "Plan into milestone…": moves an inbox item into a milestone as a task (with a new id).
import * as vscode from "vscode";
import { type InsertLocation, moveTask, nextId } from "../../core/writer";
import { type PlanService } from "../planService";
import { resolveTask, type TaskArg } from "./args";

export interface PlanIntoTarget {
  milestone: string;
  /** Section title; omitted or empty = top of the milestone (no section). */
  section?: string;
}

export function registerInboxCommands(service: PlanService): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "planner.planIntoMilestone",
      (arg: TaskArg, target?: PlanIntoTarget) => planIntoMilestone(service, arg, target)
    ),
  ];
}

export async function planIntoMilestone(
  service: PlanService,
  arg: TaskArg,
  target?: PlanIntoTarget
): Promise<string | undefined> {
  const r = resolveTask(service, arg);
  if (!r || r.task.kind !== "inbox") {
    void vscode.window.showWarningMessage("Planner: select an inbox item to plan.");
    return undefined;
  }
  const plan = service.plan;
  const item = r.task;
  const chosen = target ?? (await pickMilestoneLocation(service, "Plan into milestone…"));
  if (!chosen) return undefined;
  const milestone = plan.milestoneById(chosen.milestone);
  if (!milestone) {
    void vscode.window.showErrorMessage(`Planner: unknown milestone ${chosen.milestone}.`);
    return undefined;
  }
  const source = plan.file(item.file)!;
  const dest = plan.file(milestone.file)!;
  const location: InsertLocation = chosen.section
    ? { kind: "section", title: chosen.section }
    : { kind: "root" };
  const id = item.id ?? nextId(plan, "T");
  const edits = moveTask(source, item, dest, location, (first) =>
    item.id ? first : `${first.replace(/\s+$/, "")} ^${id}`
  );
  const ok = await service.apply(edits, { source: "view" });
  return ok ? id : undefined;
}

/** Asks for a milestone and a section (existing, none or new). */
export async function pickMilestoneLocation(
  service: PlanService,
  placeHolder: string
): Promise<PlanIntoTarget | undefined> {
  const plan = service.plan;
  const m = await vscode.window.showQuickPick(
    plan.milestones
      .filter((x) => x.status !== "done" && x.status !== "cancelled")
      .map((x) => ({
        label: x.title,
        description: x.target ? `target ${x.target}` : undefined,
        id: x.id,
      })),
    { placeHolder }
  );
  if (!m) return undefined;
  const milestone = plan.milestoneById(m.id)!;
  const sections = milestone.sections.map((s) => ({
    label: s.title,
    value: s.title as string | null,
  }));
  if (sections.length === 0) return { milestone: m.id };
  const pick = await vscode.window.showQuickPick(
    [
      ...sections,
      { label: "$(list-flat) No section", value: "" as string | null },
      { label: "$(add) New section…", value: null },
    ],
    { placeHolder: `Section in ${milestone.title}` }
  );
  if (!pick) return undefined;
  if (pick.value === null) {
    const title = await vscode.window.showInputBox({ prompt: "New section title" });
    if (!title) return undefined;
    return { milestone: m.id, section: title };
  }
  return { milestone: m.id, section: pick.value || undefined };
}
