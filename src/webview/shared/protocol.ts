// Typed messages between the extension host and the webviews (discriminated unions).
// Webviews never touch files: every change is a message that the host turns into a WorkspaceEdit.
import { type TaskFilter } from "../../core/filter";
import { type Priority, type Status } from "../../core/model";
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
  /** `undo`: the notice reports an edit and offers to undo it. */
  | { type: "notice"; level: "info" | "error"; message: string; undo?: boolean };

export type CommonWebviewMessage =
  { type: "ready" } | { type: "reveal"; key: string } | { type: "undo" } | { type: "redo" };

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
  | { type: "edit"; key: string; title?: string; owner?: string | null; estimate?: string }
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
