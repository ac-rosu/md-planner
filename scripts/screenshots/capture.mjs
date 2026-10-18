// Renders each webview with the sample project in headless Chrome/Edge and saves PNG screenshots.
//   node scripts/screenshots/capture.mjs [view ...]
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const root = join(here, "..", "..");
const out = join(root, "out", "screenshots");
mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [join(here, "models.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(out, "models.cjs"),
  logLevel: "warning",
});
const modelsFile = join(out, "models.json");
execFileSync(
  process.execPath,
  [join(out, "models.cjs"), join(root, "examples/customer-portal/plan"), "2026-10-14", modelsFile],
  { stdio: "inherit" }
);
const messages = JSON.parse(readFileSync(modelsFile, "utf8"));

const browsers = [
  process.env.PLANNER_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const browser = browsers.find((b) => existsSync(b));
if (!browser) throw new Error("No Chrome/Edge found (set PLANNER_BROWSER).");

const views = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(messages);
const harness = readFileSync(join(here, "harness.html"), "utf8");
copyFileSync(join(here, "theme-dark.css"), join(out, "theme.css"));
for (const view of views) {
  const html = harness
    .replaceAll("__VIEW__", view)
    .replace("__MESSAGES__", JSON.stringify(messages[view]))
    .replace("__BODYCLASS__", "vscode-dark");
  const page = join(out, `${view}.html`);
  writeFileSync(page, html);
  const png = join(out, `${view}.png`);
  execFileSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--virtual-time-budget=4000",
      "--window-size=1500,860",
      `--screenshot=${png}`,
      `file://${page}`,
    ],
    { stdio: "ignore" }
  );
  console.log(`${view}: ${png}`);
}
