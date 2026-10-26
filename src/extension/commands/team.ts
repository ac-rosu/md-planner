// Team and project settings from the user interface: add and edit people (capacity, work week,
// skills, colour, time off, capacity changes) and the project calendar (dates, work week, hours per
// day, holidays). Forms as in edit.ts; values passed as an argument skip the form.
import * as vscode from "vscode";
import { isOpen, type Person } from "../../core/model";
import {
  ambiguousBudget,
  parseBudget,
  parseOvertime,
  parseWorkday,
  personIdFromName,
} from "../../core/resolve";
import { parseCapacity } from "../../core/duration";
import {
  addPerson,
  addRepeatedProperty,
  changePerson,
  changeProject,
  type PersonChange,
  type PersonFields,
  type ProjectChange,
  listItems,
  removePerson as removePersonEdits,
} from "../../core/writer/entities";
import { type PlanService } from "../planService";
import { type PlannerState } from "../state";
import { type FormField, showForm } from "../ui/form";
import {
  askCapacity,
  askCapacityChange,
  askChoice,
  askColor,
  askDate,
  askDateRange,
  askList,
  askOvertime,
  askText,
  askValues,
  askWorkday,
  askWorkweek,
  sortDates,
} from "../ui/inputs";
import {
  type DateSuggestion,
  daysOffSuggestions,
  formatDate,
  isValidDate,
  parseDate,
  parseWorkweek,
  weekStart,
} from "../../core/dates";
import { stringArg, valuesArg } from "./args";
import { offerUndo } from "./edit";

export function registerTeamCommands(state: PlannerState): vscode.Disposable[] {
  const reg = vscode.commands.registerCommand;
  return [
    reg("planner.addPerson", (values?: unknown) =>
      addPersonCommand(state, valuesArg(values, PERSON_FIELDS, ["name"]))
    ),
    reg("planner.editPerson", (arg?: unknown, change?: unknown) =>
      editPersonCommand(
        state,
        arg,
        valuesArg(
          change,
          PERSON_FIELDS.filter((k) => k !== "id")
        )
      )
    ),
    reg("planner.removePerson", (arg?: unknown, options?: unknown) =>
      removePersonCommand(state, arg, valuesArg(options, ["reassignTo", "confirm"]))
    ),
    reg("planner.addTimeOff", (arg?: unknown, range?: unknown) =>
      addTimeOffCommand(state, arg, stringArg(range))
    ),
    reg("planner.addOvertime", (arg?: unknown, value?: unknown) =>
      addOvertimeCommand(state, arg, stringArg(value), weekArg(value))
    ),
    reg("planner.addWorkday", (arg?: unknown, value?: unknown) =>
      addWorkdayCommand(state, arg, stringArg(value), weekArg(value))
    ),
    reg("planner.editProject", (change?: unknown) =>
      editProjectCommand(state, valuesArg(change, PROJECT_FIELDS))
    ),
  ];
}

// Menus pass tree nodes where tests and other commands pass values (see valuesArg).
const PERSON_FIELDS = [
  "name",
  "id",
  "role",
  "capacity",
  "workweek",
  "skills",
  "color",
  "off",
  "capacityFrom",
  "overtime",
  "workday",
];

/** `{ week: "2026-W44" }` from the team load: the week to suggest. */
function weekArg(x: unknown): string | undefined {
  return valuesArg<{ week: string }>(x, ["week"], ["week"])?.week;
}
const PROJECT_FIELDS = [
  "name",
  "code",
  "start",
  "end",
  "workweek",
  "hoursPerDay",
  "budget",
  "holidays",
];

function message(text: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${text}`, 5000);
}

/** The person an argument refers to (Team tree node, id), else the person at the cursor in team.md. */
export function resolvePerson(service: PlanService, arg: unknown): Person | undefined {
  const plan = service.plan;
  if (typeof arg === "string") return plan.personById(arg);
  if (arg && typeof arg === "object") {
    const a = arg as { person?: Person; id?: string };
    if (a.person) return plan.personById(a.person.id);
    if (typeof a.id === "string") return plan.personById(a.id);
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && service.relPath(editor.document.uri) === "team.md") {
    const line = editor.selection.active.line;
    return [...plan.people].reverse().find((p) => p.headingLine <= line);
  }
  return undefined;
}

interface PersonForm {
  name: string;
  id: string;
  role: string;
  capacity: string;
  workweek: string;
  skills: string[];
  color: string;
  off: string[];
  capacityFrom: string[];
  overtime: string[];
  workday: string[];
}

function personFields(
  state: PlannerState,
  creating: boolean,
  original?: PersonForm
): Array<FormField<PersonForm>> {
  const plan = state.plan;
  const today = state.today;
  const changed = (k: keyof PersonForm) => (s: PersonForm) =>
    original !== undefined && JSON.stringify(s[k]) !== JSON.stringify(original[k]);
  const knownSkills = [...new Set(plan.people.flatMap((p) => p.skills))];
  return [
    {
      icon: "edit",
      label: "Name",
      value: (s) => s.name,
      changed: changed("name"),
      detail: creating ? undefined : "Renaming keeps the id, so assigned tasks stay assigned",
      edit: async (s) => {
        const v = await askText({ title: "Name", value: s.name, required: true });
        if (!v) return;
        if (creating && s.id === personIdFromName(s.name)) s.id = personIdFromName(v);
        s.name = v;
      },
    },
    {
      icon: "symbol-key",
      label: "Id",
      value: (s) => s.id,
      visible: () => creating,
      detail: "Used in @owner:… – lower case, no spaces",
      edit: async (s) => {
        const v = await askText({
          title: "Person id",
          value: s.id,
          required: true,
          validate: (x) =>
            !/^[a-z0-9][\w.-]*$/.test(x)
              ? "Lower case letters, digits, dots and dashes"
              : plan.personById(x)
                ? "This id is already in use"
                : undefined,
        });
        if (v) s.id = v;
      },
    },
    {
      icon: "briefcase",
      label: "Role",
      value: (s) => s.role,
      changed: changed("role"),
      edit: async (s) => {
        const v = await askText({
          title: "Role",
          value: s.role,
          placeHolder: "e.g. Backend developer",
        });
        if (v !== undefined) s.role = v;
      },
    },
    {
      icon: "dashboard",
      label: "Capacity",
      value: (s) => s.capacity || "full time",
      changed: changed("capacity"),
      edit: async (s) => {
        const v = await askCapacity("Capacity for this project", s.capacity);
        if (v !== undefined) s.capacity = v;
      },
    },
    {
      icon: "checklist",
      label: "Work week",
      value: (s) => s.workweek || `same as the project (${plan.project.workweekText})`,
      changed: changed("workweek"),
      edit: async (s) => {
        const v = await askWorkweek("Working days", s.workweek, {
          label: "Same as the project",
          value: plan.project.workweekText,
        });
        if (v !== undefined) s.workweek = v;
      },
    },
    {
      icon: "calendar",
      label: "Time off",
      value: (s) => (s.off.length ? s.off.join(", ") : undefined),
      changed: changed("off"),
      edit: async (s) => {
        const v = await askList("Time off", s.off, {
          addLabel: "Add time off…",
          empty: "No time off",
          add: () => askDateRange("Time off", today),
        });
        if (v !== undefined) s.off = sortDates(v);
      },
    },
    {
      icon: "graph-line",
      label: "Capacity changes",
      value: (s) => (s.capacityFrom.length ? s.capacityFrom.join(", ") : undefined),
      detail: "A different capacity from a date on",
      changed: changed("capacityFrom"),
      edit: async (s) => {
        const v = await askList("Capacity changes", s.capacityFrom, {
          addLabel: "Add a capacity change…",
          empty: "No capacity changes",
          add: () => askCapacityChange("Capacity change", today),
        });
        if (v !== undefined) s.capacityFrom = sortDates(v);
      },
    },
    {
      icon: "watch",
      label: "Overtime",
      value: (s) => (s.overtime.length ? s.overtime.join(", ") : undefined),
      detail: "Extra hours on working days for a period",
      changed: changed("overtime"),
      edit: async (s) => {
        const v = await askList("Overtime", s.overtime, {
          addLabel: "Plan overtime…",
          empty: "No overtime",
          add: () => askOvertime("Overtime", today),
        });
        if (v !== undefined) s.overtime = sortDates(v);
      },
    },
    {
      icon: "calendar",
      label: "Extra working days",
      value: (s) => (s.workday.length ? s.workday.join(", ") : undefined),
      detail: "Weekend days or holidays this person works",
      changed: changed("workday"),
      edit: async (s) => {
        const v = await askList("Extra working days", s.workday, {
          addLabel: "Add a working day…",
          empty: "No extra working days",
          add: () =>
            askWorkday(
              "Extra working day",
              daysOff(plan, s.workweek, today),
              normalDayHours(plan, s.capacity, s.workweek),
              plan.project.hoursPerDay
            ),
        });
        if (v !== undefined) s.workday = sortDates(v);
      },
    },
    {
      icon: "tools",
      label: "Skills",
      value: (s) => (s.skills.length ? s.skills.join(", ") : undefined),
      detail: "Used by AI: Suggest owners",
      changed: changed("skills"),
      edit: async (s) => {
        const v = await askValues("Skills", knownSkills, s.skills, { noun: "skill" });
        if (v !== undefined) s.skills = v;
      },
    },
    {
      icon: "symbol-color",
      label: "Colour",
      value: (s) => s.color,
      detail: "On the Gantt chart, Kanban board and team load",
      changed: changed("color"),
      edit: async (s) => {
        const v = await askColor("Colour", s.color);
        if (v !== undefined) s.color = v;
      },
    },
  ];
}

function rawProp(p: Person, key: string): string {
  return p.props.entries.find((e) => e.key.toLowerCase() === key.toLowerCase())?.value ?? "";
}

function rawProps(p: Person, key: string): string[] {
  return p.props.entries
    .filter((e) => e.key.toLowerCase() === key.toLowerCase())
    .map((e) => e.value.trim());
}

export async function addPersonCommand(
  state: PlannerState,
  values?: PersonFields
): Promise<string | undefined> {
  const service = state.service;
  if (!service.root) return undefined;
  let fields = values;
  if (!fields) {
    const name = await askText({
      title: "Add person",
      prompt: "Press Enter to continue to role, capacity, time off and skills",
      placeHolder: "Name, e.g. Robin Lee",
      required: true,
      validate: (v) =>
        state.plan.personById(personIdFromName(v))
          ? "A person with this id already exists"
          : undefined,
    });
    if (!name) return undefined;
    const form: PersonForm = {
      name,
      id: personIdFromName(name),
      role: "",
      capacity: "",
      workweek: "",
      skills: [],
      color: "",
      off: [],
      capacityFrom: [],
      overtime: [],
      workday: [],
    };
    const action = await showForm({
      title: `Add person – ${name}`,
      state: form,
      actions: [{ id: "create", icon: "check", label: "Add person", description: "Enter" }],
      fields: personFields(state, true),
      placeholder: "Press Enter to add the person, or choose a field first",
    });
    if (!action) return undefined;
    fields = {
      name: form.name,
      id: form.id,
      role: form.role || undefined,
      capacity: form.capacity || undefined,
      workweek: form.workweek || undefined,
      skills: form.skills,
      color: form.color || undefined,
      off: form.off,
      capacityFrom: form.capacityFrom,
      overtime: form.overtime,
      workday: form.workday,
    };
  }
  let creation;
  try {
    creation = addPerson(service.plan, fields);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Planner: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
  if (creation.create && !(await service.createFiles([creation.create]))) return undefined;
  if (creation.edits && !(await service.apply(creation.edits, { source: "view" })))
    return undefined;
  service.fireNow();
  const id = (fields.id || personIdFromName(fields.name)).toLowerCase();
  message(`Added ${fields.name} (@owner:${id})`);
  return id;
}

export async function editPersonCommand(
  state: PlannerState,
  arg?: unknown,
  change?: PersonChange
): Promise<boolean> {
  const service = state.service;
  let person = resolvePerson(service, arg);
  if (!person) {
    const pick = await askChoice(
      "Edit which person?",
      state.plan.people.map((p) => ({ label: p.name, value: p.id, description: p.role })),
      undefined
    );
    person = pick ? state.plan.personById(pick.value) : undefined;
  }
  if (!person) return false;
  let edit = change;
  if (!edit) {
    const original: PersonForm = {
      name: person.name,
      id: person.id,
      role: person.role ?? "",
      capacity: rawProp(person, "capacity"),
      workweek: rawProp(person, "workweek"),
      skills: [...person.skills],
      color: person.color ?? "",
      off: rawProps(person, "off"),
      capacityFrom: rawProps(person, "capacityFrom"),
      overtime: rawProps(person, "overtime"),
      workday: rawProps(person, "workday"),
    };
    const form: PersonForm = {
      ...original,
      skills: [...original.skills],
      off: [...original.off],
      capacityFrom: [...original.capacityFrom],
      overtime: [...original.overtime],
      workday: [...original.workday],
    };
    const action = await showForm({
      title: `Edit ${person.name} (@owner:${person.id})`,
      state: form,
      actions: [{ id: "save", icon: "check", label: "Save changes", description: "Enter" }],
      fields: personFields(state, false, original),
      more: [
        { id: "open", icon: "go-to-file", label: "Open team.md" },
        { id: "remove", icon: "trash", label: "Remove from the team…" },
      ],
      placeholder: "Choose a field to change; ● marks changed fields; Enter saves",
    });
    if (!action) return false;
    if (action === "remove") return removePersonCommand(state, person.id);
    if (action === "open") {
      const doc = await vscode.workspace.openTextDocument(service.uri(person.file));
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(person.headingLine, 0, person.headingLine, 0),
      });
      return false;
    }
    const diff = <K extends keyof PersonForm>(k: K) =>
      JSON.stringify(form[k]) !== JSON.stringify(original[k]) ? form[k] : undefined;
    edit = {
      name: diff("name") as string | undefined,
      role: diff("role") as string | undefined,
      capacity: diff("capacity") as string | undefined,
      workweek: diff("workweek") as string | undefined,
      skills: diff("skills") as string[] | undefined,
      color: diff("color") as string | undefined,
      off: diff("off") as string[] | undefined,
      capacityFrom: diff("capacityFrom") as string[] | undefined,
      overtime: diff("overtime") as string[] | undefined,
      workday: diff("workday") as string[] | undefined,
    };
  }
  const fresh = state.plan.personById(person.id);
  const file = fresh ? state.plan.file(fresh.file) : undefined;
  if (!fresh || !file) return false;
  const edits = changePerson(file.lines, fresh, edit);
  if (edits.length === 0) return false;
  const ok = await service.apply([{ path: file.path, edits }], { source: "view" });
  if (ok) message(`Saved ${edit.name ?? fresh.name}`);
  return ok;
}

/**
 * Removes a person's section from team.md. Everything they own (tasks, punch and inbox items) goes
 * to the person chosen, or is left unassigned, so no task names an owner who is not on the team.
 */
export async function removePersonCommand(
  state: PlannerState,
  arg?: unknown,
  options?: { reassignTo?: string; confirm?: boolean }
): Promise<boolean> {
  const service = state.service;
  let person = resolvePerson(service, arg);
  if (!person) {
    const pick = await askChoice(
      "Remove which person from the team?",
      state.plan.people.map((p) => ({ label: p.name, value: p.id, description: p.role })),
      undefined
    );
    person = pick ? state.plan.personById(pick.value) : undefined;
  }
  if (!person) return false;
  const plan = state.plan;
  const owned = [...plan.tasks, ...plan.punch, ...plan.inbox].filter(
    (t) => t.owner?.toLowerCase() === person.id.toLowerCase()
  );
  let to = options?.reassignTo;
  if (to !== undefined && (!plan.personById(to) || to.toLowerCase() === person.id.toLowerCase())) {
    void vscode.window.showErrorMessage(`Planner: "${to}" is not another person on the team.`);
    return false;
  }
  if (options?.confirm !== false) {
    const open = owned.filter((t) => isOpen(t.status)).length;
    const items = `${owned.length} item${owned.length === 1 ? "" : "s"}${open < owned.length ? ` (${open} open)` : ""}`;
    if (owned.length && to === undefined) {
      const others = plan.people.filter((p) => p.id !== person.id);
      const pick = await askChoice(
        `Who takes over ${person.name}'s ${items}?`,
        [
          ...others.map((p) => ({ label: p.name, value: p.id, description: p.role })),
          { label: "Nobody", value: "", description: "leave them unassigned" },
        ],
        undefined
      );
      if (!pick) return false;
      to = pick.value || undefined;
    }
    const heir = to ? plan.personById(to)?.name : undefined;
    const detail = [
      `Their section in ${person.file} (role, capacity, time off …) is deleted.`,
      owned.length
        ? `Their ${items} ${heir ? `go to ${heir}` : "are left unassigned"}.`
        : "They own no tasks.",
      "The message afterwards has an Undo button.",
    ].join("\n");
    const answer = await vscode.window.showWarningMessage(
      `Remove ${person.name} from the team?`,
      { modal: true, detail },
      "Remove"
    );
    if (answer !== "Remove") return false;
  }
  const fresh = state.plan.personById(person.id);
  if (!fresh) return false;
  const revert = await service.applyRevertible(
    removePersonEdits(state.plan, fresh, to?.toLowerCase()),
    { source: "view" }
  );
  if (!revert) return false;
  service.fireNow();
  const heir = to ? (state.plan.personById(to)?.name ?? to) : undefined;
  offerUndo(
    service,
    `Removed ${fresh.name} from the team${owned.length ? (heir ? `; their items went to ${heir}` : "; their items are unassigned") : ""}.`,
    revert
  );
  return true;
}

export async function addTimeOffCommand(
  state: PlannerState,
  arg?: unknown,
  range?: string
): Promise<boolean> {
  const service = state.service;
  let person = resolvePerson(service, arg);
  if (!person) {
    const pick = await askChoice(
      "Time off for whom?",
      state.plan.people.map((p) => ({ label: p.name, value: p.id, description: p.role })),
      undefined
    );
    person = pick ? state.plan.personById(pick.value) : undefined;
  }
  if (!person) return false;
  const value = range ?? (await askDateRange(`Time off for ${person.name}`, state.today));
  if (!value) return false;
  const [from, to = from] = value.split("..");
  if (!isValidDate(from) || !isValidDate(to) || (parseDate(to) ?? 0) < (parseDate(from) ?? 0)) {
    void vscode.window.showErrorMessage(
      `Planner: invalid time off "${value}" (YYYY-MM-DD or from..to).`
    );
    return false;
  }
  const file = state.plan.file(person.file);
  if (!file) return false;
  const ok = await service.apply(
    [{ path: file.path, edits: [addRepeatedProperty(file.lines, person.props, "off", value)] }],
    {
      source: "view",
    }
  );
  if (ok) message(`Added time off for ${person.name}: ${value}`);
  return ok;
}

/** Upcoming days off (weekends, holidays) for a person with work week `workweek` (or the project's). */
function daysOff(
  plan: PlannerState["plan"],
  workweek: string,
  today: string,
  week?: { from: number; to: number }
): DateSuggestion[] {
  const ww = (workweek ? parseWorkweek(workweek) : undefined) ?? plan.project.workweek;
  const from = week?.from ?? parseDate(today)!;
  return daysOffSuggestions(from, ww, plan.project.holidays, { to: week?.to });
}

/** Hours of a normal working day for a capacity such as `32h/week` (or full time). */
function normalDayHours(plan: PlannerState["plan"], capacity: string, workweek: string): number {
  const ww = (workweek ? parseWorkweek(workweek) : undefined) ?? plan.project.workweek;
  const spec = capacity ? parseCapacity(capacity) : undefined;
  if (!spec) return plan.project.hoursPerDay;
  return spec.per === "day" ? spec.hours : spec.hours / Math.max(1, ww.size);
}

/** Monday..Friday and Monday..Sunday of an ISO week key such as `2026-W44`. */
function isoWeekRange(key: string | undefined): { from: number; to: number } | undefined {
  const m = key ? /^(\d{4})-W(\d{2})$/.exec(key) : null;
  if (!m) return undefined;
  // The Monday of ISO week 1 is the Monday of the week that contains 4 January.
  const jan4 = parseDate(`${m[1]}-01-04`)!;
  const from = weekStart(jan4) + (Number(m[2]) - 1) * 7;
  return { from, to: from + 6 };
}

async function pickPerson(state: PlannerState, arg: unknown, title: string) {
  const person = resolvePerson(state.service, arg);
  if (person) return person;
  const pick = await askChoice(
    title,
    state.plan.people.map((p) => ({ label: p.name, value: p.id, description: p.role })),
    undefined
  );
  return pick ? state.plan.personById(pick.value) : undefined;
}

/** Adds an `overtime:` line: from the value, or asked (with the week from the team load first). */
export async function addOvertimeCommand(
  state: PlannerState,
  arg?: unknown,
  value?: string,
  week?: string
): Promise<boolean> {
  const person = await pickPerson(state, arg, "Overtime for whom?");
  if (!person) return false;
  const range = isoWeekRange(week);
  const v =
    value ??
    (await askOvertime(
      `Overtime for ${person.name}`,
      state.today,
      range
        ? {
            from: formatDate(range.from),
            to: formatDate(range.from + 4),
            label: `Week ${week!.slice(-2)} (${week})`,
          }
        : undefined
    ));
  if (!v) return false;
  if (!parseOvertime(v)) {
    void vscode.window.showErrorMessage(
      `Planner: invalid overtime "${v}" (e.g. 2026-11-02..2026-11-27 +8h/week).`
    );
    return false;
  }
  return addPersonLine(state, person, "overtime", v, `Planned overtime for ${person.name}: ${v}`);
}

/** Adds a `workday:` line: from the value, or asked (with the days off of the week first). */
export async function addWorkdayCommand(
  state: PlannerState,
  arg?: unknown,
  value?: string,
  week?: string
): Promise<boolean> {
  const person = await pickPerson(state, arg, "Extra working day for whom?");
  if (!person) return false;
  const plan = state.plan;
  const v =
    value ??
    (await askWorkday(
      `Extra working day for ${person.name}`,
      daysOff(plan, rawProp(person, "workweek"), state.today, isoWeekRange(week)),
      normalDayHours(plan, rawProp(person, "capacity"), rawProp(person, "workweek")),
      plan.project.hoursPerDay
    ));
  if (!v) return false;
  if (!parseWorkday(v, plan.project.hoursPerDay)) {
    void vscode.window.showErrorMessage(
      `Planner: invalid working day "${v}" (e.g. 2026-11-07 or 2026-11-07 6h).`
    );
    return false;
  }
  return addPersonLine(state, person, "workday", v, `${person.name} works on ${v}`);
}

async function addPersonLine(
  state: PlannerState,
  person: Person,
  key: string,
  value: string,
  done: string
): Promise<boolean> {
  const file = state.plan.file(person.file);
  if (!file) return false;
  const ok = await state.service.apply(
    [{ path: file.path, edits: [addRepeatedProperty(file.lines, person.props, key, value)] }],
    { source: "view" }
  );
  if (ok) message(done);
  return ok;
}

interface ProjectForm {
  name: string;
  code: string;
  start: string;
  end: string;
  workweek: string;
  hoursPerDay: string;
  budget: string;
  holidays: string[];
}

export async function editProjectCommand(
  state: PlannerState,
  change?: ProjectChange
): Promise<boolean> {
  const service = state.service;
  const plan = state.plan;
  const file = plan.file(plan.project.file);
  if (!file) {
    void vscode.window.showWarningMessage(
      "Planner: there is no project.md (Planner: New project…)."
    );
    return false;
  }
  let edit = change;
  if (!edit) {
    const prop = (k: string) =>
      plan.project.props.entries.find((e) => e.key.toLowerCase() === k.toLowerCase())?.value ?? "";
    const original: ProjectForm = {
      name: plan.project.name,
      code: prop("code"),
      start: prop("start"),
      end: prop("end"),
      workweek: prop("workweek"),
      hoursPerDay: prop("hoursPerDay"),
      budget: prop("budget"),
      holidays: listItems(prop("holidays")),
    };
    const form: ProjectForm = { ...original, holidays: [...original.holidays] };
    const changed = (k: keyof ProjectForm) => (s: ProjectForm) =>
      JSON.stringify(s[k]) !== JSON.stringify(original[k]);
    const fields: Array<FormField<ProjectForm>> = [
      {
        icon: "edit",
        label: "Name",
        value: (s) => s.name,
        changed: changed("name"),
        edit: async (s) => {
          const v = await askText({ title: "Project name", value: s.name, required: true });
          if (v) s.name = v;
        },
      },
      {
        icon: "symbol-number",
        label: "Code",
        value: (s) => s.code,
        changed: changed("code"),
        edit: async (s) => {
          const v = await askText({
            title: "Project code",
            value: s.code,
            placeHolder: "e.g. P-2026-021",
          });
          if (v !== undefined) s.code = v;
        },
      },
      {
        icon: "debug-start",
        label: "Start",
        value: (s) => s.start,
        changed: changed("start"),
        edit: async (s) => {
          const v = await askDate("Project start", s.start, state.today);
          if (v !== undefined) s.start = v;
        },
      },
      {
        icon: "milestone",
        label: "End",
        value: (s) => s.end,
        changed: changed("end"),
        edit: async (s) => {
          const v = await askDate("Planned end", s.end, state.today);
          if (v !== undefined) s.end = v;
        },
      },
      {
        icon: "checklist",
        label: "Work week",
        value: (s) => s.workweek || "mon-fri",
        changed: changed("workweek"),
        edit: async (s) => {
          const v = await askWorkweek("Working days of the project", s.workweek, undefined);
          if (v !== undefined) s.workweek = v;
        },
      },
      {
        icon: "watch",
        label: "Hours per day",
        value: (s) => s.hoursPerDay || "8",
        detail: "Length of a working day; 1d in an estimate means this many hours",
        changed: changed("hoursPerDay"),
        edit: async (s) => {
          const v = await askText({
            title: "Hours per working day",
            value: s.hoursPerDay,
            placeHolder: "8",
            validate: (x) =>
              /^\d+(\.\d+)?$/.test(x) && Number(x) > 0 && Number(x) <= 24
                ? undefined
                : "A number of hours from 1 to 24",
          });
          if (v !== undefined) s.hoursPerDay = v;
        },
      },
      {
        icon: "credit-card",
        label: "Budget",
        value: (s) => s.budget || undefined,
        detail: "Hours for the whole project; the dashboard compares it with the plan",
        changed: changed("budget"),
        edit: async (s) => {
          const hpd = Number(s.hoursPerDay) || plan.project.hoursPerDay;
          const v = await askText({
            title: "Project budget in hours (empty: no budget)",
            value: s.budget,
            placeHolder: "e.g. 1200h, 150d or 30w",
            validate: (x) => {
              if (x.trim() === "" || parseBudget(x, hpd) !== undefined) return undefined;
              const both = ambiguousBudget(x);
              return both
                ? `${x.trim()} can mean ${both[0]} or ${both[1]}: write the one you mean`
                : "Hours such as 1200h, or days or weeks (150d, 30w)";
            },
          });
          if (v !== undefined) s.budget = v.trim();
        },
      },
      {
        icon: "calendar",
        label: "Holidays",
        value: (s) =>
          s.holidays.length ? `${s.holidays.length}: ${s.holidays.join(", ")}` : undefined,
        detail: "Non-working days for everybody",
        changed: changed("holidays"),
        edit: async (s) => {
          const v = await askList("Holidays", s.holidays, {
            addLabel: "Add a holiday…",
            empty: "No holidays",
            add: () => askDateRange("Holiday", state.today),
          });
          if (v !== undefined) s.holidays = sortDates(v);
        },
      },
    ];
    const action = await showForm({
      title: `Project – ${plan.project.name}`,
      state: form,
      actions: [{ id: "save", icon: "check", label: "Save changes", description: "Enter" }],
      fields,
      more: [{ id: "open", icon: "go-to-file", label: "Open project.md" }],
      placeholder: "Choose a field to change; ● marks changed fields; Enter saves",
    });
    if (!action) return false;
    if (action === "open") {
      await vscode.window.showTextDocument(service.uri(plan.project.file));
      return false;
    }
    const pick = <K extends keyof ProjectForm>(k: K) => (changed(k)(form) ? form[k] : undefined);
    edit = {
      name: pick("name") as string | undefined,
      code: pick("code") as string | undefined,
      start: pick("start") as string | undefined,
      end: pick("end") as string | undefined,
      workweek: pick("workweek") as string | undefined,
      hoursPerDay: pick("hoursPerDay") as string | undefined,
      budget: pick("budget") as string | undefined,
      holidays: pick("holidays") as string[] | undefined,
    };
  }
  const fresh = state.plan.file(state.plan.project.file);
  if (!fresh) return false;
  const edits = changeProject(fresh.lines, state.plan.project, edit);
  if (edits.length === 0) return false;
  const ok = await service.apply([{ path: fresh.path, edits }], { source: "view" });
  if (ok) message("Saved the project settings");
  return ok;
}
