// Test runner panel host: records results, raises punch items and appends run logs.
import * as vscode from "vscode";
import { type ParsedFile, type Task, type TestPlan } from "../../core/model";
import { findTaskByKey } from "../../core/scheduler";
import {
  addPunchItem,
  appendRunLog,
  caseOfStep,
  linkStepToPunch,
  recordStepResult,
  resetResults,
  setStepNote,
  testPlanOfFile,
} from "../../core/testRun";
import { buildRunnerModel } from "../../core/views/testRunner";
import { type HostToRunner, type RunnerToHost } from "../../webview/shared/protocol";
import { config, encode } from "../util";
import { type PanelContext, WebviewPanelHost } from "./panel";
import { revealTaskInEditor } from "./reveal";

export class TestRunnerPanel extends WebviewPanelHost<HostToRunner, RunnerToHost> {
  static current: TestRunnerPanel | undefined;
  private planId: string | undefined;

  static show(ctx: PanelContext, planId?: string): TestRunnerPanel {
    if (TestRunnerPanel.current) TestRunnerPanel.current.panel.reveal();
    else {
      TestRunnerPanel.current = new TestRunnerPanel(ctx);
      TestRunnerPanel.current.onDidDispose(() => (TestRunnerPanel.current = undefined));
    }
    const panel = TestRunnerPanel.current;
    if (planId) panel.select(planId);
    return panel;
  }

  private constructor(ctx: PanelContext) {
    super(ctx, "planner.testRunner", "Test runner", "testRunner");
    this.planId = ctx.memento.get<string>("runner.plan") ?? ctx.state.plan.tests[0]?.id;
    this.disposables.push(ctx.state.onDidUpdate(() => this.sendModel()));
    this.sendModel();
  }

  get testPlan(): TestPlan | undefined {
    const plan = this.ctx.state.plan;
    return plan.testById(this.planId) ?? plan.tests[0];
  }

  select(id: string): void {
    this.planId = id;
    void this.ctx.memento.update("runner.plan", id);
    this.sendModel();
  }

  model() {
    const state = this.ctx.state;
    const me = config().get<string>("me", "") || state.plan.people[0]?.id;
    return buildRunnerModel(
      state.plan,
      this.testPlan,
      state.today,
      state.plan.personById(me)?.name ?? me
    );
  }

  sendModel(): void {
    const tp = this.testPlan;
    this.panel.title = tp ? `Test run – ${tp.id}` : "Test runner";
    this.post({ type: "model", model: this.model() });
  }

  protected async onMessage(m: RunnerToHost): Promise<void> {
    switch (m.type) {
      case "ready":
        this.sendModel();
        return;
      case "selectPlan":
        this.select(m.id);
        return;
      case "result":
        await this.result(m.step, m.result ?? undefined, m.note);
        return;
      case "note": {
        const { step, file } = this.step(m.step);
        await this.ctx.history.apply(
          [{ path: file.path, edits: setStepNote(file, step, m.note) }],
          `Note on ${step.title}`
        );
        return;
      }
      case "createPunch":
        await this.createPunch(m);
        return;
      case "finishRun":
        await this.finishRun(m.date, m.tester, m.witness);
        return;
      case "reset": {
        const tp = this.testPlan;
        if (!tp) return;
        const pick = await vscode.window.showWarningMessage(
          `Clear all results and notes of ${tp.id} for a new run? Punch links and run logs stay.`,
          { modal: true },
          "Reset results"
        );
        if (pick === "Reset results") await this.reset();
        return;
      }
      case "export": {
        const tp = this.testPlan;
        if (tp)
          await vscode.commands.executeCommand("planner.export", {
            formats: [m.format === "pdf" ? "test-report-pdf" : "test-report"],
            testPlan: tp.id,
          });
        return;
      }
      case "openFile": {
        const tp = this.testPlan;
        if (tp)
          await vscode.window.showTextDocument(this.ctx.state.service.uri(tp.file), {
            viewColumn: this.editorColumn(),
            preview: true,
          });
        return;
      }
      case "reveal": {
        const t = findTaskByKey(this.ctx.state.plan, m.key);
        if (t) await revealTaskInEditor(this.ctx.state.service, t, this.editorColumn());
        return;
      }
      default:
        return;
    }
  }

  private step(key: string): { step: Task; file: ParsedFile; tp: TestPlan } {
    const plan = this.ctx.state.plan;
    const step = findTaskByKey(plan, key);
    if (!step || step.kind !== "step") throw new Error(`Step ${key} no longer exists.`);
    const file = plan.file(step.file)!;
    const tp = testPlanOfFile(plan, step.file);
    if (!tp) throw new Error(`No test plan in ${step.file}.`);
    return { step, file, tp };
  }

  async result(
    key: string,
    result: "pass" | "fail" | "na" | undefined,
    note?: string
  ): Promise<boolean> {
    const { step, file } = this.step(key);
    return this.ctx.history.apply(
      [{ path: file.path, edits: recordStepResult(file, step, result, note) }],
      `${result ?? "Clear"}: ${step.title}`
    );
  }

  async createPunch(
    m: Extract<RunnerToHost, { type: "createPunch" }>
  ): Promise<string | undefined> {
    const plan = this.ctx.state.plan;
    const { step, file, tp } = this.step(m.step);
    const tc = caseOfStep(tp, step);
    const creation = addPunchItem(plan, {
      title: m.title,
      sev: m.sev,
      owner: m.owner,
      due: m.due,
      from: tc ? `${tp.id}/${tc.id}` : tp.id,
    });
    const link = { path: file.path, edits: linkStepToPunch(file, step, creation.id) };
    if (creation.create) {
      // punchlist.md does not exist yet: create it (undoable file creation), then link the step.
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(this.ctx.state.service.uri(creation.create.path), {
        contents: encode(creation.create.text),
        ignoreIfExists: true,
      });
      if (!(await vscode.workspace.applyEdit(edit)))
        throw new Error("Could not create punchlist.md");
      // The item is in the new file now, whether or not the step can be linked to it.
      if (!(await this.ctx.history.apply([link], `Link ${step.title} to ${creation.id}`))) {
        this.notice(
          "error",
          `Punch item ${creation.id} created in punchlist.md, but "${step.title}" was not linked to it: ${file.path} was not changed.`
        );
        return creation.id;
      }
    } else if (creation.edits) {
      // Refused (a file in another encoding, a merge conflict the user chose not to touch).
      const ok = await this.ctx.history.apply(
        [creation.edits, link],
        `Punch item ${creation.id} from ${tp.id}`
      );
      if (!ok) {
        this.notice("info", `Punch item ${creation.id} was not created: no file was changed.`);
        return undefined;
      }
    }
    this.notice("info", `Punch item ${creation.id} created in punchlist.md.`);
    return creation.id;
  }

  async finishRun(date: string, tester: string, witness?: string): Promise<boolean> {
    const tp = this.testPlan;
    if (!tp) return false;
    const file = this.ctx.state.plan.file(tp.file)!;
    const ok = await this.ctx.history.apply(
      [{ path: file.path, edits: [appendRunLog(file, tp, { date, tester, witness })] }],
      `Run log ${date} for ${tp.id}`
    );
    if (ok) this.notice("info", `Run ${date} appended to ${tp.file}.`);
    return ok;
  }

  async reset(): Promise<boolean> {
    const tp = this.testPlan;
    if (!tp) return false;
    const file = this.ctx.state.plan.file(tp.file)!;
    return this.ctx.history.apply(
      [{ path: file.path, edits: resetResults(file) }],
      `Reset results of ${tp.id}`
    );
  }

  override dispose(): void {
    if (TestRunnerPanel.current === this) TestRunnerPanel.current = undefined;
    super.dispose();
  }
}
