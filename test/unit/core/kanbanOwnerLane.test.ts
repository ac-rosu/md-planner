import { describe, expect, it } from "vitest";
import { UNASSIGNED } from "../../../src/core/calendar";
import { buildKanbanModel, ownerLane } from "../../../src/core/views/kanban";
import { md, planFrom, task } from "../helpers";

const TEAM = md("# Team", "", "## Sam", "", "capacity: 40h/week", "", "## Priya", "");
const plan = planFrom({
  "team.md": TEAM,
  "milestones/M1.md": md(
    "# M1",
    "",
    "- [ ] Release checklist @owner:Sam ^T1",
    "  - [ ] Notes ^T2",
    "  - [ ] Slides @owner:priya ^T3",
    "- [ ] Nobody's ^T4",
    "- [ ] Pool @owner:unassigned ^T5"
  ),
});

describe("Kanban owner lanes", () => {
  it("puts a subtask without @owner in the lane of the owner it has from its parent", () => {
    expect(["T1", "T2", "T3", "T4", "T5"].map((id) => ownerLane(task(plan, id)))).toEqual([
      "sam",
      "sam",
      "priya",
      UNASSIGNED,
      UNASSIGNED,
    ]);
  });

  it("shows each card in the lane ownerLane names, which a drop compares with", () => {
    const m = buildKanbanModel(plan, undefined, {
      board: "tasks",
      swimlane: "owner",
      showCancelled: false,
      cardMode: "leaves",
    });
    const lanes = Object.fromEntries(
      m.lanes.map((l) => [l.key, Object.values(l.cards).flatMap((c) => c?.map((x) => x.id))])
    );
    expect(lanes).toEqual({ sam: ["T2"], priya: ["T3"], [UNASSIGNED]: ["T4", "T5"] });
  });
});
