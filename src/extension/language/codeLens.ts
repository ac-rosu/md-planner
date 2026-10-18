// CodeLens in plan files: the schedule (milestone progress and forecast, task dates and slack) and
// clickable actions next to it (owner, edit, add task, edit person …), so that every edit can be
// started from the file without knowing the commands.
import * as vscode from "vscode";
import { type Task } from "../../core/model";
import { milestoneStats } from "../../core/queries";
import { type PlannerState } from "../state";
import { config } from "../util";

export class PlanCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly disposable: vscode.Disposable;

  constructor(private readonly state: PlannerState) {
    this.disposable = state.onDidUpdate(() => this.emitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const service = this.state.service;
    if (!config().get<boolean>("codeLens.enabled", true)) return [];
    const file = service.fileFor(document);
    if (!file) return [];
    const plan = this.state.plan;
    const actions = config().get<boolean>("codeLens.actions", true);
    const showSchedule = config().get<boolean>("codeLens.tasks", true);
    const lenses: vscode.CodeLens[] = [];
    const lens = (
      line: number,
      title: string,
      command: string,
      args: unknown[],
      tooltip?: string
    ) =>
      lenses.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title,
          command,
          arguments: args,
          tooltip,
        })
      );
    const taskArg = (t: Task) => t.id ?? { file: t.file, line: t.line };
    const ownerLens = (t: Task) => {
      const own = t.owner;
      let inherited: string | undefined;
      for (let p = t.parent; !own && p && !inherited; p = p.parent) inherited = p.owner;
      const id = own ?? inherited;
      const name = id ? (plan.personById(id)?.name ?? id) : undefined;
      lens(
        t.line,
        name ? `$(person) ${name}${own ? "" : " (from the parent)"}` : "$(person) Assign owner",
        "planner.assignOwner",
        [taskArg(t)],
        "Choose who does this task"
      );
    };

    switch (file.kind) {
      case "milestone": {
        const milestone = plan.milestones.find((m) => m.file === file.path);
        if (!milestone) return [];
        const stats = milestoneStats(milestone);
        const heading = Math.max(0, milestone.headingLine);
        const parts = [
          `${stats.done}/${stats.total} tasks`,
          `${Math.round(stats.progress * 100)}%`,
        ];
        parts.push(...this.state.milestoneLensParts(milestone.id));
        lens(
          heading,
          parts.join(" · "),
          "planner.revealInTree",
          [{ milestone: milestone.id }],
          "Milestone progress (hours-weighted) – click to show it in the Milestones view"
        );
        if (actions) {
          lens(heading, "$(add) Add task", "planner.addTask", [{ milestone: milestone.id }]);
          lens(heading, "$(list-tree) Add section", "planner.addSection", [milestone.id]);
          lens(heading, "$(edit) Edit milestone", "planner.editMilestone", [milestone.id]);
        }
        for (const t of file.items) {
          if (showSchedule) {
            const text = this.state.taskLens(t);
            if (text)
              lens(
                t.line,
                text,
                "planner.revealInTree",
                [{ task: taskArg(t) }],
                "Scheduled dates and slack (from the scheduler) – click to show the task in the Milestones view"
              );
          }
          if (actions && t.kind === "task" && t.status !== "cancelled") {
            ownerLens(t);
            lens(
              t.line,
              "$(edit) Edit",
              "planner.editTask",
              [taskArg(t)],
              "Edit every field of this task"
            );
          }
        }
        break;
      }
      case "punch":
        if (!actions) break;
        lens(Math.max(0, file.headingLine), "$(add) Add punch item", "planner.addPunchItem", []);
        for (const t of file.items) {
          if (t.parent) continue;
          ownerLens(t);
          lens(t.line, "$(edit) Edit", "planner.editTask", [taskArg(t)]);
        }
        break;
      case "inbox":
        if (!actions) break;
        lens(Math.max(0, file.headingLine), "$(add) Capture to inbox", "planner.captureInbox", []);
        for (const t of file.items) {
          if (t.parent || t.status === "done" || t.status === "cancelled") continue;
          lens(t.line, "$(arrow-right) Plan into milestone…", "planner.planIntoMilestone", [
            { file: t.file, line: t.line },
          ]);
        }
        break;
      case "team":
        if (!actions) break;
        lens(Math.max(0, file.headingLine), "$(person-add) Add person", "planner.addPerson", []);
        for (const p of plan.people.filter((x) => x.file === file.path)) {
          lens(p.headingLine, "$(edit) Edit person", "planner.editPerson", [p.id]);
          lens(p.headingLine, "$(calendar) Add time off", "planner.addTimeOff", [p.id]);
          lens(
            p.headingLine,
            "$(watch) Plan overtime",
            "planner.addOvertime",
            [p.id],
            "Extra hours on working days for a period (overtime:)"
          );
          lens(
            p.headingLine,
            "$(add) Add working day",
            "planner.addWorkday",
            [p.id],
            "A weekend day or holiday this person works (workday:)"
          );
        }
        break;
      case "project":
        if (!actions) break;
        lens(
          Math.max(0, file.headingLine),
          "$(settings-gear) Edit project settings",
          "planner.editProject",
          [],
          "Name, dates, work week, hours per day and holidays"
        );
        break;
      case "test": {
        if (!actions) break;
        const tp = plan.tests.find((x) => x.file === file.path);
        if (tp)
          lens(
            Math.max(0, tp.headingLine),
            "$(beaker) Open in test runner",
            "planner.openTestRunner",
            [tp.id]
          );
        break;
      }
    }
    return lenses;
  }

  dispose(): void {
    this.disposable.dispose();
    this.emitter.dispose();
  }
}
