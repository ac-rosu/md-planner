// The filter bar of a sidebar view: owner, tag, status, milestone and text, kept per view in
// workspace state and edited through quick picks.
import * as vscode from "vscode";
import { describeFilter, isEmptyFilter, type TaskFilter } from "../../core/filter";
import { STATUS_LABEL, STATUSES, type Status } from "../../core/model";
import { type PlanService } from "../planService";

export class ViewFilter implements vscode.Disposable {
  private value: TaskFilter;
  private readonly emitter = new vscode.EventEmitter<TaskFilter>();
  readonly onDidChange = this.emitter.event;

  constructor(
    readonly viewId: string,
    private readonly state: vscode.Memento,
    private readonly service: PlanService
  ) {
    this.value = state.get<TaskFilter>(`filter.${viewId}`) ?? {};
    void this.updateContext();
  }

  get filter(): TaskFilter {
    return this.value;
  }

  get description(): string {
    return describeFilter(this.value);
  }

  async set(filter: TaskFilter): Promise<void> {
    this.value = filter;
    await this.state.update(`filter.${this.viewId}`, filter);
    await this.updateContext();
    this.emitter.fire(filter);
  }

  clear(): Promise<void> {
    return this.set({});
  }

  /** Interactive editing: pick a dimension, then values. */
  async edit(): Promise<void> {
    const plan = this.service.plan;
    type Dim = "owner" | "tag" | "status" | "milestone" | "text" | "clear";
    const f = this.value;
    const items: Array<vscode.QuickPickItem & { dim: Dim }> = [
      { dim: "owner", label: "$(person) Owner", description: f.owner?.join(", ") },
      { dim: "tag", label: "$(tag) Tag", description: f.tag?.map((t) => `#${t}`).join(" ") },
      { dim: "status", label: "$(circle-large-outline) Status", description: f.status?.join(", ") },
      { dim: "milestone", label: "$(milestone) Milestone", description: f.milestone?.join(", ") },
      { dim: "text", label: "$(search) Text", description: f.text },
    ];
    if (!isEmptyFilter(f)) items.push({ dim: "clear", label: "$(clear-all) Clear filter" });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Filter: ${this.description || "none"}`,
    });
    if (!pick) return;
    const multi = async (
      options: Array<{ label: string; value: string; description?: string }>,
      current: string[] = []
    ) => {
      const chosen = await vscode.window.showQuickPick(
        options.map((o) => ({
          ...o,
          picked: current.some((c) => c.toLowerCase() === o.value.toLowerCase()),
        })),
        { canPickMany: true, placeHolder: "Select values (none = any)" }
      );
      return chosen?.map((c) => c.value);
    };
    switch (pick.dim) {
      case "owner": {
        const values = await multi(
          [
            ...plan.people.map((p) => ({ label: p.name, value: p.id, description: p.role })),
            { label: "Unassigned", value: "unassigned" },
          ],
          f.owner
        );
        if (values) await this.set({ ...f, owner: values });
        return;
      }
      case "tag": {
        const values = await multi(
          plan.tags.map((t) => ({ label: `#${t}`, value: t })),
          f.tag
        );
        if (values) await this.set({ ...f, tag: values });
        return;
      }
      case "status": {
        const values = await multi(
          STATUSES.map((s) => ({ label: STATUS_LABEL[s], value: s })),
          f.status
        );
        if (values) await this.set({ ...f, status: values as Status[] });
        return;
      }
      case "milestone": {
        const values = await multi(
          plan.milestones.map((m) => ({ label: m.title, value: m.id })),
          f.milestone
        );
        if (values) await this.set({ ...f, milestone: values });
        return;
      }
      case "text": {
        const text = await vscode.window.showInputBox({
          prompt: "Filter text (all words must match)",
          value: f.text ?? "",
        });
        if (text !== undefined) await this.set({ ...f, text });
        return;
      }
      case "clear":
        await this.clear();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private updateContext(): Thenable<unknown> {
    return vscode.commands.executeCommand(
      "setContext",
      `planner.filtered.${this.viewId}`,
      !isEmptyFilter(this.value)
    );
  }
}

/** Applies the filter description as the tree view message. */
export function showFilterMessage(view: vscode.TreeView<unknown>, filter: ViewFilter): void {
  const d = filter.description;
  view.message = d ? `Filter: ${d}` : undefined;
}
