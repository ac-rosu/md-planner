// Resource heatmap: person × ISO week. Click a cell to list the tasks of that person-week. The grid
// has one tab stop; arrow keys, Home and End move between cells, Enter or Space selects.
import { useEffect, useRef, useState } from "preact/hooks";
import { type HeatCell, type HeatRow, type ResourcesModel } from "../../core/views/resources";
import { type HostToResources, type ResourcesToHost } from "../shared/protocol";
import { Notice } from "../shared/ui";
import { onMessage, post } from "../shared/vscode";

const send = (m: ResourcesToHost) => post(m);

const LEVEL_TEXT: Record<string, string> = {
  none: "no work",
  under: "under capacity",
  near: "near capacity",
  over: "over capacity",
};

export function App() {
  const [model, setModel] = useState<ResourcesModel | undefined>();
  const [selected, setSelected] = useState<{ row: string; week: string } | undefined>();
  const [active, setActive] = useState<{ row: string; week: string } | undefined>();
  const [notice, setNotice] = useState<
    { level: "info" | "error"; message: string; at: number } | undefined
  >();
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    const off = onMessage<HostToResources>((m) => {
      if (m.type === "model") setModel(m.model);
      else if (m.type === "notice")
        setNotice({ level: m.level, message: m.message, at: Date.now() });
    });
    send({ type: "ready" });
    return off;
  }, []);

  useEffect(() => {
    if (!model || scrolled.current || !scroller.current) return;
    scrolled.current = true;
    const index = model.weeks.findIndex((w) => w.key === model.todayWeek);
    if (index > 2) scroller.current.scrollLeft = (index - 2) * 64;
  }, [model]);

  if (!model) return <div class="empty">Loading the team load…</div>;
  // The cell that takes the tab stop: the last focused one, else the selection, else this week.
  const firstRow = model.rows[0];
  const tabStop =
    [active, selected].find(
      (c) => c && model.rows.some((r) => r.id === c.row && r.cells.some((x) => x.week === c.week))
    ) ??
    (firstRow
      ? {
          row: firstRow.id,
          week: firstRow.cells.some((c) => c.week === model.todayWeek)
            ? model.todayWeek
            : (firstRow.cells[0]?.week ?? ""),
        }
      : undefined);
  const onGridKey = (e: KeyboardEvent) => {
    const td = (e.target as HTMLElement).closest("td");
    const tr = td?.parentElement as HTMLTableRowElement | null;
    const table = tr?.closest("table");
    if (!td || !tr || !table) return;
    const last = tr.cells.length - 1;
    let [row, col] = [tr.rowIndex, td.cellIndex];
    if (e.key === "ArrowRight") col++;
    else if (e.key === "ArrowLeft") col--;
    else if (e.key === "ArrowDown") row++;
    else if (e.key === "ArrowUp") row--;
    else if (e.key === "Home")
      col = 1; // column 0 is the person
    else if (e.key === "End") col = last;
    else return;
    const target = table.rows[row]?.cells[col]?.querySelector<HTMLButtonElement>(".cell-btn");
    e.preventDefault();
    target?.focus();
  };
  const row = selected ? model.rows.find((r) => r.id === selected.row) : undefined;
  const cell = row?.cells.find((c) => c.week === selected?.week);
  const months: Array<{ label: string; span: number }> = [];
  for (const w of model.weeks) {
    const last = months[months.length - 1];
    if (last && last.label === w.month) last.span++;
    else months.push({ label: w.month, span: 1 });
  }

  return (
    <>
      <div class="toolbar" role="toolbar" aria-label="Team load options">
        <span class="title">Team load – {model.projectName}</span>
        <span role="group" aria-label="Mode">
          <button
            class="btn"
            aria-pressed={model.mode === "capacity"}
            onClick={() => send({ type: "mode", mode: "capacity" })}
            title="Resource-constrained schedule"
          >
            Scheduled
          </button>
          <button
            class="btn"
            aria-pressed={model.mode === "demand"}
            onClick={() => send({ type: "mode", mode: "demand" })}
            title="All tasks at their earliest start, ignoring capacity"
          >
            Demand
          </button>
        </span>
        <span class="legend" aria-label="Legend">
          <span class="swatch under" /> under 80%
          <span class="swatch near" /> 80–100%
          <span class="swatch over" /> over
          <span class="swatch off" /> time off
          <span class="swatch ot" /> overtime or extra days
        </span>
        <span class="spacer" />
        <span class="muted">
          {model.mode === "demand"
            ? "Demand: raw overload if everything started as early as possible."
            : "Scheduled hours per ISO week versus capacity."}
        </span>
      </div>
      <div class="heat-scroller" ref={scroller}>
        <table class="heatmap" role="grid" aria-label="Scheduled hours per person and ISO week">
          <thead>
            <tr>
              <th class="sticky corner" rowSpan={2} scope="col">
                Person
              </th>
              {months.map((m) => (
                <th class="month" colSpan={m.span} scope="colgroup">
                  {m.span >= 2 ? m.label : ""}
                </th>
              ))}
            </tr>
            <tr>
              {model.weeks.map((w) => (
                <th
                  class={`week${w.key === model.todayWeek ? " today" : ""}`}
                  scope="col"
                  title={w.key}
                >
                  {w.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody onKeyDown={onGridKey}>
            {model.rows.map((r) => (
              <tr>
                <th class="sticky person" scope="row">
                  <span class="dot" style={{ backgroundColor: r.color }} />
                  <span class="name">{r.name}</span>
                  {r.overWeeks > 0 && (
                    <span class="over-count" title={`${r.overWeeks} week(s) over capacity`}>
                      {r.overWeeks}
                    </span>
                  )}
                  {r.role && <div class="role muted">{r.role}</div>}
                </th>
                {r.cells.map((c) => (
                  <Cell
                    row={r}
                    cell={c}
                    current={c.week === model.todayWeek}
                    selected={selected?.row === r.id && selected.week === c.week}
                    tabStop={tabStop?.row === r.id && tabStop.week === c.week}
                    onFocus={() => setActive({ row: r.id, week: c.week })}
                    onSelect={() => setSelected({ row: r.id, week: c.week })}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="details" aria-live="polite">
        {row && cell ? (
          <>
            <div class="details-title">
              <b>{row.name}</b> · {cell.week} · {fmt(cell.hours)}/{fmt(cell.capacity)} h ·{" "}
              {LEVEL_TEXT[cell.level]}
              {cell.off !== "none" &&
                ` · ${cell.off === "full" ? "on leave all week" : "partly on leave"}`}
            </div>
            {cell.overtimeCapacity > 0 && (
              <div class="details-overtime">
                Normal capacity {fmt(cell.normal)} h + {fmt(cell.overtimeCapacity)} h of overtime
                {cell.extraDays.length > 0 &&
                  ` and extra working days (${cell.extraDays.join(", ")})`}
                ; {fmt(cell.overtime)} h of it is scheduled.
              </div>
            )}
            {row.id !== "unassigned" && (
              <div class="details-actions">
                <button
                  class="btn"
                  title={`Extra hours for ${row.name} on working days (overtime: in team.md)`}
                  onClick={() => send({ type: "overtime", person: row.id, week: cell.week })}
                >
                  <span class="codicon codicon-watch" /> Plan overtime…
                </button>
                <button
                  class="btn"
                  title={`A weekend day or holiday ${row.name} works (workday: in team.md)`}
                  onClick={() => send({ type: "workday", person: row.id, week: cell.week })}
                >
                  <span class="codicon codicon-calendar" /> Add a working day…
                </button>
              </div>
            )}
            {cell.tasks.length === 0 ? (
              <div class="muted">No scheduled work.</div>
            ) : (
              <ul class="task-list">
                {cell.tasks.map((t) => (
                  <li>
                    <a
                      href="#"
                      onClick={(e) => (e.preventDefault(), send({ type: "reveal", key: t.key }))}
                    >
                      {t.id ? `${t.id} · ` : ""}
                      {t.title}
                    </a>
                    <span class="muted">
                      {" "}
                      {fmt(t.hours)} h{t.overtime ? ` (${fmt(t.overtime)} h overtime)` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div class="muted">Select a cell to see the tasks of that person and week.</div>
        )}
      </div>
      <Notice notice={notice} />
    </>
  );
}

function Cell({
  row,
  cell,
  current,
  selected,
  tabStop,
  onFocus,
  onSelect,
}: {
  row: HeatRow;
  cell: HeatCell;
  current: boolean;
  selected: boolean;
  tabStop: boolean;
  onFocus: () => void;
  onSelect: () => void;
}) {
  const overtime =
    cell.overtimeCapacity > 0
      ? `, including ${fmt(cell.overtimeCapacity)} hours of overtime or extra days (${fmt(cell.overtime)} scheduled)`
      : "";
  const label = `${row.name}, ${cell.week}: ${fmt(cell.hours)} of ${fmt(cell.capacity)} hours${overtime}, ${LEVEL_TEXT[cell.level]}${cell.off !== "none" ? ", time off" : ""}`;
  return (
    <td
      class={`cell ${cell.level} off-${cell.off}${cell.overtimeCapacity > 0 ? " ot" : ""}${current ? " current" : ""}${selected ? " selected" : ""}`}
    >
      <button
        class="cell-btn"
        aria-label={label}
        aria-pressed={selected}
        title={label}
        tabIndex={tabStop ? 0 : -1}
        onFocus={onFocus}
        onClick={onSelect}
      >
        {cell.hours > 0 ? (
          <>
            <span class="hours">{fmt(cell.hours)}</span>
            <span class="cap">/{fmt(cell.capacity)}</span>
          </>
        ) : cell.capacity === 0 ? (
          <span class="cap">–</span>
        ) : null}
        {cell.overtimeCapacity > 0 && cell.hours > 0 && (
          <span class="ot-hours" aria-hidden="true">
            +{fmt(cell.overtime)} OT
          </span>
        )}
      </button>
    </td>
  );
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}
