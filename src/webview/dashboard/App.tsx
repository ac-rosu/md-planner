// Dashboard: milestone cards, burn-up, estimate accuracy, attention lists, tests and punch items.
import { useEffect, useState } from "preact/hooks";
import { burnUpGeometry } from "../../core/views/charts";
import {
  type BudgetBarPart,
  type DashboardItem,
  type DashboardModel,
  type MilestoneCard,
} from "../../core/views/dashboard";
import { type AccuracyRow } from "../../core/metrics";
import { type DashboardToHost, type HostToDashboard } from "../shared/protocol";
import { Notice } from "../shared/ui";
import { onMessage, post } from "../shared/vscode";

const send = (m: DashboardToHost) => post(m);

export function App() {
  const [model, setModel] = useState<DashboardModel | undefined>();
  const [baselines, setBaselines] = useState<string[]>([]);
  const [baseline, setBaseline] = useState<string | undefined>();
  const [burnScope, setBurnScope] = useState("project");
  const [notice, setNotice] = useState<
    { level: "info" | "error"; message: string; at: number } | undefined
  >();

  useEffect(() => {
    const off = onMessage<HostToDashboard>((m) => {
      if (m.type === "model") {
        setModel(m.model);
        setBaselines(m.baselines);
        setBaseline(m.baseline);
      } else if (m.type === "notice")
        setNotice({ level: m.level, message: m.message, at: Date.now() });
    });
    send({ type: "ready" });
    return off;
  }, []);

  if (!model) return <div class="empty">Loading the dashboard…</div>;
  const burn = burnScope === "project" ? model.burnUp.project : model.burnUp.milestones[burnScope];
  const late = model.milestones.filter((m) => m.late).length;
  const failing = model.tests.reduce((n, t) => n + t.fail, 0);

  return (
    <>
      <div class="toolbar" role="toolbar" aria-label="Dashboard">
        <span class="title">
          {model.projectName}
          {model.code ? ` · ${model.code}` : ""}
        </span>
        <span class="muted">as of {model.today}</span>
        <span class="spacer" />
        <label>
          Baseline
          <select
            value={baseline ?? ""}
            onChange={(e) => send({ type: "baseline", name: e.currentTarget.value || undefined })}
            disabled={baselines.length === 0}
          >
            {baselines.length === 0 && <option value="">none saved</option>}
            {baselines.map((b) => (
              <option value={b}>{b}</option>
            ))}
          </select>
        </label>
        <button
          class="btn"
          onClick={() => send({ type: "saveBaseline" })}
          title="Save the current schedule as a baseline"
        >
          <span class="codicon codicon-save" /> Save baseline
        </button>
        <button class="btn" onClick={() => send({ type: "open", view: "gantt" })}>
          <span class="codicon codicon-graph-line" /> Gantt
        </button>
        <button class="btn" onClick={() => send({ type: "open", view: "kanban" })}>
          <span class="codicon codicon-project" /> Kanban
        </button>
        <button class="btn" onClick={() => send({ type: "open", view: "resources" })}>
          <span class="codicon codicon-organization" /> Team load
        </button>
      </div>
      <main class="dashboard">
        <section class="kpis" aria-label="Key figures">
          <Kpi
            label="Complete"
            value={`${Math.round(model.progress * 100)}%`}
            detail="hours-weighted"
          />
          <Kpi
            label="Forecast finish"
            value={model.forecastFinish ?? "—"}
            detail={
              model.endVariance === undefined
                ? ""
                : model.endVariance > 0
                  ? `${model.endVariance} d after the end date ${model.end}`
                  : model.endVariance < 0
                    ? `${-model.endVariance} d before the end date ${model.end}`
                    : `on the end date ${model.end}`
            }
            bad={(model.endVariance ?? 0) > 0}
          />
          <Kpi
            label="Remaining work"
            value={`${Math.round(model.remainingHours)} h`}
            detail={`${model.milestones.length} milestones`}
          />
          <BudgetKpi b={model.budget} />
          <Kpi label="Late milestones" value={String(late)} bad={late > 0} />
          <Kpi
            label="Blocked"
            value={String(model.lists.blocked.length)}
            detail={
              model.blockedWaiting.tasks
                ? `${model.blockedWaiting.tasks} tasks (${model.blockedWaiting.hours} h) wait for them`
                : ""
            }
            bad={model.lists.blocked.length > 0}
          />
          <Kpi
            label="Open punch items"
            value={String(model.punch.open)}
            detail={`A ${model.punch.bySeverity.A} · B ${model.punch.bySeverity.B} · C ${model.punch.bySeverity.C}`}
            bad={model.punch.bySeverity.A > 0}
          />
          <Kpi label="Failed test steps" value={String(failing)} bad={failing > 0} />
          <Kpi
            label="Planned overtime"
            value={`${Math.round(model.overtime.hours)} h`}
            detail={
              model.overtime.byPerson.length
                ? model.overtime.byPerson
                    .slice(0, 3)
                    .map((p) => `${p.name} ${Math.round(p.hours)} h`)
                    .join(" · ")
                : "none from this week on"
            }
          />
        </section>

        <section aria-labelledby="ms-title">
          <h2 id="ms-title">Milestones</h2>
          <div class="milestones">
            {model.milestones.map((m) => (
              <Milestone m={m} />
            ))}
          </div>
        </section>

        <BudgetPanel model={model} />

        <div class="two-col">
          <section aria-labelledby="burn-title" class="panel">
            <div class="panel-head">
              <h2 id="burn-title">Burn-up</h2>
              <select
                aria-label="Burn-up scope"
                value={burnScope}
                onChange={(e) => setBurnScope(e.currentTarget.value)}
              >
                <option value="project">Whole project</option>
                {model.milestones.map((m) => (
                  <option value={m.id}>{m.title}</option>
                ))}
              </select>
            </div>
            {burn && <BurnUpChart burn={burn} />}
            <div class="chart-legend">
              <span class="key scope" /> scope <span class="key done" /> done{" "}
              <span class="key forecast" /> forecast <span class="key today" /> today
              {burn?.budget !== undefined && (
                <>
                  <span class="key budget" /> budget
                </>
              )}
            </div>
          </section>
          <section aria-labelledby="acc-title" class="panel">
            <h2 id="acc-title">Estimate accuracy</h2>
            <p class="muted small">
              Actual ÷ estimate of completed tasks. Above 100% = underestimated.
            </p>
            <AccuracyTable
              title="By person"
              rows={model.accuracy.byPerson}
              names={model.personNames}
            />
            <AccuracyTable title="By tag" rows={model.accuracy.byTag} prefix="#" />
          </section>
        </div>

        <div class="lists">
          <List title="Overdue" icon="warning" items={model.lists.overdue} bad />
          <List title="Blocked" icon="error" items={model.lists.blocked} bad />
          <List
            title="Starting this week"
            icon="debug-start"
            items={model.lists.startingThisWeek}
          />
          <List title="Unassigned" icon="question" items={model.lists.unassigned} />
          <List title="Unestimated" icon="watch" items={model.lists.unestimated} />
          <List title="Critical path" icon="flame" items={model.criticalPath} />
          {model.lists.overtime.length > 0 && (
            <List title="Planned overtime" icon="watch" items={model.lists.overtime} />
          )}
        </div>

        <div class="two-col">
          <section aria-labelledby="tests-title" class="panel">
            <h2 id="tests-title">Tests</h2>
            {model.tests.length === 0 && <div class="muted">No test plans.</div>}
            {model.tests.map((t) => (
              <div class="test-row">
                <div class="test-name">
                  <b>{t.id}</b> <span class="muted">{t.type ?? ""}</span>{" "}
                  {t.lastRun ? <span class="muted">· last run {t.lastRun}</span> : null}
                </div>
                <StackBar
                  parts={[
                    { cls: "pass", n: t.pass, label: "pass" },
                    { cls: "fail", n: t.fail, label: "fail" },
                    { cls: "na", n: t.na, label: "n.a." },
                    { cls: "open", n: t.open, label: "open" },
                  ]}
                  total={t.steps}
                />
              </div>
            ))}
          </section>
          <section aria-labelledby="punch-title" class="panel">
            <div class="panel-head">
              <h2 id="punch-title">Open punch items</h2>
              <button class="btn" onClick={() => send({ type: "open", view: "punch" })}>
                Board
              </button>
            </div>
            <StackBar
              parts={[
                { cls: "sevA", n: model.punch.bySeverity.A, label: "A" },
                { cls: "sevB", n: model.punch.bySeverity.B, label: "B" },
                { cls: "sevC", n: model.punch.bySeverity.C, label: "C" },
                { cls: "open", n: model.punch.bySeverity.none, label: "no severity" },
              ]}
              total={model.punch.open}
            />
            <p class="muted small">
              {model.punch.open} open · {model.punch.closed} closed
              {model.punch.overdue ? ` · ${model.punch.overdue} overdue` : ""}
            </p>
          </section>
        </div>
      </main>
      <Notice notice={notice} />
    </>
  );
}

function Kpi({
  label,
  value,
  detail,
  bad,
}: {
  label: string;
  value: string;
  detail?: string;
  bad?: boolean;
}) {
  return (
    <div class={`kpi${bad ? " bad" : ""}`}>
      <div class="kpi-label">{label}</div>
      <div class="kpi-value">{value}</div>
      {detail && <div class="kpi-detail muted">{detail}</div>}
    </div>
  );
}

function Milestone({ m }: { m: MilestoneCard }) {
  const pct = Math.round(m.progress * 100);
  const variance =
    m.variance === undefined
      ? ""
      : m.variance > 0
        ? `${m.variance} d late`
        : m.variance < 0
          ? `${-m.variance} d ahead`
          : "on target";
  return (
    <div class={`ms-card${m.late ? " late" : ""}`}>
      <div class="ms-head">
        <span class={`codicon codicon-milestone${m.late ? " late" : ""}`} />
        <b>{m.title}</b>
        <span class="muted">{m.status}</span>
      </div>
      <div
        class="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${m.title} ${pct}% complete`}
      >
        <div class="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div class="ms-row">
        <span>{pct}%</span>
        <span class="muted">
          {m.done}/{m.total} tasks · {m.remaining} h left
        </span>
      </div>
      <div class="ms-row">
        <span class="muted">target</span> <span>{m.target ?? "—"}</span>
      </div>
      <div class="ms-row">
        <span class="muted">forecast</span>
        <span class={m.late ? "bad" : ""}>
          {m.forecast ?? "—"} {variance && <span class="badge">{variance}</span>}
        </span>
      </div>
      {m.trend && m.trend.slip !== undefined && (
        <div class="ms-row">
          <span class="muted">vs {m.trend.baseline}</span>
          <span class={m.trend.slip > 0 ? "bad" : m.trend.slip < 0 ? "good" : ""}>
            {m.trend.slip > 0
              ? `+${m.trend.slip} d slip`
              : m.trend.slip < 0
                ? `${-m.trend.slip} d gained`
                : "unchanged"}
          </span>
        </div>
      )}
    </div>
  );
}

function BurnUpChart({ burn }: { burn: DashboardModel["burnUp"]["project"] }) {
  const g = burnUpGeometry(burn, 640, 240);
  return (
    <svg
      class="burnup"
      viewBox={`0 0 ${g.width} ${g.height}`}
      role="img"
      aria-label={`Burn-up: scope ${Math.round(burn.scope)} hours`}
    >
      {g.yTicks.map((t) => (
        <g>
          <line class="grid" x1={g.plot.left} x2={g.plot.right} y1={t.pos} y2={t.pos} />
          <text class="axis" x={g.plot.left - 6} y={t.pos + 4} text-anchor="end">
            {t.label}
          </text>
        </g>
      ))}
      {g.xTicks.map((t) => (
        <text class="axis" x={t.pos} y={g.plot.bottom + 18}>
          {t.label}
        </text>
      ))}
      {g.budgetY !== undefined && (
        <g>
          <line class="budget" x1={g.plot.left} x2={g.plot.right} y1={g.budgetY} y2={g.budgetY} />
          <text class="axis budget-label" x={g.plot.right} y={g.budgetY - 5} text-anchor="end">
            budget {Math.round(burn.budget!)} h
          </text>
        </g>
      )}
      <path class="line scope" d={g.scope} />
      <path class="line forecast" d={g.forecast} />
      <path class="line done" d={g.done} />
      {g.todayX !== undefined && (
        <line class="today" x1={g.todayX} x2={g.todayX} y1={g.plot.top} y2={g.plot.bottom} />
      )}
    </svg>
  );
}

/** "1,250 h": hours rounded, with thousands separators. */
function hours(h: number): string {
  return `${Math.round(h).toLocaleString("en-US")} h`;
}

/** Budget key figure: the forecast against the budget, "140 h left" or "50 h over". */
function BudgetKpi({ b }: { b: DashboardModel["budget"] }) {
  if (b.budget === undefined)
    return <Kpi label="Budget" value="not set" detail={`planned ${hours(b.planned)}`} />;
  const left = b.budget - b.forecast;
  return (
    <Kpi
      label="Budget"
      value={hours(b.budget)}
      detail={`forecast ${hours(b.forecast)} · ${left >= 0 ? `${hours(left)} left` : `${hours(-left)} over`}`}
      bad={left < 0}
    />
  );
}

/**
 * Budget against the plan: a meter (logged hours, work done without logged hours and the work
 * left make up the forecast; red past the budget line), the figures, why it goes over, and the
 * hours per milestone.
 */
function BudgetPanel({ model }: { model: DashboardModel }) {
  const b = model.budget;
  const over = b.budget !== undefined && b.forecast > b.budget;
  return (
    <section aria-labelledby="budget-title" class="panel budget-panel">
      <div class="panel-head">
        <h2 id="budget-title">Budget</h2>
        <button class="btn" onClick={() => send({ type: "editProject" })}>
          <span class="codicon codicon-edit" />{" "}
          {b.budget === undefined ? "Set budget…" : "Edit budget…"}
        </button>
      </div>
      <div class="budget-grid">
        <div>
          <BudgetMeter b={b} />
          <div class="chart-legend">
            <span class="swatch logged" /> logged
            {b.unlogged > 0 && (
              <>
                <span class="swatch unlogged" /> done, not logged
              </>
            )}
            <span class="swatch remaining" /> remaining
            {over && (
              <>
                <span class="swatch overrun" /> over budget
              </>
            )}
            {b.budget !== undefined && (
              <>
                <span class="key budget" /> budget
              </>
            )}
            <span class="planned-key">▲</span> planned
          </div>
          <div class="budget-figures">
            <Figure label="Budget" value={b.budget === undefined ? "not set" : hours(b.budget)} />
            <Figure label="Planned" value={hours(b.planned)} detail="sum of estimates" />
            <Figure
              label="Forecast"
              value={hours(b.forecast)}
              detail={b.unlogged > 0 ? "logged + done + remaining" : "logged + remaining"}
              bad={over}
            />
            <Figure label="Logged" value={hours(b.spent)} detail="@act" />
            {b.unlogged > 0 && (
              <Figure label="Done, not logged" value={hours(b.unlogged)} detail="at the estimate" />
            )}
            {b.budget !== undefined && (
              <Figure
                label={over ? "Over budget" : "Left"}
                value={hours(Math.abs(b.budget - b.forecast))}
                bad={over}
              />
            )}
          </div>
          {b.reasons.length > 0 && (
            <div class="budget-why">
              <h3>
                <span class="codicon codicon-warning" /> Why the forecast is over the budget
              </h3>
              <ul>
                {b.reasons.map((r) => (
                  <li>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {b.budget === undefined && (
            <p class="muted small">
              Set the project's budget in hours (budget: in project.md) to compare it with the plan.
            </p>
          )}
          {b.unestimated > 0 && b.reasons.length === 0 && (
            <p class="muted small">
              {b.unestimated} open task(s) have no estimate yet: the forecast will grow.
            </p>
          )}
        </div>
        <div>
          <table class="accuracy budget-table">
            <caption>By milestone</caption>
            <thead>
              <tr>
                <th scope="col">milestone</th>
                <th scope="col">planned</th>
                <th scope="col">logged</th>
                <th scope="col">forecast</th>
                <th scope="col">vs plan</th>
              </tr>
            </thead>
            <tbody>
              {b.milestones.map((m) => {
                const diff = Math.round(m.forecast - m.planned);
                return (
                  <tr>
                    <td title={m.title}>{m.id}</td>
                    <td>{hours(m.planned)}</td>
                    <td>{hours(m.spent)}</td>
                    <td>{hours(m.forecast)}</td>
                    <td class={diff > 0 ? "bad" : diff < 0 ? "good" : ""}>
                      {diff > 0 ? `+${diff} h` : diff < 0 ? `−${-diff} h` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {b.overruns.length > 0 && (
            <List
              title="Taking longer than estimated"
              icon="watch"
              items={b.overruns.slice(0, 5)}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function Figure({
  label,
  value,
  detail,
  bad,
}: {
  label: string;
  value: string;
  detail?: string;
  bad?: boolean;
}) {
  return (
    <div class="figure">
      <div class="muted small">{label}</div>
      <div class={`figure-value${bad ? " bad" : ""}`}>{value}</div>
      {detail && <div class="muted small">{detail}</div>}
    </div>
  );
}

/**
 * One bar on an hours scale: logged, done without logged hours, then remaining up to the forecast
 * (the parts come from the model); the budget line on top.
 */
function BudgetMeter({ b }: { b: DashboardModel["budget"] }) {
  const W = 600;
  const H = 46;
  const BAR = 16;
  const top = 18;
  const max = Math.max(b.budget ?? 0, b.forecast, b.planned, 1) * 1.04;
  const x = (h: number) => (Math.min(h, max) / max) * W;
  const gap = 2;
  const title: Record<BudgetBarPart["kind"], string> = {
    logged: `Logged ${hours(b.spent)}`,
    unlogged: `Done, not logged ${hours(b.unlogged)} (at the estimate)`,
    remaining: `Remaining ${hours(b.remaining)} · forecast ${hours(b.forecast)}`,
    overrun: `Over budget ${hours(b.forecast - (b.budget ?? b.forecast))}`,
  };
  const parts = `${hours(b.spent)} logged${b.unlogged > 0 ? `, ${hours(b.unlogged)} done, not logged` : ""}, ${hours(b.remaining)} remaining`;
  const label =
    b.budget === undefined
      ? `Forecast ${hours(b.forecast)}: ${parts}; planned ${hours(b.planned)}; no budget set`
      : `Budget ${hours(b.budget)}; forecast ${hours(b.forecast)}: ${parts}; planned ${hours(b.planned)}`;
  return (
    <svg class="budget-meter" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <defs>
        <pattern
          id="unlogged-hatch"
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line class="hatch" x1={1.5} y1={0} x2={1.5} y2={6} />
        </pattern>
      </defs>
      <rect class="track" x={0} y={top} width={W} height={BAR} rx={4} />
      {b.bar.map((p, i) => {
        // A small gap between the parts keeps them apart.
        const from = x(p.from) + (i > 0 ? gap : 0);
        const width = x(p.to) - from;
        return width > 0 ? (
          <rect
            class={p.kind}
            x={from}
            y={top}
            width={width}
            height={BAR}
            rx={4}
            fill={p.kind === "unlogged" ? "url(#unlogged-hatch)" : undefined}
          >
            <title>{title[p.kind]}</title>
          </rect>
        ) : null;
      })}
      <path class="planned" d={`M${x(b.planned)},${top + BAR + 2} l-4,7 h8 z`}>
        <title>Planned {hours(b.planned)}</title>
      </path>
      {b.budget !== undefined && (
        <g>
          <line class="budget" x1={x(b.budget)} x2={x(b.budget)} y1={top - 4} y2={top + BAR + 4}>
            <title>Budget {hours(b.budget)}</title>
          </line>
          <text
            class="budget-label"
            x={x(b.budget)}
            y={top - 7}
            text-anchor={x(b.budget) > W - 80 ? "end" : "middle"}
          >
            budget {hours(b.budget)}
          </text>
        </g>
      )}
    </svg>
  );
}

function AccuracyTable({
  title,
  rows,
  names,
  prefix = "",
}: {
  title: string;
  rows: AccuracyRow[];
  names?: Record<string, string>;
  prefix?: string;
}) {
  if (rows.length === 0)
    return <div class="muted small">{title}: no completed tasks with estimate and actual yet.</div>;
  return (
    <table class="accuracy">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">{title.replace("By ", "")}</th>
          <th scope="col">n</th>
          <th scope="col">est</th>
          <th scope="col">act</th>
          <th scope="col">act/est</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 8).map((r) => (
          <tr>
            <td>{prefix + (names?.[r.key] ?? r.key)}</td>
            <td>{r.n}</td>
            <td>{Math.round(r.est * 10) / 10}h</td>
            <td>{Math.round(r.act * 10) / 10}h</td>
            <td class={r.ratio > 1.1 ? "bad" : r.ratio < 0.9 ? "good" : ""}>
              {Math.round(r.ratio * 100)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function List({
  title,
  icon,
  items,
  bad,
}: {
  title: string;
  icon: string;
  items: DashboardItem[];
  bad?: boolean;
}) {
  return (
    <section class={`panel list${bad && items.length ? " bad" : ""}`} aria-label={title}>
      <h3>
        <span class={`codicon codicon-${icon}`} /> {title} <span class="count">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <div class="muted small">None.</div>
      ) : (
        <ul>
          {items.slice(0, 12).map((i) => (
            <li>
              <a
                href="#"
                onClick={(e) => (e.preventDefault(), send({ type: "reveal", key: i.key }))}
              >
                {i.id ? `${i.id} · ` : ""}
                {i.title}
              </a>
              <div class="muted small">{i.detail}</div>
            </li>
          ))}
          {items.length > 12 && <li class="muted small">… and {items.length - 12} more</li>}
        </ul>
      )}
    </section>
  );
}

function StackBar({
  parts,
  total,
}: {
  parts: Array<{ cls: string; n: number; label: string }>;
  total: number;
}) {
  const label =
    parts
      .filter((p) => p.n > 0)
      .map((p) => `${p.n} ${p.label}`)
      .join(", ") || "none";
  return (
    <div class="stack" role="img" aria-label={label}>
      <div class="stack-bar">
        {parts.map((p) =>
          p.n > 0 ? (
            <div
              class={`seg ${p.cls}`}
              style={{ flexGrow: String(p.n) }}
              title={`${p.n} ${p.label}`}
            />
          ) : null
        )}
        {total === 0 && <div class="seg empty" style={{ flexGrow: "1" }} />}
      </div>
      <div class="stack-label small">{label}</div>
    </div>
  );
}
