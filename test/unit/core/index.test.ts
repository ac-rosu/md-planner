import { mkdtempSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeFilter,
  isEmptyFilter,
  matchesFilter,
  matchesFilterDeep,
} from "../../../src/core/filter";
import { applyFileEdits, listPlanFiles, loadPlanIndex } from "../../../src/core/fsLoader";
import { PlanIndex } from "../../../src/core/index";
import { setAttr } from "../../../src/core/writer";
import { loadSample, md, SAMPLE_PLAN, task } from "../helpers";

describe("PlanIndex", () => {
  it("loads every plan file of the sample", () => {
    expect(listPlanFiles(SAMPLE_PLAN)).toEqual([
      "inbox.md",
      "milestones/M1-discovery-design.md",
      "milestones/M2-backend.md",
      "milestones/M3-frontend.md",
      "milestones/M4-acceptance-test.md",
      "milestones/M5-launch.md",
      "project.md",
      "punchlist.md",
      "team.md",
      "tests/UAT-01-checkout.md",
      "tests/UAT-02-go-live.md",
    ]);
    const plan = loadSample().plan;
    expect(plan.tasks.length).toBeGreaterThan(40);
    expect(new Set(plan.tasks.map((t) => t.id)).size).toBe(plan.tasks.length);
  });

  it("updates incrementally and caches the resolved plan", () => {
    const index = new PlanIndex();
    index.update("milestones/M1.md", md("# M1", "", "- [ ] a @est:1h ^T1"));
    const v = index.version;
    const first = index.plan;
    expect(index.plan).toBe(first);
    expect(index.update("milestones/M1.md", md("# M1", "", "- [ ] a @est:1h ^T1"))).toBe(false);
    expect(index.version).toBe(v);
    expect(index.update("milestones/M1.md", md("# M1", "", "- [ ] a @est:2h ^T1"))).toBe(true);
    expect(index.plan).not.toBe(first);
    expect(index.plan.taskById("T1")?.est).toBe(2);
    expect(index.update("notes/readme.md", "# x")).toBe(false);
    expect(index.remove("milestones/M1.md")).toBe(true);
    expect(index.plan.tasks).toEqual([]);
  });

  it("re-resolves durations when hoursPerDay changes in project.md", () => {
    const index = new PlanIndex();
    index.update("milestones/M1.md", md("# M1", "", "- [ ] a @est:2d ^T1"));
    expect(index.plan.taskById("T1")?.est).toBe(16);
    index.update("project.md", md("# P", "", "hoursPerDay: 7"));
    expect(index.plan.taskById("T1")?.est).toBe(14);
  });

  it("applies edits on disk and refreshes the index", () => {
    const dir = mkdtempSync(join(tmpdir(), "planner-"));
    cpSync(SAMPLE_PLAN, dir, { recursive: true });
    const index = loadPlanIndex(dir);
    const t = index.plan.taskById("T104")!;
    const file = index.get(t.file)!;
    applyFileEdits(dir, index, t.file, setAttr(file.lines, t, "owner", "priya"));
    expect(readFileSync(join(dir, t.file), "utf8")).toContain(
      "Order events schema @est:6h @owner:priya ^T104"
    );
    expect(index.plan.taskById("T104")?.owner).toBe("priya");
  });
});

describe("task filter", () => {
  const plan = loadSample().plan;

  it("matches by owner (inherited), tag, status, milestone and text", () => {
    expect(matchesFilter(task(plan, "T008"), { owner: ["alex"] })).toBe(true); // inherited from T006
    expect(matchesFilter(task(plan, "T112"), { owner: ["unassigned"] })).toBe(true);
    expect(matchesFilter(task(plan, "T106"), { tag: ["#frontend"] })).toBe(true);
    expect(matchesFilter(task(plan, "T106"), { status: ["blocked"] })).toBe(true);
    expect(matchesFilter(task(plan, "T106"), { status: ["todo"] })).toBe(false);
    expect(matchesFilter(task(plan, "T106"), { milestone: ["m2"] })).toBe(true);
    expect(matchesFilter(task(plan, "T104"), { text: "cloudevents format" })).toBe(true);
    expect(matchesFilter(task(plan, "T104"), { text: "cloudevents zzz" })).toBe(false);
    expect(matchesFilterDeep(task(plan, "T102"), { text: "cloudevents" })).toBe(true);
  });

  it("describes and detects empty filters", () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ text: "  " })).toBe(true);
    expect(
      describeFilter({ owner: ["sam"], tag: ["frontend"], status: ["doing"], text: "payment" })
    ).toBe('owner: sam · #frontend · status: doing · "payment"');
  });
});
