// Exports of plans with careless or hostile text: spreadsheet formulas in CSV, characters XML does
// not allow, text that looks like an internal placeholder, actual dates in the wrong order.
import ExcelJS from "exceljs";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { schedulePlan } from "../../../src/core/scheduler";
import { csvField, exportCsv } from "../../../src/export/csv";
import { exportFileName } from "../../../src/export/index";
import { exportMspdi } from "../../../src/export/mspdi";
import { exportXlsx } from "../../../src/export/xlsx";
import { loadSample, md, planFrom, TODAY } from "../helpers";

const FORBIDDEN = "\u0000\u0001\u0008\u000B\u000C\u000E\u001F\uFFFE\uFFFF";

/** Parses XML with a conforming parser: throws on anything that is not well-formed. */
function parseXml(xml: string): void {
  const parser = new SaxesParser();
  parser.on("error", (err) => {
    throw err;
  });
  parser.write(xml).close();
}

const hostile = () =>
  planFrom({
    "project.md": md(`# Portal${FORBIDDEN}`, "", "start: 2026-10-01"),
    "team.md": md("# Team", "", "## Sam", "", "capacity: 40h/week"),
    "milestones/M1.md": md(
      "# M1",
      "",
      "id: M1",
      "",
      `- [ ] =HYPERLINK("http://evil.example","click") @est:8h @owner:sam ^T1`,
      "- [ ] +cmd|'/C calc'!A0 @est:4h @dep:T1 ^T2",
      "- [ ] @SUM(1+1) @est:2h ^T3",
      "- [ ] -2+3 @est:2h ^T4",
      `- [ ] Bad${FORBIDDEN}text @est:2h @blocked:wait${FORBIDDEN}here ^T5`,
      "- [ ] Plain title, with a comma @est:1h ^T6"
    ),
  });

describe("CSV against formula injection", () => {
  it("prefixes text that a spreadsheet would run as a formula with '", () => {
    expect([
      csvField('=HYPERLINK("http://evil.example")'),
      csvField("+cmd|'/C calc'!A0"),
      csvField("@SUM(1+1)"),
      csvField("-2+3"),
      csvField("\t=1+1"),
      csvField("\r=1+1"),
      csvField(" =1+1"),
    ]).toEqual([
      `"'=HYPERLINK(""http://evil.example"")"`,
      "'+cmd|'/C calc'!A0",
      "'@SUM(1+1)",
      "'-2+3",
      "'\t=1+1",
      `"'\r=1+1"`,
      "' =1+1",
    ]);
  });

  it("leaves numbers, ordinary text and empty cells as they are", () => {
    expect([
      csvField(-3),
      csvField(-0.5),
      csvField(12.5),
      csvField(true),
      csvField(undefined),
      csvField(""),
      csvField("Kick-off"),
      csvField("#uat #customer"),
      csvField("T303+2d"),
      csvField("a=b"),
    ]).toEqual([
      "-3",
      "-0.5",
      "12.5",
      "true",
      "",
      "",
      "Kick-off",
      "#uat #customer",
      "T303+2d",
      "a=b",
    ]);
  });

  it("writes hostile task titles as text and keeps negative slack a number", () => {
    const p = hostile();
    const rows = exportCsv(p, schedulePlan(p, { today: "2026-10-01" })).split("\r\n");
    const row = (id: string) => rows.find((r) => r.startsWith(`${id},`))!;
    expect(row("T1")).toContain(`,"'=HYPERLINK(""http://evil.example"",""click"")",`);
    expect(row("T2")).toContain(",'+cmd|'/C calc'!A0,");
    expect(row("T3")).toContain(",'@SUM(1+1),");
    expect(row("T4")).toContain(",'-2+3,");
    expect(row("T6")).toContain(`,"Plain title, with a comma",`);

    // The sample's late tasks keep their negative slack as a number.
    const sample = loadSample().plan;
    const csv = exportCsv(sample, schedulePlan(sample, { today: TODAY }));
    expect(csv).toMatch(/\nT304,Acceptance test with key users,.*,-3,true,false,/);
    expect(csv).not.toMatch(/,'-?\d/);
  });
});

describe("Excel with hostile text", () => {
  it("stores formula-like titles as text cells and drops characters XML forbids", async () => {
    const p = hostile();
    const bytes = await exportXlsx(p, schedulePlan(p, { today: "2026-10-01" }), `Alex${FORBIDDEN}`);
    const wb = new ExcelJS.Workbook();
    // The loader parses every part as XML, so a forbidden character makes it throw.
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(wb.title).toBe("Portal");
    expect(wb.creator).toBe("Alex");
    const tasks = wb.getWorksheet("Tasks")!;
    const titles = new Map<string, ExcelJS.Cell>();
    tasks.eachRow((row, n) => {
      if (n > 1) titles.set(String(row.getCell(1).value), row.getCell(2));
    });
    const formula = titles.get("T1")!;
    expect(formula.type).toBe(ExcelJS.ValueType.String);
    expect(formula.value).toBe('=HYPERLINK("http://evil.example","click")');
    expect(formula.formula).toBeUndefined();
    expect(titles.get("T2")!.type).toBe(ExcelJS.ValueType.String);
    expect(titles.get("T5")!.value).toBe("Badtext");
    const blocked = tasks.getRow(6).getCell(28).value;
    expect(blocked).toBe("waithere");
  });
});

describe("MS Project XML with hostile text", () => {
  it("leaves out characters XML does not allow", () => {
    const p = hostile();
    const xml = exportMspdi(p, schedulePlan(p, { today: "2026-10-01" }), {
      author: `Alex${FORBIDDEN}`,
      company: `Example${FORBIDDEN} Corp`,
    });
    expect(() => parseXml(xml)).not.toThrow();
    for (const c of FORBIDDEN) expect(xml).not.toContain(c);
    expect(xml).toContain("<Name>Badtext [T5]</Name>");
    expect(xml).toContain("<Notes>Blocked: waithere</Notes>");
    expect(xml).toContain("<Title>Portal</Title>");
    expect(xml).toContain("<Author>Alex</Author>");
    expect(xml).toContain("<Company>Example Corp</Company>");
    // Tabs and line breaks are allowed and kept.
    const notes = planFrom({
      "project.md": md("# P", "", "start: 2026-10-01"),
      "milestones/M1.md": md("# M1", "", "- [ ] Task @est:1h @src:docs ^T1", "  Line\tone", ""),
    });
    expect(exportMspdi(notes, schedulePlan(notes, { today: "2026-10-01" }))).toContain(
      "<Notes>Line\tone\nSource: docs</Notes>"
    );
  });

  it("keeps the dependencies of a task whose title looks like an internal placeholder", () => {
    const p = planFrom({
      "project.md": md("# P", "", "start: 2026-10-01"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [ ] First @est:8h ^T1",
        "- [ ] __LINKS_2__ trap @est:8h @dep:T1 ^T2",
        "- [ ] Third __LINKS_4__ @est:8h @dep:T2+1d ^T3"
      ),
    });
    const xml = exportMspdi(p, schedulePlan(p, { today: "2026-10-01" }));
    expect(() => parseXml(xml)).not.toThrow();
    const row = (id: string) =>
      xml.match(
        new RegExp(`<Task><UID>(\\d+)</UID><ID>\\d+</ID><Name>[^<]*\\[${id}\\]</Name>.*?</Task>`)
      )!;
    const [t1, t2, t3] = ["T1", "T2", "T3"].map(row);
    expect(t2[0]).toContain("<Name>__LINKS_2__ trap [T2]</Name>");
    expect(t2[0]).toContain(`<PredecessorLink><PredecessorUID>${t1[1]}</PredecessorUID>`);
    expect(t3[0]).toContain("<Name>Third __LINKS_4__ [T3]</Name>");
    expect(t3[0]).toContain(
      `<PredecessorLink><PredecessorUID>${t2[1]}</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject><LinkLag>4800</LinkLag>`
    );
    expect(xml.match(/<PredecessorLink>/g)).toHaveLength(2);
    expect(xml).not.toMatch(/__LINKS_\d+__<\/Task>/);
  });

  it("never puts the actual start after the actual finish", () => {
    const p = planFrom({
      "project.md": md("# P", "", "start: 2026-10-01"),
      "team.md": md("# Team", "", "## Sam", "", "capacity: 40h/week"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [x] Started after done @est:8h @owner:sam @started:2026-10-12 @done:2026-10-05 ^T1",
        "- [x] Normal @est:8h @act:8h @owner:sam @started:2026-10-02 @done:2026-10-05 ^T2"
      ),
    });
    const xml = exportMspdi(p, schedulePlan(p, { today: "2026-10-14" }));
    const actual = (id: string) => {
      const body = xml.match(new RegExp(`<Name>[^<]*\\[${id}\\]</Name>.*?</Task>`))![0];
      return [
        /<ActualStart>([^<]*)</.exec(body)?.[1],
        /<ActualFinish>([^<]*)</.exec(body)?.[1],
        /<Work>([^<]*)</.exec(body)?.[1],
        /<ActualWork>([^<]*)</.exec(body)?.[1],
      ];
    };
    // Done without logged hours: the estimate is what it took.
    expect(actual("T1")).toEqual([
      "2026-10-05T08:00:00",
      "2026-10-05T17:00:00",
      "PT8H0M0S",
      "PT8H0M0S",
    ]);
    expect(actual("T2")).toEqual([
      "2026-10-02T08:00:00",
      "2026-10-05T17:00:00",
      "PT8H0M0S",
      "PT8H0M0S",
    ]);
  });
});

describe("export file names", () => {
  it("stay file names, whatever the report name or test plan id", () => {
    expect(exportFileName("test-report", "2026-11-02", undefined, "../../../../x")).toBe(
      "2026-11-02-.-.-.-.-x-report.html"
    );
    expect(exportFileName("html", "2026-11-02", "a/b\\c")).toBe("2026-11-02-a-b-c.html");
    expect(exportFileName("html", "2026-11-02")).toBe("2026-11-02-status-report.html");
  });
});

describe("MS Project XML of finished work and milestone order", () => {
  const p = planFrom({
    "project.md": md("# P", "", "start: 2026-10-01"),
    "team.md": md("# Team", "", "## Sam", "", "capacity: 40h/week"),
    "milestones/M1.md": md(
      "# M1 – Design",
      "",
      "id: M1",
      "",
      "- [x] Faster than planned @est:8h @act:7h @owner:sam @started:2026-10-01 @done:2026-10-01 ^T1"
    ),
    "milestones/M2.md": md(
      "# M2 – Build",
      "",
      "id: M2",
      "depends: M1",
      "",
      "- [ ] b @est:8h @owner:sam ^T2"
    ),
  });
  const xml = exportMspdi(p, schedulePlan(p, { today: "2026-10-14" }));
  const row = (name: string) =>
    xml.match(new RegExp(`<Task><UID>\\d+</UID><ID>\\d+</ID><Name>${name}</Name>.*?</Task>`))![0];

  it("gives a done task the work it took, 100 % complete", () => {
    const t1 = row("Faster than planned \\[T1\\]");
    expect(/<Work>([^<]*)</.exec(t1)?.[1]).toBe("PT7H0M0S");
    expect(/<ActualWork>([^<]*)</.exec(t1)?.[1]).toBe("PT7H0M0S");
    expect(/<RemainingWork>([^<]*)</.exec(t1)?.[1]).toBe("PT0H0M0S");
    expect(/<PercentWorkComplete>([^<]*)</.exec(t1)?.[1]).toBe("100");
  });

  it("links a milestone to the milestones it depends on", () => {
    const m1 = /<UID>(\d+)<\/UID>/.exec(row("M1 – Design"))![1];
    expect(row("M2 – Build")).toContain(`<PredecessorLink><PredecessorUID>${m1}</PredecessorUID>`);
  });
});
