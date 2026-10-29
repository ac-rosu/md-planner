// Before a move or a form's save, checks whether it would add validation errors (a cycle through
// a milestone's `depends:`, a dependency on its own parent …) or take open tasks out of the
// schedule, and asks first. The same checks make the MCP server refuse such writes; here the user may still go ahead.
import * as vscode from "vscode";
import { PlanIndex } from "../core/index";
import { newErrors, planErrors } from "../core/newErrors";
import { applyEdits, type TextEdit } from "../core/text";
import { type FileEdit } from "../core/writer";
import { type PlanService } from "./planService";

/** True when the edits add no errors, or the user wants them anyway. */
export async function confirmNoNewErrors(
  service: PlanService,
  edits: FileEdit[],
  what: string,
  verb = "move"
): Promise<boolean> {
  const plan = service.plan;
  const byPath = new Map<string, TextEdit[]>();
  for (const e of edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), ...e.edits]);
  const staged = new PlanIndex();
  for (const f of plan.files) {
    const text = f.lines.serialize();
    const list = byPath.get(f.path);
    staged.update(f.path, list ? applyEdits(text, list) : text);
  }
  const added = newErrors(planErrors(plan), planErrors(staged.plan));
  if (added.length === 0) return true;
  const go = `${verb.charAt(0).toUpperCase()}${verb.slice(1)} anyway`;
  const pick = await vscode.window.showWarningMessage(
    `${what} would add ${added.length === 1 ? "an error" : `${added.length} errors`} to the plan.`,
    {
      modal: true,
      detail: `${added.slice(0, 5).join("\n")}${added.length > 5 ? "\n…" : ""}\n\nIf you ${verb} it anyway, the errors are listed in the Problems panel.`,
    },
    go
  );
  return pick === go;
}

/**
 * True when a move keeps its open tasks scheduled (no `warning` from the core move), or the user
 * wants it anyway. Nothing else would show it: the moved tasks keep their open checkboxes.
 */
export async function confirmStillScheduled(
  warning: string | undefined,
  go = "Move anyway"
): Promise<boolean> {
  if (!warning) return true;
  const pick = await vscode.window.showWarningMessage(
    warning,
    {
      modal: true,
      detail:
        "Open tasks under a cancelled task, or in a cancelled milestone, are cancelled with it; under a done task they count as finished. Their checkboxes still look open, but they no longer appear in the schedule, the Gantt chart or the workload.",
    },
    go
  );
  return pick === go;
}
