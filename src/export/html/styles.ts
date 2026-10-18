// CSS of the exported reports: screen and print (A4), no external resources.

export function reportCss(accent: string): string {
  return `
:root { --accent: ${accent}; --ink: #1f2328; --muted: #59636e; --line: #d1d9e0; --late: #cf222e; --ok: #1a7f37; --warn: #9a6700; --bg-soft: #f6f8fa; }
* { box-sizing: border-box; }
html { font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif; color: var(--ink); font-size: 13px; line-height: 1.45; }
body { margin: 0 auto; max-width: 1100px; padding: 24px 28px 40px; background: #fff; }
header.report { display: flex; align-items: center; gap: 18px; border-bottom: 3px solid var(--accent); padding-bottom: 12px; margin-bottom: 18px; }
header.report img { max-height: 56px; max-width: 200px; }
header.report h1 { margin: 0; font-size: 22px; }
header.report .meta { color: var(--muted); margin-top: 4px; }
header.report .company { margin-left: auto; text-align: right; color: var(--muted); font-weight: 600; }
h2 { font-size: 16px; margin: 26px 0 10px; padding-bottom: 4px; border-bottom: 1px solid var(--line); color: var(--accent); break-after: avoid; }
h3 { font-size: 14px; margin: 16px 0 6px; }
section { break-inside: auto; }
p.summary { white-space: pre-wrap; font-size: 14px; background: var(--bg-soft); border-left: 4px solid var(--accent); padding: 10px 14px; margin: 0; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; }
th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--bg-soft); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr { break-inside: avoid; }
.late { color: var(--late); font-weight: 600; }
.ok { color: var(--ok); }
.muted { color: var(--muted); }
.badge { display: inline-block; padding: 0 6px; border-radius: 9px; font-size: 11px; background: var(--bg-soft); border: 1px solid var(--line); }
.badge.late { background: #ffebe9; border-color: #ffcecb; }
.badge.ok { background: #dafbe1; border-color: #aceebb; }
.bar { height: 8px; background: #eaeef2; border-radius: 4px; overflow: hidden; min-width: 80px; }
.bar > span { display: block; height: 100%; background: var(--accent); }
.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-bottom: 8px; }
.kpi { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
.kpi b { display: block; font-size: 20px; }
.kpi span { color: var(--muted); font-size: 12px; }
svg { max-width: 100%; height: auto; }
.heat td { text-align: center; font-size: 11px; padding: 3px 2px; border: 2px solid #fff; }
.heat th { font-size: 11px; text-align: center; padding: 3px 2px; }
.heat th.person { text-align: left; }
.heat .under { background: #dafbe1; }
.heat .near { background: #fff8c5; }
.heat .over { background: #ffcecb; font-weight: 600; }
.heat .off { background: repeating-linear-gradient(135deg, #d0d7de 0 2px, #fff 2px 6px); }
.heat .ot { box-shadow: inset 0 3px 0 #bc4c00; }
.heat small { display: block; font-size: 9px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.sig { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 30px; }
.sig div { border-top: 1px solid var(--ink); padding-top: 6px; min-height: 60px; }
.res-pass { color: var(--ok); font-weight: 600; }
.res-fail { color: var(--late); font-weight: 600; }
.res-na { color: #8250df; font-weight: 600; }
.res-open { color: var(--muted); }
footer { margin-top: 30px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--line); padding-top: 6px; }
@page { size: A4; margin: 14mm 12mm; }
@media print {
  html { font-size: 11px; }
  body { max-width: none; padding: 0; }
  h2 { margin-top: 18px; }
  .page-break { break-before: page; }
  a { color: inherit; text-decoration: none; }
}
`;
}
