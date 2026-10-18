// Render-time check of every webview with the generated 2,000-task plan in headless Chrome/Edge.
//   npm run build && node scripts/perf/webviews.mjs
// Prints, per view, the time from the model message to the second animation frame after it
// (render, layout and paint) and the number of DOM elements. Chrome is driven over the DevTools
// protocol on localhost so the timings are real time.
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, webviewPage } from "../lib/chrome.mjs";

const here = join(fileURLToPath(import.meta.url), "..");
const root = join(here, "..", "..");
const out = join(root, "out", "perf");
mkdirSync(out, { recursive: true });

for (const [entry, file] of [
  [join(here, "writePlan.ts"), "writePlan.cjs"],
  [join(root, "scripts/screenshots/models.ts"), "models.cjs"],
]) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(out, file),
    logLevel: "warning",
  });
}
const planDir = join(tmpdir(), `md-planner-perf-${process.pid}`);
const modelsFile = join(out, "models.json");
try {
  execFileSync(process.execPath, [join(out, "writePlan.cjs"), planDir], { stdio: "inherit" });
  execFileSync(process.execPath, [join(out, "models.cjs"), planDir, "2026-10-14", modelsFile], {
    stdio: "ignore",
  });
} finally {
  rmSync(planDir, { recursive: true, force: true });
}
const messages = JSON.parse(readFileSync(modelsFile, "utf8"));

const chrome = await launchChrome();
const themeCss = join(root, "scripts/screenshots/theme-dark.css");
for (const view of Object.keys(messages)) {
  const page = join(out, `${view}.html`);
  writeFileSync(
    page,
    webviewPage({ root, view, messages: messages[view], themeCss, bodyClass: "vscode-dark" })
  );
  const title = await chrome.open(page);
  const errors = chrome.errors.length ? ` (errors: ${chrome.errors.join("; ")})` : "";
  console.log(`${view.padEnd(11)} ${title}${errors}`);
}
await chrome.close();
