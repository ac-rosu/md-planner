// TODO/FIXME comments in source code, and the edits that promote one to a plan task.
import { type ParsedFile, type Task } from "./model";
import { tokenize } from "./parser/taskLine";
import { type Plan } from "./resolve";
import { range, type TextEdit } from "./text";
import { type InsertLocation, insertTasks, nextId } from "./writer";

export const DEFAULT_TODO_KEYWORDS = ["TODO", "FIXME"];
export const DEFAULT_TODO_INCLUDE =
  "**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,py,java,kt,cs,go,rs,rb,php,swift,c,h,cpp,hpp,sql,sh,md,scl,st}";
export const DEFAULT_TODO_EXCLUDE =
  "**/{node_modules,.git,dist,out,build,target,coverage,vendor,.venv,.vscode-test}/**";

export interface TodoItem {
  keyword: string;
  /**
   * Task id from `TODO(T142)` or `TODO(T142, alice)`, when the comment is linked: the first entry
   * in the parentheses that looks like a task id (TASK_ID). The task may be gone (see linkedTask).
   */
  taskId?: string;
  /** What the parentheses after the keyword hold (`alice` in `TODO(alice):`), when it has any. */
  ref?: string;
  text: string;
  line: number;
  /** Column of the keyword. */
  column: number;
  /** Column right after the keyword (where `(T142)` is inserted, or the parentheses open). */
  keywordEnd: number;
}

/**
 * A task id in `TODO(…)`: capital letters and digits, as the planner's ids (`T142`, `P007`).
 * Other notes there are not links: a version (`v2`), an issue (`issue42`) or a name (`alice`).
 */
const TASK_ID = /^[A-Z]+\d+$/;

/** Characters that close comments and should not end up in task titles. */
const TRAILERS = /\s*(\*\/|-->|\*\)|#>|"""|''')\s*$/;

/**
 * Finds `TODO`, `FIXME` (or other keywords) followed by `:`, `(…)` or whitespace and some
 * text. The keyword must be a whole word in upper case.
 */
export function scanTodos(text: string, keywords: string[] = DEFAULT_TODO_KEYWORDS): TodoItem[] {
  // An empty keyword would make almost every line a TODO comment.
  const words = keywords.filter((k) => typeof k === "string" && k.trim() !== "");
  if (words.length === 0) return [];
  const alternation = words.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(^|[^A-Za-z0-9_])(${alternation})(?:\\(([^)]*)\\))?(?::|\\s)\\s*(.*)$`);
  const items: TodoItem[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const column = m.index + m[1].length;
    const body = m[4].replace(TRAILERS, "").trim();
    if (!body) continue;
    const ref = m[3];
    items.push({
      keyword: m[2],
      taskId: ref
        ?.split(",")
        .map((s) => s.trim())
        .find((s) => TASK_ID.test(s)),
      ref,
      text: body,
      line: i,
      column,
      keywordEnd: column + m[2].length,
    });
  }
  return items;
}

/** The task a comment is linked to; undefined when it is not, or that task is no longer planned. */
export function linkedTask(plan: Plan, todo: TodoItem): Task | undefined {
  return todo.taskId === undefined ? undefined : plan.taskById(todo.taskId);
}

/**
 * A comment's text as a task title that reads back as written: what a task line reads as a tag,
 * an attribute or its id (see titleMarkup) goes in parentheses, so `remove once #1234 is merged`
 * keeps `(#1234)` in the title instead of losing it to a tag.
 */
export function todoTitle(text: string): string {
  let out = "";
  let at = 0;
  for (const t of tokenize(text, 0)) {
    if (t.kind !== "tag" && t.kind !== "attr" && t.kind !== "id") continue;
    out += `${text.slice(at, t.start)}(${text.slice(t.start, t.end)})`;
    at = t.end;
  }
  return out + text.slice(at);
}

export interface PromoteTodo {
  todo: TodoItem;
  /** Workspace-relative POSIX path of the source file. */
  sourcePath: string;
  milestoneFile: ParsedFile;
  location: InsertLocation;
  title?: string;
  owner?: string;
}

export interface Promotion {
  id: string;
  planEdits: TextEdit[];
  /** Edit of the source line: `TODO:` → `TODO(T142):`, `TODO(alice):` → `TODO(T142, alice):`. */
  sourceEdit: TextEdit;
}

/**
 * A task with `@src:path#Lline` in the milestone, and its id after the keyword in the code: in
 * parentheses, or first in the ones the comment has, so that scanTodos reads it back and nothing
 * written there is lost.
 */
export function promoteTodo(plan: Plan, p: PromoteTodo): Promotion {
  const id = nextId(plan, "T");
  const attrs: Array<[string, string]> = [];
  if (p.owner) attrs.push(["owner", p.owner]);
  attrs.push(["src", `${p.sourcePath}#L${p.todo.line + 1}`]);
  const planEdits = insertTasks(p.milestoneFile, p.location, [
    { title: p.title ?? todoTitle(p.todo.text), attrs, id },
  ]);
  const { line, keywordEnd, ref } = p.todo;
  // Inside the parentheses: right after `(`; an empty pair is replaced.
  const inside = keywordEnd + 1;
  const sourceEdit: TextEdit =
    ref === undefined
      ? { range: range(line, keywordEnd, keywordEnd), newText: `(${id})` }
      : ref.trim()
        ? { range: range(line, inside, inside), newText: `${id}, ` }
        : { range: range(line, inside, inside + ref.length), newText: id };
  return { id, planEdits, sourceEdit };
}

/** Parses `src/server/payments.ts#L42` into a path and a 0-based line. */
export function parseSrc(src: string): { path: string; line?: number } {
  const m = /^(.*?)(?:#L(\d+))?$/.exec(src.trim());
  return { path: m?.[1] ?? src, line: m?.[2] ? Number(m[2]) - 1 : undefined };
}

/**
 * `planner.todos.keywords` as the scan uses it: the keywords that are text and not empty; the
 * default ones when the setting is not a list.
 */
export function todoKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_TODO_KEYWORDS;
  return value.filter((k): k is string => typeof k === "string" && k.trim() !== "");
}

/** `planner.todos.include`: the default when it is empty or not text. */
export function todoInclude(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : DEFAULT_TODO_INCLUDE;
}

/** `planner.todos.exclude`: "" excludes nothing; the default when it is not text. */
export function todoExclude(value: unknown): string {
  return typeof value === "string" ? value : DEFAULT_TODO_EXCLUDE;
}

/** The last globs compiled (the TODO scanner matches every changed file against two of them). */
const compiled = new Map<string, RegExp>();

/**
 * Minimal glob matcher for `**`, `*`, `?` and `{a,b}` (enough for the include/exclude settings).
 * A `{` without its `}` is an ordinary character.
 */
export function globMatch(glob: string, path: string): boolean {
  let re = compiled.get(glob);
  if (!re) {
    if (compiled.size >= 16) compiled.clear();
    compiled.set(glob, (re = globRegExp(glob)));
  }
  return re.test(path);
}

function globRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{" && glob.indexOf("}", i) > i) {
      const end = glob.indexOf("}", i);
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$(){}|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
