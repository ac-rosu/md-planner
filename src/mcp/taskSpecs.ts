// Task specifications from MCP clients (create_tasks, build_plan) turned into validated NewTasks:
// ids are assigned up front, so dependencies may name tasks of the same call by `ref` (or by
// title), with an optional lag (`ref+2d`); owners by id or name; subtasks nest to any depth.
// Every problem is collected and reported at once.
import { isValidDate } from "../core/dates";
import { parseDuration } from "../core/duration";
import { type Priority, STATUSES, type Status } from "../core/model";
import { type Plan } from "../core/resolve";
import { type NewTask, nextIds, noteLines, statusDateAttrs } from "../core/writer";
import { newTaskFrom } from "../core/writer/entities";

export interface TaskSpec {
  /** Local reference for dependsOn within the same call (any text, e.g. "fds-review"). */
  ref?: string;
  title: string;
  status?: Status;
  /** Estimate: 4h, 1.5d, 1w. */
  estimate?: string;
  /** Actual hours so far: 3h, 1d. */
  actual?: string;
  /** Person id or name. */
  owner?: string;
  tags?: string[];
  /** Task ids, refs or titles of tasks in the same call, each with an optional lag: T101+2d. */
  dependsOn?: string[];
  /** Fixed start ("not before"), YYYY-MM-DD. */
  start?: string;
  due?: string;
  priority?: Priority;
  /** Share done, e.g. 40%. */
  progress?: string;
  /** Reason, for status blocked. */
  blocked?: string;
  /** Any other @key:value attribute (eq, test, src, custom fields); "" is ignored. */
  attributes?: Record<string, string>;
  /** Description lines under the task. */
  notes?: string | string[];
  subtasks?: TaskSpec[];
}

/** Ids and refs shared by the steps of one call. */
export class TaskRefs {
  /** ref (lower case) → id */
  readonly byRef = new Map<string, string>();
  /** title (lower case) → id, for titles that are unique in the call */
  readonly byTitle = new Map<string, string | null>();
  readonly reserved = new Set<string>();
  readonly created: Array<{ ref?: string; id: string; title: string; milestone?: string }> = [];
}

const LAG = /^(.*?)(\+\d+(?:\.\d+)?[hdw])$/i;

/** Assigns ids to the specs (and their subtasks) and records refs and titles. */
export function allocateIds(
  plan: Plan,
  specs: TaskSpec[],
  refs: TaskRefs,
  milestone: string | undefined
): Map<TaskSpec, string> {
  const all: TaskSpec[] = [];
  const walk = (list: TaskSpec[]) => {
    for (const s of list) {
      all.push(s);
      walk(s.subtasks ?? []);
    }
  };
  walk(specs);
  const ids = nextIds(plan, "T", all.length, refs.reserved);
  const out = new Map<TaskSpec, string>();
  all.forEach((s, i) => {
    out.set(s, ids[i]);
    refs.reserved.add(ids[i]);
    if (s.ref?.trim()) refs.byRef.set(s.ref.trim().toLowerCase(), ids[i]);
    const title = s.title?.trim().toLowerCase();
    if (title) refs.byTitle.set(title, refs.byTitle.has(title) ? null : ids[i]);
    refs.created.push({ ref: s.ref, id: ids[i], title: s.title?.trim() ?? "", milestone });
  });
  return out;
}

/** Builds the NewTasks for specs whose ids were allocated; problems are added to `errors`. */
export function buildTasks(
  plan: Plan,
  specs: TaskSpec[],
  ids: Map<TaskSpec, string>,
  refs: TaskRefs,
  today: string,
  errors: string[],
  where: string
): NewTask[] {
  const hpd = plan.project.hoursPerDay;
  const resolveDep = (raw: string): string | undefined => {
    const text = raw.trim();
    const m = LAG.exec(text);
    const base = (m ? m[1] : text).trim();
    const lag = m ? m[2] : "";
    const key = base.toLowerCase();
    const id =
      refs.byRef.get(key) ??
      (plan.taskById(base) ? plan.taskById(base)!.id : undefined) ??
      [...refs.reserved].find((x) => x.toLowerCase() === key) ??
      refs.byTitle.get(key) ??
      uniqueTitle(plan, base);
    return id ? `${id}${lag}` : undefined;
  };
  const build = (s: TaskSpec, label: string): NewTask => {
    const id = ids.get(s)!;
    const title = s.title?.replace(/\s+/g, " ").trim();
    if (!title) errors.push(`${label}: a task needs a title.`);
    const name = `${label} "${title ?? ""}"`;
    const attrs: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(s.attributes ?? {})) {
      if (!/^[A-Za-z][\w-]*$/.test(key)) errors.push(`${name}: invalid attribute name "${key}".`);
      else if (value !== "") attrs[key] = value;
    }
    if (s.estimate) {
      if (parseDuration(s.estimate, hpd) === undefined)
        errors.push(`${name}: invalid estimate "${s.estimate}" (e.g. 4h, 1.5d, 1w).`);
      attrs.est = s.estimate;
    }
    if (s.actual) {
      if (parseDuration(s.actual, hpd) === undefined)
        errors.push(`${name}: invalid actual "${s.actual}".`);
      attrs.act = s.actual;
    }
    if (s.owner) {
      const p = personOf(plan, s.owner);
      if (!p)
        errors.push(
          `${name}: unknown owner "${s.owner}" (team: ${plan.people.map((x) => x.id).join(", ") || "none yet"}).`
        );
      else attrs.owner = p;
    }
    if (s.dependsOn?.length) {
      const deps: string[] = [];
      for (const d of s.dependsOn) {
        const r = resolveDep(d);
        if (!r) errors.push(`${name}: unknown dependency "${d}".`);
        else if (r.replace(LAG, "$1") === id) errors.push(`${name}: depends on itself.`);
        else deps.push(r);
      }
      if (deps.length) attrs.dep = [...new Set(deps)].join(",");
    }
    for (const [key, value] of [
      ["start", s.start],
      ["due", s.due],
    ] as const) {
      if (!value) continue;
      if (!isValidDate(value)) errors.push(`${name}: invalid ${key} date "${value}" (YYYY-MM-DD).`);
      attrs[key] = value;
    }
    if (s.priority) {
      if (!["high", "med", "low"].includes(s.priority))
        errors.push(`${name}: invalid priority "${s.priority}" (high, med, low).`);
      attrs.prio = s.priority;
    }
    if (s.progress) {
      if (!/^\d{1,3}%$/.test(s.progress) || Number(s.progress.slice(0, -1)) > 100)
        errors.push(`${name}: invalid progress "${s.progress}" (e.g. 40%).`);
      attrs.progress = s.progress;
    }
    const status = s.status ?? "todo";
    if (!STATUSES.includes(status)) errors.push(`${name}: invalid status "${s.status}".`);
    for (const [k, v] of statusDateAttrs(status, today)) attrs[k] = v;
    if (status === "blocked" && s.blocked) attrs.blocked = s.blocked;
    const task = newTaskFrom(
      {
        title: title ?? "",
        status,
        attrs,
        tags: s.tags?.map((t) => t.trim().replace(/^#/, "").replace(/\s+/g, "-")).filter(Boolean),
        notes: noteLines(s.notes === undefined ? [] : [s.notes].flat()),
      },
      id
    );
    const children = (s.subtasks ?? []).map((c, i) => build(c, `${label}.${i + 1}`));
    return children.length ? { ...task, children } : task;
  };
  return specs.map((s, i) => build(s, `${where} task ${i + 1}`));
}

/**
 * A person id from an id or a full name (case-insensitive), else from a first name that only one
 * person has. `exact`: id or full name only (to tell whether a person in the input already exists).
 */
export function personOf(
  plan: Plan,
  owner: string,
  options: { exact?: boolean } = {}
): string | undefined {
  const o = owner.trim().replace(/^@/, "").toLowerCase();
  const p = plan.personById(o) ?? plan.people.find((x) => x.name.toLowerCase() === o);
  if (p || options.exact) return p?.id;
  const byFirstName = plan.people.filter((x) => x.name.split(/\s+/)[0].toLowerCase() === o);
  return byFirstName.length === 1 ? byFirstName[0].id : undefined;
}

function uniqueTitle(plan: Plan, title: string): string | undefined {
  const matches = plan.tasks.filter((t) => t.id && t.title.toLowerCase() === title.toLowerCase());
  return matches.length === 1 ? matches[0].id : undefined;
}
