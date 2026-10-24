// Plan data model. Parsed objects keep exact source positions so the writer can make minimal edits.
import { type DepRef } from "./duration";
import { type Range, type TextLines } from "./text";

export type Status = "todo" | "doing" | "review" | "blocked" | "done" | "cancelled";

export const STATUSES: readonly Status[] = [
  "todo",
  "doing",
  "review",
  "blocked",
  "done",
  "cancelled",
];

export const STATUS_CHAR: Record<Status, string> = {
  todo: " ",
  doing: "/",
  review: "?",
  blocked: "!",
  done: "x",
  cancelled: "-",
};

export const STATUS_LABEL: Record<Status, string> = {
  todo: "To do",
  doing: "In progress",
  review: "Review / test",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

/** Maps a checkbox character to a status; undefined for characters the spec does not define. */
export function statusFromChar(ch: string): Status | undefined {
  switch (ch) {
    case " ":
      return "todo";
    case "/":
      return "doing";
    case "?":
      return "review";
    case "!":
      return "blocked";
    case "x":
    case "X":
      return "done";
    case "-":
      return "cancelled";
    default:
      return undefined;
  }
}

export function isOpen(status: Status): boolean {
  return status !== "done" && status !== "cancelled";
}

export type Priority = "high" | "med" | "low";
export const PRIORITY_RANK: Record<Priority, number> = { high: 0, med: 1, low: 2 };

export type Severity = "error" | "warning" | "info" | "hint";

/** A problem found while parsing or validating, attached to a source range. */
export interface Issue {
  file: string;
  range: Range;
  severity: Severity;
  code: string;
  message: string;
  /** Extra data for quick fixes (e.g. the attribute key or the broken dependency id). */
  data?: Record<string, string>;
}

export interface Attr {
  key: string;
  value: string;
  quoted: boolean;
  /** Whole token, `@key:value`. */
  range: Range;
  /** Value only (inside quotes when quoted). */
  valueRange: Range;
}

export interface TagRef {
  tag: string;
  range: Range;
}

export interface PropertyEntry {
  key: string;
  value: string;
  comment?: string;
  line: number;
  keyRange: Range;
  valueRange: Range;
}

export interface PropertyBlock {
  /** Line of the heading the block belongs to (-1 when the file has no heading). */
  headingLine: number;
  entries: PropertyEntry[];
  /** Line where a new property is inserted (after the last entry, or after the heading). */
  insertLine: number;
}

export type ItemKind = "task" | "punch" | "inbox" | "step";

export interface NoteLine {
  line: number;
  text: string;
}

/** Any checkbox item: milestone task, punch item, inbox item or test step. */
export interface Task {
  kind: ItemKind;
  file: string;
  line: number;
  /** Indentation width of the list marker. */
  indent: number;
  /** Leading whitespace as written. */
  indentText: string;
  /** The list marker, e.g. `-`, `*`, `1.`. */
  marker: string;
  statusChar: string;
  /** Column of the status character inside `[ ]`. */
  statusCol: number;
  status: Status;
  title: string;
  /** Ranges of the text tokens that make up the title. */
  titleRanges: Range[];
  attrs: Attr[];
  tags: TagRef[];
  id?: string;
  idRange?: Range;
  notes: NoteLine[];
  children: Task[];
  parent?: Task;
  /** Last line of the item's block (notes and nested items included). */
  endLine: number;
  /** Order of appearance across the whole plan (assigned when the plan is resolved). */
  order: number;

  // Context (set by the file parser)
  milestoneId?: string;
  section?: string;
  sectionLine?: number;

  // Resolved values (set by resolvePlan; hours are numbers)
  est?: number;
  /**
   * Hours of a subtask without `@est`: its share of the nearest parent's `@est` that the estimated
   * subtasks leave (see assignBudgets). Undefined when the task has its own estimate or no budget.
   */
  budget?: number;
  act?: number;
  owner?: string;
  deps: DepRef[];
  start?: string;
  due?: string;
  prio: Priority;
  progress?: number;
  started?: string;
  done?: string;
  blocked?: string;
  test?: string;
  eq?: string;
  src?: string;
  /** Unknown `@keys`, preserved and shown as custom fields. */
  custom: Record<string, string>;

  // Punch items
  sev?: string;
  from?: string;
  // Test steps
  result?: "pass" | "fail" | "na";
  note?: string;
  punch?: string;
}

export interface Section {
  title: string;
  line: number;
  /** Top-level tasks of the section. */
  tasks: Task[];
}

export type MilestoneStatus = "planned" | "active" | "done" | "cancelled";

export interface Milestone {
  id: string;
  title: string;
  file: string;
  headingLine: number;
  props: PropertyBlock;
  target?: string;
  status: MilestoneStatus;
  depends: string[];
  description: string[];
  sections: Section[];
  /** Top-level tasks (all sections, file order). */
  tasks: Task[];
  /** Top-level tasks that appear before the first `##` section. */
  rootTasks: Task[];
}

export interface PhaseRef {
  name: string;
  milestone?: string;
  line: number;
}

export interface Project {
  file: string;
  name: string;
  props: PropertyBlock;
  code?: string;
  start?: string;
  end?: string;
  workweek: Set<number>;
  workweekText: string;
  hoursPerDay: number;
  holidays: Array<[number, number]>;
  /** Hours budgeted for the whole project (`budget: 1200h`, `150d`, `30w` or a plain number). */
  budget?: number;
  template?: string;
  phases: PhaseRef[];
}

export interface CapacityChange {
  from: number;
  hours: number;
  per: "week" | "day";
}

/** Extra hours on top of the normal capacity during a period (`overtime:`). */
export interface Overtime {
  from: number;
  to: number;
  hours: number;
  per: "week" | "day";
}

/** Days the person works although they normally would not: weekends, holidays (`workday:`). */
export interface ExtraWorkday {
  from: number;
  to: number;
  /** Hours on each of these days; undefined = the hours of a normal working day. */
  hours?: number;
}

export interface Person {
  id: string;
  name: string;
  file: string;
  headingLine: number;
  props: PropertyBlock;
  role?: string;
  /** Base capacity. */
  capacityHours: number;
  capacityPer: "week" | "day";
  capacityChanges: CapacityChange[];
  skills: string[];
  color?: string;
  off: Array<[number, number]>;
  /** Person-specific workweek (ISO weekdays); falls back to the project workweek. */
  workweek?: Set<number>;
  overtime: Overtime[];
  workdays: ExtraWorkday[];
}

/** Test plan types: acceptance (user acceptance), FAT / SAT (factory and site acceptance), IT, unit. */
export const TEST_TYPES = ["acceptance", "FAT", "SAT", "IT", "unit"] as const;
export type TestType = (typeof TEST_TYPES)[number];

export interface TestRun {
  date: string;
  title: string;
  line: number;
  props: PropertyBlock;
}

export interface TestCase {
  id: string;
  title: string;
  line: number;
  props: PropertyBlock;
  pre?: string;
  steps: Task[];
}

export interface TestPlan {
  id: string;
  title: string;
  file: string;
  headingLine: number;
  props: PropertyBlock;
  type?: string;
  milestone?: string;
  eq?: string;
  witness?: string;
  cases: TestCase[];
  runs: TestRun[];
}

export type PlanFileKind = "project" | "team" | "milestone" | "test" | "punch" | "inbox";

export interface ParsedFileBase {
  path: string;
  kind: PlanFileKind;
  lines: TextLines;
  /** Problems detected while parsing (invalid values, unknown statuses…). */
  issues: Issue[];
  title: string;
  headingLine: number;
  props: PropertyBlock;
  /** All checkbox items in the file, depth-first in file order. */
  items: Task[];
  /** Top-level checkbox items. */
  roots: Task[];
}

export interface ProjectFile extends ParsedFileBase {
  kind: "project";
  phases: PhaseRef[];
}
export interface TeamFile extends ParsedFileBase {
  kind: "team";
  people: Array<{ name: string; headingLine: number; props: PropertyBlock }>;
}
export interface MilestoneFile extends ParsedFileBase {
  kind: "milestone";
  sections: Section[];
  rootTasks: Task[];
  description: string[];
}
export interface TestFile extends ParsedFileBase {
  kind: "test";
  cases: TestCase[];
  runs: TestRun[];
}
export interface PunchFile extends ParsedFileBase {
  kind: "punch";
}
export interface InboxFile extends ParsedFileBase {
  kind: "inbox";
}

export type ParsedFile = ProjectFile | TeamFile | MilestoneFile | TestFile | PunchFile | InboxFile;
