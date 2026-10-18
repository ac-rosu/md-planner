// Token-level editor for one checkbox line. Changes are applied to the token list and turned into a
// single minimal TextEdit (common prefix/suffix diff), so untouched characters are never rewritten.
import { formatAttr, matchCheckbox, type Token } from "../parser/taskLine";
import { range, type TextEdit } from "../text";

/** Canonical order of known attributes; new attributes are inserted at their place in it. */
const KEY_ORDER = [
  "est",
  "act",
  "progress",
  "sev",
  "owner",
  "dep",
  "start",
  "due",
  "prio",
  "started",
  "done",
  "blocked",
  "test",
  "eq",
  "src",
  "from",
  "result",
  "note",
  "punch",
];

function keyRank(key: string | undefined): number {
  const i = key === undefined ? -1 : KEY_ORDER.indexOf(key);
  return i < 0 ? KEY_ORDER.length : i;
}

interface Tok {
  kind: Token["kind"];
  text: string;
  key?: string;
  tag?: string;
}

export class TaskLineEditor {
  private prefix: string;
  private statusChar: string;
  private readonly statusCol: number;
  private tokens: Tok[];

  constructor(private readonly original: string) {
    const cb = matchCheckbox(original);
    if (!cb) throw new Error(`Not a checkbox line: ${original}`);
    this.statusCol = cb.statusCol;
    this.statusChar = cb.statusChar;
    this.prefix = original.slice(0, cb.contentStart);
    this.tokens = cb.tokens.map((t) => ({
      kind: t.kind,
      text: original.slice(t.start, t.end),
      key: t.kind === "attr" ? t.key : undefined,
      tag: t.kind === "tag" ? t.tag : undefined,
    }));
  }

  setStatusChar(ch: string): this {
    this.statusChar = ch;
    return this;
  }

  hasAttr(key: string): boolean {
    return this.tokens.some((t) => t.kind === "attr" && t.key === key);
  }

  /** Sets (or with `undefined` removes) the first `@key`. New attributes go before the `^id`. */
  setAttr(key: string, value: string | undefined): this {
    const index = this.tokens.findIndex((t) => t.kind === "attr" && t.key === key);
    if (value === undefined) {
      if (index >= 0) this.removeAt(index);
      return this;
    }
    const text = formatAttr(key, value);
    if (index >= 0) this.tokens[index].text = text;
    else this.insertToken({ kind: "attr", text, key });
    return this;
  }

  /** Replaces the title text. The first text token takes the new title; other text tokens go. */
  setTitle(title: string): this {
    const textIdx = this.tokens.map((t, i) => (t.kind === "text" ? i : -1)).filter((i) => i >= 0);
    if (textIdx.length === 0) {
      if (title === "") return this;
      const firstSpace = this.tokens.findIndex((t) => t.kind === "space");
      if (firstSpace === 0) {
        this.tokens.splice(1, 0, { kind: "text", text: title }, { kind: "space", text: " " });
        if (this.tokens.length === 3) this.tokens.pop(); // nothing followed the new title
      } else {
        this.tokens.unshift({ kind: "space", text: " " }, { kind: "text", text: title });
      }
      return this;
    }
    for (let k = textIdx.length - 1; k >= 1; k--) this.removeAt(textIdx[k]);
    this.tokens[textIdx[0]].text = title;
    return this;
  }

  addTag(tag: string): this {
    if (this.tokens.some((t) => t.kind === "tag" && t.tag === tag)) return this;
    this.insertToken({ kind: "tag", text: `#${tag}`, tag });
    return this;
  }

  removeTag(tag: string): this {
    const index = this.tokens.findIndex((t) => t.kind === "tag" && t.tag === tag);
    if (index >= 0) this.removeAt(index);
    return this;
  }

  setId(id: string | undefined): this {
    const index = this.tokens.findIndex((t) => t.kind === "id");
    if (id === undefined) {
      if (index >= 0) this.removeAt(index);
      return this;
    }
    if (index >= 0) {
      this.tokens[index].text = `^${id}`;
      return this;
    }
    // Append as the last token, before any trailing whitespace.
    let at = this.tokens.length;
    while (at > 0 && this.tokens[at - 1].kind === "space") at--;
    const insert: Tok[] = [
      { kind: "space", text: " " },
      { kind: "id", text: `^${id}` },
    ];
    this.tokens.splice(at, 0, ...insert);
    return this;
  }

  toString(): string {
    const prefix =
      this.prefix.slice(0, this.statusCol) +
      this.statusChar +
      this.prefix.slice(this.statusCol + 1);
    return prefix + this.tokens.map((t) => t.text).join("");
  }

  /** Minimal edit for `line`, or undefined when nothing changed. */
  toEdit(line: number): TextEdit | undefined {
    return minimalLineEdit(line, this.original, this.toString());
  }

  /**
   * Inserts a new attribute or tag keeping the conventional order `title @attrs #tags ^id`.
   * Attributes go after the last existing attribute that comes before them in the canonical key
   * order (est, act, progress, sev, owner, dep, start, due, prio, started, done, blocked, …), or before
   * the first attribute when all come later, or after the title when there are none. Tags go after
   * the last token that is not the id.
   */
  private insertToken(tok: Tok): void {
    let at = 0;
    let lastText = -1;
    let afterLower = -1;
    let firstAttr = -1;
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (t.kind !== "space" && t.kind !== "id") at = i + 1;
      if (t.kind === "text") lastText = i + 1;
      if (t.kind === "attr") {
        if (firstAttr < 0) firstAttr = i;
        if (keyRank(t.key) <= keyRank(tok.key)) afterLower = i + 1;
      }
    }
    if (tok.kind === "attr") {
      if (afterLower > 0) at = afterLower;
      else if (firstAttr > 0) {
        // All existing attributes come later in the canonical order: insert before the first.
        this.tokens.splice(firstAttr, 0, tok, { kind: "space", text: " " });
        return;
      } else if (lastText > 0) at = lastText;
    }
    if (at === 0) {
      // No content yet: put it after the leading space, if any.
      const lead = this.tokens[0]?.kind === "space";
      if (lead) {
        this.tokens.splice(
          1,
          0,
          tok,
          ...(this.tokens.length > 1 ? [{ kind: "space" as const, text: " " }] : [])
        );
        return;
      }
      this.tokens.unshift({ kind: "space", text: " " }, tok);
      return;
    }
    this.tokens.splice(at, 0, { kind: "space", text: " " }, tok);
  }

  private removeAt(index: number): void {
    const prev = this.tokens[index - 1];
    const next = this.tokens[index + 1];
    if (prev?.kind === "space") {
      // Drop the token together with the whitespace in front of it, unless that whitespace is the
      // separator after `]` and more content follows (then drop the whitespace after it instead).
      if (index - 1 === 0 && next?.kind === "space") this.tokens.splice(index, 2);
      else this.tokens.splice(index - 1, 2);
    } else if (next?.kind === "space") {
      this.tokens.splice(index, 2);
    } else {
      this.tokens.splice(index, 1);
    }
  }
}

/** The smallest single edit that turns `before` into `after` on one line. */
export function minimalLineEdit(line: number, before: string, after: string): TextEdit | undefined {
  if (before === after) return undefined;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < max - p &&
    before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)
  ) {
    s++;
  }
  return {
    range: range(line, p, before.length - s),
    newText: after.slice(p, after.length - s),
  };
}
