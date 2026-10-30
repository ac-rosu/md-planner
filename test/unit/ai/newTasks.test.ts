// New tasks from AI replies (Break down, Plan from text) are written so that they read back as
// proposed and add no errors: notes stay notes, titles stay titles, and dependencies that would
// add validation errors are dropped with a warning.
import { describe, expect, it } from "vitest";
import { breakDownProposal, planFromTextProposal } from "../../../src/ai/commands";
import { PlanIndex } from "../../../src/core/index";
import { newErrors, planErrors } from "../../../src/core/newErrors";
import { type Plan } from "../../../src/core/resolve";
import { applyEdits } from "../../../src/core/text";
import { validatePlan } from "../../../src/core/validate";
import { type FileEdit } from "../../../src/core/writer";
import { loadSample, md, planFrom, task } from "../helpers";

const M2 = "milestones/M2-backend.md";

interface Spec {
  ref: string;
  title: string;
  estimate?: string;
  owner?: string;
  dependsOn?: string[];
  notes?: string;
  parent?: string;
}

function reply(specs: Spec[], rationale = "") {
  return {
    rationale,
    subtasks: specs.map((s) => ({
      tags: [],
      estimate: "",
      owner: "",
      dependsOn: [],
      notes: "",
      ...s,
    })),
  };
}

/** The plan with the proposal's edits applied (every file parsed again). */
function after(plan: Plan, edits: FileEdit[]): { plan: Plan; texts: Map<string, string> } {
  const index = new PlanIndex();
  const texts = new Map<string, string>();
  for (const f of plan.files) {
    const own = edits.filter((e) => e.path === f.path).flatMap((e) => e.edits);
    const text = own.length ? applyEdits(f.lines.text, own) : f.lines.text;
    texts.set(f.path, text);
    index.update(f.path, text);
  }
  return { plan: index.plan, texts };
}

describe("AI notes with line breaks", () => {
  const plan = loadSample().plan;
  const t107 = task(plan, "T107");

  it("indents every line of a note under its subtask", () => {
    const p = breakDownProposal(
      plan,
      t107,
      reply([
        {
          ref: "N1",
          title: "Login step",
          estimate: "1d",
          notes: "Covers login.\nUse the session middleware.",
        },
        { ref: "N2", title: "Logout step", estimate: "1d" },
      ])
    );
    const { plan: next, texts } = after(plan, p.edits);
    expect(texts.get(M2)).toContain(
      [
        "  - [ ] Login step @est:1d ^T408",
        "        Covers login.",
        "        Use the session middleware.",
        "  - [ ] Logout step @est:1d ^T409",
      ].join("\n")
    );
    expect(task(next, "T409").parent?.id).toBe("T107");
    expect(task(next, "T408").notes.map((n) => n.text)).toEqual([
      "Covers login.",
      "Use the session middleware.",
    ]);
  });

  it("keeps a note's checkbox, heading and open code fence from changing the outline", () => {
    const p = breakDownProposal(
      plan,
      t107,
      reply([
        {
          ref: "N1",
          title: "Cart step",
          estimate: "1d",
          notes: "Covers the cart.\n- [ ] x\n## y\n```",
        },
        { ref: "N2", title: "Pay step", estimate: "1d" },
      ])
    );
    const { plan: next } = after(plan, p.edits);
    expect(next.tasks.length).toBe(plan.tasks.length + 2);
    const m2 = next.milestoneById("M2")!;
    expect(m2.sections.map((s) => s.title)).toEqual(
      plan.milestoneById("M2")!.sections.map((s) => s.title)
    );
    // The fence is closed: the tasks after the new ones are still read.
    expect(task(next, "T108").title).toBe("Checkout integration tests");
    expect(task(next, "T409").parent?.id).toBe("T107");
    expect(newErrors(planErrors(plan), planErrors(next))).toEqual([]);
  });

  it("writes the file's own line endings", () => {
    const crlf = (...lines: string[]) => lines.join("\r\n") + "\r\n";
    const p0 = planFrom({
      "team.md": md("# Team", "", "## Sam", "", "id: sam", "capacity: 40h/week"),
      "milestones/M1.md": crlf("# M1", "", "- [ ] Build API @est:3d ^T1", "- [ ] Docs ^T2"),
    });
    const p = breakDownProposal(
      p0,
      task(p0, "T1"),
      reply([
        { ref: "N1", title: "Endpoints", estimate: "1d", notes: "First line.\nSecond line." },
        { ref: "N2", title: "Tests", estimate: "2d" },
      ])
    );
    const { texts } = after(p0, p.edits);
    const text = texts.get("milestones/M1.md")!;
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(text).toContain("        First line.\r\n        Second line.\r\n");
  });
});

describe("AI titles with tags, attributes and ids", () => {
  const plan = loadSample().plan;
  const t107 = task(plan, "T107");

  it("keeps them in the title, in brackets, and warns", () => {
    const p = breakDownProposal(
      plan,
      t107,
      reply([
        {
          ref: "N1",
          title: "Design @owner:mallory @due:2026-11-03 @start:2027-05-01 #urgent ^T2",
          estimate: "1d",
        },
        { ref: "N2", title: "Build\n@due:2026-11-04", estimate: "1d" },
      ])
    );
    const { plan: next, texts } = after(plan, p.edits);
    expect(texts.get(M2)).toContain(
      "  - [ ] Design (@owner:mallory) (@due:2026-11-03) (@start:2027-05-01) (#urgent) (^T2) @est:1d ^T408\n" +
        "  - [ ] Build (@due:2026-11-04) @est:1d ^T409\n"
    );
    for (const id of ["T408", "T409"]) {
      const t = task(next, id);
      expect(t.due).toBeUndefined();
      expect(t.start).toBeUndefined();
      expect(t.owner).toBeUndefined();
      expect(t.tags).toEqual([]);
      expect(t.attrs.map((a) => a.key)).toEqual(["est"]);
    }
    expect(task(next, "T408").title).toBe(
      "Design (@owner:mallory) (@due:2026-11-03) (@start:2027-05-01) (#urgent) (^T2)"
    );
    expect(p.warnings).toEqual([
      '"Design @owner:mallory @due:2026-11-03 @start:2027-05-01 #urgent ^T2": @owner:mallory @due:2026-11-03 @start:2027-05-01 #urgent ^T2 would be read as attributes, tags or an id; kept in the title in brackets.',
      '"Build @due:2026-11-04": @due:2026-11-04 would be read as attributes, tags or an id; kept in the title in brackets.',
    ]);
  });

  it("does the same in Plan from text", () => {
    const m3 = plan.milestoneById("M3")!;
    const p = planFromTextProposal(plan, m3, {
      section: "Reporting",
      tasks: [
        {
          ref: "N1",
          title: "Report page #42",
          estimate: "2d",
          tags: [],
          owner: "",
          dependsOn: [],
          notes: "",
          parent: "",
        },
      ],
    });
    const { plan: next } = after(plan, p.edits);
    expect(task(next, "T408").title).toBe("Report page (#42)");
    expect(task(next, "T408").tags).toEqual([]);
    expect(p.warnings).toHaveLength(1);
  });
});

describe("AI dependencies that would add errors", () => {
  const plan = loadSample().plan;
  const t107 = task(plan, "T107");

  it("drops a dependency on the task's own parent, and cycles, with a warning", () => {
    const p = breakDownProposal(
      plan,
      t107,
      reply([
        { ref: "N1", title: "Cart step", estimate: "1d", dependsOn: ["T107", "T105"] },
        { ref: "N2", title: "Pay step", estimate: "1d", dependsOn: ["N1", "T108"] },
        { ref: "N3", title: "Confirm step", estimate: "1d", dependsOn: ["N4"] },
        { ref: "N4", title: "Receipt step", estimate: "1d", dependsOn: ["N3"] },
      ])
    );
    const { plan: next, texts } = after(plan, p.edits);
    expect(newErrors(planErrors(plan), planErrors(next))).toEqual([]);
    expect(texts.get(M2)).toContain(
      [
        "  - [ ] Cart step @est:1d @dep:T105 ^T408",
        "  - [ ] Pay step @est:1d @dep:T408 ^T409",
        "  - [ ] Confirm step @est:1d @dep:T411 ^T410",
        "  - [ ] Receipt step @est:1d ^T411",
      ].join("\n")
    );
    expect(p.warnings).toHaveLength(3);
    expect(p.warnings[0]).toMatch(
      /^"Cart step": dependency on T107 dropped, as it would add an error: .*Depends on its own parent T107/
    );
    expect(p.warnings[1]).toMatch(
      /^"Pay step": dependency on T108 dropped, as it would add an error: Circular dependency: /
    );
    expect(p.warnings[2]).toMatch(
      /^"Receipt step": dependency on T410 dropped, as it would add an error: Circular dependency: /
    );
  });

  it("drops cycles between new tasks in Plan from text", () => {
    const m3 = plan.milestoneById("M3")!;
    const spec = (ref: string, dependsOn: string[], parent = "") => ({
      ref,
      title: `Task ${ref}`,
      estimate: "1d",
      tags: [],
      owner: "",
      dependsOn,
      notes: "",
      parent,
    });
    const p = planFromTextProposal(plan, m3, {
      section: "Reporting",
      tasks: [spec("N1", ["N2"]), spec("N2", ["N1"]), spec("N3", ["N1"], "N1")],
    });
    const { plan: next } = after(plan, p.edits);
    expect(newErrors(planErrors(plan), planErrors(next))).toEqual([]);
    expect(task(next, "T408").deps.map((d) => d.id)).toEqual(["T409"]);
    expect(task(next, "T409").deps).toEqual([]);
    expect(task(next, "T410").deps).toEqual([]);
    expect(p.warnings).toHaveLength(2);
  });
});

describe("Break down and the parent's estimate", () => {
  const plan = loadSample().plan;
  const t107 = task(plan, "T107");

  it("sets the parent's @est to the subtasks' total when every subtask is estimated", () => {
    const p = breakDownProposal(
      plan,
      t107,
      reply([
        { ref: "N1", title: "Cart step", estimate: "12h" },
        { ref: "N2", title: "Pay step", estimate: "1.5d" },
      ])
    );
    const { plan: next, texts } = after(plan, p.edits);
    expect(texts.get(M2)).toContain(
      "- [ ] Checkout flow (cart, pay, confirm) @est:24h @owner:alex @dep:T102,T105 @eq:checkout #checkout ^T107\n"
    );
    expect(p.notes).toContain(
      "T107 Checkout flow (cart, pay, confirm): @est:1w → @est:24h, the subtasks' total"
    );
    const codes = validatePlan(next)
      .filter((i) => i.file === M2)
      .map((i) => i.code);
    expect(codes).not.toContain("parent-estimate-unscheduled");
    expect(codes).not.toContain("parent-estimate-exceeded");
  });

  it("keeps it as the budget when a subtask has no estimate, or when they add up to it", () => {
    const shared = breakDownProposal(
      plan,
      t107,
      reply([
        { ref: "N1", title: "Cart step", estimate: "12h" },
        { ref: "N2", title: "Pay step" },
      ])
    );
    expect(after(plan, shared.edits).texts.get(M2)).toContain(
      "- [ ] Checkout flow (cart, pay, confirm) @est:1w @owner:alex"
    );
    const exact = breakDownProposal(
      plan,
      t107,
      reply([
        { ref: "N1", title: "Cart step", estimate: "3d" },
        { ref: "N2", title: "Pay step", estimate: "16h" },
      ])
    );
    expect(after(plan, exact.edits).texts.get(M2)).toContain(
      "- [ ] Checkout flow (cart, pay, confirm) @est:1w @owner:alex"
    );
    expect(exact.notes.some((n) => n.includes("subtasks' total"))).toBe(false);
  });
});
