// Open AI proposals each get their own new ids, and a proposal whose ids were taken since it was
// made is refused at Accept (the copies would be renumbered on save, but not the @deps on them).
import { describe, expect, it } from "vitest";
import { breakDownProposal, planFromTextProposal, takenIds } from "../../../src/ai/commands";
import { loadSample, md, planFrom, task } from "../helpers";

const plan = loadSample().plan;

const twoSteps = {
  rationale: "",
  subtasks: [
    { ref: "N1", title: "First", estimate: "1d", tags: [], owner: "", dependsOn: [], notes: "" },
    {
      ref: "N2",
      title: "Second",
      estimate: "1d",
      tags: [],
      owner: "",
      dependsOn: ["N1"],
      notes: "",
    },
  ],
};

describe("ids of open proposals", () => {
  it("lists the ids a proposal adds", () => {
    const p = breakDownProposal(plan, task(plan, "T107"), twoSteps);
    expect(p.ids).toEqual(["T408", "T409"]);
  });

  it("reserves them, so a second open proposal gets other ids", () => {
    const first = breakDownProposal(plan, task(plan, "T012"), twoSteps);
    const second = breakDownProposal(plan, task(plan, "T107"), twoSteps, new Set(first.ids));
    expect(first.ids).toEqual(["T408", "T409"]);
    expect(second.ids).toEqual(["T410", "T411"]);
    expect(second.notes).toContain("+ T411 Second @est:1d @dep:T410");
    const third = planFromTextProposal(
      plan,
      plan.milestoneById("M3")!,
      {
        section: "More",
        tasks: twoSteps.subtasks.map((s) => ({ ...s, parent: "" })),
      },
      new Set([...first.ids!, ...second.ids!])
    );
    expect(third.ids).toEqual(["T412", "T413"]);
  });

  it("names the proposed ids that the plan uses by now", () => {
    const p = breakDownProposal(plan, task(plan, "T107"), twoSteps);
    expect(takenIds(plan, p.ids!)).toEqual([]);
    const later = planFrom({
      "team.md": md("# Team"),
      "milestones/M1.md": md("# M1", "", "- [ ] Typed meanwhile ^T409"),
    });
    expect(takenIds(later, p.ids!)).toEqual(["T409"]);
    expect(takenIds(later, [])).toEqual([]);
  });
});
