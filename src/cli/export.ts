// `planner export`: the same exporters as `Planner: Export…`, for CI pipelines and scripts.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { latestBaseline, parseBaseline } from "../core/baseline";
import { type Plan } from "../core/resolve";
import { schedulePlan } from "../core/scheduler";
import {
  EXPORT_FORMATS,
  type ExportFormat,
  exportFormatOf,
  logoDataUri,
  REPORT_SECTIONS,
  type ReportSection,
  runExport,
} from "../export/index";
import { type CliIo, type ParsedArgs } from "./index";

export const EXPORT_HELP = `Usage: planner export --format <formats> [options]

Formats (comma-separated): ${EXPORT_FORMATS.map((f) => f.id).join(", ")}

Options:
  --plan <dir>             plan folder (default: ./plan)
  --out <dir>              output folder (default: <plan>/reports)
  --today <YYYY-MM-DD>     schedule and report as of this date (default: today)
  --sections <list>        status report sections (default: all): ${REPORT_SECTIONS.map((s) => s.id).join(", ")}
  --summary <text>         status summary for the report
  --period <days>          reporting period in days (default 7)
  --weeks <n>              weeks in the report's Gantt and team load (default 12)
  --test <id>              test plan for test-report / test-report-pdf (default: the first)
  --baseline <id>          baseline (file name without .json) for trends (default: latest)
  --author, --company, --accent <#rrggbb>, --logo <file>   report header and branding
  --browser <path>         Edge/Chrome for PDF (default: detect)
  --delimiter <char>       CSV delimiter (default ,)
`;

export async function runExportCommand(
  plan: Plan,
  planDir: string,
  args: ParsedArgs,
  today: string,
  io: CliIo
): Promise<number> {
  const str = (k: string) => {
    const v = args.flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const ids = (str("format") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const formats = ids.map(exportFormatOf).filter((f): f is ExportFormat => f !== undefined);
  if (formats.length === 0 || formats.length !== ids.length) {
    io.err(`Unknown or missing --format.\n\n${EXPORT_HELP}`);
    return 2;
  }
  const sectionIds = new Set(REPORT_SECTIONS.map((s) => s.id));
  const sections = str("sections")
    ?.split(",")
    .map((s) => s.trim()) as ReportSection[] | undefined;
  if (sections?.some((s) => !sectionIds.has(s))) {
    io.err(`Unknown section in --sections (${REPORT_SECTIONS.map((s) => s.id).join(", ")}).\n`);
    return 2;
  }
  const unassignedCapacity = Number(str("unassigned-capacity") ?? 40);
  const schedule = schedulePlan(plan, { today, unassignedCapacity });
  const demand = schedulePlan(plan, { today, unassignedCapacity, mode: "demand" });

  const baselineDir = join(planDir, "baselines");
  const baselineIds = existsSync(baselineDir)
    ? readdirSync(baselineDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
    : [];
  const baselines = baselineIds.map((id) => ({
    id,
    ...parseBaseline(readFileSync(join(baselineDir, `${id}.json`), "utf8"), id),
  }));
  const wanted = str("baseline");
  const baseline = wanted ? baselines.find((b) => b.id === wanted) : latestBaseline(baselines);
  if (wanted && !baseline) {
    io.err(`Unknown baseline ${wanted} (${baselineIds.join(", ") || "none saved"}).\n`);
    return 2;
  }
  const logo = str("logo");
  let logoUri: string | undefined;
  if (logo) {
    if (!existsSync(logo)) {
      io.err(`Logo file not found: ${logo}\n`);
      return 2;
    }
    logoUri = logoDataUri(readFileSync(logo), logo);
  }
  const result = await runExport(plan, schedule, demand, {
    formats,
    sections,
    summary: str("summary"),
    periodDays: Number(str("period") ?? 7),
    ganttWeeks: Number(str("weeks") ?? 12),
    author: str("author"),
    branding:
      str("company") || str("accent") || logoUri
        ? { company: str("company"), accentColor: str("accent"), logoDataUri: logoUri }
        : undefined,
    baseline,
    testPlan: str("test"),
    csvDelimiter: str("delimiter") ?? ",",
    browserPath: str("browser"),
  });
  const out = resolve(str("out") ?? join(planDir, "reports"));
  mkdirSync(out, { recursive: true });
  for (const f of result.files) {
    const path = join(out, f.name);
    writeFileSync(path, f.data);
    io.out(`${path}\n`);
  }
  for (const w of result.warnings) io.err(`warning: ${w}\n`);
  const missing = formats.filter((f) => !result.files.some((x) => x.format === f));
  return missing.length ? 1 : 0;
}
