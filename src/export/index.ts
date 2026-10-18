// Export orchestration shared by the extension (`Planner: Export…`) and the CLI (`planner export`):
// produces the files in memory; the caller writes them to plan/reports/.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Baseline } from "../core/baseline";
import { formatDate } from "../core/dates";
import { type Plan } from "../core/resolve";
import { type Schedule } from "../core/scheduler";
import { exportCsv } from "./csv";
import { renderTestReport } from "./testReport";
import {
  type Branding,
  REPORT_SECTIONS,
  renderStatusReport,
  type ReportSection,
} from "./html/report";
import { exportMspdi } from "./mspdi";
import { findBrowser, printToPdf } from "./pdf";
import { exportXlsx } from "./xlsx";

export type ExportFormat =
  "html" | "pdf" | "xlsx" | "mspdi" | "csv" | "test-report" | "test-report-pdf";

export const EXPORT_FORMATS: Array<{ id: ExportFormat; label: string; detail: string }> = [
  {
    id: "html",
    label: "HTML status report",
    detail: "one self-contained file, print-ready – for managers and team leads",
  },
  {
    id: "pdf",
    label: "PDF status report",
    detail: "the HTML report printed with headless Edge or Chrome",
  },
  {
    id: "xlsx",
    label: "Excel workbook",
    detail: "Tasks, Schedule, Team load per week, Milestones, Tests, Punch list",
  },
  {
    id: "mspdi",
    label: "MS Project XML",
    detail: "tasks, durations, dependencies, resources, assignments, calendar",
  },
  { id: "csv", label: "CSV", detail: "flat task table for other tools" },
  {
    id: "test-report",
    label: "Test report (HTML)",
    detail: "test plan with results, punch items and signature block",
  },
  {
    id: "test-report-pdf",
    label: "Test report (PDF)",
    detail: "the test report printed to PDF",
  },
];

/** Earlier names of formats, still accepted (CLI, MCP, the last choice remembered by VS Code). */
const FORMAT_ALIASES: Record<string, ExportFormat> = {
  fat: "test-report",
  "fat-pdf": "test-report-pdf",
};

/** The export format of an id or alias, else undefined. */
export function exportFormatOf(id: string): ExportFormat | undefined {
  const f = FORMAT_ALIASES[id] ?? id;
  return EXPORT_FORMATS.some((x) => x.id === f) ? (f as ExportFormat) : undefined;
}

export { REPORT_SECTIONS, type ReportSection };

export interface ExportRequest {
  formats: ExportFormat[];
  sections?: ReportSection[];
  summary?: string;
  periodDays: number;
  ganttWeeks: number;
  author?: string;
  branding?: Branding;
  baseline?: Baseline;
  /** Test plan id for the test report. */
  testPlan?: string;
  tester?: string;
  witness?: string;
  csvDelimiter?: string;
  browserPath?: string;
  /** Base name of the status report files (default `status-report`). */
  name?: string;
}

export interface ExportFile {
  format: ExportFormat;
  name: string;
  data: string | Uint8Array;
}

export interface ExportResult {
  files: ExportFile[];
  warnings: string[];
}

export function exportFileName(
  format: ExportFormat,
  today: string,
  name = "status-report",
  testPlan?: string
): string {
  switch (format) {
    case "html":
      return `${today}-${name}.html`;
    case "pdf":
      return `${today}-${name}.pdf`;
    case "xlsx":
      return `${today}-plan.xlsx`;
    case "mspdi":
      return `${today}-plan.xml`;
    case "csv":
      return `${today}-tasks.csv`;
    case "test-report":
      return `${today}-${testPlan ?? "test"}-report.html`;
    case "test-report-pdf":
      return `${today}-${testPlan ?? "test"}-report.pdf`;
  }
}

export async function runExport(
  plan: Plan,
  schedule: Schedule,
  demand: Schedule | undefined,
  r: ExportRequest
): Promise<ExportResult> {
  const today = formatDate(schedule.today);
  const files: ExportFile[] = [];
  const warnings: string[] = [];
  const want = new Set(r.formats);
  let statusHtml: string | undefined;
  const html = () =>
    (statusHtml ??= renderStatusReport(plan, schedule, {
      sections: r.sections ?? REPORT_SECTIONS.map((s) => s.id),
      summary: r.summary,
      periodDays: r.periodDays,
      ganttWeeks: r.ganttWeeks,
      author: r.author,
      branding: r.branding,
      baseline: r.baseline,
      demand,
    }));

  if (want.has("html"))
    files.push({ format: "html", name: exportFileName("html", today, r.name), data: html() });
  if (want.has("pdf")) {
    const pdf = await toPdf(html(), r.browserPath, warnings);
    if (pdf) files.push({ format: "pdf", name: exportFileName("pdf", today, r.name), data: pdf });
    else if (!want.has("html"))
      files.push({ format: "html", name: exportFileName("html", today, r.name), data: html() });
  }
  if (want.has("xlsx"))
    files.push({
      format: "xlsx",
      name: exportFileName("xlsx", today),
      data: await exportXlsx(plan, schedule, r.author),
    });
  if (want.has("mspdi"))
    files.push({
      format: "mspdi",
      name: exportFileName("mspdi", today),
      data: exportMspdi(plan, schedule, { author: r.author, company: r.branding?.company }),
    });
  if (want.has("csv"))
    files.push({
      format: "csv",
      name: exportFileName("csv", today),
      data: exportCsv(plan, schedule, r.csvDelimiter ?? ","),
    });
  if (want.has("test-report") || want.has("test-report-pdf")) {
    const tp = plan.testById(r.testPlan) ?? (r.testPlan ? undefined : plan.tests[0]);
    if (!tp) {
      warnings.push(
        r.testPlan ? `Unknown test plan ${r.testPlan}.` : "There are no test plans to report."
      );
    } else {
      const reportHtml = renderTestReport(plan, tp, {
        today,
        tester: r.tester,
        witness: r.witness,
        branding: r.branding,
      });
      if (want.has("test-report"))
        files.push({
          format: "test-report",
          name: exportFileName("test-report", today, undefined, tp.id),
          data: reportHtml,
        });
      if (want.has("test-report-pdf")) {
        const pdf = await toPdf(reportHtml, r.browserPath, warnings);
        if (pdf)
          files.push({
            format: "test-report-pdf",
            name: exportFileName("test-report-pdf", today, undefined, tp.id),
            data: pdf,
          });
        else if (!want.has("test-report"))
          files.push({
            format: "test-report",
            name: exportFileName("test-report", today, undefined, tp.id),
            data: reportHtml,
          });
      }
    }
  }
  return { files, warnings };
}

/** Prints HTML to PDF in a temporary folder; returns undefined (with a warning) when impossible. */
async function toPdf(
  htmlText: string,
  browserPath: string | undefined,
  warnings: string[]
): Promise<Uint8Array | undefined> {
  const browser = findBrowser(browserPath || undefined);
  if (!browser) {
    warnings.push(
      browserPath
        ? `The browser ${browserPath} (planner.export.browserPath) was not found; the HTML report was written instead.`
        : "No Microsoft Edge or Google Chrome was found for PDF printing; the HTML report was written instead. Set planner.export.browserPath."
    );
    return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "planner-pdf-"));
  try {
    const htmlPath = join(dir, "report.html");
    const pdfPath = join(dir, "report.pdf");
    writeFileSync(htmlPath, htmlText, "utf8");
    await printToPdf(browser, htmlPath, pdfPath);
    return new Uint8Array(readFileSync(pdfPath));
  } catch (err) {
    warnings.push(
      `${err instanceof Error ? err.message : String(err)} The HTML report was written instead.`
    );
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `data:` URI for a logo file (PNG, JPEG, GIF, SVG, WebP). */
export function logoDataUri(bytes: Uint8Array, fileName: string): string | undefined {
  const ext = fileName.toLowerCase().split(".").pop();
  const mime: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
  };
  const type = ext ? mime[ext] : undefined;
  if (!type) return undefined;
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}
