// Edge cases of the MCP write tools, called directly on small plans in temporary folders.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignIds,
  deleteTasks,
  moveTask,
  renameTaskId,
  updateTasks,
} from "../../../src/mcp/taskTools";
import { buildPlan } from "../../../src/mcp/buildPlan";
import { listPunchItems } from "../../../src/mcp/inboxTools";
import { findWorkspace } from "../../../src/mcp/settings";
import { addTestCases, createTestPlans, finishTestRun } from "../../../src/mcp/testTools";
import { listTodos, promoteTodo } from "../../../src/mcp/todoTools";
import { PlannerTools } from "../../../src/mcp/tools";
import { md, TODAY } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01", "hoursPerDay: 8");
const TEAM = md("# Team", "", "## Alex", "", "id: alex");

/** A plan folder with project.md, team.md and the given files; returns the tools and a reader. */
function planWith(files: Record<string, string>) {
  const planDir = join(mkdtempSync(join(tmpdir(), "planner-mcp-edits-")), "plan");
  for (const [rel, text] of Object.entries({
    "project.md": PROJECT,
    "team.md": TEAM,
    ...files,
  })) {
    mkdirSync(dirname(join(planDir, rel)), { recursive: true });
    writeFileSync(join(planDir, rel), text);
  }
  return {
    tools: new PlannerTools({ planDir, today: TODAY }),
    read: (rel: string) => readFileSync(join(planDir, rel), "utf8"),
  };
}

describe("delete_tasks", () => {
  it("deletes an id-less task by its key, not the first task with the same title", () => {
    const { tools, read } = planWith({
      "milestones/M1-a.md": md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        "- [ ] Unit 100 ^T1",
        "  - [ ] Test",
        "- [ ] Unit 200 ^T2",
        "  - [ ] Test"
      ),
    });
    const r = deleteTasks(tools, { ids: ["milestones/M1-a.md#8"] });
    expect(r.deleted).toEqual(["Test"]);
    expect(read("milestones/M1-a.md")).toBe(
      md("# M1 – A", "", "id: M1", "", "- [ ] Unit 100 ^T1", "  - [ ] Test", "- [ ] Unit 200 ^T2")
    );
  });

  it("deletes several id-less tasks and inbox items, wherever they are in the request", () => {
    const { tools, read } = planWith({
      "milestones/M1-a.md": md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        "- [ ] Same @est:1h",
        "- [ ] Keep ^T1",
        "- [ ] Same @est:2h",
        "- [ ] Same @est:3h"
      ),
      "inbox.md": md("# Inbox", "", "- [ ] one", "- [ ] two", "- [ ] three"),
    });
    const r = deleteTasks(tools, {
      ids: ["milestones/M1-a.md#5", "inbox:3", "milestones/M1-a.md#8", "inbox:1", "T1"],
    });
    expect(r.deleted).toEqual(["Same", "three", "Same", "one", "T1"]);
    expect(read("milestones/M1-a.md")).toBe(md("# M1 – A", "", "id: M1", "", "- [ ] Same @est:2h"));
    expect(read("inbox.md")).toBe(md("# Inbox", "", "- [ ] two"));
  });
});

describe("refusing writes that add errors", () => {
  const files = {
    "milestones/M1-a.md": md(
      "# M1 – A",
      "",
      "id: M1",
      "",
      "- [ ] Cycle one @dep:T2 ^T1",
      "- [ ] Cycle two @dep:T1 ^T2",
      "- [ ] Broken @dep:T999 ^T3",
      "- [ ] Free ^T4"
    ),
    "milestones/M2-b.md": md("# M2 – B", "", "id: M2"),
  };

  it("moves a task with an existing error to another file", () => {
    const { tools, read } = planWith(files);
    moveTask(tools, { id: "T3", milestone: "M2" });
    expect(read("milestones/M2-b.md")).toBe(
      md("# M2 – B", "", "id: M2", "", "- [ ] Broken @dep:T999 ^T3")
    );
  });

  it("renames a task that is part of an existing cycle", () => {
    const { tools, read } = planWith(files);
    renameTaskId(tools, { id: "T1", newId: "T10" });
    expect(read("milestones/M1-a.md")).toContain("- [ ] Cycle two @dep:T10 ^T2");
  });

  it("renames a task that a dependency on its own parent or subtask names", () => {
    const { tools, read } = planWith({
      "milestones/M1-a.md": md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        "- [ ] Parent @dep:T2 ^T1",
        "  - [ ] Part @est:1h ^T2",
        "- [ ] Child first @dep:T4 ^T3",
        "  - [ ] Child @est:1h @dep:T3 ^T4"
      ),
    });
    renameTaskId(tools, { id: "T2", newId: "T7" });
    renameTaskId(tools, { id: "T3", newId: "T8" });
    expect(read("milestones/M1-a.md")).toBe(
      md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        "- [ ] Parent @dep:T7 ^T1",
        "  - [ ] Part @est:1h ^T7",
        "- [ ] Child first @dep:T4 ^T8",
        "  - [ ] Child @est:1h @dep:T8 ^T4"
      )
    );
  });

  it("renames ids that other errors name: an invalid dependency, a duplicate id", () => {
    const { tools, read } = planWith({
      "milestones/M1-a.md": md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        "- [ ] Lag typo @est:1h @dep:T2+3x ^T1",
        "- [ ] Target @est:1h ^T2",
        "- [ ] Twice @est:1h ^T3",
        "- [ ] Twice again @est:1h ^T3",
        "- [ ] Unrelated @est:1h ^T101"
      ),
    });
    renameTaskId(tools, { id: "T2", newId: "T7" });
    renameTaskId(tools, { id: "T3", newId: "T9" });
    // T101 is also the example in the invalid dependency message: that message is unchanged.
    renameTaskId(tools, { id: "T101", newId: "T200" });
    expect(read("milestones/M1-a.md")).toBe(
      md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        "- [ ] Lag typo @est:1h @dep:T7+3x ^T1",
        "- [ ] Target @est:1h ^T7",
        "- [ ] Twice @est:1h ^T9",
        "- [ ] Twice again @est:1h ^T9",
        "- [ ] Unrelated @est:1h ^T200"
      )
    );
  });

  it("still refuses a rename that adds an error", () => {
    const { tools, read } = planWith({
      "milestones/M1-a.md": md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        "- [ ] Parent @dep:T9 ^T1",
        "  - [ ] Part @est:1h ^T2"
      ),
    });
    const before = read("milestones/M1-a.md");
    // The unknown T9 would become the parent's own subtask.
    expect(() => renameTaskId(tools, { id: "T2", newId: "T9" })).toThrow(
      /Nothing was written.*Depends on its own subtask T9/s
    );
    expect(read("milestones/M1-a.md")).toBe(before);
  });

  it("assigns ids to tasks in an existing cycle, also to tasks with the same title", () => {
    const { tools, read } = planWith({
      "milestones/M1-a.md": md(
        "# M1 – A",
        "",
        "id: M1",
        "depends: M2",
        "",
        "- [ ] Test @est:1h",
        "- [ ] Test @est:2h"
      ),
      "milestones/M2-b.md": md("# M2 – B", "", "id: M2", "depends: M1", "", "- [ ] B @est:1h ^T1"),
    });
    expect(assignIds(tools, {}).ids).toEqual(["T2", "T3"]);
    expect(read("milestones/M1-a.md")).toContain("- [ ] Test @est:1h ^T2\n- [ ] Test @est:2h ^T3");
  });

  it("retitles a task without an id in an existing cycle", () => {
    const { tools, read } = planWith({
      "milestones/M1-a.md": md("# M1 – A", "", "id: M1", "depends: M2", "", "- [ ] Draft @est:1h"),
      "milestones/M2-b.md": md("# M2 – B", "", "id: M2", "depends: M1", "", "- [ ] B @est:1h ^T1"),
    });
    updateTasks(tools, { updates: [{ id: "milestones/M1-a.md#6", title: "Second draft" }] });
    expect(read("milestones/M1-a.md")).toContain("- [ ] Second draft @est:1h\n");
    updateTasks(tools, {
      updates: [
        { id: "milestones/M1-a.md#6", title: "Third draft" },
        { id: "milestones/M1-a.md#6", title: "Final text" },
      ],
    });
    expect(read("milestones/M1-a.md")).toContain("- [ ] Final text @est:1h\n");
  });

  it("still refuses a new cycle or a second unknown dependency", () => {
    const { tools, read } = planWith(files);
    const before = read("milestones/M1-a.md");
    expect(() =>
      updateTasks(tools, {
        updates: [
          { id: "T4", dependsOn: ["T3"] },
          { id: "T3", addDependsOn: ["T4"] },
        ],
      })
    ).toThrow(/Nothing was written.*\n- Circular dependency: T(3 → T4|4 → T3)\./s);
    expect(() =>
      updateTasks(tools, { updates: [{ id: "T4", attributes: { dep: "T999" } }] })
    ).toThrow('milestones/M1-a.md: Unknown dependency "T999".');
    expect(read("milestones/M1-a.md")).toBe(before);
  });
});

describe("update_task with subtasks", () => {
  const M1 = md(
    "# M1 – A",
    "",
    "id: M1",
    "",
    "- [/] Parent @started:2026-10-01 ^T1",
    "  - [x] Done child @est:1h @done:2026-10-02 ^T2",
    "  - [ ] Open child @est:1h ^T3"
  );

  it("asks the agent what happens to open subtasks when a parent is finished", () => {
    const { tools, read } = planWith({ "milestones/M1-a.md": M1 });
    expect(() => updateTasks(tools, { updates: [{ id: "T1", status: "done" }] })).toThrow(
      /T1: has 1 open subtask \(T3\): pass subtasks "done"/
    );
    expect(read("milestones/M1-a.md")).toBe(M1);
    updateTasks(tools, { updates: [{ id: "T1", status: "done", subtasks: "cancelled" }] });
    expect(read("milestones/M1-a.md")).toBe(
      md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        `- [x] Parent @started:2026-10-01 @done:${TODAY} ^T1`,
        "  - [x] Done child @est:1h @done:2026-10-02 ^T2",
        "  - [-] Open child @est:1h ^T3"
      )
    );
  });

  it("finishes the parent with its last subtask, unless planner.parentStatus is off", () => {
    const { tools, read } = planWith({ "milestones/M1-a.md": M1 });
    updateTasks(tools, { updates: [{ id: "T3", status: "done" }] });
    expect(read("milestones/M1-a.md")).toContain(
      `- [x] Parent @started:2026-10-01 @done:${TODAY} ^T1`
    );
    const off = planWith({ "milestones/M1-a.md": M1 });
    const vscodeDir = join(dirname(off.tools.planDir), ".vscode");
    mkdirSync(vscodeDir, { recursive: true });
    writeFileSync(join(vscodeDir, "settings.json"), '{ "planner.parentStatus": "off" }');
    updateTasks(off.tools, { updates: [{ id: "T3", status: "done" }] });
    expect(off.read("milestones/M1-a.md")).toContain("- [/] Parent @started:2026-10-01 ^T1");
  });
});

describe("task keys", () => {
  it("get_task and the write tools take the same ids, keys and inbox positions", () => {
    const { tools } = planWith({
      "milestones/M1-a.md": md("# M1 – A", "", "id: M1", "", "- [ ] Task ^T1", "- [ ] No id"),
      "punchlist.md": md("# Punch list", "", "- [ ] Loose cable @sev:B"),
      "inbox.md": md("# Inbox", "", "- [ ] Idea", "- [ ] Other idea"),
    });
    for (const [ref, title] of [
      ["T1", "Task"],
      ["milestones/M1-a.md#6", "No id"],
      ["punchlist.md#3", "Loose cable"],
      ["inbox:2", "Other idea"],
      ["inbox.md#3", "Idea"],
    ]) {
      expect(tools.getTask({ id: ref }).title).toBe(title);
      expect(updateTasks(tools, { updates: [{ id: ref, priority: "high" }] }).updated).toHaveLength(
        1
      );
    }
  });

  it("updates and deletes punch items without an id by the key list_punch_items returns", () => {
    const { tools, read } = planWith({
      "punchlist.md": md("# Punch list", "", "- [ ] Loose cable @sev:B", "- [ ] Typo @sev:C"),
    });
    const keys = listPunchItems(tools, {}).map((p) => p.id);
    expect(keys).toEqual(["punchlist.md#3", "punchlist.md#4"]);
    updateTasks(tools, { updates: [{ id: keys[0], owner: "alex" }] });
    expect(read("punchlist.md")).toContain("- [ ] Loose cable @sev:B @owner:alex\n");
    expect(deleteTasks(tools, { ids: [keys[1]] }).deleted).toEqual(["Typo"]);
    expect(read("punchlist.md")).toBe(
      md("# Punch list", "", "- [ ] Loose cable @sev:B @owner:alex")
    );
  });
});

describe("people by name", () => {
  const team = md(
    "# Team",
    "",
    "## Sam Smith",
    "",
    "role: PLC",
    "",
    "## Sam Taylor",
    "",
    "## Priya Patel"
  );
  const files = {
    "team.md": team,
    "milestones/M1-a.md": md("# M1 – A", "", "id: M1", "", "- [ ] Task ^T1"),
  };

  it("build_plan adds a new person instead of renaming one with the same first name", () => {
    const { tools, read } = planWith(files);
    const r = buildPlan(tools, { people: [{ name: "Sam", capacity: "32h/week" }] });
    expect(r.created.people).toEqual(["sam"]);
    expect(r.updated.people).toEqual([]);
    expect(read("team.md")).toContain("## Sam Smith\n\nrole: PLC\n");
    expect(read("team.md")).toContain("## Sam\n");
  });

  it("takes a first name as owner only when one person has it", () => {
    const { tools, read } = planWith(files);
    updateTasks(tools, { updates: [{ id: "T1", owner: "Priya" }] });
    expect(read("milestones/M1-a.md")).toContain("- [ ] Task @owner:priya-patel ^T1");
    expect(() => updateTasks(tools, { updates: [{ id: "T1", owner: "Sam" }] })).toThrow(
      'T1: unknown owner "Sam"'
    );
  });
});

describe("test cases", () => {
  it("numbers new cases around the ids given in the same call", () => {
    const { tools, read } = planWith({});
    createTestPlans(tools, {
      plans: [
        {
          id: "FAT-1",
          title: "FAT",
          cases: [
            { title: "a", steps: ["x"] },
            { id: "TC-01", title: "b", steps: ["y"] },
            { title: "c", steps: ["z"] },
          ],
        },
      ],
    });
    const text = read("tests/FAT-1-fat.md");
    expect(text.match(/^## .*$/gm)).toEqual(["## TC-02 a", "## TC-01 b", "## TC-03 c"]);
    addTestCases(tools, {
      test: "FAT-1",
      cases: [
        { title: "d", steps: ["w"] },
        { id: "TC-04", title: "e", steps: ["v"] },
      ],
    });
    expect(
      read("tests/FAT-1-fat.md")
        .match(/^## .*$/gm)
        ?.slice(3)
    ).toEqual(["## TC-05 d", "## TC-04 e"]);
  });

  it("refuses a case id that exists or is given twice", () => {
    const { tools } = planWith({});
    expect(() =>
      createTestPlans(tools, {
        plans: [
          {
            id: "FAT-1",
            title: "FAT",
            cases: [
              { id: "TC-01", title: "a", steps: ["x"] },
              { id: "tc-01", title: "b", steps: ["y"] },
            ],
          },
        ],
      })
    ).toThrow("Test plan FAT-1: test case tc-01 already exists.");
    createTestPlans(tools, {
      plans: [{ id: "FAT-1", title: "FAT", cases: [{ title: "a", steps: ["x"] }] }],
    });
    expect(() =>
      addTestCases(tools, { test: "FAT-1", cases: [{ id: "TC-01", title: "b", steps: ["y"] }] })
    ).toThrow("FAT-1: test case TC-01 already exists.");
  });
});

describe("test runs", () => {
  it("does not record a tester nobody gave", () => {
    const { tools, read } = planWith({
      "tests/FAT-1.md": md(
        "# FAT",
        "",
        "id: FAT-1",
        "type: FAT",
        "",
        "## TC-01 Start",
        "",
        "- [ ] Press start @result:pass"
      ),
    });
    const before = read("tests/FAT-1.md");
    for (const tester of [undefined, " "])
      expect(() => finishTestRun(tools, { test: "FAT-1", tester: tester as string })).toThrow(
        "Who ran the test?"
      );
    expect(read("tests/FAT-1.md")).toBe(before);
    finishTestRun(tools, { test: "FAT-1", tester: "alex" });
    expect(read("tests/FAT-1.md")).toContain("tester: Alex");
  });
});

describe("the workspace of a nested plan folder", () => {
  it("reads the settings and TODO comments of the workspace, not of the plan's parent", () => {
    const ws = mkdtempSync(join(tmpdir(), "planner-mcp-ws-"));
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(ws, rel)), { recursive: true });
      writeFileSync(join(ws, rel), text);
    };
    write(
      ".vscode/settings.json",
      '{ "planner.planFolder": "docs/plan", // nested\n "planner.todos.include": "src/**" }'
    );
    write("docs/plan/project.md", PROJECT);
    write("docs/plan/team.md", TEAM);
    write("docs/plan/milestones/M1-a.md", md("# M1 – A", "", "id: M1"));
    write("src/a.ts", "// TODO: handle the timeout\n");
    write("docs/b.ts", "// TODO: not in src\n");
    const planDir = join(ws, "docs", "plan");
    expect(findWorkspace(planDir)).toBe(ws);
    expect(findWorkspace(join(ws, "elsewhere", "plan"))).toBe(join(ws, "elsewhere"));
    const tools = new PlannerTools({ planDir, today: TODAY });
    expect(listTodos(tools, {}).map((t) => t.file)).toEqual(["src/a.ts"]);
    promoteTodo(tools, { file: "src/a.ts", line: 1, milestone: "M1" });
    expect(readFileSync(join(planDir, "milestones/M1-a.md"), "utf8")).toContain("@src:src/a.ts");
    expect(readFileSync(join(ws, "src/a.ts"), "utf8")).toBe("// TODO(T1): handle the timeout\n");
  });
});

describe("build_plan on existing milestones", () => {
  const files = {
    "milestones/M1-a.md": md("# M1 – A", "", "id: M1", "", "Old scope.", "", "- [ ] Task ^T1"),
    "milestones/M2-b.md": md("# M2 – B", "", "id: M2"),
  };

  it("renames a milestone found by id and replaces its description", () => {
    const { tools, read } = planWith(files);
    const r = buildPlan(tools, {
      milestones: [
        { id: "M1", name: "Renamed", description: "New scope." },
        { id: "M2", description: "Scope of B." },
      ],
    });
    expect(r.updated.milestones).toEqual(["M1", "M2"]);
    expect(read("milestones/M1-a.md")).toBe(
      md("# M1 – Renamed", "", "id: M1", "", "New scope.", "", "- [ ] Task ^T1")
    );
    expect(read("milestones/M2-b.md")).toBe(md("# M2 – B", "", "id: M2", "", "Scope of B."));
  });

  it("does not count the name a milestone was found by as a change", () => {
    const { tools, read } = planWith(files);
    const r = buildPlan(tools, {
      milestones: [
        { name: "a", sections: ["Docs"] },
        { id: "M2", name: "B" },
      ],
    });
    expect(r.updated.milestones).toEqual([]);
    expect(read("milestones/M1-a.md")).toContain("# M1 – A\n");
    expect(read("milestones/M2-b.md")).toBe(files["milestones/M2-b.md"]);
  });
});

describe("task notes", () => {
  it("get_task gives the notes as update_task takes them, and a change touches only its lines", () => {
    const { tools, read } = planWith({
      "milestones/M1-a.md": md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        "- [ ] Task ^T1",
        "      Check:",
        "        - wiring",
        "",
        "      Then sign off."
      ),
    });
    const notes: string[] = tools.getTask({ id: "T1" }).notes;
    expect(notes).toEqual(["Check:", "  - wiring", "", "Then sign off."]);
    const r = updateTasks(tools, {
      updates: [{ id: "T1", notes: [...notes.slice(0, 2), "  - labels", ...notes.slice(2)] }],
    });
    expect(r.changed).toEqual([
      { file: "milestones/M1-a.md", line: 8, before: [], after: ["        - labels"] },
    ]);
    expect(read("milestones/M1-a.md")).toContain(
      "      Check:\n        - wiring\n        - labels\n\n      Then sign off.\n"
    );
  });
});

describe("move_task", () => {
  const M1 = md(
    "# M1 – A",
    "",
    "id: M1",
    "",
    "- [-] Old approach @est:8h ^T1",
    "  - [-] Old part @est:2h ^T4",
    "- [ ] New approach @est:16h ^T2",
    "- [x] Setup @est:2h @done:2026-10-02 ^T3",
    "- [ ] Next @est:4h"
  );
  const M2 = md("# M2 – B", "", "id: M2", "status: cancelled");

  it("refuses to put open work under a cancelled or done task, or into a cancelled milestone", () => {
    const { tools, read } = planWith({ "milestones/M1-a.md": M1, "milestones/M2-b.md": M2 });
    expect(() => moveTask(tools, { id: "T2", parent: "T1" })).toThrow(
      "Nothing was moved: T2 would end up under T1, which is cancelled, and no longer be scheduled. Reopen the task or milestone it would be under, or set T2 to done or cancelled first."
    );
    expect(() => moveTask(tools, { id: "T2", after: "T4" })).toThrow(
      /T2 would end up under T1, which is cancelled/
    );
    expect(() => moveTask(tools, { id: "T2", parent: "T3" })).toThrow(
      /T2 would end up under T3, which is done/
    );
    expect(() => moveTask(tools, { id: "T2", milestone: "M2" })).toThrow(
      /T2 would move into M2, which is cancelled/
    );
    expect(read("milestones/M1-a.md")).toBe(M1);
    expect(read("milestones/M2-b.md")).toBe(M2);
    // Finished work can go there, and open work next to a cancelled task.
    moveTask(tools, { id: "T3", parent: "T1" });
    moveTask(tools, { id: "T2", before: "T1" });
    expect(read("milestones/M1-a.md")).toBe(
      md(
        "# M1 – A",
        "",
        "id: M1",
        "",
        "- [ ] New approach @est:16h ^T2",
        "- [-] Old approach @est:8h ^T1",
        "  - [-] Old part @est:2h ^T4",
        "  - [x] Setup @est:2h @done:2026-10-02 ^T3",
        "- [ ] Next @est:4h"
      )
    );
  });

  it("returns the new key of a task without an id", () => {
    const { tools, read } = planWith({ "milestones/M1-a.md": M1 });
    expect(moveTask(tools, { id: "milestones/M1-a.md#9", before: "T2" }).id).toBe(
      "milestones/M1-a.md#7"
    );
    expect(read("milestones/M1-a.md").split("\n")[6]).toBe("- [ ] Next @est:4h");
    expect(moveTask(tools, { id: "milestones/M1-a.md#7", parent: "T2" }).id).toBe(
      "milestones/M1-a.md#8"
    );
    expect(read("milestones/M1-a.md").split("\n")[7]).toBe("  - [ ] Next @est:4h");
  });
});
