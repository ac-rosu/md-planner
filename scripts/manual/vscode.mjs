// VS Code workbench screenshots for the user manual. Starts the VS Code build from .vscode-test
// with md-planner and the helper extension (scripts/manual/helper) on a throwaway copy of the sample
// project, drives it with real key and mouse events over the DevTools protocol, and annotates the
// workbench DOM before each capture.
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { connect, pageTools, sleep } from "./lib.mjs";

const VIEW = { width: 1440, height: 900 };
const WIDE = 0.5;
const CROP = 0.75;

const USER_SETTINGS = {
  "workbench.startupEditor": "none",
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "workbench.tips.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.layoutControl.enabled": false,
  "workbench.view.alwaysShowHeaderActions": true,
  "window.restoreWindows": "none",
  "window.menuStyle": "custom",
  "window.titleBarStyle": "custom",
  "window.commandCenter": true,
  "editor.minimap.enabled": false,
  "editor.stickyScroll.enabled": false,
  "editor.fontSize": 13,
  "editor.hover.delay": 250,
  "editor.suggest.preview": false,
  "editor.accessibilitySupport": "off",
  // Editor context menus render in the light DOM, where the screenshot script can find them.
  "editor.useShadowDOM": false,
  // Modal dialogs (delete confirmation) render in the workbench instead of natively.
  "window.dialogStyle": "custom",
  "files.autoSave": "off",
  "git.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.ignoreRecommendations": true,
  "security.workspace.trust.enabled": false,
  "chat.disableAIFeatures": true,
  "planner.export.openAfterExport": false,
};

/** The VS Code executable downloaded by @vscode/test-electron. */
function findVscode(root) {
  const base = join(root, ".vscode-test");
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("vscode-")) : [];
  for (const d of dirs.sort().reverse()) {
    for (const exe of [
      join(base, d, "Visual Studio Code.app", "Contents", "MacOS", "Code"),
      join(base, d, "Code.exe"),
      join(base, d, "code"),
      join(base, d, "VSCode-linux-x64", "code"),
    ])
      if (existsSync(exe)) return exe;
  }
  throw new Error("No VS Code in .vscode-test; run `npm run test:integration` once.");
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Starts VS Code on a fresh folder `name` (filled by `setup(folder)`), with today pinned. The
 * profile lives in os.tmpdir(): VS Code's IPC socket path must stay short.
 */
export async function launchVscode({ root, today, name, setup }) {
  const base = mkdtempSync(join(tmpdir(), "mdpm-"));
  const folder = join(base, name);
  mkdirSync(folder, { recursive: true });
  setup?.(folder);
  const user = join(base, "u");
  mkdirSync(join(user, "User"), { recursive: true });
  writeFileSync(join(user, "User", "settings.json"), JSON.stringify(USER_SETTINGS, null, 2));
  mkdirSync(join(base, "x"));
  const env = { ...process.env, MD_PLANNER_MANUAL_TODAY: today };
  for (const k of Object.keys(env))
    if (k === "ELECTRON_RUN_AS_NODE" || k.startsWith("VSCODE_")) delete env[k];
  const port = await freePort();
  const child = spawn(
    findVscode(root),
    [
      folder,
      `--user-data-dir=${user}`,
      `--extensions-dir=${join(base, "x")}`,
      `--extensionDevelopmentPath=${root}`,
      `--extensionDevelopmentPath=${join(root, "scripts", "manual", "helper")}`,
      `--remote-debugging-port=${port}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
    ],
    { env, stdio: "ignore" }
  );
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((x) => x.type === "page" && /workbench/.test(x.url));
    } catch {
      // not listening yet
    }
  }
  if (!page) throw new Error("VS Code did not open a workbench window.");
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    ...VIEW,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const t = pageTools(cdp);
  // The status bar item of md-planner appears once the plan is loaded and scheduled.
  await t.waitFor({ sel: ".statusbar-item", text: "overdue" }, 60000).catch(() => undefined);
  await sleep(1500);
  return {
    t,
    folder,
    port,
    async close() {
      cdp.close();
      child.kill();
      await sleep(1000);
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Workbench helpers on top of the page tools; `port` is VS Code's DevTools port. */
export function workbench(t, title, folder, port) {
  const v = {
    /**
     * Rect, in workbench coordinates, of the element `selector` inside the visible webview (Gantt,
     * Kanban …). Webviews are separate DevTools targets: an outer frame with the content in
     * #active-frame.
     */
    async webviewRect(selector) {
      const frames = await t.cdp.evaluate(`[...document.querySelectorAll("iframe.webview.ready")]
        .map((f) => ({ src: f.src, r: f.getBoundingClientRect().toJSON() }))
        .filter((f) => f.r.width > 0 && f.r.height > 0)`);
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for (const f of frames) {
        const id = new URL(f.src).searchParams.get("id");
        const target = targets.find(
          (x) => x.type === "iframe" && new URL(x.url).searchParams.get("id") === id
        );
        if (!target) continue;
        const frame = await connect(target.webSocketDebuggerUrl);
        try {
          const r = await frame.evaluate(`(() => {
            const inner = document.querySelector("#active-frame");
            const el = inner?.contentDocument?.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const a = inner.getBoundingClientRect();
            const b = el.getBoundingClientRect();
            return { x: a.x + b.x, y: a.y + b.y, w: b.width, h: b.height };
          })()`);
          if (r) return { x: f.r.x + r.x, y: f.r.y + r.y, w: r.w, h: r.h };
        } finally {
          frame.close();
        }
      }
      throw new Error(`Not found in a webview: ${selector}`);
    },
    /**
     * Cosmetic only: hides the "[Extension Development Host]" title prefix and shows paths of the
     * throwaway workspace relative to the workspace, as they appear in a normal window.
     */
    async tidy() {
      await t.cdp.evaluate(`(() => {
        const folder = ${JSON.stringify(folder ?? "")};
        const walk = (n) => {
          if (n.nodeType === 3) {
            let s = n.textContent;
            s = s.replace("[Extension Development Host] ", "");
            if (folder) s = s.split(folder + "/").join("").split(folder).join(${JSON.stringify(title)});
            if (s !== n.textContent) n.textContent = s;
          }
          n.childNodes.forEach(walk);
        };
        walk(document.body);
        document.title = ${JSON.stringify(title)};
      })()`);
    },
    async shot(file, opts) {
      await v.tidy();
      await t.shot(file, opts);
    },
    async escape(times = 1) {
      for (let i = 0; i < times; i++) await t.key("Escape", undefined, { wait: 200 });
    },
    quickInput: ".quick-input-widget",
    async waitQuickInput() {
      await t.waitFor(".quick-input-widget .quick-input-box input");
      await sleep(300);
    },
    /** Runs a command from the command palette by its title. */
    async command(name, { submit = true } = {}) {
      await t.key("p", "cmd+shift");
      await v.waitQuickInput();
      await t.type(name);
      await sleep(700);
      if (submit) {
        await t.key("Enter");
        await sleep(800);
      }
    },
    async openFile(name, line) {
      await t.key("p", "cmd");
      await v.waitQuickInput();
      await t.type(name);
      await sleep(900);
      await t.key("Enter");
      await sleep(900);
      if (line) await v.gotoLine(line);
    },
    async gotoLine(line, column) {
      await t.key("g", "ctrl");
      await v.waitQuickInput();
      await t.type(column ? `${line}:${column}` : String(line));
      await sleep(300);
      await t.key("Enter");
      await sleep(400);
    },
    paneHeader: (name) => ({ sel: ".pane-header", within: ".part.sidebar", text: name }),
    pane: (name) => ({ sel: ".pane", within: ".part.sidebar", text: name, closest: ".pane" }),
    row: (text, pane) => ({
      sel: ".monaco-list-row",
      within: pane ? v.pane(pane) : ".part.sidebar",
      text,
    }),
    async showPlanner() {
      await t.click({ sel: ".activitybar .action-label", aria: "Planner" });
      await sleep(800);
    },
    /** Expands or collapses sidebar views so that only `open` are expanded. */
    async onlyPanes(open) {
      const headers = await t.cdp
        .evaluate(`[...document.querySelectorAll(".part.sidebar .pane-header")]
        .map((h) => ({ title: h.querySelector("h3")?.textContent ?? "", expanded: h.getAttribute("aria-expanded") === "true" }))`);
      for (const h of headers) {
        const want = open.includes(h.title);
        if (want !== h.expanded) {
          await t.click({ sel: ".part.sidebar .pane-header h3", exact: h.title }, { wait: 400 });
        }
      }
    },
    /** Drags the sash on the right of the sidebar to the given sidebar width. */
    async sidebarWidth(width) {
      const sb = await t.rect(".part.sidebar");
      const edge = sb.x + sb.w;
      await t.drag({ x: edge, y: sb.y + 300 }, { x: sb.x + width, y: sb.y + 300 }, { steps: 6 });
      await sleep(400);
    },
    /** Hovers editor text until VS Code shows its hover (retries: hovers need fresh movement). */
    async editorHover(rect) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await t.hover({ rect: { x: 30, y: 600, w: 1, h: 1 } });
        await sleep(300);
        await t.hover({ rect });
        try {
          await t.waitFor(".monaco-hover", 3000);
          await sleep(600);
          return;
        } catch {
          // try again
        }
      }
      throw new Error("The editor hover did not appear.");
    },
    /** Hovers a tree row until its inline buttons are visible (they need fresh mouse movement). */
    async hoverRow(row) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await t.hover({ rect: { x: 900, y: 500, w: 1, h: 1 } });
        await sleep(200);
        await t.hover(row);
        await sleep(300);
        if (await t.exists({ sel: ".actions .action-label", within: row })) return;
      }
      throw new Error("The row buttons did not appear.");
    },
    /** Collapses every node of the Milestones view. */
    async collapseAll() {
      await t.click(
        { sel: ".pane-header .action-label", aria: "Collapse All", within: v.pane("Milestones") },
        { wait: 400 }
      );
    },
    /** Expands a tree row (no-op when it is already expanded). */
    async expand(rowTarget) {
      const twistie = { sel: ".monaco-tl-twistie.collapsed", within: rowTarget };
      if (await t.exists(twistie)) await t.click(twistie, { wait: 500 });
    },
    async notificationsClear() {
      await v.command("Notifications: Clear All Notifications");
    },
    /** Screen rect of the text `sub` on the (rendered) editor line that contains `line`. */
    async textRect(line, sub = line) {
      const r = await t.cdp.evaluate(`(() => {
        const norm = (s) => s.replace(/\\u00a0/g, " ");
        const el = [...document.querySelectorAll(".part.editor .monaco-editor .view-line")]
          .find((l) => norm(l.textContent).includes(${JSON.stringify(line)}));
        if (!el) return null;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let text = "";
        while (walker.nextNode()) {
          nodes.push([walker.currentNode, text.length]);
          text += walker.currentNode.textContent;
        }
        const sub = ${JSON.stringify(sub)};
        const i = norm(text).indexOf(sub);
        if (i < 0) return null;
        const at = (k) => {
          for (let j = nodes.length - 1; j >= 0; j--) if (nodes[j][1] <= k) return [nodes[j][0], k - nodes[j][1]];
        };
        const range = document.createRange();
        range.setStart(...at(i));
        range.setEnd(...at(i + sub.length));
        const q = range.getBoundingClientRect();
        return { x: q.left, y: q.top, w: q.width, h: q.height };
      })()`);
      if (!r) throw new Error(`Text not visible in the editor: ${sub} (${line})`);
      return r;
    },
  };
  return v;
}

/** Copies the sample project (without generated folders) into `folder`. */
function copySample(root, folder) {
  cpSync(join(root, "examples", "customer-portal"), folder, {
    recursive: true,
    filter: (src) => !/[\\/](\.planner|reports)([\\/]|$)/.test(src),
  });
}

/** Runs one shot; on failure, saves the whole window as out/manual/failed-<name>.png. */
async function runShot(t, v, name, file, run) {
  try {
    await run(t, v, file);
  } catch (err) {
    const debug = join(file, "..", "..", "..", "..", "out", "manual", `failed-${name}.png`);
    await t.shot(debug, { scale: WIDE }).catch(() => undefined);
    console.error(`  ! ${name} failed; window saved as ${debug}`);
    throw err;
  }
}

export async function captureVscode({ root, out, today, only }) {
  const want = (name) => !only || only.some((o) => name.startsWith(o));
  const img = (name) => join(out, `${name}.png`);
  const sampleShots = SAMPLE_SHOTS.filter((s) => want(s[0]));
  if (sampleShots.length) {
    const vs = await launchVscode({
      root,
      today,
      name: "customer-portal",
      setup: (f) => copySample(root, f),
    });
    try {
      const v = workbench(vs.t, "customer-portal", vs.folder, vs.port);
      await v.showPlanner();
      await v.sidebarWidth(430);
      await v.openFile("M2-backend.md");
      for (const [name, run] of sampleShots) {
        await runShot(vs.t, v, name, img(name), run);
        await v.escape(2);
      }
    } finally {
      await vs.close();
    }
  }
  const newShots = NEW_PROJECT_SHOTS.filter((s) => want(s[0]));
  if (newShots.length) {
    const vs = await launchVscode({ root, today, name: "mobile-app" });
    try {
      const v = workbench(vs.t, "mobile-app", vs.folder, vs.port);
      await v.showPlanner();
      await v.sidebarWidth(430);
      for (const [name, run] of newShots) await runShot(vs.t, v, name, img(name), run);
    } finally {
      await vs.close();
    }
  }
}

const quickInput = (pad = 8) => ({ clip: ".quick-input-widget", pad });
const sidebar = ".part.sidebar";

/** Waits until the element returned by the browser expression `find` is visible; its rect. */
async function waitForRect(t, find, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    const r = await t.cdp.evaluate(`(() => {
      const e = ${find};
      const r = e?.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    })()`);
    if (r) return r;
    if (Date.now() > end) throw new Error("Timed out waiting for an element");
    await sleep(150);
  }
}

/** Crop of the sidebar from its top down to `height` CSS px, plus `extra` px of the editor. */
async function sidebarClip(t, height, extra = 0) {
  const r = await t.rect(sidebar);
  return { x: r.x, y: r.y, w: r.w + extra, h: height ?? r.h };
}

const SAMPLE_SHOTS = [
  [
    "vscode-overview",
    async (t, v, file) => {
      await v.onlyPanes([
        "Milestones",
        "My Work / Team",
        "Inbox",
        "Punch List",
        "Tests",
        "TODOs in Code",
      ]);
      await v.gotoLine(1);
      const header = (name) => ({ sel: ".part.sidebar .pane-header h3", exact: name });
      await v.shot(file, {
        scale: WIDE,
        annotations: [
          { target: { sel: ".activitybar .action-label", aria: "Planner" }, n: 1, at: "e", d: 4 },
          { target: header("Milestones"), n: 2, at: "e", d: 10 },
          { target: header("My Work / Team"), n: 3, at: "e", d: 10 },
          { target: header("Inbox"), n: 4, at: "e", d: 10 },
          { target: header("Punch List"), n: 5, at: "e", d: 10 },
          { target: header("Tests"), n: 6, at: "e", d: 10 },
          { target: header("TODOs in Code"), n: 7, at: "e", d: 30 },
          { target: { sel: ".part.editor .codelens-decoration", index: 0 }, n: 8, at: "e", d: 14 },
          { target: { sel: ".part.editor .codelens-decoration", index: 2 }, n: 9, at: "e", d: 14 },
          {
            target: '.editor-actions .action-label[aria-label="Open Gantt"]',
            n: 10,
            at: "s",
            d: 10,
          },
          { target: { sel: ".statusbar-item", text: "overdue" }, n: 11, at: "n", d: 10 },
          { target: '[id="status.problems"]', n: 12, at: "n", d: 10 },
        ],
      });
    },
  ],
  [
    "sidebar-actions",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      const header = await t.rect(v.paneHeader("Milestones"));
      const act = (label) => ({
        sel: ".pane-header .action-label",
        aria: label,
        within: v.pane("Milestones"),
      });
      const first = await t.rect(act("Add task…"));
      const b = (label, n, d) => ({ target: act(label), n, at: "s", d, box: false });
      const x = first.x - 16;
      await v.shot(file, {
        scale: 1,
        clip: { x, y: header.y - 4, w: header.x + header.w - x, h: 96 },
        annotations: [
          b("Add task…", 1, 6),
          b("Add milestone…", 2, 38),
          b("Filter…", 3, 6),
          b("Open Gantt", 4, 38),
          b("Open Kanban", 5, 6),
          b("Open dashboard", 6, 38),
          b("Export…", 7, 6),
          b("Collapse All", 8, 38),
          b("More Actions...", 9, 6),
        ],
      });
      await t.click(act("More Actions..."));
      // Toolbar dropdown menus render in a shadow root.
      const menu = await waitForRect(
        t,
        `[...document.querySelectorAll(".shadow-root-host")]
          .map((h) => h.shadowRoot?.querySelector(".monaco-menu"))
          .find(Boolean)`
      );
      await sleep(400);
      await v.shot(file.replace("sidebar-actions", "sidebar-more"), {
        scale: CROP,
        clip: {
          x: menu.x - 220,
          y: header.y - 4,
          w: menu.w + 240,
          h: menu.y + menu.h - header.y + 16,
        },
      });
      await v.escape();
    },
  ],
  [
    "sidebar-milestones",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.expand(v.row("M1 – Discovery"));
      await v.expand(v.row("M2 – Backend"));
      await v.hoverRow(v.row("Shared API library"));
      const sb = await sidebarClip(t, 560);
      await v.shot(file, {
        scale: CROP,
        clip: { ...sb, w: sb.w + 40 },
        annotations: [
          {
            target: { sel: ".label-description", within: v.row("M1 – Discovery") },
            n: 1,
            at: "s",
            d: 2,
            dx: 40,
          },
          { target: { sel: ".label-name", within: v.row("Preparation") }, n: 2, at: "e", d: 60 },
          {
            target: {
              sel: ".custom-view-tree-node-item-icon, .codicon",
              within: v.row("Domain model"),
            },
            n: 3,
            at: "w",
            d: 8,
          },
          {
            target: { sel: ".label-description", within: v.row("Domain model") },
            n: 4,
            at: "e",
            d: 10,
          },
          {
            target: { sel: ".actions", within: v.row("Shared API library") },
            n: 5,
            at: "s",
            d: 4,
          },
          {
            target: { sel: ".label-description", within: v.row("Payment form") },
            n: 6,
            at: "e",
            d: 10,
          },
        ],
      });
    },
  ],
  [
    "sidebar-tooltip",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.expand(v.row("M2 – Backend"));
      await t.hover(v.row("Checkout flow"));
      await t.waitFor(".workbench-hover, .monaco-hover", 8000);
      await sleep(400);
      const row = await t.rect(v.row("Checkout flow"));
      const hover = await t.rect(".workbench-hover");
      const x = Math.min(row.x, hover.x) - 8;
      const y = Math.min(row.y, hover.y) - 8;
      await v.shot(file, {
        scale: CROP,
        clip: {
          x,
          y,
          w: Math.max(row.x + row.w, hover.x + hover.w) - x + 8,
          h: Math.max(row.y + row.h, hover.y + hover.h) - y + 8,
        },
      });
      await t.hover({ rect: { x: 900, y: 500, w: 1, h: 1 } });
    },
  ],
  [
    "sidebar-context-menu",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.expand(v.row("M2 – Backend"));
      await v.expand(v.row("Common"));
      await t.click(v.row("Shared API library"), { button: "right" });
      await t.waitFor(".context-view .monaco-menu");
      await t.hover({ sel: ".context-view .action-label", text: "Set status" });
      await sleep(900);
      const menus = await t.rect({ sel: ".context-view .monaco-menu", all: true });
      const row = await t.rect(v.row("Shared API library"));
      await v.shot(file, {
        scale: CROP,
        clip: {
          x: row.x,
          y: row.y - 10,
          w: menus.x + menus.w - row.x + 12,
          h: menus.y + menus.h - row.y + 22,
        },
      });
    },
  ],
  [
    "sidebar-filter",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await t.click({
        sel: ".pane-header .action-label",
        aria: "Filter…",
        within: v.pane("Milestones"),
      });
      await v.waitQuickInput();
      await v.shot(file, quickInput());
      await t.key("Enter"); // Owner
      await v.waitQuickInput();
      await sleep(300);
      await t.click(
        { sel: ".quick-input-list .monaco-list-row", text: "Sam" },
        { at: { x: 0, dx: 18 } }
      );
      await v.shot(file.replace("sidebar-filter", "sidebar-filter-owner"), quickInput());
      await t.click({ sel: ".quick-input-widget .monaco-button", exact: "OK" });
      await sleep(800);
      await v.shot(file.replace("sidebar-filter", "sidebar-filtered"), {
        scale: CROP,
        clip: await sidebarClip(t, 330),
        annotations: [
          {
            target: { sel: ".message", within: v.pane("Milestones") },
            label: "Active filter",
            at: "in-ne",
          },
          {
            target: {
              sel: ".pane-header .action-label",
              aria: "Clear filter",
              within: v.pane("Milestones"),
            },
            label: "Clear filter",
            at: "s",
            d: 30,
            dx: -40,
          },
        ],
      });
      await t.click({
        sel: ".pane-header .action-label",
        aria: "Clear filter",
        within: v.pane("Milestones"),
      });
    },
  ],
  [
    "sidebar-team",
    async (t, v, file) => {
      await v.onlyPanes(["My Work / Team"]);
      await v.expand(v.row("Sam"));
      const act = (label) => ({
        sel: ".pane-header .action-label",
        aria: label,
        within: v.pane("My Work / Team"),
      });
      const row = (text) => v.row(text, "My Work / Team");
      await v.hoverRow(row("Sam"));
      await v.shot(file, {
        scale: CROP,
        clip: await sidebarClip(t, 700, 250),
        annotations: [
          {
            target: act("Add person…"),
            label: "Add person…",
            n: 1,
            at: "e",
            d: 30,
            dy: -62,
            from: v.paneHeader("My Work / Team"),
          },
          {
            target: act("Filter…"),
            label: "Filter…",
            n: 2,
            at: "e",
            d: 30,
            dy: -31,
            from: v.paneHeader("My Work / Team"),
          },
          {
            target: act("Open team load"),
            label: "Open team load",
            n: 3,
            at: "e",
            d: 30,
            dy: 0,
            from: v.paneHeader("My Work / Team"),
          },
          {
            target: { sel: ".actions", within: row("Sam") },
            label: "Add time off · Edit person",
            n: 4,
            at: "e",
            d: 20,
            from: row("Sam"),
          },
          {
            target: { sel: ".label-description", within: row("Alex") },
            label: "Role · open tasks · this week",
            n: 5,
            at: "e",
            d: 20,
            from: row("Alex"),
          },
          {
            target: row("Domain model"),
            label: "Sorted by scheduled start",
            n: 6,
            at: "e",
            d: 20,
            dy: 14,
            box: false,
          },
          {
            target: { sel: ".label-name", within: row("Unassigned") },
            label: "Tasks without @owner",
            n: 7,
            at: "e",
            d: 20,
            from: row("Unassigned"),
          },
        ],
      });
    },
  ],
  [
    "sidebar-inbox",
    async (t, v, file) => {
      await v.onlyPanes(["Inbox"]);
      await v.hoverRow(v.row("Ask the payment provider"));
      await v.shot(file, {
        scale: CROP,
        clip: await sidebarClip(t, 220, 250),
        annotations: [
          {
            target: { sel: ".actions .action-label", within: v.row("Ask the payment provider") },
            label: "Plan into milestone…",
            at: "e",
            d: 20,
            from: v.row("Ask the payment provider"),
          },
        ],
      });
      await v.hoverRow(v.row("Ask the payment provider"));
      await t.click({ sel: ".actions .action-label", within: v.row("Ask the payment provider") });
      await v.waitQuickInput();
      await v.shot(file.replace("sidebar-inbox", "inbox-plan"), quickInput());
      await t.type("Backend");
      await sleep(300);
      await t.key("Enter");
      await v.waitQuickInput();
      await v.shot(file.replace("sidebar-inbox", "inbox-section"), quickInput());
      await v.escape();
    },
  ],
  [
    "sidebar-punch",
    async (t, v, file) => {
      await v.onlyPanes(["Punch List"]);
      await v.expand(v.row("Closed"));
      const act = (label) => ({
        sel: ".pane-header .action-label",
        aria: label,
        within: v.pane("Punch List"),
      });
      const row = (text) => v.row(text, "Punch List");
      await v.shot(file, {
        scale: CROP,
        clip: await sidebarClip(t, 470, 250),
        annotations: [
          {
            target: act("Add punch item…"),
            label: "Add punch item…",
            at: "e",
            d: 30,
            dy: -74,
            from: v.paneHeader("Punch List"),
          },
          {
            target: act("Filter…"),
            label: "Filter…",
            at: "e",
            d: 30,
            dy: -44,
            from: v.paneHeader("Punch List"),
          },
          {
            target: act("Open punch-list board"),
            label: "Punch-list board",
            at: "e",
            d: 30,
            dy: -14,
            from: v.paneHeader("Punch List"),
          },
          {
            target: { sel: ".label-name", within: row("Severity A") },
            label: "Severity group",
            at: "e",
            d: 20,
            from: row("Severity A"),
          },
          {
            target: { sel: ".label-name", within: { ...row("Sam"), index: 0 } },
            label: "Owner",
            at: "e",
            d: 20,
            from: { ...row("Sam"), index: 0 },
          },
          {
            target: { sel: ".label-description", within: row("Payment confirmation") },
            label: "Id · due · overdue",
            at: "e",
            d: 20,
            from: row("Payment confirmation"),
          },
          {
            target: { sel: ".label-name", within: row("Closed") },
            label: "Closed items",
            at: "e",
            d: 20,
            from: row("Closed"),
          },
        ],
      });
    },
  ],
  [
    "sidebar-tests",
    async (t, v, file) => {
      await v.onlyPanes(["Tests"]);
      await v.expand(v.row("Acceptance test – Checkout"));
      await v.expand(v.row("TC-01"));
      await t.hover(v.row("Acceptance test – Checkout"));
      await sleep(250);
      const row = (text) => v.row(text, "Tests");
      await v.shot(file, {
        scale: CROP,
        clip: await sidebarClip(t, 470, 250),
        annotations: [
          {
            target: { sel: ".actions .action-label", within: row("Acceptance test – Checkout") },
            label: "Open test runner",
            at: "e",
            d: 20,
            from: row("Acceptance test – Checkout"),
          },
          {
            target: { sel: ".label-description", within: row("TC-01") },
            label: "Pass / fail / open per case",
            at: "e",
            d: 20,
            from: row("TC-01"),
          },
          {
            target: { sel: ".label-description", within: row("Pay with a test card") },
            label: "Note → punch item",
            at: "e",
            d: 20,
            from: row("Pay with a test card"),
          },
        ],
      });
    },
  ],
  [
    "sidebar-todos",
    async (t, v, file) => {
      await v.onlyPanes(["TODOs in Code"]);
      await t.hover(v.row("TODO: handle the payment"));
      await sleep(250);
      const row = (text) => v.row(text, "TODOs in Code");
      await v.shot(file, {
        scale: CROP,
        clip: await sidebarClip(t, 480, 250),
        annotations: [
          {
            target: { sel: ".actions .action-label", within: row("TODO: handle the payment") },
            label: "Promote to task…",
            at: "e",
            d: 20,
            from: row("TODO: handle the payment"),
          },
          {
            target: {
              sel: ".custom-view-tree-node-item-icon, .codicon",
              within: row("implement credit notes"),
            },
            label: "Link icon: already a task (T113)",
            at: "e",
            d: 20,
            from: row("implement credit notes"),
          },
          {
            target: { sel: ".label-name", within: row("payments.ts") },
            label: "File · count",
            at: "e",
            d: 20,
            from: row("payments.ts"),
          },
        ],
      });
    },
  ],
  [
    "editor-hover-task",
    async (t, v, file) => {
      await v.gotoLine(20);
      await v.editorHover(await v.textRect("Order state machine", "T101"));
      const h = await t.rect(".monaco-hover");
      const r = await v.textRect("Order state machine", "T101");
      await v.shot(file, {
        scale: CROP,
        clip: {
          x: Math.min(h.x, r.x) - 20,
          y: Math.min(h.y, r.y) - 12,
          w: Math.max(h.w, 300) + 60,
          h: Math.abs(r.y - h.y) + h.h + 40,
        },
      });
    },
  ],
  [
    "editor-hover-owner",
    async (t, v, file) => {
      await v.gotoLine(20);
      const r = await v.textRect("Order state machine", "@owner:sam");
      await v.editorHover({ x: r.x + r.w - 20, y: r.y, w: 10, h: r.h });
      const h = await t.rect(".monaco-hover");
      await v.shot(file, {
        scale: CROP,
        clip: {
          x: Math.min(h.x, r.x) - 20,
          y: Math.min(h.y, r.y) - 12,
          w: Math.max(h.w, 300) + 60,
          h: Math.abs(r.y - h.y) + h.h + 40,
        },
      });
    },
  ],
  [
    "editor-todo-menu",
    async (t, v, file) => {
      await v.openFile("payments.ts", 17);
      const r = await v.textRect("TODO: handle the payment", "handle the payment");
      await t.click({ rect: r }, { button: "right" });
      await t.waitFor(".context-view .monaco-menu");
      await sleep(400);
      const menu = await t.rect(".context-view .monaco-menu");
      await v.shot(file, {
        scale: CROP,
        clip: {
          x: r.x - 140,
          y: r.y - 30,
          w: menu.x + menu.w - r.x + 300,
          h: menu.y + menu.h - r.y + 40,
        },
        annotations: [
          {
            target: { sel: ".context-view .action-label", text: "Promote to task" },
            label: "Planner",
            at: "e",
            d: 20,
            dx: 0,
          },
        ],
      });
      await v.escape();
      await v.openFile("M2-backend.md", 1);
    },
  ],
  [
    "editor-codelens",
    async (t, v, file) => {
      await v.gotoLine(1);
      const ed = await t.rect(".part.editor");
      const lens = (text) => ({ sel: ".codelens-decoration", text });
      await v.shot(file, {
        scale: CROP,
        clip: { x: ed.x, y: ed.y + 34, w: 1010, h: 620 },
        annotations: [
          {
            target: lens("forecast"),
            label: "Progress, forecast · Add task · Add section · Edit milestone",
            at: "s",
            d: 66,
            dx: 260,
          },
          {
            target: lens("slack 21 d"),
            label: "Schedule · owner (click to change) · Edit",
            at: "e",
            d: 30,
          },
          { target: lens("done 2026-10-06"), label: "Done date", at: "e", d: 30 },
          { target: lens("50%"), label: "Parent: roll-up and progress", at: "e", d: 30 },
          {
            target: lens("from the parent"),
            label: "Owner inherited from the parent",
            at: "e",
            d: 30,
          },
        ],
      });
    },
  ],
  [
    "editor-peek",
    async (t, v, file) => {
      await v.gotoLine(14);
      await t.click({ rect: await v.textRect("Shared API library", "^T121") });
      await v.command("Go to References");
      await t.waitFor(".peekview-widget", 8000);
      await sleep(900);
      const ed = await t.rect(".part.editor");
      const peek = await t.rect(".peekview-widget");
      await v.shot(file, {
        scale: WIDE,
        clip: { x: ed.x, y: peek.y - 90, w: ed.w, h: peek.h + 100 },
      });
      await v.escape();
    },
  ],
  [
    "editor-rename",
    async (t, v, file) => {
      await v.gotoLine(25);
      await t.click({ rect: await v.textRect("^T105", "T105") });
      await v.command("Rename Symbol");
      await t.waitFor(".rename-box", 8000);
      await sleep(400);
      const b = await t.rect(".rename-box");
      await v.shot(file, {
        scale: CROP,
        clip: { x: b.x - 420, y: b.y - 40, w: b.w + 520, h: b.h + 70 },
      });
      await v.escape();
    },
  ],
  [
    "editor-problems",
    async (t, v, file) => {
      await t.key("m", "cmd+shift");
      await t.waitFor(".part.panel .markers-panel, .part.panel .monaco-list", 8000);
      await sleep(900);
      const p = await t.rect(".part.panel");
      await v.shot(file, { scale: WIDE, clip: { x: p.x, y: p.y, w: p.w, h: p.h } });
      await t.key("j", "cmd"); // hide the panel again
      await sleep(400);
    },
  ],
  [
    "editor-context-menu",
    async (t, v, file) => {
      await v.gotoLine(14);
      const r = await v.textRect("Shared API library", "Shared API library");
      await t.click({ rect: r }, { button: "right" });
      await t.waitFor(".context-view .monaco-menu");
      await sleep(400);
      const menu = await t.rect(".context-view .monaco-menu");
      await v.shot(file, {
        scale: CROP,
        clip: { x: menu.x - 30, y: menu.y - 10, w: menu.w + 280, h: menu.h + 20 },
        annotations: [
          {
            target: {
              sel: ".context-view .action-label",
              text: "Edit task",
              closest: ".action-item",
            },
            label: "Every field of the task",
            at: "e",
            d: 40,
          },
          {
            target: {
              sel: ".context-view .action-label",
              text: "Set status",
              closest: ".action-item",
            },
            label: "Status submenu",
            at: "e",
            d: 40,
          },
          {
            target: {
              sel: ".context-view .action-label",
              text: "Planner AI",
              closest: ".action-item",
            },
            label: "AI submenu",
            at: "e",
            d: 40,
          },
        ],
      });
    },
  ],
  [
    "editor-status-cycle",
    async (t, v, file) => {
      await v.gotoLine(14);
      const line = async () => {
        const r = await v.textRect("Shared API library", "- [");
        const ed = await t.rect(".part.editor .monaco-editor");
        return { x: r.x - 70, y: r.y - 22, w: ed.x + ed.w - r.x + 40, h: 48 };
      };
      await v.shot(file.replace("cycle", "before"), { scale: CROP, clip: await line() });
      const box = await v.textRect("Shared API library", "[ ]");
      await t.click({ rect: { x: box.x + box.w / 2 - 1, y: box.y, w: 2, h: box.h } });
      await sleep(1200);
      await v.shot(file.replace("cycle", "after"), { scale: CROP, clip: await line() });
      await t.key("z", "cmd");
      await sleep(600);
    },
  ],
  [
    "editor-complete",
    async (t, v, file) => {
      const shotSuggest = async (name) => {
        await t.waitFor(".suggest-widget.visible", 8000);
        await sleep(500);
        const s = await t.rect(".suggest-widget.visible");
        const c = await v.textRect("Payment sandbox test", "- [ ] Payment sandbox");
        const x = c.x - 40;
        await v.shot(file.replace("editor-complete", name), {
          scale: CROP,
          clip: { x, y: c.y - 30, w: Math.max(s.x + s.w - x + 20, 700), h: s.y + s.h - c.y + 44 },
        });
      };
      await v.gotoLine(28);
      await t.key("End");
      await t.key("Enter");
      await t.key("Home", "shift");
      await t.type("- [ ] Payment sandbox test ", { slow: 15 });
      await t.type("@", { wait: 300 });
      await shotSuggest("editor-complete-keys");
      await t.type("owner:", { slow: 40, wait: 500 });
      await shotSuggest("editor-complete-owner");
      await t.type("sam", { slow: 30 });
      await v.escape();
      await t.type(" @dep:", { slow: 40, wait: 500 });
      await shotSuggest("editor-complete-dep");
      await t.type("T105", { slow: 30 });
      await v.escape();
      await t.type(" @due:", { slow: 40, wait: 500 });
      await shotSuggest("editor-complete-date");
      await v.escape();
      await t.type("2026-11-27", { slow: 15 });
      await sleep(1500);
      await t.key(".", "cmd");
      await t.waitFor(".action-widget", 8000);
      await sleep(500);
      const menu = await t.rect(".action-widget");
      const line = await v.textRect("Payment sandbox test", "- [ ] Payment sandbox");
      await v.shot(file.replace("editor-complete", "editor-quickfix"), {
        scale: CROP,
        clip: {
          x: line.x - 60,
          y: line.y - 30,
          w: Math.max(menu.x + menu.w - line.x + 100, 760),
          h: menu.y + menu.h - line.y + 50,
        },
      });
      await t.click({ sel: ".action-widget .monaco-list-row", text: "@est:1d" });
      await sleep(600);
      await t.key("s", "cmd");
      await sleep(1800);
      const after = await v.textRect("Payment sandbox test", "- [ ] Payment sandbox");
      const ed = await t.rect(".part.editor .monaco-editor");
      await v.shot(file.replace("editor-complete", "editor-autoid"), {
        scale: CROP,
        clip: { x: after.x - 60, y: after.y - 24, w: ed.x + ed.w - after.x + 40, h: 52 },
      });
    },
  ],
  [
    "statusbar",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.expand(v.row("M2 – Backend"));
      await v.expand(v.row("Common"));
      await t.click(v.row("Shared API library"), { button: "right" });
      await t.waitFor(".context-view .monaco-menu");
      await t.click({ sel: ".context-view .action-label", text: "Start timer" });
      await sleep(2500);
      const sb = await t.rect(".part.statusbar");
      await v.shot(file, {
        scale: CROP,
        clip: { x: 0, y: sb.y - 70, w: 620, h: sb.h + 70 },
        annotations: [
          {
            target: { sel: ".statusbar-item", text: "overdue" },
            label: "Overdue and blocked → dashboard",
            at: "n",
            d: 14,
            dx: 30,
          },
          {
            target: { sel: ".statusbar-item", text: "T121" },
            label: "Running timer → click to stop",
            at: "n",
            d: 14,
            dx: 140,
          },
        ],
      });
    },
  ],
  [
    "log-time",
    async (t, v, file) => {
      await v.gotoLine(14);
      await v.command("Planner: Log time");
      await v.waitQuickInput();
      await t.type("1h30m");
      await v.shot(file, quickInput());
      await v.escape();
    },
  ],
  [
    "command-palette",
    async (t, v, file) => {
      await v.command("Planner: ", { submit: false });
      await v.shot(file, quickInput());
      await v.escape();
    },
  ],
  [
    "export",
    async (t, v, file) => {
      await v.command("Planner: Export");
      await v.waitQuickInput();
      await v.shot(file.replace("export", "export-formats"), quickInput());
      await t.key("Enter");
      await v.waitQuickInput();
      await v.shot(file.replace("export", "export-sections"), quickInput());
      await t.key("Enter");
      await v.waitQuickInput();
      await v.shot(file.replace("export", "export-summary"), quickInput());
      await t.key("ArrowDown");
      await t.key("Enter");
      await v.waitQuickInput();
      await t.type(
        "Discovery on track for 20 October; backend ahead of plan; launch forecast 3 days late."
      );
      await v.shot(file.replace("export", "export-summary-text"), quickInput());
      await t.key("Enter");
      await t.waitFor({ sel: ".notification-toast", text: "exported" }, 30000);
      await sleep(500);
      const n = await t.rect({
        sel: ".notification-toast",
        text: "exported",
        closest: ".notification-toast",
      });
      await v.shot(file.replace("export", "export-done"), {
        scale: CROP,
        clip: { x: n.x, y: n.y, w: n.w, h: n.h },
        pad: 8,
      });
      await v.notificationsClear();
    },
  ],
  [
    "baseline-save",
    async (t, v, file) => {
      await v.command("Planner: Save baseline");
      await v.waitQuickInput();
      await t.type("after sign-off");
      await v.shot(file, quickInput());
      await v.escape();
    },
  ],
  [
    "ai",
    async (t, v, file) => {
      await v.gotoLine(41);
      const r = await v.textRect("Invoice generation", "Invoice generation");
      await t.click({ rect: r }, { button: "right" });
      await t.waitFor(".context-view .monaco-menu");
      await t.hover({ sel: ".context-view .action-label", text: "Planner AI" });
      await sleep(900);
      const menus = await t.rect({ sel: ".context-view .monaco-menu", all: true });
      await v.shot(file.replace("ai", "ai-menu"), {
        scale: CROP,
        clip: { x: menus.x - 10, y: menus.y - 10, w: menus.w + 20, h: menus.h + 20 },
      });
      await t.click({ sel: ".context-view .action-label", text: "Break down task" });
      await t.waitFor(".monaco-diff-editor", 30000);
      await t.waitFor({ sel: ".notification-toast", text: "proposal" }, 30000);
      await sleep(1500);
      await v.shot(file.replace("ai", "ai-proposal"), {
        scale: WIDE,
        annotations: [
          {
            target: { sel: ".tab", text: "AI proposal", closest: ".tab" },
            label: "Proposal (diff)",
            at: "s",
            d: 4,
            dx: -40,
            n: 1,
          },
          {
            target: '.editor-actions .action-label[aria-label="Accept AI proposal"]',
            n: 2,
            label: "Accept",
            at: "s",
            d: 30,
            dx: -70,
          },
          {
            target: '.editor-actions .action-label[aria-label="Reject AI proposal"]',
            n: 3,
            label: "Reject",
            at: "s",
            d: 30,
            dx: 40,
          },
          {
            target: {
              sel: ".notification-toast",
              text: "proposal",
              closest: ".notification-toast",
            },
            n: 4,
            label: "Or decide here",
            at: "w",
            d: 20,
          },
          { target: { sel: ".part.panel" }, n: 5, label: "Planner AI log", at: "in-ne", pad: -2 },
        ],
      });
      await t.click({ sel: ".notification-toast .monaco-button", text: "Reject" });
      await sleep(800);
      await t.key("j", "cmd");
      await v.command("View: Close All Editors");
      await v.openFile("M2-backend.md", 1);
    },
  ],
  [
    "gantt-vscode",
    async (t, v, file) => {
      await v.onlyPanes([
        "Milestones",
        "My Work / Team",
        "Inbox",
        "Punch List",
        "Tests",
        "TODOs in Code",
      ]);
      await t.click({
        sel: ".pane-header .action-label",
        aria: "Open Gantt",
        within: v.pane("Milestones"),
      });
      await t.waitFor({ sel: ".tab", text: "Gantt" }, 15000);
      await sleep(3000);
      await v.shot(file, {
        scale: WIDE,
        annotations: [
          {
            target: {
              sel: ".pane-header .action-label",
              aria: "Open Gantt",
              within: v.pane("Milestones"),
            },
            label: "Open Gantt",
            at: "s",
            d: 30,
          },
          {
            target: { sel: ".tab", text: "Gantt", closest: ".tab" },
            label: "Opens as an editor tab",
            at: "s",
            d: 60,
            dx: 120,
          },
        ],
      });
      await v.command("View: Close All Editors");
      await v.openFile("M2-backend.md", 1);
    },
  ],
  [
    "walkthrough",
    async (t, v, file) => {
      await v.command("Welcome: Open Walkthrough", { submit: true });
      await v.waitQuickInput();
      await t.type("Markdown Project Planner");
      await sleep(500);
      await t.key("Enter");
      await sleep(3000);
      await t.hover({ rect: { x: 25, y: 700, w: 1, h: 1 } });
      await sleep(600);
      await v.shot(file, { scale: WIDE });
      await v.command("View: Close All Editors");
      await v.openFile("M2-backend.md", 1);
    },
  ],
  [
    "settings",
    async (t, v, file) => {
      await v.command("Preferences: Open Settings (UI)");
      await sleep(1500);
      await t.type("planner.ai");
      await sleep(1500);
      await v.shot(file, { scale: WIDE });
    },
  ],
  // ------------------------------------------------------------------ Add and edit from the UI
  [
    "tree-actions",
    async (t, v, file) => {
      await v.command("View: Close All Editors");
      await v.openFile("M2-backend.md", 1);
      await v.onlyPanes(["Milestones"]);
      await v.collapseAll();
      await v.expand(v.row("M2 – Backend"));
      await v.expand(v.row("Common"));
      await t.click(v.row("Shared API library"));
      await sleep(1200);
      await v.hoverRow(v.row("M2 – Backend"));
      const m2 = await t.rect(v.row("M2 – Backend"));
      const sb = await t.rect(sidebar);
      const act = (row, aria) => ({ sel: ".actions .action-label", aria, within: v.row(row) });
      await v.shot(file, {
        scale: CROP,
        clip: { x: sb.x, y: m2.y - 8, w: sb.w + 50, h: 150 },
        annotations: [
          { target: { sel: ".actions", within: v.row("M2 – Backend") }, n: 1, at: "e", d: 6 },
          { target: act("Shared API library", "Edit task…"), n: 2, at: "s", d: 30, box: false },
          {
            target: act("Shared API library", "Assign owner…"),
            n: 3,
            at: "s",
            d: 6,
            box: false,
          },
          {
            target: act("Shared API library", "Cycle status"),
            n: 4,
            at: "s",
            d: 30,
            box: false,
          },
        ],
      });
    },
  ],
  [
    "form",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.collapseAll();
      await v.expand(v.row("M2 – Backend"));
      await v.expand(v.row("Common"));
      const row = v.row("Notifications and e-mail service");
      await v.hoverRow(row);
      await t.click({ sel: ".actions .action-label", aria: "Edit task…", within: row });
      await v.waitQuickInput();
      await sleep(300);
      const qi = await t.rect(v.quickInput);
      const clip = { x: qi.x - 10, y: qi.y - 10, w: qi.w + 330, h: qi.h + 20 };
      const item = (text) => ({ sel: ".quick-input-list .monaco-list-row", text });
      await v.shot(file.replace("form", "form-edit-task"), {
        scale: CROP,
        clip,
        annotations: [
          { target: ".quick-input-titlebar", n: 1, at: "e", d: 20 },
          { target: item("Save changes"), n: 2, at: "e", d: 20 },
          { target: item("Owner"), n: 3, at: "e", d: 20 },
          { target: { sel: ".label-description", within: item("Estimate") }, n: 4, at: "e", d: 60 },
          { target: item("Add subtask"), n: 5, at: "e", d: 20 },
        ],
      });
      await t.type("Depends on");
      await sleep(300);
      await t.key("Enter");
      await v.waitQuickInput();
      await sleep(400);
      await v.shot(file.replace("form", "form-depends"), quickInput());
      await v.escape();
      await v.waitQuickInput();
      await t.type("Priority");
      await sleep(300);
      await t.key("Enter");
      await v.waitQuickInput();
      await t.type("High");
      await sleep(300);
      await t.key("Enter");
      await v.waitQuickInput();
      await sleep(400);
      await v.shot(file.replace("form", "form-changed"), {
        scale: CROP,
        clip,
        annotations: [
          {
            target: { sel: ".label-description", within: item("Priority") },
            label: "● changed – not written yet",
            at: "e",
            d: 60,
          },
          { target: item("Save changes"), label: "Enter writes all changes", at: "e", d: 20 },
        ],
      });
      await v.escape();
      await t.waitFor(".monaco-dialog-box", 5000);
      await sleep(300);
      await v.shot(file.replace("form", "form-discard"), {
        scale: CROP,
        clip: ".monaco-dialog-box",
        pad: 8,
      });
      await t.click({ sel: ".monaco-dialog-box .monaco-button", text: "Discard" });
      await sleep(300);
    },
  ],
  [
    "form-add-task",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.collapseAll();
      await v.expand(v.row("M2 – Backend"));
      const section = v.row("Billing");
      await v.hoverRow(section);
      await t.click({ sel: ".actions .action-label", aria: "Add task…", within: section });
      await v.waitQuickInput();
      await t.type("Billing report export");
      await v.shot(file.replace("form-add-task", "form-add-task-title"), quickInput());
      await t.key("Enter");
      await v.waitQuickInput();
      await sleep(400);
      const qi = await t.rect(v.quickInput);
      const item = (text) => ({ sel: ".quick-input-list .monaco-list-row", text });
      await v.shot(file, {
        scale: CROP,
        clip: { x: qi.x - 10, y: qi.y - 10, w: qi.w + 330, h: qi.h + 20 },
        annotations: [
          { target: item("Create task"), label: "Enter creates the task", at: "e", d: 20 },
          {
            target: item("Create and add another"),
            label: "…and opens the next one",
            at: "e",
            d: 20,
          },
          { target: item("Owner"), label: "Optional: fill in now or later", at: "e", d: 20 },
        ],
      });
      await v.escape();
    },
  ],
  [
    "assign-owner",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.collapseAll();
      await v.expand(v.row("M2 – Backend"));
      await v.expand(v.row("Accounts"));
      const row = v.row("Password reset and e-mail verification");
      await v.hoverRow(row);
      await t.click({ sel: ".actions .action-label", aria: "Assign owner…", within: row });
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(file, quickInput());
      await v.escape();
    },
  ],
  [
    "form-person",
    async (t, v, file) => {
      await v.onlyPanes(["My Work / Team"]);
      const row = v.row("Jordan", "My Work / Team");
      await v.hoverRow(row);
      await t.click({ sel: ".actions .action-label", aria: "Edit person…", within: row });
      await v.waitQuickInput();
      await sleep(300);
      const qi = await t.rect(v.quickInput);
      const item = (text) => ({ sel: ".quick-input-list .monaco-list-row", text });
      await v.shot(file, {
        scale: CROP,
        clip: { x: qi.x - 10, y: qi.y - 10, w: qi.w + 330, h: qi.h + 20 },
        annotations: [
          { target: item("Capacity changes"), label: "From a date on", at: "e", d: 20 },
          { target: item("Time off"), label: "Holidays and absence", at: "e", d: 20 },
          { target: item("Name"), label: "Renaming keeps @owner ids", at: "e", d: 20 },
        ],
      });
      await t.type("Capacity changes");
      await sleep(300);
      await t.key("Enter");
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(file.replace("form-person", "form-list"), quickInput());
      await v.escape();
      await v.waitQuickInput();
      await v.escape();
    },
  ],
  [
    "form-project",
    async (t, v, file) => {
      await v.command("Planner: Edit project settings");
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(file, quickInput());
      await v.escape();
    },
  ],
  [
    "form-milestone",
    async (t, v, file) => {
      await v.openFile("M2-backend.md", 1);
      await v.command("Planner: Edit milestone");
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(file, quickInput());
      await v.escape();
    },
  ],
  [
    "delete-confirm",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.collapseAll();
      await v.expand(v.row("M2 – Backend"));
      await v.expand(v.row("Common"));
      await t.click(v.row("Shared API library"), { button: "right" });
      await t.waitFor(".context-view .monaco-menu");
      await t.click({ sel: ".context-view .action-label", text: "Delete task…" });
      await t.waitFor(".monaco-dialog-box", 5000);
      await sleep(400);
      await v.shot(file, { scale: CROP, clip: ".monaco-dialog-box", pad: 8 });
      await t.click({ sel: ".monaco-dialog-box .monaco-button", text: "Cancel" });
      await sleep(300);
    },
  ],
  [
    "delete-milestone",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.collapseAll();
      await t.click(v.row("M2 – Backend"), { button: "right" });
      await t.waitFor(".context-view .monaco-menu");
      await t.click({ sel: ".context-view .action-label", text: "Delete milestone…" });
      await t.waitFor(".monaco-dialog-box", 5000);
      await sleep(400);
      await v.shot(file, { scale: CROP, clip: ".monaco-dialog-box", pad: 8 });
      await t.click({ sel: ".monaco-dialog-box .monaco-button", text: "Cancel" });
      await sleep(300);
    },
  ],
  [
    "remove-person",
    async (t, v, file) => {
      await v.onlyPanes(["My Work / Team"]);
      await t.click(v.row("Jordan", "My Work / Team"), { button: "right" });
      await t.waitFor(".context-view .monaco-menu");
      await t.click({ sel: ".context-view .action-label", text: "Remove from team…" });
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(file, quickInput());
      await v.escape();
    },
  ],
  [
    "editor-team-lens",
    async (t, v, file) => {
      await v.openFile("team.md", 1);
      const ed = await t.rect(".part.editor");
      const lens = (text) => ({ sel: ".codelens-decoration a", text });
      await v.shot(file, {
        scale: CROP,
        clip: { x: ed.x, y: ed.y + 50, w: 820, h: 300 },
        annotations: [
          { target: lens("Add person"), label: "Add a person", at: "e", d: 30 },
          {
            target: { sel: ".codelens-decoration", index: 1 },
            label: "Edit · time off · overtime · working day",
            at: "e",
            d: 30,
          },
        ],
      });
      await v.openFile("M2-backend.md", 1);
    },
  ],
  [
    "kanban-context-menu",
    async (t, v, file) => {
      await v.command("Planner: Open Kanban");
      await t.waitFor({ sel: ".tab", text: "Kanban" }, 15000);
      await sleep(3000);
      const card = await v.webviewRect('.card[data-key="T102"]');
      await t.click({ rect: card }, { button: "right" });
      await t.waitFor(".context-view .monaco-menu");
      await sleep(500);
      const menu = await t.rect(".context-view .monaco-menu");
      const x = Math.min(card.x, menu.x) - 10;
      const y = Math.min(card.y, menu.y) - 10;
      await v.shot(file, {
        scale: CROP,
        clip: {
          x,
          y,
          w: Math.max(card.x + card.w, menu.x + menu.w) - x + 10,
          h: Math.max(card.y + card.h, menu.y + menu.h) - y + 10,
        },
      });
      await v.escape();
      await v.command("View: Close All Editors");
      await v.openFile("M2-backend.md", 1);
    },
  ],
  [
    "gantt-context-menu",
    async (t, v, file) => {
      await v.command("Planner: Open Gantt");
      await t.waitFor({ sel: ".tab", text: "Gantt" }, 15000);
      await sleep(3000);
      // The task list on the left: the task name stays visible next to the menu.
      const row = await v.webviewRect('.list-row[data-row="T005"]');
      await t.click({ rect: row }, { button: "right", at: { x: 0.45 } });
      await t.waitFor(".context-view .monaco-menu");
      await sleep(500);
      const menu = await t.rect(".context-view .monaco-menu");
      await v.shot(file, {
        scale: CROP,
        clip: {
          x: row.x,
          y: Math.min(row.y, menu.y) - 10,
          w: Math.max(row.x + row.w, menu.x + menu.w) - row.x + 10,
          h: Math.max(row.y + row.h, menu.y + menu.h) - Math.min(row.y, menu.y) + 20,
        },
      });
      await v.escape();
      await v.command("View: Close All Editors");
      await v.openFile("M2-backend.md", 1);
    },
  ],
  [
    "overtime",
    async (t, v, file) => {
      await v.command("Planner: Plan overtime");
      await v.waitQuickInput();
      await t.type("Sam");
      await sleep(300);
      await t.key("Enter");
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(file.replace("overtime", "overtime-period"), quickInput());
      await t.type("Next week");
      await sleep(300);
      await t.key("Enter");
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(file.replace("overtime", "overtime-hours"), quickInput());
      await v.escape();
      await v.command("Planner: Add a working day");
      await v.waitQuickInput();
      await t.type("Jordan");
      await sleep(300);
      await t.key("Enter");
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(file.replace("overtime", "workday-day"), quickInput());
      await t.key("Enter");
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(file.replace("overtime", "workday-hours"), quickInput());
      await v.escape();
    },
  ],
  // Writes to the sample copy: keep it last.
  [
    "tree-placeholder",
    async (t, v, file) => {
      await v.openFile("M2-backend.md", 1);
      await v.command("Planner: Add section");
      await v.waitQuickInput();
      await t.type("Reporting");
      await t.key("Enter");
      await sleep(1500);
      await v.onlyPanes(["Milestones"]);
      await v.expand(v.row("M2 – Backend"));
      await sleep(400);
      await v.expand(v.row("Reporting"));
      await sleep(400);
      const section = await t.rect(v.row("Reporting"));
      const sb = await t.rect(sidebar);
      await v.shot(file, {
        scale: CROP,
        clip: { x: sb.x, y: section.y - 60, w: sb.w + 200, h: 130 },
        annotations: [
          {
            target: v.row("Add a task…"),
            label: "Click to add the first task",
            at: "e",
            d: 20,
            box: false,
          },
        ],
      });
    },
  ],
];

const NEW_PROJECT_SHOTS = [
  [
    "start-welcome",
    async (t, v, file) => {
      await v.onlyPanes(["Milestones"]);
      await v.shot(file, {
        scale: CROP,
        clip: { x: 0, y: 0, w: 640, h: 460 },
        annotations: [
          {
            target: { sel: ".activitybar .action-label", aria: "Planner" },
            label: "Planner icon",
            at: "e",
            d: 14,
          },
          {
            target: { sel: ".part.sidebar .monaco-button", text: "New project" },
            label: "Start here",
            at: "e",
            d: 40,
          },
          {
            target: { sel: ".part.sidebar .monaco-button", text: "Configure MCP" },
            label: "Or let an AI agent build it",
            at: "e",
            d: 40,
          },
        ],
      });
      await v.onlyPanes([
        "Milestones",
        "My Work / Team",
        "Inbox",
        "Punch List",
        "Tests",
        "TODOs in Code",
      ]);
    },
  ],
  [
    "new-project",
    async (t, v, file) => {
      await t.click({ sel: ".part.sidebar .monaco-button", text: "New project" });
      await v.waitQuickInput();
      await t.type("Mobile App 2.0");
      await v.shot(file.replace("new-project", "new-project-name"), quickInput());
      await t.key("Enter");
      await v.waitQuickInput();
      await t.type("P-2026-021");
      await t.key("Enter");
      await v.waitQuickInput();
      await v.shot(file.replace("new-project", "new-project-start"), quickInput());
      await t.key("Enter");
      await v.waitQuickInput();
      await t.key("Enter");
      await v.waitQuickInput();
      await sleep(400);
      await v.shot(file.replace("new-project", "new-project-template"), quickInput());
      await t.key("Enter");
      await v.waitQuickInput();
      await t.key("a", "cmd");
      await t.type("Alex");
      await v.shot(file.replace("new-project", "new-project-lead"), quickInput());
      await t.key("Enter");
      await sleep(3000);
      await v.expand(v.row("M2 – Backend"));
      await sleep(600);
      await v.shot(file.replace("new-project", "new-project-done"), {
        scale: WIDE,
        annotations: [
          {
            target: v.row("M1 – Discovery"),
            label: "Five milestones from the template",
            at: "e",
            d: 340,
          },
          {
            target: { sel: ".tab", text: "project.md", closest: ".tab" },
            label: "project.md opens",
            at: "s",
            d: 150,
            dx: 260,
          },
          {
            target: '[id="status.problems"]',
            label: "Tasks still need estimates",
            at: "n",
            d: 14,
            dx: 60,
          },
          {
            target: {
              sel: ".notification-toast",
              text: ".mcp.json",
              closest: ".notification-toast",
            },
            label: "…and .mcp.json, for AI agents",
            at: "n",
            d: 30,
          },
        ],
      });
    },
  ],
  [
    "tutorial",
    async (t, v, file) => {
      const img = (name) => file.replace("tutorial", name);
      const item = (text) => ({ sel: ".quick-input-list .monaco-list-row", text });
      /** Chooses the quick pick entry that matches `text` (typed into the filter box). */
      const choose = async (text) => {
        await t.type(text);
        await sleep(300);
        await t.key("Enter");
        await v.waitQuickInput();
      };
      /** A date through "Other date…" (date pickers list suggestions first). */
      const otherDate = async (date) => {
        await choose("Other date");
        await t.type(date);
        await t.key("Enter");
        await v.waitQuickInput();
      };
      const formClip = async () => {
        const qi = await t.rect(v.quickInput);
        return { x: qi.x - 10, y: qi.y - 10, w: qi.w + 330, h: qi.h + 20 };
      };

      // Step 1 – project calendar: holidays.
      await v.command("Planner: Edit project settings");
      await v.waitQuickInput();
      await choose("Holidays");
      await choose("Add a holiday");
      await otherDate("2026-12-25");
      await otherDate("2026-12-26");
      await choose("Add a holiday");
      await otherDate("2027-01-01");
      await t.key("Enter"); // last day: only this day
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(img("tutorial-holidays"), quickInput());
      await t.key("Enter"); // Done
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(img("tutorial-project"), {
        scale: CROP,
        clip: await formClip(),
        annotations: [
          { target: item("Start"), label: "Nothing is scheduled before it", at: "e", d: 20 },
          { target: item("Work week"), label: "Working days", at: "e", d: 20 },
          { target: item("Hours per day"), label: "1d = this many hours", at: "e", d: 20 },
          { target: item("Holidays"), label: "● changed", at: "e", d: 20 },
        ],
      });
      await t.key("Enter"); // Save changes
      await sleep(1000);

      // Step 2 – a person.
      await v.onlyPanes(["Milestones", "My Work / Team"]);
      await t.click({
        sel: ".pane-header .action-label",
        aria: "Add person…",
        within: v.pane("My Work / Team"),
      });
      await v.waitQuickInput();
      await t.type("Sam");
      await t.key("Enter");
      await v.waitQuickInput();
      await choose("Role");
      await t.type("Backend developer");
      await t.key("Enter");
      await v.waitQuickInput();
      await choose("Capacity");
      await sleep(300);
      await v.shot(img("tutorial-capacity"), quickInput());
      await choose("32h/week");
      await choose("Time off");
      await choose("Add time off");
      await otherDate("2026-11-16");
      await otherDate("2026-11-20");
      await t.key("Enter"); // Done
      await v.waitQuickInput();
      await choose("Colour");
      await choose("green");
      await sleep(300);
      await v.shot(img("tutorial-person"), {
        scale: CROP,
        clip: await formClip(),
        annotations: [
          { target: item("Add person"), label: "Enter adds Sam to team.md", at: "e", d: 20 },
          { target: item("Id"), label: "Used in @owner:sam", at: "e", d: 20 },
          { target: item("Capacity changes"), label: "From a date on, optional", at: "e", d: 20 },
        ],
      });
      await t.key("Enter");
      await sleep(1200);

      // Step 3 – a milestone.
      await v.onlyPanes(["Milestones"]);
      await v.collapseAll();
      await t.click({
        sel: ".pane-header .action-label",
        aria: "Add milestone…",
        within: v.pane("Milestones"),
      });
      await v.waitQuickInput();
      await t.type("Documentation");
      await t.key("Enter");
      await v.waitQuickInput();
      await choose("Target");
      await otherDate("2027-04-09");
      await choose("Depends on");
      await t.click(item("M5"));
      await t.click({ sel: ".quick-input-widget .monaco-button", exact: "OK" });
      await v.waitQuickInput();
      await sleep(300);
      await v.shot(img("tutorial-milestone"), {
        scale: CROP,
        clip: await formClip(),
        annotations: [
          { target: item("Create milestone"), label: "Enter creates the file", at: "e", d: 20 },
          { target: item("Id"), label: "Next free id", at: "e", d: 20 },
          { target: item("Depends on"), label: "Starts after M5", at: "e", d: 20 },
        ],
      });
      await t.key("Enter");
      await sleep(1500);
      const m6 = await t.rect(v.row("M6 – Documentation"));
      const sb = await t.rect(sidebar);
      await v.shot(img("tutorial-milestone-new"), {
        scale: CROP,
        clip: { x: sb.x, y: m6.y - 140, w: sb.w + 200, h: 200 },
        annotations: [
          {
            target: v.row("Add a task…"),
            label: "Click to add the first task",
            at: "e",
            d: 20,
            box: false,
          },
        ],
      });

      // Step 6 – the first task, from the placeholder.
      await t.click(v.row("Add a task…"));
      await v.waitQuickInput();
      await t.type("User guide");
      await t.key("Enter");
      await v.waitQuickInput();
      await choose("Estimate");
      await t.type("3d");
      await t.key("Enter");
      await v.waitQuickInput();
      await choose("Owner");
      await sleep(300);
      await v.shot(img("tutorial-owner"), quickInput());
      await choose("Sam");
      await sleep(300);
      await v.shot(img("tutorial-task"), {
        scale: CROP,
        clip: await formClip(),
        annotations: [
          { target: item("Create task"), label: "Enter writes the task", at: "e", d: 20 },
          {
            target: item("Create and add another"),
            label: "Next task, same place",
            at: "e",
            d: 20,
          },
          { target: item("Depends on"), label: "Pick from all tasks", at: "e", d: 20 },
        ],
      });
      await t.key("Enter");
      await sleep(1500);
      await v.openFile("M6-documentation.md", 1);
      await sleep(1000);
      const ed = await t.rect(".part.editor");
      await v.shot(img("tutorial-result"), {
        scale: CROP,
        clip: { x: ed.x, y: ed.y + 30, w: 900, h: 300 },
      });
    },
  ],
];
