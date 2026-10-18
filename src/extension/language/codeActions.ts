// Quick fixes: add estimate, assign id, remove broken dependency, change unknown owner.
import * as vscode from "vscode";
import { type Task } from "../../core/model";
import { type TextEdit } from "../../core/text";
import { assignMissingIds, nextId, removeDependency, setAttr, setId } from "../../core/writer";
import { itemAtLine } from "../commands/args";
import { type PlanService } from "../planService";
import { toRange } from "../util";

const ESTIMATES = ["2h", "4h", "1d", "2d", "1w"];

export class PlanCodeActionProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly service: PlanService) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const rel = this.service.relPath(document.uri);
    const file = this.service.fileFor(document);
    if (rel === undefined || !file) return [];
    const plan = this.service.plan;
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== "planner") continue;
      const task = itemAtLine(plan, rel, diagnostic.range.start.line);
      if (!task || task.line !== diagnostic.range.start.line) continue;
      switch (diagnostic.code) {
        case "missing-estimate":
          for (const est of ESTIMATES) {
            actions.push(
              this.fix(
                `Add estimate @est:${est}`,
                document,
                setAttr(file.lines, task, "est", est),
                diagnostic,
                est === "4h"
              )
            );
          }
          actions.push(
            this.command("Add estimate…", "planner.addEstimate", [taskArg(task)], diagnostic)
          );
          break;
        case "missing-id": {
          actions.push(
            this.fix(
              `Assign id ^${nextId(plan)}`,
              document,
              setId(file.lines, task, nextId(plan)),
              diagnostic,
              true
            )
          );
          const all = assignMissingIds(plan, file);
          if (all.length > 1)
            actions.push(
              this.fix(
                `Assign ids to all ${all.length} tasks in this file`,
                document,
                all,
                diagnostic
              )
            );
          break;
        }
        case "unknown-dep": {
          const depId = document.getText(diagnostic.range);
          actions.push(
            this.fix(
              `Remove broken dependency ${depId}`,
              document,
              removeDependency(file.lines, task, depId),
              diagnostic,
              true
            )
          );
          break;
        }
        case "unknown-owner":
          for (const p of plan.people) {
            actions.push(
              this.fix(
                `Change owner to ${p.id} (${p.name})`,
                document,
                setAttr(file.lines, task, "owner", p.id),
                diagnostic
              )
            );
          }
          break;
      }
    }
    return actions;
  }

  private fix(
    title: string,
    document: vscode.TextDocument,
    edits: TextEdit[],
    diagnostic: vscode.Diagnostic,
    preferred = false
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    const we = new vscode.WorkspaceEdit();
    for (const e of edits) we.replace(document.uri, toRange(e.range), e.newText);
    action.edit = we;
    action.diagnostics = [diagnostic];
    action.isPreferred = preferred;
    return action;
  }

  private command(
    title: string,
    command: string,
    args: unknown[],
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.command = { command, title, arguments: args };
    action.diagnostics = [diagnostic];
    return action;
  }
}

function taskArg(t: Task): string | { file: string; line: number } {
  return t.id ?? { file: t.file, line: t.line };
}
