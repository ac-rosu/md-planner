// AI proposals: the proposed file contents are shown as a diff against the current files, and
// nothing is written until the user accepts. Accepting applies the same minimal edits as a normal
// (undoable) WorkspaceEdit; rejecting discards them.
import * as vscode from "vscode";
import { applyEdits } from "../core/text";
import { type EditHistory } from "../extension/editHistory";
import { type PlanService } from "../extension/planService";
import { type Proposal, takenIds } from "./commands";

export const PROPOSAL_SCHEME = "planner-proposal";

interface Pending {
  id: number;
  proposal: Proposal;
  base: Map<string, string>;
  proposed: Map<string, string>;
  resolve: (accepted: boolean) => void;
}

export class ProposalManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly service: PlanService,
    private readonly history: EditHistory,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.disposables.push(
      this.emitter,
      vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, this)
    );
  }

  /** Ids of proposals waiting for a decision (newest last). */
  get open(): number[] {
    return [...this.pending.keys()];
  }

  /** The task ids that open proposals add: a new proposal must not give them out again. */
  get reservedIds(): Set<string> {
    return new Set([...this.pending.values()].flatMap((p) => p.proposal.ids ?? []));
  }

  proposalText(id: number, path: string): string | undefined {
    return this.pending.get(id)?.proposed.get(path);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const [, id, ...rest] = uri.path.split("/");
    return this.pending.get(Number(id))?.proposed.get(rest.join("/")) ?? "";
  }

  /**
   * Shows the proposal and resolves true when accepted (and applied), false when rejected.
   * `interactive: false` skips the notification (tests decide through accept()/reject()).
   */
  async show(proposal: Proposal, options: { interactive?: boolean } = {}): Promise<boolean> {
    const edits = proposal.edits.filter((e) => e.edits.length > 0);
    if (edits.length === 0) {
      void vscode.window.showInformationMessage(
        `Planner AI: nothing to change.${proposal.warnings.length ? ` ${proposal.warnings[0]}` : ""}`
      );
      return false;
    }
    const base = new Map<string, string>();
    const proposed = new Map<string, string>();
    for (const fe of edits) {
      const file = this.service.index.get(fe.path);
      if (!file) throw new Error(`Not a plan file: ${fe.path}`);
      base.set(fe.path, file.lines.text);
      proposed.set(fe.path, applyEdits(file.lines.text, fe.edits));
    }
    const id = this.next++;
    const result = new Promise<boolean>((resolve) =>
      this.pending.set(id, { id, proposal: { ...proposal, edits }, base, proposed, resolve })
    );
    this.log.info(
      `Proposal #${id}: ${proposal.title}\n${proposal.notes.map((n) => `  ${n}`).join("\n")}${proposal.warnings.length ? `\nCorrected or rejected parts of the reply:\n${proposal.warnings.map((w) => `  ! ${w}`).join("\n")}` : ""}`
    );
    void vscode.commands.executeCommand("setContext", "planner.hasProposal", true);
    for (const path of proposed.keys()) {
      const right = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${id}/${path}` });
      await vscode.commands.executeCommand(
        "vscode.diff",
        this.service.uri(path),
        right,
        `AI proposal: ${proposal.title} (${path.split("/").pop()})`,
        { preview: false }
      );
    }
    if (options.interactive !== false) {
      this.log.show(true);
      const detail = [
        ...proposal.notes.slice(0, 3),
        ...(proposal.notes.length > 3
          ? [`… ${proposal.notes.length - 3} more in the Planner AI output`]
          : []),
      ].join("\n");
      void vscode.window
        .showInformationMessage(
          `Planner AI proposal: ${proposal.title}`,
          { detail, modal: false },
          "Accept",
          "Reject"
        )
        .then((choice) => {
          if (!this.pending.has(id)) return;
          if (choice === "Accept") void this.accept(id);
          else if (choice === "Reject") void this.reject(id);
        });
    }
    return result;
  }

  /**
   * Applies a proposal if the files did not change since it was made and the ids of its new tasks
   * are still free (another file may have given them out meanwhile).
   */
  async accept(id = this.latest()): Promise<boolean> {
    const p = id === undefined ? undefined : this.pending.get(id);
    if (!p) return false;
    for (const [path, text] of p.base) {
      if (this.service.index.get(path)?.lines.text !== text) {
        this.finish(p, false);
        void vscode.window.showWarningMessage(
          `Planner AI: ${path} changed since the proposal was made; nothing was applied. Run the command again.`
        );
        return false;
      }
    }
    const taken = takenIds(this.service.plan, p.proposal.ids ?? []);
    if (taken.length) {
      this.finish(p, false);
      void vscode.window.showWarningMessage(
        `Planner AI: the proposal's new ${taken.length === 1 ? "id" : "ids"} ${taken.join(", ")} ${taken.length === 1 ? "is" : "are"} now used by other tasks in the plan; nothing was applied. Run the command again.`
      );
      return false;
    }
    const ok = await this.history.apply(p.proposal.edits, `AI: ${p.proposal.title}`);
    this.finish(p, ok);
    if (ok)
      void vscode.window.setStatusBarMessage(`Planner AI: applied "${p.proposal.title}"`, 4000);
    return ok;
  }

  async reject(id = this.latest()): Promise<boolean> {
    const p = id === undefined ? undefined : this.pending.get(id);
    if (!p) return false;
    this.finish(p, false);
    return true;
  }

  private latest(): number | undefined {
    const ids = this.open;
    return ids[ids.length - 1];
  }

  private finish(p: Pending, accepted: boolean): void {
    this.pending.delete(p.id);
    this.log.info(`Proposal #${p.id} ${accepted ? "accepted" : "rejected"}.`);
    void vscode.commands.executeCommand("setContext", "planner.hasProposal", this.pending.size > 0);
    void this.closeDiffs(p.id);
    p.resolve(accepted);
  }

  private async closeDiffs(id: number): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputTextDiff &&
          input.modified.scheme === PROPOSAL_SCHEME &&
          input.modified.path.startsWith(`/${id}/`)
        ) {
          await vscode.window.tabGroups.close(tab, true);
        }
      }
    }
  }

  dispose(): void {
    for (const p of [...this.pending.values()]) this.finish(p, false);
    for (const d of this.disposables) d.dispose();
  }
}
