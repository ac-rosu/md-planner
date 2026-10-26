// Builds the semantic Plan from parsed files: interprets property values and task attributes with
// the project settings (hours per day, workweek) and links everything by id.
import { type DayNumber, isoWeekday, parseDate, parseDateRange, parseWorkweek } from "./dates";
import {
  parseCapacity,
  parseDeps,
  parseDuration,
  parseExtraCapacity,
  parsePercent,
} from "./duration";
import {
  type Attr,
  type CapacityChange,
  type ExtraWorkday,
  type InboxFile,
  type Issue,
  type Milestone,
  type MilestoneFile,
  type MilestoneStatus,
  type Overtime,
  type ParsedFile,
  type Person,
  type Priority,
  type Project,
  type ProjectFile,
  type PropertyBlock,
  type PropertyEntry,
  type PunchFile,
  type Task,
  type TeamFile,
  type TestFile,
  type TestPlan,
} from "./model";
import { getProp, getProps, splitList } from "./parser/properties";
import { assignBudgets } from "./rollup";

export interface Plan {
  files: ParsedFile[];
  project: Project;
  people: Person[];
  milestones: Milestone[];
  /** All milestone tasks, depth-first in plan order (milestones sorted by id). */
  tasks: Task[];
  tests: TestPlan[];
  punch: Task[];
  inbox: Task[];
  issues: Issue[];
  /** All tags in use, sorted. */
  tags: string[];
  personById(id: string | undefined): Person | undefined;
  milestoneById(id: string | undefined): Milestone | undefined;
  taskById(id: string | undefined): Task | undefined;
  testById(id: string | undefined): TestPlan | undefined;
  punchById(id: string | undefined): Task | undefined;
  file(path: string): ParsedFile | undefined;
}

export const DEFAULT_HOURS_PER_DAY = 8;
export const DEFAULT_WORKWEEK = "mon-fri";
export const MILESTONE_STATUSES: readonly MilestoneStatus[] = [
  "planned",
  "active",
  "done",
  "cancelled",
];

/** Natural comparison so that M2 sorts before M10. */
export function naturalCompare(a: string, b: string): number {
  return (
    a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0)
  );
}

export function resolvePlan(input: Iterable<ParsedFile>): Plan {
  const files = [...input].sort((a, b) => naturalCompare(a.path, b.path));
  const issues: Issue[] = [];
  for (const f of files) issues.push(...f.issues);

  const projectFile = files.find((f): f is ProjectFile => f.kind === "project");
  const project = resolveProject(projectFile, issues);
  const hpd = project.hoursPerDay;

  const teamFile = files.find((f): f is TeamFile => f.kind === "team");
  const people = teamFile ? resolveTeam(teamFile, project, issues) : [];

  const milestones = files
    .filter((f): f is MilestoneFile => f.kind === "milestone")
    .map((f) => resolveMilestone(f, issues))
    .sort((a, b) => naturalCompare(a.id, b.id) || naturalCompare(a.file, b.file));

  const tasks: Task[] = [];
  let order = 0;
  for (const m of milestones) {
    const file = files.find((f) => f.path === m.file)!;
    for (const t of file.items) {
      t.milestoneId = m.id;
      t.order = order++;
      resolveItem(t, hpd, issues);
      tasks.push(t);
    }
  }

  const tests = files
    .filter((f): f is TestFile => f.kind === "test")
    .map((f) => resolveTest(f, hpd, issues))
    .sort((a, b) => naturalCompare(a.id, b.id));

  const punch: Task[] = [];
  const inbox: Task[] = [];
  for (const f of files) {
    if (f.kind === "punch" || f.kind === "inbox") {
      const target = (f as PunchFile | InboxFile).kind === "punch" ? punch : inbox;
      for (const t of f.items) {
        t.order = order++;
        resolveItem(t, hpd, issues);
        target.push(t);
      }
    }
  }

  assignBudgets([...tasks, ...punch, ...inbox]);

  const tagSet = new Set<string>();
  for (const t of [...tasks, ...punch, ...inbox]) for (const tag of t.tags) tagSet.add(tag.tag);

  const byLower = <T>(items: T[], key: (x: T) => string) => {
    const map = new Map<string, T>();
    for (const x of items) {
      const k = key(x).toLowerCase();
      if (!map.has(k)) map.set(k, x);
    }
    return (id: string | undefined) => (id === undefined ? undefined : map.get(id.toLowerCase()));
  };
  const byExact = <T>(items: T[], key: (x: T) => string | undefined) => {
    const map = new Map<string, T>();
    for (const x of items) {
      const k = key(x);
      if (k !== undefined && !map.has(k)) map.set(k, x);
    }
    return (id: string | undefined) => (id === undefined ? undefined : map.get(id));
  };
  const fileMap = new Map(files.map((f) => [f.path, f]));

  return {
    files,
    project,
    people,
    milestones,
    tasks,
    tests,
    punch,
    inbox,
    issues,
    tags: [...tagSet].sort(naturalCompare),
    personById: byLower(people, (p) => p.id),
    milestoneById: byLower(milestones, (m) => m.id),
    taskById: byExact(tasks, (t) => t.id),
    testById: byLower(tests, (t) => t.id),
    punchById: byExact(punch, (t) => t.id),
    file: (path) => fileMap.get(path),
  };
}

function issue(
  issues: Issue[],
  file: string,
  entry: { valueRange: Issue["range"] },
  code: string,
  message: string,
  severity: Issue["severity"] = "error",
  data?: Record<string, string>
): void {
  issues.push({ file, range: entry.valueRange, severity, code, message, data });
}

function dateProp(
  file: string,
  block: PropertyBlock,
  key: string,
  issues: Issue[]
): string | undefined {
  const e = getProp(block, key);
  if (!e || e.value === "") return undefined;
  if (parseDate(e.value) === undefined) {
    issue(issues, file, e, "invalid-date", `Invalid date "${e.value}" (expected YYYY-MM-DD).`);
    return undefined;
  }
  return e.value;
}

function dateRanges(
  file: string,
  entries: PropertyEntry[],
  issues: Issue[]
): Array<[DayNumber, DayNumber]> {
  const ranges: Array<[DayNumber, DayNumber]> = [];
  for (const e of entries) {
    for (const part of splitList(e.value)) {
      const r = parseDateRange(part);
      if (r) ranges.push(r);
      else
        issue(
          issues,
          file,
          e,
          "invalid-date",
          `Invalid date or range "${part}" (expected YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD).`
        );
    }
  }
  return ranges;
}

export function resolveProject(file: ProjectFile | undefined, issues: Issue[]): Project {
  const props: PropertyBlock = file?.props ?? { headingLine: -1, entries: [], insertLine: 0 };
  const path = file?.path ?? "project.md";
  let hoursPerDay = DEFAULT_HOURS_PER_DAY;
  const hpd = getProp(props, "hoursPerDay");
  if (hpd && hpd.value !== "") {
    const n = Number(hpd.value.replace(/h$/i, ""));
    if (Number.isFinite(n) && n > 0 && n <= 24) hoursPerDay = n;
    else
      issue(issues, path, hpd, "invalid-value", `hoursPerDay must be a number between 0 and 24.`);
  }
  let workweekText = DEFAULT_WORKWEEK;
  let workweek = parseWorkweek(DEFAULT_WORKWEEK)!;
  const ww = getProp(props, "workweek");
  if (ww && ww.value !== "") {
    const parsed = parseWorkweek(ww.value);
    if (parsed && parsed.size > 0) {
      workweek = parsed;
      workweekText = ww.value;
    } else {
      issue(issues, path, ww, "invalid-value", `Invalid workweek "${ww.value}" (e.g. mon-fri).`);
    }
  }
  let budget: number | undefined;
  const b = getProp(props, "budget");
  if (b && b.value !== "") {
    budget = parseBudget(b.value, hoursPerDay);
    const readings = ambiguousBudget(b.value);
    if (budget === undefined)
      issue(
        issues,
        path,
        b,
        "invalid-value",
        readings
          ? `Budget "${b.value}" can mean ${readings[0]} or ${readings[1]}: write the one you mean.`
          : `Invalid budget "${b.value}": hours such as 1200h, or days or weeks (150d, 30w).`
      );
  }
  const start = dateProp(path, props, "start", issues);
  const end = dateProp(path, props, "end", issues);
  if (start && end && end < start) {
    issue(
      issues,
      path,
      getProp(props, "end")!,
      "invalid-value",
      "Project end is before its start."
    );
  }
  return {
    file: path,
    name: file?.title ?? "Project",
    props,
    code: getProp(props, "code")?.value || undefined,
    start,
    end,
    workweek,
    workweekText,
    hoursPerDay,
    holidays: dateRanges(
      path,
      getProps(props, "holidays").concat(getProps(props, "holiday")),
      issues
    ),
    budget,
    template: getProp(props, "template")?.value || undefined,
    phases: file?.phases ?? [],
  };
}

/**
 * `1200h`, `150d`, `30w` or a plain number of hours; undefined when invalid or not positive. The
 * number may have a decimal point or a decimal comma (`12.5h`, `12,5h`), and thousands separators
 * where they cannot be decimals (`1,200,000h`, `1.200,5h`). One separator before three digits
 * (`1,200h`, `1.200h`) is 1200 to some and 1.2 to others: undefined.
 */
export function parseBudget(text: string, hoursPerDay: number): number | undefined {
  const m = /^([\d.,]+)([hdw]?)$/i.exec(text.trim());
  const n = m ? parseAmount(m[1]) : undefined;
  if (!m || n === undefined) return undefined;
  const hours = m[2] ? parseDuration(`${n}${m[2]}`, hoursPerDay) : n;
  return hours !== undefined && hours > 0 ? hours : undefined;
}

/** `1,200h` or `1.200h`: the two readings of a budget that parseBudget leaves undecided. */
export function ambiguousBudget(text: string): [string, string] | undefined {
  const m = /^([1-9]\d{0,2})[.,](\d{3})([hdw]?)$/i.exec(text.trim());
  return m ? [`${m[1]}${m[2]}${m[3]}`, `${Number(`${m[1]}.${m[2]}`)}${m[3]}`] : undefined;
}

/** See parseBudget: digits with a decimal point or comma, and thousands separators. */
function parseAmount(text: string): number | undefined {
  if (!/^\d+(?:[.,]\d+)*$/.test(text)) return undefined;
  const runs = text.split(/[.,]/);
  const seps = text.replace(/\d+/g, "");
  if (seps === "") return Number(text);
  // Groups of three digits after the first one to three, between the given runs.
  const grouped = (upTo: number) =>
    /^[1-9]\d{0,2}$/.test(runs[0]) && runs.slice(1, upTo).every((r) => r.length === 3);
  const mark = seps[seps.length - 1];
  if (seps.length === 1) return grouped(2) ? undefined : Number(`${runs[0]}.${runs[1]}`);
  if ([...seps].every((s) => s === mark))
    return grouped(runs.length) ? Number(runs.join("")) : undefined;
  // Thousands separators, then the other character as the decimal mark.
  if (seps.slice(0, -1).includes(mark) || !grouped(runs.length - 1)) return undefined;
  return Number(`${runs.slice(0, -1).join("")}.${runs[runs.length - 1]}`);
}

/** `2026-11-02..2026-11-27 +8h/week` or `2026-11-05 +2h/day`: a period and the extra hours. */
export function parseOvertime(text: string): Overtime | undefined {
  const m = /^(\S+)\s+(.+)$/.exec(text.trim());
  const range = m ? parseDateRange(m[1]) : undefined;
  const spec = m ? parseExtraCapacity(m[2]) : undefined;
  return range && spec
    ? { from: range[0], to: range[1], hours: spec.hours, per: spec.per }
    : undefined;
}

/** `2026-11-07`, `2026-11-07 6h` or `2026-11-07..2026-11-08 4h`: days worked and their hours. */
export function parseWorkday(text: string, hoursPerDay: number): ExtraWorkday | undefined {
  const m = /^(\S+)(?:\s+(.+))?$/.exec(text.trim());
  const range = m ? parseDateRange(m[1]) : undefined;
  if (!m || !range) return undefined;
  if (m[2] === undefined) return { from: range[0], to: range[1] };
  const hours = parseDuration(m[2], hoursPerDay);
  return hours !== undefined && hours > 0 && hours <= 24
    ? { from: range[0], to: range[1], hours }
    : undefined;
}

const inRanges = (ranges: Array<[DayNumber, DayNumber]>, day: DayNumber) =>
  ranges.some(([a, b]) => day >= a && day <= b);

export function personIdFromName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function resolveTeam(file: TeamFile, project: Project, issues: Issue[]): Person[] {
  const people: Person[] = [];
  const seen = new Map<string, number>();
  for (const p of file.people) {
    const props = p.props;
    const idEntry = getProp(props, "id");
    const id = idEntry?.value || personIdFromName(p.name);
    if (seen.has(id.toLowerCase())) {
      issues.push({
        file: file.path,
        range: idEntry?.valueRange ?? {
          start: { line: p.headingLine, character: 0 },
          end: { line: p.headingLine, character: file.lines.line(p.headingLine).length },
        },
        severity: "error",
        code: "duplicate-person",
        message: `Duplicate person id "${id}".`,
      });
    }
    seen.set(id.toLowerCase(), p.headingLine);

    let workweek: Set<number> | undefined;
    const ww = getProp(props, "workweek");
    if (ww && ww.value) {
      workweek = parseWorkweek(ww.value);
      if (!workweek)
        issue(issues, file.path, ww, "invalid-value", `Invalid workweek "${ww.value}".`);
    }
    const daysPerWeek = (workweek ?? project.workweek).size;
    let capacityHours = project.hoursPerDay * daysPerWeek;
    let capacityPer: "week" | "day" = "week";
    const cap = getProp(props, "capacity");
    if (cap && cap.value) {
      const spec = parseCapacity(cap.value);
      if (spec) {
        capacityHours = spec.hours;
        capacityPer = spec.per;
      } else {
        issue(
          issues,
          file.path,
          cap,
          "invalid-duration",
          `Invalid capacity "${cap.value}" (e.g. 32h/week or 6h/day).`
        );
      }
    }
    const capacityChanges: CapacityChange[] = [];
    for (const e of getProps(props, "capacityFrom")) {
      const m = /^(\S+)\s+(.+)$/.exec(e.value);
      const from = m ? parseDate(m[1]) : undefined;
      const spec = m ? parseCapacity(m[2]) : undefined;
      if (from === undefined || !spec) {
        issue(
          issues,
          file.path,
          e,
          "invalid-value",
          `Invalid capacityFrom "${e.value}" (e.g. 2027-01-01 24h/week).`
        );
      } else {
        capacityChanges.push({ from, hours: spec.hours, per: spec.per });
      }
    }
    capacityChanges.sort((a, b) => a.from - b.from);
    const off = dateRanges(file.path, getProps(props, "off"), issues);
    const week = workweek ?? project.workweek;
    const regular = (d: DayNumber) => week.has(isoWeekday(d)) && !inRanges(project.holidays, d);
    const overtime: Overtime[] = [];
    for (const e of getProps(props, "overtime")) {
      const o = parseOvertime(e.value);
      if (!o) {
        issue(
          issues,
          file.path,
          e,
          "invalid-value",
          `Invalid overtime "${e.value}" (e.g. 2026-11-02..2026-11-27 +8h/week or 2026-11-05 +2h/day).`
        );
        continue;
      }
      let working = 0;
      for (let d = o.from; d <= o.to; d++) if (regular(d)) working++;
      if (working === 0)
        issue(
          issues,
          file.path,
          e,
          "overtime-no-working-days",
          `${p.name} has no working days in this period; use workday: for weekends and holidays.`,
          "warning"
        );
      overtime.push(o);
    }
    const workdays: ExtraWorkday[] = [];
    for (const e of getProps(props, "workday")) {
      const w = parseWorkday(e.value, project.hoursPerDay);
      if (!w) {
        issue(
          issues,
          file.path,
          e,
          "invalid-value",
          `Invalid workday "${e.value}" (e.g. 2026-11-07, 2026-11-07 6h or 2026-11-07..2026-11-08).`
        );
        continue;
      }
      let extra = 0;
      let away = 0;
      for (let d = w.from; d <= w.to; d++) {
        if (inRanges(off, d)) away++;
        else if (!regular(d)) extra++;
      }
      if (extra === 0)
        issue(
          issues,
          file.path,
          e,
          away > 0 ? "workday-during-time-off" : "workday-not-needed",
          away > 0
            ? `${p.name} is on time off then (off:); the workday is ignored.`
            : `${p.name} already works on these days: workday: adds weekends and holidays. For extra hours on a working day, use overtime: (e.g. +2h/day).`,
          "warning"
        );
      workdays.push(w);
    }
    people.push({
      id,
      name: p.name,
      file: file.path,
      headingLine: p.headingLine,
      props,
      role: getProp(props, "role")?.value || undefined,
      capacityHours,
      capacityPer,
      capacityChanges,
      skills: splitList(getProp(props, "skills")?.value ?? "").map((s) => s.toLowerCase()),
      color: getProp(props, "color")?.value || undefined,
      off,
      workweek,
      overtime,
      workdays,
    });
  }
  return people;
}

/** Milestone id: the `id:` property, else the `M<n>` prefix of the file name, else the file stem. */
export function milestoneIdFromPath(path: string): string {
  const stem = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  const m = /^(M\d+[A-Za-z]?)(?:[-_ ]|$)/i.exec(stem);
  return m ? m[1].toUpperCase() : stem;
}

function resolveMilestone(file: MilestoneFile, issues: Issue[]): Milestone {
  const props = file.props;
  const id = getProp(props, "id")?.value || milestoneIdFromPath(file.path);
  let status: MilestoneStatus = "planned";
  const st = getProp(props, "status");
  if (st && st.value) {
    const v = st.value.toLowerCase() as MilestoneStatus;
    if (MILESTONE_STATUSES.includes(v)) status = v;
    else
      issue(
        issues,
        file.path,
        st,
        "invalid-value",
        `Invalid milestone status "${st.value}" (planned | active | done | cancelled).`
      );
  }
  return {
    id,
    title: file.title,
    file: file.path,
    headingLine: file.headingLine,
    props,
    target: dateProp(file.path, props, "target", issues),
    status,
    depends: splitList(getProp(props, "depends")?.value ?? ""),
    description: file.description,
    sections: file.sections,
    tasks: file.roots,
    rootTasks: file.rootTasks,
  };
}

function resolveTest(file: TestFile, hpd: number, issues: Issue[]): TestPlan {
  const props = file.props;
  for (const step of file.items) resolveItem(step, hpd, issues);
  const stem = (file.path.split("/").pop() ?? file.path).replace(/\.md$/i, "");
  return {
    id: getProp(props, "id")?.value || stem,
    title: file.title,
    file: file.path,
    headingLine: file.headingLine,
    props,
    type: getProp(props, "type")?.value || undefined,
    milestone: getProp(props, "milestone")?.value || undefined,
    eq: getProp(props, "eq")?.value || undefined,
    witness: getProp(props, "witness")?.value || undefined,
    cases: file.cases,
    runs: file.runs,
  };
}

const KNOWN_KEYS = new Set([
  "est",
  "act",
  "owner",
  "dep",
  "start",
  "due",
  "prio",
  "progress",
  "started",
  "done",
  "blocked",
  "test",
  "eq",
  "src",
  "sev",
  "from",
  "result",
  "note",
  "punch",
]);

export function isKnownAttr(key: string): boolean {
  return KNOWN_KEYS.has(key);
}

const PRIORITY_ALIASES: Record<string, Priority> = {
  high: "high",
  h: "high",
  med: "med",
  medium: "med",
  m: "med",
  low: "low",
  l: "low",
};

/** Interprets a checkbox item's attributes. Resets previously resolved values first. */
export function resolveItem(t: Task, hoursPerDay: number, issues: Issue[]): void {
  t.est = t.act = t.owner = t.start = t.due = t.progress = undefined;
  t.started = t.done = t.blocked = t.test = t.eq = t.src = undefined;
  t.sev = t.from = t.result = t.note = t.punch = undefined;
  t.deps = [];
  t.prio = "med";
  t.custom = {};
  const seen = new Set<string>();
  for (const a of t.attrs) {
    if (seen.has(a.key)) {
      issues.push({
        file: t.file,
        range: a.range,
        severity: "warning",
        code: "duplicate-attr",
        message: `Duplicate @${a.key}; only the first one is used.`,
        data: { key: a.key },
      });
      continue;
    }
    seen.add(a.key);
    applyAttr(t, a, hoursPerDay, issues);
  }
}

function applyAttr(t: Task, a: Attr, hpd: number, issues: Issue[]): void {
  const bad = (code: string, message: string) =>
    issues.push({
      file: t.file,
      range: a.valueRange.start.character === a.valueRange.end.character ? a.range : a.valueRange,
      severity: "error",
      code,
      message,
      data: { key: a.key },
    });
  const v = a.value;
  switch (a.key) {
    case "est":
    case "act": {
      const h = parseDuration(v, hpd);
      if (h === undefined)
        bad("invalid-duration", `Invalid duration "${v}" for @${a.key} (e.g. 12h, 2d, 1w).`);
      else t[a.key] = h;
      return;
    }
    case "owner":
      if (v) t.owner = v;
      else bad("invalid-value", "@owner needs a person id.");
      return;
    case "dep": {
      t.deps = parseDeps(v, hpd);
      for (const d of t.deps)
        if (!d.valid) bad("invalid-value", `Invalid dependency "${d.raw}" (e.g. T101 or T101+2d).`);
      t.deps = t.deps.filter((d) => d.valid);
      return;
    }
    case "start":
    case "due":
    case "started":
    case "done":
      if (parseDate(v) === undefined)
        bad("invalid-date", `Invalid date "${v}" for @${a.key} (expected YYYY-MM-DD).`);
      else t[a.key] = v;
      return;
    case "prio": {
      const p = PRIORITY_ALIASES[v.toLowerCase()];
      if (p) t.prio = p;
      else bad("invalid-value", `Invalid priority "${v}" (high, med or low).`);
      return;
    }
    case "progress": {
      const p = parsePercent(v);
      if (p === undefined) bad("invalid-value", `Invalid progress "${v}" (0%–100%).`);
      else t.progress = p;
      return;
    }
    case "sev": {
      const s = v.toUpperCase();
      if (s === "A" || s === "B" || s === "C") t.sev = s;
      else bad("invalid-value", `Invalid severity "${v}" (A, B or C).`);
      return;
    }
    case "result": {
      const r = v.toLowerCase();
      if (r === "pass" || r === "fail" || r === "na") t.result = r;
      else bad("invalid-value", `Invalid result "${v}" (pass, fail or na).`);
      return;
    }
    case "blocked":
      // `@blocked:` or `@blocked:""` gives no reason: the same as no `@blocked` at all.
      t.blocked = v.trim() || undefined;
      return;
    case "test":
    case "eq":
    case "src":
    case "from":
    case "note":
    case "punch":
      t[a.key] = v;
      return;
    default:
      t.custom[a.key] = v;
  }
}
