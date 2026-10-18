// PDF export: prints an HTML file with headless Edge or Chrome (`--print-to-pdf`). The browser is
// auto-detected; `planner.export.browserPath` (or --browser in the CLI) overrides it.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

export function browserCandidates(platform = process.platform, env = process.env): string[] {
  const out: string[] = [];
  if (platform === "darwin") {
    out.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (platform === "win32") {
    const roots = [env["PROGRAMFILES(X86)"], env.PROGRAMFILES, env.LOCALAPPDATA].filter(
      (r): r is string => !!r
    );
    for (const r of roots) {
      out.push(
        win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
        win32.join(r, "Google", "Chrome", "Application", "chrome.exe")
      );
    }
  } else {
    for (const dir of (env.PATH ?? "").split(posix.delimiter)) {
      for (const name of [
        "microsoft-edge",
        "microsoft-edge-stable",
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
      ]) {
        out.push(posix.join(dir, name));
      }
    }
  }
  return out;
}

/** The browser to print with: the configured path when it exists, else the first one found. */
export function findBrowser(configured?: string): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  return browserCandidates().find((p) => existsSync(p));
}

/** Prints `htmlPath` to `pdfPath`. Rejects with a readable message when the browser fails. */
export function printToPdf(
  browser: string,
  htmlPath: string,
  pdfPath: string,
  timeoutMs = 60_000
): Promise<void> {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--no-pdf-header-footer",
    "--run-all-compositor-stages-before-draw",
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: timeoutMs, windowsHide: true }, (err) => {
      if (err && !existsSync(pdfPath))
        reject(new Error(`PDF printing with ${browser} failed: ${err.message}`));
      else if (!existsSync(pdfPath))
        reject(new Error(`PDF printing with ${browser} produced no file.`));
      else resolve();
    });
  });
}
