// Gantt webview: toolbar, accessible task tree (left) and the SVG timeline (right).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type GanttLink, type GanttModel, type GanttRow } from "../../core/views/gantt";
import {
  DEFAULT_GANTT_OPTIONS,
  type GanttToHost,
  type GanttViewOptions,
  type GanttZoom,
  type HostToGantt,
} from "../shared/protocol";
import { Notice, Tooltip, UndoRedo } from "../shared/ui";
import { getState, isoDate, onMessage, post, setState } from "../shared/vscode";
import { Chart, type DragResult, ROW_H } from "./Chart";
import { EditDialog, type EditResult } from "./EditDialog";
import { stepWorkingDays, visibleRows, vscodeContext } from "./rows";
import { dayToX, fitPx, headerTicks, makeScale, ZOOM_PX } from "./scale";

const LEFT_W = 320;

interface Persisted {
  collapsed: string[];
}

const send = (m: GanttToHost) => post(m);

export function App() {
  const [model, setModel] = useState<GanttModel | undefined>();
  const [options, setOptions] = useState<GanttViewOptions>(DEFAULT_GANTT_OPTIONS);
  const [baselines, setBaselines] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(getState<Persisted>()?.collapsed ?? [])
  );
  const [selected, setSelected] = useState<string | undefined>();
  const [selectedLink, setSelectedLink] = useState<GanttLink | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [notice, setNotice] = useState<
    { level: "info" | "error"; message: string; at: number } | undefined
  >();
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const tooltip = useMemo(() => new Tooltip(), []);
  const pendingFocus = useRef<string | undefined>(undefined);

  useEffect(() => {
    const off = onMessage<HostToGantt>((m) => {
      switch (m.type) {
        case "model":
          setModel(m.model);
          setOptions(m.options);
          setBaselines(m.baselines);
          break;
        case "focus":
          pendingFocus.current = m.key;
          setSelected(m.key);
          break;
        case "history":
          setHistory({ canUndo: m.canUndo, canRedo: m.canRedo });
          break;
        case "notice":
          setNotice({ level: m.level, message: m.message, at: Date.now() });
          break;
      }
    });
    send({ type: "ready" });
    return off;
  }, []);

  useEffect(() => setState<Persisted>({ collapsed: [...collapsed] }), [collapsed]);

  const rows = useMemo(() => (model ? visibleRows(model.rows, collapsed) : []), [model, collapsed]);
  const scale = useMemo(() => {
    if (!model) return makeScale(0, 30, ZOOM_PX.week);
    return makeScale(model.start, model.end, options.pxPerDay ?? ZOOM_PX[options.zoom]);
  }, [model, options.zoom, options.pxPerDay]);

  // Scroll a focused task (from "Open in Gantt") or today into view.
  useEffect(() => {
    if (!model || !scroller.current) return;
    const key = pendingFocus.current;
    if (key) {
      pendingFocus.current = undefined;
      // Expand ancestors of the focused row.
      const byKey = new Map(model.rows.map((r) => [r.key, r]));
      const open = new Set(collapsed);
      let changed = false;
      for (let p = byKey.get(key)?.parent; p; p = byKey.get(p)?.parent)
        if (open.delete(p)) changed = true;
      if (changed) {
        setCollapsed(open);
        pendingFocus.current = key;
        return;
      }
      scrollToRow(key);
    }
  }, [model, rows]);

  const updateOptions = (patch: Partial<GanttViewOptions>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    send({ type: "options", options: next });
  };

  const scrollToRow = (key: string) => {
    const index = rows.findIndex((r) => r.key === key);
    const el = scroller.current;
    if (index < 0 || !el) return;
    const row = rows[index];
    const top = index * ROW_H;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 80)
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    if (row.start !== undefined) {
      const x = dayToX(scale, row.start);
      if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - LEFT_W - 40)
        el.scrollLeft = Math.max(0, x - 80);
    }
  };

  const scrollToToday = () => {
    if (!model || !scroller.current) return;
    scroller.current.scrollLeft = Math.max(
      0,
      dayToX(scale, model.today) - (scroller.current.clientWidth - LEFT_W) / 3
    );
  };

  // Start at today the first time a model arrives.
  const scrolledOnce = useRef(false);
  useEffect(() => {
    if (model && !scrolledOnce.current) {
      scrolledOnce.current = true;
      requestAnimationFrame(scrollToToday);
    }
  }, [model]);

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };

  const select = (key: string, reveal: boolean) => {
    setSelected(key);
    setSelectedLink(undefined);
    const row = model?.rows.find((r) => r.key === key);
    if (reveal && row?.task) send({ type: "reveal", key: row.task });
  };

  const onDrag = (r: DragResult) => {
    if (r.kind === "move") send({ type: "move", key: r.key, start: isoDate(r.start) });
    else if (r.kind === "resize") send({ type: "resize", key: r.key, finish: isoDate(r.finish) });
    else send({ type: "link", from: r.from, to: r.to });
  };

  const onEditSave = (key: string, result: EditResult) => {
    setEditing(undefined);
    if (Object.keys(result).length) send({ type: "edit", key, ...result });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!model || editing) return;
    const index = rows.findIndex((r) => r.key === selected);
    const row = rows[index];
    const move = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (r) {
        setSelected(r.key);
        scrollToRow(r.key);
        requestAnimationFrame(() =>
          list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(r.key)}"]`)?.focus()
        );
      }
    };
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(rows.length - 1);
    } else if (!row) {
      return;
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && row.editable) {
      e.preventDefault();
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      if (e.shiftKey && row.finish !== undefined) {
        const finish = stepWorkingDays(model, row.finish, dir);
        if (row.start === undefined || finish >= row.start)
          send({ type: "resize", key: row.key, finish: isoDate(finish) });
      } else if (!e.shiftKey && row.start !== undefined) {
        send({
          type: "move",
          key: row.key,
          start: isoDate(stepWorkingDays(model, row.start, dir)),
        });
      }
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && row.hasChildren) {
      e.preventDefault();
      const isCollapsed = collapsed.has(row.key);
      if ((e.key === "ArrowLeft") !== isCollapsed) toggle(row.key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (row.task) send({ type: "reveal", key: row.task });
      else if (row.hasChildren) toggle(row.key);
    } else if (e.key === "F2" && row.editable) {
      e.preventDefault();
      setEditing(row.key);
    } else if (e.key === " " && row.hasChildren) {
      e.preventDefault();
      toggle(row.key);
    }
  };

  const removeSelectedLink = () => {
    if (!selectedLink) return;
    send({ type: "unlink", from: selectedLink.from, to: selectedLink.to });
    setSelectedLink(undefined);
  };
  const onGlobalKey = (e: KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedLink && !editing) {
      e.preventDefault();
      removeSelectedLink();
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", onGlobalKey);
    return () => window.removeEventListener("keydown", onGlobalKey);
  });

  if (!model) return <div class="empty">Loading the schedule…</div>;
  const ticks = headerTicks(scale);
  const editRow = editing ? model.rows.find((r) => r.key === editing) : undefined;
  const zoomLabel: Record<GanttZoom, string> = {
    day: "Day",
    week: "Week",
    month: "Month",
    quarter: "Quarter",
  };
  const late = model.rows.filter((r) => r.kind === "milestone" && r.late).length;

  return (
    <>
      <div class="toolbar" role="toolbar" aria-label="Gantt options">
        <span class="title">{model.projectName}</span>
        <label>
          Group
          <select
            value={options.grouping}
            onChange={(e) =>
              updateOptions({ grouping: e.currentTarget.value as GanttViewOptions["grouping"] })
            }
          >
            <option value="milestone">Milestone</option>
            <option value="section">Section</option>
            <option value="owner">Owner</option>
            <option value="tag">Tag</option>
          </select>
        </label>
        <label>
          Colour
          <select
            value={options.color}
            onChange={(e) =>
              updateOptions({ color: e.currentTarget.value as GanttViewOptions["color"] })
            }
          >
            <option value="owner">Owner</option>
            <option value="status">Status</option>
            <option value="milestone">Milestone</option>
          </select>
        </label>
        <span role="group" aria-label="Zoom">
          {(["day", "week", "month", "quarter"] as GanttZoom[]).map((z) => (
            <button
              class="btn"
              aria-pressed={!options.pxPerDay && options.zoom === z}
              onClick={() => updateOptions({ zoom: z, pxPerDay: undefined })}
            >
              {zoomLabel[z]}
            </button>
          ))}
        </span>
        <button
          class="btn"
          title="Fit the whole project"
          aria-pressed={options.pxPerDay !== undefined}
          onClick={() => {
            const width = (scroller.current?.clientWidth ?? 1200) - LEFT_W - 20;
            updateOptions({ pxPerDay: fitPx(model.start, model.end, width) });
            if (scroller.current) scroller.current.scrollLeft = 0;
          }}
        >
          <span class="codicon codicon-screen-full" /> Fit
        </button>
        <button class="btn" onClick={scrollToToday} title="Scroll to today">
          <span class="codicon codicon-calendar" /> Today
        </button>
        <button
          class="btn"
          aria-pressed={options.showCritical}
          onClick={() => updateOptions({ showCritical: !options.showCritical })}
          title="Highlight the critical path"
        >
          Critical path
        </button>
        <button
          class="btn"
          aria-pressed={options.hideDone}
          onClick={() => updateOptions({ hideDone: !options.hideDone })}
        >
          Hide done
        </button>
        {baselines.length > 0 && (
          <label>
            Baseline
            <select
              value={options.showBaseline ? (options.baseline ?? "") : "-"}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (v === "-") updateOptions({ showBaseline: false });
                else updateOptions({ showBaseline: true, baseline: v || undefined });
              }}
            >
              <option value="-">None</option>
              <option value="">Latest</option>
              {baselines.map((b) => (
                <option value={b}>{b}</option>
              ))}
            </select>
          </label>
        )}
        <span class="spacer" />
        {late > 0 && (
          <span class="late-badge" title="Milestones forecast after their target">
            <span class="codicon codicon-warning" /> {late} late
          </span>
        )}
        {selectedLink && (
          <button class="btn" onClick={removeSelectedLink}>
            <span class="codicon codicon-trash" /> Remove dependency
          </button>
        )}
        <UndoRedo
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onUndo={() => send({ type: "undo" })}
          onRedo={() => send({ type: "redo" })}
        />
      </div>
      <div class="scroller" ref={scroller}>
        <div class="canvas" style={{ width: `${LEFT_W + scale.width}px` }}>
          <div class="header">
            <div class="corner" style={{ width: `${LEFT_W}px` }}>
              <span>Task</span>
              <span class="muted">{rows.filter((r) => r.kind === "task").length} tasks</span>
            </div>
            <svg class="timeline-header" width={scale.width} height={44} aria-hidden="true">
              {ticks.top.map((t) => (
                <g>
                  <line class="tick" x1={t.x} y1={0} x2={t.x} y2={22} />
                  <text class="tick-label" x={t.x + 4} y={15}>
                    {t.width > 40 ? t.label : ""}
                  </text>
                </g>
              ))}
              {ticks.bottom.map((t) => (
                <g>
                  <line class="tick" x1={t.x} y1={22} x2={t.x} y2={44} />
                  <text class="tick-label small" x={t.x + 3} y={37}>
                    {t.width >= 22 ? t.label : ""}
                  </text>
                </g>
              ))}
              <line
                class="today"
                x1={dayToX(scale, model.today)}
                y1={0}
                x2={dayToX(scale, model.today)}
                y2={44}
              />
            </svg>
          </div>
          <div class="body">
            <div
              class="list"
              ref={list}
              role="tree"
              aria-label="Tasks"
              style={{ width: `${LEFT_W}px` }}
              onKeyDown={onKeyDown}
            >
              {rows.map((r) => (
                <ListRow
                  row={r}
                  selected={r.key === selected}
                  collapsed={collapsed.has(r.key)}
                  onToggle={() => toggle(r.key)}
                  onSelect={() => select(r.key, false)}
                  onOpen={() => r.task && send({ type: "reveal", key: r.task })}
                  onEdit={() => r.editable && setEditing(r.key)}
                  focusable={r.key === (selected ?? rows[0]?.key)}
                />
              ))}
            </div>
            <Chart
              model={model}
              rows={rows}
              scale={scale}
              options={options}
              selected={selected}
              selectedLink={selectedLink}
              tooltip={tooltip}
              onSelect={select}
              onEdit={(key) => {
                const row = model.rows.find((r) => r.key === key);
                if (row?.editable) setEditing(key);
              }}
              onDrag={onDrag}
              onSelectLink={(l) => {
                setSelectedLink(l);
                if (l) setSelected(undefined);
              }}
            />
          </div>
        </div>
      </div>
      <div class="statusline muted" aria-live="polite">
        Drag a bar to move it (@start), drag its end to resize (@est), drag the dot to another bar
        to add a dependency. Double-click or F2 to edit, right-click for all actions; Alt+←/→ moves,
        Shift+Alt+←/→ resizes.
        {model.rows.some((r) => r.overtime) &&
          " Orange marks above a bar: overtime or extra working days (hover for the hours)."}
      </div>
      {editRow && (
        <EditDialog
          row={editRow}
          model={model}
          onSave={(r) => onEditSave(editRow.key, r)}
          onCancel={() => setEditing(undefined)}
          onAllFields={() => {
            setEditing(undefined);
            if (editRow.task) send({ type: "editAll", key: editRow.task });
          }}
        />
      )}
      <Notice notice={notice} />
    </>
  );
}

function ListRow({
  row,
  selected,
  collapsed,
  focusable,
  onToggle,
  onSelect,
  onOpen,
  onEdit,
}: {
  row: GanttRow;
  selected: boolean;
  collapsed: boolean;
  focusable: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const label = [
    row.title,
    row.id,
    row.ownerName,
    row.start !== undefined
      ? `${isoDate(row.start)} to ${isoDate(row.finish ?? row.start)}`
      : "not scheduled",
    row.late ? "late" : "",
    row.critical ? "critical" : "",
    row.overtime ? `${row.overtime} hours of overtime` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div
      class={`list-row ${row.kind}${selected ? " selected" : ""}${row.status ? ` status-${row.status}` : ""}`}
      role="treeitem"
      aria-level={row.level + 1}
      aria-expanded={row.hasChildren ? !collapsed : undefined}
      aria-selected={selected}
      aria-label={label}
      tabIndex={focusable ? 0 : -1}
      data-row={row.key}
      data-vscode-context={vscodeContext(row)}
      onClick={onSelect}
      onDblClick={() => (row.editable ? onEdit() : onOpen())}
      style={{ paddingLeft: `${6 + row.level * 14}px` }}
    >
      {row.hasChildren ? (
        <span
          class={`twisty codicon codicon-chevron-${collapsed ? "right" : "down"}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        />
      ) : (
        <span class="twisty" />
      )}
      {row.kind === "milestone" && (
        <span class={`codicon codicon-milestone${row.late ? " late" : ""}`} />
      )}
      <span class="row-title">{row.title}</span>
      {row.id && row.kind !== "milestone" && <span class="row-id muted">{row.id}</span>}
      {row.ownerInitials && <span class="row-owner">{row.ownerInitials}</span>}
      {row.task && (
        <button
          class="icon-btn row-open"
          title="Reveal in editor"
          aria-label={`Reveal ${row.title} in editor`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <span class="codicon codicon-go-to-file" />
        </button>
      )}
    </div>
  );
}
