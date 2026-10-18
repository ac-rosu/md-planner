import ExcelJS from "exceljs";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../src/cli/index";
import { parseBaseline } from "../../../src/core/baseline";
import { schedulePlan } from "../../../src/core/scheduler";
import { CSV_COLUMNS, csvField, exportCsv } from "../../../src/export/csv";
import { milestoneLabel, renderTestReport } from "../../../src/export/testReport";
import { computeRisks, REPORT_SECTIONS, renderStatusReport } from "../../../src/export/html/report";
import { exportFileName, exportFormatOf, logoDataUri, runExport } from "../../../src/export/index";
import { exportMspdi, maxUnits, msDuration, workingTimes } from "../../../src/export/mspdi";
import { browserCandidates, findBrowser } from "../../../src/export/pdf";
import { exportXlsx, XLSX_SHEETS } from "../../../src/export/xlsx";
import { loadSample, md, planFrom, SAMPLE_PLAN, TODAY } from "../helpers";

const plan = loadSample().plan;
const schedule = schedulePlan(plan, { today: TODAY });
const demand = schedulePlan(plan, { today: TODAY, mode: "demand" });
const baseline = parseBaseline(
  readFileSync(join(SAMPLE_PLAN, "baselines/2026-10-07-kickoff.json"), "utf8")
);
const allSections = REPORT_SECTIONS.map((s) => s.id);

/** Minimal XML well-formedness check: balanced tags, no stray `&` or `<`. */
function assertWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack: string[] = [];
  const re =
    /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+);)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (!m[2])
      throw new Error(`stray character at ${m.index}: ${body.slice(m.index, m.index + 40)}`);
    if (m[4]) continue;
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[2]) throw new Error(`</${m[2]}> closes <${open}>`);
    } else stack.push(m[2]);
  }
  if (stack.length) throw new Error(`unclosed: ${stack.join(" ")}`);
}

describe("HTML status report", () => {
  const html = renderStatusReport(plan, schedule, {
    sections: allSections,
    summary: "On track. <script>alert(1)</script> & fine",
    periodDays: 7,
    ganttWeeks: 12,
    author: "Alex",
    branding: {
      company: "Example Corp",
      accentColor: "#0f766e",
      logoDataUri: "data:image/png;base64,AAAA",
    },
    baseline,
    demand,
  });

  it("is one self-contained file without scripts or external resources", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//i);
    expect(html).not.toMatch(/<link/i);
    expect(html).toContain("@media print");
    expect(html).toContain("--accent: #0f766e");
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
  });

  it("contains the eight sections with escaped content", () => {
    for (const heading of [
      "Summary",
      "Milestones",
      "Schedule – next 12 weeks",
      "Team load",
      "Progress",
      "Blocked items and risks",
      "Tests and punch list",
    ]) {
      expect(html).toContain(`>${heading}`);
    }
    expect(html).toContain(
      "Project P-2026-014 · Status report 2026-10-14 · Period 2026-10-08 – 2026-10-14 · by Alex"
    );
    expect(html).toContain("On track. &lt;script&gt;alert(1)&lt;/script&gt; &amp; fine");
    expect(html).toContain('<th class="num">vs kickoff</th>');
    expect(html).toMatch(/M5 – Launch<\/b>.*2027-03-31.*3 d late/s);
    expect(html).toMatch(/<svg[^>]*aria-label="Gantt chart"/);
    expect(html).toMatch(/<svg[^>]*aria-label="Burn-up chart"/);
    expect(html).toContain(
      "T004</td><td>Integration inventory (APIs, SSO, CRM)</td><td>Jordan</td><td>2026-10-13"
    );
    expect(html).toContain("waiting for the payment provider API keys");
    expect(html).toContain("<b>UAT-01</b>");
  });

  it("marks planned overtime in the team load and the key figures", () => {
    expect(html).toContain("<small>+8 OT</small>");
    expect(html).toContain(
      "<b>Planned overtime:</b> Sam 11 h (W45, W46: T114, T206, T105) · Maria 4 h (W48: T303)"
    );
    expect(html).toContain("<span>planned overtime</span>");
  });

  it("leaves out unselected sections", () => {
    const small = renderStatusReport(plan, schedule, {
      sections: ["header", "milestones"],
      periodDays: 7,
      ganttWeeks: 4,
    });
    expect(small).toContain(">Milestones<");
    expect(small).not.toContain(">Summary<");
    expect(small).not.toContain("Gantt chart");
    expect(small).not.toContain(">Tests and punch list<");
  });

  it("lists deterministic risks", () => {
    const risks = computeRisks(plan, schedule, demand).join("\n");
    expect(risks).toContain("M5 – Launch</b> is forecast 2027-03-31");
    expect(risks).toContain("Critical path: 8 task(s) from T304 to T407");
    expect(risks).toMatch(/Sam has more work than capacity in 2026-W43, 2026-W44/);
    expect(risks).toContain("2 open task(s) have no owner.");
  });
});

describe("test report", () => {
  const html = renderTestReport(plan, plan.testById("UAT-01")!, {
    today: TODAY,
    branding: { company: "Example Corp" },
  });

  it("has header, cases with results, summary, punch items and signatures", () => {
    expect(html).toContain("Test report – Acceptance test – Checkout");
    expect(html).toContain("<th>Component / equipment</th><td>checkout</td>");
    expect(html).toContain("<th>Date</th><td>2026-10-12</td><th>Tester</th><td>Alex</td>");
    expect(html).toContain("<th>Witness</th><td>Customer key users</td>");
    expect(html).toContain("NOT PASSED</span> – 1 failed step(s)");
    expect(html).toContain(
      '<td class="res-fail">Fail</td><td>confirmation after 3.5 s</td><td>P007 (todo)</td>'
    );
    expect(html).toContain('<td class="res-open">Not run</td>');
    expect(html).toContain("Payment confirmation after 3.5 s instead of 2 s");
    expect(html).toContain("P003"); // raised from UAT-01/TC-01 via @from
    expect(html).toContain('<div class="sig">');
    expect(html).not.toMatch(/<script/i);
  });

  it("names the milestone once when its title already starts with the id", () => {
    expect(html).toContain("<th>Milestone</th><td>M4 – Acceptance Test</td>");
    const p = planFrom({
      "project.md": md("# P", "", "start: 2026-10-01"),
      "milestones/M1-discovery.md": md("# M1 – Discovery", "", "id: M1"),
      "milestones/M2-backend.md": md("# Backend development", "", "id: M2"),
      "milestones/M3-frontend.md": md("# M30 screens", "", "id: M3"),
    });
    expect(milestoneLabel(p, "M1")).toBe("M1 – Discovery");
    expect(milestoneLabel(p, "m1")).toBe("M1 – Discovery");
    expect(milestoneLabel(p, "M2")).toBe("M2 – Backend development");
    expect(milestoneLabel(p, "M3")).toBe("M3 – M30 screens");
    expect(milestoneLabel(p, "M9")).toBe("M9");
  });
});

describe("CSV", () => {
  it("quotes per RFC 4180 and uses CRLF with a BOM", () => {
    expect([
      csvField("a"),
      csvField("a,b"),
      csvField('say "hi"'),
      csvField("x\ny"),
      csvField(undefined),
      csvField(3),
      csvField("a;b", ";"),
    ]).toEqual(["a", '"a,b"', '"say ""hi"""', '"x\ny"', "", "3", '"a;b"']);
    const csv = exportCsv(plan, schedule);
    expect(csv.startsWith("\ufeffId,Title,Milestone")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.length - 1).toBe(plan.tasks.length + 1);
    expect(lines[0].split(",")).toHaveLength(CSV_COLUMNS.length);
    expect(csv).toContain(
      'T107,"Checkout flow (cart, pay, confirm)",M2,Checkout,,true,todo,alex,40,0,40,0,med,,,,,"T102, T105",2026-11-12,2026-11-20,15,false,false,#checkout,,checkout,,,milestones/M2-backend.md,'
    );
    expect(exportCsv(plan, schedule, ";").slice(1).split("\r\n")[0]).toContain(
      "Id;Title;Milestone"
    );
  });
});

describe("MS Project XML (MSPDI)", () => {
  const xml = exportMspdi(plan, schedule, { author: "Alex", company: "Example Corp" });
  const count = (re: RegExp) => (xml.match(re) ?? []).length;

  it("is well-formed MSPDI with project settings and calendars", () => {
    assertWellFormed(xml);
    expect(xml).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>\n<Project xmlns="http:\/\/schemas.microsoft.com\/project">/
    );
    expect(xml).toContain(
      "<MinutesPerDay>480</MinutesPerDay><MinutesPerWeek>2400</MinutesPerWeek>".replace(
        "</MinutesPerDay><",
        "</MinutesPerDay>\n<"
      )
    );
    expect(xml).toContain(
      "<FromDate>2026-12-25T00:00:00</FromDate><ToDate>2026-12-26T23:59:00</ToDate>"
    );
    expect(xml).toContain("<WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>");
    expect(count(/<Calendar>/g)).toBe(1 + plan.people.length);
    // Maria works mon-thu: her calendar has its own week days.
    expect(xml).toMatch(
      /<Name>Maria<\/Name>.*?<WeekDays>.*?<DayType>6<\/DayType><DayWorking>0<\/DayWorking>/s
    );
    // … and an extra working Friday of 4 hours.
    expect(xml).toContain(
      "<FromDate>2026-11-27T00:00:00</FromDate><ToDate>2026-11-27T23:59:00</ToDate></TimePeriod><Occurrences>1</Occurrences><Name>Extra working day</Name><Type>1</Type><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime></WorkingTimes>"
    );
  });

  it("writes the WBS, constraints, links with lag, resources and assignments", () => {
    const cancelled = plan.tasks.filter((t) => t.status === "cancelled").length;
    const sections = plan.milestones.flatMap((m) =>
      m.sections.filter((s) => s.tasks.some((t) => t.status !== "cancelled"))
    ).length;
    expect(count(/<Task>/g)).toBe(
      1 + plan.milestones.length + sections + plan.tasks.length - cancelled
    );
    expect(xml).toMatch(
      /<Name>Checkout flow \(cart, pay, confirm\) \[T107\]<\/Name>.*?<OutlineNumber>2\.2\.5<\/OutlineNumber>.*?<Start>2026-11-12T08:00:00<\/Start><Finish>2026-11-20T17:00:00<\/Finish><Duration>PT56H0M0S<\/Duration>.*?<ConstraintType>4<\/ConstraintType><ConstraintDate>2026-11-12T08:00:00<\/ConstraintDate>/s
    );
    expect(xml).toMatch(
      /\[T304\].*?<PredecessorLink><PredecessorUID>\d+<\/PredecessorUID><Type>1<\/Type><CrossProject>0<\/CrossProject><LinkLag>9600<\/LinkLag><LagFormat>7<\/LagFormat><\/PredecessorLink>/s
    );
    expect(xml).toMatch(/<Name>M2 – Backend<\/Name>.*?<Deadline>2026-12-15T17:00:00<\/Deadline>/s);
    expect(xml).toMatch(
      /<Name>Alex<\/Name><Type>1<\/Type><IsNull>0<\/IsNull><Initials>AL<\/Initials><Group>Project lead \/ backend<\/Group><Code>alex<\/Code><MaxUnits>0.8<\/MaxUnits>/
    );
    const assigned = plan.tasks.filter(
      (t) => t.children.length === 0 && t.status !== "cancelled" && (t.owner ?? t.parent?.owner)
    ).length;
    expect(count(/<Assignment>/g)).toBe(assigned);
    expect(xml).toContain("<ActualFinish>2026-10-13T17:00:00</ActualFinish>");
  });

  it("formats durations and working times", () => {
    expect([msDuration(16), msDuration(1.5), msDuration(0)]).toEqual([
      "PT16H0M0S",
      "PT1H30M0S",
      "PT0H0M0S",
    ]);
    expect(workingTimes(8)).toEqual([
      ["08:00:00", "12:00:00"],
      ["13:00:00", "17:00:00"],
    ]);
    expect(workingTimes(7.5)).toEqual([
      ["08:00:00", "12:00:00"],
      ["13:00:00", "16:30:00"],
    ]);
    expect(workingTimes(4)).toEqual([["08:00:00", "12:00:00"]]);
    expect(maxUnits(plan.personById("maria")!, 5, 8)).toBe(0.5);
    expect(maxUnits(plan.personById("jordan")!, 5, 8)).toBe(0.6);
  });
});

describe("Excel", () => {
  it("has all six sheets with the plan's data", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await exportXlsx(plan, schedule, "Alex")) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(XLSX_SHEETS);
    const tasks = wb.getWorksheet("Tasks")!;
    expect(tasks.rowCount).toBe(plan.tasks.length + 1);
    expect(tasks.getRow(1).getCell(1).value).toBe("Id");
    expect(wb.getWorksheet("Milestones")!.rowCount).toBe(6);
    expect(wb.getWorksheet("Milestones")!.getRow(6).getCell(7).value).toBe(true); // M5 late
    expect(wb.getWorksheet("Punch list")!.rowCount).toBe(6);
    expect(wb.getWorksheet("Tests")!.rowCount).toBe(1 + 4 + 4);
    const load = wb.getWorksheet("Team load per week")!;
    expect(load.getRow(1).values).toEqual([
      undefined,
      "Person",
      "Week",
      "Week start",
      "Scheduled hours",
      "Capacity",
      "Load (%)",
      "Days off",
      "Overtime capacity",
      "Overtime scheduled",
    ]);
    expect(load.rowCount).toBeGreaterThan(50);
    const markW45 = load
      .getSheetValues()
      .find((r) => Array.isArray(r) && r[1] === "Sam" && r[2] === "2026-W45") as unknown[];
    expect(markW45.slice(4)).toEqual([48, 48, 100, 0, 8, 8]);
    expect(wb.creator).toBe("Alex");
  });
});

describe("export orchestration and PDF", () => {
  it("names files by date and format and embeds logos", () => {
    expect(exportFileName("html", TODAY)).toBe("2026-10-14-status-report.html");
    expect(exportFileName("mspdi", TODAY)).toBe("2026-10-14-plan.xml");
    expect(exportFileName("test-report-pdf", TODAY, undefined, "UAT-01")).toBe(
      "2026-10-14-UAT-01-report.pdf"
    );
    expect(exportFormatOf("test-report")).toBe("test-report");
    expect(exportFormatOf("fat")).toBe("test-report");
    expect(exportFormatOf("fat-pdf")).toBe("test-report-pdf");
    expect(exportFormatOf("docx")).toBeUndefined();
    expect(logoDataUri(new Uint8Array([1, 2, 3]), "logo.PNG")).toBe("data:image/png;base64,AQID");
    expect(logoDataUri(new Uint8Array([1]), "logo.bmp")).toBeUndefined();
  });

  it("detects browsers per platform", () => {
    expect(browserCandidates("darwin", {})[1]).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    );
    expect(browserCandidates("linux", { PATH: "/usr/bin" })).toContain("/usr/bin/google-chrome");
    expect(
      browserCandidates("win32", { PROGRAMFILES: "C:\\PF" }).some((p) => p.includes("msedge.exe"))
    ).toBe(true);
    expect(findBrowser("/no/such/browser")).toBeUndefined();
  });

  it("falls back to HTML with a warning when no browser is available", async () => {
    const r = await runExport(plan, schedule, demand, {
      formats: ["pdf"],
      periodDays: 7,
      ganttWeeks: 4,
      browserPath: "/no/such/browser",
    });
    expect(r.files.map((f) => f.name)).toEqual(["2026-10-14-status-report.html"]);
    expect(r.warnings[0]).toMatch(/was not found; the HTML report was written instead/);
  });

  it.runIf(findBrowser() !== undefined)(
    "prints the HTML report to PDF with Edge/Chrome",
    async () => {
      const r = await runExport(plan, schedule, demand, {
        formats: ["pdf", "test-report-pdf"],
        periodDays: 7,
        ganttWeeks: 8,
      });
      expect(r.warnings).toEqual([]);
      for (const f of r.files) {
        const head = Buffer.from(f.data as Uint8Array)
          .subarray(0, 5)
          .toString("latin1");
        expect(head).toBe("%PDF-");
        expect(Buffer.from(f.data as Uint8Array).toString("latin1")).toMatch(/\/Type\s*\/Page[^s]/);
      }
    },
    // Two browser launches, each allowed 60 s by printToPdf (a cold start on a CI runner takes
    // 15-25 s): a print that really fails then reports its own error instead of a test timeout.
    150_000
  );

  it("is available from the CLI", async () => {
    const out = mkdtempSync(join(tmpdir(), "planner-cli-"));
    let stdout = "";
    const code = await main(
      [
        "export",
        "--plan",
        SAMPLE_PLAN,
        "--today",
        TODAY,
        "--format",
        "html,csv,xlsx,mspdi,fat",
        "--out",
        out,
        "--summary",
        "All good",
      ],
      {
        out: (t) => (stdout += t),
        err: () => undefined,
      }
    );
    expect(code).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "2026-10-14-UAT-01-report.html",
      "2026-10-14-plan.xlsx",
      "2026-10-14-plan.xml",
      "2026-10-14-status-report.html",
      "2026-10-14-tasks.csv",
    ]);
    expect(readFileSync(join(out, "2026-10-14-status-report.html"), "utf8")).toContain("All good");
    expect(stdout.split("\n").filter(Boolean)).toHaveLength(5);
    expect(
      await main(["export", "--plan", SAMPLE_PLAN, "--format", "docx"], {
        out: () => undefined,
        err: () => undefined,
      })
    ).toBe(2);
    expect(existsSync(join(out, "2026-10-14-plan.xml"))).toBe(true);
  });
});
