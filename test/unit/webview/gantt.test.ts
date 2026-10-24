import { describe, expect, it } from "vitest";
import { formatDate, isoWeekday, parseDate } from "../../../src/core/dates";
import { schedulePlan } from "../../../src/core/scheduler";
import { buildGanttModel } from "../../../src/core/views/gantt";
import {
  linkTargetAt,
  resizeHandleWidth,
  stepWorkingDays,
  visibleRows,
  vscodeContext,
} from "../../../src/webview/gantt/rows";
import {
  dayToX,
  fitPx,
  gridLines,
  headerTicks,
  makeScale,
  xToDay,
  zoomFor,
} from "../../../src/webview/gantt/scale";
import { loadSample, TODAY } from "../helpers";

const plan = loadSample().plan;
const schedule = schedulePlan(plan, { today: TODAY });
const d = (s: string) => parseDate(s)!;

describe("gantt scale", () => {
  it("starts on a Monday and converts days and pixels both ways", () => {
    const s = makeScale(d("2026-10-01"), d("2027-03-31"), 14);
    expect(isoWeekday(s.start)).toBe(1);
    expect(s.start).toBeLessThanOrEqual(d("2026-09-24"));
    expect(xToDay(s, dayToX(s, d("2026-12-25")))).toBe(d("2026-12-25"));
    expect(xToDay(s, dayToX(s, d("2026-12-25")) + 13.9)).toBe(d("2026-12-25"));
    expect(s.width).toBe(Math.ceil(s.days * 14));
  });

  it("labels header rows per zoom level", () => {
    const week = headerTicks(makeScale(d("2026-10-01"), d("2026-11-30"), 14));
    expect(week.top[0].label).toMatch(/^(Sep|Oct) 2026$/);
    expect(week.bottom.map((t) => t.label)).toContain("W42");
    const day = headerTicks(makeScale(d("2026-10-12"), d("2026-10-20"), 32));
    expect(day.bottom.map((t) => t.label)).toContain("We 14");
    expect(day.top.some((t) => t.label.startsWith("W42 · 12 Oct 2026"))).toBe(true);
    const month = headerTicks(makeScale(d("2026-10-01"), d("2027-03-31"), 4));
    expect(month.top.map((t) => t.label)).toEqual(["2026", "2027"]);
    expect(month.bottom.map((t) => t.label)).toContain("Jan");
    const quarter = headerTicks(makeScale(d("2026-10-01"), d("2027-09-30"), 1.5));
    expect(quarter.bottom.map((t) => t.label)).toEqual(
      expect.arrayContaining(["Q4", "Q1", "Q2", "Q3"])
    );
    expect(gridLines(makeScale(d("2026-10-01"), d("2026-11-30"), 14)).length).toBeGreaterThan(8);
  });

  it("fits the range into a width and maps densities to zoom names", () => {
    const px = fitPx(d("2026-10-01"), d("2027-03-31"), 1200);
    expect(px).toBeGreaterThan(5);
    expect(px).toBeLessThan(7);
    expect(zoomFor(32)).toBe("day");
    expect(zoomFor(14)).toBe("week");
    expect(zoomFor(4)).toBe("month");
    expect(zoomFor(1)).toBe("quarter");
  });

  it("steps over weekends and holidays", () => {
    const model = { workweek: [1, 2, 3, 4, 5], holidays: [d("2026-12-25")] };
    expect(formatDate(stepWorkingDays(model, d("2026-12-24"), 1))).toBe("2026-12-28");
    expect(formatDate(stepWorkingDays(model, d("2026-12-28"), -1))).toBe("2026-12-24");
    expect(formatDate(stepWorkingDays(model, d("2026-10-14"), 3))).toBe("2026-10-19");
  });
});

describe("gantt model", () => {
  it("groups by milestone with sections, nested tasks and roll-ups", () => {
    const m = buildGanttModel(plan, schedule, { grouping: "milestone" });
    expect(m.rows[0]).toMatchObject({
      key: "milestone:M1",
      kind: "milestone",
      target: d("2026-10-30"),
      late: false,
    });
    const m5 = m.rows.find((r) => r.key === "milestone:M5")!;
    expect(m5).toMatchObject({ late: true, finish: d("2027-03-31") });
    const t102 = m.rows.find((r) => r.key === "T102")!;
    expect(t102).toMatchObject({
      kind: "parent",
      hasChildren: true,
      ownerInitials: "SA",
      editable: false,
    });
    const t104 = m.rows.find((r) => r.key === "T104")!;
    expect(t104).toMatchObject({
      kind: "task",
      parent: "T102",
      level: 3,
      editable: true,
      est: "6h",
    });
    expect(m.rows.find((r) => r.key === "T101")).toMatchObject({ editable: false, status: "done" });
    expect(m.rows.some((r) => r.key === "T115")).toBe(false); // cancelled
    expect(m.links).toContainEqual({ from: "T101", to: "T102", critical: false });
    expect(m.links.filter((l) => l.critical).map((l) => `${l.from}>${l.to}`)).toContain(
      "T403>T404"
    );
    expect(m.start).toBeLessThanOrEqual(d("2026-10-01"));
    expect(m.end).toBe(d("2027-03-31"));
    expect(m.holidays).toContain(d("2026-12-25"));
    expect(t104.tooltip[0]).toBe("T104 · Order events schema");
  });

  it("groups by owner, section and tag", () => {
    const owner = buildGanttModel(plan, schedule, { grouping: "owner" });
    expect(owner.rows.filter((r) => r.kind === "group").map((r) => r.title)).toEqual([
      "Alex",
      "Sam",
      "Priya",
      "Jordan",
      "Maria",
      "Unassigned",
    ]);
    expect(owner.rows.find((r) => r.key === "T112")?.parent).toBe("owner:unassigned");
    const section = buildGanttModel(plan, schedule, { grouping: "section" });
    expect(section.rows.find((r) => r.title === "M2 › Checkout")?.kind).toBe("group");
    const tag = buildGanttModel(plan, schedule, { grouping: "tag" });
    expect(tag.rows.find((r) => r.key === "T106")?.parent).toBe("tag:frontend");
    expect(tag.rows.filter((r) => r.kind === "group").at(-1)?.title).toBe("(no tag)");
  });

  it("hides done tasks on request and hides rows under collapsed groups", () => {
    const m = buildGanttModel(plan, schedule, { grouping: "milestone", hideDone: true });
    expect(m.rows.some((r) => r.key === "T001")).toBe(false);
    const visible = visibleRows(m.rows, new Set(["milestone:M2"]));
    expect(visible.some((r) => r.key === "milestone:M2")).toBe(true);
    expect(visible.some((r) => r.milestone === "M2" && r.kind !== "milestone")).toBe(false);
    expect(visible.some((r) => r.key === "T201")).toBe(true);
  });

  it("adds baseline bars and slip", () => {
    const baseline = {
      name: "kickoff",
      task: (key: string) =>
        key === "T107" ? { start: d("2026-11-05"), finish: d("2026-11-13") } : undefined,
    };
    const m = buildGanttModel(plan, schedule, { grouping: "milestone", baseline });
    expect(m.baseline).toBe("kickoff");
    expect(m.rows.find((r) => r.key === "T107")).toMatchObject({
      baselineFinish: d("2026-11-13"),
      slip: 5,
    });
  });
});

describe("gantt drag safety", () => {
  const model = buildGanttModel(plan, schedule, { grouping: "milestone", hideDone: false });
  const rows = model.rows;
  const scale = makeScale(model.start, model.end, 14);
  const ROW = 26;
  const index = (key: string) => rows.findIndex((r) => r.key === key);
  const row = (key: string) => rows[index(key)];

  it("links only when the pointer is released on a bar (or right next to it)", () => {
    const target = row("T122");
    const y = index("T122") * ROW + ROW / 2;
    const left = dayToX(scale, target.start!);
    const right = dayToX(scale, target.finish! + 1);
    expect(linkTargetAt(rows, scale, "T121", (left + right) / 2, y, ROW)?.key).toBe("T122");
    expect(linkTargetAt(rows, scale, "T121", right + 5, y, ROW)?.key).toBe("T122");
    // Far from the bar, on the same row: no dependency.
    expect(linkTargetAt(rows, scale, "T121", right + 60, y, ROW)).toBeUndefined();
    // Not on itself, not on milestone or section rows.
    expect(linkTargetAt(rows, scale, "T122", (left + right) / 2, y, ROW)).toBeUndefined();
    const m = index("milestone:M2");
    expect(linkTargetAt(rows, scale, "T121", left, m * ROW + 5, ROW)).toBeUndefined();
  });

  it("keeps the resize handle to a third of the bar, and off very short bars", () => {
    expect(resizeHandleWidth(4.5)).toBe(0);
    expect(resizeHandleWidth(11)).toBe(0);
    expect(resizeHandleWidth(12)).toBe(4);
    expect(resizeHandleWidth(200)).toBe(8);
  });

  it("offers Remove fixed start on pinned bars only", () => {
    expect(JSON.parse(vscodeContext(row("T105")))).toMatchObject({ key: "T105", pinned: true });
    expect(JSON.parse(vscodeContext(row("T122"))).pinned).toBeUndefined();
    expect(row("T105").tooltip.join("\n")).toContain(
      "Fixed start: not before 2026-11-10 · right-click → Remove fixed start"
    );
  });
});
