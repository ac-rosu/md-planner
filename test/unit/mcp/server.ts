// Starts the bundled MCP server on a temporary workspace and talks to it over stdio, as an MCP
// client (Claude Code, Copilot) would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import esbuild from "esbuild";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateFiles } from "../../../scripts/lib/templates.mjs";
import { ROOT, SAMPLE_PLAN, TODAY } from "../helpers";

let bundle: Promise<string> | undefined;

/** The server bundled once per test file, with the templates embedded as in dist/. */
function bundled(): Promise<string> {
  bundle ??= (async () => {
    const out = mkdtempSync(join(tmpdir(), "planner-mcp-bin-"));
    await esbuild.build({
      entryPoints: [join(ROOT, "src/mcp/server.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: join(out, "mcp-server.js"),
      define: {
        PLANNER_VERSION: '"test"',
        PLANNER_TEMPLATES: JSON.stringify(templateFiles(join(ROOT, "templates"))),
      },
      logLevel: "warning",
    });
    return join(out, "mcp-server.js");
  })();
  return bundle;
}

export interface McpSession {
  client: Client;
  /** The workspace folder; the plan is `<workspace>/plan`. */
  workspace: string;
  planDir: string;
  /** Calls a tool; `json` is the parsed result (any: the tests read the fields they check). */
  call(
    name: string,
    args?: Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ isError: boolean; text: string; json: any }>;
  file(rel: string): string;
  close(): Promise<void>;
}

/** A server on a new workspace: with a copy of the sample plan, or with no plan at all. */
export async function startServer(options: { sample?: boolean } = {}): Promise<McpSession> {
  const server = await bundled();
  const workspace = mkdtempSync(join(tmpdir(), "planner-mcp-ws-"));
  const planDir = join(workspace, "plan");
  if (options.sample ?? true) cpSync(SAMPLE_PLAN, planDir, { recursive: true });
  else mkdirSync(workspace, { recursive: true });
  const client = new Client({ name: "md-planner-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server, "--plan", planDir, "--today", TODAY],
      stderr: "ignore",
    })
  );
  return {
    client,
    workspace,
    planDir,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      const text = r.content[0].text;
      let json: unknown;
      if (!r.isError)
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
      return { isError: r.isError === true, text, json };
    },
    file: (rel) => readFileSync(join(planDir, rel), "utf8"),
    close: () => client.close(),
  };
}
