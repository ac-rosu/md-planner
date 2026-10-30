// Project templates: folders of Markdown files with placeholders, instantiated by "New project".
//   {{name}} {{code}} {{start}} {{end}} {{today}} {{lead}} {{leadId}}
//   {{date:0.25}}  start + 25 % of the project duration, moved back to a Friday-or-earlier weekday
import { addMonths, formatDate, isoWeekday, parseDate } from "./dates";
import { personIdFromName } from "./resolve";

export interface TemplateParams {
  name: string;
  code?: string;
  start: string;
  end: string;
  today: string;
  /** Name of the first team member (the person creating the plan). */
  lead?: string;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)(?::([^}]*))?\s*\}\}/g;

export function instantiateTemplate(
  files: Record<string, string>,
  params: TemplateParams
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    out[substitute(path, params)] = substituteText(text, params);
  }
  return out;
}

function substituteText(text: string, params: TemplateParams): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const hadPlaceholder = /\{\{/.test(line);
    const replaced = substitute(line, params);
    // A property whose only content was an empty placeholder is dropped (e.g. `code: {{code}}`).
    if (hadPlaceholder && /^[A-Za-z][\w-]*:\s*$/.test(replaced)) continue;
    // A heading that became empty (e.g. `## {{lead}}` without a lead) drops its section.
    if (hadPlaceholder && /^#{1,6}\s*$/.test(replaced)) continue;
    kept.push(replaced);
  }
  return kept.join(eol);
}

function substitute(text: string, params: TemplateParams): string {
  return text.replace(PLACEHOLDER, (_m, key: string, arg: string | undefined) => {
    switch (key) {
      case "name":
        return params.name;
      case "code":
        return params.code ?? "";
      case "start":
        return params.start;
      case "end":
        return params.end;
      case "today":
        return params.today;
      case "lead":
        return params.lead ?? "";
      case "leadId":
        return params.lead ? personIdFromName(params.lead) : "";
      case "date":
        return fractionDate(params.start, params.end, Number(arg ?? "0"));
      default:
        return _m;
    }
  });
}

/** start + fraction × (end − start), moved back to the nearest Monday–Friday. */
export function fractionDate(start: string, end: string, fraction: number): string {
  const a = parseDate(start);
  const b = parseDate(end);
  if (a === undefined || b === undefined || !Number.isFinite(fraction)) return start;
  let d = a + Math.round((b - a) * Math.min(1, Math.max(0, fraction)));
  while (isoWeekday(d) > 5 && d > a) d--;
  return formatDate(d);
}

/** Default project end: start + 6 months (same day of month, clamped to the month's last day). */
export function defaultEndDate(start: string): string {
  const s = parseDate(start);
  return s === undefined ? start : formatDate(addMonths(s, 6));
}
