// Status bar: overdue and blocked counts (click → dashboard).
import * as vscode from "vscode";
import { blockedTasks, overdueTasks } from "../core/queries";
import { type PlannerState } from "./state";

export class PlannerStatusBar implements vscode.Disposable {
  readonly attention = vscode.window.createStatusBarItem(
    "planner.attention",
    vscode.StatusBarAlignment.Left,
    50
  );
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly state: PlannerState,
    private readonly attentionCommand: string
  ) {
    this.attention.name = "Planner: overdue and blocked";
    this.disposables.push(
      this.attention,
      state.onDidUpdate(() => this.update())
    );
    this.update();
  }

  update(): void {
    if (!this.state.service.root) {
      this.attention.hide();
      return;
    }
    const plan = this.state.plan;
    const overdue = overdueTasks(plan, this.state.today).length;
    const blocked = blockedTasks(plan).length;
    this.attention.text = `$(warning) ${overdue} overdue  $(circle-slash) ${blocked} blocked`;
    this.attention.tooltip = `${overdue} overdue and ${blocked} blocked tasks – click to open the dashboard`;
    this.attention.command = this.attentionCommand;
    this.attention.backgroundColor =
      overdue > 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.attention.accessibilityInformation = {
      label: `${overdue} overdue tasks, ${blocked} blocked tasks`,
    };
    this.attention.show();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
