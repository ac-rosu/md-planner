// Quick fixes: add estimate, assign id, remove broken dependency, change unknown owner, turn a
// mistyped line into a task, and the fixes of the consistency checks (dates, status dates, ids).
import * as vscode from "vscode";
import { type Task } from "../../core/model";
import { type TextEdit } from "../../core/text";
import { impliedDeps, suggestYear } from "../../core/consistency";
import { nearMissCheckbox } from "../../core/parser/taskLine";
import { formatHours } from "../../core/duration";
import { budgetSplit, openSubtasks } from "../../core/rollup";
import {
  assignMissingIds,
  insertTasks,
  minimalLineEdit,
  nextId,
  removeDependency,
  setAttr,
  setId,
  setProperty,
  setStatus,
} from "../../core/writer";
import { previousMilestone } from "../../core/queries";
import { newTaskFrom } from "../../core/writer/entities";
import { siblingsOf } from "../../core/writer/structure";
import { itemAtLine } from "../commands/args";
import { rollUpParents } from "../commands/status";
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
      const lineNo = diagnostic.range.start.line;
      if (diagnostic.code === "not-a-task") {
        const near = nearMissCheckbox(document.lineAt(lineNo).text);
        const edit = near && minimalLineEdit(lineNo, document.lineAt(lineNo).text, near.fixed);
        if (edit)
          actions.push(
            this.fix(`Make it a task: ${near.fixed.trim()}`, document, [edit], diagnostic, true)
          );
        continue;
      }
      const milestone = plan.milestones.find((m) => m.file === rel);
      if (milestone && diagnostic.code === "floating-milestone") {
        const prev = previousMilestone(plan, milestone);
        if (prev)
          actions.push(
            this.fix(
              `Add depends: ${prev.id} (start after ${prev.id} is finished)`,
              document,
              setProperty(file.lines, milestone.props, "depends", prev.id),
              diagnostic,
              true
            )
          );
        continue;
      }
      if (milestone && diagnostic.code === "milestone-started-early") {
        actions.push(
          this.fix(
            "Set the milestone status to planned",
            document,
            setProperty(file.lines, milestone.props, "status", "planned"),
            diagnostic
          )
        );
        continue;
      }
      const task = itemAtLine(plan, rel, lineNo);
      if (!task || task.line !== lineNo) continue;
      const remove = (key: string, preferred = false) =>
        actions.push(
          this.fix(
            `Remove @${key}`,
            document,
            setAttr(file.lines, task, key, undefined),
            diagnostic,
            preferred
          )
        );
      const removeDep = () => {
        const depId = document.getText(diagnostic.range);
        actions.push(
          this.fix(
            `Remove the dependency on ${depId}`,
            document,
            removeDependency(file.lines, task, depId),
            diagnostic,
            true
          )
        );
      };
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
          {
            // A task without an estimate is often a group whose tasks were not indented under it.
            const siblings = siblingsOf(file, task);
            const next = siblings[siblings.indexOf(task) + 1];
            if (next && task.children.length === 0)
              actions.push(
                this.command(
                  `Make the next task (${next.id ?? next.title}) a subtask of this one`,
                  "planner.indentTask",
                  [taskArg(next)],
                  diagnostic
                )
              );
          }
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
        case "duplicate-id": {
          const id = nextId(plan);
          actions.push(
            this.fix(
              `Give this task a new id ^${id}`,
              document,
              setId(file.lines, task, id),
              diagnostic
            )
          );
          break;
        }
        case "cancelled-dep":
        case "family-dep":
          removeDep();
          break;
        case "implied-dep": {
          const implied = new Set(impliedDeps(plan, task).map((x) => x.id));
          const kept = task.deps.filter((d) => !implied.has(d.id)).map((d) => d.raw);
          actions.push(
            this.fix(
              `Remove the implied dependenc${implied.size === 1 ? "y" : "ies"} (${[...implied].join(", ")})`,
              document,
              setAttr(file.lines, task, "dep", kept.length ? kept.join(",") : undefined),
              diagnostic,
              true
            )
          );
          break;
        }
        case "stale-started":
          remove("started", true);
          break;
        case "missing-done": {
          const today = this.service.today();
          actions.push(
            this.fix(
              `Add @done:${today}`,
              document,
              setAttr(file.lines, task, "done", today),
              diagnostic,
              true
            )
          );
          break;
        }
        case "date-outside-project": {
          const key = /^@(\w+):/.exec(document.getText(diagnostic.range))?.[1];
          const value = key === "start" ? task.start : key === "due" ? task.due : undefined;
          if (!key || !value) break;
          const suggestion = suggestYear(plan, value);
          if (suggestion)
            actions.push(
              this.fix(
                `Change @${key} to ${suggestion}`,
                document,
                setAttr(file.lines, task, key, suggestion),
                diagnostic,
                true
              )
            );
          remove(key);
          break;
        }
        case "start-after-started":
        case "start-after-target":
          remove("start", true);
          break;
        case "due-after-target": {
          const m = plan.milestoneById(task.milestoneId);
          if (m?.target)
            actions.push(
              this.fix(
                `Change @due to the ${m.id} target ${m.target}`,
                document,
                setAttr(file.lines, task, "due", m.target),
                diagnostic,
                true
              )
            );
          remove("due");
          break;
        }
        case "parent-estimate-unscheduled":
        case "parent-estimate-exceeded": {
          const { estimated, logged } = budgetSplit(task);
          const total = formatHours(estimated + logged);
          if (diagnostic.code === "parent-estimate-unscheduled" && task.est !== undefined) {
            const rest = formatHours(task.est - estimated - logged);
            const subtask = newTaskFrom(
              { title: `${task.title} (remaining work)`, attrs: { est: rest } },
              nextId(plan)
            );
            actions.push(
              this.fix(
                `Add a subtask for the remaining ${rest}`,
                document,
                insertTasks(file, { kind: "child", task }, [subtask]),
                diagnostic,
                true
              )
            );
          }
          actions.push(
            this.fix(
              `Set @est to the subtasks' total (${total})`,
              document,
              setAttr(file.lines, task, "est", total),
              diagnostic,
              diagnostic.code === "parent-estimate-exceeded"
            )
          );
          actions.push(
            this.fix(
              "Remove @est (use the subtasks' total)",
              document,
              setAttr(file.lines, task, "est", undefined),
              diagnostic
            )
          );
          break;
        }
        case "done-parent-open-subtasks": {
          const today = this.service.today();
          const open = openSubtasks(task);
          actions.push(
            this.fix(
              `Mark the ${open.length === 1 ? "open subtask" : `${open.length} open subtasks`} done`,
              document,
              open.flatMap((t) => setStatus(file.lines, t, "done", today)),
              diagnostic,
              true
            )
          );
          actions.push(
            this.fix(
              "Reopen this task (in progress)",
              document,
              setStatus(file.lines, task, "doing", today),
              diagnostic
            )
          );
          break;
        }
        case "started-early":
          actions.push(
            this.fix(
              "Put it back to To do",
              document,
              setStatus(file.lines, task, "todo", this.service.today()),
              diagnostic
            )
          );
          break;
        case "open-parent-all-done":
          actions.push(
            this.fix(
              "Mark this task done",
              document,
              setStatus(file.lines, task, "done", this.service.today(), {
                rollUp: rollUpParents(),
              }),
              diagnostic,
              true
            )
          );
          break;
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
