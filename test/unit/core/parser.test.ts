import { describe, expect, it } from "vitest";
import { type Task } from "../../../src/core/model";
import { classifyPlanPath, parseFileAs } from "../../../src/core/parser/files";
import { matchProperty } from "../../../src/core/parser/properties";
import { matchCheckbox, tokenize } from "../../../src/core/parser/taskLine";
import { estimateHours, remainingHours, progressOf } from "../../../src/core/rollup";
import { loadSample, md, planFrom, task } from "../helpers";

describe("task line tokenizer", () => {
  it("recognises the six statuses and list markers", () => {
    for (const [line, ch] of [
      ["- [ ] a", " "],
      ["* [/] a", "/"],
      ["+ [?] a", "?"],
      ["1. [!] a", "!"],
      ["2) [x] a", "x"],
      ["- [X] a", "X"],
      ["- [-] a", "-"],
      ["- [x]", "x"],
    ] as const) {
      expect(matchCheckbox(line)?.statusChar).toBe(ch);
    }
    expect(matchCheckbox("- [] a")).toBeUndefined();
    expect(matchCheckbox("- [x]a")).toBeUndefined();
    expect(matchCheckbox("-[x] a")).toBeUndefined();
    expect(matchCheckbox("text - [x] a")).toBeUndefined();
  });

  it("splits attributes, quoted values, tags and the trailing id", () => {
    const line =
      '- [!] Payment form @est:6h @owner:priya #frontend @blocked:"waiting for the payment provider API keys" ^T106';
    const cb = matchCheckbox(line)!;
    const kinds = cb.tokens.filter((t) => t.kind !== "space").map((t) => t.kind);
    expect(kinds).toEqual(["text", "text", "attr", "attr", "tag", "attr", "id"]);
    const blocked = cb.tokens.find((t) => t.kind === "attr" && t.key === "blocked");
    expect(blocked).toMatchObject({
      value: "waiting for the payment provider API keys",
      quoted: true,
    });
    expect(cb.tokens.at(-1)).toMatchObject({ kind: "id", id: "T106" });
  });

  it("reconstructs every line exactly from its tokens", () => {
    const lines = [
      "- [ ]   spaced   out   @est:4h   #t   ^T1   ",
      '- [x] "quoted" title with @k:"a \\"b\\" c" and email a@b.c ^T2',
      "\t- [/] tab @x:y#z #a/b #c-d #1 ^not-last more",
      "- [ ] @est:4h only attributes",
      "- [ ] emoji 🍺 @owner:jörg #füller",
      '- [ ] unterminated @note:"oops here ^T3',
    ];
    for (const line of lines) {
      const cb = matchCheckbox(line)!;
      const rebuilt =
        line.slice(0, cb.contentStart) + cb.tokens.map((t) => line.slice(t.start, t.end)).join("");
      expect(rebuilt).toBe(line);
    }
  });

  it("only treats the last token as id and @key without colon as text", () => {
    const tokens = tokenize("a ^T1 b @plain c@d.e ^T2", 0).filter((t) => t.kind !== "space");
    expect(tokens.map((t) => t.kind)).toEqual(["text", "text", "text", "text", "text", "id"]);
  });
});

describe("property lines", () => {
  it("separates value and comment on space-hash-space", () => {
    expect(matchProperty("capacity: 32h/week # rest goes to lead work", 0)).toMatchObject({
      key: "capacity",
      value: "32h/week",
      comment: "rest goes to lead work",
    });
    expect(matchProperty("color: #ff0000", 0)).toMatchObject({
      value: "#ff0000",
      comment: undefined,
    });
    expect(matchProperty("depends:", 0)).toMatchObject({ value: "" });
    expect(matchProperty("empty: # c", 0)).toMatchObject({ value: "", comment: "c" });
    expect(matchProperty("https://example.com", 0)).toBeUndefined();
    expect(matchProperty("Free text: with a colon", 0)).toBeUndefined();
  });
});

describe("file classification", () => {
  it("maps plan paths to file kinds and skips generated folders", () => {
    expect(classifyPlanPath("project.md")).toBe("project");
    expect(classifyPlanPath("team.md")).toBe("team");
    expect(classifyPlanPath("inbox.md")).toBe("inbox");
    expect(classifyPlanPath("punchlist.md")).toBe("punch");
    expect(classifyPlanPath("milestones/M2-plc.md")).toBe("milestone");
    expect(classifyPlanPath("milestones/sub/M9.md")).toBe("milestone");
    expect(classifyPlanPath("tests/UAT-01.md")).toBe("test");
    expect(classifyPlanPath("reports/x.md")).toBeUndefined();
    expect(classifyPlanPath("README.md")).toBeUndefined();
    expect(classifyPlanPath("milestones/M1.txt")).toBeUndefined();
  });
});

describe("sample project", () => {
  const plan = loadSample().plan;

  it("reads project settings, holidays and phases", () => {
    const p = plan.project;
    expect(p.name).toBe("Customer Portal 2.0");
    expect(p.code).toBe("P-2026-014");
    expect(p.start).toBe("2026-10-01");
    expect(p.end).toBe("2027-03-31");
    expect(p.hoursPerDay).toBe(8);
    expect([...p.workweek].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(p.holidays).toHaveLength(4);
    expect(p.template).toBe("software");
    expect(p.phases.map((ph) => [ph.name, ph.milestone])).toEqual([
      ["Discovery & design", "M1"],
      ["Backend", "M2"],
      ["Frontend", "M3"],
      ["Acceptance test", "M4"],
      ["Launch", "M5"],
    ]);
  });

  it("reads the team with ids, capacity, time off and capacity changes", () => {
    expect(plan.people.map((p) => p.id)).toEqual(["alex", "sam", "priya", "jordan", "maria"]);
    const alex = plan.personById("alex")!;
    expect(alex).toMatchObject({
      role: "Project lead / backend",
      capacityHours: 32,
      capacityPer: "week",
      color: "blue",
    });
    expect(alex.skills).toEqual(["backend", "frontend", "architecture"]);
    expect(plan.personById("sam")!.off).toHaveLength(2);
    expect(plan.personById("jordan")!.capacityChanges).toHaveLength(1);
    expect(plan.personById("maria")).toMatchObject({ capacityHours: 4, capacityPer: "day" });
    expect(plan.personById("maria")!.workweek?.size).toBe(4);
  });

  it("reads milestones in id order with targets, status and dependencies", () => {
    expect(plan.milestones.map((m) => m.id)).toEqual(["M1", "M2", "M3", "M4", "M5"]);
    const m2 = plan.milestoneById("M2")!;
    expect(m2).toMatchObject({
      title: "M2 – Backend",
      target: "2026-12-15",
      status: "active",
    });
    expect(m2.depends).toEqual(["M1"]);
    expect(m2.sections.map((s) => s.title)).toEqual([
      "Common",
      "Checkout",
      "Accounts",
      "Billing",
      "Notes",
    ]);
    expect(m2.description[0]).toMatch(/^Services and APIs/);
  });

  it("parses tasks with all attribute kinds, nesting and notes", () => {
    const t102 = task(plan, "T102");
    expect(t102).toMatchObject({
      status: "doing",
      owner: "sam",
      title: "Order state machine",
      est: 12,
    });
    expect(t102.deps.map((d) => d.id)).toEqual(["T101"]);
    expect(t102.tags.map((t) => t.tag)).toEqual(["checkout"]);
    expect(t102.children.map((c) => c.id)).toEqual(["T103", "T104"]);
    expect(task(plan, "T104").notes.map((n) => n.text)).toEqual([
      "Notes indented under a task are its description.",
      "Use the CloudEvents format; order and payment events only for now.",
    ]);
    expect(task(plan, "T104").parent?.id).toBe("T102");
    expect(task(plan, "T105")).toMatchObject({
      est: 16,
      start: "2026-11-10",
      prio: "high",
      eq: "checkout/payment",
    });
    expect(task(plan, "T106")).toMatchObject({
      status: "blocked",
      blocked: "waiting for the payment provider API keys",
    });
    expect(task(plan, "T107").est).toBe(40);
    expect(task(plan, "T114").custom).toEqual({ security: "high" });
    expect(task(plan, "T115").status).toBe("cancelled");
    expect(task(plan, "T101").section).toBe("Checkout");
    expect(task(plan, "T101").milestoneId).toBe("M2");
  });

  it("rolls up estimates and remaining work", () => {
    const t006 = task(plan, "T006");
    expect(t006.est).toBeUndefined();
    expect(estimateHours(t006)).toBe(8 + 12 + 6 + 8);
    expect(remainingHours(task(plan, "T008"))).toBe(8); // 12h − 4h
    expect(remainingHours(t006)).toBe(8 + 6 + 8);
    expect(remainingHours(task(plan, "T001"))).toBe(0);
    expect(progressOf(task(plan, "T001"))).toBe(1);
    expect(progressOf(t006)).toBeCloseTo((8 + 4) / 34);
  });

  it("parses test plans, cases, steps and results", () => {
    const fat = plan.testById("UAT-01")!;
    expect(fat).toMatchObject({
      type: "acceptance",
      milestone: "M4",
      eq: "checkout",
      witness: "Customer key users",
    });
    expect(fat.cases.map((c) => [c.id, c.title])).toEqual([
      ["TC-01", "Successful purchase"],
      ["TC-02", "Declined card"],
    ]);
    expect(fat.cases[0].pre).toBe("Signed-in customer with an empty cart");
    const steps = fat.cases[0].steps;
    expect(steps.map((s) => s.result)).toEqual(["pass", "fail", undefined]);
    expect(steps[1]).toMatchObject({
      note: "confirmation after 3.5 s",
      punch: "P007",
      kind: "step",
    });
  });

  it("parses punch and inbox items", () => {
    expect(plan.punch.map((p) => p.id)).toEqual(["P001", "P002", "P003", "P004", "P007"]);
    expect(plan.punchById("P003")).toMatchObject({
      sev: "A",
      owner: "sam",
      from: "UAT-01/TC-01",
      kind: "punch",
    });
    expect(plan.inbox).toHaveLength(3);
    expect(plan.inbox[2]).toMatchObject({ owner: "jordan", kind: "inbox" });
  });

  it("has no errors or warnings in its own parse", () => {
    expect(plan.issues.filter((i) => i.severity !== "info" && i.severity !== "hint")).toEqual([]);
  });
});

describe("structure edge cases", () => {
  it("ignores checkboxes in code fences and attaches notes to the right task", () => {
    const plan = planFrom({
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [ ] Parent @est:2h ^T1",
        "  - [ ] Child @est:1h ^T2",
        "    child note",
        "  parent note",
        "  - [ ] Second child ^T3",
        "",
        "      ```",
        "      - [ ] fenced note line",
        "      ```",
        "",
        "```",
        "- [ ] not a task ^T9",
        "```",
        "Paragraph ends the list.",
        "  - [ ] indented after paragraph ^T4"
      ),
    });
    const ids = plan.tasks.map((t) => t.id);
    expect(ids).toEqual(["T1", "T2", "T3", "T4"]);
    expect(task(plan, "T2").notes.map((n) => n.text)).toEqual(["child note"]);
    expect(task(plan, "T1").notes.map((n) => n.text)).toEqual(["parent note"]);
    expect(task(plan, "T3").parent?.id).toBe("T1");
    expect(task(plan, "T3").notes.map((n) => n.text)).toEqual([
      "```",
      "- [ ] fenced note line",
      "```",
    ]);
    expect(task(plan, "T1").endLine).toBe(12);
    expect(task(plan, "T4").parent).toBeUndefined();
  });

  it("reports invalid values with precise ranges", () => {
    const plan = planFrom({
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "target: 2026-02-30",
        "",
        "- [ ] Bad @est:12 @start:tomorrow @prio:urgent @progress:150% ^T1"
      ),
    });
    const codes = plan.issues.map((i) => [i.code, i.range.start.line]);
    expect(codes).toEqual([
      ["invalid-date", 3],
      ["invalid-duration", 5],
      ["invalid-date", 5],
      ["invalid-value", 5],
      ["invalid-value", 5],
    ]);
    const est = plan.issues.find((i) => i.code === "invalid-duration")!;
    expect(est.range.start.character).toBe("- [ ] Bad @est:".length);
  });

  it("derives milestone ids from file names and person ids from headings", () => {
    const plan = planFrom({
      "milestones/M10-late.md": md("# Late", "", "- [ ] x ^T1"),
      "milestones/M2-early.md": md("# Early", "", "- [ ] y ^T2"),
      "team.md": md("# Team", "", "## Robin Lee", "", "capacity: 40h/week"),
    });
    expect(plan.milestones.map((m) => m.id)).toEqual(["M2", "M10"]);
    expect(plan.people[0].id).toBe("robin-lee");
    expect(plan.tasks.map((t: Task) => t.id)).toEqual(["T2", "T1"]);
  });

  it("parses a test plan run log section", () => {
    const file = parseFileAs(
      "tests/T.md",
      md(
        "# T",
        "",
        "id: T",
        "",
        "## TC-01 A",
        "",
        "- [x] s @result:pass",
        "",
        "## Run 2027-01-20",
        "",
        "tester: alex",
        "result: 1 pass"
      ),
      "test"
    );
    if (file.kind !== "test") throw new Error();
    expect(file.cases).toHaveLength(1);
    expect(file.runs).toMatchObject([{ date: "2027-01-20" }]);
    expect(file.runs[0].props.entries.map((e) => e.key)).toEqual(["tester", "result"]);
  });
});
