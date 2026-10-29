// Excel export (exceljs): Tasks, Schedule, Team load per week, Milestones, Tests, Punch list.
import ExcelJS from "exceljs";
import { formatDate } from "../core/dates";
import { teamLoad } from "../core/load";
import { type Plan } from "../core/resolve";
import { ownerOf } from "../core/rollup";
import { type Schedule } from "../core/scheduler";
import { buildDashboardModel } from "../core/views/dashboard";
import { CSV_COLUMNS, taskRows } from "./csv";

export const XLSX_SHEETS = [
  "Tasks",
  "Schedule",
  "Team load per week",
  "Milestones",
  "Tests",
  "Punch list",
];

type Cell = string | number | boolean | undefined;

/**
 * Characters XML 1.0 does not allow. exceljs drops the C0 controls itself but writes U+FFFE and
 * U+FFFF as they are, which would make the workbook unreadable.
 */
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

/**
 * Plan text for a cell, without the characters XML forbids. exceljs stores a string as a text cell,
 * never as a formula, so `=HYPERLINK(…)` in a title is shown, not run.
 */
function xlsxText<T extends Cell>(value: T): T {
  return (typeof value === "string" ? value.replace(NOT_XML, "") : value) as T;
}

function sheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: Cell[][],
  widths?: number[]
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r.map((v) => (v === undefined ? null : xlsxText(v))));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF4" } };
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: headers.length },
  };
  headers.forEach((h, i) => {
    const longest = Math.max(h.length, ...rows.slice(0, 500).map((r) => String(r[i] ?? "").length));
    ws.getColumn(i + 1).width = widths?.[i] ?? Math.min(60, Math.max(8, longest + 2));
  });
  return ws;
}

export async function exportXlsx(
  plan: Plan,
  schedule: Schedule,
  author?: string
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = xlsxText(author ?? "Markdown Project Planner");
  wb.title = xlsxText(plan.project.name);
  const today = formatDate(schedule.today);
  wb.created = new Date(`${today}T00:00:00Z`);
  wb.modified = wb.created;

  sheet(wb, "Tasks", CSV_COLUMNS, taskRows(plan, schedule));

  const scheduleRows: Cell[][] = [...schedule.tasks.values()]
    .sort((a, b) => a.task.order - b.task.order)
    .map((ts) => [
      ts.key,
      ts.task.title,
      ts.task.milestoneId,
      ts.resource,
      ts.task.status,
      ts.start === undefined ? undefined : formatDate(ts.start),
      ts.finish === undefined ? undefined : formatDate(ts.finish),
      Math.round(ts.scheduledHours * 100) / 100,
      ts.slack,
      ts.critical,
      ts.late,
      ts.deadline === undefined ? undefined : formatDate(ts.deadline),
      ts.unscheduled,
    ]);
  sheet(
    wb,
    "Schedule",
    [
      "Id",
      "Title",
      "Milestone",
      "Resource",
      "Status",
      "Start",
      "Finish",
      "Scheduled hours",
      "Slack (d)",
      "Critical",
      "Late",
      "Deadline",
      "Not scheduled",
    ],
    scheduleRows
  );

  const from = schedule.start;
  const to = Math.max(schedule.finish ?? from, from);
  const loadRows: Cell[][] = teamLoad(plan, schedule, from, to).flatMap((row) =>
    row.weeks.map((w) => [
      row.name,
      w.week,
      formatDate(w.start),
      Math.round(w.hours * 100) / 100,
      Math.round(w.capacity * 100) / 100,
      w.capacity > 0 ? Math.round((w.hours / w.capacity) * 100) : w.hours > 0 ? 999 : 0,
      w.offDays,
      Math.round(w.overtimeCapacity * 100) / 100,
      Math.round(w.overtime * 100) / 100,
    ])
  );
  const loadSheet = sheet(
    wb,
    "Team load per week",
    [
      "Person",
      "Week",
      "Week start",
      "Scheduled hours",
      "Capacity",
      "Load (%)",
      "Days off",
      "Overtime capacity",
      "Overtime scheduled",
    ],
    loadRows
  );
  loadRows.forEach((r, i) => {
    const pctCell = loadSheet.getCell(i + 2, 6);
    const v = Number(r[5]);
    if (v > 100) pctCell.font = { bold: true, color: { argb: "FFCF222E" } };
  });

  const dash = buildDashboardModel(plan, schedule);
  sheet(
    wb,
    "Milestones",
    [
      "Id",
      "Title",
      "Status",
      "Target",
      "Forecast",
      "Variance (d)",
      "Late",
      "Complete (%)",
      "Tasks done",
      "Tasks total",
      "Remaining (h)",
      "Depends on",
    ],
    dash.milestones.map((m) => [
      m.id,
      m.title,
      m.status,
      m.target,
      m.forecast,
      m.variance,
      m.late,
      Math.round(m.progress * 100),
      m.done,
      m.total,
      m.remaining,
      plan.milestoneById(m.id)?.depends.join(", "),
    ])
  );

  const testRows: Cell[][] = [];
  for (const tp of plan.tests) {
    for (const c of tp.cases) {
      c.steps
        .flatMap((s) => [s, ...s.children])
        .forEach((s, i) => {
          testRows.push([
            tp.id,
            tp.type,
            c.id,
            c.title,
            i + 1,
            s.title,
            s.result ?? "open",
            s.note,
            s.punch,
            tp.file,
            s.line + 1,
          ]);
        });
    }
  }
  sheet(
    wb,
    "Tests",
    [
      "Test plan",
      "Type",
      "Case",
      "Case title",
      "Step",
      "Step text",
      "Result",
      "Note",
      "Punch",
      "File",
      "Line",
    ],
    testRows
  );

  sheet(
    wb,
    "Punch list",
    [
      "Id",
      "Title",
      "Severity",
      "Status",
      "Owner",
      "Due",
      "From",
      "Started",
      "Done",
      "Overdue",
      "Tags",
      "Line",
    ],
    plan.punch
      .filter((p) => !p.parent)
      .map((p) => [
        p.id,
        p.title,
        p.sev,
        p.status,
        ownerOf(p),
        p.due,
        p.from,
        p.started,
        p.done,
        p.status !== "done" && p.status !== "cancelled" && !!p.due && p.due < today,
        p.tags.map((t) => `#${t.tag}`).join(" "),
        p.line + 1,
      ])
  );

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
