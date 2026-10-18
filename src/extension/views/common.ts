// Shared tree-item presentation: status icons, task descriptions and tooltips.
import * as vscode from "vscode";
import { formatHours } from "../../core/duration";
import { STATUS_LABEL, type Status, type Task } from "../../core/model";
import { hoursLabel, isOverdue } from "../../core/queries";
import { type Plan } from "../../core/resolve";
import { estimateHours, initials, ownerOf, remainingHours } from "../../core/rollup";
import { md } from "../util";

const STATUS_ICONS: Record<Status, [string, string | undefined]> = {
  todo: ["circle-large-outline", undefined],
  doing: ["play-circle", "charts.blue"],
  review: ["eye", "charts.purple"],
  blocked: ["error", "charts.red"],
  done: ["pass-filled", "charts.green"],
  cancelled: ["circle-slash", "disabledForeground"],
};

export function statusIcon(status: Status): vscode.ThemeIcon {
  const [icon, color] = STATUS_ICONS[status];
  return new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
}

export function ownerInitials(plan: Plan, t: Task): string | undefined {
  const owner = ownerOf(t);
  if (!owner) return undefined;
  const person = plan.personById(owner);
  return initials(person?.name ?? owner);
}

export interface TaskDecorations {
  /** Text appended when the task is late (from the schedule). */
  late?: string;
  /** Extra description parts (e.g. scheduled dates). */
  extra?: string[];
}

/** `T105 · MA · 5/12h · overdue` */
export function taskDescription(
  plan: Plan,
  t: Task,
  today: string,
  deco: TaskDecorations = {}
): string {
  const parts: string[] = [];
  if (t.id) parts.push(t.id);
  const who = ownerInitials(plan, t);
  if (who) parts.push(who);
  const hours = hoursLabel(t);
  if (hours) parts.push(hours);
  parts.push(...(deco.extra ?? []));
  if (isOverdue(plan, t, today)) parts.push("⚠ overdue");
  else if (deco.late) parts.push(`⚠ ${deco.late}`);
  return parts.join(" · ");
}

/** Footer of task tooltips that points at the context menu. */
export const TASK_HINT =
  "$(info) Click to open the line · right-click to edit, change status or owner, move or delete";
export const PUNCH_HINT =
  "$(info) Click to open the line · right-click to edit, change status or owner";

export function taskTooltip(
  plan: Plan,
  t: Task,
  extraLines: string[] = [],
  hint?: string
): vscode.MarkdownString {
  const out = new vscode.MarkdownString(undefined, true);
  out.supportThemeIcons = true;
  out.appendMarkdown(`**${t.id ? md(t.id) + " · " : ""}${md(t.title || "(untitled)")}**\n\n`);
  const rows: Array<[string, string]> = [["Status", STATUS_LABEL[t.status]]];
  const owner = ownerOf(t);
  if (owner) rows.push(["Owner", plan.personById(owner)?.name ?? owner]);
  const est = estimateHours(t);
  if (est !== undefined) rows.push(["Estimate", formatHours(est)]);
  if (t.act !== undefined) rows.push(["Actual", formatHours(t.act)]);
  if (t.status !== "done" && t.status !== "cancelled" && est !== undefined)
    rows.push(["Remaining", formatHours(remainingHours(t))]);
  if (t.progress !== undefined) rows.push(["Progress", `${Math.round(t.progress * 100)}%`]);
  if (t.start) rows.push(["Fixed start", t.start]);
  if (t.due) rows.push(["Due", t.due]);
  if (t.started) rows.push(["Started", t.started]);
  if (t.done) rows.push(["Done", t.done]);
  if (t.deps.length) rows.push(["Depends on", t.deps.map((d) => d.raw).join(", ")]);
  if (t.prio !== "med") rows.push(["Priority", t.prio]);
  if (t.blocked) rows.push(["Blocked", t.blocked]);
  if (t.test) rows.push(["Test plan", t.test]);
  if (t.eq) rows.push(["Equipment", t.eq]);
  if (t.src) rows.push(["Source", t.src]);
  for (const [k, v] of Object.entries(t.custom)) rows.push([k, v]);
  if (t.tags.length) rows.push(["Tags", t.tags.map((x) => `#${x.tag}`).join(" ")]);
  out.appendMarkdown(rows.map(([k, v]) => `${md(k)}: ${md(v)}`).join("  \n"));
  for (const line of extraLines) out.appendMarkdown(`  \n${line}`);
  if (t.notes.length) {
    out.appendMarkdown("\n\n---\n\n");
    out.appendMarkdown(
      t.notes
        .slice(0, 8)
        .map((n) => md(n.text))
        .join("  \n")
    );
  }
  if (hint) out.appendMarkdown(`\n\n---\n\n${hint}`);
  return out;
}

/** Stable tree id for a task, so expansion state survives refreshes. */
export function taskNodeId(t: Task): string {
  return t.id ? `task:${t.id}:${t.file}` : `task:${t.file}:${t.line}`;
}
