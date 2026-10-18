// TODO comments in the source code of the workspace (the parent of the plan folder): list them and
// promote one to a task (with @src back to the line; the comment gets the id: TODO(T142)).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DEFAULT_TODO_EXCLUDE,
  DEFAULT_TODO_INCLUDE,
  DEFAULT_TODO_KEYWORDS,
  globMatch,
  promoteTodo as promoteTodoEdits,
  scanTodos,
} from "../core/todos";
import { applyEdits } from "../core/text";
import { type InsertLocation } from "../core/writer";
import { milestoneOf } from "./milestoneTools";
import { workspaceSettings } from "./settings";
import { personOf } from "./taskSpecs";
import { type PlannerTools, ToolError } from "./tools";

interface ScanOptions {
  include?: string;
  exclude?: string;
  keywords?: string[];
  maxFiles?: number;
}

function options(tools: PlannerTools, args: ScanOptions) {
  const s = workspaceSettings(tools.workspaceDir);
  return {
    include: args.include ?? ((s["todos.include"] as string) || DEFAULT_TODO_INCLUDE),
    exclude: args.exclude ?? (s["todos.exclude"] as string) ?? DEFAULT_TODO_EXCLUDE,
    keywords: args.keywords ?? ((s["todos.keywords"] as string[]) || DEFAULT_TODO_KEYWORDS),
    maxFiles: args.maxFiles ?? Number(s["todos.maxFiles"] ?? 2000),
  };
}

/** Workspace files matching include and not exclude, the plan folder left out. */
function sourceFiles(tools: PlannerTools, o: ReturnType<typeof options>): string[] {
  const root = tools.workspaceDir;
  const planRel = relative(root, tools.planDir).split(sep).join("/");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (out.length >= o.maxFiles) return;
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      if (rel === planRel || rel.startsWith(`${planRel}/`)) continue;
      const isDir = statSync(full).isDirectory();
      if (o.exclude && globMatch(o.exclude, isDir ? `${rel}/x` : rel)) continue;
      if (isDir) walk(full);
      else if (globMatch(o.include, rel)) out.push(rel);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

export function listTodos(tools: PlannerTools, args: ScanOptions & { unlinkedOnly?: boolean }) {
  const plan = tools.load();
  const o = options(tools, args);
  const root = tools.workspaceDir;
  const items = sourceFiles(tools, o).flatMap((file) =>
    scanTodos(readFileSync(join(root, file), "utf8"), o.keywords).map((t) => ({
      file,
      line: t.line + 1,
      keyword: t.keyword,
      text: t.text,
      task: t.taskId,
      taskStatus: t.taskId ? plan.taskById(t.taskId)?.status : undefined,
    }))
  );
  return args.unlinkedOnly ? items.filter((i) => !i.task) : items;
}

export function promoteTodo(
  tools: PlannerTools,
  args: {
    file: string;
    line: number;
    milestone: string;
    section?: string;
    title?: string;
    owner?: string;
  }
) {
  const st = tools.stage();
  const plan = st.plan;
  const root = tools.workspaceDir;
  const sourcePath = args.file.split("\\").join("/").replace(/^\.\//, "");
  const full = join(root, sourcePath);
  if (!existsSync(full)) throw new ToolError(`File not found: ${sourcePath}`);
  const text = readFileSync(full, "utf8");
  const o = options(tools, {});
  const todo = scanTodos(text, o.keywords).find((t) => t.line === args.line - 1);
  if (!todo)
    throw new ToolError(
      `No ${o.keywords.join("/")} comment on line ${args.line} of ${sourcePath}.`
    );
  if (todo.taskId) throw new ToolError(`That comment is already linked to ${todo.taskId}.`);
  const m = milestoneOf(plan, args.milestone);
  if (!m) throw new ToolError(`Unknown milestone "${args.milestone}".`);
  const owner = args.owner ? personOf(plan, args.owner) : undefined;
  if (args.owner && !owner) throw new ToolError(`Unknown owner "${args.owner}".`);
  const location: InsertLocation = args.section?.trim()
    ? { kind: "section", title: args.section.trim() }
    : { kind: "root" };
  const p = promoteTodoEdits(plan, {
    todo,
    sourcePath,
    milestoneFile: plan.file(m.file)!,
    location,
    title: args.title,
    owner,
  });
  st.apply({ path: m.file, edits: p.planEdits });
  const sourceRel = relative(tools.planDir, full).split(sep).join("/");
  st.set(sourceRel, applyEdits(text, [p.sourceEdit]));
  return { id: p.id, milestone: m.id, changed: tools.commit(st) };
}
