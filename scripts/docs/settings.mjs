// Re-generates docs/settings.md from package.json (see settingsDoc.ts).
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const root = join(here, "..", "..");
const outfile = join(root, "out", "docs", "settingsDoc.cjs");
await esbuild.build({
  entryPoints: [join(here, "settingsDoc.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "warning",
});
execFileSync(process.execPath, [outfile, root], { stdio: "inherit" });
