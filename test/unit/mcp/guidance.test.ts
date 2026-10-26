// What agents are told about the planner: the server's instructions, get_plan_format and the agent
// skill (skills/md-planner/SKILL.md) name only tools and commands that exist.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAN_FORMAT, SERVER_INSTRUCTIONS } from "../../../src/mcp/format";
import { ROOT } from "../helpers";
import { type McpSession, startServer } from "./server";

const SKILL = readFileSync(join(ROOT, "skills/md-planner/SKILL.md"), "utf8");

/** Words written like tool names (snake_case). */
const toolNames = (text: string) => [...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];

describe("guidance for agents", () => {
  let mcp: McpSession;
  let tools: Set<string>;
  beforeAll(async () => {
    mcp = await startServer();
    tools = new Set((await mcp.client.listTools()).tools.map((t) => t.name));
  });
  afterAll(() => mcp.close());

  it("sends the instructions to every client when it connects", () => {
    expect(mcp.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it("names only tools that exist", () => {
    for (const [what, text] of [
      ["instructions", SERVER_INSTRUCTIONS],
      ["plan format", PLAN_FORMAT],
      ["skill", SKILL],
    ])
      expect(
        toolNames(text).filter((name) => !tools.has(name)),
        what
      ).toEqual([]);
    for (const name of [
      "get_plan_overview",
      "get_plan_format",
      "get_schedule",
      "build_plan",
      "create_tasks",
      "update_tasks",
      "update_person",
      "log_time",
      "validate_plan",
    ])
      expect(SKILL).toContain(`\`${name}\``);
  });

  it("is an agent skill named after its folder, with a short description", () => {
    const m = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(SKILL);
    expect(m?.[1]).toBe("md-planner");
    expect(m![1]).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(m![2].length).toBeLessThanOrEqual(1024);
  });

  it("names VS Code commands by their titles", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      contributes: { commands: Array<{ category?: string; title: string }> };
    };
    const titles = new Set(pkg.contributes.commands.map((c) => `${c.category}: ${c.title}`));
    const named = [...SKILL.matchAll(/\*\*(Planner: [^*]+)\*\*/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !titles.has(name))).toEqual([]);
  });
});
