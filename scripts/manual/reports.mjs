// Report screenshots for the user manual: the HTML status report and the test report of the sample
// project, written by the CLI (the same exporters as `Planner: Export…`) and rendered in Chrome.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launchChrome } from "../lib/chrome.mjs";
import { pageTools, sleep } from "./lib.mjs";

const SUMMARY =
  "Discovery & design (M1) is 62% complete and forecast for 20 October, 8 working days before its " +
  "target; only the internal review and the stakeholder sign-off are left. The backend (M2) has " +
  "started and is forecast 15 working days ahead of its target. The launch (M5) is forecast 3 " +
  "working days after its 26 March target because the rollout chain is on the critical path; we " +
  "are looking at overlapping the load tests with the production setup. The payment form is " +
  "blocked until the payment provider sends the production API keys. The internal dry run of the " +
  "checkout acceptance test found one failure (confirmation time), tracked as punch item P007.";

export async function captureReports({ root, out, work, today, only }) {
  const want = (name) => !only || only.some((o) => name.startsWith(o));
  if (!["report-", "test-report"].some(want)) return;
  const sample = join(root, "examples", "customer-portal");
  const reports = join(work, "reports");
  mkdirSync(reports, { recursive: true });
  execFileSync(
    process.execPath,
    [
      join(root, "dist", "cli.js"),
      "export",
      "--plan",
      join(sample, "plan"),
      "--format",
      "html,test-report",
      "--today",
      today,
      "--out",
      reports,
      "--summary",
      SUMMARY,
      "--author",
      "Alex",
      "--company",
      "Example Corp",
      "--accent",
      "#0f766e",
      "--logo",
      join(sample, "docs", "logo.svg"),
    ],
    { stdio: "inherit" }
  );
  const files = readdirSync(reports);
  const html = files.find((f) => f.startsWith(today) && f.includes("status-report"));
  const testReport = files.find(
    (f) => f.startsWith(today) && f.endsWith("-report.html") && !f.includes("status-report")
  );

  const chrome = await launchChrome();
  const t = pageTools(chrome);
  const show = async (file, width, height) => {
    await chrome.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await chrome.send("Page.navigate", { url: `file://${join(reports, file)}` });
    await sleep(1200);
  };
  try {
    if (want("report-top")) {
      await show(html, 1000, 1300);
      await t.shot(join(out, "report-top.png"), {
        scale: 0.6,
        clip: { x: 0, y: 0, w: 1000, h: 1300 },
      });
    }
    if (want("report-sections")) {
      await show(html, 1000, 4200);
      const g = await t.rect({ sel: "h2", text: "Team load" });
      await t.shot(join(out, "report-sections.png"), {
        scale: 0.6,
        clip: { x: 0, y: g.y - 20, w: 1000, h: 1200 },
      });
    }
    if (want("test-report")) {
      await show(testReport, 1000, 1400);
      await t.shot(join(out, "test-report.png"), {
        scale: 0.6,
        clip: { x: 0, y: 0, w: 1000, h: 1400 },
      });
    }
  } finally {
    await chrome.close();
  }
}
