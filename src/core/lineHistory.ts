// Following lines through the changes of a document: where a line went (or that it was deleted or
// replaced), where a line came from (or that it was added), and a bounded log of the changes of an
// open document, so that an item parsed earlier can be found again on its line.
import { type Range } from "./text";

/** A change of a document's text: a range replaced by a text (as VS Code reports them). */
export interface TextChange {
  range: Range;
  text: string;
}

/**
 * Where a line is after a change of its document: moved by the lines added and removed above it,
 * or undefined when the change took its start (the line was deleted or replaced, or joined to the
 * line above). Typing at its start (indenting it) or within it keeps it.
 */
export function lineAfter(line: number, changes: readonly TextChange[]): number | undefined {
  let at = line;
  // Each change applies to the text the ones before it left.
  for (const { range, text } of changes) {
    const { start, end } = range;
    // After the start of the line: it stays.
    if (start.line > at || (start.line === at && start.character > 0)) continue;
    const moved = text.split("\n").length - 1 - (end.line - start.line);
    // Up to its start: it moves, as long as it still starts a line afterwards.
    const startsLine = start.line === at || text.endsWith("\n") || (!text && !start.character);
    if (end.line < at || (end.line === at && end.character === 0 && startsLine)) at += moved;
    // From its start: only an edit within the line keeps it.
    else if (start.line !== at || end.line !== at || moved !== 0) return undefined;
  }
  return at;
}

/**
 * Where a line of the text after the changes was before them, or undefined when they added it: the
 * reverse of lineAfter. A change keeps a line where it was or moves it by the lines it adds.
 */
export function lineBefore(line: number, changes: readonly TextChange[]): number | undefined {
  let at: number | undefined = line;
  for (let i = changes.length - 1; i >= 0 && at !== undefined; i--) {
    const change = changes[i];
    const { start, end } = change.range;
    const moved = change.text.split("\n").length - 1 - (end.line - start.line);
    const now: number = at;
    at = [now, now - moved].find((x) => x >= 0 && lineAfter(x, [change]) === now);
  }
  return at;
}

/** A change as an EditLog keeps it: a long text only as its line breaks. */
export interface LoggedChange extends TextChange {
  /** The text was long: only its line breaks are kept, and it may hold any line. */
  long?: true;
}

/**
 * Where the line of an item (with its title) is after changes, as lineAfter: null when a change took
 * its start (the line was deleted or replaced). Undefined when a change inserted lines right next to
 * it, one of them with its title (Copy Line Down or Up, a paste there): VS Code leaves the cursor on
 * the lines it takes for the original, which people then edit as the copy, so the two cannot be
 * told apart (as the timer, see copiesLine).
 */
export function followLine(
  line: number,
  title: string,
  changes: readonly LoggedChange[]
): number | null | undefined {
  let at = line;
  for (const change of changes) {
    const next = lineAfter(at, [change]);
    if (next === undefined) return null;
    if (copiesNextTo(at, title, change)) return undefined;
    at = next;
  }
  return at;
}

/** True when a change inserts k lines within k lines of `line`, one of them maybe with `title`. */
function copiesNextTo(line: number, title: string, { range, text, long }: LoggedChange): boolean {
  const lines = text.split("\n");
  const k = lines.length - 1;
  const at = range.start.line;
  return (
    k > 0 && line > at - k && line < at + k && (!!long || lines.some((l) => l.includes(title)))
  );
}

/** Longer texts are kept as their line breaks only. */
const LONG_TEXT = 2000;

/**
 * The changes of an open document that add or remove lines, oldest first, each with the version of
 * the document it made and when it was recorded: a count shared by the logs of all documents (and
 * the parses of their texts), to tell what came first across documents. Changes within a line move
 * no line and are left out. Keeps the last `limit` versions with changes.
 */
export class EditLog {
  private readonly entries: Array<{ version: number; time: number; changes: LoggedChange[] }> = [];
  /** The last version recorded. */
  private version: number;
  /** The changes after this time are all here: the log began then, or forgot the change before. */
  private from: number;

  constructor(
    version: number,
    time: number,
    private readonly limit = 1000
  ) {
    this.version = version;
    this.from = time;
  }

  /** Records the changes that made a version, at a time later than any recorded before. */
  record(version: number, time: number, changes: readonly TextChange[]): void {
    // The same version without changes: only its saved state changed.
    if (version <= this.version && changes.length === 0) return;
    if (version <= this.version) {
      // Out of step (not expected): what the log has is of no use any more.
      this.entries.length = 0;
      this.from = time;
      this.version = version;
      return;
    }
    this.version = version;
    const kept = changes.filter(
      (c) => c.range.start.line !== c.range.end.line || c.text.includes("\n")
    );
    if (kept.length === 0) return;
    this.entries.push({ version, time, changes: kept.map(keep) });
    if (this.entries.length > this.limit) this.from = this.entries.shift()!.time;
  }

  /**
   * The changes recorded after `time` that made the versions up to `version`, in order. Undefined
   * when the log does not reach back to that time or has not seen that version.
   */
  changes(time: number, version: number): LoggedChange[] | undefined {
    if (time < this.from || version > this.version) return undefined;
    return this.entries
      .filter((e) => e.time > time && e.version <= version)
      .flatMap((e) => e.changes);
  }
}

function keep({ range, text }: TextChange): LoggedChange {
  const { start, end } = range;
  const copy = {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  };
  return text.length > LONG_TEXT
    ? { range: copy, text: text.replace(/[^\n]+/g, "x"), long: true }
    : { range: copy, text };
}
