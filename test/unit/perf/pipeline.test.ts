// End-to-end performance check on a generated 2,000-task plan: everything the extension does on a
// file change (re-parse one file, rebuild the plan, schedule, demand schedule, diagnostics, cache)
// must stay under the 200 ms target, and every view model and export must stay interactive.
import { describe, expect, it } from "vitest";
import { PlanIndex } from "../../../src/core/index";
import { scheduleDiagnostics } from "../../../src/core/scheduleDiagnostics";
import { scheduleJsonText } from "../../../src/core/scheduleJson";
import { schedulePlan } from "../../../src/core/scheduler";
import { validatePlan } from "../../../src/core/validate";
import { buildDashboardModel } from "../../../src/core/views/dashboard";
import { buildGanttModel } from "../../../src/core/views/gantt";
import { buildKanbanModel } from "../../../src/core/views/kanban";
import { buildResourcesModel } from "../../../src/core/views/resources";
import { exportCsv } from "../../../src/export/csv";
import { REPORT_SECTIONS, renderStatusReport } from "../../../src/export/html/report";
import { exportMspdi } from "../../../src/export/mspdi";
import { exportXlsx } from "../../../src/export/xlsx";
import { DEFAULT_KANBAN_OPTIONS } from "../../../src/webview/shared/protocol";
import { LARGE_PLAN_TODAY, largePlanFiles } from "../../fixtures/largePlan";

const today = LARGE_PLAN_TODAY;

/** Best of `runs` wall-clock times in ms. */
function best(runs: number, fn: () => unknown): number {
  let min = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

describe("2,000-task plan end to end", () => {
  const files = largePlanFiles();
  const index = new PlanIndex();
  const timings: Record<string, number> = {};

  it("loads the generated plan", () => {
    timings.load = best(1, () => {
      for (const [path, text] of Object.entries(files)) index.update(path, text);
      return index.plan;
    });
    const plan = index.plan;
    expect(plan.tasks).toHaveLength(2000);
    expect(plan.milestones).toHaveLength(20);
    expect(plan.issues).toEqual([]);
    expect(timings.load).toBeLessThan(1000);
  });

  it("recomputes after an edit in under 200 ms (parse, plan, schedules, diagnostics, cache)", () => {
    const path = "milestones/M10-work-package.md";
    const original = files[path];
    let flip = false;
    const recompute = () => {
      // A one-line change, as from typing in the editor or a drag in the Gantt.
      flip = !flip;
      index.update(path, flip ? original.replace("@est:2d", "@est:3d") : original);
      const plan = index.plan;
      const schedule = schedulePlan(plan, { today });
      const demand = schedulePlan(plan, { today, mode: "demand" });
      const issues = [
        ...validatePlan(plan, { graph: schedule.graph }),
        ...scheduleDiagnostics(plan, schedule, demand),
      ];
      return [scheduleJsonText(plan, schedule), issues];
    };
    recompute(); // warm-up
    timings.recompute = best(5, recompute);
    expect(timings.recompute).toBeLessThan(200);
  });

  it("builds every view model quickly", () => {
    const plan = index.plan;
    const schedule = schedulePlan(plan, { today });
    const demand = schedulePlan(plan, { today, mode: "demand" });
    timings.gantt = best(3, () => buildGanttModel(plan, schedule, { grouping: "milestone" }));
    timings.kanban = best(3, () => buildKanbanModel(plan, schedule, DEFAULT_KANBAN_OPTIONS));
    timings.resources = best(3, () => buildResourcesModel(plan, demand));
    timings.dashboard = best(3, () => buildDashboardModel(plan, schedule));
    const gantt = buildGanttModel(plan, schedule, { grouping: "milestone" });
    expect(gantt.rows.filter((r) => r.kind === "task" || r.kind === "parent")).toHaveLength(2000);
    for (const view of ["gantt", "kanban", "resources", "dashboard"])
      expect(timings[view], view).toBeLessThan(150);
  });

  it("exports the whole plan", async () => {
    const plan = index.plan;
    const schedule = schedulePlan(plan, { today });
    timings.html = best(1, () =>
      renderStatusReport(plan, schedule, {
        sections: REPORT_SECTIONS.map((s) => s.id),
        periodDays: 14,
        ganttWeeks: 8,
      })
    );
    timings.csv = best(1, () => exportCsv(plan, schedule));
    timings.mspdi = best(1, () => exportMspdi(plan, schedule));
    const t0 = performance.now();
    const xlsx = await exportXlsx(plan, schedule);
    timings.xlsx = performance.now() - t0;
    expect(xlsx.byteLength).toBeGreaterThan(10_000);
    for (const format of ["html", "csv", "mspdi", "xlsx"])
      expect(timings[format], format).toBeLessThan(3000);
    console.log(
      `2,000 tasks (ms): ${Object.entries(timings)
        .map(([k, v]) => `${k} ${v.toFixed(1)}`)
        .join(", ")}`
    );
  });
});
