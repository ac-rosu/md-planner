import { describe, expect, it } from "vitest";
import {
  addPerson,
  addRepeatedProperty,
  addTask,
  captureInbox,
  changeMilestone,
  changePerson,
  changeProject,
  changeTask,
  createMilestone,
  deleteMilestoneLinks,
  deleteTaskWithLinks,
  dependentsOf,
  formatMilestoneFile,
  listItems,
  milestoneDependents,
  milestoneFileName,
  milestoneHeading,
  newTaskFrom,
  nextMilestoneId,
  removePerson,
  removeRepeatedProperty,
  renamePerson,
  setHeadingText,
  setMilestoneDescription,
  setOrRemoveProperty,
  splitMilestoneTitle,
} from "../../../src/core/writer/entities";
import { apply, md, planFrom, task, TODAY } from "../helpers";

const M1 = md(
  "# M1 – Discovery",
  "",
  "id: M1",
  "target: 2026-11-30 # customer date",
  "status: active",
  "",
  "## Preparation",
  "",
  "- [ ] Kick-off @est:4h @owner:alex ^T001",
  "- [ ] Review URS @est:1d @dep:T001 ^T002",
  "  - [ ] Read P&IDs @est:4h ^T003",
  "  - [ ] Read URS @est:4h ^T004",
  "",
  "## Specification",
  "",
  "- [ ] Integration inventory (APIs, SSO, CRM) @est:2d @dep:T002,T004+1d,T001 #integration ^T005"
);
const M2 = md(
  "# M2 – Backend",
  "",
  "id: M2",
  "depends: M1",
  "",
  "- [ ] FBs @est:1w @dep:T003 ^T010"
);
const TEAM = md(
  "# Team",
  "",
  "## Alex",
  "",
  "id: alex",
  "capacity: 32h/week",
  "off: 2026-12-22..2027-01-02",
  "",
  "## Sam Smith",
  "",
  "capacity: 40h/week"
);
const files = () => ({
  "project.md": md("# P", "", "start: 2026-10-01", "holidays: 2026-12-25, 2026-12-26"),
  "team.md": TEAM,
  "milestones/M1-discovery-design.md": M1,
  "milestones/M2-backend.md": M2,
});

describe("entity writers", () => {
  it("renames a heading and keeps its level", () => {
    const plan = planFrom(files());
    const f = plan.file("milestones/M1-discovery-design.md")!;
    expect(apply(f, setHeadingText(f.lines, 0, "M1 – Discovery design"))).toContain(
      "# M1 – Discovery design\n"
    );
  });

  it("applies form changes to a task line in one edit", () => {
    const plan = planFrom(files());
    const t = task(plan, "T002");
    const f = plan.file(t.file)!;
    const edits = changeTask(
      f.lines,
      t,
      {
        title: "Review support tickets and analytics",
        status: "doing",
        attrs: { owner: "sam", est: "12h", due: "2026-11-20", dep: undefined },
        addTags: ["review"],
      },
      TODAY
    );
    expect(edits).toHaveLength(1);
    expect(apply(f, edits)).toContain(
      "- [/] Review support tickets and analytics @est:12h @owner:sam @due:2026-11-20 @started:2026-10-14 #review ^T002\n"
    );
  });

  it("writes a blocked reason with the status and removes empty values", () => {
    const plan = planFrom(files());
    const t = task(plan, "T001");
    const f = plan.file(t.file)!;
    const out = apply(
      f,
      changeTask(
        f.lines,
        t,
        { status: "blocked", blockedReason: "no access", attrs: { est: "" } },
        TODAY
      )
    );
    expect(out).toContain('- [!] Kick-off @owner:alex @blocked:"no access" ^T001\n');
  });

  it("builds new tasks with attributes in the canonical order", () => {
    expect(
      newTaskFrom(
        {
          title: "Test",
          attrs: { due: "2026-11-01", owner: "sam", est: "4h", prio: "med" },
          tags: ["#a"],
        },
        "T9"
      )
    ).toEqual({
      title: "Test",
      status: undefined,
      attrs: [
        ["est", "4h"],
        ["owner", "sam"],
        ["due", "2026-11-01"],
      ],
      tags: ["a"],
      notes: undefined,
      id: "T9",
    });
  });

  it("adds a task to a section and as a subtask", () => {
    const plan = planFrom(files());
    const f = plan.file("milestones/M1-discovery-design.md")!;
    const inSection = apply(
      f,
      addTask(
        f,
        { kind: "section", title: "Specification" },
        { title: "Alarm list", attrs: { est: "1d" } },
        "T011"
      ).edits
    );
    expect(inSection).toContain("#integration ^T005\n- [ ] Alarm list @est:1d ^T011\n");
    const child = apply(
      f,
      addTask(
        f,
        { kind: "child", task: task(plan, "T002") },
        { title: "Check tags", attrs: { owner: "sam" } },
        "T012"
      ).edits
    );
    expect(child).toContain(
      "  - [ ] Read URS @est:4h ^T004\n  - [ ] Check tags @owner:sam ^T012\n"
    );
  });

  it("deletes a task block and removes the dependencies on it and its subtasks", () => {
    const plan = planFrom(files());
    const t = task(plan, "T002");
    expect(dependentsOf(plan, t).map((x) => x.id)).toEqual(["T005", "T010"]);
    const edits = deleteTaskWithLinks(plan, t);
    const m1 = edits.find((e) => e.path === "milestones/M1-discovery-design.md")!;
    const out1 = apply(plan.file("milestones/M1-discovery-design.md")!, m1.edits);
    expect(out1).not.toContain("Review URS");
    expect(out1).not.toContain("Read P&IDs");
    expect(out1).toContain(
      "- [ ] Integration inventory (APIs, SSO, CRM) @est:2d @dep:T001 #integration ^T005\n"
    );
    const m2 = edits.find((e) => e.path === "milestones/M2-backend.md")!;
    expect(apply(plan.file("milestones/M2-backend.md")!, m2.edits)).toContain(
      "- [ ] FBs @est:1w ^T010\n"
    );
  });

  it("creates milestone files with the next id", () => {
    const plan = planFrom(files());
    expect(nextMilestoneId(plan)).toBe("M3");
    expect(milestoneFileName("M3", "Frontend & Design – Phase 1")).toBe(
      "milestones/M3-frontend-design-phase-1.md"
    );
    expect(
      formatMilestoneFile({
        id: "M3",
        name: "Frontend",
        target: "2027-01-22",
        depends: ["M1", "M2"],
      })
    ).toBe("# M3 – Frontend\n\nid: M3\ntarget: 2027-01-22\nstatus: planned\ndepends: M1, M2\n");
    expect(createMilestone(plan, { id: "M3", name: "Frontend" }).path).toBe(
      "milestones/M3-frontend.md"
    );
    expect(() => createMilestone(plan, { id: "M2", name: "Other" })).toThrow(/already in use/);
  });

  it("splits and rebuilds milestone headings", () => {
    expect(splitMilestoneTitle("M2", "M2 – Backend")).toEqual({
      prefix: "M2 – ",
      name: "Backend",
    });
    expect(splitMilestoneTitle("M2", "Backend services")).toEqual({
      prefix: "",
      name: "Backend services",
    });
    expect(milestoneHeading("M2", " Software  ", "M2 – ")).toBe("M2 – Software");
  });

  it("sets, removes and repeats properties", () => {
    const plan = planFrom(files());
    const m = plan.milestoneById("M1")!;
    const f = plan.file(m.file)!;
    expect(apply(f, setOrRemoveProperty(f.lines, m.props, "target", "2026-12-04"))).toContain(
      "target: 2026-12-04 # customer date\n"
    );
    expect(apply(f, setOrRemoveProperty(f.lines, m.props, "target", undefined))).not.toContain(
      "target:"
    );
    expect(apply(f, setOrRemoveProperty(f.lines, m.props, "depends", "M0"))).toContain(
      "status: active\ndepends: M0\n"
    );
    const alex = plan.personById("alex")!;
    const team = plan.file("team.md")!;
    expect(
      apply(team, [addRepeatedProperty(team.lines, alex.props, "off", "2027-02-09")])
    ).toContain("off: 2026-12-22..2027-01-02\noff: 2027-02-09\n");
    expect(
      apply(team, removeRepeatedProperty(team.lines, alex.props, "off", "2026-12-22..2027-01-02"))
    ).not.toContain("off:");
    expect(listItems(" 2026-12-25,, 2026-12-26 ")).toEqual(["2026-12-25", "2026-12-26"]);
  });

  it("adds people to team.md, or creates it", () => {
    const plan = planFrom(files());
    const add = addPerson(plan, {
      name: "Priya Patel",
      role: "Frontend",
      capacity: "24h/week",
      skills: ["frontend", "notifications"],
      color: "purple",
    });
    expect(apply(plan.file("team.md")!, add.edits![0].edits)).toContain(
      "capacity: 40h/week\n\n## Priya Patel\n\nid: priya-patel\nrole: Frontend\ncapacity: 24h/week\nskills: frontend, notifications\ncolor: purple\n"
    );
    expect(() => addPerson(plan, { name: "Alex" })).toThrow(/already in use/);
    const empty = planFrom({ "project.md": md("# P") });
    expect(
      addPerson(empty, { name: "Maria", capacity: "4h/day", workweek: "mon-thu" }).create
    ).toEqual({
      path: "team.md",
      text: "# Team\n\n## Maria\n\nid: maria\ncapacity: 4h/day\nworkweek: mon-thu\n",
    });
  });

  it("keeps the id when renaming a person whose id came from the name", () => {
    const plan = planFrom(files());
    const team = plan.file("team.md")!;
    const sam = plan.personById("sam-smith")!;
    expect(apply(team, renamePerson(team.lines, sam, "Sam de Smith"))).toContain(
      "## Sam de Smith\n\nid: sam-smith\ncapacity: 40h/week\n"
    );
    const alex = plan.personById("alex")!;
    expect(apply(team, renamePerson(team.lines, alex, "Alex R."))).toContain(
      "## Alex R.\n\nid: alex\ncapacity: 32h/week\n"
    );
  });

  it("removes a person and reassigns or unassigns their tasks", () => {
    const plan = planFrom(files());
    const alex = plan.personById("alex")!;
    const edits = removePerson(plan, alex, "sam-smith");
    const team = apply(plan.file("team.md")!, edits.find((e) => e.path === "team.md")!.edits);
    expect(team).toBe("# Team\n\n## Sam Smith\n\ncapacity: 40h/week\n");
    const m1 = apply(
      plan.file("milestones/M1-discovery-design.md")!,
      edits.find((e) => e.path === "milestones/M1-discovery-design.md")!.edits
    );
    expect(m1).toContain("- [ ] Kick-off @est:4h @owner:sam-smith ^T001\n");
    const last = plan.personById("sam-smith")!;
    const unassigned = removePerson(plan, last);
    expect(apply(plan.file("team.md")!, unassigned[0].edits)).toBe(
      "# Team\n\n## Alex\n\nid: alex\ncapacity: 32h/week\noff: 2026-12-22..2027-01-02\n"
    );
  });

  it("removes only the person's section, not the text after the team", () => {
    const team = md(
      "# Team",
      "",
      "## Alex",
      "",
      "id: alex",
      "",
      "### Certificates",
      "",
      "```md",
      "# not a heading",
      "```",
      "",
      "## Sam",
      "",
      "role: Backend",
      "",
      "# Notes",
      "",
      "Free text about the team."
    );
    const plan = planFrom({ "team.md": team });
    const remove = (id: string) =>
      apply(plan.file("team.md")!, removePerson(plan, plan.personById(id)!)[0].edits);
    expect(remove("sam")).toBe(team.replace("## Sam\n\nrole: Backend\n\n", ""));
    expect(remove("alex")).toBe(team.replace(/## Alex[^]*?(?=## Sam)/, ""));
  });

  it("writes overtime and extra working days", () => {
    const plan = planFrom(files());
    const add = addPerson(plan, {
      name: "Chris",
      overtime: ["2026-11-02..2026-11-13 +8h/week"],
      workday: ["2026-11-07 6h"],
    });
    expect(apply(plan.file("team.md")!, add.edits![0].edits)).toContain(
      "## Chris\n\nid: chris\novertime: 2026-11-02..2026-11-13 +8h/week\nworkday: 2026-11-07 6h\n"
    );
    const team = plan.file("team.md")!;
    const alex = plan.personById("alex")!;
    expect(
      apply(
        team,
        changePerson(team.lines, alex, {
          overtime: ["2026-11-02..2026-11-06 +2h/day"],
          workday: ["2026-11-07", "2026-11-14"],
        })
      )
    ).toContain(
      "off: 2026-12-22..2027-01-02\novertime: 2026-11-02..2026-11-06 +2h/day\nworkday: 2026-11-07\nworkday: 2026-11-14\n"
    );
  });

  it("edits a person's name, properties and lists in one change", () => {
    const plan = planFrom(files());
    const team = plan.file("team.md")!;
    const sam = plan.personById("sam-smith")!;
    const out = apply(
      team,
      changePerson(team.lines, sam, {
        name: "Sam de Smith",
        role: "Backend developer",
        capacity: "32h/week",
        skills: ["backend", "frontend"],
        off: ["2026-11-17..2026-11-21", "2027-02-09"],
        capacityFrom: ["2027-01-01 40h/week"],
      })
    );
    expect(out).toContain(
      "## Sam de Smith\n\nid: sam-smith\ncapacity: 32h/week\nrole: Backend developer\nskills: backend, frontend\n" +
        "off: 2026-11-17..2026-11-21\noff: 2027-02-09\ncapacityFrom: 2027-01-01 40h/week\n"
    );
    const alex = plan.personById("alex")!;
    const removed = apply(
      team,
      changePerson(team.lines, alex, { capacity: "", off: [], color: "blue" })
    );
    expect(removed).toContain("## Alex\n\nid: alex\ncolor: blue\n\n## Sam Smith");
  });

  it("edits a milestone's name and properties", () => {
    const plan = planFrom(files());
    const m = plan.milestoneById("M1")!;
    const f = plan.file(m.file)!;
    const out = apply(
      f,
      changeMilestone(f.lines, m, {
        name: "Discovery and design",
        target: "2026-12-04",
        status: "done",
        depends: ["M0"],
      })
    );
    expect(
      out.startsWith(
        "# M1 – Discovery and design\n\nid: M1\ntarget: 2026-12-04 # customer date\nstatus: done\ndepends: M0\n"
      )
    ).toBe(true);
    expect(apply(f, changeMilestone(f.lines, m, { target: "", depends: [] }))).toContain(
      "id: M1\nstatus: active\n\n## Preparation"
    );
  });

  it("removes every dependency on a milestone and its tasks before it is deleted", () => {
    const plan = planFrom({
      "milestones/M1-a.md": md("# M1 – A", "", "id: M1", "", "- [ ] One ^T1", "- [ ] Two ^T2"),
      "milestones/M2-b.md": md(
        "# M2 – B",
        "",
        "id: M2",
        "depends: M1, M0 # order",
        "",
        "- [ ] Uses one @dep:T1+2d,T3 ^T3x",
        "- [ ] Uses both @dep:T1,T2 ^T4",
        "- [ ] Inside ^T3"
      ),
    });
    const m1 = plan.milestoneById("M1")!;
    const dependents = milestoneDependents(plan, m1);
    expect(dependents.tasks.map((t) => t.id)).toEqual(["T3x", "T4"]);
    expect(dependents.milestones.map((m) => m.id)).toEqual(["M2"]);
    const edits = deleteMilestoneLinks(plan, m1);
    expect(edits.every((e) => e.path === "milestones/M2-b.md")).toBe(true);
    expect(
      apply(
        plan.file("milestones/M2-b.md")!,
        edits.flatMap((e) => e.edits)
      )
    ).toBe(
      md(
        "# M2 – B",
        "",
        "id: M2",
        "depends: M0 # order",
        "",
        "- [ ] Uses one @dep:T3 ^T3x",
        "- [ ] Uses both ^T4",
        "- [ ] Inside ^T3"
      )
    );
  });

  it("sets, changes and removes a milestone's description", () => {
    const set = (text: string, description: string) => {
      const plan = planFrom({ "milestones/M1-a.md": text });
      const m = plan.milestones[0];
      return apply(
        plan.file(m.file)!,
        setMilestoneDescription(plan.file(m.file)!.lines, m, description)
      );
    };
    const plain = md("# M1 – A", "", "id: M1", "", "- [ ] Task ^T1");
    expect(set(plain, "Scope.\n\nMore.")).toBe(
      md("# M1 – A", "", "id: M1", "", "Scope.", "", "More.", "", "- [ ] Task ^T1")
    );
    expect(set("# M1 – A\nid: M1\n## S\n", "Scope.")).toBe("# M1 – A\nid: M1\n\nScope.\n\n## S\n");
    expect(set("# M1 – A\n\nid: M1", "Scope.")).toBe("# M1 – A\n\nid: M1\n\nScope.");
    const described = md(
      "# M1 – A",
      "",
      "id: M1",
      "",
      "Old scope,",
      "two lines.",
      "",
      "## S",
      "",
      "Free text."
    );
    expect(set(described, "Old scope,\nthree lines.\n")).toBe(
      md("# M1 – A", "", "id: M1", "", "Old scope,", "three lines.", "", "## S", "", "Free text.")
    );
    expect(set(described, "")).toBe(md("# M1 – A", "", "id: M1", "", "## S", "", "Free text."));
    expect(set(md("# M1 – A", "", "id: M1", "", "Old."), "")).toBe(md("# M1 – A", "", "id: M1"));
    expect(set(plain, "")).toBe(plain);
  });

  it("edits the project heading, properties and holidays", () => {
    const plan = planFrom(files());
    const f = plan.file("project.md")!;
    const out = apply(
      f,
      changeProject(f.lines, plan.project, {
        name: "Line 3",
        code: "P-1",
        holidays: ["2026-12-25", "2026-12-28..2026-12-31"],
        hoursPerDay: "7.5",
      })
    );
    expect(out).toBe(
      "# Line 3\n\nstart: 2026-10-01\nholidays: 2026-12-25, 2026-12-28..2026-12-31\ncode: P-1\nhoursPerDay: 7.5\n"
    );
  });

  it("captures inbox items, or creates inbox.md", () => {
    const plan = planFrom({ ...files(), "inbox.md": md("# Inbox", "", "- [ ] Old idea") });
    const c = captureInbox(plan, "Ask for datasheets #customer");
    expect(apply(plan.file("inbox.md")!, c.edits![0].edits)).toBe(
      "# Inbox\n\n- [ ] Old idea\n- [ ] Ask for datasheets #customer\n"
    );
    expect(captureInbox(planFrom(files()), "First").create).toEqual({
      path: "inbox.md",
      text: "# Inbox\n\n- [ ] First\n",
    });
  });
});
