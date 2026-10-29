// CSV export: one flat row per task (RFC 4180 quoting, CRLF line endings, UTF-8 with BOM so that
// Excel reads the special characters).
import { formatDate } from "../core/dates";
import { type Plan } from "../core/resolve";
import {
  actualHours,
  estimateHours,
  isLeaf,
  ownerOf,
  progressOf,
  remainingHours,
} from "../core/rollup";
import { type Schedule } from "../core/scheduler";

export const CSV_COLUMNS = [
  "Id",
  "Title",
  "Milestone",
  "Section",
  "Parent",
  "Leaf",
  "Status",
  "Owner",
  "Estimate (h)",
  "Actual (h)",
  "Remaining (h)",
  "Progress (%)",
  "Priority",
  "Fixed start",
  "Due",
  "Started",
  "Done",
  "Dependencies",
  "Scheduled start",
  "Scheduled finish",
  "Slack (d)",
  "Critical",
  "Late",
  "Tags",
  "Test",
  "Equipment",
  "Source",
  "Blocked",
  "File",
  "Line",
];

/**
 * Text that a spreadsheet would read as a formula (starting with `=`, `+`, `-`, `@`, a tab or a
 * carriage return, also after leading spaces) gets a leading `'`, so that a task title like
 * `=HYPERLINK(…)` stays text. Numbers (hours, percentages, negative slack) are written unchanged.
 */
export function csvField(value: string | number | boolean | undefined, delimiter = ","): string {
  if (value === undefined) return "";
  const s =
    typeof value === "string" && /^\s*[=+\-@\t\r]/.test(value) ? `'${value}` : String(value);
  return s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function taskRows(
  plan: Plan,
  schedule: Schedule
): Array<Array<string | number | boolean | undefined>> {
  const r1 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);
  return plan.tasks.map((t) => {
    const ts = schedule.tasks.get(t);
    const roll = schedule.parents.get(t);
    const start = ts?.start ?? roll?.start;
    const finish = ts?.finish ?? roll?.finish;
    return [
      t.id,
      t.title,
      t.milestoneId,
      t.section,
      t.parent?.id,
      isLeaf(t),
      t.status,
      ownerOf(t),
      r1(estimateHours(t)),
      r1(actualHours(t)),
      r1(remainingHours(t)),
      Math.round(progressOf(t) * 100),
      t.prio,
      t.start,
      t.due,
      t.started,
      t.done,
      t.deps.map((d) => d.raw).join(", "),
      start === undefined ? undefined : formatDate(start),
      finish === undefined ? undefined : formatDate(finish),
      ts?.slack,
      ts?.critical,
      ts?.late,
      t.tags.map((x) => `#${x.tag}`).join(" "),
      t.test,
      t.eq,
      t.src,
      t.blocked,
      t.file,
      t.line + 1,
    ];
  });
}

export function exportCsv(plan: Plan, schedule: Schedule, delimiter = ","): string {
  const lines = [CSV_COLUMNS, ...taskRows(plan, schedule)].map((row) =>
    row.map((v) => csvField(v, delimiter)).join(delimiter)
  );
  return "﻿" + lines.join("\r\n") + "\r\n";
}
