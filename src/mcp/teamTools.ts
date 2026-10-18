// Team tools: people with capacity, work week, skills, colour, time off, capacity changes, overtime
// and extra working days; add, change and remove them.
import { formatDate, parseDate, parseDateRange, parseWorkweek } from "../core/dates";
import { parseCapacity } from "../core/duration";
import { weekLoadAt } from "../core/load";
import { type Person } from "../core/model";
import { openTasksOf } from "../core/queries";
import { type Plan, parseOvertime, parseWorkday, personIdFromName } from "../core/resolve";
import {
  addPerson,
  changePerson,
  type PersonChange,
  type PersonFields,
  removePerson as removePersonEdits,
} from "../core/writer/entities";
import { type Staging } from "./staging";
import { personOf } from "./taskSpecs";
import { type PlannerTools, ToolError } from "./tools";

export interface PersonInput {
  name: string;
  /** Used in @owner; default: the name in lower case with dashes. */
  id?: string;
  role?: string;
  /** e.g. 40h/week, 32h/week, 6h/day; default full time */
  capacity?: string;
  /** Own working days, e.g. mon-thu */
  workweek?: string;
  skills?: string[];
  color?: string;
  /** Dates or ranges from..to */
  timeOff?: string[];
  /** e.g. "2027-01-01 32h/week" */
  capacityChanges?: string[];
  /** e.g. "2026-11-02..2026-11-13 +8h/week" */
  overtime?: string[];
  /** Weekend days or holidays worked, e.g. "2026-11-28" or "2026-11-28 6h" */
  workdays?: string[];
}

export interface PersonUpdate extends Partial<PersonInput> {
  /** Person id or name. */
  id: string;
  addTimeOff?: string[];
  addCapacityChanges?: string[];
  addOvertime?: string[];
  addWorkdays?: string[];
}

function rawList(p: Person, key: string): string[] {
  return p.props.entries
    .filter((e) => e.key.toLowerCase() === key.toLowerCase())
    .map((e) => e.value.trim());
}

/** Checks the values of a person; problems are added to `errors`. */
function checkPerson(plan: Plan, p: Partial<PersonInput>, label: string, errors: string[]): void {
  const hpd = plan.project.hoursPerDay;
  if (p.capacity && !parseCapacity(p.capacity))
    errors.push(`${label}: invalid capacity "${p.capacity}" (e.g. 32h/week or 6h/day).`);
  if (p.workweek && !parseWorkweek(p.workweek))
    errors.push(`${label}: invalid work week "${p.workweek}" (e.g. mon-thu).`);
  for (const v of p.timeOff ?? [])
    if (!parseDateRange(v))
      errors.push(`${label}: invalid time off "${v}" (YYYY-MM-DD or from..to).`);
  for (const v of p.capacityChanges ?? []) {
    const m = /^(\S+)\s+(.+)$/.exec(v.trim());
    if (!m || parseDate(m[1]) === undefined || !parseCapacity(m[2]))
      errors.push(`${label}: invalid capacity change "${v}" (e.g. 2027-01-01 32h/week).`);
  }
  for (const v of p.overtime ?? [])
    if (!parseOvertime(v))
      errors.push(`${label}: invalid overtime "${v}" (e.g. 2026-11-02..2026-11-13 +8h/week).`);
  for (const v of p.workdays ?? [])
    if (!parseWorkday(v, hpd))
      errors.push(`${label}: invalid working day "${v}" (e.g. 2026-11-28 or 2026-11-28 6h).`);
  if (p.id !== undefined && !/^[a-z0-9][\w.-]*$/i.test(p.id))
    errors.push(`${label}: invalid id "${p.id}" (letters, digits, dots and dashes).`);
}

/** Stages new people one after the other (team.md is created when missing). */
export function stagePeople(st: Staging, people: PersonInput[]): string[] {
  const errors: string[] = [];
  people.forEach((p, i) => {
    if (!p.name?.trim()) errors.push(`Person ${i + 1}: a name is needed.`);
    checkPerson(st.plan, p, `Person ${i + 1} "${p.name ?? ""}"`, errors);
  });
  if (errors.length) throw new ToolError(errors.join("\n"));
  const ids: string[] = [];
  for (const p of people) {
    const fields: PersonFields = {
      name: p.name.trim(),
      id: p.id?.trim().toLowerCase(),
      role: p.role,
      capacity: p.capacity,
      workweek: p.workweek,
      skills: p.skills,
      color: p.color,
      off: p.timeOff,
      capacityFrom: p.capacityChanges,
      overtime: p.overtime,
      workday: p.workdays,
    };
    let creation;
    try {
      creation = addPerson(st.plan, fields);
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    if (creation.create) st.create(creation.create.path, creation.create.text);
    st.apply(creation.edits);
    ids.push((fields.id || personIdFromName(fields.name)).toLowerCase());
  }
  return ids;
}

/** Stages changes of one person (lists are replaced; add* lists are appended). */
export function stagePersonUpdate(st: Staging, u: PersonUpdate): string {
  const plan = st.plan;
  const id = personOf(plan, u.id);
  const person = id ? plan.personById(id) : undefined;
  if (!person)
    throw new ToolError(
      `Unknown person "${u.id}" (team: ${plan.people.map((p) => p.id).join(", ") || "none"}).`
    );
  const merge = (key: string, replace?: string[], add?: string[]) =>
    replace === undefined && add === undefined
      ? undefined
      : [...new Set([...(replace ?? rawList(person, key)), ...(add ?? [])])];
  const lists = {
    timeOff: merge("off", u.timeOff, u.addTimeOff),
    capacityChanges: merge("capacityFrom", u.capacityChanges, u.addCapacityChanges),
    overtime: merge("overtime", u.overtime, u.addOvertime),
    workdays: merge("workday", u.workdays, u.addWorkdays),
  };
  const errors: string[] = [];
  checkPerson(plan, { ...u, id: undefined, ...lists }, person.name, errors);
  if (errors.length) throw new ToolError(errors.join("\n"));
  const change: PersonChange = {
    name: u.name,
    role: u.role,
    capacity: u.capacity,
    workweek: u.workweek,
    skills: u.skills,
    color: u.color,
    off: lists.timeOff,
    capacityFrom: lists.capacityChanges,
    overtime: lists.overtime,
    workday: lists.workdays,
  };
  const file = plan.file(person.file)!;
  st.apply({ path: file.path, edits: changePerson(file.lines, person, change) });
  return person.id;
}

export function listPeople(tools: PlannerTools) {
  const plan = tools.load();
  const today = parseDate(tools.today)!;
  const range = (a: number, b: number) =>
    a === b ? formatDate(a) : `${formatDate(a)}..${formatDate(b)}`;
  return plan.people.map((p) => {
    const w = weekLoadAt(tools.schedule, p.id, today);
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      capacity: rawList(p, "capacity")[0] || `${p.capacityHours}h/${p.capacityPer} (full time)`,
      workweek: rawList(p, "workweek")[0] || undefined,
      skills: p.skills,
      color: p.color,
      timeOff: rawList(p, "off"),
      capacityChanges: rawList(p, "capacityFrom"),
      overtime: rawList(p, "overtime"),
      workdays: rawList(p, "workday"),
      openTasks: openTasksOf(plan, p.id).length,
      thisWeek: {
        week: w.week,
        hours: Math.round(w.hours * 10) / 10,
        capacity: Math.round(w.capacity * 10) / 10,
        overtimeScheduled: Math.round(w.overtime * 10) / 10,
      },
      upcomingTimeOff: p.off.filter(([, b]) => b >= today).map(([a, b]) => range(a, b)),
    };
  });
}

export function addPeople(tools: PlannerTools, args: { people: PersonInput[] }) {
  if (!args.people?.length) throw new ToolError("No people given.");
  const st = tools.stage();
  const ids = stagePeople(st, args.people);
  return { added: ids, changed: tools.commit(st) };
}

export function updatePerson(tools: PlannerTools, args: PersonUpdate) {
  const st = tools.stage();
  const id = stagePersonUpdate(st, args);
  return { id, changed: tools.commit(st) };
}

export function removePerson(tools: PlannerTools, args: { id: string; reassignTo?: string }) {
  const st = tools.stage();
  const plan = st.plan;
  const id = personOf(plan, args.id);
  const person = id ? plan.personById(id) : undefined;
  if (!person) throw new ToolError(`Unknown person "${args.id}".`);
  let to: string | undefined;
  if (args.reassignTo) {
    to = personOf(plan, args.reassignTo);
    if (!to || to === person.id)
      throw new ToolError(`Cannot reassign to "${args.reassignTo}" (not another team member).`);
  }
  const owned = [...plan.tasks, ...plan.punch, ...plan.inbox].filter(
    (t) => t.owner?.toLowerCase() === person.id.toLowerCase()
  );
  st.apply(removePersonEdits(plan, person, to));
  return {
    removed: person.id,
    reassigned: owned.map((t) => t.id ?? t.title),
    to: to ?? "unassigned",
    changed: tools.commit(st),
  };
}
