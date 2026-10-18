// Command-line interface for CI and scripts, on the same core as the extension:
//   planner validate [--plan plan] [--today YYYY-MM-DD] [--json] [--strict]
//   planner schedule [--plan plan] [--today YYYY-MM-DD] [--json] [--mode capacity|demand]
//   planner export   --format html,pdf,xlsx,mspdi,csv,test-report,test-report-pdf [...]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isValidDate, localToday } from "../core/dates";
import { loadPlanIndex } from "../core/fsLoader";
import { type Issue } from "../core/model";
import { scheduleDiagnostics } from "../core/scheduleDiagnostics";
import { scheduleToJson } from "../core/scheduleJson";
import { schedulePlan } from "../core/scheduler";
import { validatePlan } from "../core/validate";
import { EXPORT_HELP, runExportCommand } from "./export";

declare const PLANNER_VERSION: string | undefined;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const HELP = `Markdown Project Planner CLI

Usage: planner <command> [options]

Commands:
  validate   check the plan files; exit code 1 on errors (or warnings with --strict)
  schedule   compute the schedule (dates, slack, critical path, milestone forecasts)
  export     write reports and data exports (see: planner help export)

Options:
  --plan <dir>          plan folder (default: ./plan)
  --today <YYYY-MM-DD>  schedule as of this date (default: today)
  --json                machine-readable output
  --strict              validate: also fail on warnings
  --mode <mode>         schedule: capacity (default) or demand
  --unassigned-capacity <h>  hours per week of the unassigned pool (default 40)
`;

export interface ParsedArgs {
  command?: string;
  flags: Map<string, string | true>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--"))
        flags.set(a.slice(2), argv[++i]);
      else flags.set(a.slice(2), true);
    } else {
      positional.push(a);
    }
  }
  return { command: positional.shift(), flags, positional };
}

export async function main(
  argv: string[],
  io: CliIo = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }
): Promise<number> {
  const args = parseArgs(argv);
  const str = (k: string) => {
    const v = args.flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  if (args.flags.has("version")) {
    io.out(`${typeof PLANNER_VERSION === "string" ? PLANNER_VERSION : "dev"}\n`);
    return 0;
  }
  if (!args.command || args.command === "help" || args.flags.has("help")) {
    io.out(args.command === "export" || args.positional[0] === "export" ? EXPORT_HELP : HELP);
    return 0;
  }
  const planDir = resolve(str("plan") ?? "plan");
  if (!existsSync(planDir)) {
    io.err(`Plan folder not found: ${planDir}\n`);
    return 2;
  }
  const today = str("today") ?? localToday();
  if (!isValidDate(today)) {
    io.err(`Invalid --today ${today} (expected YYYY-MM-DD)\n`);
    return 2;
  }
  const index = loadPlanIndex(planDir);
  const plan = index.plan;
  const unassignedCapacity = Number(str("unassigned-capacity") ?? 40);

  switch (args.command) {
    case "validate": {
      const schedule = schedulePlan(plan, { today, unassignedCapacity });
      const issues = [
        ...validatePlan(plan, { graph: schedule.graph }),
        ...scheduleDiagnostics(plan, schedule),
      ];
      const errors = issues.filter((i) => i.severity === "error").length;
      const warnings = issues.filter((i) => i.severity === "warning").length;
      if (args.flags.has("json")) {
        io.out(JSON.stringify({ errors, warnings, issues }, null, 2) + "\n");
      } else {
        for (const i of issues) io.out(formatIssue(planDir, i) + "\n");
        io.out(
          `${plan.files.length} files, ${plan.tasks.length} tasks: ${errors} error(s), ${warnings} warning(s), ${issues.length - errors - warnings} info\n`
        );
      }
      return errors > 0 || (args.flags.has("strict") && warnings > 0) ? 1 : 0;
    }
    case "schedule": {
      const mode = str("mode") === "demand" ? "demand" : "capacity";
      const schedule = schedulePlan(plan, { today, unassignedCapacity, mode });
      const json = scheduleToJson(plan, schedule);
      if (args.flags.has("json")) {
        io.out(JSON.stringify(json, null, 2) + "\n");
        return 0;
      }
      io.out(`${plan.project.name} – schedule as of ${today} (${mode})\n\n`);
      io.out(
        table(
          ["Milestone", "Target", "Forecast", "Variance", "Progress"],
          json.milestones.map((m) => [
            `${m.id} ${m.title.replace(/^M\d+\s*[–-]\s*/, "")}`,
            m.target ?? "",
            m.forecast ?? "",
            m.variance === undefined
              ? ""
              : m.variance > 0
                ? `+${m.variance} d (late)`
                : `${m.variance} d`,
            `${Math.round(m.progress * 100)}%`,
          ])
        )
      );
      io.out("\n");
      io.out(
        table(
          ["Task", "Owner", "Start", "Finish", "Slack", "Notes"],
          json.tasks
            .filter((t) => t.status !== "done")
            .map((t) => [
              `${t.id} ${t.title}`.slice(0, 48),
              t.owner,
              t.start ?? "",
              t.finish ?? "",
              t.slack === undefined ? "" : String(t.slack),
              [
                t.critical ? "critical" : "",
                t.late ? "late" : "",
                t.unscheduled ?? "",
                ...(t.flags ?? []),
              ]
                .filter(Boolean)
                .join(", "),
            ])
        )
      );
      io.out(`\nCritical path: ${json.criticalPath.join(" → ") || "—"}\n`);
      return 0;
    }
    case "export":
      return runExportCommand(plan, planDir, args, today, io);
    default:
      io.err(`Unknown command "${args.command}".\n\n${HELP}`);
      return 2;
  }
}

function formatIssue(planDir: string, i: Issue): string {
  return `${planDir}/${i.file}:${i.range.start.line + 1}:${i.range.start.character + 1}: ${i.severity} ${i.code}: ${i.message}`;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((v, c) => v.padEnd(widths[c]))
      .join("  ")
      .trimEnd();
  return (
    [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n") + "\n"
  );
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    }
  );
}
