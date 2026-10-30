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

const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

/**
 * Adds or updates the md-planner entry in an .mcp.json text, keeping everything else. An existing
 * entry keeps what the user added to it (other environment variables, `disabled` …): only its
 * type, command, arguments and ELECTRON_RUN_AS_NODE are set.
 */
export function mergeMcpJson(existing: string | undefined, entry: McpServerEntry): string {
  let data: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};
  if (existing && existing.trim()) {
    try {
      data = JSON.parse(existing);
    } catch {
      throw new Error(".mcp.json is not valid JSON; fix or remove it first.");
    }
    if (!isObject(data)) throw new Error(".mcp.json must contain a JSON object.");
  }
  if (data.mcpServers != null && !isObject(data.mcpServers))
    throw new Error('"mcpServers" in .mcp.json must be a JSON object; fix it first.');
  const before = data.mcpServers?.[MCP_SERVER_NAME];
  const old = isObject(before) ? before : {};
  data.mcpServers = {
    ...(data.mcpServers ?? {}),
    [MCP_SERVER_NAME]: {
      ...old,
      type: "stdio",
      command: entry.command,
      args: entry.args,
      env: { ...(isObject(old.env) ? old.env : {}), ...entry.env },
    },
  };
  return JSON.stringify(data, null, 2) + "\n";
}
