import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { docText, getApi, restorePlan, TODAY } from "./helpers";

const M2 = "milestones/M2-backend.md";

function line(id: string): string {
  return docText(M2)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

describe("done dates for work entered afterwards", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);

  it("sets a status on the day it happened, and the parent follows on the subtasks' days", async () => {
    await vscode.commands.executeCommand(
      "planner.setStatus",
      "T104",
      "done",
      undefined,
      undefined,
      undefined,
      "2026-10-12"
    );
    assert.match(line("T104"), /\[x\] Order events schema @est:6h @done:2026-10-12 \^T104$/);
    // T103 finished on 10-13, T104 on 10-12: the parent finished with the last one.
    assert.match(line("T102"), /^- \[x\] .*@done:2026-10-13 .*\^T102$/);
  });

  it("marks a task done on a day, and corrects that day", async () => {
    await vscode.commands.executeCommand("planner.doneOn", "T121", "2026-10-07");
    assert.match(line("T121"), /^- \[x\] .*@done:2026-10-07 .*\^T121$/);
    await vscode.commands.executeCommand("planner.doneOn", "T121", "2026-10-08");
    assert.match(line("T121"), /@done:2026-10-08 /);
    assert.doesNotMatch(line("T121"), /2026-10-07/);
  });

  it("marks the open tasks of a section done on one day, leaving cancelled work", async () => {
    const ok = await vscode.commands.executeCommand(
      "planner.markOpenDone",
      { milestone: "M2", section: "Billing" },
      "2026-10-02"
    );
    assert.equal(ok, true);
    assert.match(line("T113"), /^- \[x\] .*@done:2026-10-02 .*\^T113$/);
    assert.match(line("T114"), /^- \[x\] .*@done:2026-10-02 .*\^T114$/);
    assert.match(line("T115"), /^- \[-\] /);
  });

  it("ignores a day after today", async () => {
    await vscode.commands.executeCommand(
      "planner.setStatus",
      "T122",
      "done",
      undefined,
      undefined,
      true,
      "2099-01-01"
    );
    assert.match(line("T122"), new RegExp(`@done:${TODAY} `));
  });
});
