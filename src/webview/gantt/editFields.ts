// The fields of the Gantt's inline edit dialog, and what it saves. Pure functions, unit-tested.
import { type GanttRow } from "../../core/views/gantt";

/** What the dialog sends: only the fields that were changed in it. */
export interface EditResult {
  title?: string;
  /** null: no owner. */
  owner?: string | null;
  estimate?: string;
}

/** The dialog's fields as text, as it shows them for a row. */
export interface EditValues {
  title: string;
  owner: string;
  estimate: string;
}

export function editValues(row: GanttRow): EditValues {
  return { title: row.title, owner: row.owner?.toLowerCase() ?? "", estimate: row.est ?? "" };
}

/**
 * The fields changed from the values the dialog opened with, compared with those and not with
 * the task as it is now: a field left alone is not sent, so it never writes back a value the task
 * had when the dialog opened (another change, in the editor or by an agent, made meanwhile stays).
 * An emptied estimate is not sent: an estimate is changed, not removed, here.
 */
export function changedFields(opened: EditValues, now: EditValues): EditResult {
  const result: EditResult = {};
  const title = now.title.trim();
  const estimate = now.estimate.trim();
  if (title !== opened.title) result.title = title;
  if (now.owner !== opened.owner) result.owner = now.owner === "" ? null : now.owner;
  if (estimate !== opened.estimate && estimate !== "")
    result.estimate = estimate.replace(/\s+/g, "");
  return result;
}
