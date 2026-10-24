// Dashboard panel host.
import * as vscode from "vscode";
import { findTaskByKey } from "../../core/scheduler";
import { buildDashboardModel } from "../../core/views/dashboard";
import { type DashboardToHost, type HostToDashboard } from "../../webview/shared/protocol";
import { type BaselineService } from "../baselines";
import { type PanelContext, WebviewPanelHost } from "./panel";
import { revealTaskInEditor } from "./reveal";

export class DashboardPanel extends WebviewPanelHost<HostToDashboard, DashboardToHost> {
  static current: DashboardPanel | undefined;
  private baseline: string | undefined;

  static show(ctx: PanelContext, baselines: BaselineService): DashboardPanel {
    if (DashboardPanel.current) DashboardPanel.current.panel.reveal();
    else {
      DashboardPanel.current = new DashboardPanel(ctx, baselines);
      DashboardPanel.current.onDidDispose(() => (DashboardPanel.current = undefined));
    }
    return DashboardPanel.current;
  }

  private constructor(
    ctx: PanelContext,
    private readonly baselines: BaselineService
  ) {
    super(ctx, "planner.dashboard", "Dashboard", "dashboard");
    this.baseline = ctx.memento.get<string>("dashboard.baseline");
    this.disposables.push(
      ctx.state.onDidUpdate(() => this.sendModel()),
      baselines.onDidChange(() => this.sendModel())
    );
    this.sendModel();
  }

  /** The model currently shown (also used by tests). */
  model() {
    const state = this.ctx.state;
    const names = this.baselines.names();
    const id =
      this.baseline && names.includes(this.baseline) ? this.baseline : names[names.length - 1];
    return {
      model: buildDashboardModel(state.plan, state.schedule, this.baselines.get(id)),
      baselines: names,
      baseline: id,
    };
  }

  sendModel(): void {
    this.panel.title = `Dashboard – ${this.ctx.state.plan.project.name}`;
    this.post({ type: "model", ...this.model() });
  }

  protected async onMessage(m: DashboardToHost): Promise<void> {
    switch (m.type) {
      case "ready":
        this.sendModel();
        return;
      case "baseline":
        this.baseline = m.name;
        await this.ctx.memento.update("dashboard.baseline", m.name);
        this.sendModel();
        return;
      case "saveBaseline":
        await vscode.commands.executeCommand("planner.saveBaseline");
        return;
      case "editProject":
        await vscode.commands.executeCommand("planner.editProject");
        return;
      case "open":
        await vscode.commands.executeCommand(
          m.view === "gantt"
            ? "planner.openGantt"
            : m.view === "kanban"
              ? "planner.openKanban"
              : m.view === "punch"
                ? "planner.openPunchBoard"
                : "planner.openResources"
        );
        return;
      case "reveal": {
        const t = findTaskByKey(this.ctx.state.plan, m.key);
        if (t) await revealTaskInEditor(this.ctx.state.service, t, this.editorColumn());
        return;
      }
      default:
        return;
    }
  }

  override dispose(): void {
    if (DashboardPanel.current === this) DashboardPanel.current = undefined;
    super.dispose();
  }
}
