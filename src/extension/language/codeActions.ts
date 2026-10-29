// Quick fixes: add estimate, assign id, remove broken dependency, change unknown owner, turn a
// mistyped line into a task, and the fixes of the consistency checks (dates, status dates, ids).
import * as vscode from "vscode";
import { isOpen, type Task } from "../../core/model";
import { type TextEdit } from "../../core/text";
import { impliedDeps, suggestPeriodYear, suggestYear } from "../../core/consistency";
import { joinDepIds, moveIdToEnd, moveLineUp, renameAttrKey } from "../../core/lineFixes";
import { propertyBlockFor } from "../../core/parser/files";
import { nearMissCheckbox } from "../../core/parser/taskLine";
import { meantAttr } from "../../core/resolve";
import { formatHours } from "../../core/duration";
import { budgetSplit, isEffectivelyDone, openSubtasks } from "../../core/rollup";
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
import { isFloatingMilestone, isOpenTask, previousMilestone } from "../../core/queries";
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
      if (
        diagnostic.code === "misspelled-attr" ||
        diagnostic.code === "dep-space" ||
        diagnostic.code === "id-not-last"
      ) {
        const text = document.lineAt(lineNo).text;
        const { start, end } = diagnostic.range;
        const sameLine = start.line === end.line;
        const key = /^@([^:\s]+)/.exec(document.getText(diagnostic.range))?.[1];
        const meant = key && meantAttr(key);
        const fix =
          diagnostic.code === "misspelled-attr"
            ? meant && sameLine
              ? {
                  title: `Change to @${meant}`,
                  text: renameAttrKey(text, start.character, end.character, meant),
                }
              : undefined
            : diagnostic.code === "dep-space"
              ? { title: "Join the ids: @dep without spaces", text: joinDepIds(text) }
              : {
                  title: "Move the id to the end of the line",
                  text: sameLine ? moveIdToEnd(text, start.character, end.character) : undefined,
                };
        const edit = fix?.text !== undefined && minimalLineEdit(lineNo, text, fix.text);
        if (fix && edit) actions.push(this.fix(fix.title, document, [edit], diagnostic, true));
        continue;
      }
      if (diagnostic.code === "property-not-read") {
        // Moved up to the end of the block of the heading above it, where it is read.
        const to = propertyBlockFor(file, lineNo);
        if (to !== undefined && to < lineNo)
          actions.push(
            this.fix(
              "Move it up to the other properties",
              document,
              moveLineUp(file.lines, lineNo, to),
              diagnostic,
              true
            )
          );
        continue;
      }
      if (diagnostic.code === "progress-fraction") {
        const value = Number(document.getText(diagnostic.range));
        if (value > 0 && value < 1)
          actions.push(
            this.fix(
              `Change to ${Math.round(value * 100)}%`,
              document,
              [{ range: diagnostic.range, newText: `${Math.round(value * 100)}%` }],
              diagnostic,
              true
            )
          );
        continue;
      }
      if (
        (file.kind === "team" || file.kind === "project") &&
        (diagnostic.code === "date-outside-project" || diagnostic.code === "long-holiday")
      ) {
        // A date or period in a team.md property: its dates after the project end a year
        // earlier, when that fits. The diagnostic covers exactly the date or period.
        const { start, end } = diagnostic.range;
        const period = document.getText(diagnostic.range);
        const suggestion = start.line === end.line ? suggestPeriodYear(plan, period) : undefined;
        const text = document.lineAt(lineNo).text;
        const edit =
          suggestion &&
          minimalLineEdit(
            lineNo,
            text,
            text.slice(0, start.character) + suggestion + text.slice(end.character)
          );
        if (edit)
          actions.push(
            this.fix(`Change ${period} to ${suggestion}`, document, [edit], diagnostic, true)
          );
        continue;
      }
      const milestone = plan.milestones.find((m) => m.file === rel);
      if (milestone && diagnostic.code === "floating-milestone") {
        // Asked again: by now an earlier milestone may wait for it, and depends: on the one before
        // it could make a cycle.
        const prev = previousMilestone(plan, milestone);
        if (prev && isFloatingMilestone(plan, milestone))
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
            // Indent asks first when the move would add errors, so it stays a command; "editor"
            // makes it an edit in this editor like the other fixes (not saved, focus stays here).
            const siblings = siblingsOf(file, task);
            const next = siblings[siblings.indexOf(task) + 1];
            if (next && task.children.length === 0)
              actions.push(
                this.command(
                  `Make the next task (${next.id ?? next.title}) a subtask of this one`,
                  "planner.indentTask",
                  [taskArg(next), "editor"],
                  diagnostic
                )
              );
          }
          break;
        case "missing-id": {
          const id = nextId(plan, idPrefix(task));
          actions.push(
            this.fix(`Assign id ^${id}`, document, setId(file.lines, task, id), diagnostic, true)
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
          const id = nextId(plan, idPrefix(task));
          actions.push(
            this.fix(
              `Give this ${task.kind === "task" ? "task" : "item"} a new id ^${id}`,
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
        case "cancelled-parent-open-subtasks": {
          // No preferred fix: the subtasks may have been cancelled with this task on purpose, or
          // put under it by mistake.
          const today = this.service.today();
          const open = openSubtasks(task);
          if (open.length === 0) break;
          actions.push(
            this.fix(
              `Cancel the ${open.length === 1 ? "open subtask" : `${open.length} open subtasks`} too`,
              document,
              open.flatMap((t) => setStatus(file.lines, t, "cancelled", today)),
              diagnostic
            )
          );
          // Moving a subtask out or reopening this task only gets work scheduled when nothing above
          // it is done or cancelled (a task, or the milestone), and only the open subtasks that no
          // done subtask holds.
          const freed = open.filter((t) => !isEffectivelyDone(t));
          if (
            freed.length === 0 ||
            plan.milestoneById(task.milestoneId)?.status === "cancelled" ||
            (task.parent && !isOpenTask(task.parent))
          )
            break;
          const kids = task.children.filter((c) => isOpen(c.status));
          if (kids.length === 1)
            actions.push(
              this.command(
                `Move ${kids[0].id ?? kids[0].title} out of this task (outdent)`,
                "planner.outdentTask",
                [taskArg(kids[0])],
                diagnostic
              )
            );
          const started = freed.some((t) => t.status === "doing" || t.status === "review");
          actions.push(
            this.fix(
              `Reopen this task (${started ? "in progress" : "to do"})`,
              document,
              setStatus(file.lines, task, started ? "doing" : "todo", today),
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

/** Punch items get `P` ids; tasks and inbox items (which become tasks) `T` ids. */
function idPrefix(t: Task): string {
  return t.kind === "punch" ? "P" : "T";
}
