// Test report (acceptance, FAT, SAT …): per test plan a header (project, unit, date, tester, witness), every case with
// step results and notes, a summary, the punch items raised and a signature block.
import { type Plan } from "../core/resolve";
import { countResults } from "../core/testRun";
import { type TestPlan } from "../core/model";
import { type Branding } from "./html/report";
import { reportCss } from "./html/styles";
import { el, esc } from "./html/util";

export interface TestReportOptions {
  /** Report date; defaults to the date of the latest run, else today. */
  date?: string;
  tester?: string;
  witness?: string;
  today: string;
  branding?: Branding;
}

const RESULT_TEXT: Record<string, string> = {
  pass: "Pass",
  fail: "Fail",
  na: "N/A",
  open: "Not run",
};

/**
 * The milestone as shown in the report header: its title when the title already starts with the id
 * (`M4 – Acceptance Test`), else id and title (`M4 – Acceptance test on staging`), or the bare
 * id when it is unknown.
 */
export function milestoneLabel(plan: Plan, id: string): string {
  const title = plan.milestoneById(id)?.title.trim();
  if (!title) return id;
  const startsWithId =
    title.toLowerCase().startsWith(id.toLowerCase()) &&
    !/^[\p{L}\p{N}_]/u.test(title.slice(id.length));
  return startsWithId ? title : `${id} – ${title}`;
}

export function renderTestReport(plan: Plan, tp: TestPlan, o: TestReportOptions): string {
  const runs = [...tp.runs].filter((r) => r.date).sort((a, b) => a.date.localeCompare(b.date));
  const lastRun = runs[runs.length - 1];
  const prop = (key: string) =>
    lastRun?.props.entries.find((e) => e.key.toLowerCase() === key)?.value;
  const date = o.date ?? lastRun?.date ?? o.today;
  const tester = o.tester ?? prop("tester") ?? "";
  const witness = o.witness ?? tp.witness ?? prop("witness") ?? "";
  const counts = countResults(tp);
  const accent =
    o.branding?.accentColor && /^#[0-9a-f]{3,8}$/i.test(o.branding.accentColor)
      ? o.branding.accentColor
      : "#0969da";
  const verdict =
    counts.fail > 0
      ? `<span class="late">NOT PASSED</span> – ${counts.fail} failed step(s)`
      : counts.open > 0
        ? `<span class="muted">INCOMPLETE</span> – ${counts.open} step(s) not run`
        : `<span class="ok">PASSED</span>`;

  const header = el(
    "header",
    { class: "report" },
    o.branding?.logoDataUri
      ? el("img", { src: o.branding.logoDataUri, alt: o.branding.company ?? "logo" })
      : "",
    el(
      "div",
      {},
      el("h1", {}, `Test report – ${esc(tp.title)}`),
      el(
        "div",
        { class: "meta" },
        `${esc(plan.project.name)}${plan.project.code ? ` · ${esc(plan.project.code)}` : ""}`
      )
    ),
    o.branding?.company ? el("div", { class: "company" }, esc(o.branding.company)) : ""
  );
  const info = `<table><tbody>
<tr><th>Test plan</th><td>${esc(tp.id)}</td><th>Type</th><td>${esc(tp.type ?? "")}</td></tr>
<tr><th>Component / equipment</th><td>${esc(tp.eq ?? "")}</td><th>Milestone</th><td>${esc(tp.milestone ? milestoneLabel(plan, tp.milestone) : "")}</td></tr>
<tr><th>Date</th><td>${esc(date)}</td><th>Tester</th><td>${esc(tester)}</td></tr>
<tr><th>Witness</th><td>${esc(witness)}</td><th>Result</th><td>${verdict}</td></tr>
</tbody></table>`;

  const cases = tp.cases.map((c) => {
    const steps = c.steps.flatMap((s) => [s, ...s.children]);
    const rows = steps.map((s, i) => {
      const r = s.result ?? "open";
      const punch = s.punch ? plan.punchById(s.punch) : undefined;
      return `<tr><td class="num">${i + 1}</td><td>${s.parent ? "&nbsp;&nbsp;" : ""}${esc(s.title)}</td><td class="res-${r}">${RESULT_TEXT[r]}</td><td>${esc(s.note ?? "")}</td><td>${s.punch ? `${esc(s.punch)}${punch ? ` (${esc(punch.status)})` : ""}` : ""}</td></tr>`;
    });
    const cc = countResults(c);
    return el(
      "section",
      {},
      el("h2", {}, `${esc(c.id)} ${esc(c.title)}`),
      c.pre ? el("p", {}, `<b>Pre-condition:</b> ${esc(c.pre)}`) : "",
      steps.length
        ? `<table><thead><tr><th class="num">#</th><th>Step</th><th>Result</th><th>Note</th><th>Punch</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
        : el("p", { class: "muted" }, "No steps."),
      el(
        "p",
        { class: "muted" },
        `${cc.pass} pass · ${cc.fail} fail · ${cc.na} n/a · ${cc.open} not run`
      )
    );
  });

  const raised = new Set<string>();
  for (const c of tp.cases)
    for (const s of c.steps.flatMap((x) => [x, ...x.children])) if (s.punch) raised.add(s.punch);
  for (const p of plan.punch)
    if (p.from?.split("/")[0]?.toLowerCase() === tp.id.toLowerCase() && p.id) raised.add(p.id);
  const punchItems = [...raised]
    .map((id) => plan.punchById(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
  const punchTable = punchItems.length
    ? `<table><thead><tr><th>Id</th><th>Sev</th><th>Item</th><th>From</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>${punchItems
        .map(
          (p) =>
            `<tr><td>${esc(p.id)}</td><td><b class="${p.sev === "A" ? "late" : ""}">${esc(p.sev ?? "")}</b></td><td>${esc(p.title)}</td><td>${esc(p.from ?? "")}</td><td>${esc(p.owner ? (plan.personById(p.owner)?.name ?? p.owner) : "")}</td><td>${esc(p.due ?? "")}</td><td>${esc(p.status)}</td></tr>`
        )
        .join("")}</tbody></table>`
    : el("p", { class: "muted" }, "No punch items were raised.");

  const runLog = runs.length
    ? `<table><thead><tr><th>Run</th><th>Details</th></tr></thead><tbody>${runs
        .map(
          (r) =>
            `<tr><td>${esc(r.date)}</td><td>${r.props.entries.map((e) => `${esc(e.key)}: ${esc(e.value)}`).join("<br>")}</td></tr>`
        )
        .join("")}</tbody></table>`
    : "";

  const summary = el(
    "section",
    {},
    el("h2", {}, "Summary"),
    `<table><tbody><tr><th>Steps</th><td class="num">${counts.steps}</td><th>Pass</th><td class="num ok">${counts.pass}</td><th>Fail</th><td class="num ${counts.fail ? "late" : ""}">${counts.fail}</td><th>N/A</th><td class="num">${counts.na}</td><th>Not run</th><td class="num">${counts.open}</td></tr></tbody></table>`,
    el("p", {}, `Overall result: ${verdict}`),
    runLog ? el("h3", {}, "Run log") + runLog : ""
  );

  const signatures = el(
    "section",
    {},
    el("h2", {}, "Sign-off"),
    `<div class="sig"><div><b>Tester</b><br>${esc(tester)}<br><span class="muted">Date / signature</span></div><div><b>Witness</b><br>${esc(witness)}<br><span class="muted">Date / signature</span></div></div>`
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(tp.id)} report ${esc(date)}</title>
<style>${reportCss(accent)}</style>
</head>
<body>
${header}
${info}
${cases.join("\n")}
${summary}
<section><h2>Punch items raised</h2>${punchTable}</section>
${signatures}
<footer>Generated by Markdown Project Planner on ${esc(o.today)} from ${esc(tp.file)}.</footer>
</body>
</html>
`;
}
