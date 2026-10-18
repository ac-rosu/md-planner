// Team load heatmap panel.
import * as vscode from "vscode";
import { findTaskByKey } from "../../core/scheduler";
import { buildResourcesModel } from "../../core/views/resources";
import { type HostToResources, type ResourcesToHost } from "../../webview/shared/protocol";
import { type PanelContext, WebviewPanelHost } from "./panel";
import { revealTaskInEditor } from "./reveal";

export class ResourcesPanel extends WebviewPanelHost<HostToResources, ResourcesToHost> {
  static current: ResourcesPanel | undefined;
  private mode: "capacity" | "demand";

  static show(ctx: PanelContext): ResourcesPanel {
    if (ResourcesPanel.current) ResourcesPanel.current.panel.reveal();
    else {
      ResourcesPanel.current = new ResourcesPanel(ctx);
      ResourcesPanel.current.onDidDispose(() => (ResourcesPanel.current = undefined));
    }
    return ResourcesPanel.current;
  }

  private constructor(ctx: PanelContext) {
    super(ctx, "planner.resources", "Team load", "resources");
    this.mode = ctx.memento.get<"capacity" | "demand">("resources.mode") ?? "capacity";
    this.disposables.push(ctx.state.onDidUpdate(() => this.sendModel()));
    this.sendModel();
  }

  get viewMode(): "capacity" | "demand" {
    return this.mode;
  }

  /** The model currently shown (also used by tests). */
  model() {
    const state = this.ctx.state;
    return buildResourcesModel(state.plan, this.mode === "demand" ? state.demand : state.schedule);
  }

  sendModel(): void {
    this.panel.title = `Team load – ${this.ctx.state.plan.project.name}`;
    this.post({ type: "model", model: this.model() });
  }

  protected async onMessage(m: ResourcesToHost): Promise<void> {
    switch (m.type) {
      case "ready":
        this.sendModel();
        return;
      case "mode":
        this.mode = m.mode;
        await this.ctx.memento.update("resources.mode", m.mode);
        this.sendModel();
        return;
      case "reveal": {
        const t = findTaskByKey(this.ctx.state.plan, m.key);
        if (t) await revealTaskInEditor(this.ctx.state.service, t, this.editorColumn());
        return;
      }
      case "overtime":
        await vscode.commands.executeCommand("planner.addOvertime", m.person, { week: m.week });
        return;
      case "workday":
        await vscode.commands.executeCommand("planner.addWorkday", m.person, { week: m.week });
        return;
      default:
        return;
    }
  }

  override dispose(): void {
    if (ResourcesPanel.current === this) ResourcesPanel.current = undefined;
    super.dispose();
  }
}
