// How much work a write tool does: the plan is parsed once and not scheduled (validation needs
// only the dependency graph); after the write the staged plan is the plan, scheduled on demand.
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPlanFiles } from "../../../src/core/fsLoader";
import type * as Files from "../../../src/core/parser/files";
import type * as Scheduler from "../../../src/core/scheduler";
import { updateTasks } from "../../../src/mcp/taskTools";
import { PlannerTools } from "../../../src/mcp/tools";
import { SAMPLE_PLAN, TODAY } from "../helpers";

const counts = vi.hoisted(() => ({ parses: 0, schedules: 0 }));

vi.mock("../../../src/core/parser/files", async (original) => {
  const m = await original<typeof Files>();
  return {
    ...m,
    parsePlanFile: (...a: Parameters<typeof m.parsePlanFile>) => {
      counts.parses++;
      return m.parsePlanFile(...a);
    },
  };
});

vi.mock("../../../src/core/scheduler", async (original) => {
  const m = await original<typeof Scheduler>();
  return {
    ...m,
    schedulePlan: (...a: Parameters<typeof m.schedulePlan>) => {
      counts.schedules++;
      return m.schedulePlan(...a);
    },
  };
});

describe("the cost of a write tool", () => {
  beforeEach(() => {
    counts.parses = 0;
    counts.schedules = 0;
  });

  it("parses the plan once and schedules it only when asked", () => {
    const planDir = join(mkdtempSync(join(tmpdir(), "planner-mcp-cost-")), "plan");
    cpSync(SAMPLE_PLAN, planDir, { recursive: true });
    const files = listPlanFiles(planDir).length;
    const tools = new PlannerTools({ planDir, today: TODAY });

    updateTasks(tools, { updates: [{ id: "T001", priority: "high" }] });
    // Every file once, and the changed file again.
    expect(counts).toEqual({ parses: files + 1, schedules: 0 });
    expect(tools.plan.taskById("T001")?.prio).toBe("high");
    expect(tools.schedule.tasks.size).toBeGreaterThan(0);
    expect(counts.schedules).toBe(1);
    void tools.schedule;
    expect(counts.schedules).toBe(1);
  });
});
