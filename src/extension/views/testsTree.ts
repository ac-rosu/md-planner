// Tests view: test plan → test case → step, with pass / fail / open counts.
import * as vscode from "vscode";
import { type Task, type TestCase, type TestPlan } from "../../core/model";
import { taskKey } from "../../core/scheduler";
import { countResults } from "../../core/testRun";
import { type PlannerState } from "../state";
import { md } from "../util";

export type TestNode =
  | { kind: "plan"; plan: TestPlan }
  | { kind: "case"; plan: TestPlan; tc: TestCase }
  | { kind: "step"; plan: TestPlan; step: Task };

const RESULT_ICON: Record<string, [string, string | undefined]> = {
  pass: ["pass-filled", "charts.green"],
  fail: ["error", "charts.red"],
  na: ["circle-slash", "charts.purple"],
  open: ["circle-large-outline", undefined],
};

export class TestsTreeProvider implements vscode.TreeDataProvider<TestNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TestNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposable: vscode.Disposable;

  constructor(private readonly state: PlannerState) {
    this.disposable = state.onDidUpdate(() => this.emitter.fire(undefined));
  }

  getChildren(node?: TestNode): TestNode[] {
    if (!node) return this.state.plan.tests.map((plan) => ({ kind: "plan", plan }));
    if (node.kind === "plan")
      return node.plan.cases.map((tc) => ({ kind: "case", plan: node.plan, tc }));
    if (node.kind === "case")
      return node.tc.steps
        .flatMap((s) => [s, ...s.children])
        .map((step) => ({ kind: "step", plan: node.plan, step }));
    return [];
  }

  getTreeItem(node: TestNode): vscode.TreeItem {
    const counts = (c: ReturnType<typeof countResults>) =>
      `${c.pass} pass${c.fail ? ` · ${c.fail} fail` : ""}${c.na ? ` · ${c.na} n.a.` : ""} · ${c.open} open`;
    switch (node.kind) {
      case "plan": {
        const c = countResults(node.plan);
        const item = new vscode.TreeItem(
          node.plan.title,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `test:${node.plan.id}`;
        item.description = counts(c);
        item.iconPath = new vscode.ThemeIcon(
          "beaker",
          c.fail
            ? new vscode.ThemeColor("charts.red")
            : c.open === 0 && c.steps
              ? new vscode.ThemeColor("charts.green")
              : undefined
        );
        item.tooltip = new vscode.MarkdownString(
          `**${md(node.plan.title)}**  \n${node.plan.id}${node.plan.type ? ` · ${node.plan.type}` : ""}${node.plan.milestone ? ` · ${node.plan.milestone}` : ""}  \n${counts(c)} (${c.steps} steps)` +
            (node.plan.runs.length
              ? `  \nRuns: ${node.plan.runs.map((r) => r.date || r.title).join(", ")}`
              : "")
        );
        item.contextValue = "testPlan";
        item.command = {
          command: "planner.openTestRunner",
          title: "Open in test runner",
          arguments: [node.plan.id],
        };
        return item;
      }
      case "case": {
        const c = countResults(node.tc);
        const item = new vscode.TreeItem(
          `${node.tc.id} ${node.tc.title}`,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `test:${node.plan.id}:${node.tc.id}`;
        item.description = counts(c);
        item.iconPath = new vscode.ThemeIcon(
          c.fail ? "error" : c.open === 0 && c.steps ? "pass" : "list-ordered",
          c.fail ? new vscode.ThemeColor("charts.red") : undefined
        );
        item.tooltip = node.tc.pre ? `Pre-condition: ${node.tc.pre}` : undefined;
        item.contextValue = "testCase";
        return item;
      }
      case "step": {
        const s = node.step;
        const result = s.result ?? "open";
        const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
        item.id = `test-step:${taskKey(s)}`;
        item.description = [s.note, s.punch ? `→ ${s.punch}` : ""].filter(Boolean).join(" ");
        const [icon, color] = RESULT_ICON[result];
        item.iconPath = new vscode.ThemeIcon(
          icon,
          color ? new vscode.ThemeColor(color) : undefined
        );
        item.contextValue = `testStep result-${result}`;
        item.command = {
          command: "planner.revealTask",
          title: "Reveal",
          arguments: [{ file: s.file, line: s.line }],
        };
        item.accessibilityInformation = {
          label: `${s.title}, ${result}${s.note ? `, ${s.note}` : ""}`,
        };
        return item;
      }
    }
  }

  dispose(): void {
    this.disposable.dispose();
    this.emitter.dispose();
  }
}
