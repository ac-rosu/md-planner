// The MCP tools on plan files that careless users and tools left behind: merge conflicts, other
// encodings, unreadable files, wrong-case names, and a configuration for a folder that is gone.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMilestones } from "../../../src/mcp/milestoneTools";
import { createProject, planOverview } from "../../../src/mcp/projectTools";
import { deleteTasks, updateTasks } from "../../../src/mcp/taskTools";
import { addPeople } from "../../../src/mcp/teamTools";
import { PlannerTools, ToolError } from "../../../src/mcp/tools";
import { md, TODAY } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01", "hoursPerDay: 8");
const TEAM = md("# Team", "", "## Alex", "", "id: alex");

/** A plan folder with the given files (text or bytes); defaults to project.md and team.md. */
function planWith(
  files: Record<string, string | Uint8Array>,
  base: Record<string, string> = { "project.md": PROJECT, "team.md": TEAM }
) {
  const planDir = join(mkdtempSync(join(tmpdir(), "planner-mcp-robust-")), "plan");
  mkdirSync(planDir, { recursive: true });
  for (const [rel, content] of Object.entries({ ...base, ...files })) {
    mkdirSync(dirname(join(planDir, rel)), { recursive: true });
    writeFileSync(join(planDir, rel), content);
  }
  return {
    planDir,
    tools: new PlannerTools({ planDir, today: TODAY }),
    bytes: (rel: string) => readFileSync(join(planDir, rel)),
    read: (rel: string) => readFileSync(join(planDir, rel), "utf8"),
  };
}

/** The ToolError a call throws. */
function refusal(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return (err as Error).message;
  }
  throw new Error("no error");
}

const M1 = "milestones/M1-a.md";

describe("MCP writes to files with merge conflict markers", () => {
  const conflicted = md(
    "# M1 – A",
    "",
    "id: M1",
    "",
    "- [ ] One @est:1h ^T1",
    "<<<<<<< HEAD",
    "- [ ] Two @est:2h ^T2",
    "=======",
    "- [ ] Two @est:4h ^T2",
    ">>>>>>> feature"
  );

  it("are refused with one error naming the file; nothing is written", () => {
    const { tools, read } = planWith({
      [M1]: conflicted,
      "milestones/M2-b.md": md("# M2 – B", "", "id: M2", "", "- [ ] Three @est:1h ^T3"),
    });
    expect(
      refusal(() =>
        updateTasks(tools, {
          updates: [
            { id: "T3", owner: "alex" },
            { id: "T1", owner: "alex" },
          ],
        })
      )
    ).toBe(
      "Nothing was written: milestones/M1-a.md has git merge conflict markers (lines 6, 8, 10). Resolve the conflict first: keep the lines you want and delete the <<<<<<<, ======= and >>>>>>> lines."
    );
    expect(read(M1)).toBe(conflicted);
    expect(read("milestones/M2-b.md")).not.toContain("@owner");
    expect(refusal(() => deleteTasks(tools, { ids: ["T1"] }))).toMatch(
      /^Nothing was written: milestones\/M1-a\.md has git merge conflict markers/
    );
    // Other files can still be changed, and the plan can be read and validated.
    updateTasks(tools, { updates: [{ id: "T3", owner: "alex" }] });
    expect(read("milestones/M2-b.md")).toContain("Three @est:1h @owner:alex ^T3");
    const v = tools.validatePlan();
    expect(v.issues.filter((i) => i.code === "merge-conflict")).toHaveLength(3);
  });
});

describe("MCP writes to files that are not UTF-8", () => {
  it("are refused, and the bytes stay as they were", () => {
    const text = md("# M1 – Café", "", "id: M1", "", "- [ ] Über die Brücke @est:1h ^T1");
    const latin1 = Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
    const { tools, bytes } = planWith({ [M1]: latin1 });
    expect(refusal(() => updateTasks(tools, { updates: [{ id: "T1", status: "doing" }] }))).toBe(
      "Nothing was written: milestones/M1-a.md is not UTF-8, so the planner does not change it (accented letters would be lost). Save it as UTF-8: Reopen with Encoding → Latin-1 (or the file's encoding), then Save with Encoding → UTF-8."
    );
    expect(Buffer.compare(bytes(M1), Buffer.from(latin1))).toBe(0);
    expect(tools.validatePlan().issues.map((i) => i.code)).toContain("not-utf8");
  });

  it("does not touch the bytes of UTF-8 files with a BOM", () => {
    const bom = "﻿" + md("# M1 – Café", "", "id: M1", "", "- [ ] Über @est:1h ^T1");
    const { tools, read } = planWith({ [M1]: bom });
    updateTasks(tools, { updates: [{ id: "T1", owner: "alex" }] });
    expect(read(M1)).toBe(bom.replace("@est:1h ^T1", "@est:1h @owner:alex ^T1"));
  });
});

describe("MCP with unreadable plan files", () => {
  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "reads the rest of the plan and reports the file",
    () => {
      const { tools, planDir } = planWith({
        [M1]: md("# M1 – A", "", "id: M1", "", "- [ ] One @est:1h ^T1"),
        "milestones/M2-b.md": md("# M2 – B", "", "id: M2", "", "- [ ] Two @est:1h ^T2"),
      });
      const locked = join(planDir, "milestones/M2-b.md");
      chmodSync(locked, 0o000);
      try {
        expect(tools.listTasks({}).tasks.map((t) => t.id)).toEqual(["T1"]);
        const v = tools.validatePlan();
        expect(v.issues.find((i) => i.code === "unreadable-file")).toMatchObject({
          severity: "warning",
          location: "milestones/M2-b.md:1:1",
        });
        updateTasks(tools, { updates: [{ id: "T1", owner: "alex" }] });
      } finally {
        chmodSync(locked, 0o644);
      }
    }
  );
});

describe("MCP with wrong-case plan file names", () => {
  it("reads them and writes into the files and folders that are there", () => {
    const { tools, read, planDir } = planWith(
      {
        "Project.md": PROJECT,
        "Team.md": TEAM,
        "Milestones/M1-a.md": md("# M1 – A", "", "id: M1", "", "- [ ] One @est:1h ^T1"),
      },
      {}
    );
    expect(tools.hasPlan()).toBe(true);
    expect(planOverview(tools)).toMatchObject({ exists: true, project: { hoursPerDay: 8 } });
    expect(tools.listTasks({}).tasks.map((t) => t.id)).toEqual(["T1"]);
    const people = addPeople(tools, { people: [{ name: "Sam" }] });
    expect(people.changed.map((c) => c.file)).toEqual(["Team.md"]);
    const created = createMilestones(tools, { milestones: [{ name: "Second" }] });
    expect(created.changed.map((c) => c.file)).toEqual(["Milestones/M2-second.md"]);
    expect(readdirSync(planDir).sort()).toEqual(["Milestones", "Project.md", "Team.md"]);
    expect(readdirSync(join(planDir, "Milestones")).sort()).toEqual(["M1-a.md", "M2-second.md"]);
    expect(read("Team.md")).toContain("## Sam");
    expect(tools.load().milestones.map((m) => m.id)).toEqual(["M1", "M2"]);
  });
});

describe("MCP with a plan folder that is gone", () => {
  it("says the configuration is out of date instead of offering to create a plan", () => {
    const gone = join(mkdtempSync(join(tmpdir(), "planner-mcp-gone-")), "moved-away");
    const planDir = join(gone, "plan");
    for (const tools of [
      new PlannerTools({ planDir, today: TODAY }),
      new PlannerTools({ planDir, workspaceDir: gone, today: TODAY }),
    ]) {
      const message = refusal(() => planOverview(tools));
      expect(message).toBe(
        `The plan folder ${planDir} does not exist, and neither does ${gone}: this MCP server is configured for a project that was moved or deleted. Re-run "Planner: Configure MCP for Claude Code" in VS Code (or fix the --plan path), then restart the server.`
      );
      expect(refusal(() => createProject(tools, { name: "X" }))).toBe(message);
      expect(refusal(() => tools.listTasks({}))).toBe(message);
      expect(existsSync(gone)).toBe(false);
    }
  });

  it("still offers to create a plan in a workspace without one", () => {
    const workspace = mkdtempSync(join(tmpdir(), "planner-mcp-new-"));
    const tools = new PlannerTools({ planDir: join(workspace, "plan"), today: TODAY });
    expect(planOverview(tools)).toMatchObject({ exists: false });
    createProject(tools, { name: "New" });
    expect(existsSync(join(workspace, "plan", "project.md"))).toBe(true);
  });
});
