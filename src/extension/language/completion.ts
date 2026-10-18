// Completion in plan files: `@` keys, owner ids, task ids after `@dep:`, tags, dates, enum values
// and property values (status, depends, milestone, type).
import * as vscode from "vscode";
import {
  dateSuggestions,
  daysOffSuggestions,
  formatDate,
  parseDate,
  weekStart,
} from "../../core/dates";
import { TEST_TYPES } from "../../core/model";
import { estimateHours } from "../../core/rollup";
import { MILESTONE_STATUSES } from "../../core/resolve";
import { matchCheckbox } from "../../core/parser/taskLine";
import { type PlanService } from "../planService";

interface KeyInfo {
  key: string;
  detail: string;
  /** Re-open the suggest widget after inserting `key:` (values are offered). */
  values?: boolean;
  kinds?: Array<"task" | "punch" | "inbox" | "step">;
}

const KEYS: KeyInfo[] = [
  { key: "est", detail: "estimate: 12h, 2d, 1w", values: true, kinds: ["task", "inbox"] },
  { key: "act", detail: "actual hours spent", kinds: ["task"] },
  {
    key: "owner",
    detail: "person id from team.md",
    values: true,
    kinds: ["task", "punch", "inbox"],
  },
  {
    key: "dep",
    detail: "finish-to-start dependencies: T101,T102+2d",
    values: true,
    kinds: ["task"],
  },
  { key: "start", detail: "fixed start date", values: true, kinds: ["task"] },
  { key: "due", detail: "deadline", values: true, kinds: ["task", "punch", "inbox"] },
  { key: "prio", detail: "high | med | low", values: true, kinds: ["task", "inbox"] },
  { key: "progress", detail: "manual progress, e.g. 40%", values: true, kinds: ["task"] },
  {
    key: "started",
    detail: "date work started (automatic)",
    values: true,
    kinds: ["task", "punch"],
  },
  { key: "done", detail: "date completed (automatic)", values: true, kinds: ["task", "punch"] },
  { key: "blocked", detail: 'reason for [!]: @blocked:"…"', kinds: ["task", "punch"] },
  { key: "test", detail: "linked test plan id", values: true, kinds: ["task"] },
  {
    key: "eq",
    detail: "component or equipment path, e.g. checkout/payment",
    values: true,
    kinds: ["task", "step"],
  },
  { key: "src", detail: "origin of a promoted code TODO", kinds: ["task"] },
  { key: "sev", detail: "punch severity A | B | C", values: true, kinds: ["punch"] },
  { key: "from", detail: "test case of origin: UAT-01/TC-01", values: true, kinds: ["punch"] },
  { key: "result", detail: "pass | fail | na", values: true, kinds: ["step"] },
  { key: "note", detail: 'step note: @note:"…"', kinds: ["step"] },
  { key: "punch", detail: "punch item raised by this step", values: true, kinds: ["step"] },
];

export class PlanCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly service: PlanService) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    if (!this.service.isPlanDocument(document)) return undefined;
    const plan = this.service.plan;
    const file = this.service.fileFor(document);
    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);
    const cb = matchCheckbox(lineText);

    if (!cb || position.character < cb.contentStart) {
      return this.propertyCompletions(file?.kind, before, position);
    }
    const itemKind =
      file?.kind === "punch"
        ? "punch"
        : file?.kind === "inbox"
          ? "inbox"
          : file?.kind === "test"
            ? "step"
            : "task";

    // @key:value
    const attr = /(?:^|\s)@([A-Za-z][\w-]*):("?)([^\s"]*)$/.exec(before);
    if (attr) {
      const [, key, , partial] = attr;
      const valueStart = position.character - partial.length;
      return this.valueCompletions(
        key,
        partial,
        new vscode.Range(position.line, valueStart, position.line, position.character),
        lineText
      );
    }
    // @key
    const keyMatch = /(?:^|\s)@([A-Za-z][\w-]*)?$/.exec(before);
    if (keyMatch) {
      const partial = keyMatch[1] ?? "";
      const range = new vscode.Range(
        position.line,
        position.character - partial.length,
        position.line,
        position.character
      );
      const present = new Set(
        cb.tokens.filter((t) => t.kind === "attr").map((t) => (t.kind === "attr" ? t.key : ""))
      );
      return KEYS.filter((k) => !k.kinds || k.kinds.includes(itemKind)).map((k, i) => {
        const item = new vscode.CompletionItem(k.key, vscode.CompletionItemKind.Property);
        item.detail = k.detail;
        item.insertText = `${k.key}:`;
        item.range = range;
        item.sortText = `${present.has(k.key) ? "1" : "0"}${String(i).padStart(2, "0")}`;
        if (k.values) item.command = { command: "editor.action.triggerSuggest", title: "values" };
        return item;
      });
    }
    // #tag
    const tag = /(?:^|\s)#([\p{L}\p{N}_/-]*)$/u.exec(before);
    if (tag) {
      const partial = tag[1];
      const range = new vscode.Range(
        position.line,
        position.character - partial.length,
        position.line,
        position.character
      );
      return plan.tags.map((t) => {
        const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.Keyword);
        item.range = range;
        item.detail = `${plan.tasks.filter((x) => x.tags.some((y) => y.tag === t)).length} tasks`;
        return item;
      });
    }
    return undefined;
  }

  private valueCompletions(
    key: string,
    partial: string,
    range: vscode.Range,
    lineText: string
  ): vscode.CompletionItem[] {
    const plan = this.service.plan;
    const simple = (
      values: Array<[string, string?]>,
      kind = vscode.CompletionItemKind.EnumMember
    ) =>
      values.map(([v, detail], i) => {
        const item = new vscode.CompletionItem(v, kind);
        item.detail = detail;
        item.range = range;
        item.sortText = String(i).padStart(3, "0");
        return item;
      });
    switch (key) {
      case "owner":
        return plan.people.map((p) => {
          const item = new vscode.CompletionItem(p.id, vscode.CompletionItemKind.User);
          item.detail = [p.name, p.role].filter(Boolean).join(" · ");
          item.documentation = p.skills.length ? `Skills: ${p.skills.join(", ")}` : undefined;
          item.range = range;
          return item;
        });
      case "dep": {
        // Complete the last id of a comma list.
        const listPart = partial.split(",").pop() ?? "";
        const itemRange = new vscode.Range(
          range.end.line,
          range.end.character - listPart.length,
          range.end.line,
          range.end.character
        );
        const own = /\^([\w-]+)\s*$/.exec(lineText)?.[1];
        const taken = new Set(partial.split(",").map((p) => p.replace(/\+.*$/, "")));
        return plan.tasks
          .filter((t) => t.id && t.id !== own && !taken.has(t.id))
          .map((t) => {
            const item = new vscode.CompletionItem(
              { label: t.id!, description: t.title },
              vscode.CompletionItemKind.Reference
            );
            item.detail = `${t.milestoneId ?? ""}${t.section ? ` · ${t.section}` : ""}`;
            const est = estimateHours(t);
            item.documentation = `${t.title}${est !== undefined ? ` (${est}h)` : ""}`;
            item.range = itemRange;
            item.filterText = `${t.id} ${t.title}`;
            item.sortText = String(t.order).padStart(6, "0");
            return item;
          });
      }
      case "start":
      case "due":
      case "started":
      case "done":
        return dateSuggestions(this.service.today()).map((s, i) => {
          const item = new vscode.CompletionItem(
            { label: s.date, description: s.label },
            vscode.CompletionItemKind.Value
          );
          item.range = range;
          item.filterText = `${s.date} ${s.label}`;
          item.sortText = String(i).padStart(2, "0");
          return item;
        });
      case "prio":
        return simple([["high"], ["med", "default"], ["low"]]);
      case "sev":
        return simple([
          ["A", "blocks acceptance"],
          ["B", "fix before go-live"],
          ["C", "may be fixed after launch"],
        ]);
      case "result":
        return simple([["pass"], ["fail"], ["na", "not applicable"]]);
      case "progress":
        return simple([["25%"], ["50%"], ["75%"], ["90%"]]);
      case "est":
        return simple([["2h"], ["4h"], ["1d"], ["2d"], ["1w"]], vscode.CompletionItemKind.Value);
      case "test":
        return plan.tests.map((t) => {
          const item = new vscode.CompletionItem(
            { label: t.id, description: t.title },
            vscode.CompletionItemKind.Reference
          );
          item.range = range;
          return item;
        });
      case "from":
        return plan.tests.flatMap((t) =>
          t.cases.map((c) => {
            const item = new vscode.CompletionItem(
              { label: `${t.id}/${c.id}`, description: c.title },
              vscode.CompletionItemKind.Reference
            );
            item.range = range;
            return item;
          })
        );
      case "punch":
        return plan.punch
          .filter((p) => p.id)
          .map((p) => {
            const item = new vscode.CompletionItem(
              { label: p.id!, description: p.title },
              vscode.CompletionItemKind.Reference
            );
            item.range = range;
            return item;
          });
      case "eq": {
        const paths = new Set<string>();
        for (const t of plan.tasks) if (t.eq) paths.add(t.eq);
        for (const t of plan.tests) if (t.eq) paths.add(t.eq);
        return simple(
          [...paths].sort().map((p) => [p]),
          vscode.CompletionItemKind.Folder
        );
      }
      default:
        return [];
    }
  }

  private propertyCompletions(
    kind: string | undefined,
    before: string,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const plan = this.service.plan;
    const m = /^([A-Za-z][\w-]*):\s*(?:.*,\s*)?([^,\s]*)$/.exec(before);
    if (!m) return undefined;
    const key = m[1].toLowerCase();
    const partial = m[2];
    const range = new vscode.Range(
      position.line,
      position.character - partial.length,
      position.line,
      position.character
    );
    const items = (values: Array<[string, string?]>) =>
      values.map(([v, d]) => {
        const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember);
        item.detail = d;
        item.range = range;
        return item;
      });
    if (kind === "milestone" && key === "status") return items(MILESTONE_STATUSES.map((s) => [s]));
    if (key === "depends" || key === "milestone")
      return items(plan.milestones.map((x) => [x.id, x.title]));
    if (kind === "test" && key === "type") return items(TEST_TYPES.map((t) => [t]));
    if (key === "workweek") return items([["mon-fri"], ["mon-thu"], ["sun-thu"], ["mon-sat"]]);
    if (key === "target" || key === "start" || key === "end" || key === "off")
      return dateSuggestions(this.service.today()).map((s) => {
        const item = new vscode.CompletionItem(
          { label: s.date, description: s.label },
          vscode.CompletionItemKind.Value
        );
        item.range = range;
        item.filterText = `${s.date} ${s.label}`;
        return item;
      });
    if (key === "color")
      return items([["blue"], ["green"], ["purple"], ["orange"], ["yellow"], ["red"]]);
    if (kind === "team" && (key === "workday" || key === "overtime")) {
      const today = parseDate(this.service.today());
      if (today === undefined) return undefined;
      const value = (label: string, description: string, sort: number) => {
        const item = new vscode.CompletionItem(
          { label, description },
          vscode.CompletionItemKind.Value
        );
        item.range = range;
        item.filterText = `${label} ${description}`;
        item.sortText = String(sort).padStart(3, "0");
        return item;
      };
      if (key === "overtime") {
        const monday = weekStart(today);
        const span = (from: number, to: number) => `${formatDate(from)}..${formatDate(to)}`;
        return [
          value(`${span(monday + 7, monday + 11)} +8h/week`, "next week, 8 extra hours", 0),
          value(`${span(monday + 7, monday + 18)} +8h/week`, "the next two weeks", 1),
          value(`${span(monday + 7, monday + 11)} +2h/day`, "next week, 2 extra hours a day", 2),
        ];
      }
      // Extra working days: the coming days off of the person whose section this is.
      const person = [...plan.people]
        .reverse()
        .find((p) => p.file === "team.md" && p.headingLine <= position.line);
      return daysOffSuggestions(
        today,
        person?.workweek ?? plan.project.workweek,
        plan.project.holidays,
        { limit: 12 }
      ).map((s, i) => value(s.date, s.label, i));
    }
    return undefined;
  }
}
