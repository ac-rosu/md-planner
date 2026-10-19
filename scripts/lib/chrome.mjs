// Headless Chrome/Edge driven over the DevTools protocol (localhost only), used by the webview
// performance and accessibility checks. Pages are written by `webviewPage()`: the built webview
// bundle plus a stand-in for the VS Code webview API that answers "ready" with recorded host
// messages and records everything the webview posts in `window.__posted`.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  const browser = [
    process.env.PLANNER_BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ]
    .filter(Boolean)
    .find((b) => existsSync(b));
  if (!browser) throw new Error("No Chrome/Edge found (set PLANNER_BROWSER).");
  return browser;
}

/**
 * HTML for one webview: theme variables, the view's CSS and JS from dist/webview, and the API
 * stand-in. The title becomes "rendered <ms> ms, <n> elements" two frames after the model message.
 */
export function webviewPage({ root, view, messages, themeCss, bodyClass }) {
  const dist = pathToFileURL(join(root, "dist", "webview")).href;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>pending</title>
<link rel="stylesheet" href="${pathToFileURL(themeCss).href}" />
<link rel="stylesheet" href="${dist}/${view}.css" />
<script>
window.__messages = ${JSON.stringify(messages)};
window.__posted = [];
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    window.__posted.push(m);
    if (m.type !== "ready") return;
    const t0 = performance.now();
    for (const msg of window.__messages) window.postMessage(msg, "*");
    setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      document.title = "rendered " + Math.round(performance.now() - t0) + " ms, " +
        document.querySelectorAll("*").length + " elements";
    })), 0);
  },
  getState() { return undefined; },
  setState() {},
});
</script>
</head>
<body class="${bodyClass}"><div id="root"></div><script src="${dist}/${view}.js"></script></body>
</html>`;
}

export async function launchChrome(browser = findBrowser()) {
  const userDir = mkdtempSync(join(tmpdir(), "md-planner-chrome-"));
  const chrome = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      // Linux CI runners (Ubuntu 26.04) block the user namespaces Chrome's sandbox needs; the
      // pages loaded here are this repository's own files.
      ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${userDir}`,
      "--allow-file-access-from-files",
      "--window-size=1500,860",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  let exited;
  chrome.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  chrome.on("exit", (code, signal) => (exited = signal ?? `exit code ${code}`));
  let port;
  // up to 30 s: a cold start on a CI runner is slow
  for (let i = 0; i < 300 && !port && !exited; i++) {
    try {
      port = readFileSync(join(userDir, "DevToolsActivePort"), "utf8").split("\n")[0];
    } catch {
      await sleep(100);
    }
  }
  if (!port) {
    chrome.kill();
    throw new Error(
      `Chrome did not start its DevTools endpoint (${exited ?? "no answer in 30 s"}).` +
        (stderr.trim() ? `\nChrome said:\n${stderr.trim()}` : "")
    );
  }
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
    (t) => t.type === "page"
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.error ? { error: m.error } : m.result);
      pending.delete(m.id);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");

  /** Evaluates an expression in the page (promises are awaited) and returns its value. */
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "error");
    return r.result?.value;
  };

  return {
    errors,
    send,
    evaluate,
    /** Opens a page and waits until the webview has rendered; returns the title. */
    async open(file) {
      errors.length = 0;
      await send("Page.navigate", { url: pathToFileURL(file).href });
      let title = "pending";
      for (let i = 0; i < 300 && !String(title).startsWith("rendered"); i++) {
        await sleep(50);
        title = (await evaluate("document.title")) ?? title;
      }
      return title;
    },
    /** Presses a key in the focused element (modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift). */
    async press(key, code = key, modifiers = 0, keyCode = 0) {
      const base = { key, code, modifiers, windowsVirtualKeyCode: keyCode };
      const text = key === "Enter" ? "\r" : key.length === 1 && !(modifiers & 7) ? key : undefined;
      await send("Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        ...base,
        ...(text ? { text } : {}),
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(30);
    },
    async close() {
      ws.close();
      chrome.kill();
      await sleep(200);
      rmSync(userDir, { recursive: true, force: true });
    },
  };
}
