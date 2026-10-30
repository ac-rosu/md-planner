import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { type AiProvider, type AiRequest } from "../../src/ai/provider";
import { docText, getApi, planUri, restorePlan, waitFor } from "./helpers";

const M2 = "milestones/M2-backend.md";

/** Test double for an AI provider: answers with canned JSON and records the requests. */
class CannedProvider implements AiProvider {
  readonly label = "test provider";
  readonly requests: AiRequest[] = [];
  constructor(private readonly reply: (r: AiRequest) => unknown) {}
  async complete(request: AiRequest): Promise<string> {
    this.requests.push(request);
    return JSON.stringify(this.reply(request));
  }
}

function line(rel: string, id: string): string {
  return docText(rel)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

describe("AI proposals", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(async () => {
    const api = await getApi();
    for (const id of api.proposals.open) await api.proposals.reject(id);
    api.ai.useProvider(undefined);
    await restorePlan();
  });

  it("shows an estimate proposal as a diff and writes nothing until accepted", async () => {
    const api = await getApi();
    const provider = new CannedProvider(() => ({
      estimates: [{ id: "T121", estimate: "4d", rationale: "12 CM types" }],
    }));
    api.ai.useProvider(provider);
    const before = readFileSync(planUri(M2).fsPath, "utf8");
    const done = vscode.commands.executeCommand<boolean>("planner.ai.estimate", "T121");
    const id = await waitFor(() => api.proposals.open[0], "proposal");
    assert.equal(provider.requests[0].purpose, "estimate");
    // The proposal exists only as a virtual document; the plan file is untouched.
    assert.equal(readFileSync(planUri(M2).fsPath, "utf8"), before);
    assert.equal(docText(M2), before);
    assert.match(
      api.proposals.proposalText(id, M2)!,
      /Shared API library \(auth, validation, logging\) @est:4d @owner:sam #backend \^T121/
    );
    const diffTab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputTextDiff);
    assert.ok(diffTab, "a diff editor is open");
    assert.ok(await api.proposals.accept(id));
    assert.equal(await done, true);
    assert.equal(
      line(M2, "T121"),
      "- [ ] Shared API library (auth, validation, logging) @est:4d @owner:sam #backend ^T121"
    );
  });

  it("discards a rejected proposal", async () => {
    const api = await getApi();
    api.ai.useProvider(
      new CannedProvider(() => ({
        assignments: [{ id: "T112", owner: "alex", reason: "Owns the account services." }],
      }))
    );
    const before = docText(M2);
    const done = vscode.commands.executeCommand<boolean>("planner.ai.suggestOwners", "T112");
    const id = await waitFor(() => api.proposals.open[0], "proposal");
    await api.proposals.reject(id);
    assert.equal(await done, false);
    assert.equal(docText(M2), before);
    assert.equal(readFileSync(planUri(M2).fsPath, "utf8"), before);
  });

  it("refuses to apply a proposal when the file changed meanwhile", async () => {
    const api = await getApi();
    api.ai.useProvider(
      new CannedProvider(() => ({
        rationale: "two steps",
        subtasks: [
          {
            ref: "N1",
            title: "Fill",
            estimate: "1d",
            tags: [],
            owner: "",
            dependsOn: [],
            notes: "",
          },
          {
            ref: "N2",
            title: "Cap",
            estimate: "1d",
            tags: [],
            owner: "",
            dependsOn: ["N1"],
            notes: "",
          },
        ],
      }))
    );
    void vscode.commands.executeCommand("planner.ai.breakDown", "T107");
    const id = await waitFor(() => api.proposals.open[0], "proposal");
    await vscode.commands.executeCommand("planner.assignOwner", "T107", "sam");
    await waitFor(() => api.state.plan.taskById("T107")?.owner === "sam", "index");
    const changed = docText(M2);
    assert.equal(await api.proposals.accept(id), false);
    assert.equal(docText(M2), changed);
    assert.equal(api.proposals.open.length, 0);
  });

  it("gives open proposals their own ids and refuses one whose ids were taken meanwhile", async () => {
    const api = await getApi();
    const step = (ref: string, title: string, dependsOn: string[]) => ({
      ref,
      title,
      estimate: "1d",
      tags: [],
      owner: "",
      dependsOn,
      notes: "",
    });
    api.ai.useProvider(
      new CannedProvider(() => ({
        rationale: "two steps",
        subtasks: [step("N1", "First", []), step("N2", "Second", ["N1"])],
      }))
    );
    const M1 = "milestones/M1-discovery-design.md";
    const M3 = "milestones/M3-frontend.md";
    const first = vscode.commands.executeCommand<boolean>("planner.ai.breakDown", "T107");
    const a = await waitFor(() => api.proposals.open[0], "first proposal");
    const second = vscode.commands.executeCommand<boolean>("planner.ai.breakDown", "T012");
    const b = await waitFor(() => api.proposals.open[1], "second proposal");
    assert.match(
      api.proposals.proposalText(a, M2)!,
      /First @est:1d \^T408\n.*Second @est:1d @dep:T408 \^T409\n/
    );
    assert.match(
      api.proposals.proposalText(b, M1)!,
      /First @est:1d \^T410\n.*Second @est:1d @dep:T410 \^T411\n/
    );
    // A task typed in another file takes T410 before the second proposal is accepted.
    const doc = await vscode.workspace.openTextDocument(planUri(M3));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(planUri(M3), doc.lineAt(doc.lineCount - 1).range.end, "\n- [ ] Typed ^T410\n");
    await vscode.workspace.applyEdit(edit);
    await waitFor(() => api.service.plan.taskById("T410"), "typed task");
    const m1 = docText(M1);
    assert.equal(await api.proposals.accept(b), false);
    assert.equal(await second, false);
    assert.equal(docText(M1), m1);
    assert.ok(await api.proposals.accept(a));
    assert.equal(await first, true);
    assert.match(docText(M2), /First @est:1d \^T408\n/);
  });

  it("breaks a task down into subtasks after Accept, undoable in one step", async () => {
    const api = await getApi();
    api.ai.useProvider(
      new CannedProvider(() => ({
        rationale: "phases",
        subtasks: [
          {
            ref: "N1",
            title: "Fill phase",
            estimate: "12h",
            tags: [],
            owner: "",
            dependsOn: [],
            notes: "",
          },
          {
            ref: "N2",
            title: "Cap phase",
            estimate: "12h",
            tags: [],
            owner: "",
            dependsOn: ["N1"],
            notes: "",
          },
        ],
      }))
    );
    const before = docText(M2);
    const done = vscode.commands.executeCommand<boolean>("planner.ai.breakDown", "T107");
    await waitFor(() => api.proposals.open[0], "proposal");
    await vscode.commands.executeCommand("planner.proposal.accept");
    await waitFor(() => api.proposals.open.length === 0, "decided");
    assert.equal(await done, true);
    assert.match(
      docText(M2),
      /\^T107\n {2}- \[ \] Fill phase @est:12h \^T408\n {2}- \[ \] Cap phase @est:12h @dep:T408 \^T409\n/
    );
    await api.history.undo();
    assert.equal(docText(M2), before);
  });

  it("drafts a status summary from metrics only", async () => {
    const api = await getApi();
    const provider = new CannedProvider(() => ({ summary: "Discovery on track." }));
    api.ai.useProvider(provider);
    const { draftSummary } = await import("../../src/extension/commands/ai");
    const text = await draftSummary({
      ai: api.ai,
      proposals: api.proposals,
      state: api.state,
      baselines: api.baselines,
      memento: undefined as never,
    });
    assert.equal(text, "Discovery on track.");
    assert.match(provider.requests[0].prompt, /Overall: \d+% complete/);
    // planner.ai.redact in the sample settings removes the project name before sending.
    assert.match(provider.requests[0].prompt, /"\[redacted\]"/);
    assert.doesNotMatch(provider.requests[0].prompt, /Customer Portal 2.0/i);
  });
});
