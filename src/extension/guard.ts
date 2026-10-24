// Before a move, checks whether it would add validation errors (a cycle through a milestone's
// `depends:`, a dependency on its own parent …) and asks first. The same check makes the MCP server
// refuse such writes; here the user may still go ahead.
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
  what: string
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
  const go = "Move anyway";
  const pick = await vscode.window.showWarningMessage(
    `${what} would add ${added.length === 1 ? "an error" : `${added.length} errors`} to the plan.`,
    {
      modal: true,
      detail: `${added.slice(0, 5).join("\n")}${added.length > 5 ? "\n…" : ""}\n\nIf you move it anyway, the errors are listed in the Problems panel.`,
    },
    go
  );
  return pick === go;
}
