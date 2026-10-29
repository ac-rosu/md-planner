// What a careless or misled agent cannot do through the tools: break the files with line breaks,
// reach outside the workspace, or hand the planner ambiguous or absurd values.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpSession, startServer } from "./server";

let s: McpSession;
const call = (name: string, args: Record<string, unknown> = {}) => s.call(name, args);
const M1 = "milestones/M1-discovery-design.md";

beforeAll(async () => {
  s = await startServer();
}, 60_000);

afterAll(async () => {
  await s?.close();
});

describe("MCP tools keep the files intact", () => {
  it("write single-line values on one line", async () => {
    const r = await call("update_task", {
      id: "T011",
      attributes: { eq: "x\n- [ ] ghost @est:80h @owner:mark\n## Ghost" },
    });
    expect(r.isError).toBe(false);
    const text = s.file(M1);
    expect(text).not.toMatch(/^- \[ \] ghost/m);
    expect(text).not.toMatch(/^## Ghost/m);
    await call("update_project", { code: "X\nhoursPerDay: 2\nend: 2026-11-01" });
    const o = (await call("get_plan_overview")).json;
    expect(o.project.hoursPerDay).toBe(8);
    expect(s.file("project.md")).toContain("code: X hoursPerDay: 2 end: 2026-11-01\n");
  });

  it("keep a milestone description text", async () => {
    await call("update_milestone", {
      id: "M1",
      description: "Scope.\n- [ ] ghost @est:80h\n## Ghost",
    });
    expect(s.file(M1)).toContain("Scope.\n\\- [ ] ghost @est:80h\n\\## Ghost\n");
    const tasks = (await call("list_tasks", { milestone: "M1" })).json;
    expect(JSON.stringify(tasks)).not.toContain("ghost");
  });
});

describe("MCP tools stay inside the workspace", () => {
  it("write exports only into the workspace, under a plain name", async () => {
    const name = await call("export_report", { formats: ["csv"], name: "../../../outside" });
    expect(name.isError).toBe(true);
    expect(name.text).toContain("name is a file name without folders");
    const out = await call("export_report", { formats: ["csv"], outDir: "/tmp" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("outDir must be inside the workspace");
    const ok = await call("export_report", { formats: ["csv"], outDir: "exports" });
    expect(ok.isError).toBe(false);
    expect(existsSync(join(s.workspace, "exports"))).toBe(true);
  });

  it("never start a browser from inside the workspace", async () => {
    const fake = join(s.workspace, "chrome");
    writeFileSync(fake, "#!/bin/sh\ntouch pwned\n", { mode: 0o755 });
    const r = await call("export_report", { formats: ["csv"], browserPath: fake });
    expect(r.isError).toBe(false);
    expect(r.json.warnings[0]).toContain("is inside the workspace, so it was not used");
  });

  it("link TODOs and read templates only inside the workspace", async () => {
    const todo = await call("promote_todo", {
      file: "../../../etc/hosts",
      line: 1,
      milestone: "M1",
    });
    expect(todo.isError).toBe(true);
    expect(todo.text).toContain("file must be inside the workspace");
    const templates = await call("list_templates", { templatesFolder: "/" });
    expect(templates.isError).toBe(true);
    expect(templates.text).toContain("templatesFolder must be inside the workspace");
  });
});

describe("MCP tools refuse ambiguous or absurd values", () => {
  it("refuse a ref given to two tasks, and note titles with tags", async () => {
    const twice = await call("create_tasks", {
      milestone: "M1",
      tasks: [
        { ref: "a", title: "One" },
        { ref: "a", title: "Two" },
        { title: "Three", dependsOn: ["a"] },
      ],
    });
    expect(twice.isError).toBe(true);
    expect(twice.text).toContain('ref "a" is used by more than one task');
    const tagged = await call("create_tasks", {
      milestone: "M1",
      tasks: [{ title: "Fix bug #42" }],
    });
    expect(tagged.isError).toBe(false);
    expect(tagged.json.warnings[0]).toContain("#42 is read as a tag, attribute or id");
  });

  it("limit logged time and keep hours typed in another format", async () => {
    const huge = await call("log_time", { id: "T011", time: 5000 });
    expect(huge.isError).toBe(true);
    const path = join(s.planDir, M1);
    writeFileSync(path, readFileSync(path, "utf8").replace("^T011", "@act:90m ^T011"));
    const typed = await call("log_time", { id: "T011", time: "1h" });
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain("@act:90m, which is not read as hours");
    expect(s.file(M1)).toContain("@act:90m ^T011");
  });

  it("validate export options", async () => {
    expect((await call("export_report", { formats: ["csv"], csvDelimiter: '"' })).isError).toBe(
      true
    );
    expect((await call("export_report", { formats: ["html"], ganttWeeks: 300000 })).isError).toBe(
      true
    );
  });
});
