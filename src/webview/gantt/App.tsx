// Gantt webview: toolbar, accessible task tree (left) and the SVG timeline (right).
import { type RefObject } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { type GanttLink, type GanttModel, type GanttRow } from "../../core/views/gantt";
import {
  DEFAULT_GANTT_OPTIONS,
  type GanttToHost,
  type GanttViewOptions,
  type GanttZoom,
  type HostToGantt,
} from "../shared/protocol";
import { Notice, noticeFrom, Tooltip, UndoRedo } from "../shared/ui";
import { getState, isoDate, onMessage, post, setState } from "../shared/vscode";
import { Chart, type DragResult, ROW_H } from "./Chart";
import { EditDialog } from "./EditDialog";
import { type EditResult } from "./editFields";
import {
  describeFocus,
  editTarget,
  type EditTarget,
  linkFocus,
  moveBase,
  stepWorkingDays,
  visibleRows,
  vscodeContext,
} from "./rows";
import { dayToX, fitPx, headerTicks, makeScale, type Scale, ZOOM_PX, ZoomGesture } from "./scale";

const LEFT_W = 320;

interface Persisted {
  collapsed: string[];
}

/**
 * Where to scroll once the chart is drawn: to today when it opens, and to a task asked for with
 * "Open in Gantt". A new object per request, so the same task asked for again is shown again.
 */
interface PendingScroll {
  today?: boolean;
  key?: string;
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
  const [editing, setEditing] = useState<EditTarget | undefined>();
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [notice, setNotice] = useState<
    { level: "info" | "error"; message: string; at: number; undo?: number } | undefined
  >();
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const tooltip = useMemo(() => new Tooltip(), []);
  const [pendingScroll, setPendingScroll] = useState<PendingScroll | undefined>({ today: true });
  // A pinch zoom (see below): the gesture, its next frame, and its save once the gesture pauses.
  const gesture = useMemo(() => new ZoomGesture(LEFT_W), []);
  const pinch = useRef<{ frame: number; save?: number }>({ frame: 0 });
  const opened = useRef(false);

  useEffect(() => {
    const off = onMessage<HostToGantt>((m) => {
      switch (m.type) {
        case "model": {
          // The zoom comes from the host when the chart opens; after that it changes only here (the
          // host stores it). A later model can have left the host before the latest zoom reached
          // it, and a pinch is sent only once it pauses, so the zoom shown stays.
          const keepZoom = opened.current;
          opened.current = true;
          setModel(m.model);
          setOptions((shown) =>
            keepZoom ? { ...m.options, zoom: shown.zoom, pxPerDay: shown.pxPerDay } : m.options
          );
          setBaselines(m.baselines);
          break;
        }
        case "focus":
          setPendingScroll((p) => ({ ...p, key: m.key }));
          setSelected(m.key);
          break;
        case "history":
          setHistory({ canUndo: m.canUndo, canRedo: m.canRedo });
          break;
        case "notice":
          setNotice(noticeFrom(m));
          break;
      }
    });
    send({ type: "ready" });
    return off;
  }, []);

  useEffect(() => setState<Persisted>({ collapsed: [...collapsed] }), [collapsed]);

  // An edit dialog whose task changed meanwhile (in the editor, by an agent) closes, and says so.
  useEffect(() => {
    if (!model || !editing) return;
    const target = editTarget(model.rows, editing);
    if ("closed" in target) {
      setEditing(undefined);
      setNotice({ level: "info", message: target.closed, at: Date.now() });
    }
  }, [model]);

  const rows = useMemo(() => (model ? visibleRows(model.rows, collapsed) : []), [model, collapsed]);
  const focus = useMemo(() => {
    const shown = new Set(rows.map((r) => r.key));
    const links = (model?.links ?? []).filter((l) => shown.has(l.from) && shown.has(l.to));
    return linkFocus(links, selected, selectedLink);
  }, [model, rows, selected, selectedLink]);
  const scale = useMemo(() => {
    if (!model) return makeScale(0, 30, ZOOM_PX.week);
    return makeScale(model.start, model.end, options.pxPerDay ?? ZOOM_PX[options.zoom]);
  }, [model, options.zoom, options.pxPerDay]);

  // Scroll today and a focused task (from "Open in Gantt") into view.
  useEffect(() => {
    if (!model || !scroller.current || !pendingScroll) return;
    const { today, key } = pendingScroll;
    if (key !== undefined) {
      // Expand ancestors of the focused row; this runs again with the new rows.
      const byKey = new Map(model.rows.map((r) => [r.key, r]));
      const open = new Set(collapsed);
      let changed = false;
      for (let p = byKey.get(key)?.parent; p; p = byKey.get(p)?.parent)
        if (open.delete(p)) changed = true;
      if (changed) {
        setCollapsed(open);
        return;
      }
    }
    // Done with this request only: a task asked for while the chart was opening is shown next.
    setPendingScroll((p) => (p === pendingScroll ? undefined : p));
    if (today) scrollToToday();
    if (key !== undefined) scrollToRow(key);
  }, [model, rows, pendingScroll]);

  const updateOptions = (patch: Partial<GanttViewOptions>) => {
    // The toolbar takes over from a pinch: a frame not drawn yet is dropped, and these options
    // carry the zoom shown, so it needs no save of its own.
    cancelAnimationFrame(pinch.current.frame);
    clearTimeout(pinch.current.save);
    pinch.current = { frame: 0 };
    gesture.end();
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

  // Pinch on a trackpad (Chromium reports it as Ctrl + wheel) or Ctrl/Cmd + mouse wheel zooms the
  // timeline around the pointer; plain wheel and swipes keep scrolling. One render per frame; the
  // zoom is saved once the gesture pauses.
  const live = useRef<{ scale: Scale; options: GanttViewOptions }>({ scale, options });
  live.current = { scale, options };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const pointerX = Math.max(LEFT_W, e.clientX - el.getBoundingClientRect().left);
      gesture.wheel(live.current.scale, el.scrollLeft, pointerX, e.deltaY, e.deltaMode);
      if (pinch.current.frame) return;
      pinch.current.frame = requestAnimationFrame(() => {
        pinch.current.frame = 0;
        // Nothing to draw at a zoom limit: the gesture is over.
        const px = gesture.frame(live.current.scale);
        if (px === undefined) return;
        setOptions((shown) => ({ ...shown, pxPerDay: px }));
        clearTimeout(pinch.current.save);
        // Sends the options as they are by then, so a change made in the meantime is kept.
        pinch.current.save = window.setTimeout(() => {
          pinch.current.save = undefined;
          send({ type: "options", options: live.current.options });
        }, 400);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [model !== undefined]);
  // After the zoomed chart is laid out, scroll so the same day is under the pointer again. More
  // wheel events already waiting for the next frame keep zooming around the same day.
  useLayoutEffect(() => {
    const left = gesture.scrollLeft(scale, pinch.current.frame !== 0);
    if (left !== undefined && scroller.current) scroller.current.scrollLeft = left;
  }, [scale]);

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

  const startEdit = (row: GanttRow | undefined) => {
    if (row?.editable) setEditing({ key: row.key, title: row.title });
  };

  // With the title it opened with: the host refuses the edit when the task is no longer that one.
  const onEditSave = (target: EditTarget, result: EditResult) => {
    setEditing(undefined);
    if (Object.keys(result).length)
      send({ type: "edit", key: target.key, original: target.title, ...result });
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
      // A task in progress moves from where its remaining work starts (see moveBase).
      const base = moveBase(row);
      if (e.shiftKey && row.finish !== undefined) {
        const finish = stepWorkingDays(model, row.finish, dir);
        if (row.start === undefined || finish >= row.start)
          send({ type: "resize", key: row.key, finish: isoDate(finish) });
      } else if (!e.shiftKey && base !== undefined) {
        send({ type: "move", key: row.key, start: isoDate(stepWorkingDays(model, base, dir)) });
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
      startEdit(row);
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
    } else if (e.key === "Escape" && !editing && (selectedLink || focus.links.size > 0)) {
      // Back to every dependency line at full strength.
      e.preventDefault();
      setSelectedLink(undefined);
      setSelected(undefined);
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", onGlobalKey);
    return () => window.removeEventListener("keydown", onGlobalKey);
  });

  if (!model) return <div class="empty">Loading the schedule…</div>;
  const focusText = describeFocus(model, focus, selected, selectedLink);
  const ticks = headerTicks(scale);
  const target = editing && editTarget(model.rows, editing);
  const editRow = target && "row" in target ? target.row : undefined;
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
        <label title="Schedule: tasks in the order they start, so the chart reads as a cascade. Files: as written in the plan files.">
          Order
          <select
            value={options.order}
            onChange={(e) =>
              updateOptions({ order: e.currentTarget.value as GanttViewOptions["order"] })
            }
          >
            <option value="schedule">Schedule</option>
            <option value="file">Files</option>
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
        <FitButton
          model={model}
          scroller={scroller}
          pxPerDay={options.pxPerDay}
          onFit={(px) => {
            updateOptions({ pxPerDay: px });
            if (scroller.current) scroller.current.scrollLeft = 0;
          }}
        />
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
                  linked={focus.rows.has(r.key)}
                  collapsed={collapsed.has(r.key)}
                  onToggle={() => toggle(r.key)}
                  onSelect={() => select(r.key, false)}
                  onOpen={() => r.task && send({ type: "reveal", key: r.task })}
                  onEdit={() => startEdit(r)}
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
              focus={focus}
              tooltip={tooltip}
              onSelect={select}
              onEdit={(key) => startEdit(model.rows.find((r) => r.key === key))}
              onDrag={onDrag}
              onSelectLink={(l) => {
                // A click on a line selects it; a click on empty space clears both selections.
                setSelectedLink(l);
                setSelected(undefined);
              }}
            />
          </div>
        </div>
      </div>
      <div class={`statusline${focusText ? " focus" : " muted"}`} aria-live="polite">
        {focusText ?? (
          <>
            Drag a bar to move it (@start), drag its end to resize (@est), drag the dot to another
            bar to add a dependency. Click a bar or an arrow to highlight its dependencies.
            Double-click or F2 to edit, right-click for all actions; Alt+←/→ moves, Shift+Alt+←/→
            resizes; pinch or Ctrl/Cmd+scroll zooms.
            {model.rows.some((r) => r.overtime) &&
              " Orange marks above a bar: overtime or extra working days (hover for the hours)."}
          </>
        )}
      </div>
      {editing && editRow && (
        // Keyed by the task: a dialog opened on another task starts from that task's values.
        <EditDialog
          key={editing.key}
          row={editRow}
          model={model}
          onSave={(r) => onEditSave(editing, r)}
          onCancel={() => setEditing(undefined)}
          onAllFields={() => {
            setEditing(undefined);
            if (editRow.task) send({ type: "editAll", key: editRow.task });
          }}
        />
      )}
      {/* The Undo button undoes the edit the notice reports, and no other. */}
      <Notice notice={notice} onUndo={(entry) => send({ type: "undo", entry })} />
    </>
  );
}

/**
 * Fit: the pixels per day that show the whole project in the width the chart has now. It follows
 * the panel's width on its own, so resizing the panel re-renders this button only.
 */
function FitButton({
  model,
  scroller,
  pxPerDay,
  onFit,
}: {
  model: GanttModel;
  scroller: RefObject<HTMLDivElement | null>;
  pxPerDay: number | undefined;
  onFit: (px: number) => void;
}) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      // A hidden panel measures 0: keep the last width.
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Pixels per day that show the whole project (a pinch zoom presses none of the zoom buttons).
  const fit = fitPx(model.start, model.end, (width || 1200) - LEFT_W - 20);
  return (
    <button
      class="btn"
      title="Fit the whole project"
      aria-pressed={pxPerDay !== undefined && Math.abs(pxPerDay - fit) < 0.01}
      onClick={() => onFit(fit)}
    >
      <span class="codicon codicon-screen-full" /> Fit
    </button>
  );
}

function ListRow({
  row,
  selected,
  linked,
  collapsed,
  focusable,
  onToggle,
  onSelect,
  onOpen,
  onEdit,
}: {
  row: GanttRow;
  selected: boolean;
  /** At the other end of a highlighted dependency line. */
  linked: boolean;
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
      class={`list-row ${row.kind}${selected ? " selected" : ""}${linked ? " linked" : ""}${row.status ? ` status-${row.status}` : ""}`}
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
