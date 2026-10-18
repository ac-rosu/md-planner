// build_plan: a whole plan (or an extension of one) in one call. An agent turns a plain-text
// description into this structure; the server creates the project if needed, adds or updates
// people and milestones, creates sections and tasks (dependencies may name tasks of any milestone
// of the call by ref or title), inbox and punch items and test plans — all staged, validated and
// written together, or not at all.
import { formatDate } from "../core/dates";
import { validatePlan } from "../core/validate";
import { splitMilestoneTitle } from "../core/writer/entities";
import {
  type MilestoneInput,
  type MilestoneUpdate,
  milestoneOf,
  stageMilestones,
  stageMilestoneUpdate,
  stageSections,
} from "./milestoneTools";
import { type PunchInput, stageInbox, stagePunchItems } from "./inboxTools";
import { applySettings, type CreateProjectArgs, stageProject } from "./projectTools";
import { type TaskGroup, prepareGroup, stageGroup } from "./taskTools";
import { TaskRefs, type TaskSpec, personOf } from "./taskSpecs";
import { type PersonInput, stagePeople, stagePersonUpdate } from "./teamTools";
import { stageTestPlans, type TestPlanInput } from "./testTools";
import { type PlannerTools, ToolError } from "./tools";

export interface SectionInput {
  title: string;
  tasks?: TaskSpec[];
}

export interface PlanMilestone extends Omit<MilestoneInput, "sections" | "name"> {
  /** Needed for a new milestone; for an existing one found by id, a new name. */
  name?: string;
  /** Section titles, or sections with their tasks. */
  sections?: Array<string | SectionInput>;
  /** Tasks directly under the milestone (no section). */
  tasks?: TaskSpec[];
}

export interface BuildPlanArgs {
  /** Project settings: create the project when there is none, else change its settings. */
  project?: Partial<CreateProjectArgs>;
  /** New people are added; people that exist (by id or name) are updated. */
  people?: PersonInput[];
  /** New milestones are created; existing ones (by id or name) are updated and extended. */
  milestones?: PlanMilestone[];
  inbox?: string[];
  punch?: PunchInput[];
  tests?: TestPlanInput[];
  /** Check everything and report the result without writing. */
  dryRun?: boolean;
}

export function buildPlan(tools: PlannerTools, args: BuildPlanArgs) {
  const st = tools.stage({ allowMissingPlan: true });
  const created = { project: false, people: [] as string[], milestones: [] as string[] };
  const updated = { people: [] as string[], milestones: [] as string[] };

  // Project
  if (!st.exists("project.md")) {
    if (!args.project?.name)
      throw new ToolError("There is no plan yet: give project settings with at least a name.");
    stageProject(tools, st, args.project as CreateProjectArgs);
    created.project = true;
  } else if (args.project) {
    const { template: _t, templatesFolder: _f, lead: _l, ...settings } = args.project;
    if (Object.values(settings).some((v) => v !== undefined)) applySettings(st, settings);
  }

  // People
  for (const p of args.people ?? []) {
    const existing = personOf(st.plan, p.id ?? p.name ?? "", { exact: true });
    if (existing) {
      stagePersonUpdate(st, { ...p, id: existing });
      updated.people.push(existing);
    } else created.people.push(...stagePeople(st, [p]));
  }

  // Milestones: create the new ones, then dependencies and changes of all of them.
  const ids: string[] = [];
  const renames: Array<string | undefined> = [];
  const fresh: Array<{ index: number; input: MilestoneInput }> = [];
  (args.milestones ?? []).forEach((m, index) => {
    const byId = m.id ? st.plan.milestoneById(m.id) : undefined;
    const existing = byId || (m.name && milestoneOf(st.plan, m.name));
    if (!existing) {
      fresh.push({
        index,
        input: { ...m, name: m.name ?? "", depends: undefined, sections: undefined },
      });
      return;
    }
    ids[index] = existing.id;
    // Found by name: the name is how it was found, not a new one.
    const name = m.name?.replace(/\s+/g, " ").trim();
    if (byId && name && name !== splitMilestoneTitle(byId.id, byId.title).name)
      renames[index] = name;
  });
  const newIds = stageMilestones(
    st,
    fresh.map((f) => f.input)
  );
  fresh.forEach((f, i) => {
    ids[f.index] = newIds[i];
    created.milestones.push(newIds[i]);
  });
  (args.milestones ?? []).forEach((m, index) => {
    const id = ids[index];
    const titles = (m.sections ?? []).map((s) => (typeof s === "string" ? s : s.title));
    stageSections(st, id, titles);
    const isNew = created.milestones.includes(id);
    const change: MilestoneUpdate = isNew
      ? { id, depends: m.depends }
      : {
          id,
          depends: m.depends,
          name: renames[index],
          target: m.target,
          status: m.status,
          description: m.description,
        };
    if (Object.values(change).filter((v) => v !== undefined).length > 1) {
      stageMilestoneUpdate(st, change);
      if (!isNew) updated.milestones.push(id);
    }
  });

  // Tasks: ids for every group first, so dependencies can point anywhere in the call.
  const refs = new TaskRefs();
  const groups: TaskGroup[] = [];
  (args.milestones ?? []).forEach((m, index) => {
    const milestone = ids[index];
    if (m.tasks?.length) groups.push(prepareGroup(st, refs, { milestone }, m.tasks));
    for (const s of m.sections ?? [])
      if (typeof s !== "string" && s.tasks?.length)
        groups.push(prepareGroup(st, refs, { milestone, section: s.title }, s.tasks));
  });
  const errors: string[] = [];
  for (const g of groups) stageGroup(st, refs, g, tools.today, errors);
  if (errors.length) throw new ToolError(`Nothing was written:\n- ${errors.join("\n- ")}`);

  if (args.inbox?.length) stageInbox(st, args.inbox);
  const punch = args.punch?.length ? stagePunchItems(st, args.punch, tools.today) : [];
  const tests = args.tests?.length ? stageTestPlans(st, args.tests) : [];

  const tasks = refs.created.map(({ ref, id, title, milestone }) => ({
    ...(ref ? { ref } : {}),
    id,
    title,
    milestone,
  }));
  const summary = { created: { ...created, tasks, punch, tests }, updated };

  if (args.dryRun) {
    const plan = st.plan;
    const schedule = tools.scheduleOf(plan);
    const issues = validatePlan(plan, { graph: schedule.graph });
    return {
      dryRun: true,
      ...summary,
      wouldFail: tools.newErrors(st),
      files: st.changes().map((c) => ({ file: c.file, created: c.created ?? false })),
      ...forecast(plan, schedule),
      warnings: issues
        .filter((i) => i.severity !== "error")
        .map((i) => i.message)
        .slice(0, 30),
    };
  }
  const changed = tools.commit(st);
  const plan = tools.plan;
  const issues = validatePlan(plan, { graph: tools.schedule.graph });
  return {
    ...summary,
    files: changed.map((c) => ({ file: c.file, created: c.created ?? false })),
    ...forecast(plan, tools.schedule),
    warnings: issues
      .filter((i) => i.severity !== "error")
      .map((i) => i.message)
      .slice(0, 30),
  };
}

function forecast(plan: PlannerTools["plan"], schedule: PlannerTools["schedule"]) {
  const fmt = (d: number | undefined) => (d === undefined ? undefined : formatDate(d));
  return {
    finish: fmt(schedule.finish),
    milestones: plan.milestones.map((m) => {
      const ms = schedule.milestones.get(m.id);
      return {
        id: m.id,
        title: m.title,
        target: m.target,
        forecast: fmt(ms?.forecast),
        late: ms?.late ?? false,
        variance: ms?.variance,
      };
    }),
  };
}
