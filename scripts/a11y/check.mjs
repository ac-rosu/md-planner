// Accessibility check of every webview with the sample project in headless Chrome/Edge:
//   npm run build && node scripts/a11y/check.mjs
// 1. axe-core (WCAG 2.1 A/AA rules) in the light, dark and high-contrast themes.
// 2. Keyboard scenarios: each view's main actions work without a mouse (keys are sent through
//    the DevTools protocol; the messages the webview posts to the host are checked).
// 3. Layout: no content is hidden behind other content (Kanban swimlanes taller than the window).
// Exits with code 1 when anything fails.
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, webviewPage } from "../lib/chrome.mjs";
import { KEYBOARD_SCENARIOS } from "./keyboard.mjs";

const here = join(fileURLToPath(import.meta.url), "..");
const root = join(here, "..", "..");
const out = join(root, "out", "a11y");
mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "scripts/screenshots/models.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(out, "models.cjs"),
  logLevel: "warning",
});
const modelsFile = join(out, "models.json");
const variantsFile = join(out, "variants.json");
execFileSync(
  process.execPath,
  [
    join(out, "models.cjs"),
    join(root, "examples/customer-portal/plan"),
    "2026-10-14",
    modelsFile,
    variantsFile,
  ],
  { stdio: "ignore" }
);
const messages = JSON.parse(readFileSync(modelsFile, "utf8"));
const variants = JSON.parse(readFileSync(variantsFile, "utf8"));
const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8"
);

const THEMES = [
  { name: "light", css: "theme-light.css", bodyClass: "vscode-light" },
  { name: "dark", css: "theme-dark.css", bodyClass: "vscode-dark" },
  { name: "high contrast", css: "theme-hc.css", bodyClass: "vscode-high-contrast" },
];
const views = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(messages);

const chrome = await launchChrome();
let failures = 0;
const page = (view, theme, recorded = messages[view], name = view) => {
  const file = join(out, `${name}-${theme.name.replace(" ", "-")}.html`);
  writeFileSync(
    file,
    webviewPage({
      root,
      view,
      messages: recorded,
      themeCss: join(root, "scripts/screenshots", theme.css),
      bodyClass: theme.bodyClass,
    })
  );
  return file;
};

for (const theme of THEMES) {
  for (const view of views) {
    await chrome.open(page(view, theme));
    await chrome.evaluate(axeSource);
    const violations = await chrome.evaluate(`axe
      .run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })
      .then((r) => r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => n.target.join(" ") + (n.failureSummary ? " — " + n.failureSummary.split("\\n").slice(1).join(" ").trim() : "")),
      })))`);
    const errors = chrome.errors.map((e) => `script error: ${e}`);
    const label = `${theme.name.padEnd(13)} ${view.padEnd(11)}`;
    if (violations.length === 0 && errors.length === 0) {
      console.log(`ok    ${label}`);
      continue;
    }
    failures++;
    console.log(`FAIL  ${label}`);
    for (const e of errors) console.log(`        ${e}`);
    for (const v of violations) {
      console.log(`        ${v.impact} ${v.id}: ${v.help} (${v.nodes.length})`);
      for (const n of v.nodes.slice(0, 3)) console.log(`          ${n}`);
    }
  }
}

const axeIn = async (selector) =>
  chrome.evaluate(`axe
    .run(${JSON.stringify(selector)}, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })
    .then((r) => r.violations.map((v) => v.id + " " + v.nodes.map((n) => n.target.join(" ")).join(", ")))`);
const dark = THEMES[1];
for (const scenario of KEYBOARD_SCENARIOS.filter((s) => views.includes(s.view))) {
  await chrome.open(page(scenario.view, dark));
  await chrome.evaluate(axeSource);
  try {
    await scenario.run(chrome, axeIn);
    console.log(`ok    keyboard      ${scenario.view.padEnd(11)} ${scenario.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  keyboard      ${scenario.view.padEnd(11)} ${scenario.name}: ${err.message}`);
  }
}
// Kanban swimlanes taller than the window: every card must stay inside its own lane's cell (a
// squeezed grid row once let cards overflow into, and hide, the next lane).
if (views.includes("kanban")) {
  await chrome.open(page("kanban", dark, variants["kanban-lanes"], "kanban-lanes"));
  const hidden = await chrome.evaluate(`(() => {
    const out = [];
    for (const list of document.querySelectorAll(".cards")) {
      const r = list.getBoundingClientRect();
      for (const card of list.children) {
        const c = card.getBoundingClientRect();
        if (c.top < r.top - 1 || c.bottom > r.bottom + 1) out.push(card.dataset.key);
      }
    }
    return out;
  })()`);
  const lanes = await chrome.evaluate(`document.querySelectorAll(".lane-header").length`);
  if (lanes < 2 || hidden.length) {
    failures++;
    console.log(
      `FAIL  layout        kanban      owner swimlanes: ${lanes} lanes, cards outside their lane: ${hidden.join(", ")}`
    );
  } else {
    console.log(`ok    layout        kanban      owner swimlanes: every card inside its lane`);
  }
}
await chrome.close();
if (failures) {
  console.log(`${failures} accessibility check(s) failed.`);
  process.exit(1);
}
console.log("All accessibility checks passed.");
