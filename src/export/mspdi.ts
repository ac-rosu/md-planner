// MS Project XML (MSPDI) export: calendar, tasks (WBS from milestones, sections and subtasks),
// dependencies with lag, resources and assignments. Open tasks get a "start no earlier than"
// constraint at their scheduled start so MS Project shows the same resource-constrained dates.
import { type DayNumber, formatDate, parseDate } from "../core/dates";
import { type Milestone, type Person, type Section, type Task } from "../core/model";
import { type Plan } from "../core/resolve";
import {
  activeChildren,
  actualHours,
  estimateHours,
  hasLoggedWork,
  initials,
  isLeaf,
  ownerOf,
  progressOf,
  remainingHours,
  startedOn,
} from "../core/rollup";
import { type Schedule } from "../core/scheduler";

const PRIORITY = { high: 700, med: 500, low: 300 } as const;

function x(text: string | number | undefined): string {
  if (text === undefined) return "";
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!
  );
}

function tag(name: string, value: string | number | undefined): string {
  return value === undefined || value === "" ? "" : `<${name}>${x(value)}</${name}>`;
}

/** `PT16H0M0S` */
export function msDuration(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  return `PT${Math.floor(totalMinutes / 60)}H${totalMinutes % 60}M0S`;
}

/** Working times of a day: 08:00–12:00 and 13:00–… for the configured hours per day. */
export function workingTimes(hoursPerDay: number): Array<[string, string]> {
  const t = (h: number) =>
    `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}:00`;
  if (hoursPerDay <= 4) return [["08:00:00", t(8 + hoursPerDay)]];
  return [
    ["08:00:00", "12:00:00"],
    ["13:00:00", t(13 + hoursPerDay - 4)],
  ];
}

/** MSPDI day type: 1 = Sunday … 7 = Saturday. */
function dayType(iso: number): number {
  return (iso % 7) + 1;
}

/** Collapses a set of days into [from, to] ranges. */
function ranges(days: DayNumber[]): Array<[DayNumber, DayNumber]> {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const out: Array<[DayNumber, DayNumber]> = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && d === last[1] + 1) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

export interface MspdiOptions {
  author?: string;
  company?: string;
}

export function exportMspdi(plan: Plan, schedule: Schedule, options: MspdiOptions = {}): string {
  const hpd = plan.project.hoursPerDay;
  const times = workingTimes(hpd);
  const startTime = times[0][0];
  const finishTime = times[times.length - 1][1];
  const dt = (day: DayNumber, end = false) => `${formatDate(day)}T${end ? finishTime : startTime}`;
  const cal = schedule.calendar;

  // --- Calendars ------------------------------------------------------------------------------
  const weekDays = (workweek: Set<number>) =>
    [1, 2, 3, 4, 5, 6, 7]
      .map((iso) =>
        workweek.has(iso)
          ? `<WeekDay><DayType>${dayType(iso)}</DayType><DayWorking>1</DayWorking><WorkingTimes>${times
              .map(
                ([f, t]) =>
                  `<WorkingTime><FromTime>${f}</FromTime><ToTime>${t}</ToTime></WorkingTime>`
              )
              .join("")}</WorkingTimes></WeekDay>`
          : `<WeekDay><DayType>${dayType(iso)}</DayType><DayWorking>0</DayWorking></WeekDay>`
      )
      .join("");
  // A non-working period, or a working day with its working times (extra working days).
  const exception = (a: DayNumber, b: DayNumber, name: string, working?: Array<[string, string]>) =>
    `<Exception><EnteredByOccurrences>0</EnteredByOccurrences><TimePeriod><FromDate>${formatDate(a)}T00:00:00</FromDate><ToDate>${formatDate(b)}T23:59:00</ToDate></TimePeriod><Occurrences>1</Occurrences><Name>${x(name)}</Name><Type>1</Type>${
      working
        ? `<DayWorking>1</DayWorking><WorkingTimes>${working
            .map(
              ([f, t]) =>
                `<WorkingTime><FromTime>${f}</FromTime><ToTime>${t}</ToTime></WorkingTime>`
            )
            .join("")}</WorkingTimes>`
        : "<DayWorking>0</DayWorking>"
    }</Exception>`;
  const exceptions = (items: string[]) =>
    items.length ? `<Exceptions>${items.join("")}</Exceptions>` : "";
  const holidayDays: DayNumber[] = [];
  for (const [a, b] of plan.project.holidays) for (let d = a; d <= b; d++) holidayDays.push(d);
  const calendars = [
    `<Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID><WeekDays>${weekDays(plan.project.workweek)}</WeekDays>${exceptions(ranges(holidayDays).map(([a, b]) => exception(a, b, "Holiday")))}</Calendar>`,
  ];
  const people = plan.people;
  const resourceUid = new Map<string, number>();
  people.forEach((p, i) => {
    resourceUid.set(p.id.toLowerCase(), i + 1);
    const offDays: DayNumber[] = [];
    for (const [a, b] of p.off) for (let d = a; d <= b; d++) offDays.push(d);
    const ownWeek =
      p.workweek && [...p.workweek].sort().join() !== [...plan.project.workweek].sort().join();
    // Extra working days (weekends, holidays) with their hours; overtime on working days is not
    // part of an MS Project calendar.
    const extra: string[] = [];
    for (const w of p.workdays)
      for (let d = w.from; d <= w.to; d++) {
        const hours = cal.capacity(p.id, d);
        if (hours > 0 && cal.normalCapacity(p.id, d) === 0)
          extra.push(exception(d, d, "Extra working day", workingTimes(hours)));
      }
    calendars.push(
      `<Calendar><UID>${i + 2}</UID><Name>${x(p.name)}</Name><IsBaseCalendar>0</IsBaseCalendar><BaseCalendarUID>1</BaseCalendarUID>${ownWeek ? `<WeekDays>${weekDays(p.workweek!)}</WeekDays>` : ""}${exceptions([...ranges(offDays).map(([a, b]) => exception(a, b, "Time off")), ...extra])}</Calendar>`
    );
  });

  // --- Tasks ----------------------------------------------------------------------------------
  const taskXml: string[] = [];
  const uidOf = new Map<Task | Milestone | Section, number>();
  let uid = 0;
  const projectStart = plan.project.start ? parseDate(plan.project.start)! : schedule.start;
  const projectFinish =
    schedule.finish ?? (plan.project.end ? parseDate(plan.project.end)! : projectStart);
  taskXml.push(
    `<Task><UID>0</UID><ID>0</ID><Name>${x(plan.project.name)}</Name><Type>1</Type><IsNull>0</IsNull><OutlineNumber>0</OutlineNumber><OutlineLevel>0</OutlineLevel><Start>${dt(projectStart)}</Start><Finish>${dt(projectFinish, true)}</Finish><Summary>1</Summary><PercentComplete>${Math.round(progressAll(plan) * 100)}</PercentComplete></Task>`
  );
  const assignments: string[] = [];
  const links = new Map<number, string[]>();
  const pendingLinks: Array<{ succ: number; pred: Task | Milestone; lagHours: number }> = [];

  const durationHours = (start: DayNumber, finish: DayNumber) =>
    Math.max(0, cal.workingDaysBetween(start, finish + 1)) * hpd;

  /**
   * The day work began: `@started`, also on a to-do task with logged work (see stale-started),
   * which the schedule leaves out.
   */
  const actualStart = (t: Task): DayNumber | undefined => {
    const iso = hasLoggedWork(t) ? t.started : startedOn(t);
    return iso ? parseDate(iso) : undefined;
  };
  // A row starts on its scheduled (or rolled-up) start, or on its actual start when that is
  // earlier, like a task under way: MS Project expects no actual start before the start. A
  // summary row starts no later than the rows in it.
  const startOf = new Map<Task, DayNumber | undefined>();
  const taskStart = (t: Task): DayNumber | undefined => {
    if (!startOf.has(t)) {
      const rolled = isLeaf(t) ? schedule.tasks.get(t)?.start : schedule.parents.get(t)?.start;
      startOf.set(t, startWithin(rolled, activeChildren(t), actualStart(t)));
    }
    return startOf.get(t);
  };
  /** A start, or an earlier actual start or start of one of the tasks in its row. */
  const startWithin = (start: DayNumber | undefined, tasks: Task[], actual?: DayNumber) => {
    if (start === undefined) return undefined;
    let first = actual !== undefined && actual < start ? actual : start;
    for (const t of tasks) {
      const s = taskStart(t);
      if (s !== undefined && s < first) first = s;
    }
    return first;
  };

  const summary = (
    name: string,
    outline: string,
    level: number,
    start?: DayNumber,
    finish?: DayNumber,
    progress = 0,
    extra = ""
  ) => {
    const id = ++uid;
    taskXml.push(
      `<Task><UID>${id}</UID><ID>${id}</ID><Name>${x(name)}</Name><Type>1</Type><IsNull>0</IsNull><WBS>${outline}</WBS><OutlineNumber>${outline}</OutlineNumber><OutlineLevel>${level}</OutlineLevel>${start !== undefined ? `<Start>${dt(start)}</Start>` : ""}${finish !== undefined ? `<Finish>${dt(finish, true)}</Finish>` : ""}${start !== undefined && finish !== undefined ? `<Duration>${msDuration(durationHours(start, finish))}</Duration><DurationFormat>7</DurationFormat>` : ""}<Summary>1</Summary><Milestone>0</Milestone><PercentComplete>${Math.round(progress * 100)}</PercentComplete>${extra}</Task>`
    );
    return id;
  };

  const taskNode = (t: Task, outline: string, level: number) => {
    if (t.status === "cancelled") return;
    const leaf = isLeaf(t);
    const ts = schedule.tasks.get(t);
    const roll = schedule.parents.get(t);
    const started = actualStart(t);
    const start = taskStart(t);
    const finish = leaf ? ts?.finish : roll?.finish;
    const id = ++uid;
    uidOf.set(t, id);
    const est = estimateHours(t) ?? 0;
    const act = actualHours(t);
    const remaining = remainingHours(t);
    const work = t.status === "done" ? Math.max(act, est) : act + remaining;
    const pctDone = Math.round(progressOf(t) * 100);
    const parts = [
      `<UID>${id}</UID><ID>${id}</ID>`,
      tag("Name", t.id ? `${t.title} [${t.id}]` : t.title),
      "<Type>1</Type><IsNull>0</IsNull>",
      tag("WBS", outline),
      tag("OutlineNumber", outline),
      tag("OutlineLevel", level),
      `<Priority>${PRIORITY[t.prio]}</Priority>`,
      start !== undefined ? `<Start>${dt(start)}</Start>` : "",
      finish !== undefined ? `<Finish>${dt(finish, true)}</Finish>` : "",
      start !== undefined && finish !== undefined
        ? `<Duration>${msDuration(durationHours(start, finish))}</Duration><DurationFormat>7</DurationFormat>`
        : "",
      `<Work>${msDuration(work)}</Work>`,
      `<Summary>${leaf ? 0 : 1}</Summary><Milestone>0</Milestone>`,
      `<PercentComplete>${pctDone}</PercentComplete><PercentWorkComplete>${work > 0 ? Math.round((act / work) * 100) : pctDone}</PercentWorkComplete>`,
      act > 0 ? `<ActualWork>${msDuration(act)}</ActualWork>` : "",
      leaf ? `<RemainingWork>${msDuration(remaining)}</RemainingWork>` : "",
    ];
    if (started !== undefined) parts.push(`<ActualStart>${dt(started)}</ActualStart>`);
    if (t.status === "done" && t.done)
      parts.push(`<ActualFinish>${dt(parseDate(t.done)!, true)}</ActualFinish>`);
    if (leaf && ts && !ts.done && start !== undefined) {
      const constraintDay = Math.max(start, schedule.start);
      parts.push(
        `<ConstraintType>4</ConstraintType><ConstraintDate>${dt(constraintDay)}</ConstraintDate>`
      );
    }
    const due = t.due ? parseDate(t.due) : undefined;
    if (due !== undefined) parts.push(`<Deadline>${dt(due, true)}</Deadline>`);
    const notes = [
      ...t.notes.map((n) => n.text),
      t.blocked ? `Blocked: ${t.blocked}` : "",
      t.eq ? `Equipment: ${t.eq}` : "",
      t.src ? `Source: ${t.src}` : "",
    ].filter(Boolean);
    if (notes.length) parts.push(tag("Notes", notes.join("\n")));
    taskXml.push(`<Task>${parts.join("")}__LINKS_${id}__</Task>`);
    for (const d of t.deps) {
      const pred = plan.taskById(d.id);
      if (pred) pendingLinks.push({ succ: id, pred, lagHours: d.lagHours });
    }
    const owner = ownerOf(t)?.toLowerCase();
    const rid = owner ? resourceUid.get(owner) : undefined;
    if (leaf && rid !== undefined) {
      const hours = start !== undefined && finish !== undefined ? durationHours(start, finish) : 0;
      const units = hours > 0 ? Math.min(1, Math.round((work / hours) * 100) / 100) : 1;
      assignments.push(
        `<Assignment><UID>${assignments.length + 1}</UID><TaskUID>${id}</TaskUID><ResourceUID>${rid}</ResourceUID><Units>${units}</Units><Work>${msDuration(work)}</Work>${act > 0 ? `<ActualWork>${msDuration(act)}</ActualWork>` : ""}<RemainingWork>${msDuration(remaining)}</RemainingWork>${start !== undefined ? `<Start>${dt(start)}</Start>` : ""}${finish !== undefined ? `<Finish>${dt(finish, true)}</Finish>` : ""}</Assignment>`
      );
    }
    t.children
      .filter((c) => c.status !== "cancelled")
      .forEach((c, i) => taskNode(c, `${outline}.${i + 1}`, level + 1));
  };

  plan.milestones
    .filter((m) => m.status !== "cancelled")
    .forEach((m, mi) => {
      const ms = schedule.milestones.get(m.id);
      const target = m.target ? parseDate(m.target) : undefined;
      const mOutline = String(mi + 1);
      const start = startWithin(
        ms?.start,
        m.tasks.filter((t) => t.status !== "cancelled")
      );
      const mid = summary(
        m.title,
        mOutline,
        1,
        start,
        ms?.forecast,
        ms?.progress ?? 0,
        target !== undefined ? `<Deadline>${dt(target, true)}</Deadline>` : ""
      );
      uidOf.set(m, mid);
      for (const dep of m.depends) {
        const pm = plan.milestoneById(dep);
        if (pm) pendingLinks.push({ succ: mid, pred: pm, lagHours: 0 });
      }
      let n = 0;
      for (const t of m.rootTasks)
        if (t.status !== "cancelled") taskNode(t, `${mOutline}.${++n}`, 2);
      for (const s of m.sections) {
        const tasks = s.tasks.filter((t) => t.status !== "cancelled");
        if (!tasks.length) continue;
        const roll = schedule.sections.get(s);
        const sOutline = `${mOutline}.${++n}`;
        const start = startWithin(roll?.start, tasks);
        uidOf.set(s, summary(s.title, sOutline, 2, start, roll?.finish, roll?.progress ?? 0));
        tasks.forEach((t, i) => taskNode(t, `${sOutline}.${i + 1}`, 3));
      }
    });

  for (const l of pendingLinks) {
    const pred = uidOf.get(l.pred);
    if (pred === undefined) continue;
    const list = links.get(l.succ) ?? [];
    list.push(
      `<PredecessorLink><PredecessorUID>${pred}</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject><LinkLag>${Math.round(l.lagHours * 600)}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`
    );
    links.set(l.succ, list);
  }
  const tasks = taskXml.map((t) =>
    t.replace(/__LINKS_(\d+)__/, (_m, id) => (links.get(Number(id)) ?? []).join(""))
  );

  // --- Resources ------------------------------------------------------------------------------
  const resources = people.map((p, i) => {
    const units = maxUnits(p, plan.project.workweek.size, hpd);
    return `<Resource><UID>${i + 1}</UID><ID>${i + 1}</ID><Name>${x(p.name)}</Name><Type>1</Type><IsNull>0</IsNull><Initials>${x(initials(p.name))}</Initials>${tag("Group", p.role)}${tag("Code", p.id)}<MaxUnits>${units}</MaxUnits><CalendarUID>${i + 2}</CalendarUID>${tag("Notes", p.skills.length ? `Skills: ${p.skills.join(", ")}` : undefined)}</Resource>`;
  });

  const minutesPerDay = Math.round(hpd * 60);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
<SaveVersion>14</SaveVersion>
<Name>${x(plan.project.name)}.xml</Name>
<Title>${x(plan.project.name)}</Title>
${tag("Company", options.company)}
${tag("Author", options.author)}
<CreationDate>${dt(schedule.today)}</CreationDate>
<ScheduleFromStart>1</ScheduleFromStart>
<StartDate>${dt(projectStart)}</StartDate>
<FinishDate>${dt(projectFinish, true)}</FinishDate>
<FYStartDate>1</FYStartDate>
<CriticalSlackLimit>0</CriticalSlackLimit>
<CurrencyDigits>2</CurrencyDigits>
<CalendarUID>1</CalendarUID>
<DefaultStartTime>${startTime}</DefaultStartTime>
<DefaultFinishTime>${finishTime}</DefaultFinishTime>
<MinutesPerDay>${minutesPerDay}</MinutesPerDay>
<MinutesPerWeek>${minutesPerDay * plan.project.workweek.size}</MinutesPerWeek>
<DaysPerMonth>20</DaysPerMonth>
<DefaultTaskType>1</DefaultTaskType>
<DurationFormat>7</DurationFormat>
<WorkFormat>2</WorkFormat>
<CurrentDate>${dt(schedule.today)}</CurrentDate>
<StatusDate>${dt(schedule.today)}</StatusDate>
<Calendars>${calendars.join("")}</Calendars>
<Tasks>${tasks.join("")}</Tasks>
<Resources>${resources.join("")}</Resources>
<Assignments>${assignments.join("")}</Assignments>
</Project>
`;
}

/** Share of a full-time day the person works (32 h/week on a 5 × 8 h calendar = 0.8). */
export function maxUnits(p: Person, projectWorkdays: number, hoursPerDay: number): number {
  const days = p.workweek?.size ?? projectWorkdays;
  const daily = p.capacityPer === "day" ? p.capacityHours : p.capacityHours / Math.max(1, days);
  return Math.round((daily / hoursPerDay) * 100) / 100;
}

function progressAll(plan: Plan): number {
  let total = 0;
  let done = 0;
  for (const t of plan.tasks) {
    if (!isLeaf(t) || t.status === "cancelled") continue;
    const est = estimateHours(t) ?? 0;
    total += est;
    done += est * progressOf(t);
  }
  return total > 0 ? done / total : 0;
}
