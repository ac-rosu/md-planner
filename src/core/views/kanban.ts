// Kanban view model: columns from the status table, cards, swimlanes and WIP limits, for the task
// board and the punch-list board. Filtering uses the same function as the sidebar views.
import { UNASSIGNED } from "../calendar";
import { formatDate } from "../dates";
import { matchesFilter, type TaskFilter } from "../filter";
import { isOpen, PRIORITY_RANK, type Priority, type Status, type Task } from "../model";
import { deadlineOf } from "../queries";
import { type Plan } from "../resolve";
import { actualHours, estimateHours, initials, isLeaf, leavesOf, ownerOf } from "../rollup";
import { type TaskOvertime, taskOvertime } from "../load";
import { type Schedule, taskKey } from "../scheduler";
import { NEUTRAL, personColor } from "./colors";

export type KanbanBoard = "tasks" | "punch";
export type KanbanSwimlane = "none" | "owner" | "milestone" | "severity";
export type KanbanCardMode = "tasks" | "leaves";

export const KANBAN_COLUMNS: readonly Status[] = [
  "todo",
  "doing",
  "review",
  "blocked",
  "done",
  "cancelled",
];

export const COLUMN_TITLE: Record<Status, string> = {
  todo: "To do",
  doing: "Doing",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export interface KanbanCard {
  key: string;
  id?: string;
  title: string;
  status: Status;
  prio: Priority;
  owner?: string;
  ownerName?: string;
  ownerInitials?: string;
  ownerColor: string;
  hours: string;
  due?: string;
  late: boolean;
  tags: string[];
  subtasks?: { done: number; total: number };
  milestone?: string;
  parentTitle?: string;
  blocked?: string;
  sev?: string;
  from?: string;
  /** Scheduled finish (task board). */
  finish?: string;
  /** Hours of overtime and extra working days scheduled for the task (or its subtasks). */
  overtime?: number;
}

export interface KanbanColumn {
  status: Status;
  title: string;
  count: number;
  wip?: number;
  over: boolean;
}

export interface KanbanLane {
  key: string;
  title: string;
  cards: Partial<Record<Status, KanbanCard[]>>;
}

export interface KanbanOptions {
  board: KanbanBoard;
  swimlane: KanbanSwimlane;
  filter?: TaskFilter;
  showCancelled: boolean;
  cardMode: KanbanCardMode;
  wipLimits?: Partial<Record<Status, number>>;
}

export interface KanbanModel {
  board: KanbanBoard;
  swimlane: KanbanSwimlane;
  cardMode: KanbanCardMode;
  showCancelled: boolean;
  columns: KanbanColumn[];
  lanes: KanbanLane[];
  total: number;
  /** Cards hidden by the filter. */
  hidden: number;
  today: string;
  people: Array<{ id: string; name: string }>;
  milestones: Array<{ id: string; title: string }>;
  tags: string[];
  filter: TaskFilter;
  projectName: string;
}

const SEV_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

export function buildKanbanModel(
  plan: Plan,
  schedule: Schedule | undefined,
  options: KanbanOptions
): KanbanModel {
  const filter = options.filter ?? {};
  const today = schedule ? formatDate(schedule.today) : "";
  const personIndex = new Map(plan.people.map((p, i) => [p.id.toLowerCase(), i]));
  const items =
    options.board === "punch"
      ? plan.punch.filter((t) => !t.parent)
      : options.cardMode === "leaves"
        ? plan.tasks.filter((t) => isLeaf(t))
        : plan.tasks.filter((t) => !t.parent);
  const columnsShown = KANBAN_COLUMNS.filter((s) => s !== "cancelled" || options.showCancelled);
  const overtime = schedule ? taskOvertime(schedule) : new Map<string, TaskOvertime>();
  const overtimeOf = (t: Task) => {
    const hours = (isLeaf(t) ? [t] : leavesOf(t)).reduce(
      (s, l) => s + (overtime.get(taskKey(l))?.hours ?? 0),
      0
    );
    return hours > 0.05 ? Math.round(hours * 10) / 10 : undefined;
  };

  const card = (t: Task): KanbanCard => {
    const owner = ownerOf(t);
    const person = owner ? plan.personById(owner) : undefined;
    const pi = owner ? personIndex.get(owner.toLowerCase()) : undefined;
    const est = estimateHours(t);
    const act = actualHours(t);
    const fmt = (n: number) => String(Math.round(n * 100) / 100);
    const hours =
      est === undefined
        ? act
          ? `${fmt(act)}h`
          : ""
        : act
          ? `${fmt(act)}/${fmt(est)}h`
          : `${fmt(est)}h`;
    const ts = schedule?.tasks.get(t);
    const due = t.kind === "punch" ? t.due : (t.due ?? deadlineOf(plan, t));
    const finish = ts?.finish !== undefined ? formatDate(ts.finish) : undefined;
    const late =
      isOpen(t.status) &&
      ((due !== undefined && due < today) ||
        (ts?.late ?? false) ||
        (t.kind !== "punch" &&
          !isLeaf(t) &&
          leavesOf(t).some((l) => schedule?.tasks.get(l)?.late)));
    const kids = t.children.filter((c) => c.status !== "cancelled");
    return {
      key: taskKey(t),
      id: t.id,
      title: t.title || "(untitled)",
      status: t.status,
      prio: t.prio,
      owner,
      ownerName: person?.name ?? owner,
      ownerInitials: owner ? initials(person?.name ?? owner) : undefined,
      ownerColor: pi === undefined ? NEUTRAL : personColor(plan.people[pi].color, pi),
      hours,
      // Deadlines matter for open work only.
      due: isOpen(t.status) ? (t.due ?? (t.kind === "punch" ? undefined : due)) : undefined,
      late,
      tags: t.tags.map((x) => x.tag),
      subtasks: kids.length
        ? { done: kids.filter((c) => c.status === "done").length, total: kids.length }
        : undefined,
      milestone: t.milestoneId,
      parentTitle: options.cardMode === "leaves" && t.parent ? t.parent.title : undefined,
      blocked: t.blocked,
      sev: t.sev,
      from: t.from,
      finish,
      overtime: t.kind === "punch" ? undefined : overtimeOf(t),
    };
  };

  const laneOf = (t: Task): { key: string; title: string } => {
    switch (options.swimlane) {
      case "owner": {
        const o = ownerOf(t)?.toLowerCase();
        if (!o || o === UNASSIGNED) return { key: UNASSIGNED, title: "Unassigned" };
        return { key: o, title: plan.personById(o)?.name ?? o };
      }
      case "milestone": {
        const m = plan.milestoneById(t.milestoneId);
        return { key: m?.id ?? "", title: m?.title ?? "No milestone" };
      }
      case "severity":
        return t.sev
          ? { key: t.sev, title: `Severity ${t.sev}` }
          : { key: "", title: "No severity" };
      default:
        return { key: "all", title: "" };
    }
  };

  const lanes = new Map<string, KanbanLane>();
  // Stable lane order: team / milestones / severities first, then whatever appears.
  if (options.swimlane === "owner")
    for (const p of plan.people)
      lanes.set(p.id.toLowerCase(), { key: p.id.toLowerCase(), title: p.name, cards: {} });
  if (options.swimlane === "milestone")
    for (const m of plan.milestones) lanes.set(m.id, { key: m.id, title: m.title, cards: {} });
  if (options.swimlane === "severity")
    for (const s of ["A", "B", "C"]) lanes.set(s, { key: s, title: `Severity ${s}`, cards: {} });

  let total = 0;
  let hidden = 0;
  for (const t of items) {
    if (!columnsShown.includes(t.status)) continue;
    total++;
    if (!matchesFilter(t, filter)) {
      hidden++;
      continue;
    }
    const lane = laneOf(t);
    let l = lanes.get(lane.key);
    if (!l) lanes.set(lane.key, (l = { key: lane.key, title: lane.title, cards: {} }));
    (l.cards[t.status] ??= []).push(card(t));
  }
  const sortCards = (a: KanbanCard, b: KanbanCard, ta: Task, tb: Task) =>
    (options.board === "punch" ? (SEV_RANK[a.sev ?? ""] ?? 3) - (SEV_RANK[b.sev ?? ""] ?? 3) : 0) ||
    PRIORITY_RANK[a.prio] - PRIORITY_RANK[b.prio] ||
    ta.order - tb.order;
  const byKey = new Map(items.map((t) => [taskKey(t), t]));
  for (const l of lanes.values()) {
    for (const s of Object.keys(l.cards) as Status[]) {
      l.cards[s]!.sort((a, b) => sortCards(a, b, byKey.get(a.key)!, byKey.get(b.key)!));
    }
  }
  const laneList = [...lanes.values()].filter(
    (l) => options.swimlane === "none" || Object.values(l.cards).some((c) => c && c.length > 0)
  );

  const columns: KanbanColumn[] = columnsShown.map((s) => {
    const count = laneList.reduce((n, l) => n + (l.cards[s]?.length ?? 0), 0);
    const wip = options.wipLimits?.[s];
    return {
      status: s,
      title: COLUMN_TITLE[s],
      count,
      wip,
      over: wip !== undefined && count > wip,
    };
  });

  return {
    board: options.board,
    swimlane: options.swimlane,
    cardMode: options.cardMode,
    showCancelled: options.showCancelled,
    columns,
    lanes: laneList.length ? laneList : [{ key: "all", title: "", cards: {} }],
    total,
    hidden,
    today,
    people: plan.people.map((p) => ({ id: p.id, name: p.name })),
    milestones: plan.milestones.map((m) => ({ id: m.id, title: m.title })),
    tags: plan.tags,
    filter,
    projectName: plan.project.name,
  };
}

/**
 * Priority for a card dropped between two neighbours within a column: the card it lands after
 * (else the card it lands before). Returns undefined when nothing changes.
 */
export function priorityForDrop(
  current: Priority,
  before: Priority | undefined,
  after: Priority | undefined
): Priority | undefined {
  const target = before ?? after;
  if (!target || target === current) return undefined;
  return target;
}
