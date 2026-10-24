// SVG timeline of the Gantt chart. The static layer (grid, bars, links) is memoized; dragging only
// re-renders the overlay.
import { type JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import { isoWeekday } from "../../core/dates";
import { type GanttLink, type GanttModel, type GanttRow } from "../../core/views/gantt";
import { type GanttViewOptions } from "../shared/protocol";
import { type Tooltip } from "../shared/ui";
import {
  dayLabel,
  dragPreview,
  type LinkFocus,
  linkId,
  linkTargetAt,
  resizeHandleWidth,
  type RoutedLink,
  routeLinks,
  rowColor,
  vscodeContext,
} from "./rows";
import { dayToX, gridLines, type Scale } from "./scale";

export const ROW_H = 26;
const BAR_H = 14;
const BAR_Y = (ROW_H - BAR_H) / 2;
/** Pixels the pointer must travel before a press becomes a drag (a click may wobble). */
const DRAG_THRESHOLD = 6;

export type DragResult =
  | { kind: "move"; key: string; start: number }
  | { kind: "resize"; key: string; finish: number }
  | { kind: "link"; from: string; to: string };

interface Drag {
  kind: "move" | "resize" | "link";
  key: string;
  row: GanttRow;
  originX: number;
  originY: number;
  x: number;
  y: number;
  moved: boolean;
}

interface ChartProps {
  model: GanttModel;
  rows: GanttRow[];
  scale: Scale;
  options: GanttViewOptions;
  selected?: string;
  selectedLink?: GanttLink;
  /** Lines to bring forward (the rest fade) and the bars at their other ends. */
  focus: LinkFocus;
  tooltip: Tooltip;
  onSelect: (key: string, reveal: boolean) => void;
  onEdit: (key: string) => void;
  onDrag: (r: DragResult) => void;
  onSelectLink: (l: GanttLink | undefined) => void;
}

export function Chart(props: ChartProps) {
  const { model, rows, scale, options, tooltip } = props;
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | undefined>();
  const height = Math.max(rows.length * ROW_H, 40);
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);

  const routed = useMemo(
    () => routeLinks(model.links, rows, scale, ROW_H),
    [model.links, rows, scale]
  );
  const staticLayer = useMemo(
    () => renderStatic(model, rows, scale, options, height, routed),
    [model, rows, scale, options, height, routed]
  );
  const focused = routed.filter((r) => props.focus.links.has(linkId(r.link)));

  const linkTarget = (d: Drag) => linkTargetAt(rows, scale, d.key, d.x, d.y, ROW_H);

  const local = (e: PointerEvent | MouseEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const linkEl = target.closest("[data-link]");
    if (linkEl) {
      const [from, to] = linkEl.getAttribute("data-link")!.split("→");
      tooltip.hide(); // the help line says what the selected line means
      props.onSelectLink(model.links.find((l) => l.from === from && l.to === to));
      return;
    }
    const barEl = target.closest("[data-key]");
    if (!barEl) {
      props.onSelectLink(undefined);
      return;
    }
    const key = barEl.getAttribute("data-key")!;
    const row = rows[rowIndex.get(key) ?? -1];
    if (!row) return;
    const kind = target.closest(".link-handle")
      ? "link"
      : target.closest(".resize-handle")
        ? "resize"
        : "move";
    const p = local(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ kind, key, row, originX: p.x, originY: p.y, x: p.x, y: p.y, moved: false });
    tooltip.hide();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    const p = local(e);
    const moved =
      drag.moved ||
      Math.abs(p.x - drag.originX) > DRAG_THRESHOLD ||
      Math.abs(p.y - drag.originY) > DRAG_THRESHOLD;
    setDrag({ ...drag, x: p.x, y: p.y, moved });
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(undefined);
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (!d.moved) {
      props.onSelect(d.key, true);
      return;
    }
    const days = Math.round((d.x - d.originX) / scale.px);
    if (d.kind === "move" && d.row.editable && d.row.start !== undefined && days !== 0) {
      props.onDrag({ kind: "move", key: d.key, start: d.row.start + days });
    } else if (d.kind === "resize" && d.row.editable && d.row.finish !== undefined && days !== 0) {
      const finish = Math.max(d.row.start ?? d.row.finish, d.row.finish + days);
      props.onDrag({ kind: "resize", key: d.key, finish });
    } else if (d.kind === "link") {
      // Only a drop on a bar links: releasing anywhere else in a row does nothing.
      const target = linkTarget(d);
      if (target) props.onDrag({ kind: "link", from: d.key, to: target.key });
    }
  };

  const onPointerOver = (e: PointerEvent) => {
    if (drag) return;
    const linkEl = (e.target as Element).closest("[data-link]");
    if (linkEl) {
      const [from, to] = linkEl.getAttribute("data-link")!.split("→");
      // The selected line is described in the help line already.
      if (props.selectedLink && linkId(props.selectedLink) === `${from}→${to}`) {
        tooltip.hide();
        return;
      }
      tooltip.show(
        linkTooltip(rows[rowIndex.get(from) ?? -1], rows[rowIndex.get(to) ?? -1]),
        e.clientX,
        e.clientY
      );
      return;
    }
    const barEl = (e.target as Element).closest("[data-key]");
    if (!barEl) {
      tooltip.hide();
      return;
    }
    const row = rows[rowIndex.get(barEl.getAttribute("data-key")!) ?? -1];
    if (row) tooltip.show(row.tooltip, e.clientX, e.clientY);
  };

  return (
    <svg
      ref={svg}
      class={`chart${drag ? ` dragging ${drag.kind}` : ""}${focused.length ? " focus" : ""}`}
      width={scale.width}
      height={height}
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        onPointerMove(e);
        if (!drag) tooltip.move(e.clientX, e.clientY);
      }}
      onPointerUp={onPointerUp}
      onPointerOver={onPointerOver}
      onPointerLeave={() => tooltip.hide()}
      onDblClick={(e) => {
        const barEl = (e.target as Element).closest("[data-key]");
        if (barEl) props.onEdit(barEl.getAttribute("data-key")!);
      }}
    >
      {staticLayer}
      {props.selected !== undefined && rowIndex.has(props.selected) && (
        <rect
          class="selected-row"
          x={0}
          y={rowIndex.get(props.selected)! * ROW_H}
          width={scale.width}
          height={ROW_H}
        />
      )}
      {focused.length > 0 && (
        <FocusLayer
          focused={focused}
          rows={rows}
          rowIndex={rowIndex}
          scale={scale}
          focus={props.focus}
          selectedLink={props.selectedLink}
        />
      )}
      {drag && drag.moved && (
        <DragOverlay
          drag={drag}
          model={model}
          scale={scale}
          rowIndex={rowIndex}
          target={drag.kind === "link" ? linkTarget(drag) : undefined}
        />
      )}
    </svg>
  );
}

/** "T416 Draft test plan waits for T491 Review FS" */
function linkTooltip(from: GanttRow | undefined, to: GanttRow | undefined): string[] {
  const name = (r: GanttRow | undefined) => (r ? (r.id ? `${r.id} ${r.title}` : r.title) : "?");
  return [`${name(to)}`, `waits for ${name(from)}`, "Click to highlight it, Delete to remove it"];
}

/**
 * The highlighted lines drawn again above the bars, so they can be followed all the way, and an
 * outline around the bars at their other ends.
 */
function FocusLayer({
  focused,
  rows,
  rowIndex,
  scale,
  focus,
  selectedLink,
}: {
  focused: RoutedLink[];
  rows: GanttRow[];
  rowIndex: Map<string, number>;
  scale: Scale;
  focus: LinkFocus;
  selectedLink?: GanttLink;
}) {
  const ends = [...focus.rows]
    .map((key) => rows[rowIndex.get(key) ?? -1])
    .filter((r) => r?.start !== undefined && r.finish !== undefined);
  return (
    <g class="focus-layer">
      {ends.map((r) => {
        const x = dayToX(scale, r.start!);
        const w = Math.max(scale.px * 0.6, dayToX(scale, r.finish! + 1) - x);
        return (
          <rect
            class="link-end"
            x={x - 3}
            y={rowIndex.get(r.key)! * ROW_H + 2}
            width={w + 6}
            height={ROW_H - 4}
            rx={4}
          />
        );
      })}
      <g class="links focused">
        {focused.map(({ link, d }) => (
          <g
            class={`link highlight${selectedLink && linkId(selectedLink) === linkId(link) ? " selected" : ""}`}
            data-link={linkId(link)}
          >
            <path class="link-hit" d={d} />
            <path class="link-line" d={d} marker-end="url(#arrow-focus)" />
          </g>
        ))}
      </g>
    </g>
  );
}

function DragOverlay({
  drag,
  model,
  scale,
  rowIndex,
  target,
}: {
  drag: Drag;
  model: GanttModel;
  scale: Scale;
  rowIndex: Map<string, number>;
  /** Link drags: the bar under the pointer that would get the dependency. */
  target?: GanttRow;
}) {
  const row = drag.row;
  const y = (rowIndex.get(drag.key) ?? 0) * ROW_H;
  if (drag.kind === "link") {
    const x1 = dayToX(scale, (row.finish ?? row.start ?? 0) + 1);
    const name = (r: GanttRow) =>
      r.id ?? (r.title.length > 30 ? `${r.title.slice(0, 29)}…` : r.title);
    const ty = target ? (rowIndex.get(target.key) ?? 0) * ROW_H : 0;
    const tx = target ? dayToX(scale, target.start!) : 0;
    const tw = target ? dayToX(scale, target.finish! + 1) - tx : 0;
    return (
      <g class="drag-overlay">
        {target && (
          <rect
            class="link-target"
            x={tx - 3}
            y={ty + 2}
            width={tw + 6}
            height={ROW_H - 4}
            rx={4}
          />
        )}
        <line
          class={`link-ghost${target ? " valid" : ""}`}
          x1={x1}
          y1={y + ROW_H / 2}
          x2={drag.x}
          y2={drag.y}
        />
        <circle class="link-ghost-end" cx={drag.x} cy={drag.y} r={4} />
        <text class="ghost-label" x={drag.x + 10} y={drag.y - 8}>
          {target ? `${name(target)} waits for ${name(row)}` : "Drop on a bar to add a dependency"}
        </text>
      </g>
    );
  }
  if (row.start === undefined || row.finish === undefined) return null;
  const days = Math.round((drag.x - drag.originX) / scale.px);
  const { start, finish } = dragPreview(
    model,
    { start: row.start, finish: row.finish },
    drag.kind,
    days
  );
  const x = dayToX(scale, start);
  const w = Math.max(scale.px, dayToX(scale, finish + 1) - x);
  return (
    <g class="drag-overlay">
      <rect class="bar-ghost" x={x} y={y + BAR_Y - 2} width={w} height={BAR_H + 4} rx={3} />
      <text class="ghost-label" x={x + w + 6} y={y + ROW_H / 2 + 4}>
        {dayLabel(start)} → {dayLabel(finish)}
      </text>
    </g>
  );
}

function renderStatic(
  model: GanttModel,
  rows: GanttRow[],
  scale: Scale,
  options: GanttViewOptions,
  height: number,
  routed: RoutedLink[]
): JSX.Element {
  const holidays = new Set(model.holidays);
  const shading: JSX.Element[] = [];
  if (scale.px >= 6) {
    for (let d = scale.start; d < scale.start + scale.days; d++) {
      if (!model.workweek.includes(isoWeekday(d)) || holidays.has(d)) {
        shading.push(
          <rect
            class={holidays.has(d) ? "holiday" : "weekend"}
            x={dayToX(scale, d)}
            y={0}
            width={scale.px}
            height={height}
          />
        );
      }
    }
  }
  const grid = gridLines(scale).map((x) => <line class="grid" x1={x} y1={0} x2={x} y2={height} />);
  const stripes = rows.map((r, i) =>
    r.kind === "milestone" || r.kind === "group" ? (
      <rect class={`stripe ${r.kind}`} x={0} y={i * ROW_H} width={scale.width} height={ROW_H} />
    ) : null
  );
  const todayX = dayToX(scale, model.today);

  const bars = rows.map((r, i) => renderRow(r, i, scale, options));

  const links = routed.map(({ link: l, d }) => {
    const critical = options.showCritical && l.critical;
    return (
      <g class={`link${critical ? " critical" : ""}`} data-link={linkId(l)}>
        <path class="link-hit" d={d} />
        <path
          class="link-line"
          d={d}
          marker-end={critical ? "url(#arrow-critical)" : "url(#arrow)"}
        />
      </g>
    );
  });

  return (
    <g>
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path class="arrow-head" d="M0,0 L8,4 L0,8 z" />
        </marker>
        <marker
          id="arrow-critical"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path class="arrow-head critical" d="M0,0 L8,4 L0,8 z" />
        </marker>
        <marker
          id="arrow-focus"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path class="arrow-head focus" d="M0,0 L8,4 L0,8 z" />
        </marker>
      </defs>
      {stripes}
      {shading}
      {grid}
      <line class="today" x1={todayX} y1={0} x2={todayX} y2={height} />
      <g class="links">{links}</g>
      <g class="bars">{bars}</g>
    </g>
  );
}

function renderRow(
  r: GanttRow,
  i: number,
  scale: Scale,
  options: GanttViewOptions
): JSX.Element | null {
  const y = i * ROW_H;
  const color = rowColor(r, options.color);
  const parts: JSX.Element[] = [];
  const hasBar = r.start !== undefined && r.finish !== undefined;
  const x = hasBar ? dayToX(scale, r.start!) : 0;
  const w = hasBar ? Math.max(scale.px * 0.6, dayToX(scale, r.finish! + 1) - x) : 0;

  if (options.showBaseline && r.baselineStart !== undefined && r.baselineFinish !== undefined) {
    const bx = dayToX(scale, r.baselineStart);
    const bw = Math.max(2, dayToX(scale, r.baselineFinish + 1) - bx);
    parts.push(<rect class="baseline" x={bx} y={y + ROW_H - 6} width={bw} height={3} />);
  }

  if (r.kind === "task") {
    if (hasBar) {
      const critical = options.showCritical && r.critical;
      const done = r.status === "done";
      parts.push(
        <rect
          class={`bar task${critical ? " critical" : ""}${done ? " done" : ""}${r.late ? " late" : ""}${r.status === "blocked" ? " blocked" : ""}`}
          x={x}
          y={y + BAR_Y}
          width={w}
          height={BAR_H}
          rx={3}
          style={{ fill: color }}
        />
      );
      if (r.progress > 0 && !done) {
        parts.push(
          <rect
            class="progress"
            x={x}
            y={y + BAR_Y}
            width={w * Math.min(1, r.progress)}
            height={BAR_H}
            rx={3}
          />
        );
      }
      parts.push(...overtimeMarks(r, scale, y + BAR_Y - 4));
      if (r.editable) {
        // The resize handle covers at most a third of the bar, and very short bars have none, so a
        // drag meant to move a short bar does not change its estimate.
        const hw = resizeHandleWidth(w);
        if (hw > 0) {
          parts.push(
            <rect
              class="resize-handle"
              x={x + w - hw}
              y={y + BAR_Y}
              width={hw + 3}
              height={BAR_H}
            />
          );
        }
        parts.push(<circle class="link-handle" cx={x + w + 8} cy={y + ROW_H / 2} r={4} />);
      }
      if (scale.px * (r.finish! - r.start! + 1) > 60 && r.ownerInitials) {
        parts.push(
          <text class="bar-label" x={x + 4} y={y + ROW_H / 2 + 4}>
            {r.ownerInitials}
          </text>
        );
      }
    } else if (r.unscheduled) {
      parts.push(
        <text class="unscheduled" x={4} y={y + ROW_H / 2 + 4}>
          not scheduled
        </text>
      );
    }
    if (options.showBaseline && r.slip !== undefined && r.slip > 0 && hasBar) {
      parts.push(
        <text class="slip" x={x + w + 16} y={y + ROW_H / 2 + 4}>
          +{r.slip}d
        </text>
      );
    }
    if (r.deadline !== undefined && r.late) {
      const dx = dayToX(scale, r.deadline + 1);
      parts.push(<line class="deadline" x1={dx} y1={y + 3} x2={dx} y2={y + ROW_H - 3} />);
    }
  } else if (hasBar) {
    // Roll-up bar for parents, sections, groups and milestones.
    parts.push(
      <rect
        class={`rollup ${r.kind}`}
        x={x}
        y={y + ROW_H / 2 - 3}
        width={w}
        height={6}
        style={{ fill: color }}
      />
    );
    parts.push(
      <path
        class={`rollup-cap ${r.kind}`}
        d={`M${x},${y + ROW_H / 2 - 3} v10 l5,-4 z M${x + w},${y + ROW_H / 2 - 3} v10 l-5,-4 z`}
        style={{ fill: color }}
      />
    );
    if (r.progress > 0)
      parts.push(
        <rect
          class="rollup-progress"
          x={x}
          y={y + ROW_H / 2 - 3}
          width={w * Math.min(1, r.progress)}
          height={6}
        />
      );
    parts.push(...overtimeMarks(r, scale, y + ROW_H / 2 - 8));
  }

  // A pin on the fixed start (`@start`): the scheduler never places the task earlier.
  if (r.task && r.fixedStart !== undefined && hasBar) {
    const px = dayToX(scale, r.fixedStart);
    parts.push(<path class="pin" d={`M${px - 4},${y} h8 l-4,5 z`} />);
  }

  if (r.kind === "milestone") {
    if (r.target !== undefined) {
      const tx = dayToX(scale, r.target) + scale.px / 2;
      parts.push(
        <path class={`diamond${r.late ? " late" : ""}`} d={diamond(tx, y + ROW_H / 2, 7)} />
      );
    }
    if (r.late && r.finish !== undefined && r.target !== undefined) {
      const fx = dayToX(scale, r.finish) + scale.px / 2;
      const tx = dayToX(scale, r.target) + scale.px / 2;
      parts.push(
        <line class="slip-line" x1={tx + 7} y1={y + ROW_H / 2} x2={fx - 6} y2={y + ROW_H / 2} />
      );
      parts.push(<path class="diamond forecast" d={diamond(fx, y + ROW_H / 2, 6)} />);
    }
    if (options.showBaseline && r.slip !== undefined && r.slip > 0 && hasBar) {
      parts.push(
        <text class="slip" x={x + w + 12} y={y + ROW_H / 2 + 4}>
          +{r.slip}d
        </text>
      );
    }
  }
  if (parts.length === 0) return null;
  return (
    <g class={`row ${r.kind}`} data-key={r.key} data-vscode-context={vscodeContext(r)}>
      {parts}
    </g>
  );
}

/** Orange marks above a bar on the days with overtime or extra working days. */
function overtimeMarks(r: GanttRow, scale: Scale, top: number): JSX.Element[] {
  return (r.overtimeDays ?? []).map((d) => {
    const x = dayToX(scale, d);
    return (
      <rect
        class="overtime"
        x={x}
        y={top}
        width={Math.max(2, dayToX(scale, d + 1) - x - 1)}
        height={4}
      />
    );
  });
}

function diamond(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} z`;
}
