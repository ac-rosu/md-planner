// Helpers for writing static HTML and SVG strings.

export function esc(text: string | number | undefined | null): string {
  if (text === undefined || text === null) return "";
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

/** Builds an HTML element string; attributes with undefined/false values are skipped. */
export function el(
  tag: string,
  attrs: Record<string, string | number | boolean | undefined>,
  ...children: string[]
): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v as string | number)}"`))
    .join("");
  return `<${tag}${a}>${children.join("")}</${tag}>`;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function hours(n: number | undefined): string {
  if (n === undefined) return "";
  return `${Math.round(n * 10) / 10} h`;
}
