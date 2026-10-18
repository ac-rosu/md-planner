// Task filter shared by the sidebar views, the Kanban board and the MCP server, so that the same
// filter always matches the same tasks everywhere.
import { type Status, type Task } from "./model";
import { ownerOf } from "./rollup";

export interface TaskFilter {
  owner?: string[];
  tag?: string[];
  status?: Status[];
  milestone?: string[];
  text?: string;
}

export function isEmptyFilter(f: TaskFilter | undefined): boolean {
  return (
    !f ||
    (!f.owner?.length &&
      !f.tag?.length &&
      !f.status?.length &&
      !f.milestone?.length &&
      !f.text?.trim())
  );
}

/** `owner` matches the effective owner (own or inherited); `unassigned` matches tasks without one. */
export function matchesFilter(task: Task, f: TaskFilter | undefined): boolean {
  if (!f) return true;
  if (f.owner?.length) {
    const owner = (ownerOf(task) ?? "unassigned").toLowerCase();
    if (!f.owner.some((o) => o.toLowerCase() === owner)) return false;
  }
  if (f.tag?.length) {
    const tags = new Set(task.tags.map((t) => t.tag.toLowerCase()));
    if (!f.tag.some((t) => tags.has(t.replace(/^#/, "").toLowerCase()))) return false;
  }
  if (f.status?.length && !f.status.includes(task.status)) return false;
  if (f.milestone?.length) {
    const m = (task.milestoneId ?? "").toLowerCase();
    if (!f.milestone.some((x) => x.toLowerCase() === m)) return false;
  }
  const text = f.text?.trim().toLowerCase();
  if (text) {
    const hay = [
      task.title,
      task.id ?? "",
      ...task.notes.map((n) => n.text),
      ...task.tags.map((t) => `#${t.tag}`),
    ]
      .join("\n")
      .toLowerCase();
    if (!text.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

/** A task matches when it or any of its descendants matches (so tree views keep the path). */
export function matchesFilterDeep(task: Task, f: TaskFilter | undefined): boolean {
  if (matchesFilter(task, f)) return true;
  return task.children.some((c) => matchesFilterDeep(c, f));
}

/** Short human-readable description of a filter, e.g. `owner: mark · #hmi · doing`. */
export function describeFilter(f: TaskFilter | undefined): string {
  if (isEmptyFilter(f)) return "";
  const parts: string[] = [];
  if (f!.owner?.length) parts.push(`owner: ${f!.owner.join(", ")}`);
  if (f!.tag?.length) parts.push(f!.tag.map((t) => `#${t.replace(/^#/, "")}`).join(" "));
  if (f!.status?.length) parts.push(`status: ${f!.status.join(", ")}`);
  if (f!.milestone?.length) parts.push(`milestone: ${f!.milestone.join(", ")}`);
  if (f!.text?.trim()) parts.push(`"${f!.text.trim()}"`);
  return parts.join(" · ");
}
