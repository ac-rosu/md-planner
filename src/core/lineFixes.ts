// Text fixes for the quick fixes of diagnostics about things the planner reads differently than
// they were meant: `@Owner:bob`, `@dep:T2, T1`, `- [ ] f ^T6 @est:8h`, a property below its block.
import { type TextEdit, type TextLines } from "./text";

/** The line with the attribute at [start, end) under another key: `@Owner:bob` → `@owner:bob`. */
export function renameAttrKey(line: string, start: number, end: number, key: string): string {
  const attr = line.slice(start, end).replace(/^@[^:\s]+/, `@${key}`);
  return line.slice(0, start) + attr + line.slice(end);
}

/**
 * `@dep:T2, T1, T3+2d` → `@dep:T2,T1,T3+2d`: the ids after a comma and a space joined back into the
 * value. Only words that look like ids (with a digit) are joined, so `@dep:T2, then …` keeps its
 * text. Undefined when there is nothing to join.
 */
export function joinDepIds(line: string): string | undefined {
  const next = /(@dep:\S*,)[ \t]+(?=[A-Za-z_-]*\d[\w-]*(?:\+[\d.]+[hdw]?)?(?:,|[ \t]|$))/;
  // `@dep:T1 +2d`: a lag after the space.
  const lag = /(@dep:\S*[^,\s])[ \t]+(\+\d+(?:\.\d+)?[hdw]?)(?=[ \t,]|$)/;
  let out = line;
  for (let prev = ""; prev !== out;) {
    prev = out;
    out = out.replace(next, "$1").replace(lag, "$1$2");
  }
  return out === line ? undefined : out;
}

/**
 * The edits that move line `from` up to line `to` (a property line below its block, into it):
 * inserted after line `to - 1` and removed where it was, keeping the file's line ends. The two
 * edits never touch, also when the line is the last one of a file without a final line end.
 */
export function moveLineUp(lines: TextLines, from: number, to: number): TextEdit[] {
  const insert: TextEdit = {
    range: { start: lines.lineEnd(to - 1), end: lines.lineEnd(to - 1) },
    newText: `${lines.eol}${lines.line(from)}`,
  };
  const remove: TextEdit =
    from === lines.lineCount - 1
      ? { range: { start: lines.lineEnd(from - 1), end: lines.lineEnd(from) }, newText: "" }
      : {
          range: { start: { line: from, character: 0 }, end: { line: from + 1, character: 0 } },
          newText: "",
        };
  return [insert, remove];
}

/**
 * `- [ ] f ^T6 @est:8h` → `- [ ] f @est:8h ^T6`: the id at [start, end) moved to the end of the
 * line, where it is read as the id. Undefined when the line already ends with another id.
 */
export function moveIdToEnd(line: string, start: number, end: number): string | undefined {
  const id = line.slice(start, end);
  if (/\^[A-Za-z0-9_-]+[ \t]*$/.test(line.slice(end))) return undefined;
  // Take one space next to it along, so no double space is left.
  const from = start > 0 && /[ \t]/.test(line[start - 1]) ? start - 1 : start;
  const to = from === start && /[ \t]/.test(line[end] ?? "") ? end + 1 : end;
  const rest = line.slice(0, from) + line.slice(to);
  const body = rest.replace(/[ \t]+$/, "");
  return `${body} ${id}${rest.slice(body.length)}`;
}
