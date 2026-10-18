import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { dateSuggestions } from "../../../src/core/dates";
import {
  definitionOf,
  referenceAt,
  referencesOf,
  taskIdOccurrences,
} from "../../../src/core/navigation";
import { parseFileAs } from "../../../src/core/parser/files";
import {
  blockedTasks,
  deadlineOf,
  hoursLabel,
  milestoneStats,
  openTasksOf,
  overdueTasks,
} from "../../../src/core/queries";
import { defaultEndDate, fractionDate, instantiateTemplate } from "../../../src/core/templates";
import { loadSample, md, ROOT, task, walkFiles } from "../helpers";

const plan = loadSample().plan;

function at(line: string, col: number) {
  return referenceAt(line, 3, col);
}

describe("referenceAt", () => {
  const line =
    "- [/] Order state machine @est:12h @owner:sam @dep:T101,T105+2d @test:UAT-01 #checkout ^T102";

  it("finds ids, owners, dependency list items, tests and tags", () => {
    expect(at(line, line.indexOf("^T102") + 2)).toMatchObject({
      kind: "task",
      id: "T102",
      isDefinition: true,
    });
    expect(at(line, line.indexOf("sam") + 1)).toMatchObject({ kind: "person", id: "sam" });
    expect(at(line, line.indexOf("T101") + 1)).toMatchObject({
      kind: "task",
      id: "T101",
      isDefinition: false,
    });
    const t105 = at(line, line.indexOf("T105") + 2)!;
    expect(t105).toMatchObject({ kind: "task", id: "T105" });
    expect(t105.range.end.character - t105.range.start.character).toBe(4);
    expect(at(line, line.indexOf("UAT-01"))).toMatchObject({ kind: "test", id: "UAT-01" });
    expect(at(line, line.indexOf("#checkout") + 1)).toMatchObject({ kind: "tag", tag: "checkout" });
    expect(at(line, 8)).toBeUndefined();
  });

  it("splits @from into test plan and test case", () => {
    const l = "- [ ] p @from:UAT-01/TC-01 ^P001";
    expect(at(l, l.indexOf("UAT") + 1)).toMatchObject({ kind: "test", id: "UAT-01" });
    expect(at(l, l.indexOf("TC-01") + 1)).toMatchObject({
      kind: "testCase",
      testId: "UAT-01",
      caseId: "TC-01",
    });
    expect(at(l, l.indexOf("^P001") + 1)).toMatchObject({
      kind: "punch",
      id: "P001",
      isDefinition: true,
    });
  });

  it("finds milestone references in property lines", () => {
    expect(referenceAt("depends: M2, M3", 0, 13)).toMatchObject({ kind: "milestone", id: "M3" });
    expect(referenceAt("milestone: M4", 0, 12)).toMatchObject({ kind: "milestone", id: "M4" });
    expect(referenceAt("target: 2026-12-01", 0, 10)).toBeUndefined();
  });
});

describe("definitions and references in the sample", () => {
  it("resolves task, person, test case and milestone definitions", () => {
    const def = definitionOf(plan, {
      kind: "task",
      id: "T101",
      range: rangeZero(),
      isDefinition: false,
    })!;
    expect(def.file).toBe("milestones/M2-backend.md");
    expect(plan.file(def.file)!.lines.line(def.range.start.line)).toMatch(/\^T101$/);
    expect(definitionOf(plan, { kind: "person", id: "Sam", range: rangeZero() })).toMatchObject({
      file: "team.md",
    });
    expect(
      definitionOf(plan, {
        kind: "testCase",
        testId: "UAT-01",
        caseId: "tc-02",
        range: rangeZero(),
      })
    ).toMatchObject({
      file: "tests/UAT-01-checkout.md",
    });
    expect(definitionOf(plan, { kind: "milestone", id: "M3", range: rangeZero() })?.file).toBe(
      "milestones/M3-frontend.md"
    );
  });

  it("lists every occurrence of a task id", () => {
    const occ = taskIdOccurrences(plan, "T107");
    expect(occ.map((o) => [o.file, o.isDefinition])).toEqual([
      ["milestones/M2-backend.md", true],
      ["milestones/M2-backend.md", false],
      ["milestones/M4-acceptance-test.md", false],
    ]);
    for (const o of occ) {
      const text = plan.file(o.file)!.lines.line(o.range.start.line);
      expect(text.slice(o.range.start.character, o.range.end.character)).toBe("T107");
    }
  });

  it("finds references to people, punch items, tests and milestones", () => {
    expect(referencesOf(plan, { kind: "person", id: "maria", range: rangeZero() }).length).toBe(
      1 + 5
    );
    expect(
      referencesOf(plan, { kind: "punch", id: "P007", range: rangeZero(), isDefinition: false })
    ).toHaveLength(2);
    expect(referencesOf(plan, { kind: "test", id: "UAT-01", range: rangeZero() }).length).toBe(
      1 + 2 + 4
    );
    expect(referencesOf(plan, { kind: "milestone", id: "M1", range: rangeZero() })).toHaveLength(
      1 + 2
    );
    expect(
      referencesOf(plan, { kind: "tag", tag: "frontend", range: rangeZero() }).length
    ).toBeGreaterThan(5);
  });
});

function rangeZero() {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

describe("queries", () => {
  it("finds deadlines, overdue and blocked tasks", () => {
    expect(deadlineOf(plan, task(plan, "T111"))).toBe("2026-12-04");
    expect(deadlineOf(plan, task(plan, "T104"))).toBe("2026-12-15");
    expect(overdueTasks(plan, "2026-10-14")).toEqual([]);
    expect(overdueTasks(plan, "2026-11-02").map((t) => t.id)).toEqual([
      "T005",
      "T008",
      "T009",
      "T010",
      "T011",
      "T012",
    ]);
    expect(blockedTasks(plan).map((t) => t.id)).toEqual(["T106"]);
  });

  it("lists open leaf tasks per person, inheriting owners", () => {
    expect(openTasksOf(plan, "alex").map((t) => t.id)).toEqual([
      "T005",
      "T008",
      "T012",
      "T107",
      "T110",
      "T111",
      "T304",
      "T403",
    ]);
    expect(openTasksOf(plan, "unassigned").map((t) => t.id)).toEqual(["T112", "T209"]);
  });

  it("computes milestone stats and hour labels", () => {
    const m1 = milestoneStats(plan.milestoneById("M1")!);
    expect(m1).toMatchObject({ total: 11, done: 5, estimate: 94, unestimated: 0 });
    // Done: 4 + 12 + 8 + 16 + 8; partial: T005 6 of 12h, T008 4 of 12h.
    expect(m1.progress).toBeCloseTo((48 + 6 + 4) / 94);
    expect(hoursLabel(task(plan, "T102"))).toBe("7/12h");
    expect(hoursLabel(task(plan, "T121"))).toBe("24h");
  });
});

describe("date suggestions", () => {
  it("offers relative dates from today", () => {
    expect(dateSuggestions("2026-10-14")).toEqual([
      { label: "today", date: "2026-10-14" },
      { label: "tomorrow", date: "2026-10-15" },
      { label: "next Monday", date: "2026-10-19" },
      { label: "end of week", date: "2026-10-16" },
      { label: "end of next week", date: "2026-10-23" },
      { label: "end of month", date: "2026-10-31" },
    ]);
    expect(dateSuggestions("2026-10-17")[3]).toEqual({ label: "end of week", date: "2026-10-23" });
    expect(dateSuggestions("2026-10-19")[2]).toEqual({ label: "next Monday", date: "2026-10-26" });
  });
});

describe("templates", () => {
  const files = Object.fromEntries(
    walkFiles(join(ROOT, "templates/software")).map((f) => [
      f.slice(join(ROOT, "templates/software/").length).split(sep).join("/"),
      readFileSync(f, "utf8"),
    ])
  );

  it("fills placeholders, computes milestone dates and drops empty properties", () => {
    const out = instantiateTemplate(files, {
      name: "Mobile App",
      start: "2027-01-04",
      end: "2027-06-30",
      today: "2026-10-14",
      lead: "Robin Lee",
    });
    expect(out["project.md"]).toMatch(/^# Mobile App\n\nstart: 2027-01-04\nend: 2027-06-30\n/);
    expect(out["project.md"]).not.toMatch(/code:/);
    expect(out["team.md"]).toMatch(/## Robin Lee\n\nid: robin-lee\n/);
    expect(out["milestones/M1-discovery-design.md"]).toMatch(/target: 2027-01-29\n/);
    expect(out["milestones/M5-launch.md"]).toMatch(/target: 2027-06-30\n/);
    expect(out["tests/UAT-01.md"]).toMatch(/^type: acceptance /m);
    for (const text of Object.values(out)) expect(text).not.toMatch(/\{\{/);
    // The instantiated project parses without errors.
    for (const [path, text] of Object.entries(out)) {
      if (!path.endsWith(".md")) continue;
      const kind = path.startsWith("milestones/")
        ? "milestone"
        : path.startsWith("tests/")
          ? "test"
          : path === "team.md"
            ? "team"
            : "project";
      expect(parseFileAs(path, text, kind).issues).toEqual([]);
    }
  });

  it("computes fractions and default end dates", () => {
    expect(fractionDate("2026-10-01", "2027-03-31", 0)).toBe("2026-10-01");
    expect(fractionDate("2026-10-01", "2027-03-31", 1)).toBe("2027-03-31");
    expect(fractionDate("2026-10-05", "2026-10-12", 0.85)).toBe("2026-10-09"); // Sunday → Friday
    expect(defaultEndDate("2026-10-14")).toBe("2027-04-14");
    expect(md("a")).toBe("a\n");
  });
});
