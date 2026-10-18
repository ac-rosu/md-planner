// Colours for owners, statuses and milestones. Values are CSS colours that work in VS Code
// webviews (theme variables) and in exported HTML (fallback hex after the variable).
import { type Status } from "../model";

const PALETTE: Record<string, string> = {
  blue: "var(--vscode-charts-blue, #3794ff)",
  green: "var(--vscode-charts-green, #388a34)",
  purple: "var(--vscode-charts-purple, #b180d7)",
  orange: "var(--vscode-charts-orange, #d18616)",
  yellow: "var(--vscode-charts-yellow, #cca700)",
  red: "var(--vscode-charts-red, #f14c4c)",
};

const ORDER = ["blue", "green", "purple", "orange", "yellow", "red"];

export const NEUTRAL = "var(--vscode-charts-foreground, #888888)";

/** Colour for a person: their `color:` (palette name or hex), else by position in the team. */
export function personColor(color: string | undefined, index: number): string {
  if (color) {
    const named = PALETTE[color.toLowerCase()];
    if (named) return named;
    if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  }
  return index < 0 ? NEUTRAL : PALETTE[ORDER[index % ORDER.length]];
}

export function statusColor(status: Status): string {
  switch (status) {
    case "todo":
      return NEUTRAL;
    case "doing":
      return PALETTE.blue;
    case "review":
      return PALETTE.purple;
    case "blocked":
      return PALETTE.red;
    case "done":
      return PALETTE.green;
    case "cancelled":
      return "var(--vscode-disabledForeground, #999999)";
  }
}

export function milestoneColor(index: number): string {
  return PALETTE[ORDER[(index + 0) % ORDER.length]];
}

/** Plain hex fallbacks for contexts without CSS variables (e.g. Excel). */
export function hexOf(cssColor: string): string {
  const m = /#[0-9a-f]{3,8}/i.exec(cssColor);
  return m ? m[0] : "#888888";
}
