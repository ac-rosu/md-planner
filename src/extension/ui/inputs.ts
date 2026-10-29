// Pickers and input boxes for the create and edit forms. Conventions: undefined means "cancelled,
// keep the old value"; an empty string (or an empty list) means "remove the value".
import * as vscode from "vscode";
import {
  type DateSuggestion,
  dateSuggestions,
  formatDate,
  isValidDate,
  parseDate,
  parseWorkweek,
  weekStart,
} from "../../core/dates";
import { parseCapacity, parseDuration, parseExtraCapacity } from "../../core/duration";
import { STATUS_LABEL, STATUSES, type Status, type Task } from "../../core/model";
import { type Plan } from "../../core/resolve";
import { PERSON_COLORS } from "../../core/writer/entities";

export interface Choice<T> {
  label: string;
  value: T;
  description?: string;
  detail?: string;
}

export async function askText(o: {
  title: string;
  prompt?: string;
  value?: string;
  placeHolder?: string;
  required?: boolean;
  validate?: (value: string) => string | undefined;
  /** A note that does not stop Enter (what the text will turn into, say). */
  warn?: (value: string) => string | undefined;
}): Promise<string | undefined> {
  const text = await vscode.window.showInputBox({
    title: o.title,
    prompt: o.prompt,
    value: o.value,
    placeHolder: o.placeHolder,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (o.required && !v.trim()) return "Required";
      if (!v.trim()) return undefined;
      const error = o.validate?.(v.trim());
      if (error) return error;
      const warning = o.warn?.(v.trim());
      return warning
        ? { message: warning, severity: vscode.InputBoxValidationSeverity.Warning }
        : undefined;
    },
  });
  return text === undefined ? undefined : text.trim();
}

/** A single choice; returns `{ value }` so that undefined values can be chosen too. */
export async function askChoice<T>(
  title: string,
  choices: Array<Choice<T>>,
  current?: T,
  placeHolder?: string
): Promise<{ value: T } | undefined> {
  const items = choices.map((c) => ({
    label: c.label,
    description: [c.description, c.value === current ? "current" : undefined]
      .filter(Boolean)
      .join(" · "),
    detail: c.detail,
    choice: c,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title,
    placeHolder,
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  return pick ? { value: pick.choice.value } : undefined;
}

export async function askDuration(
  title: string,
  current: string | undefined,
  hoursPerDay: number
): Promise<string | undefined> {
  return askText({
    title,
    value: current,
    prompt: "Hours (h), days (d) or weeks (w). Leave empty to remove the estimate.",
    placeHolder: "e.g. 4h, 1.5d, 1w",
    validate: (v) =>
      parseDuration(v, hoursPerDay) === undefined
        ? "Use a number with h, d or w, for example 4h, 1.5d or 1w"
        : undefined,
  });
}

/** A date from suggestions (today, next Monday, end of month …), or typed; "" removes it. */
export async function askDate(
  title: string,
  current: string | undefined,
  today: string,
  extra: Array<{ label: string; date: string }> = [],
  allowNone = true
): Promise<string | undefined> {
  const choices: Array<Choice<string>> = [];
  if (allowNone && current) choices.push({ label: "$(close) No date", value: "" });
  for (const e of extra) choices.push({ label: e.date, description: e.label, value: e.date });
  for (const s of dateSuggestions(today))
    choices.push({ label: s.date, description: s.label, value: s.date });
  choices.push({ label: "$(edit) Other date…", value: "\u0000custom" });
  const pick = await askChoice(
    title,
    choices,
    current,
    current ? `Current: ${current}` : undefined
  );
  if (!pick) return undefined;
  if (pick.value !== "\u0000custom") return pick.value;
  return askText({
    title,
    value: current,
    placeHolder: "YYYY-MM-DD",
    validate: (v) => (isValidDate(v) ? undefined : "Use YYYY-MM-DD, for example 2026-11-20"),
  });
}

/** A single day or a range `from..to` (for time off and holidays). */
export async function askDateRange(title: string, today: string): Promise<string | undefined> {
  const from = await askDate(`${title} – first day`, undefined, today, [], false);
  if (!from) return undefined;
  const to = await askDate(
    `${title} – last day`,
    undefined,
    from,
    [{ label: "only this day", date: from }],
    false
  );
  if (!to) return undefined;
  if (to < from) {
    void vscode.window.showWarningMessage("Planner: the last day is before the first day.");
    return undefined;
  }
  return to === from ? from : `${from}..${to}`;
}

/** A person from team.md; "" = no owner. */
export async function askPerson(
  plan: Plan,
  title: string,
  current: string | undefined,
  noneLabel = "No owner"
): Promise<string | undefined> {
  const choices: Array<Choice<string>> = plan.people.map((p) => ({
    label: `$(person) ${p.name}`,
    value: p.id,
    description: [p.id, p.role].filter(Boolean).join(" · "),
    detail: p.skills.length ? `Skills: ${p.skills.join(", ")}` : undefined,
  }));
  choices.push({ label: `$(circle-slash) ${noneLabel}`, value: "" });
  const pick = await askChoice(title, choices, current?.toLowerCase(), "Choose a person");
  return pick?.value;
}

export async function askStatus(title: string, current: Status): Promise<Status | undefined> {
  const pick = await askChoice(
    title,
    STATUSES.map((s) => ({ label: STATUS_LABEL[s], value: s })),
    current
  );
  return pick?.value;
}

export async function askPriority(title: string, current: string): Promise<string | undefined> {
  const pick = await askChoice(
    title,
    [
      { label: "$(arrow-up) High", value: "high", description: "scheduled first" },
      { label: "Medium", value: "med", description: "default" },
      { label: "$(arrow-down) Low", value: "low", description: "scheduled last" },
    ],
    current
  );
  return pick?.value;
}

export async function askProgress(
  title: string,
  current: string | undefined
): Promise<string | undefined> {
  return askText({
    title,
    value: current,
    prompt: "Share of the work done. Leave empty to use actual hours instead.",
    placeHolder: "e.g. 40%",
    validate: (v) => {
      const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(v);
      return m && Number(m[1]) <= 100 ? undefined : "Use a percentage from 0% to 100%";
    },
  });
}

/** Several tasks (dependencies). Keeps an existing lag (`T101+2d`) for tasks that stay selected. */
export async function askTasks(
  plan: Plan,
  title: string,
  selected: string[],
  include: (t: Task) => boolean
): Promise<string[] | undefined> {
  const byId = new Map(selected.map((raw) => [raw.replace(/\+.*$/, ""), raw]));
  const items = plan.tasks
    .filter((t) => t.id && include(t))
    .map((t) => {
      const m = plan.milestoneById(t.milestoneId);
      return {
        label: `${t.id} · ${t.title}`,
        description: [m?.id, t.section].filter(Boolean).join(" › "),
        picked: byId.has(t.id!),
        id: t.id!,
      };
    });
  // Current dependencies first, so they are visible without scrolling.
  items.sort((a, b) => Number(b.picked) - Number(a.picked));
  const picks = await vscode.window.showQuickPick(items, {
    title,
    canPickMany: true,
    placeHolder: "Tick the tasks that must finish first (none = no dependencies)",
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  return picks?.map((p) => byId.get(p.id) ?? p.id);
}

/** Several milestones (for `depends:`). */
export async function askMilestones(
  plan: Plan,
  title: string,
  selected: string[],
  exclude?: string
): Promise<string[] | undefined> {
  // Milestones that already wait for this one (directly or through others) would make a loop
  // that leaves all their work unscheduled; ones already chosen stay, so nothing is dropped.
  const waiting = new Set<string>();
  if (exclude) {
    const key = (id: string) => id.toLowerCase();
    for (let grew = true; grew;) {
      grew = false;
      for (const m of plan.milestones)
        if (
          !waiting.has(key(m.id)) &&
          m.depends.some((d) => key(d) === key(exclude) || waiting.has(key(d)))
        ) {
          waiting.add(key(m.id));
          grew = true;
        }
    }
  }
  const chosen = (id: string) => selected.some((s) => s.toLowerCase() === id.toLowerCase());
  const items = plan.milestones
    .filter((m) => m.id !== exclude && (!waiting.has(m.id.toLowerCase()) || chosen(m.id)))
    .map((m) => ({
      label: m.title,
      description: m.target ? `target ${m.target}` : undefined,
      picked: chosen(m.id),
      id: m.id,
    }));
  const picks = await vscode.window.showQuickPick(items, {
    title,
    canPickMany: true,
    placeHolder: "Tick the milestones that must be finished first",
    ignoreFocusOut: true,
  });
  return picks?.map((p) => p.id);
}

/**
 * Several values from a known list (tags, skills) plus new ones typed into the filter box: the
 * typed text appears as "New …" and can be ticked like the others.
 */
export async function askValues(
  title: string,
  known: string[],
  selected: string[],
  o: { prefix?: string; noun: string; clean?: (typed: string) => string }
): Promise<string[] | undefined> {
  const prefix = o.prefix ?? "";
  type Item = vscode.QuickPickItem & { value: string };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = title;
  qp.canSelectMany = true;
  qp.ignoreFocusOut = true;
  qp.placeholder = `Tick ${o.noun}s, or type a new one`;
  const all = [...new Set([...known, ...selected])].sort((a, b) => a.localeCompare(b));
  const base: Item[] = all.map((v) => ({ label: prefix + v, value: v }));
  qp.items = base;
  qp.selectedItems = base.filter((i) => selected.includes(i.value));
  qp.onDidChangeValue((text) => {
    const typed = text.trim().replace(new RegExp(`^${prefix}`), "");
    // Shown as it will be written, so a tag like "v1.2" is "v1-2" before it is ticked.
    const v = o.clean ? o.clean(typed) : typed.replace(/\s+/g, "-");
    const keep = qp.selectedItems;
    const extra: Item[] =
      v && !all.includes(v)
        ? [{ label: `$(add) New ${o.noun}: ${prefix}${v}`, value: v, alwaysShow: true }]
        : [];
    qp.items = [...extra, ...base];
    qp.selectedItems = qp.items.filter((i) => keep.some((k) => k.value === i.value));
  });
  return new Promise((resolve) => {
    let done = false;
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.selectedItems.map((i) => i.value));
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

/**
 * Edits a list of entries (time off, holidays, capacity changes): choose an entry to remove it,
 * "Add…" to add one, "Done" to keep the changes.
 */
export async function askList(
  title: string,
  entries: string[],
  o: { addLabel: string; add: () => Promise<string | undefined>; empty: string }
): Promise<string[] | undefined> {
  let list = [...entries];
  for (;;) {
    type Item = vscode.QuickPickItem & { action?: "done" | "add"; entry?: string };
    const items: Item[] = [
      {
        label: "$(check) Done",
        action: "done",
        description: `${list.length} entr${list.length === 1 ? "y" : "ies"}`,
      },
      { label: `$(add) ${o.addLabel}`, action: "add" },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      ...(list.length
        ? list.map((e) => ({ label: e, description: "select to remove", entry: e }))
        : [{ label: o.empty, description: "" }]),
    ];
    const pick = await vscode.window.showQuickPick(items, { title, ignoreFocusOut: true });
    if (!pick) return undefined;
    if (pick.action === "done") return list;
    if (pick.action === "add") {
      const v = await o.add();
      if (v && !list.includes(v)) list = [...list, v].sort();
    } else if (pick.entry) {
      const entry = pick.entry;
      const ok = await askChoice(
        title,
        [
          { label: `$(trash) Remove ${entry}`, value: true },
          { label: "Keep it", value: false },
        ],
        undefined
      );
      if (ok?.value) list = list.filter((e) => e !== entry);
    }
  }
}

const CAPACITY_PRESETS = [
  "40h/week",
  "36h/week",
  "32h/week",
  "24h/week",
  "16h/week",
  "8h/day",
  "6h/day",
  "4h/day",
];

/** A person's capacity; "" is full time (no `capacity:` line). */
export async function askCapacity(
  title: string,
  current: string | undefined
): Promise<string | undefined> {
  return pickCapacity(
    title,
    { label: "Full time", value: "", description: "hours per day × working days (default)" },
    current ?? "",
    current
  );
}

/**
 * A capacity change from a date: `2027-01-01 24h/week`. Full time is written as the person's
 * full-time hours, `fullTime` (`40h/week`: hours per day × their working days), as a change needs a
 * value.
 */
export async function askCapacityChange(
  title: string,
  today: string,
  fullTime: string
): Promise<string | undefined> {
  const from = await askDate(`${title} – from`, undefined, today, [], false);
  if (!from) return undefined;
  const cap = await pickCapacity(
    `${title} – new capacity from ${from}`,
    {
      label: "Full time",
      value: fullTime,
      description: `${fullTime}: hours per day × working days`,
    },
    undefined,
    undefined
  );
  if (!cap) return undefined;
  return `${from} ${cap}`;
}

/** The capacity presets after `fullTime`, or a typed capacity (starting from `typed`). */
async function pickCapacity(
  title: string,
  fullTime: Choice<string>,
  current: string | undefined,
  typed: string | undefined
): Promise<string | undefined> {
  const choices: Array<Choice<string>> = [
    fullTime,
    ...CAPACITY_PRESETS.filter((p) => p !== fullTime.value).map((p) => ({ label: p, value: p })),
    { label: "$(edit) Other…", value: "\u0000custom" },
  ];
  const pick = await askChoice(title, choices, current, "Hours available for this project");
  if (!pick) return undefined;
  if (pick.value !== "\u0000custom") return pick.value;
  return askText({
    title,
    value: typed,
    placeHolder: "e.g. 28h/week or 5h/day",
    validate: (v) =>
      parseCapacity(v) ? undefined : "Use hours per week or day, e.g. 28h/week or 5h/day",
  });
}

/**
 * Overtime: a period (a suggested week first, or this week, next week …) and the extra hours.
 * Returns an `overtime:` value such as `2026-11-02..2026-11-06 +8h/week`.
 */
export async function askOvertime(
  title: string,
  today: string,
  suggestion?: { from: string; to: string; label: string }
): Promise<string | undefined> {
  const t = parseDate(today)!;
  const week = (start: number, weeks: number) =>
    `${formatDate(start)}..${formatDate(start + 7 * (weeks - 1) + 4)}`;
  const monday = weekStart(t);
  const periods: Array<Choice<string>> = [];
  if (suggestion)
    periods.push({ label: suggestion.label, value: `${suggestion.from}..${suggestion.to}` });
  if (t <= monday + 4)
    periods.push({ label: "This week", value: `${formatDate(t)}..${formatDate(monday + 4)}` });
  periods.push(
    { label: "Next week", value: week(monday + 7, 1) },
    { label: "The next two weeks", value: week(monday + 7, 2) },
    { label: "$(edit) Other period…", value: "\u0000custom" }
  );
  for (const p of periods) if (p.value !== "\u0000custom") p.description = p.value;
  const period = await askChoice(
    `${title} – when?`,
    periods,
    undefined,
    "Overtime is worked on working days"
  );
  if (!period) return undefined;
  const range =
    period.value === "\u0000custom" ? await askDateRange(`${title} – period`, today) : period.value;
  if (!range) return undefined;
  const extra = await askChoice(
    `${title} – how many extra hours?`,
    [
      { label: "+4h/week", value: "+4h/week", description: "on top of the normal capacity" },
      { label: "+8h/week", value: "+8h/week" },
      { label: "+16h/week", value: "+16h/week" },
      { label: "+1h/day", value: "+1h/day" },
      { label: "+2h/day", value: "+2h/day" },
      { label: "$(edit) Other…", value: "\u0000custom" },
    ],
    undefined,
    range
  );
  if (!extra) return undefined;
  const hours =
    extra.value === "\u0000custom"
      ? await askText({
          title: `${title} – extra hours`,
          placeHolder: "e.g. +6h/week or +1.5h/day",
          required: true,
          validate: (v) =>
            parseExtraCapacity(v) ? undefined : "Hours per week or day, e.g. +6h/week or +1.5h/day",
        })
      : extra.value;
  if (!hours) return undefined;
  return `${range} ${hours.startsWith("+") ? hours : `+${hours}`}`;
}

/**
 * An extra working day: one of the suggested days off (weekends, holidays) or another date, and
 * its hours. Returns a `workday:` value such as `2026-11-07` or `2026-11-07 6h`.
 */
export async function askWorkday(
  title: string,
  suggestions: DateSuggestion[],
  normalHours: number,
  hoursPerDay: number
): Promise<string | undefined> {
  const day = await askChoice(
    `${title} – which day?`,
    [
      ...suggestions.map((s) => ({ label: s.label, value: s.date, description: s.date })),
      { label: "$(edit) Other date…", value: "\u0000custom" },
    ],
    undefined,
    "A weekend day or holiday this person works"
  );
  if (!day) return undefined;
  const date =
    day.value === "\u0000custom"
      ? await askText({
          title: `${title} – date`,
          placeHolder: "YYYY-MM-DD",
          required: true,
          validate: (v) => (isValidDate(v) ? undefined : "Use YYYY-MM-DD, for example 2026-11-07"),
        })
      : day.value;
  if (!date) return undefined;
  const normal = Math.round(normalHours * 10) / 10;
  const hours = await askChoice(
    `${title} – how long?`,
    [
      { label: `A normal day (${normal} h)`, value: "" },
      { label: "4h", value: "4h", description: "half a day" },
      { label: "6h", value: "6h" },
      { label: "$(edit) Other…", value: "\u0000custom" },
    ],
    undefined,
    date
  );
  if (!hours) return undefined;
  const h =
    hours.value === "\u0000custom"
      ? await askText({
          title: `${title} – hours`,
          placeHolder: "e.g. 5h",
          required: true,
          validate: (v) => {
            const n = parseDuration(v, hoursPerDay);
            return n !== undefined && n > 0 && n <= 24 ? undefined : "Hours, e.g. 5h (at most 24h)";
          },
        })
      : hours.value;
  if (h === undefined) return undefined;
  return h ? `${date} ${h}` : date;
}

export async function askWorkweek(
  title: string,
  current: string | undefined,
  fallback: { label: string; value: string } | undefined
): Promise<string | undefined> {
  const options = ["mon-fri", "mon-thu", "tue-fri", "mon-sat", "sun-thu"];
  const choices: Array<Choice<string>> = [
    ...(fallback ? [{ label: fallback.label, value: "", description: fallback.value }] : []),
    ...options.map((o) => ({ label: o, value: o })),
    { label: "$(edit) Other…", value: "\u0000custom", description: "e.g. mon,wed,fri" },
  ];
  const pick = await askChoice(title, choices, current ?? "", "Working days");
  if (!pick) return undefined;
  if (pick.value !== "\u0000custom") return pick.value;
  return askText({
    title,
    value: current,
    placeHolder: "mon-fri, mon-thu, mon,wed,fri",
    validate: (v) =>
      parseWorkweek(v) ? undefined : "Use day names such as mon-fri or mon,wed,fri",
  });
}

export async function askColor(
  title: string,
  current: string | undefined
): Promise<string | undefined> {
  const pick = await askChoice(
    title,
    [
      { label: "None", value: "" },
      ...PERSON_COLORS.map((c) => ({ label: `$(circle-filled) ${c}`, value: c })),
    ],
    current ?? ""
  );
  return pick?.value;
}

/** Sorts date ranges and single dates chronologically. */
export function sortDates(values: string[]): string[] {
  return [...values].sort(
    (a, b) => (parseDate(a.slice(0, 10)) ?? 0) - (parseDate(b.slice(0, 10)) ?? 0)
  );
}
