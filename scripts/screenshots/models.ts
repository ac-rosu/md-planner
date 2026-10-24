// Builds the webview view models of the sample project for the screenshot harness.
//   models.cjs <planDir> <today> <outFile> [variantsFile]
// The optional variants file holds extra view states (keyed "<view>-<variant>") for layout checks.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlanIndex } from "../../src/core/fsLoader";
import { schedulePlan } from "../../src/core/scheduler";
import { buildGanttModel } from "../../src/core/views/gantt";
import { buildKanbanModel } from "../../src/core/views/kanban";
import { buildDashboardModel } from "../../src/core/views/dashboard";
import { buildResourcesModel } from "../../src/core/views/resources";
import { buildRunnerModel } from "../../src/core/views/testRunner";
import { baselineLookup, parseBaseline } from "../../src/core/baseline";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { DEFAULT_GANTT_OPTIONS, DEFAULT_KANBAN_OPTIONS } from "../../src/webview/shared/protocol";

const [planDir, today, outFile, variantsFile] = process.argv.slice(2);
const plan = loadPlanIndex(planDir).plan;
const schedule = schedulePlan(plan, { today });
const baselineDir = join(planDir, "baselines");
const baselineFiles = existsSync(baselineDir)
  ? readdirSync(baselineDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
  : [];
const baseline = baselineFiles.length
  ? parseBaseline(readFileSync(join(baselineDir, baselineFiles[baselineFiles.length - 1]), "utf8"))
  : undefined;
const demand = schedulePlan(plan, { today, mode: "demand" });
const messages: Record<string, unknown[]> = {
  gantt: [
    {
      type: "model",
      model: buildGanttModel(plan, schedule, {
        grouping: "milestone",
        order: DEFAULT_GANTT_OPTIONS.order,
        baseline: baseline ? baselineLookup(baseline) : undefined,
      }),
      options: { ...DEFAULT_GANTT_OPTIONS },
      baselines: baselineFiles.map((f) => f.replace(/\.json$/, "")),
    },
    { type: "history", canUndo: true, canRedo: false },
  ],
  kanban: [
    {
      type: "model",
      model: buildKanbanModel(plan, schedule, {
        ...DEFAULT_KANBAN_OPTIONS,
        wipLimits: { doing: 2, review: 2 },
      }),
      options: DEFAULT_KANBAN_OPTIONS,
    },
  ],
  resources: [{ type: "model", model: buildResourcesModel(plan, demand) }],
  testRunner: [
    {
      type: "model",
      model: buildRunnerModel(plan, plan.testById("UAT-01") ?? plan.tests[0], today, "Alex"),
    },
    { type: "history", canUndo: false, canRedo: false },
  ],
  dashboard: [
    {
      type: "model",
      model: buildDashboardModel(plan, schedule, baseline),
      baselines: baselineFiles.map((f) => f.replace(/\.json$/, "")),
      baseline: baselineFiles.at(-1)?.replace(/\.json$/, ""),
    },
  ],
};
writeFileSync(outFile, JSON.stringify(messages));
console.log(`models written to ${join(outFile)}`);

if (variantsFile) {
  // Owner swimlanes over the whole plan: lanes taller than the window (layout regression check).
  const lanes = { ...DEFAULT_KANBAN_OPTIONS, swimlane: "owner" as const };
  const variants: Record<string, unknown[]> = {
    "kanban-lanes": [
      {
        type: "model",
        model: buildKanbanModel(plan, schedule, { ...lanes, wipLimits: { doing: 2, review: 2 } }),
        options: lanes,
      },
    ],
  };
  writeFileSync(variantsFile, JSON.stringify(variants));
}
