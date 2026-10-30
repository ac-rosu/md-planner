// AI commands. Each one builds a request from the computed plan data, validates the JSON reply,
// and shows the result as a proposal (diff with Accept / Reject) or as a read-only document.
import * as vscode from "vscode";
import {
  breakDownProposal,
  breakDownRequest,
  calibrateProposal,
  calibrateRequest,
  calibrationRows,
  estimateProposal,
  estimateRequest,
  ownersProposal,
  ownersRequest,
  planFromTextProposal,
  planFromTextRequest,
  readSummary,
  reviewMarkdown,
  scheduleReviewRequest,
  statusSummaryRequest,
  unassignedTasks,
} from "../../ai/commands";
import { type ProposalManager } from "../../ai/proposals";
import { AiError } from "../../ai/provider";
import { type AiService } from "../../ai/service";
import { describeAccuracy } from "../../core/metrics";
import { type Task } from "../../core/model";
import { isLeaf, ownerOf } from "../../core/rollup";
import { type BaselineService } from "../baselines";
import { type PlannerState } from "../state";
import { config } from "../util";
import { itemsInSelection, resolveTask, type TaskArg } from "./args";

export interface AiCommandDeps {
  ai: AiService;
  proposals: ProposalManager;
  state: PlannerState;
  baselines: BaselineService;
  memento: vscode.Memento;
}

/** Runs a command body and reports AI and validation errors to the user. */
async function guarded<T>(deps: AiCommandDeps, body: () => Promise<T>): Promise<T | undefined> {
  try {
    return await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ai.log.error(message);
    if (!(err instanceof AiError && message === "Cancelled."))
      void vscode.window.showErrorMessage(`Planner AI: ${message}`);
    return undefined;
  }
}

function openLeaves(tasks: Task[]): Task[] {
  return tasks.filter(
    (t) => t.kind === "task" && isLeaf(t) && t.status !== "done" && t.status !== "cancelled"
  );
}

export function registerAiCommands(deps: AiCommandDeps): vscode.Disposable[] {
  const { ai, proposals, state } = deps;
  const reg = vscode.commands.registerCommand;
  return [
    reg("planner.ai.setApiKey", () => ai.setApiKey()),
    reg("planner.proposal.accept", () => proposals.accept()),
    reg("planner.proposal.reject", () => proposals.reject()),

    reg("planner.ai.breakDown", (arg?: TaskArg) =>
      guarded(deps, async () => {
        const r = resolveTask(state.service, arg);
        if (!r || r.task.kind !== "task")
          throw new Error("Put the cursor on a task or select one in a view.");
        const { reply } = await ai.run(breakDownRequest(state.plan, state.schedule, r.task));
        // The ids of open proposals are taken: two proposals must not add the same ids.
        return proposals.show(breakDownProposal(state.plan, r.task, reply, proposals.reservedIds));
      })
    ),

    reg("planner.ai.estimate", (arg?: TaskArg) =>
      guarded(deps, async () => {
        const plan = state.plan;
        let tasks: Task[];
        if (arg) {
          const r = resolveTask(state.service, arg);
          tasks = r ? openLeaves([r.task]) : [];
        } else {
          const editor = vscode.window.activeTextEditor;
          const inFile = editor ? state.service.fileFor(editor.document) : undefined;
          const selected =
            editor && inFile ? openLeaves(itemsInSelection(state.service, editor)) : [];
          tasks = selected.filter((t) => t.est === undefined);
          if (selected.length === 1) tasks = selected;
          if (tasks.length === 0)
            tasks = openLeaves(inFile ? inFile.items : plan.tasks).filter(
              (t) => t.est === undefined
            );
        }
        if (tasks.length === 0) {
          void vscode.window.showInformationMessage(
            "Planner AI: no open tasks without an estimate here."
          );
          return false;
        }
        const { reply } = await ai.run(estimateRequest(plan, tasks.slice(0, 60)));
        return proposals.show(estimateProposal(plan, tasks.slice(0, 60), reply));
      })
    ),

    reg("planner.ai.calibrate", () =>
      guarded(deps, async () => {
        const plan = state.plan;
        const { rows, accuracy } = calibrationRows(plan);
        if (rows.length === 0) {
          const lines = [
            describeAccuracy(accuracy.overall, "All completed tasks"),
            ...accuracy.byPerson.map((r) =>
              describeAccuracy(r, plan.personById(r.key)?.name ?? r.key)
            ),
            ...accuracy.byTag.map((r) => describeAccuracy(r, `#${r.key}`)),
          ];
          ai.log.info(
            `Calibration: nothing to change (needs at least 3 completed tasks per person or tag with a 10 % deviation).\n${lines.join("\n")}`
          );
          void vscode.window.showInformationMessage(
            "Planner AI: no open estimates to calibrate yet (needs 3+ completed tasks per person or tag).",
            { detail: lines.join("\n"), modal: false }
          );
          return false;
        }
        const { reply } = await ai.run(calibrateRequest(plan, rows, accuracy));
        return proposals.show(calibrateProposal(plan, rows, reply));
      })
    ),

    reg("planner.ai.suggestOwners", (arg?: TaskArg) =>
      guarded(deps, async () => {
        const plan = state.plan;
        const r = arg ? resolveTask(state.service, arg) : undefined;
        const tasks = r ? openLeaves([r.task]).filter((t) => !ownerOf(t)) : unassignedTasks(plan);
        if (tasks.length === 0) {
          void vscode.window.showInformationMessage("Planner AI: every open task has an owner.");
          return false;
        }
        if (plan.people.length === 0) throw new Error("team.md has no people to assign.");
        const { reply } = await ai.run(ownersRequest(plan, state.schedule, tasks.slice(0, 60)));
        return proposals.show(ownersProposal(plan, tasks.slice(0, 60), reply));
      })
    ),

    reg("planner.ai.planFromText", (arg?: { text?: string; milestone?: string }) =>
      guarded(deps, async () => {
        const plan = state.plan;
        const text = arg?.text ?? (await pickScopeText());
        if (!text?.trim()) return false;
        let milestoneId = arg?.milestone;
        if (!milestoneId) {
          const pick = await vscode.window.showQuickPick(
            plan.milestones
              .filter((m) => m.status !== "done" && m.status !== "cancelled")
              .map((m) => ({
                label: m.title,
                description: m.target ? `target ${m.target}` : undefined,
                id: m.id,
              })),
            { placeHolder: "Plan the new tasks into milestone…" }
          );
          if (!pick) return false;
          milestoneId = pick.id;
        }
        const milestone = plan.milestoneById(milestoneId);
        if (!milestone) throw new Error(`Unknown milestone ${milestoneId}.`);
        const { reply } = await ai.run(planFromTextRequest(plan, milestone, text));
        return proposals.show(planFromTextProposal(plan, milestone, reply, proposals.reservedIds));
      })
    ),

    reg("planner.ai.statusSummary", () =>
      guarded(deps, async () => {
        const summary = await draftSummary(deps);
        if (summary === undefined) return undefined;
        const edited = await vscode.window.showInputBox({
          title: "Status summary (drafted by AI – edit before use)",
          value: summary,
          ignoreFocusOut: true,
        });
        if (edited === undefined) return undefined;
        await deps.memento.update("export.summary", edited);
        const choice = await vscode.window.showInformationMessage(
          "Planner: summary saved for the next report.",
          "Export report now",
          "Copy"
        );
        if (choice === "Copy") await vscode.env.clipboard.writeText(edited);
        if (choice === "Export report now")
          await vscode.commands.executeCommand("planner.export", { summary: edited });
        return edited;
      })
    ),

    reg("planner.ai.scheduleReview", () =>
      guarded(deps, async () => {
        const { reply, model } = await ai.run(
          scheduleReviewRequest(state.plan, state.schedule, state.demand)
        );
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: reviewMarkdown(state.plan, reply, state.today, model),
        });
        await vscode.window.showTextDocument(doc, { preview: false });
        return doc;
      })
    ),
  ];
}

/** Drafts a status summary from the computed metrics (used by the command and by Export). */
export async function draftSummary(deps: AiCommandDeps): Promise<string | undefined> {
  const { state, ai, baselines } = deps;
  const { reply } = await ai.run(
    statusSummaryRequest(
      state.plan,
      state.schedule,
      baselines.get(undefined),
      config().get<number>("export.periodDays", 7)
    )
  );
  return readSummary(reply);
}

async function pickScopeText(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  const selection =
    editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
  const clipboard = await vscode.env.clipboard.readText();
  const items: Array<vscode.QuickPickItem & { id: string }> = [];
  if (selection.trim())
    items.push({
      id: "selection",
      label: "$(selection) Selected text",
      detail: preview(selection),
    });
  if (clipboard.trim())
    items.push({ id: "clipboard", label: "$(clippy) Clipboard", detail: preview(clipboard) });
  items.push({ id: "type", label: "$(edit) Type a short description" });
  const pick =
    items.length === 1
      ? items[0]
      : await vscode.window.showQuickPick(items, {
          placeHolder: "Scope description (FDS section, customer e-mail …)",
        });
  if (!pick) return undefined;
  if (pick.id === "selection") return selection;
  if (pick.id === "clipboard") return clipboard;
  return vscode.window.showInputBox({ prompt: "Describe the scope to plan", ignoreFocusOut: true });
}

function preview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}
