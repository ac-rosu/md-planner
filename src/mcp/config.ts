// .mcp.json helpers (no VS Code dependency, shared with tests).

export const MCP_SERVER_NAME = "md-planner";

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The server entry: VS Code's own runtime in Node mode, so no separate Node install is needed. */
export function serverEntry(
  runtime: string,
  serverPath: string,
  planDir: string,
  workspaceDir?: string
): McpServerEntry {
  return {
    command: runtime,
    args: [serverPath, "--plan", planDir, ...(workspaceDir ? ["--workspace", workspaceDir] : [])],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/** True when an .mcp.json text has the md-planner server (false when missing or invalid). */
export function hasServerEntry(text: string | undefined): boolean {
  try {
    const data = JSON.parse(text ?? "") as { mcpServers?: Record<string, unknown> } | null;
    return !!data?.mcpServers?.[MCP_SERVER_NAME];
  } catch {
    return false;
  }
}

/** Adds or replaces the md-planner entry in an .mcp.json text, keeping everything else. */
export function mergeMcpJson(existing: string | undefined, entry: McpServerEntry): string {
  let data: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};
  if (existing && existing.trim()) {
    try {
      data = JSON.parse(existing);
    } catch {
      throw new Error(".mcp.json is not valid JSON; fix or remove it first.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error(".mcp.json must contain a JSON object.");
  }
  data.mcpServers = { ...(data.mcpServers ?? {}), [MCP_SERVER_NAME]: { type: "stdio", ...entry } };
  return JSON.stringify(data, null, 2) + "\n";
}
