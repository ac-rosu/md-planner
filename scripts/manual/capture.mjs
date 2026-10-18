// Screenshots of the user manual (docs/manual/images): webviews in headless Chrome, the generated
// reports, and the VS Code workbench driven over the DevTools protocol. Needs a desktop session
// (VS Code opens a window), Chrome or Edge, and the VS Code build in .vscode-test (downloaded by
// `npm run test:integration`).
//   node scripts/manual/capture.mjs [--only name,prefix,...] [--skip webviews,reports,vscode]
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureReports } from "./reports.mjs";
import { captureVscode } from "./vscode.mjs";
import { captureWebviews } from "./webviews.mjs";

/** The date every screenshot is taken "as of" (a Wednesday in the sample project's timeline). */
export const TODAY = "2026-10-14";

const here = join(fileURLToPath(import.meta.url), "..");
const root = join(here, "..", "..");
const out = join(root, "docs", "manual", "images");
const work = join(root, "out", "manual");
const pages = join(work, "pages");
mkdirSync(out, { recursive: true });
mkdirSync(pages, { recursive: true });

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? "").split(",").filter(Boolean) : undefined;
};
const only = arg("only");
const skip = new Set(arg("skip") ?? []);

await esbuild.build({
  entryPoints: [join(here, "models.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(work, "models.cjs"),
  logLevel: "warning",
});
const plan = join(root, "examples", "customer-portal", "plan");
execFileSync(process.execPath, [join(work, "models.cjs"), plan, TODAY, join(work, "models.json")], {
  stdio: "inherit",
});
const models = JSON.parse(readFileSync(join(work, "models.json"), "utf8"));

if (!skip.has("webviews")) {
  console.log("webviews");
  await captureWebviews({ root, out, pages, models, only });
}
if (!skip.has("reports")) {
  console.log("reports");
  await captureReports({ root, out, work, today: TODAY, only });
}
if (!skip.has("vscode")) {
  console.log("vscode");
  await captureVscode({ root, out, today: TODAY, only });
}
