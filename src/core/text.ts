// Line model of a text file. Keeps every byte needed to reproduce the file exactly: an optional
// UTF-8 BOM and the line ending of each individual line (LF, CRLF or a lone CR).
// Positions are 0-based { line, character } in UTF-16 code units, like VS Code and LSP.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export type Eol = "" | "\n" | "\r\n" | "\r";

export interface Line {
  text: string;
  eol: Eol;
}

export class TextLines {
  private constructor(
    readonly lines: readonly Line[],
    readonly bom: boolean
  ) {}

  static parse(source: string): TextLines {
    let text = source;
    let bom = false;
    if (text.charCodeAt(0) === 0xfeff) {
      bom = true;
      text = text.slice(1);
    }
    const lines: Line[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 /* \n */) {
        lines.push({ text: text.slice(start, i), eol: "\n" });
        start = i + 1;
      } else if (c === 13 /* \r */) {
        const crlf = text.charCodeAt(i + 1) === 10;
        lines.push({ text: text.slice(start, i), eol: crlf ? "\r\n" : "\r" });
        if (crlf) i++;
        start = i + 1;
      }
    }
    lines.push({ text: text.slice(start), eol: "" });
    return new TextLines(lines, bom);
  }

  get lineCount(): number {
    return this.lines.length;
  }

  line(n: number): string {
    return this.lines[n]?.text ?? "";
  }

  /** The text without BOM, exactly as VS Code's TextDocument.getText() returns it. */
  get text(): string {
    let out = "";
    for (const l of this.lines) out += l.text + l.eol;
    return out;
  }

  /** Byte-exact reproduction of the original source, including the BOM. */
  serialize(): string {
    return (this.bom ? "﻿" : "") + this.text;
  }

  /** The line ending used for new lines: the most frequent one in the file (LF when none). */
  get eol(): "\n" | "\r\n" {
    let crlf = 0;
    let lf = 0;
    for (const l of this.lines) {
      if (l.eol === "\r\n") crlf++;
      else if (l.eol === "\n") lf++;
    }
    return crlf > lf ? "\r\n" : "\n";
  }

  offsetAt(pos: Position): number {
    let offset = 0;
    const line = Math.min(pos.line, this.lines.length - 1);
    for (let i = 0; i < line; i++) offset += this.lines[i].text.length + this.lines[i].eol.length;
    return offset + Math.min(pos.character, this.lines[line].text.length);
  }

  /** Position of an offset in the BOM-less text. */
  positionAt(offset: number): Position {
    let rest = Math.max(0, offset);
    for (let i = 0; i < this.lines.length; i++) {
      const len = this.lines[i].text.length;
      if (rest <= len) return { line: i, character: rest };
      rest -= len + this.lines[i].eol.length;
      if (rest < 0) return { line: i, character: len };
    }
    const last = this.lines.length - 1;
    return { line: last, character: this.lines[last].text.length };
  }

  /** End of a line's text (before its line ending). */
  lineEnd(line: number): Position {
    return { line, character: this.line(line).length };
  }
}

export function pos(line: number, character: number): Position {
  return { line, character };
}

export function range(line: number, start: number, end: number): Range {
  return { start: { line, character: start }, end: { line, character: end } };
}

export function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

/**
 * Applies non-overlapping edits to a text (BOM-less, as in TextLines.text). Edits may be in any
 * order; edits at the same position are applied in the given order.
 */
export function applyEdits(source: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return source;
  const lines = TextLines.parse(source);
  const bom = lines.bom ? "﻿" : "";
  const text = lines.text;
  const indexed = edits.map((edit, index) => ({
    edit,
    index,
    start: lines.offsetAt(edit.range.start),
    end: lines.offsetAt(edit.range.end),
  }));
  indexed.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  let out = "";
  let cursor = 0;
  for (const e of indexed) {
    if (e.start < cursor) throw new Error("applyEdits: overlapping edits");
    out += text.slice(cursor, e.start) + e.edit.newText;
    cursor = e.end;
  }
  out += text.slice(cursor);
  return bom + out;
}

/** True when two texts differ at most in whitespace at the ends of lines and of the text. */
export function sameExceptTrailingSpace(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .split(/\r\n|\n|\r/)
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
  return norm(a) === norm(b);
}

/** Visual indentation width of leading whitespace (tabs advance to the next multiple of 4). */
export function indentWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === " ") width++;
    else if (ch === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

export function leadingWhitespace(text: string): string {
  const m = /^[ \t]*/.exec(text);
  return m ? m[0] : "";
}

/**
 * Applies edits and computes the inverse edits (in positions of the new text) that restore the
 * original text exactly. Used for undo/redo of edits made from views.
 */
export function invertEdits(
  source: string,
  edits: readonly TextEdit[]
): { text: string; inverse: TextEdit[] } {
  const oldLines = TextLines.parse(source);
  const bom = oldLines.bom ? "\ufeff" : "";
  const old = oldLines.text;
  const sorted = edits
    .map((edit, index) => ({
      edit,
      index,
      start: oldLines.offsetAt(edit.range.start),
      end: oldLines.offsetAt(edit.range.end),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  let out = "";
  let cursor = 0;
  const spans: Array<{ newStart: number; newEnd: number; oldText: string }> = [];
  for (const e of sorted) {
    if (e.start < cursor) throw new Error("invertEdits: overlapping edits");
    out += old.slice(cursor, e.start);
    const newStart = out.length;
    out += e.edit.newText;
    spans.push({ newStart, newEnd: out.length, oldText: old.slice(e.start, e.end) });
    cursor = e.end;
  }
  out += old.slice(cursor);
  const newLines = TextLines.parse(out);
  const inverse = spans.map((s) => ({
    range: { start: newLines.positionAt(s.newStart), end: newLines.positionAt(s.newEnd) },
    newText: s.oldText,
  }));
  return { text: bom + out, inverse };
}
