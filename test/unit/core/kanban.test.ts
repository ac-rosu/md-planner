import { describe, expect, it } from "vitest";
import { schedulePlan } from "../../../src/core/scheduler";
import {
  buildKanbanModel,
  priorityForDrop,
  type KanbanOptions,
} from "../../../src/core/views/kanban";
import { loadSample, TODAY } from "../helpers";

const plan = loadSample().plan;
const schedule = schedulePlan(plan, { today: TODAY });
const base: KanbanOptions = {
  board: "tasks",
  swimlane: "none",
  showCancelled: false,
  cardMode: "tasks",
};
const keys = (m: ReturnType<typeof buildKanbanModel>, status: string, lane = 0) =>
  (m.lanes[lane].cards[status as "todo"] ?? []).map((c) => c.key);

describe("kanban model", () => {
  it("has a column per status, cancelled hidden unless asked", () => {
    const m = buildKanbanModel(plan, schedule, base);
    expect(m.columns.map((c) => c.title)).toEqual(["To do", "Doing", "Review", "Blocked", "Done"]);
    expect(
      buildKanbanModel(plan, schedule, { ...base, showCancelled: true }).columns.at(-1)?.title
    ).toBe("Cancelled");
    expect(keys(m, "doing")).toEqual(["T006", "T102"]);
    expect(keys(m, "review")).toEqual(["T005"]);
    expect(keys(m, "blocked")).toEqual(["T106"]);
    expect(m.total).toBe(m.columns.reduce((n, c) => n + c.count, 0));
  });

  it("sorts by priority, then file order, and fills card details", () => {
    const m = buildKanbanModel(plan, schedule, base);
    const todo = keys(m, "todo");
    expect(todo.indexOf("T105")).toBeLessThan(todo.indexOf("T011"));
    const t102 = m.lanes[0].cards.doing!.find((c) => c.key === "T102")!;
    expect(t102).toMatchObject({
      title: "Order state machine",
      ownerInitials: "SA",
      hours: "7/12h",
      subtasks: { done: 1, total: 2 },
      milestone: "M2",
    });
    const t106 = m.lanes[0].cards.blocked![0];
    expect(t106.blocked).toBe("waiting for the payment provider API keys");
    const t407 = m.lanes[0].cards.todo!.find((c) => c.key === "T407")!;
    expect(t407).toMatchObject({ late: true, due: "2027-03-26" });
  });

  it("shows every subtask in leaves mode with its parent", () => {
    const m = buildKanbanModel(plan, schedule, { ...base, cardMode: "leaves" });
    const t104 = m.lanes[0].cards.todo!.find((c) => c.key === "T104")!;
    expect(t104.parentTitle).toBe("Order state machine");
    expect(keys(m, "doing")).toEqual(["T008"]);
  });

  it("builds swimlanes by owner and milestone", () => {
    const byOwner = buildKanbanModel(plan, schedule, { ...base, swimlane: "owner" });
    expect(byOwner.lanes.map((l) => l.key)).toEqual([
      "alex",
      "sam",
      "priya",
      "jordan",
      "maria",
      "unassigned",
    ]);
    const byMilestone = buildKanbanModel(plan, schedule, { ...base, swimlane: "milestone" });
    expect(byMilestone.lanes.map((l) => l.key)).toEqual(["M1", "M2", "M3", "M4", "M5"]);
  });

  it("filters exactly like the sidebar and counts hidden cards", () => {
    const m = buildKanbanModel(plan, schedule, { ...base, filter: { owner: ["priya"] } });
    const all = m.lanes.flatMap((l) => Object.values(l.cards).flat());
    expect(all.every((c) => c!.owner?.toLowerCase() === "priya")).toBe(true);
    expect(m.hidden).toBe(m.total - all.length);
    const tag = buildKanbanModel(plan, schedule, {
      ...base,
      filter: { tag: ["billing"], text: "in" },
    });
    expect(tag.lanes.flatMap((l) => Object.values(l.cards).flat()).map((c) => c!.key)).toEqual([
      "T113",
      "T114",
      "T207",
    ]);
  });

  it("marks columns over their WIP limit", () => {
    const m = buildKanbanModel(plan, schedule, { ...base, wipLimits: { doing: 1, review: 2 } });
    expect(m.columns.find((c) => c.status === "doing")).toMatchObject({
      count: 2,
      wip: 1,
      over: true,
    });
    expect(m.columns.find((c) => c.status === "review")).toMatchObject({
      count: 1,
      wip: 2,
      over: false,
    });
  });

  it("builds the punch board sorted by severity with severity lanes", () => {
    const m = buildKanbanModel(plan, schedule, { ...base, board: "punch" });
    expect(keys(m, "todo")).toEqual(["P007", "P002"]);
    expect(keys(m, "doing")).toEqual(["P003"]);
    expect(m.lanes[0].cards.doing![0]).toMatchObject({
      sev: "A",
      from: "UAT-01/TC-01",
      due: "2026-10-23",
    });
    const lanes = buildKanbanModel(plan, schedule, {
      ...base,
      board: "punch",
      swimlane: "severity",
    });
    expect(lanes.lanes.map((l) => l.key)).toEqual(["A", "B", "C"]);
  });

  it("derives the priority of a card from its drop position", () => {
    expect(priorityForDrop("med", "high", "high")).toBe("high");
    expect(priorityForDrop("med", undefined, "low")).toBe("low");
    expect(priorityForDrop("high", "high", "med")).toBeUndefined();
    expect(priorityForDrop("low", undefined, undefined)).toBeUndefined();
  });
});
