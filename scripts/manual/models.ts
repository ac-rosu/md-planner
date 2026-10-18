// Builds the webview messages for the user manual screenshots: every view of the sample project
// in the variants the manual shows, computed exactly as the extension's panels compute them.
//   node out/manual/models.cjs <planDir> <today> <outFile>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baselineLookup, parseBaseline } from "../../src/core/baseline";
import { type TaskFilter } from "../../src/core/filter";
import { loadPlanIndex } from "../../src/core/fsLoader";
import { schedulePlan } from "../../src/core/scheduler";
import { buildDashboardModel } from "../../src/core/views/dashboard";
import { buildGanttModel } from "../../src/core/views/gantt";
import { buildKanbanModel } from "../../src/core/views/kanban";
import { buildResourcesModel } from "../../src/core/views/resources";
import { buildRunnerModel } from "../../src/core/views/testRunner";
import {
  DEFAULT_GANTT_OPTIONS,
  DEFAULT_KANBAN_OPTIONS,
  type GanttViewOptions,
  type KanbanViewOptions,
} from "../../src/webview/shared/protocol";

const [planDir, today, outFile] = process.argv.slice(2);
const plan = loadPlanIndex(planDir).plan;
const schedule = schedulePlan(plan, { today });
const demand = schedulePlan(plan, { today, mode: "demand" });

const baselineDir = join(planDir, "baselines");
const baselineIds = existsSync(baselineDir)
  ? readdirSync(baselineDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => f.replace(/\.json$/, ""))
  : [];
const latest = baselineIds.at(-1);
const baseline = latest
  ? parseBaseline(readFileSync(join(baselineDir, `${latest}.json`), "utf8"))
  : undefined;

// The sample workspace's .vscode/settings.json sets these WIP limits.
const wipLimits = { doing: 2, review: 2 };
const history = (canUndo: boolean) => ({ type: "history", canUndo, canRedo: false });

function gantt(patch: Partial<GanttViewOptions> = {}): unknown[] {
  const options = { ...DEFAULT_GANTT_OPTIONS, ...patch };
  return [
    {
      type: "model",
      model: buildGanttModel(plan, schedule, {
        grouping: options.grouping,
        hideDone: options.hideDone,
        baseline: options.showBaseline && baseline ? baselineLookup(baseline) : undefined,
      }),
      options,
      baselines: baselineIds,
    },
    history(true),
  ];
}

function kanban(patch: Partial<KanbanViewOptions> = {}, filter: TaskFilter = {}): unknown[] {
  const options = { ...DEFAULT_KANBAN_OPTIONS, ...patch };
  return [
    {
      type: "model",
      model: buildKanbanModel(plan, schedule, { ...options, filter, wipLimits }),
      options,
    },
    history(true),
  ];
}

const fat = plan.testById("UAT-01") ?? plan.tests[0];

// The test run in progress: the third step of TC-01 has just failed and has no punch item yet, so
// the runner offers "Create punch item" (computed from an in-memory edit; no file is changed).
const running = loadPlanIndex(planDir);
const fatText = readFileSync(join(planDir, fat.file), "utf8").replace(
  "- [ ] Order appears in the order history",
  '- [x] Order appears in the order history @result:fail @note:"stays in STOPPING for 8 s"'
);
running.update(fat.file, fatText);
const runningFat = running.plan.testById(fat.id);

const messages: Record<string, unknown[]> = {
  gantt: gantt(),
  "gantt-owner": gantt({ grouping: "owner", color: "status" }),
  "gantt-month": gantt({ zoom: "month", showBaseline: false, hideDone: true }),
  "gantt-ot": gantt({ grouping: "owner", hideDone: true, showBaseline: false }),
  kanban: kanban(),
  "kanban-owner": kanban({ swimlane: "owner" }, { milestone: ["M1"] }),
  "kanban-frontend": kanban({}, { tag: ["frontend"] }),
  "kanban-punch": kanban({ board: "punch", swimlane: "severity" }),
  resources: [{ type: "model", model: buildResourcesModel(plan, schedule) }],
  "resources-demand": [{ type: "model", model: buildResourcesModel(plan, demand) }],
  dashboard: [
    {
      type: "model",
      model: buildDashboardModel(plan, schedule, baseline),
      baselines: baselineIds,
      baseline: latest,
    },
  ],
  testRunner: [
    { type: "model", model: buildRunnerModel(plan, fat, today, "Alex") },
    history(false),
  ],
  "testRunner-fail": [
    { type: "model", model: buildRunnerModel(running.plan, runningFat, today, "Alex") },
    history(true),
  ],
};
writeFileSync(outFile, JSON.stringify(messages));
console.log(`manual models written to ${outFile}`);
