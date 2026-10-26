import { describe, expect, it } from "vitest";
import {
  EditLog,
  followLine,
  lineAfter,
  lineBefore,
  type TextChange,
} from "../../../src/core/lineHistory";
import { applyEdits, TextLines } from "../../../src/core/text";

const change = (sl: number, sc: number, el: number, ec: number, text: string): TextChange => ({
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  text,
});
const insert = (line: number, text: string) => change(line, 0, line, 0, text);

describe("lineAfter and lineBefore", () => {
  it("follow a line through lines added and removed above it, and back", () => {
    expect(lineAfter(10, [insert(2, "a\nb\n")])).toBe(12);
    expect(lineBefore(12, [insert(2, "a\nb\n")])).toBe(10);
    expect(lineBefore(3, [insert(2, "a\nb\n")])).toBeUndefined();
    expect(lineAfter(10, [change(2, 0, 4, 0, "")])).toBe(8);
    expect(lineBefore(8, [change(2, 0, 4, 0, "")])).toBe(10);
    // Deleted or replaced: gone; typed within or at its start: kept.
    expect(lineAfter(10, [change(10, 0, 11, 0, "")])).toBeUndefined();
    expect(lineAfter(10, [change(10, 0, 10, 5, "- [x]")])).toBe(10);
    expect(lineAfter(10, [insert(10, "  ")])).toBe(10);
    // A line break typed within it: the rest is a line added below.
    expect(lineAfter(10, [change(10, 4, 10, 4, "\n")])).toBe(10);
    expect(lineBefore(11, [change(10, 4, 10, 4, "\n")])).toBeUndefined();
    expect(lineBefore(12, [change(10, 4, 10, 4, "\n")])).toBe(11);
  });

  it("are each other's reverse for the lines a change keeps, in any text", () => {
    // A small deterministic generator: random texts and changes, applied one after the other.
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pieces = ["", "a", "bc", "\n", "x\n", "\ny", "\n\n", "pq\nr\n"];
    for (let run = 0; run < 3000; run++) {
      let text = Array.from({ length: 1 + next(6) }, () => "line".slice(0, next(5))).join("\n");
      const changes: TextChange[] = [];
      const before = TextLines.parse(text).lineCount;
      for (let n = 1 + next(3); n > 0; n--) {
        const lines = TextLines.parse(text);
        const pos = () => {
          const line = next(lines.lineCount);
          return { line, character: next(lines.line(line).length + 1) };
        };
        let [start, end] = [pos(), pos()];
        if (start.line > end.line || (start.line === end.line && start.character > end.character))
          [start, end] = [end, start];
        const c = { range: { start, end }, text: pieces[next(pieces.length)] };
        changes.push(c);
        text = applyEdits(text, [{ range: c.range, newText: c.text }]);
      }
      const after = TextLines.parse(text).lineCount;
      const kept = new Map<number, number>();
      for (let line = 0; line < before; line++) {
        const to = lineAfter(line, changes);
        if (to === undefined) continue;
        expect(to).toBeGreaterThanOrEqual(0);
        expect(to).toBeLessThan(after);
        expect(lineBefore(to, changes)).toBe(line);
        kept.set(to, line);
      }
      // Every other line of the text now was added by the changes.
      for (let line = 0; line < after; line++)
        expect(lineBefore(line, changes)).toBe(kept.get(line));
    }
  });
});

describe("followLine", () => {
  const TITLE = "Order events schema";
  const LINE = `- [ ] ${TITLE} @est:6h ^T104`;

  it("follows the line of an item, or says it was deleted or replaced", () => {
    expect(followLine(10, TITLE, [insert(2, "Typed above\n")])).toBe(11);
    expect(followLine(10, TITLE, [insert(10, "- [ ] Typed above @est:1h\n")])).toBe(11);
    expect(followLine(10, TITLE, [change(10, 0, 11, 0, "")])).toBeNull();
    expect(followLine(10, TITLE, [change(9, 0, 11, 0, "- [ ] Other\n")])).toBeNull();
    // A copy pasted elsewhere leaves it where it is.
    expect(followLine(10, TITLE, [insert(3, `${LINE}\n`)])).toBe(11);
    expect(followLine(10, TITLE, [insert(14, `${LINE}\n`)])).toBe(10);
  });

  it("does not tell the line from a copy put right next to it", () => {
    // Copy Line Down inserts the copy at its start, Copy Line Up after its end.
    expect(followLine(10, TITLE, [insert(10, `${LINE}\n`)])).toBeUndefined();
    expect(followLine(10, TITLE, [change(10, 30, 10, 30, `\n${LINE}`)])).toBeUndefined();
    // Lines 9 to 11 copied down, with it among them; a long text may hold it too.
    expect(followLine(10, TITLE, [insert(9, `a\n${LINE}\nb\n`)])).toBeUndefined();
    const long = `${"- [ ] Other task\n".repeat(200)}`;
    expect(followLine(10, TITLE, [{ ...insert(10, long), long: true }])).toBeUndefined();
    // Once it moved on, a copy next to its old place does not matter.
    expect(followLine(10, TITLE, [insert(0, "a\n"), insert(10, `${LINE}\n`)])).toBe(12);
  });
});

describe("EditLog", () => {
  it("keeps the changes that add or remove lines, by version and time", () => {
    const log = new EditLog(1, 0);
    log.record(2, 1, [change(0, 0, 0, 3, "abc")]);
    log.record(3, 2, [insert(4, "a\n")]);
    log.record(3, 3, []);
    log.record(4, 4, [change(6, 0, 7, 0, "")]);
    expect(log.changes(0, 4)).toEqual([insert(4, "a\n"), change(6, 0, 7, 0, "")]);
    expect(log.changes(2, 4)).toEqual([change(6, 0, 7, 0, "")]);
    expect(log.changes(2, 3)).toEqual([]);
    // A version it has not seen.
    expect(log.changes(0, 5)).toBeUndefined();
  });

  it("keeps long texts as their line breaks", () => {
    const log = new EditLog(1, 0);
    const text = `${"a".repeat(3000)}\nb\n`;
    log.record(2, 1, [insert(0, text)]);
    expect(log.changes(0, 2)).toEqual([{ ...insert(0, "x\nx\n"), long: true }]);
  });

  it("forgets the oldest changes beyond its limit", () => {
    const log = new EditLog(1, 0, 2);
    for (let v = 2; v <= 4; v++) log.record(v, v, [insert(0, "a\n")]);
    expect(log.changes(1, 4)).toBeUndefined();
    expect(log.changes(2, 4)).toEqual([insert(0, "a\n"), insert(0, "a\n")]);
  });

  it("starts anew when the versions are out of step", () => {
    const log = new EditLog(5, 0);
    log.record(6, 1, [insert(0, "a\n")]);
    log.record(3, 2, [insert(0, "b\n")]);
    expect(log.changes(0, 3)).toBeUndefined();
    log.record(4, 3, [insert(0, "c\n")]);
    expect(log.changes(2, 4)).toEqual([insert(0, "c\n")]);
  });
});
