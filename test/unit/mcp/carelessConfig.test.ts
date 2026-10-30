// The MCP server with configurations people edit by hand: a customised md-planner entry in
// .mcp.json, an absolute or `./` plan folder, a templates folder that is a file or holds more than
// templates, settings typed as text, and agents passing the dates a task was started or finished.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan } from "../../../src/mcp/buildPlan";
import { mergeMcpJson, serverEntry } from "../../../src/mcp/config";
import { findWorkspace, planFolderPath } from "../../../src/mcp/settings";
import { createTasks } from "../../../src/mcp/taskTools";
import { availableTemplates } from "../../../src/mcp/templates";
import { listTodos } from "../../../src/mcp/todoTools";
import { PlannerTools, ToolError } from "../../../src/mcp/tools";
import { md, TODAY } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01", "hoursPerDay: 8");
const TEAM = md("# Team", "", "## Alex", "", "id: alex");
const M1 = "milestones/M1-a.md";

/** A workspace with a plan folder, the given plan files and .vscode/settings.json. */
function workspaceWith(
  files: Record<string, string>,
  settings: Record<string, unknown> = {},
  other: Record<string, string | Uint8Array> = {}
) {
  const workspace = mkdtempSync(join(tmpdir(), "planner-mcp-careless-"));
  const planDir = join(workspace, "plan");
  const all = {
    "plan/project.md": PROJECT,
    "plan/team.md": TEAM,
    [`plan/${M1}`]: md("# M1 – A", "", "id: M1"),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`plan/${k}`, v])),
    ".vscode/settings.json": JSON.stringify(settings),
    ...other,
  };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(dirname(join(workspace, rel)), { recursive: true });
    writeFileSync(join(workspace, rel), content);
  }
  return {
    workspace,
    planDir,
    tools: new PlannerTools({ planDir, workspaceDir: workspace, today: TODAY }),
    read: (rel: string) => readFileSync(join(planDir, rel), "utf8"),
  };
}

function refusal(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return (err as Error).message;
  }
  throw new Error("no error");
}

describe(".mcp.json", () => {
  const entry = serverEntry("/vscode/node", "/storage/mcp-server.js", "/ws/plan", "/ws");

  it("keeps what the user added to the md-planner entry", () => {
    const existing = JSON.stringify({
      mcpServers: {
        "md-planner": {
          type: "stdio",
          command: "/old/node",
          args: ["/old/server.js", "--plan", "/old/plan"],
          env: { ELECTRON_RUN_AS_NODE: "0", PLANNER_TODAY: "2026-01-05", HTTP_PROXY: "x" },
          disabled: true,
          timeout: 30000,
        },
        other: { command: "y" },
      },
    });
    const merged = JSON.parse(mergeMcpJson(existing, entry));
    expect(merged.mcpServers["md-planner"]).toEqual({
      type: "stdio",
      command: "/vscode/node",
      args: entry.args,
      env: { ELECTRON_RUN_AS_NODE: "1", PLANNER_TODAY: "2026-01-05", HTTP_PROXY: "x" },
      disabled: true,
      timeout: 30000,
    });
    expect(merged.mcpServers.other).toEqual({ command: "y" });
  });

  it("writes a fresh entry as before, also over one that is not an object", () => {
    for (const existing of [
      undefined,
      "{}",
      '{"mcpServers":null}',
      '{"mcpServers":{"md-planner":"x"}}',
    ])
      expect(JSON.parse(mergeMcpJson(existing, entry)).mcpServers["md-planner"]).toEqual({
        type: "stdio",
        ...entry,
      });
  });

  it("refuses an mcpServers that is not an object, instead of replacing it", () => {
    expect(() => mergeMcpJson('{"mcpServers":[1,2]}', entry)).toThrow(/mcpServers/);
  });
});

describe("the plan folder setting", () => {
  it("resolves ./plan, plan/ and absolute folders as the extension does", () => {
    const { workspace } = workspaceWith({});
    const settings = (planFolder: unknown) =>
      writeFileSync(
        join(workspace, ".vscode/settings.json"),
        JSON.stringify({ "planner.planFolder": planFolder })
      );
    settings("./plan");
    expect(planFolderPath(workspace)).toBe(join(workspace, "plan"));
    expect(findWorkspace(join(workspace, "plan"))).toBe(workspace);
    settings("plan/");
    expect(planFolderPath(workspace)).toBe(join(workspace, "plan"));
    settings("");
    expect(planFolderPath(workspace)).toBe(join(workspace, "plan"));
    // Absolute: as it is, not below the workspace.
    const elsewhere = join(mkdtempSync(join(tmpdir(), "planner-abs-")), "myplan");
    settings(elsewhere);
    expect(planFolderPath(workspace)).toBe(elsewhere);
  });
});

describe("custom templates", () => {
  it("ignores a templates folder that is a file; the built-ins still work", () => {
    const { workspace } = workspaceWith({}, {}, { "templates.txt": "not a folder" });
    const names = availableTemplates(join(workspace, "templates.txt")).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["empty", "blank", "software"]));
  });

  it("lists sub-folders that are not hidden, and copies only Markdown and .gitignore", () => {
    const { workspace } = workspaceWith(
      {},
      {},
      {
        "tpl/mini/project.md": "# {{name}}\n",
        "tpl/mini/.gitignore": ".planner/\n",
        "tpl/mini/.DS_Store": new Uint8Array([0, 1, 2, 255]),
        "tpl/mini/logo.png": new Uint8Array([137, 80, 78, 71, 0, 255]),
        "tpl/mini/.git/HEAD": "ref: refs/heads/main\n",
        "tpl/.git/HEAD": "ref: refs/heads/main\n",
        "tpl/README.md": "templates\n",
      }
    );
    const custom = availableTemplates(join(workspace, "tpl")).filter((t) =>
      t.description.startsWith("Custom")
    );
    expect(custom.map((t) => t.name)).toEqual(["mini"]);
    expect(Object.keys(custom[0].files).sort()).toEqual([".gitignore", "project.md"]);
  });
});

describe("planner.scheduling.unassignedCapacity", () => {
  const unowned = md("# M1 – A", "", "id: M1", "", "- [ ] Unowned @est:80h ^T1");

  it("is read from the workspace settings", () => {
    const { tools } = workspaceWith(
      { [M1]: unowned },
      { "planner.scheduling.unassignedCapacity": 20 }
    );
    expect(tools.unassignedCapacity).toBe(20);
    const at40 = workspaceWith({ [M1]: unowned }).tools;
    expect(at40.unassignedCapacity).toBe(40);
    // Half the capacity: the 80 hours take twice the weeks.
    tools.load();
    at40.load();
    const end = (t: PlannerTools) => [...t.schedule.tasks.values()][0].finish ?? 0;
    expect(end(at40)).toBeGreaterThan(0);
    expect(end(tools)).toBeGreaterThan(end(at40));
  });

  it("reads 40h as 40, and something that is not hours as 40", () => {
    for (const value of ["40h", "40", "lots"]) {
      const { tools } = workspaceWith({}, { "planner.scheduling.unassignedCapacity": value });
      expect(tools.unassignedCapacity, value).toBe(40);
    }
  });

  it("given to the server, wins over the setting", () => {
    const { planDir, workspace } = workspaceWith(
      {},
      { "planner.scheduling.unassignedCapacity": 20 }
    );
    const tools = new PlannerTools({ planDir, workspaceDir: workspace, unassignedCapacity: 10 });
    expect(tools.unassignedCapacity).toBe(10);
  });
});

describe("dates an agent gives for a task's status", () => {
  it("create_tasks keeps attributes.done and attributes.started", () => {
    const { tools, read } = workspaceWith({});
    createTasks(tools, {
      milestone: "M1",
      tasks: [
        { title: "Done in June", status: "done", attributes: { done: "2026-06-02" } },
        { title: "Started in May", status: "doing", attributes: { started: "2026-05-04" } },
        { title: "Done today", status: "done" },
      ],
    });
    const text = read(M1);
    expect(text).toMatch(/\[x\] Done in June .*@done:2026-06-02/);
    expect(text).not.toMatch(/Done in June .*@done:2026-10-14/);
    expect(text).toMatch(/\[\/\] Started in May .*@started:2026-05-04/);
    expect(text).toMatch(/\[x\] Done today .*@done:2026-10-14/);
  });

  it("build_plan keeps them too, and refuses one that is not a date", () => {
    const { tools, read } = workspaceWith({});
    buildPlan(tools, {
      milestones: [
        {
          id: "M1",
          tasks: [{ title: "Old work", status: "done", attributes: { done: "2026-06-02" } }],
        },
      ],
    });
    expect(read(M1)).toMatch(/Old work .*@done:2026-06-02/);
    const before = read(M1);
    expect(
      refusal(() =>
        createTasks(tools, {
          milestone: "M1",
          tasks: [{ title: "Bad", status: "done", attributes: { done: "last week" } }],
        })
      )
    ).toMatch(/invalid done date "last week"/);
    expect(read(M1)).toBe(before);
  });
});

describe("list_todos", () => {
  it("does not hang on an include glob with an unclosed {", () => {
    const { tools } = workspaceWith(
      {},
      { "planner.todos.include": "**/*.{ts,py", "planner.todos.keywords": ["TODO", ""] },
      { "src/a.ts": "// TODO: one\nplain line\n" }
    );
    const started = Date.now();
    expect(listTodos(tools, {})).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
    // With the brace closed the comment is found, and the empty keyword adds nothing.
    expect(listTodos(tools, { include: "**/*.{ts,py}" }).map((t) => [t.file, t.text])).toEqual([
      ["src/a.ts", "one"],
    ]);
  });
});
