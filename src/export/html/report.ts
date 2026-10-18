// HTML status report: one self-contained file (inline CSS, static SVG, no scripts) with
// selectable sections and a print stylesheet. Also the input for the PDF export.
import { type Baseline } from "../../core/baseline";
import { formatDate, parseDate, weekStart } from "../../core/dates";
import { formatHours } from "../../core/duration";
import { attentionLists, punchStats, testStats } from "../../core/metrics";
import { isOpen, type Task } from "../../core/model";
import { type Plan } from "../../core/resolve";
import { isLeaf, ownerOf } from "../../core/rollup";
import { type Schedule } from "../../core/scheduler";
import { burnUpGeometry } from "../../core/views/charts";
import { buildDashboardModel } from "../../core/views/dashboard";
import { buildGanttModel } from "../../core/views/gantt";
import { buildResourcesModel, plannedOvertime, overloadedWeeks } from "../../core/views/resources";
import { staticGanttSvg } from "./gantt";
import { reportCss } from "./styles";
import { el, esc, hours, pct } from "./util";

export type ReportSection =
  "header" | "summary" | "milestones" | "gantt" | "load" | "period" | "risks" | "tests";

export const REPORT_SECTIONS: Array<{ id: ReportSection; label: string }> = [
  { id: "header", label: "Header (project, code, date, period, author)" },
  { id: "summary", label: "Status summary" },
  { id: "milestones", label: "Milestones (target, forecast, variance, % complete)" },
  { id: "gantt", label: "Gantt (next weeks)" },
  { id: "load", label: "Team load heatmap" },
  { id: "period", label: "Done this period, planned next period" },
  { id: "risks", label: "Blocked items and risks" },
  { id: "tests", label: "Test status and open punch items" },
];

export interface Branding {
  company?: string;
  accentColor?: string;
  /** Logo as a data: URI (the caller reads and encodes the file). */
  logoDataUri?: string;
}

export interface StatusReportOptions {
  sections: ReportSection[];
  summary?: string;
  periodDays: number;
  ganttWeeks: number;
  author?: string;
  branding?: Branding;
  baseline?: Baseline;
  /** Demand schedule for overload risks (optional). */
  demand?: Schedule;
}

export function renderStatusReport(plan: Plan, schedule: Schedule, o: StatusReportOptions): string {
  const today = formatDate(schedule.today);
  const periodStart = formatDate(schedule.today - o.periodDays + 1);
  const accent =
    o.branding?.accentColor && /^#[0-9a-f]{3,8}$/i.test(o.branding.accentColor)
      ? o.branding.accentColor
      : "#0969da";
  const dash = buildDashboardModel(plan, schedule, o.baseline);
  const body: string[] = [];
  const has = (s: ReportSection) => o.sections.includes(s);

  if (has("header")) {
    body.push(
      el(
        "header",
        { class: "report" },
        o.branding?.logoDataUri
          ? el("img", { src: o.branding.logoDataUri, alt: o.branding.company ?? "logo" })
          : "",
        el(
          "div",
          {},
          el("h1", {}, esc(plan.project.name)),
          el(
            "div",
            { class: "meta" },
            [
              plan.project.code ? `Project ${esc(plan.project.code)}` : "",
              `Status report ${esc(today)}`,
              `Period ${esc(periodStart)} – ${esc(today)}`,
              o.author ? `by ${esc(o.author)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")
          )
        ),
        o.branding?.company ? el("div", { class: "company" }, esc(o.branding.company)) : ""
      )
    );
    body.push(kpis(dash));
  }

  if (has("summary")) {
    body.push(
      el(
        "section",
        {},
        el("h2", {}, "Summary"),
        o.summary?.trim()
          ? el("p", { class: "summary" }, esc(o.summary.trim()))
          : el("p", { class: "muted" }, "No summary was written for this report.")
      )
    );
  }

  if (has("milestones")) {
    const rows = dash.milestones.map((m) => {
      const variance =
        m.variance === undefined
          ? ""
          : m.variance > 0
            ? `<span class="badge late">${m.variance} d late</span>`
            : m.variance < 0
              ? `<span class="badge ok">${-m.variance} d ahead</span>`
              : `<span class="badge">on target</span>`;
      const trend =
        m.trend?.slip === undefined
          ? ""
          : m.trend.slip > 0
            ? `<span class="late">+${m.trend.slip} d</span>`
            : m.trend.slip < 0
              ? `<span class="ok">${m.trend.slip} d</span>`
              : "±0";
      return `<tr><td><b>${esc(m.title)}</b><div class="muted">${esc(m.status)}</div></td><td>${esc(m.target ?? "—")}</td><td class="${m.late ? "late" : ""}">${esc(m.forecast ?? "—")}</td><td>${variance}</td>${o.baseline ? `<td class="num">${trend}</td>` : ""}<td class="num">${pct(m.progress)}<div class="bar"><span style="width:${Math.round(m.progress * 100)}%"></span></div></td><td class="num">${m.done}/${m.total}</td><td class="num">${hours(m.remaining)}</td></tr>`;
    });
    body.push(
      el(
        "section",
        {},
        el("h2", {}, "Milestones"),
        `<table><thead><tr><th>Milestone</th><th>Target</th><th>Forecast</th><th>Variance</th>${o.baseline ? `<th class="num">vs ${esc(o.baseline.name)}</th>` : ""}<th class="num">Complete</th><th class="num">Tasks</th><th class="num">Remaining</th></tr></thead><tbody>${rows.join("")}</tbody></table>`,
        burnUpSvg(dash.burnUp.project)
      )
    );
  }

  if (has("gantt")) {
    const model = buildGanttModel(plan, schedule, { grouping: "milestone" });
    body.push(
      el(
        "section",
        { class: "page-break" },
        el("h2", {}, `Schedule – next ${o.ganttWeeks} weeks`),
        staticGanttSvg(model, { weeks: o.ganttWeeks }),
        el(
          "p",
          { class: "muted" },
          "Bars coloured by owner; red outline = critical path; red line = today; diamond = milestone target."
        )
      )
    );
  }

  if (has("load")) {
    const from = weekStart(schedule.today);
    const to = from + o.ganttWeeks * 7 - 1;
    const res = buildResourcesModel(plan, schedule, { from, to });
    const weeks = res.weeks.filter((w) => w.start >= from && w.start <= to);
    const head = `<tr><th class="person">Person</th>${weeks.map((w) => `<th>${esc(w.label)}</th>`).join("")}</tr>`;
    const rows = res.rows
      .map((r) => {
        const cells = r.cells
          .filter((c) => c.start >= from && c.start <= to)
          .map((c) => {
            const cls = [
              c.off === "full" && c.hours === 0 ? "off" : c.level === "none" ? "" : c.level,
              c.overtimeCapacity > 0 ? "ot" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const text =
              c.hours > 0
                ? `${Math.round(c.hours)}/${Math.round(c.capacity)}`
                : c.off === "full"
                  ? "off"
                  : "";
            const ot = c.overtime >= 0.5 ? `<small>+${Math.round(c.overtime)} OT</small>` : "";
            return `<td class="${cls}" title="${esc(`${r.name} ${c.week}`)}">${text}${ot}</td>`;
          })
          .join("");
        return `<tr><th class="person">${esc(r.name)}</th>${cells}</tr>`;
      })
      .join("");
    body.push(
      el(
        "section",
        {},
        el("h2", {}, "Team load (scheduled hours / capacity per week)"),
        `<table class="heat">${head}${rows}</table>`,
        el(
          "p",
          { class: "muted" },
          "Green: under 80 % · yellow: 80–100 % · red: over capacity · hatched: time off · orange top line: overtime or extra working days planned, +N OT: overtime hours scheduled."
        ),
        ...overtimeNote(res, from, to)
      )
    );
  }

  if (has("period")) {
    const done = plan.tasks
      .filter(
        (t) =>
          isLeaf(t) && t.status === "done" && t.done && t.done >= periodStart && t.done <= today
      )
      .sort((a, b) => (a.done ?? "").localeCompare(b.done ?? "") || a.order - b.order);
    const nextEnd = schedule.today + o.periodDays;
    const next = plan.tasks
      .filter((t) => {
        if (!isLeaf(t) || !isOpen(t.status)) return false;
        const ts = schedule.tasks.get(t);
        if (!ts || ts.start === undefined || ts.finish === undefined || ts.done) return false;
        return ts.start <= nextEnd && ts.finish > schedule.today - 1;
      })
      .sort(
        (a, b) =>
          (schedule.tasks.get(a)!.start ?? 0) - (schedule.tasks.get(b)!.start ?? 0) ||
          a.order - b.order
      );
    const doneRows = done.map(
      (t) =>
        `<tr><td>${esc(t.id ?? "")}</td><td>${esc(t.title)}</td><td>${esc(owner(plan, t))}</td><td>${esc(t.done)}</td><td class="num">${hours(t.act ?? t.est)}</td></tr>`
    );
    const nextRows = next.map((t) => {
      const ts = schedule.tasks.get(t)!;
      return `<tr><td>${esc(t.id ?? "")}</td><td>${esc(t.title)}${t.status === "blocked" ? ' <span class="badge late">blocked</span>' : ""}</td><td>${esc(owner(plan, t))}</td><td>${esc(formatDate(ts.start!))} → ${esc(formatDate(ts.finish!))}</td><td class="num">${hours(ts.scheduledHours)}</td></tr>`;
    });
    body.push(
      el(
        "section",
        {},
        el("h2", {}, "Progress"),
        el(
          "div",
          { class: "two" },
          el(
            "div",
            {},
            el("h3", {}, `Done ${esc(periodStart)} – ${esc(today)} (${done.length})`),
            done.length
              ? `<table><thead><tr><th>Id</th><th>Task</th><th>Owner</th><th>Done</th><th class="num">Hours</th></tr></thead><tbody>${doneRows.join("")}</tbody></table>`
              : el("p", { class: "muted" }, "Nothing completed in this period.")
          ),
          el(
            "div",
            {},
            el("h3", {}, `Planned until ${esc(formatDate(nextEnd))} (${next.length})`),
            next.length
              ? `<table><thead><tr><th>Id</th><th>Task</th><th>Owner</th><th>Scheduled</th><th class="num">Hours</th></tr></thead><tbody>${nextRows.join("")}</tbody></table>`
              : el("p", { class: "muted" }, "Nothing scheduled in the next period.")
          )
        )
      )
    );
  }

  if (has("risks")) {
    const lists = attentionLists(plan, schedule);
    const risks = computeRisks(plan, schedule, o.demand);
    const blocked = lists.blocked.map(
      (t) =>
        `<tr><td>${esc(t.id ?? "")}</td><td>${esc(t.title)}</td><td>${esc(owner(plan, t))}</td><td>${esc(t.blocked ?? "no reason given")}</td></tr>`
    );
    body.push(
      el(
        "section",
        {},
        el("h2", {}, "Blocked items and risks"),
        lists.blocked.length
          ? `<table><thead><tr><th>Id</th><th>Blocked task</th><th>Owner</th><th>Reason</th></tr></thead><tbody>${blocked.join("")}</tbody></table>`
          : el("p", { class: "muted" }, "No blocked tasks."),
        risks.length
          ? `<ul>${risks.map((r) => `<li>${r}</li>`).join("")}</ul>`
          : el("p", { class: "muted" }, "No schedule risks detected.")
      )
    );
  }

  if (has("tests")) {
    const tests = plan.tests.map(testStats);
    const ps = punchStats(plan, today);
    const punch = plan.punch
      .filter((p) => !p.parent && isOpen(p.status))
      .sort(
        (a, b) =>
          (a.sev ?? "Z").localeCompare(b.sev ?? "Z") || (a.due ?? "9").localeCompare(b.due ?? "9")
      );
    body.push(
      el(
        "section",
        {},
        el("h2", {}, "Tests and punch list"),
        tests.length
          ? `<table><thead><tr><th>Test plan</th><th>Type</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">N.a.</th><th class="num">Open</th><th>Last run</th></tr></thead><tbody>${tests
              .map(
                (t) =>
                  `<tr><td><b>${esc(t.id)}</b> ${esc(t.title)}</td><td>${esc(t.type ?? "")}</td><td class="num">${t.pass}</td><td class="num ${t.fail ? "late" : ""}">${t.fail}</td><td class="num">${t.na}</td><td class="num">${t.open}</td><td>${esc(t.lastRun ?? "—")}</td></tr>`
              )
              .join("")}</tbody></table>`
          : el("p", { class: "muted" }, "No test plans."),
        el(
          "h3",
          {},
          `Open punch items: ${ps.open} (A ${ps.bySeverity.A} · B ${ps.bySeverity.B} · C ${ps.bySeverity.C}${ps.overdue ? ` · ${ps.overdue} overdue` : ""})`
        ),
        punch.length
          ? `<table><thead><tr><th>Id</th><th>Sev</th><th>Item</th><th>Owner</th><th>Due</th><th>From</th><th>Status</th></tr></thead><tbody>${punch
              .map(
                (p) =>
                  `<tr><td>${esc(p.id ?? "")}</td><td><b class="${p.sev === "A" ? "late" : ""}">${esc(p.sev ?? "")}</b></td><td>${esc(p.title)}</td><td>${esc(owner(plan, p))}</td><td class="${p.due && p.due < today ? "late" : ""}">${esc(p.due ?? "")}</td><td>${esc(p.from ?? "")}</td><td>${esc(p.status)}</td></tr>`
              )
              .join("")}</tbody></table>`
          : ""
      )
    );
  }

  body.push(
    el(
      "footer",
      {},
      `Generated by Markdown Project Planner on ${esc(today)} from the plan files. Schedule computed deterministically as of ${esc(today)}.`
    )
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(plan.project.name)} – status report ${esc(today)}</title>
<style>${reportCss(accent)}</style>
</head>
<body>
${body.join("\n")}
</body>
</html>
`;
}

/** "Planned overtime: Mark 16 h (W45, W46) …" under the team load, when there is any. */
function overtimeNote(
  res: ReturnType<typeof buildResourcesModel>,
  from: number,
  to: number
): string[] {
  const window = {
    ...res,
    rows: res.rows.map((r) => ({
      ...r,
      cells: r.cells.filter((c) => c.start >= from && c.start <= to),
    })),
  };
  const people = plannedOvertime(window).map((p) => {
    const tasks = new Map<string, string>();
    for (const c of window.rows.find((r) => r.id === p.id)?.cells ?? [])
      for (const t of c.tasks) if (t.overtime) tasks.set(t.key, t.id ?? t.title);
    const weeks = p.weeks.map((w) => w.week.slice(-3)).join(", ");
    const hours = Math.round(p.weeks.reduce((s, w) => s + w.hours, 0));
    return esc(`${p.name} ${hours} h (${weeks}: ${[...tasks.values()].join(", ")})`);
  });
  return people.length ? [el("p", {}, `<b>Planned overtime:</b> ${people.join(" · ")}`)] : [];
}

function kpis(d: ReturnType<typeof buildDashboardModel>): string {
  const late = d.milestones.filter((m) => m.late).length;
  const item = (value: string, label: string, cls = "") =>
    `<div class="kpi"><b class="${cls}">${esc(value)}</b><span>${esc(label)}</span></div>`;
  return `<div class="kpis">${[
    item(pct(d.progress), "complete (hours-weighted)"),
    item(
      d.forecastFinish ?? "—",
      d.endVariance === undefined
        ? "forecast finish"
        : d.endVariance > 0
          ? `forecast finish, ${d.endVariance} d after end`
          : "forecast finish",
      (d.endVariance ?? 0) > 0 ? "late" : ""
    ),
    item(formatHours(Math.round(d.remainingHours)), "remaining work"),
    item(String(late), "late milestones", late ? "late" : ""),
    item(String(d.lists.blocked.length), "blocked tasks", d.lists.blocked.length ? "late" : ""),
    item(String(d.punch.open), "open punch items", d.punch.bySeverity.A ? "late" : ""),
    ...(d.overtime.hours > 0
      ? [item(formatHours(Math.round(d.overtime.hours)), "planned overtime")]
      : []),
  ].join("")}</div>`;
}

function burnUpSvg(burn: ReturnType<typeof buildDashboardModel>["burnUp"]["project"]): string {
  const g = burnUpGeometry(burn, 760, 220);
  const parts = [
    ...g.yTicks.map(
      (t) =>
        `<line x1="${g.plot.left}" x2="${g.plot.right}" y1="${t.pos}" y2="${t.pos}" stroke="#eaeef2"/><text x="${g.plot.left - 6}" y="${t.pos + 4}" text-anchor="end" font-size="10" fill="#59636e">${esc(t.label)}</text>`
    ),
    ...g.xTicks.map(
      (t) =>
        `<text x="${t.pos}" y="${g.plot.bottom + 16}" font-size="10" fill="#59636e">${esc(t.label)}</text>`
    ),
    `<path d="${g.scope}" fill="none" stroke="#8c959f" stroke-dasharray="6 4" stroke-width="1.5"/>`,
    `<path d="${g.forecast}" fill="none" stroke="#0969da" stroke-dasharray="4 3" stroke-width="2"/>`,
    `<path d="${g.done}" fill="none" stroke="#1a7f37" stroke-width="2.5"/>`,
    g.todayX !== undefined
      ? `<line x1="${g.todayX}" x2="${g.todayX}" y1="${g.plot.top}" y2="${g.plot.bottom}" stroke="#cf222e"/>`
      : "",
  ];
  return `<h3>Burn-up (estimated hours)</h3><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.width} ${g.height}" width="${g.width}" height="${g.height}" role="img" aria-label="Burn-up chart">${parts.join("")}</svg><p class="muted">Grey dashed: scope · green: done · blue dashed: forecast · red: today.</p>`;
}

function owner(plan: Plan, t: Task): string {
  const o = ownerOf(t);
  return o ? (plan.personById(o)?.name ?? o) : "unassigned";
}

/** Deterministic risk list: late milestones and tasks, missing buffer, overload, gaps in the plan. */
export function computeRisks(plan: Plan, schedule: Schedule, demand?: Schedule): string[] {
  const risks: string[] = [];
  for (const m of plan.milestones) {
    const ms = schedule.milestones.get(m.id);
    if (!ms || m.status === "cancelled" || m.status === "done") continue;
    if (ms.late)
      risks.push(
        `<b>${esc(m.title)}</b> is forecast ${esc(formatDate(ms.forecast!))}, <span class="late">${ms.variance} working day(s) after its target ${esc(m.target)}</span>.`
      );
    else if (ms.variance !== undefined && ms.variance >= -2)
      risks.push(
        `<b>${esc(m.title)}</b> has little or no buffer (${-ms.variance} working day(s) before its target ${esc(m.target)}).`
      );
  }
  const lateTasks = [...schedule.tasks.values()].filter((ts) => ts.late && !ts.done);
  if (lateTasks.length) {
    risks.push(
      `${lateTasks.length} task(s) are scheduled after their deadline: ${lateTasks
        .slice(0, 6)
        .map((ts) => esc(ts.task.id ?? ts.task.title))
        .join(", ")}${lateTasks.length > 6 ? ", …" : ""}.`
    );
  }
  if (schedule.criticalPath.length) {
    const first = schedule.criticalPath[0];
    const last = schedule.criticalPath[schedule.criticalPath.length - 1];
    risks.push(
      `Critical path: ${schedule.criticalPath.length} task(s) from ${esc(first.id ?? first.title)} to ${esc(last.id ?? last.title)}; any delay there moves the end date.`
    );
  }
  if (demand) {
    const today = parseDate(formatDate(schedule.today))!;
    const res = buildResourcesModel(plan, demand, { from: weekStart(today), to: today + 8 * 7 });
    for (const [person, weeks] of overloadedWeeks(res)) {
      const name = plan.personById(person)?.name ?? person;
      risks.push(
        `${esc(name)} has more work than capacity in ${weeks.slice(0, 4).map(esc).join(", ")}${weeks.length > 4 ? ", …" : ""} if everything started as early as possible.`
      );
    }
  }
  const lists = attentionLists(plan, schedule);
  if (lists.unestimated.length)
    risks.push(
      `${lists.unestimated.length} open task(s) have no estimate and are scheduled with 0 hours.`
    );
  if (lists.unassigned.length) risks.push(`${lists.unassigned.length} open task(s) have no owner.`);
  const unscheduled = [...schedule.tasks.values()].filter((ts) => ts.unscheduled);
  if (unscheduled.length)
    risks.push(
      `<span class="late">${unscheduled.length} task(s) cannot be scheduled</span> (circular dependency or no capacity).`
    );
  return risks;
}
