// Report tools: baselines (save, list, compare), the dashboard and Kanban data, exports (status
// report, Excel, MS Project, CSV, test report) and estimate calibration.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { calibrationRows } from "../ai/commands";
import {
  type Baseline,
  baselineFileName,
  baselineLookup,
  baselineText,
  createBaseline,
  latestBaseline,
  milestoneTrends,
  parseBaseline,
} from "../core/baseline";
import { formatDate } from "../core/dates";
import { type TaskFilter } from "../core/filter";
import { type Status } from "../core/model";
import { buildDashboardModel } from "../core/views/dashboard";
import { buildGanttModel } from "../core/views/gantt";
import { buildKanbanModel } from "../core/views/kanban";
import { setAttr } from "../core/writer";
import {
  EXPORT_FORMATS,
  type ExportFormat,
  exportFormatOf,
  logoDataUri,
  runExport,
} from "../export/index";
import { REPORT_SECTIONS, type ReportSection } from "../export/html/report";
import { insideFolder, workspacePath } from "./paths";
import { workspaceSettings } from "./settings";
import { personOf } from "./taskSpecs";
import { type PlannerTools, ToolError } from "./tools";

function readBaselines(planDir: string): Array<{ id: string; baseline: Baseline }> {
  const dir = join(planDir, "baselines");
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; baseline: Baseline }> = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    try {
      out.push({
        id: name.replace(/\.json$/, ""),
        baseline: parseBaseline(readFileSync(join(dir, name), "utf8"), name),
      });
    } catch {
      // Invalid baseline files are skipped, as in the extension.
    }
  }
  return out;
}

function baselineById(
  tools: PlannerTools,
  id?: string
): { id: string; baseline: Baseline } | undefined {
  const all = readBaselines(tools.planDir);
  if (!id) {
    const latest = latestBaseline(all.map((b) => b.baseline));
    return all.find((b) => b.baseline === latest);
  }
  const found = all.find((b) => b.id === id || b.baseline.name.toLowerCase() === id.toLowerCase());
  if (!found)
    throw new ToolError(`Unknown baseline "${id}" (${all.map((b) => b.id).join(", ") || "none"}).`);
  return found;
}

export function saveBaseline(tools: PlannerTools, args: { name: string; overwrite?: boolean }) {
  if (!args.name?.trim()) throw new ToolError("The baseline needs a name.");
  const st = tools.stage();
  const b = createBaseline(st.plan, tools.scheduleOf(st.plan), args.name.trim());
  const path = `baselines/${baselineFileName(b)}`;
  if (st.exists(path) && !args.overwrite)
    throw new ToolError(`${path} already exists; set overwrite: true to replace it.`);
  st.create(path, baselineText(b), { overwrite: args.overwrite });
  tools.commit(st);
  return {
    id: path.slice("baselines/".length).replace(/\.json$/, ""),
    file: path,
    tasks: Object.keys(b.tasks).length,
    milestones: Object.keys(b.milestones).length,
  };
}

export function listBaselines(tools: PlannerTools) {
  tools.load();
  return readBaselines(tools.planDir).map(({ id, baseline }) => ({
    id,
    name: baseline.name,
    date: baseline.date,
    tasks: Object.keys(baseline.tasks).length,
    milestones: Object.keys(baseline.milestones).length,
  }));
}

/** Milestone slip and the tasks that moved most since a baseline (default: the latest). */
export function compareBaseline(tools: PlannerTools, args: { id?: string; limit?: number }) {
  const plan = tools.load();
  const found = baselineById(tools, args.id);
  if (!found) throw new ToolError("There is no baseline yet; save one with save_baseline.");
  const trends = milestoneTrends(plan, tools.schedule, found.baseline);
  const fmt = (d: number | undefined) => (d === undefined ? undefined : formatDate(d));
  const gantt = buildGanttModel(plan, tools.schedule, {
    grouping: "milestone",
    baseline: baselineLookup(found.baseline),
  });
  const tasks = gantt.rows
    .filter((r) => r.kind === "task" && r.slip !== undefined && r.slip !== 0)
    .sort((a, b) => Math.abs(b.slip!) - Math.abs(a.slip!))
    .slice(0, args.limit ?? 50)
    .map((r) => ({
      id: r.id ?? r.key,
      title: r.title,
      slip: r.slip,
      baselineFinish: fmt(r.baselineFinish),
      finish: fmt(r.finish),
    }));
  return {
    baseline: found.id,
    name: found.baseline.name,
    date: found.baseline.date,
    milestones: plan.milestones.map((m) => {
      const t = trends.get(m.id);
      const ms = tools.schedule.milestones.get(m.id);
      return {
        id: m.id,
        title: m.title,
        baselineForecast: t?.baselineForecast,
        forecast: fmt(ms?.forecast),
        slip: t?.slip,
      };
    }),
    tasks,
  };
}

export function getDashboard(tools: PlannerTools, args: { baseline?: string }) {
  const plan = tools.load();
  const b = baselineById(tools, args.baseline);
  const d = buildDashboardModel(plan, tools.schedule, b?.baseline);
  return { ...d, burnUp: { project: d.burnUp.project }, baseline: b?.id };
}

export function getKanban(
  tools: PlannerTools,
  args: {
    board?: "tasks" | "punch";
    swimlane?: "none" | "owner" | "milestone" | "severity";
    owner?: string;
    milestone?: string;
    tag?: string;
    text?: string;
    showCancelled?: boolean;
    cardMode?: "tasks" | "leaves";
  }
) {
  const plan = tools.load();
  const settings = workspaceSettings(tools.workspaceDir);
  const filter: TaskFilter = {
    owner: args.owner ? [personOf(plan, args.owner) ?? args.owner] : undefined,
    milestone: args.milestone ? [args.milestone] : undefined,
    tag: args.tag ? [args.tag] : undefined,
    text: args.text,
  };
  const model = buildKanbanModel(plan, tools.schedule, {
    board: args.board ?? "tasks",
    swimlane: args.swimlane ?? "none",
    filter,
    showCancelled: args.showCancelled ?? false,
    cardMode: args.cardMode ?? "tasks",
    wipLimits: (settings["kanban.wipLimits"] as Partial<Record<Status, number>>) ?? {},
  });
  return {
    columns: model.columns,
    lanes: model.lanes.map((l) => ({
      lane: l.title,
      cards: Object.fromEntries(
        Object.entries(l.cards).map(([status, cards]) => [
          status,
          (cards ?? []).map((c) => ({
            id: c.id ?? c.key,
            title: c.title,
            owner: c.owner,
            hours: c.hours || undefined,
            due: c.due,
            late: c.late || undefined,
            prio: c.prio === "med" ? undefined : c.prio,
            sev: c.sev,
            overtime: c.overtime,
          })),
        ])
      ),
    })),
  };
}

export interface ExportArgs {
  /** Format ids; the earlier names fat and fat-pdf are accepted for the test report. */
  formats: string[];
  sections?: ReportSection[];
  summary?: string;
  /** Test plan id for the test report. */
  testPlan?: string;
  tester?: string;
  witness?: string;
  author?: string;
  /** Baseline id or name (default: the latest). */
  baseline?: string;
  periodDays?: number;
  ganttWeeks?: number;
  csvDelimiter?: string;
  /** Edge or Chrome for PDF (default: detected). */
  browserPath?: string;
  /** Output folder (default: <plan>/reports). */
  outDir?: string;
  /** Base name of the status report files. */
  name?: string;
}

export async function exportReport(tools: PlannerTools, args: ExportArgs) {
  const plan = tools.load();
  const formats: ExportFormat[] = [];
  for (const id of args.formats?.length ? args.formats : ["html"]) {
    const f = exportFormatOf(id);
    if (!f)
      throw new ToolError(
        `Unknown format "${id}" (${EXPORT_FORMATS.map((x) => x.id).join(", ")}).`
      );
    formats.push(f);
  }
  for (const s of args.sections ?? [])
    if (!REPORT_SECTIONS.some((x) => x.id === s))
      throw new ToolError(
        `Unknown section "${s}" (${REPORT_SECTIONS.map((x) => x.id).join(", ")}).`
      );
  const settings = workspaceSettings(tools.workspaceDir);
  const workspace = tools.workspaceDir;
  const brandingSetting = (settings["export.branding"] ?? {}) as {
    company?: string;
    accentColor?: string;
    logo?: string;
  };
  let logo: string | undefined;
  if (brandingSetting.logo) {
    const path = isAbsolute(brandingSetting.logo)
      ? brandingSetting.logo
      : join(workspace, brandingSetting.logo);
    if (existsSync(path)) logo = logoDataUri(readFileSync(path), path);
  }
  const me = settings.me ? plan.personById(String(settings.me))?.name : undefined;
  // Files go into the workspace only, under a plain file name.
  if (args.name !== undefined && (/[\\/]/.test(args.name) || args.name.includes("..")))
    throw new ToolError(`name is a file name without folders: "${args.name}" is not.`);
  const outDir = args.outDir
    ? workspacePath(workspace, args.outDir, "outDir")
    : join(tools.planDir, "reports");
  // The browser is started: never one inside the workspace (a repository could bring its own).
  const configured = args.browserPath ?? ((settings["export.browserPath"] as string) || undefined);
  const browserPath = configured && insideFolder(workspace, configured) ? undefined : configured;
  const refused =
    configured && !browserPath
      ? [`The browser path ${configured} is inside the workspace, so it was not used.`]
      : [];
  const result = await runExport(plan, tools.schedule, tools.scheduleOf(plan, "demand"), {
    formats,
    sections: args.sections,
    summary: args.summary,
    periodDays: args.periodDays ?? Number(settings["export.periodDays"] ?? 7),
    ganttWeeks: args.ganttWeeks ?? Number(settings["export.ganttWeeks"] ?? 12),
    author: args.author ?? (settings["export.author"] as string) ?? me ?? plan.people[0]?.name,
    branding: {
      company: brandingSetting.company,
      accentColor: brandingSetting.accentColor,
      logoDataUri: logo,
    },
    baseline: baselineById(tools, args.baseline)?.baseline,
    testPlan: args.testPlan,
    tester: args.tester,
    witness: args.witness,
    csvDelimiter: args.csvDelimiter ?? (settings["export.csvDelimiter"] as string),
    browserPath,
    name: args.name,
  });
  mkdirSync(outDir, { recursive: true });
  const files = result.files.map((f) => {
    const path = join(outDir, f.name);
    writeFileSync(path, f.data);
    return { format: f.format, file: relative(workspace, path).split("\\").join("/"), path };
  });
  return { files, warnings: [...refused, ...result.warnings] };
}

/**
 * Calibrated estimates of open tasks from past accuracy (the person's actual/estimate ratio, else
 * the best tag's). With apply, the new @est values are written.
 */
export function calibrateEstimates(
  tools: PlannerTools,
  args: { minSamples?: number; apply?: boolean }
) {
  const st = tools.stage();
  const { rows } = calibrationRows(st.plan, args.minSamples ?? 3);
  const proposal = rows.map((r) => ({
    id: r.task.id ?? r.key,
    title: r.task.title,
    estimate: r.task.attrs.find((a) => a.key === "est")?.value,
    calibrated: r.value,
    factor: Math.round(r.factor * 100) / 100,
    basis: r.basis,
  }));
  if (!args.apply) return { applied: false, rows: proposal };
  for (const r of rows) {
    const file = st.plan.file(r.task.file)!;
    const t = file.items.find((x) => x.line === r.task.line) ?? r.task;
    st.apply({ path: file.path, edits: setAttr(file.lines, t, "est", r.value) });
  }
  return { applied: true, rows: proposal, changed: tools.commit(st) };
}
