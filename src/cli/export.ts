// `planner export`: the same exporters as `Planner: Export…`, for CI pipelines and scripts.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Baseline, latestBaseline, parseBaseline } from "../core/baseline";
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
import { fsReason, numberFlag, type ParsedArgs } from "./args";
import { type CliIo } from "./index";

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
  io: CliIo,
  unassignedCapacity = 40
): Promise<number> {
  const str = (k: string) => {
    const v = args.flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const fail = (message: string) => {
    io.err(`${message}\n`);
    return 2;
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
  const periodDays = numberFlag(args, "period", 7, {
    min: 1,
    integer: true,
    expected: "a whole number of days, 1 or more",
  });
  if (typeof periodDays !== "number") return fail(periodDays.error);
  const ganttWeeks = numberFlag(args, "weeks", 12, {
    min: 1,
    integer: true,
    expected: "a whole number of weeks, 1 or more",
  });
  if (typeof ganttWeeks !== "number") return fail(ganttWeeks.error);
  const delimiter = str("delimiter") ?? ",";
  if ([...delimiter].length !== 1 || /["\r\n]/.test(delimiter))
    return fail(`Invalid --delimiter ${delimiter} (expected one character, e.g. , or ;).`);
  const accent = str("accent");
  if (accent !== undefined && !/^#[0-9a-f]{3,8}$/i.test(accent))
    return fail(`Invalid --accent ${accent} (expected a colour like #0f766e).`);
  const out = resolve(str("out") ?? join(planDir, "reports"));
  const outStat = statOf(out);
  if (outStat && !outStat.isDirectory())
    return fail(`Not a folder: ${out} (--out expects the output folder).`);

  const logo = str("logo");
  let logoUri: string | undefined;
  if (logo) {
    if (!statOf(logo)) return fail(`Logo file not found: ${logo}`);
    try {
      logoUri = logoDataUri(readFileSync(logo), logo);
    } catch (err) {
      return fail(`Cannot read the logo ${logo}: ${fsReason(err)}.`);
    }
    if (!logoUri) return fail(`Unsupported logo ${logo} (PNG, JPEG, GIF, SVG or WebP).`);
  }

  // Invalid baseline files are skipped with a warning, as in the extension and the MCP server.
  const { baselines, invalid } = readBaselines(join(planDir, "baselines"));
  for (const reason of invalid.values())
    io.err(`warning: ${reason.replace(/\.$/, "")}; skipped.\n`);
  const wanted = str("baseline");
  const baseline = wanted ? baselines.find((b) => b.id === wanted) : latestBaseline(baselines);
  if (wanted && !baseline) {
    const reason = invalid.get(wanted);
    return fail(
      reason
        ? `Cannot use baseline ${wanted}: ${reason}`
        : `Unknown baseline ${wanted} (${baselines.map((b) => b.id).join(", ") || "none saved"}).`
    );
  }

  const schedule = schedulePlan(plan, { today, unassignedCapacity });
  const demand = schedulePlan(plan, { today, unassignedCapacity, mode: "demand" });
  const result = await runExport(plan, schedule, demand, {
    formats,
    sections,
    summary: str("summary"),
    periodDays,
    ganttWeeks,
    author: str("author"),
    branding:
      str("company") || accent || logoUri
        ? { company: str("company"), accentColor: accent, logoDataUri: logoUri }
        : undefined,
    baseline,
    testPlan: str("test"),
    csvDelimiter: delimiter,
    browserPath: str("browser"),
  });
  try {
    mkdirSync(out, { recursive: true });
  } catch (err) {
    return fail(`Cannot create the output folder ${out}: ${fsReason(err)}.`);
  }
  for (const f of result.files) {
    // A file name never leaves the output folder, whatever a test plan id contains.
    const path = join(out, f.name.replace(/[\\/]/g, "-"));
    try {
      writeFileSync(path, f.data);
    } catch (err) {
      return fail(`Cannot write ${path}: ${fsReason(err)}.`);
    }
    io.out(`${path}\n`);
  }
  for (const w of result.warnings) io.err(`warning: ${w}\n`);
  const missing = formats.filter((f) => !result.files.some((x) => x.format === f));
  return missing.length ? 1 : 0;
}

function statOf(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** The baselines in `dir` by id (file name without .json), and why the others were skipped. */
function readBaselines(dir: string): {
  baselines: Array<Baseline & { id: string }>;
  invalid: Map<string, string>;
} {
  const baselines: Array<Baseline & { id: string }> = [];
  const invalid = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    // No baselines folder (or not one that can be read): no baselines.
  }
  for (const name of names) {
    const id = name.slice(0, -5);
    const file = `baselines/${name}`;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch (err) {
      invalid.set(id, `${file} cannot be read (${fsReason(err)}).`);
      continue;
    }
    try {
      baselines.push({ id, ...parseBaseline(text, file) });
    } catch (err) {
      invalid.set(id, err instanceof Error ? err.message : String(err));
    }
  }
  return { baselines, invalid };
}
