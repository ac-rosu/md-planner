import { describe, expect, it } from "vitest";
import { schedulePlan } from "../../../src/core/scheduler";
import { buildKanbanModel } from "../../../src/core/views/kanban";
import {
  boardFiltersFrom,
  DEFAULT_GANTT_OPTIONS,
  DEFAULT_KANBAN_OPTIONS,
  ganttOptionsFrom,
  kanbanOptionsFrom,
  taskFilterFrom,
} from "../../../src/webview/shared/protocol";
import { asksBlockedReason } from "../../../src/webview/kanban/moves";
import { loadSample, TODAY } from "../helpers";

describe("stored view options and filters", () => {
  it("keeps valid Gantt options and gives anything else its default", () => {
    const valid = {
      ...DEFAULT_GANTT_OPTIONS,
      grouping: "owner",
      zoom: "month",
      pxPerDay: 3.5,
      baseline: "kickoff",
    } as const;
    expect(ganttOptionsFrom(valid)).toEqual(valid);
    expect(ganttOptionsFrom(undefined)).toEqual(DEFAULT_GANTT_OPTIONS);
    expect(ganttOptionsFrom("week")).toEqual(DEFAULT_GANTT_OPTIONS);
    // From an older version (no order), or a message that went wrong.
    expect(
      ganttOptionsFrom({
        grouping: "people",
        color: 3,
        hideDone: "yes",
        showCritical: false,
        pxPerDay: -1,
        baseline: 7,
        extra: true,
      })
    ).toEqual({ ...DEFAULT_GANTT_OPTIONS, showCritical: false });
    expect(ganttOptionsFrom({ pxPerDay: Number.NaN }).pxPerDay).toBeUndefined();
  });

  it("keeps valid Kanban options and gives anything else its default", () => {
    const valid = { board: "punch", swimlane: "severity", showCancelled: true, cardMode: "leaves" };
    expect(kanbanOptionsFrom(valid)).toEqual(valid);
    expect(kanbanOptionsFrom(null)).toEqual(DEFAULT_KANBAN_OPTIONS);
    expect(kanbanOptionsFrom({ board: "bugs", swimlane: ["owner"], showCancelled: 1 })).toEqual(
      DEFAULT_KANBAN_OPTIONS
    );
  });

  it("keeps the lists and text of a filter, and drops what a filter cannot hold", () => {
    const valid = {
      owner: ["sam"],
      tag: ["backend"],
      status: ["doing", "blocked"],
      milestone: ["M2"],
      text: "pay",
    };
    expect(taskFilterFrom(valid)).toEqual(valid);
    expect(taskFilterFrom({ owner: "sam", tag: [1, "ui"], status: ["late"], text: "" })).toEqual({
      tag: ["ui"],
    });
    expect(taskFilterFrom([])).toEqual({});
    expect(
      boardFiltersFrom({ tasks: { owner: "sam" }, punch: { text: "door" }, other: 1 })
    ).toEqual({ tasks: {}, punch: { text: "door" } });
    expect(boardFiltersFrom("x")).toEqual({});
  });

  it("builds a board from a filter that was stored malformed", () => {
    const plan = loadSample().plan;
    const schedule = schedulePlan(plan, { today: TODAY });
    const filter = taskFilterFrom({ owner: "sam", milestone: { M2: true } });
    const model = buildKanbanModel(plan, schedule, { ...DEFAULT_KANBAN_OPTIONS, filter });
    expect(model.hidden).toBe(0);
  });
});

describe("kanban drops", () => {
  it("asks why only when a task card becomes blocked", () => {
    expect(asksBlockedReason("tasks", "doing", "blocked")).toBe(true);
    expect(asksBlockedReason("tasks", undefined, "blocked")).toBe(true);
    // Moved within Blocked (another place or lane): it keeps its reason.
    expect(asksBlockedReason("tasks", "blocked", "blocked")).toBe(false);
    expect(asksBlockedReason("tasks", "blocked", "doing")).toBe(false);
    expect(asksBlockedReason("punch", "todo", "blocked")).toBe(false);
  });
});
