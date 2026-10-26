// TODO/FIXME comments in source code, and the edits that promote one to a plan task.
import { type ParsedFile } from "./model";
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
  /** Task id from `TODO(T142)`, when the comment is already linked. */
  taskId?: string;
  text: string;
  line: number;
  /** Column of the keyword. */
  column: number;
  /** Column right after the keyword (where `(T142)` is inserted). */
  keywordEnd: number;
}

/** Characters that close comments and should not end up in task titles. */
const TRAILERS = /\s*(\*\/|-->|\*\)|#>|"""|''')\s*$/;

/**
 * Finds `TODO`, `FIXME` (or other keywords) followed by `:`, `(…)` or whitespace and some
 * text. The keyword must be a whole word in upper case.
 */
export function scanTodos(text: string, keywords: string[] = DEFAULT_TODO_KEYWORDS): TodoItem[] {
  if (keywords.length === 0) return [];
  const alternation = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(^|[^A-Za-z0-9_])(${alternation})(?:\\(([^)]*)\\))?(?::|\\s)\\s*(.*)$`);
  const items: TodoItem[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const column = m.index + m[1].length;
    const body = m[4].replace(TRAILERS, "").trim();
    if (!body) continue;
    const ref = m[3]?.trim();
    items.push({
      keyword: m[2],
      taskId: ref && /^[A-Za-z]+\d+$/.test(ref) ? ref : undefined,
      text: body,
      line: i,
      column,
      keywordEnd: column + m[2].length,
    });
  }
  return items;
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
  /** Edit of the source line: `TODO:` → `TODO(T142):`. */
  sourceEdit: TextEdit;
}

/** A task with `@src:path#Lline` in the milestone, and `(T142)` after the keyword in the code. */
export function promoteTodo(plan: Plan, p: PromoteTodo): Promotion {
  const id = nextId(plan, "T");
  const attrs: Array<[string, string]> = [];
  if (p.owner) attrs.push(["owner", p.owner]);
  attrs.push(["src", `${p.sourcePath}#L${p.todo.line + 1}`]);
  const planEdits = insertTasks(p.milestoneFile, p.location, [
    { title: p.title ?? p.todo.text, attrs, id },
  ]);
  const sourceEdit: TextEdit = {
    range: range(p.todo.line, p.todo.keywordEnd, p.todo.keywordEnd),
    newText: `(${id})`,
  };
  return { id, planEdits, sourceEdit };
}

/** Parses `src/server/payments.ts#L42` into a path and a 0-based line. */
export function parseSrc(src: string): { path: string; line?: number } {
  const m = /^(.*?)(?:#L(\d+))?$/.exec(src.trim());
  return { path: m?.[1] ?? src, line: m?.[2] ? Number(m[2]) - 1 : undefined };
}

/** Minimal glob matcher for `**`, `*`, `?` and `{a,b}` (enough for the include/exclude settings). */
export function globMatch(glob: string, path: string): boolean {
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
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}
