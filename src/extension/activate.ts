// Extension entry point: wires the plan service, views, language features and commands.
import * as vscode from "vscode";
import { registerInboxCommands } from "./commands/inbox";
import { registerNewProjectCommand } from "./commands/newProject";
import { findById } from "./commands/args";
import { registerTaskCommands } from "./commands/tasks";
import { registerEditCommands } from "./commands/edit";
import { MilestonesDragAndDrop, registerOutlineCommands } from "./commands/outline";
import { registerTeamCommands } from "./commands/team";
import { PlanCodeActionProvider } from "./language/codeActions";
import { PlanCodeLensProvider } from "./language/codeLens";
import { PlanCompletionProvider } from "./language/completion";
import { PlanDiagnostics } from "./language/diagnostics";
import { FormatGuard } from "./formatGuard";
import { registerEditorIntegration } from "./language/editorIntegration";
import {
  PlanDefinitionProvider,
  PlanHoverProvider,
  PlanReferenceProvider,
  PlanRenameProvider,
} from "./language/navigation";
import { BaselineService, saveBaselineCommand } from "./baselines";
import { EditHistory } from "./editHistory";
import { TimerService } from "./timer";
import { TodoScanner } from "./todoScanner";
import { promoteTodoCommand, type TodoArg } from "./commands/todos";
import { type PlanIntoTarget } from "./commands/inbox";
import { TestsTreeProvider } from "./views/testsTree";
import { TodosTreeProvider } from "./views/todosTree";
import { TestRunnerPanel } from "./webviews/testRunnerPanel";
import { type ExportArgs, exportCommand } from "./commands/export";
import { AiService } from "../ai/service";
import { ProposalManager } from "../ai/proposals";
import { draftSummary, registerAiCommands } from "./commands/ai";
import { configureMcpCommand, refreshStableServer, registerMcpProvider } from "./mcp";
import { DashboardPanel } from "./webviews/dashboardPanel";
import { ResourcesPanel } from "./webviews/resourcesPanel";
import { PlanService } from "./planService";
import { PlannerState } from "./state";
import { PlannerStatusBar } from "./statusbar";
import { showFilterMessage, ViewFilter } from "./views/filter";
import { InboxTreeProvider } from "./views/inboxTree";
import { PunchTreeProvider } from "./views/punchTree";
import { KanbanPanel } from "./webviews/kanbanPanel";
import { type MilestoneNode, MilestonesTreeProvider } from "./views/milestonesTree";
import { TeamTreeProvider } from "./views/teamTree";
import { GanttPanel } from "./webviews/ganttPanel";
import { type PanelContext } from "./webviews/panel";
import { resolveTask, stringArg, type TaskArg } from "./commands/args";
import { taskKey } from "../core/scheduler";
import { kanbanCardKey } from "../core/views/kanban";

/** Returned from activate() for integration tests and other extensions. */
export interface PlannerApi {
  service: PlanService;
  state: PlannerState;
  milestones: MilestonesTreeProvider;
  /** Drag and drop of the Milestones view. */
  milestonesDnd: MilestonesDragAndDrop;
  /** Notices plan files rewritten by a formatter on save. */
  formatGuard: FormatGuard;
  team: TeamTreeProvider;
  inbox: InboxTreeProvider;
  punch: PunchTreeProvider;
  diagnostics: PlanDiagnostics;
  history: EditHistory;
  panels: PanelContext;
  /** The open Gantt panel, if any. */
  gantt(): GanttPanel | undefined;
  /** The open Kanban panel, if any. */
  kanban(): KanbanPanel | undefined;
  resources(): ResourcesPanel | undefined;
  dashboard(): DashboardPanel | undefined;
  baselines: BaselineService;
  timer: TimerService;
  tests: TestsTreeProvider;
  todos: TodosTreeProvider;
  todoScanner: TodoScanner;
  testRunner(): TestRunnerPanel | undefined;
  ai: AiService;
  proposals: ProposalManager;
  /** Pins "today" (ISO date) for deterministic tests; undefined restores the real date. */
  setToday(date: string | undefined): void;
}

export async function activate(context: vscode.ExtensionContext): Promise<PlannerApi> {
  const log = vscode.window.createOutputChannel("Planner", { log: true });
  const service = new PlanService(log);
  const state = new PlannerState(service);
  const history = new EditHistory(service);
  context.subscriptions.push(log, service, state, history);
  const panels: PanelContext = {
    extensionUri: context.extensionUri,
    state,
    history,
    memento: context.workspaceState,
  };
  const baselines = new BaselineService(state);
  const ai = new AiService(context.secrets);
  const proposals = new ProposalManager(service, history, ai.log);
  const aiDeps = { ai, proposals, state, baselines, memento: context.workspaceState };
  context.subscriptions.push(ai, proposals);
  const timer = new TimerService(service, context.workspaceState);
  const todoScanner = new TodoScanner(service);
  const tests = new TestsTreeProvider(state);
  const todos = new TodosTreeProvider(todoScanner, state);
  const todosView = vscode.window.createTreeView("planner.todos", {
    treeDataProvider: todos,
    showCollapseAll: true,
  });
  todoScanner.onDidChange(
    () => (todosView.description = todoScanner.count ? String(todoScanner.count) : undefined)
  );
  context.subscriptions.push(
    baselines,
    timer,
    todoScanner,
    tests,
    todos,
    todosView,
    vscode.window.createTreeView("planner.tests", {
      treeDataProvider: tests,
      showCollapseAll: true,
    })
  );

  // Sidebar views
  const milestonesFilter = new ViewFilter("milestones", context.workspaceState, service);
  const teamFilter = new ViewFilter("team", context.workspaceState, service);
  const inboxFilter = new ViewFilter("inbox", context.workspaceState, service);
  const punchFilter = new ViewFilter("punch", context.workspaceState, service);
  const milestones = new MilestonesTreeProvider(state, milestonesFilter);
  const team = new TeamTreeProvider(state, teamFilter);
  const inbox = new InboxTreeProvider(state, inboxFilter);
  const punch = new PunchTreeProvider(state, punchFilter);
  const milestonesDnd = new MilestonesDragAndDrop(state);
  const milestonesView = vscode.window.createTreeView("planner.milestones", {
    treeDataProvider: milestones,
    showCollapseAll: true,
    dragAndDropController: milestonesDnd,
  });
  context.subscriptions.push(...registerOutlineCommands(state, milestonesView));
  const teamView = vscode.window.createTreeView("planner.team", {
    treeDataProvider: team,
    showCollapseAll: true,
  });
  const inboxView = vscode.window.createTreeView("planner.inbox", { treeDataProvider: inbox });
  const punchView = vscode.window.createTreeView("planner.punch", {
    treeDataProvider: punch,
    showCollapseAll: true,
  });
  const views: Array<[ViewFilter, vscode.TreeView<unknown>]> = [
    [milestonesFilter, milestonesView as vscode.TreeView<unknown>],
    [teamFilter, teamView as vscode.TreeView<unknown>],
    [inboxFilter, inboxView as vscode.TreeView<unknown>],
    [punchFilter, punchView as vscode.TreeView<unknown>],
  ];
  for (const [filter, view] of views) {
    showFilterMessage(view, filter);
    context.subscriptions.push(
      filter,
      view,
      filter.onDidChange(() => showFilterMessage(view, filter)),
      vscode.commands.registerCommand(`planner.${filter.viewId}.filter`, () => filter.edit()),
      vscode.commands.registerCommand(`planner.${filter.viewId}.clearFilter`, () => filter.clear())
    );
  }
  context.subscriptions.push(milestones, team, inbox, punch);

  // Notices when format on save rewrites a plan file.
  const formatGuard = new FormatGuard(service, context.workspaceState);
  context.subscriptions.push(formatGuard);

  // Language features for plan files
  const selector: vscode.DocumentSelector = [
    { language: "markdown", scheme: "file" },
    { language: "markdown", scheme: "untitled" },
  ];
  const diagnostics = new PlanDiagnostics(state);
  const codeLens = new PlanCodeLensProvider(state);
  context.subscriptions.push(
    diagnostics,
    codeLens,
    vscode.languages.registerCompletionItemProvider(
      selector,
      new PlanCompletionProvider(service),
      "@",
      ":",
      "#",
      ","
    ),
    vscode.languages.registerHoverProvider(selector, new PlanHoverProvider(state)),
    vscode.languages.registerDefinitionProvider(selector, new PlanDefinitionProvider(service)),
    vscode.languages.registerReferenceProvider(selector, new PlanReferenceProvider(service)),
    vscode.languages.registerRenameProvider(selector, new PlanRenameProvider(service)),
    vscode.languages.registerCodeLensProvider(selector, codeLens),
    vscode.languages.registerCodeActionsProvider(selector, new PlanCodeActionProvider(service), {
      providedCodeActionKinds: PlanCodeActionProvider.kinds,
    }),
    ...registerEditorIntegration(service, formatGuard)
  );

  // Commands
  context.subscriptions.push(
    ...registerTaskCommands(service),
    ...registerEditCommands(state),
    ...registerTeamCommands(state),
    ...registerInboxCommands(service),
    registerNewProjectCommand(context, service),
    vscode.commands.registerCommand("planner.refresh", () => service.locate()),
    vscode.commands.registerCommand("planner.openKanban", (arg?: TaskArg) => {
      const r = arg ? resolveTask(service, arg) : undefined;
      const board = r?.task.kind === "punch" ? "punch" : r ? "tasks" : undefined;
      // The card's own key: a copied line that kept its id has a card of its own.
      return KanbanPanel.show(panels, board, r ? kanbanCardKey(service.plan, r.task) : undefined);
    }),
    vscode.commands.registerCommand("planner.openPunchBoard", () =>
      KanbanPanel.show(panels, "punch")
    ),
    vscode.commands.registerCommand("planner.openGantt", (arg?: TaskArg) => {
      const r = arg ? resolveTask(service, arg) : undefined;
      return GanttPanel.show(panels, baselines, r ? taskKey(r.task) : undefined);
    }),
    vscode.commands.registerCommand("planner.openResources", () => ResourcesPanel.show(panels)),
    vscode.commands.registerCommand("planner.openDashboard", () =>
      DashboardPanel.show(panels, baselines)
    ),
    vscode.commands.registerCommand("planner.saveBaseline", (name?: unknown) =>
      saveBaselineCommand(baselines, stringArg(name))
    ),
    vscode.commands.registerCommand("planner.startTimer", (arg?: TaskArg) => timer.start(arg)),
    vscode.commands.registerCommand("planner.stopTimer", () => timer.stop()),
    vscode.commands.registerCommand("planner.logTime", (arg?: TaskArg, value?: unknown) =>
      timer.log(arg, typeof value === "number" ? value : stringArg(value))
    ),
    vscode.commands.registerCommand(
      "planner.openTestRunner",
      (planId?: string | { plan?: { id: string } }) =>
        TestRunnerPanel.show(panels, typeof planId === "string" ? planId : planId?.plan?.id)
    ),
    vscode.commands.registerCommand("planner.todos.refresh", () => todoScanner.scanAll()),
    vscode.commands.registerCommand("planner.export", (args?: ExportArgs) =>
      exportCommand(
        state,
        baselines,
        context.workspaceState,
        args,
        ai.enabled ? () => draftSummary(aiDeps) : undefined
      )
    ),
    ...registerAiCommands(aiDeps),
    vscode.commands.registerCommand("planner.configureMcp", () =>
      configureMcpCommand(context, service)
    ),
    // The user manual ships in the package (docs/manual) and opens in the Markdown preview, so it
    // works offline. The preview is locked: it keeps showing the manual when another Markdown file
    // becomes active, while links between the manual's pages still open in the same preview.
    vscode.commands.registerCommand("planner.openManual", () => {
      const readme = vscode.Uri.joinPath(context.extensionUri, "docs", "manual", "README.md");
      return vscode.commands.executeCommand("markdown.showPreview", readme, [readme], {
        locked: true,
      });
    }),
    vscode.commands.registerCommand(
      "planner.promoteTodo",
      (arg?: TodoArg, target?: PlanIntoTarget & { title?: string; owner?: string }) =>
        promoteTodoCommand(service, todoScanner, arg, target)
    ),
    vscode.commands.registerCommand(
      "planner.revealInTree",
      async (arg?: { milestone?: string; task?: string | { file: string; line: number } }) => {
        const plan = service.plan;
        let node: MilestoneNode | undefined;
        if (arg?.milestone) {
          const m = plan.milestoneById(arg.milestone);
          if (m) node = { kind: "milestone", milestone: m };
        } else if (arg?.task) {
          const t =
            typeof arg.task === "string"
              ? findById(plan, arg.task)
              : plan
                  .file(arg.task.file)
                  ?.items.find((x) => x.line === (arg.task as { line: number }).line);
          if (t && t.kind === "task") node = { kind: "task", task: t };
        }
        if (node) await milestonesView.reveal(node, { select: true, focus: true, expand: true });
      }
    )
  );

  // Status bar
  context.subscriptions.push(new PlannerStatusBar(state, "planner.openDashboard"));

  const mcpProvider = registerMcpProvider(context, service);
  if (mcpProvider) context.subscriptions.push(mcpProvider);
  void refreshStableServer(context).catch(() => undefined);

  await service.locate();
  void todoScanner.scanAll();
  return {
    service,
    state,
    milestones,
    milestonesDnd,
    formatGuard,
    team,
    inbox,
    punch,
    diagnostics,
    history,
    panels,
    gantt: () => GanttPanel.current,
    kanban: () => KanbanPanel.current,
    resources: () => ResourcesPanel.current,
    dashboard: () => DashboardPanel.current,
    baselines,
    timer,
    tests,
    todos,
    todoScanner,
    testRunner: () => TestRunnerPanel.current,
    ai,
    proposals,
    setToday: (date) => service.setToday(date),
  };
}
