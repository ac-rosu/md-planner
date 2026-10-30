import { describe, expect, it } from "vitest";
import { formatDate, isoWeekday, parseDate } from "../../../src/core/dates";
import { schedulePlan } from "../../../src/core/scheduler";
import { buildGanttModel } from "../../../src/core/views/gantt";
import { type GanttRow } from "../../../src/core/views/gantt";
import { changedFields, editValues } from "../../../src/webview/gantt/editFields";
import {
  dayLabel,
  describeFocus,
  dragPreview,
  editTarget,
  linkFocus,
  linkId,
  linkTargetAt,
  moveBase,
  resizeHandleWidth,
  roundedPath,
  routeLinks,
  stepWorkingDays,
  visibleRows,
  vscodeContext,
} from "../../../src/webview/gantt/rows";
import {
  anchoredScroll,
  dayToX,
  fitPx,
  gridLines,
  headerTicks,
  makeScale,
  MAX_PX,
  MIN_PX,
  type Scale,
  xToDay,
  zoomFor,
  ZoomGesture,
  zoomPx,
} from "../../../src/webview/gantt/scale";
import { loadSample, md, planFrom, TODAY } from "../helpers";

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

describe("gantt zoom gesture", () => {
  it("zooms in on a pinch or wheel up, out on a pinch or wheel down, within limits", () => {
    expect(zoomPx(14, -100)).toBeCloseTo(14 * Math.pow(2, 0.4));
    expect(zoomPx(14, 100)).toBeCloseTo(14 / Math.pow(2, 0.4));
    // A wheel in lines (Firefox-style) counts like pixels; huge deltas are capped.
    expect(zoomPx(14, -3, 1)).toBeCloseTo(zoomPx(14, -99));
    expect(zoomPx(14, -5000)).toBeCloseTo(14 * Math.pow(2, 0.8));
    // Small pinch steps add up smoothly.
    let px = 14;
    for (let i = 0; i < 10; i++) px = zoomPx(px, -10);
    expect(px).toBeCloseTo(zoomPx(14, -100));
    expect(zoomPx(MAX_PX, -100)).toBe(MAX_PX);
    expect(zoomPx(MIN_PX, 100)).toBe(MIN_PX);
  });

  it("keeps the day under the pointer in place", () => {
    const before = makeScale(d("2026-10-01"), d("2027-03-31"), 14);
    const after = { ...before, px: 28, width: before.days * 28 };
    const day = d("2026-12-01") + 0.5;
    // The pointer is 700 px from the left of the scroll area; the chart starts after a 320 px list.
    const scrollBefore = 320 + (day - before.start) * before.px - 700;
    const scrollAfter = anchoredScroll(after, day, 700, 320);
    expect(320 + (day - after.start) * after.px - scrollAfter).toBe(700);
    expect(scrollAfter).toBeGreaterThan(scrollBefore);
    // Never scrolls before the start.
    expect(anchoredScroll(after, before.start, 700, 320)).toBe(0);
  });

  // The chart starts after the 320 px task list; `dayAt` is the day under a pointer x.
  const at = (px: number) => makeScale(d("2026-10-01"), d("2027-03-31"), px);
  const dayAt = (s: Scale, scrollLeft: number, x: number) =>
    s.start + (scrollLeft + x - 320) / s.px;

  it("adds up wheel events until the frame, around the day under the pointer", () => {
    const g = new ZoomGesture(320);
    const shown = at(14);
    g.wheel(shown, 1000, 700, -50);
    // The pointer moved before the frame: the gesture still keeps the first day in place.
    g.wheel(shown, 1000, 900, -50);
    const px = g.frame(shown)!;
    expect(px).toBeCloseTo(zoomPx(zoomPx(14, -50), -50));
    const drawn = at(px);
    // More events waiting for the next frame: the gesture goes on around the same day.
    const left = g.scrollLeft(drawn, true)!;
    expect(dayAt(drawn, left, 700)).toBeCloseTo(dayAt(shown, 1000, 700));
    g.wheel(drawn, left, 900, -50);
    const next = at(g.frame(drawn)!);
    const last = g.scrollLeft(next, false)!;
    expect(dayAt(next, last, 700)).toBeCloseTo(dayAt(shown, 1000, 700));
    // Laid out with nothing waiting: the gesture is over.
    expect(g.scrollLeft(next, false)).toBeUndefined();
  });

  it("ends a gesture that changes nothing, so the next one starts at the pointer", () => {
    for (const [px, deltaY] of [
      [MAX_PX, -200], // pinching in at the limit
      [MIN_PX, 200], // pinching out at the limit
      [14, 0], // no movement
    ]) {
      const g = new ZoomGesture(320);
      const shown = at(px);
      g.wheel(shown, 3000, 700, deltaY);
      expect(g.frame(shown)).toBeUndefined();
      // A redraw for another reason (a new model, a zoom button) does not scroll back to that spot.
      expect(g.scrollLeft(shown, false)).toBeUndefined();
      expect(g.scrollLeft(at(32), false)).toBeUndefined();
    }
    // After scrolling elsewhere, the next pinch keeps the day now under the pointer in place.
    const g = new ZoomGesture(320);
    const max = at(MAX_PX);
    g.wheel(max, 3000, 700, -100);
    expect(g.frame(max)).toBeUndefined();
    g.wheel(max, 6000, 500, 100);
    const drawn = at(g.frame(max)!);
    expect(drawn.px).toBeLessThan(MAX_PX);
    expect(dayAt(drawn, g.scrollLeft(drawn, false)!, 500)).toBeCloseTo(dayAt(max, 6000, 500));
  });

  it("ends when the zoom changes by other means", () => {
    const g = new ZoomGesture(320);
    const shown = at(14);
    g.wheel(shown, 1000, 700, -100);
    g.end();
    expect(g.frame(shown)).toBeUndefined();
    expect(g.scrollLeft(at(4.5), false)).toBeUndefined();
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

  it("gives a bar in progress the day its remaining work starts", () => {
    // Started Tue 20 Oct, 16 of 40 h left; today is Thu 29 Oct.
    const p = planFrom({
      "project.md": md("# P", "", "start: 2026-10-05", "workweek: mon-fri", "hoursPerDay: 8"),
      "team.md": md("# Team", "", "## Alex", "", "capacity: 40h/week"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [/] Build @est:40h @act:24h @owner:alex @started:2026-10-20 ^T1",
        "- [ ] Test @est:8h @owner:alex @dep:T1 ^T2"
      ),
    });
    const m = buildGanttModel(p, schedulePlan(p, { today: "2026-10-29" }), {
      grouping: "milestone",
    });
    expect(m.rows.find((r) => r.key === "T1")).toMatchObject({
      start: d("2026-10-20"),
      workStart: d("2026-10-29"),
      finish: d("2026-10-30"),
    });
    // A task not started yet: its work starts where its bar does.
    expect(m.rows.find((r) => r.key === "T2")?.workStart).toBeUndefined();
  });

  it("gives a subtask without an estimate its share of the parent's", () => {
    const p = planFrom({
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [ ] Feature @est:40h ^T1",
        "  - [ ] Part A ^T2",
        "  - [ ] Part B @est:4h ^T3",
        "  - [ ] Part C ^T4"
      ),
    });
    const m = buildGanttModel(p, schedulePlan(p, { today: TODAY }), { grouping: "milestone" });
    expect(m.rows.find((r) => r.key === "T2")).toMatchObject({ budget: 18, budgetOf: "T1" });
    expect(m.rows.find((r) => r.key === "T3")?.budget).toBeUndefined();
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

  it("previews a drag in working days, as the schedule will place it", () => {
    const cal = { workweek: [1, 2, 3, 4, 5], holidays: [d("2026-10-14")] };
    // Wed 7 → Thu 8 Oct (2 working days), moved by 2 calendar days: Fri 9 and Mon 12, not Sat.
    const bar = { start: d("2026-10-07"), finish: d("2026-10-08") };
    const moved = dragPreview(cal, bar, "move", 2);
    expect([moved.start, moved.finish].map(dayLabel)).toEqual(["Fri 2026-10-09", "Mon 2026-10-12"]);
    // Landing on a Saturday starts on Monday; the holiday on Wed 14 Oct is skipped.
    const weekend = dragPreview(cal, bar, "move", 3);
    expect([weekend.start, weekend.finish].map(dayLabel)).toEqual([
      "Mon 2026-10-12",
      "Tue 2026-10-13",
    ]);
    const holiday = dragPreview(cal, bar, "move", 6);
    expect(dayLabel(holiday.start)).toBe("Tue 2026-10-13");
    expect(dayLabel(holiday.finish)).toBe("Thu 2026-10-15");
    // Resizing onto a Saturday ends on the Friday before; never before the start.
    expect(dayLabel(dragPreview(cal, bar, "resize", 2).finish)).toBe("Fri 2026-10-09");
    expect(dragPreview(cal, bar, "resize", -5).finish).toBe(bar.start);
  });

  it("moves a bar in progress from where its remaining work starts, keeping @started", () => {
    const cal = { workweek: [1, 2, 3, 4, 5], holidays: [] };
    // Started Tue 20 Oct; the rest is Thu 29 and Fri 30 Oct.
    const bar = { start: d("2026-10-20"), finish: d("2026-10-30"), workStart: d("2026-10-29") };
    expect(moveBase(bar)).toBe(d("2026-10-29"));
    expect(moveBase({ start: d("2026-10-07") })).toBe(d("2026-10-07"));
    expect(moveBase({})).toBeUndefined();
    // One day later: Friday and Monday; the bar still starts on Tuesday 20 Oct.
    const moved = dragPreview(cal, bar, "move", 1);
    expect([moved.start, moved.finish].map(dayLabel)).toEqual(["Tue 2026-10-20", "Mon 2026-11-02"]);
  });

  it("offers Remove fixed start on pinned bars only", () => {
    expect(JSON.parse(vscodeContext(row("T105")))).toMatchObject({ key: "T105", pinned: true });
    expect(JSON.parse(vscodeContext(row("T122"))).pinned).toBeUndefined();
    expect(row("T105").tooltip.join("\n")).toContain(
      "Fixed start: not before 2026-11-10 · right-click → Remove fixed start"
    );
  });
});

describe("gantt dependency lines", () => {
  const scale = makeScale(d("2026-10-05"), d("2026-11-30"), 14);
  const ROW = 26;
  const bar = (key: string, start: string, finish: string) =>
    ({ key, kind: "task", start: d(start), finish: d(finish) }) as GanttRow;
  const link = (from: string, to: string) => ({ from, to, critical: false });

  it("rounds the corners of a line and leaves the end straight for the arrow", () => {
    expect(
      roundedPath(
        [
          [0, 0],
          [10, 0],
          [10, 20],
          [30, 20],
        ],
        4
      )
    ).toBe("M0,0 L6,0 Q10,0 10,4 L10,16 Q10,20 14,20 L30,20");
    // Short legs get a smaller radius; repeated points are dropped.
    expect(
      roundedPath(
        [
          [0, 0],
          [2, 0],
          [2, 0],
          [2, 10],
        ],
        4
      )
    ).toBe("M0,0 L1,0 Q2,0 2,1 L2,10");
  });

  it("gives predecessors that finish on the same day their own vertical lane", () => {
    const rows = [
      bar("A", "2026-10-05", "2026-10-07"),
      bar("B", "2026-10-06", "2026-10-07"),
      bar("C", "2026-10-12", "2026-10-13"),
      bar("D", "2026-10-14", "2026-10-15"),
    ];
    const routed = routeLinks([link("A", "D"), link("A", "C"), link("B", "C")], rows, scale, ROW);
    // The lane is where the line turns: the x of its first corner.
    const laneX = (from: string, to: string) =>
      Number(routed.find((r) => linkId(r.link) === `${from}→${to}`)!.d.match(/Q([\d.]+),/)![1]);
    const x1 = dayToX(scale, d("2026-10-08"));
    // A's lines share one lane (one source), B's line runs 3 px further.
    expect(laneX("A", "C")).toBe(x1 + 6);
    expect(laneX("A", "D")).toBe(x1 + 6);
    expect(laneX("B", "C")).toBe(x1 + 9);
    // Every line ends at the start of its successor, on the row centre.
    const end = routed
      .find((r) => r.link.to === "D")!
      .d.split(" L")
      .at(-1);
    expect(end).toBe(`${dayToX(scale, d("2026-10-14")) - 2},${3 * ROW + ROW / 2}`);
  });

  it("goes round through the row gap when the successor starts right away", () => {
    const rows = [bar("A", "2026-10-05", "2026-10-07"), bar("B", "2026-10-07", "2026-10-08")];
    const [r] = routeLinks([link("A", "B")], rows, scale, ROW);
    // Down to the gap between the rows (y = 26), back left, down into B.
    expect(r.d).toContain(",26 ");
    expect(r.d.endsWith(`L${dayToX(scale, d("2026-10-07")) - 2},39`)).toBe(true);
  });

  it("skips lines to rows that are hidden or not scheduled", () => {
    const rows = [bar("A", "2026-10-05", "2026-10-07"), { key: "B", kind: "task" } as GanttRow];
    expect(routeLinks([link("A", "B"), link("A", "X")], rows, scale, ROW)).toEqual([]);
  });

  it("highlights the selected line, or the lines of the selected bar", () => {
    const links = [link("A", "B"), link("B", "C"), link("C", "D")];
    const line = linkFocus(links, "D", { from: "A", to: "B" });
    expect([...line.links]).toEqual(["A→B"]);
    expect([...line.rows]).toEqual(["A", "B"]);
    const task = linkFocus(links, "B", undefined);
    expect([...task.links]).toEqual(["A→B", "B→C"]);
    expect([...task.rows]).toEqual(["A", "C"]);
    // Nothing to highlight: nothing fades.
    expect(linkFocus(links, "E", undefined).links.size).toBe(0);
    expect(linkFocus(links, undefined, { from: "X", to: "Y" }).links.size).toBe(0);
    expect(linkId(links[0])).toBe("A→B");
  });

  it("says in the help line what the highlighted dependencies mean", () => {
    const rows = ["A", "B", "C", "D"].map((k) => ({ key: k, id: `T${k}`, title: k }) as GanttRow);
    const links = [link("A", "C"), link("B", "C"), link("C", "D")];
    const model = { rows, links };
    expect(describeFocus(model, linkFocus(links, "C", undefined), "C", undefined)).toBe(
      "TC waits for TA, TB; TD waits for TC. Esc shows all arrows."
    );
    const sel = links[2];
    expect(describeFocus(model, linkFocus(links, undefined, sel), undefined, sel)).toBe(
      "TD waits for TC. Delete removes this dependency; Esc shows all arrows."
    );
    expect(describeFocus(model, linkFocus(links, "X", undefined), "X", undefined)).toBeUndefined();
  });
});

describe("gantt edit dialog", () => {
  const row = (key: string, title: string, more: Partial<GanttRow> = {}) =>
    ({ key, kind: "task", title, owner: "Sam", est: "12h", ...more }) as GanttRow;

  it("saves only the fields changed from the values it opened with", () => {
    const opened = editValues(row("T5", "Payments"));
    expect(opened).toEqual({ title: "Payments", owner: "sam", estimate: "12h" });
    // The estimate was changed elsewhere meanwhile: a new owner does not write the old one back.
    expect(changedFields(opened, { ...opened, owner: "alex" })).toEqual({ owner: "alex" });
    expect(changedFields(opened, opened)).toEqual({});
    expect(
      changedFields(opened, { title: " Payment provider ", owner: "", estimate: "2 d" })
    ).toEqual({ title: "Payment provider", owner: null, estimate: "2d" });
    // An emptied estimate is left as it is.
    expect(changedFields(opened, { ...opened, estimate: " " })).toEqual({});
  });

  it("stays on its task, and closes when the task changed while it was open", () => {
    const rows = [row("T5", "Payments"), row("milestones/M2.md#12", "Refunds")];
    expect(editTarget(rows, { key: "T5", title: "Payments" })).toEqual({ row: rows[0] });
    expect(editTarget([row("T5", "Payment provider")], { key: "T5", title: "Payments" })).toEqual({
      closed:
        '"Payments" changed while its edit dialog was open (its title is now "Payment provider"), so the dialog was closed and nothing was written. Open it again to edit the task.',
    });
    // A line inserted above: line 12 holds another task now.
    const shifted = [row("milestones/M2.md#12", "Invoices")];
    expect(editTarget(shifted, { key: "milestones/M2.md#12", title: "Refunds" })).toEqual({
      closed:
        '"Refunds" changed while its edit dialog was open (its line now holds "Invoices"), so the dialog was closed and nothing was written. Open it again to edit the task.',
    });
    // Gone, or known by an id since it was saved.
    expect(editTarget([], { key: "milestones/M2.md#12", title: "Refunds" })).toEqual({
      closed:
        '"Refunds" changed while its edit dialog was open, so the dialog was closed and nothing was written. Open it again to edit the task.',
    });
  });
});
