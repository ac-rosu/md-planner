// Typed messages between the extension host and the webviews (discriminated unions).
// Webviews never touch files: every change is a message that the host turns into a WorkspaceEdit.
import { type TaskFilter } from "../../core/filter";
import { type Priority, type Status, STATUSES } from "../../core/model";
import { type GanttGrouping, type GanttModel, type GanttOrder } from "../../core/views/gantt";
import { type DashboardModel } from "../../core/views/dashboard";
import { type ResourcesModel } from "../../core/views/resources";
import { type RunnerModel } from "../../core/views/testRunner";
import {
  type KanbanBoard,
  type KanbanCardMode,
  type KanbanModel,
  type KanbanSwimlane,
} from "../../core/views/kanban";

// ---------------------------------------------------------------------------------------------
// Messages every webview understands

export type CommonHostMessage =
  | { type: "history"; canUndo: boolean; canRedo: boolean }
  /** `undo`: the notice reports this edit of the history and offers to undo it. */
  | { type: "notice"; level: "info" | "error"; message: string; undo?: number };

export type CommonWebviewMessage =
  | { type: "ready" }
  | { type: "reveal"; key: string }
  /** With `entry` (the Undo button of a notice): only that edit, while it is the last one. */
  | { type: "undo"; entry?: number }
  | { type: "redo" };

// ---------------------------------------------------------------------------------------------
// Gantt

export type GanttColorMode = "owner" | "status" | "milestone";
export type GanttZoom = "day" | "week" | "month" | "quarter";

export interface GanttViewOptions {
  grouping: GanttGrouping;
  /** Rows by scheduled start (a cascade) or as in the files. */
  order: GanttOrder;
  color: GanttColorMode;
  zoom: GanttZoom;
  /** Set by "fit to project"; overrides the zoom's default pixels per day. */
  pxPerDay?: number;
  showCritical: boolean;
  showBaseline: boolean;
  hideDone: boolean;
  /** Baseline file name (without extension); undefined = latest. */
  baseline?: string;
}

export const DEFAULT_GANTT_OPTIONS: GanttViewOptions = {
  grouping: "milestone",
  order: "schedule",
  color: "owner",
  zoom: "week",
  showCritical: true,
  showBaseline: true,
  hideDone: false,
};

export type HostToGantt =
  | CommonHostMessage
  | {
      type: "model";
      model: GanttModel;
      options: GanttViewOptions;
      baselines: string[];
    }
  | { type: "focus"; key: string };

export type GanttToHost =
  | CommonWebviewMessage
  | { type: "options"; options: GanttViewOptions }
  | { type: "move"; key: string; start: string }
  | { type: "resize"; key: string; finish: string }
  | { type: "link"; from: string; to: string }
  | { type: "unlink"; from: string; to: string }
  /**
   * The inline edit dialog: only the fields changed in it. `original` is the title the task had
   * when the dialog opened: a task without id is known by its line, which may hold another task by
   * now, and a new title must not undo a change made meanwhile.
   */
  | {
      type: "edit";
      key: string;
      original?: string;
      title?: string;
      owner?: string | null;
      estimate?: string;
    }
  /** Open the full edit form (all fields) for a task. */
  | { type: "editAll"; key: string };

// ---------------------------------------------------------------------------------------------
// Kanban

export interface KanbanViewOptions {
  board: KanbanBoard;
  swimlane: KanbanSwimlane;
  showCancelled: boolean;
  cardMode: KanbanCardMode;
}

export const DEFAULT_KANBAN_OPTIONS: KanbanViewOptions = {
  board: "tasks",
  swimlane: "none",
  showCancelled: false,
  cardMode: "tasks",
};

export type HostToKanban =
  | CommonHostMessage
  | { type: "model"; model: KanbanModel; options: KanbanViewOptions }
  | { type: "focus"; key: string };

export type KanbanToHost =
  | CommonWebviewMessage
  | { type: "options"; options: KanbanViewOptions }
  | { type: "filter"; filter: TaskFilter }
  | {
      type: "move";
      key: string;
      status: Status;
      /** Lane the card was dropped in (owner swimlanes reassign the owner). */
      lane?: string;
      /** Cards directly above and below the drop position in the target column. */
      above?: string;
      below?: string;
      /** Reason when moved to Blocked. */
      reason?: string;
    }
  | { type: "priority"; key: string; prio: Priority }
  /** "+" in a column header: add a task (or punch item) with that status. */
  | { type: "add"; status: Status }
  /** Double-click or F2 on a card: the full edit form. */
  | { type: "edit"; key: string }
  /** Click on the owner chip: choose the owner. */
  | { type: "assign"; key: string };

// ---------------------------------------------------------------------------------------------
// Resources (team heatmap)

export type HostToResources = CommonHostMessage | { type: "model"; model: ResourcesModel };

export type ResourcesToHost =
  | CommonWebviewMessage
  | { type: "mode"; mode: "capacity" | "demand" }
  /** Plan overtime or an extra working day for a person in an ISO week (`2026-W44`). */
  | { type: "overtime"; person: string; week: string }
  | { type: "workday"; person: string; week: string };

// ---------------------------------------------------------------------------------------------
// Dashboard

export type PlannerView = "gantt" | "kanban" | "resources" | "punch";

export type HostToDashboard =
  | CommonHostMessage
  | { type: "model"; model: DashboardModel; baselines: string[]; baseline?: string };

export type DashboardToHost =
  | CommonWebviewMessage
  | { type: "baseline"; name?: string }
  | { type: "open"; view: PlannerView }
  | { type: "saveBaseline" }
  /** Opens the project form (to set the budget). */
  | { type: "editProject" };

// ---------------------------------------------------------------------------------------------
// Test runner

export type HostToRunner = CommonHostMessage | { type: "model"; model: RunnerModel };

export type RunnerToHost =
  | CommonWebviewMessage
  | { type: "selectPlan"; id: string }
  | { type: "result"; step: string; result: "pass" | "fail" | "na" | null; note?: string }
  | { type: "note"; step: string; note: string }
  | {
      type: "createPunch";
      step: string;
      title: string;
      sev: "A" | "B" | "C";
      owner?: string;
      due?: string;
    }
  | { type: "finishRun"; date: string; tester: string; witness?: string }
  | { type: "reset" }
  | { type: "openFile" }
  | { type: "export"; format: "html" | "pdf" };

// ---------------------------------------------------------------------------------------------
// Stored view state. Options and filters come from the webview and are kept in the workspace
// state, so a board or chart opens as it was left. Each value is checked when it arrives and when
// it is read back: one the views cannot use (from an older version, or a message that went wrong)
// would otherwise break the view every time it opens. What is not valid gets its default.

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Gantt options as stored or sent: every field checked, defaults for the rest. */
export function ganttOptionsFrom(value: unknown): GanttViewOptions {
  const v = isPlain(value) ? value : {};
  const d = DEFAULT_GANTT_OPTIONS;
  const options: GanttViewOptions = {
    grouping: oneOf<GanttGrouping>(
      v.grouping,
      ["milestone", "section", "owner", "tag"],
      d.grouping
    ),
    order: oneOf<GanttOrder>(v.order, ["schedule", "file"], d.order),
    color: oneOf<GanttColorMode>(v.color, ["owner", "status", "milestone"], d.color),
    zoom: oneOf<GanttZoom>(v.zoom, ["day", "week", "month", "quarter"], d.zoom),
    showCritical: flag(v.showCritical, d.showCritical),
    showBaseline: flag(v.showBaseline, d.showBaseline),
    hideDone: flag(v.hideDone, d.hideDone),
  };
  if (typeof v.pxPerDay === "number" && Number.isFinite(v.pxPerDay) && v.pxPerDay > 0)
    options.pxPerDay = v.pxPerDay;
  if (typeof v.baseline === "string") options.baseline = v.baseline;
  return options;
}

/** Kanban options as stored or sent: every field checked, defaults for the rest. */
export function kanbanOptionsFrom(value: unknown): KanbanViewOptions {
  const v = isPlain(value) ? value : {};
  const d = DEFAULT_KANBAN_OPTIONS;
  return {
    board: oneOf<KanbanBoard>(v.board, ["tasks", "punch"], d.board),
    swimlane: oneOf<KanbanSwimlane>(
      v.swimlane,
      ["none", "owner", "milestone", "severity"],
      d.swimlane
    ),
    showCancelled: flag(v.showCancelled, d.showCancelled),
    cardMode: oneOf<KanbanCardMode>(v.cardMode, ["tasks", "leaves"], d.cardMode),
  };
}

/** A filter as stored or sent: lists of text (known statuses only) and a text, nothing else. */
export function taskFilterFrom(value: unknown): TaskFilter {
  const v = isPlain(value) ? value : {};
  const list = (x: unknown) =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  const filter: TaskFilter = {};
  const owner = list(v.owner);
  const tag = list(v.tag);
  const status = list(v.status).filter((s): s is Status => STATUSES.includes(s as Status));
  const milestone = list(v.milestone);
  if (owner.length) filter.owner = owner;
  if (tag.length) filter.tag = tag;
  if (status.length) filter.status = status;
  if (milestone.length) filter.milestone = milestone;
  if (typeof v.text === "string" && v.text !== "") filter.text = v.text;
  return filter;
}

/** The Kanban filter of each board, as stored. */
export function boardFiltersFrom(value: unknown): Partial<Record<KanbanBoard, TaskFilter>> {
  const v = isPlain(value) ? value : {};
  const out: Partial<Record<KanbanBoard, TaskFilter>> = {};
  for (const board of ["tasks", "punch"] as const)
    if (v[board] !== undefined) out[board] = taskFilterFrom(v[board]);
  return out;
}
