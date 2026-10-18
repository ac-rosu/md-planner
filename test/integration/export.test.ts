import * as assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { getApi, planUri, restorePlan, TODAY } from "./helpers";

describe("export", () => {
  const reports = () => planUri("reports").fsPath;

  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(() => rmSync(reports(), { recursive: true, force: true }));

  it("writes the selected formats to plan/reports/<date>-<name>.<ext>", async () => {
    const written = await vscode.commands.executeCommand<vscode.Uri[]>("planner.export", {
      formats: ["html", "xlsx", "mspdi", "csv"],
      sections: ["header", "summary", "milestones", "risks"],
      summary: "PLC development starts next week.",
      open: false,
    });
    assert.deepEqual(
      written.map((u) => u.path.split("/").pop()),
      [
        `${TODAY}-status-report.html`,
        `${TODAY}-plan.xlsx`,
        `${TODAY}-plan.xml`,
        `${TODAY}-tasks.csv`,
      ]
    );
    assert.deepEqual(readdirSync(reports()).sort(), [
      `${TODAY}-plan.xlsx`,
      `${TODAY}-plan.xml`,
      `${TODAY}-status-report.html`,
      `${TODAY}-tasks.csv`,
    ]);
    const html = readFileSync(join(reports(), `${TODAY}-status-report.html`), "utf8");
    assert.ok(html.includes("PLC development starts next week."));
    assert.ok(html.includes(">Blocked items and risks<"));
    assert.ok(!html.includes(">Team load"));
    assert.ok(html.includes("by Alex"), "author from planner.me");
  });

  it("exports the test report from the test runner", async () => {
    const written = await vscode.commands.executeCommand<vscode.Uri[]>("planner.export", {
      formats: ["test-report"],
      testPlan: "UAT-02",
      open: false,
    });
    assert.equal(written.length, 1);
    const html = readFileSync(written[0].fsPath, "utf8");
    assert.ok(html.includes("Test report – Go-live acceptance – Checkout"));
    assert.ok(html.includes("INCOMPLETE"));
  });
});
