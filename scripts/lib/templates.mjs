// templates/<name>/** as { name: { path: text } }: bundled into the MCP server (scripts/build.mjs,
// test/unit/mcp/mcp.test.ts), which may run from a copy outside the extension folder.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function templateFiles(dir) {
  const out = {};
  for (const name of readdirSync(dir)) {
    const base = join(dir, name);
    if (!statSync(base).isDirectory()) continue;
    const files = {};
    const walk = (d) => {
      for (const f of readdirSync(d).sort()) {
        const full = join(d, f);
        if (statSync(full).isDirectory()) walk(full);
        else files[relative(base, full).split(sep).join("/")] = readFileSync(full, "utf8");
      }
    };
    walk(base);
    out[name] = files;
  }
  return out;
}
