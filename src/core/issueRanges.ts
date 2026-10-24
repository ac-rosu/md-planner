// Where diagnostics point on a task line: the checkbox, the task text, one attribute or one id in
// a `@dep` list. Shared by the validation modules.
import { type Issue, type Task } from "./model";
import { type Plan } from "./resolve";
import { range, type Range } from "./text";

/** An issue on one attribute of a task (the checkbox when the attribute is missing). */
export function attrIssue(
  t: Task,
  key: string,
  severity: Issue["severity"],
  code: string,
  message: string,
  data?: Record<string, string>
): Issue {
  const a = t.attrs.find((x) => x.key === key);
  return {
    file: t.file,
    range: a?.range ?? statusRange(t),
    severity,
    code,
    message,
    data: { key, ...data },
  };
}

/** Range of the checkbox `[ ]`. */
export function statusRange(t: Task): Range {
  return range(t.line, t.statusCol - 1, t.statusCol + 2);
}

/** Range of the task text after the checkbox. */
export function lineContentRange(plan: Plan, t: Task): Range {
  const text = plan.file(t.file)?.lines.line(t.line) ?? "";
  return range(t.line, Math.min(t.statusCol + 2, text.length), text.replace(/\s+$/, "").length);
}

/** Precise range of one id inside a task's `@dep` value. */
export function depIdRange(t: Task, id: string): Range {
  const a = t.attrs.find((x) => x.key === "dep");
  if (!a) return statusRange(t);
  if (!a.quoted) {
    const re = new RegExp(`(^|,)\\s*(${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=\\+|,|\\s*$)`);
    const m = re.exec(a.value);
    if (m) {
      const offset = m.index + m[0].length - m[2].length;
      const start = a.valueRange.start.character + offset;
      return range(a.range.start.line, start, start + id.length);
    }
  }
  return a.valueRange;
}
