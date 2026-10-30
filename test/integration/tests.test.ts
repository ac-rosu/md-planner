import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { type TestNode } from "../../src/extension/views/testsTree";
import { type TodoNode } from "../../src/extension/views/todosTree";
import { type TestRunnerPanel } from "../../src/extension/webviews/testRunnerPanel";
import {
  docText,
  getApi,
  planUri,
  positionOf,
  restorePlan,
  TODAY,
  waitFor,
  workspaceDir,
} from "./helpers";

const UAT = "tests/UAT-01-checkout.md";

function fatLine(start: string): string {
  return docText(UAT)
    .split("\n")
    .find((l) => l.includes(start))!;
}

async function openRunner(): Promise<TestRunnerPanel> {
  const api = await getApi();
  await vscode.commands.executeCommand("planner.openTestRunner", "UAT-01");
  return waitFor(() => api.testRunner(), "runner");
}

const STEP_STOP = "tests/UAT-01-checkout.md#15"; // "Order appears in the order history"
const STEP_DECLINED = "tests/UAT-01-checkout.md#19"; // "Declined card → …"

describe("test plans, runner and TODOs", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);

  it("shows test plans, cases and steps with counts", async () => {
    const api = await getApi();
    const plans = api.tests.getChildren() as Array<Extract<TestNode, { kind: "plan" }>>;
    assert.deepEqual(
      plans.map((p) => p.plan.id),
      ["UAT-01", "UAT-02"]
    );
    assert.equal(api.tests.getTreeItem(plans[0]).description, "1 pass · 1 fail · 2 open");
    const cases = api.tests.getChildren(plans[0]);
    assert.equal(api.tests.getTreeItem(cases[0]).label, "TC-01 Successful purchase");
    const steps = api.tests.getChildren(cases[0]);
    assert.equal(api.tests.getTreeItem(steps[1]).description, "confirmation after 3.5 s → P007");
  });

  it("records results and notes from the runner", async () => {
    const runner = await openRunner();
    assert.equal(runner.testPlan?.id, "UAT-01");
    await runner.receive({ type: "result", step: STEP_STOP, result: "pass" });
    assert.equal(fatLine("Order appears"), "- [x] Order appears in the order history @result:pass");
    await runner.receive({
      type: "result",
      step: STEP_DECLINED,
      result: "fail",
      note: "error message missing",
    });
    assert.equal(
      fatLine("Declined card →"),
      '- [x] Declined card → clear error message, the cart is kept @result:fail @note:"error message missing"'
    );
    await runner.receive({ type: "undo" });
    assert.equal(
      fatLine("Declined card →"),
      "- [ ] Declined card → clear error message, the cart is kept"
    );
  });

  it("does not say a punch item was created when the change was refused", async () => {
    const api = await getApi();
    const runner = await openRunner();
    const notices: string[] = [];
    const post = runner.post.bind(runner);
    runner.post = (m) => {
      if (m.type === "notice") notices.push(m.message);
      post(m);
    };
    const punch = docText("punchlist.md");
    // As when the question about merge conflict markers is cancelled.
    const apply = api.service.apply.bind(api.service);
    api.service.apply = () => Promise.resolve(false);
    try {
      await runner.receive({
        type: "createPunch",
        step: STEP_DECLINED,
        title: "No error message for a declined card",
        sev: "A",
      });
    } finally {
      api.service.apply = apply;
    }
    assert.equal(docText("punchlist.md"), punch);
    assert.deepEqual(notices, ["Punch item P008 was not created: no file was changed."]);
  });

  it("creates a punch item from a failed step with a back-link", async () => {
    const api = await getApi();
    const runner = await openRunner();
    await runner.receive({ type: "result", step: STEP_DECLINED, result: "fail" });
    await waitFor(
      () => api.state.plan.testById("UAT-01")?.cases[1].steps[0].result === "fail",
      "index"
    );
    await runner.receive({
      type: "createPunch",
      step: STEP_DECLINED,
      title: "No error message for a declined card",
      sev: "A",
      owner: "sam",
    });
    assert.match(
      docText("punchlist.md"),
      /- \[ \] No error message for a declined card @sev:A @owner:sam @from:UAT-01\/TC-02 \^P008\n$/
    );
    assert.equal(
      fatLine("Declined card →"),
      "- [x] Declined card → clear error message, the cart is kept @result:fail @punch:P008"
    );
  });

  it("appends a run log and resets results for a new run", async () => {
    const api = await getApi();
    const runner = await openRunner();
    await runner.finishRun("2027-01-20", "Alex", "Customer key users");
    assert.ok(
      docText(UAT).endsWith(
        "## Run 2027-01-20\n\ntester: Alex\nwitness: Customer key users\nresult: 1 pass, 1 fail, 0 n.a., 2 open (4 steps)\nfailed: TC-01\npunch: P007\n"
      )
    );
    await waitFor(() => api.state.plan.testById("UAT-01")?.runs.length === 2, "runs");
    await runner.reset();
    assert.equal(
      fatLine("Pay with a test card"),
      "- [ ] Pay with a test card → confirmation within 2 s @punch:P007"
    );
    assert.equal(
      fatLine("Add a product"),
      "- [ ] Add a product and open the cart → total with VAT shown"
    );
  });

  it("lists TODO comments in code, including linked ones", async () => {
    const api = await getApi();
    await api.todoScanner.scanAll();
    const files = api.todos.getChildren() as Array<Extract<TodoNode, { kind: "file" }>>;
    assert.deepEqual(
      files.map((f) => f.file.path),
      ["src/server/invoices.ts", "src/server/payments.ts", "src/web/paymentForm.ts"]
    );
    const invoices = api.todos.getChildren(files[0]);
    assert.match(String(api.todos.getTreeItem(invoices[0]).description), /line 8 · → T113 to do/);
  });

  it("promotes a FIXME to a task and links the comment both ways", async () => {
    const api = await getApi();
    await api.todoScanner.scanAll();
    const source = vscode.Uri.file(join(workspaceDir(), "src/server/payments.ts"));
    const original = readFileSync(source.fsPath, "utf8");
    try {
      const id = await vscode.commands.executeCommand<string>(
        "planner.promoteTodo",
        { uri: source, line: 19 },
        { milestone: "M2", section: "Checkout", owner: "sam" }
      );
      assert.equal(id, "T408");
      assert.match(
        docText("milestones/M2-backend.md"),
        /\^T108\n- \[ \] the amount is not checked against the cart total yet @owner:sam @src:src\/server\/payments.ts#L20 \^T408\n/
      );
      const doc = await vscode.workspace.openTextDocument(source);
      assert.equal(
        doc.lineAt(19).text,
        "  /* FIXME(T408): the amount is not checked against the cart total yet */"
      );
    } finally {
      const doc = await vscode.workspace.openTextDocument(source);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(source, new vscode.Range(0, 0, doc.lineCount, 0), original);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    }
    void TODAY;
  });

  it("navigates from @src to the code", async () => {
    const pos = await positionOf("milestones/M2-backend.md", "@src:src/server/invoices.ts", 8);
    const defs = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeDefinitionProvider",
      planUri("milestones/M2-backend.md"),
      pos
    );
    assert.equal(defs.length, 1);
    assert.ok(defs[0].uri.fsPath.endsWith(join("src", "server", "invoices.ts")));
    assert.equal(defs[0].range.start.line, 7);
  });
});
