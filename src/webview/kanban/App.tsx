// Kanban webview: task and punch-list boards with swimlanes, WIP limits and sidebar filters.
// SortableJS handles dragging; the DOM move is reverted and the host's new model re-renders the
// board, so the Markdown files stay the single source of truth.
import Sortable from "sortablejs";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type TaskFilter } from "../../core/filter";
import { type Priority, type Status } from "../../core/model";
import { type KanbanCard, type KanbanModel } from "../../core/views/kanban";
import {
  DEFAULT_KANBAN_OPTIONS,
  type HostToKanban,
  type KanbanToHost,
  type KanbanViewOptions,
} from "../shared/protocol";
import { Notice, UndoRedo, useReturnFocus } from "../shared/ui";
import { onMessage, post } from "../shared/vscode";
import { asksBlockedReason } from "./moves";

const send = (m: KanbanToHost) => post(m);
const PRIOS: Priority[] = ["high", "med", "low"];

interface PendingBlock {
  move: Extract<KanbanToHost, { type: "move" }>;
  title: string;
}

export function App() {
  const [model, setModel] = useState<KanbanModel | undefined>();
  const [options, setOptions] = useState<KanbanViewOptions>(DEFAULT_KANBAN_OPTIONS);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [notice, setNotice] = useState<
    { level: "info" | "error"; message: string; at: number } | undefined
  >();
  const [blocking, setBlocking] = useState<PendingBlock | undefined>();
  const [focusKey, setFocusKey] = useState<string | undefined>();

  useEffect(() => {
    const off = onMessage<HostToKanban>((m) => {
      if (m.type === "model") {
        setModel(m.model);
        setOptions(m.options);
      } else if (m.type === "history") setHistory({ canUndo: m.canUndo, canRedo: m.canRedo });
      else if (m.type === "notice")
        setNotice({ level: m.level, message: m.message, at: Date.now() });
      else if (m.type === "focus") setFocusKey(m.key);
    });
    send({ type: "ready" });
    return off;
  }, []);

  useEffect(() => {
    if (!focusKey) return;
    const el = document.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      setFocusKey(undefined);
    }
  }, [focusKey, model]);

  const updateOptions = (patch: Partial<KanbanViewOptions>) => {
    const next = { ...options, ...patch };
    if (patch.board === "punch" && next.swimlane === "milestone") next.swimlane = "severity";
    if (patch.board === "tasks" && next.swimlane === "severity") next.swimlane = "none";
    setOptions(next);
    send({ type: "options", options: next });
  };

  const setFilter = (patch: Partial<TaskFilter>) => {
    if (!model) return;
    send({ type: "filter", filter: { ...model.filter, ...patch } });
  };

  const cardsByKey = useMemo(() => {
    const map = new Map<string, KanbanCard>();
    for (const l of model?.lanes ?? [])
      for (const list of Object.values(l.cards)) for (const c of list ?? []) map.set(c.key, c);
    return map;
  }, [model]);

  const requestMove = (move: Extract<KanbanToHost, { type: "move" }>, title: string) => {
    if (asksBlockedReason(options.board, cardsByKey.get(move.key)?.status, move.status))
      setBlocking({ move, title });
    else send(move);
  };

  if (!model) return <div class="empty">Loading the board…</div>;
  const f = model.filter;
  const columns = model.columns;
  const swimlanes =
    options.board === "punch" ? ["none", "severity", "owner"] : ["none", "owner", "milestone"];

  return (
    <>
      <div class="toolbar" role="toolbar" aria-label="Board options">
        <span class="title">{model.projectName}</span>
        <span role="group" aria-label="Board">
          <button
            class="btn"
            aria-pressed={options.board === "tasks"}
            onClick={() => updateOptions({ board: "tasks" })}
          >
            Tasks
          </button>
          <button
            class="btn"
            aria-pressed={options.board === "punch"}
            onClick={() => updateOptions({ board: "punch" })}
          >
            Punch list
          </button>
        </span>
        <label>
          Swimlanes
          <select
            value={options.swimlane}
            onChange={(e) =>
              updateOptions({ swimlane: e.currentTarget.value as KanbanViewOptions["swimlane"] })
            }
          >
            {swimlanes.map((s) => (
              <option value={s}>{s === "none" ? "None" : s[0].toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
        </label>
        {options.board === "tasks" && (
          <label>
            Cards
            <select
              value={options.cardMode}
              onChange={(e) =>
                updateOptions({ cardMode: e.currentTarget.value as KanbanViewOptions["cardMode"] })
              }
            >
              <option value="tasks">Tasks (with subtasks)</option>
              <option value="leaves">Every subtask</option>
            </select>
          </label>
        )}
        <button
          class="btn"
          aria-pressed={options.showCancelled}
          onClick={() => updateOptions({ showCancelled: !options.showCancelled })}
        >
          Cancelled
        </button>
        <span class="filters" role="group" aria-label="Filters">
          <select
            aria-label="Owner filter"
            value={f.owner?.[0] ?? ""}
            onChange={(e) =>
              setFilter({ owner: e.currentTarget.value ? [e.currentTarget.value] : undefined })
            }
          >
            <option value="">All owners</option>
            {model.people.map((p) => (
              <option value={p.id}>{p.name}</option>
            ))}
            <option value="unassigned">Unassigned</option>
          </select>
          <select
            aria-label="Tag filter"
            value={f.tag?.[0] ?? ""}
            onChange={(e) =>
              setFilter({ tag: e.currentTarget.value ? [e.currentTarget.value] : undefined })
            }
          >
            <option value="">All tags</option>
            {model.tags.map((t) => (
              <option value={t}>#{t}</option>
            ))}
          </select>
          {options.board === "tasks" && (
            <select
              aria-label="Milestone filter"
              value={f.milestone?.[0] ?? ""}
              onChange={(e) =>
                setFilter({
                  milestone: e.currentTarget.value ? [e.currentTarget.value] : undefined,
                })
              }
            >
              <option value="">All milestones</option>
              {model.milestones.map((m) => (
                <option value={m.id}>{m.title}</option>
              ))}
            </select>
          )}
          <input
            type="search"
            aria-label="Text filter"
            placeholder="Filter text"
            value={f.text ?? ""}
            onChange={(e) => setFilter({ text: e.currentTarget.value || undefined })}
          />
          {(f.owner?.length ||
            f.tag?.length ||
            f.milestone?.length ||
            f.text ||
            f.status?.length) && (
            <button
              class="icon-btn"
              title="Clear filter"
              aria-label="Clear filter"
              onClick={() => send({ type: "filter", filter: {} })}
            >
              <span class="codicon codicon-clear-all" />
            </button>
          )}
        </span>
        <span class="spacer" />
        <span class="muted">
          {model.total - model.hidden} of {model.total} cards
        </span>
        <UndoRedo
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onUndo={() => send({ type: "undo" })}
          onRedo={() => send({ type: "redo" })}
        />
      </div>
      <div
        class="board"
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(220px, 1fr))` }}
      >
        {columns.map((c) => (
          <div class={`column-header${c.over ? " over" : ""}`}>
            <span class={`status-dot status-${c.status}`} />
            <span class="column-title" role="heading" aria-level={2}>
              {c.title}
            </span>
            <span
              class="column-count"
              title={c.wip !== undefined ? `WIP limit ${c.wip}` : undefined}
            >
              {c.wip !== undefined ? `${c.count}/${c.wip}` : c.count}
            </span>
            <button
              class="icon-btn column-add"
              title={`Add a ${options.board === "punch" ? "punch item" : "task"} to ${c.title}`}
              aria-label={`Add a ${options.board === "punch" ? "punch item" : "task"} to ${c.title}`}
              onClick={() => send({ type: "add", status: c.status })}
            >
              <span class="codicon codicon-add" />
            </button>
          </div>
        ))}
        {model.lanes.map((lane) => (
          <>
            {options.swimlane !== "none" && (
              <div class="lane-header" style={{ gridColumn: `1 / span ${columns.length}` }}>
                {lane.title}
                <span class="muted">
                  {" "}
                  · {Object.values(lane.cards).reduce((n, l) => n + (l?.length ?? 0), 0)}
                </span>
              </div>
            )}
            {columns.map((c, ci) => (
              <CardList
                lane={lane.key}
                status={c.status}
                cards={lane.cards[c.status] ?? []}
                board={options.board}
                today={model.today}
                onDrop={(move) => {
                  const card = cardsByKey.get(move.key);
                  requestMove(move, card?.title ?? move.key);
                }}
                onKeyMove={(card, dir) => {
                  const target = columns[ci + dir];
                  if (target)
                    requestMove(
                      { type: "move", key: card.key, status: target.status, lane: lane.key },
                      card.title
                    );
                }}
                onPriority={(card, dir) => {
                  const i = PRIOS.indexOf(card.prio) + dir;
                  if (i >= 0 && i < PRIOS.length)
                    send({ type: "priority", key: card.key, prio: PRIOS[i] });
                }}
              />
            ))}
          </>
        ))}
      </div>
      {blocking && (
        <BlockedDialog
          title={blocking.title}
          onCancel={() => setBlocking(undefined)}
          onOk={(reason) => {
            send({ ...blocking.move, reason: reason || undefined });
            setBlocking(undefined);
          }}
        />
      )}
      <Notice notice={notice} />
    </>
  );
}

function CardList({
  lane,
  status,
  cards,
  board,
  today,
  onDrop,
  onKeyMove,
  onPriority,
}: {
  lane: string;
  status: Status;
  cards: KanbanCard[];
  board: string;
  today: string;
  onDrop: (m: Extract<KanbanToHost, { type: "move" }>) => void;
  onKeyMove: (card: KanbanCard, dir: -1 | 1) => void;
  onPriority: (card: KanbanCard, dir: -1 | 1) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  useEffect(() => {
    if (!ref.current) return;
    const sortable = Sortable.create(ref.current, {
      group: "kanban",
      animation: 120,
      ghostClass: "card-ghost",
      dragClass: "card-drag",
      onEnd: (evt) => {
        const item = evt.item as HTMLElement;
        const to = evt.to as HTMLElement;
        const from = evt.from as HTMLElement;
        const key = item.dataset.key!;
        const siblings = [...to.children].filter((c) => c !== item) as HTMLElement[];
        const index = evt.newIndex ?? 0;
        const above = siblings[index - 1]?.dataset.key;
        const below = siblings[index]?.dataset.key;
        // Put the DOM back where Preact expects it; the host's new model re-renders the board.
        item.remove();
        from.insertBefore(item, from.children[evt.oldIndex ?? 0] ?? null);
        if (from === to && evt.oldIndex === evt.newIndex) return;
        dropRef.current({
          type: "move",
          key,
          status: to.dataset.status as Status,
          lane: to.dataset.lane,
          above,
          below,
        });
      },
    });
    return () => sortable.destroy();
  }, []);
  return (
    <div
      class={`cards status-${status}`}
      ref={ref}
      data-status={status}
      data-lane={lane}
      role="list"
      aria-label={`${status} cards`}
    >
      {cards.map((c) => (
        <Card card={c} board={board} today={today} onKeyMove={onKeyMove} onPriority={onPriority} />
      ))}
    </div>
  );
}

function Card({
  card,
  board,
  today,
  onKeyMove,
  onPriority,
}: {
  card: KanbanCard;
  board: string;
  today: string;
  onKeyMove: (card: KanbanCard, dir: -1 | 1) => void;
  onPriority: (card: KanbanCard, dir: -1 | 1) => void;
}) {
  const overdue = card.late;
  const label = [
    card.title,
    card.id,
    card.ownerName,
    card.hours,
    card.due ? `due ${card.due}${overdue ? " (late)" : ""}` : "",
    card.prio !== "med" ? `priority ${card.prio}` : "",
    card.sev ? `severity ${card.sev}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div
      class={`card prio-${card.prio}${overdue ? " late" : ""}`}
      data-key={card.key}
      data-vscode-context={JSON.stringify({
        webviewSection: board === "punch" ? "punch" : "task",
        key: card.key,
        preventDefaultContextMenuItems: true,
      })}
      role="listitem"
      tabIndex={0}
      aria-label={label}
      title="Double-click to edit · right-click for all actions"
      onDblClick={() => send({ type: "edit", key: card.key })}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          send({ type: "reveal", key: card.key });
        } else if (e.key === "F2") {
          e.preventDefault();
          send({ type: "edit", key: card.key });
        } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          onKeyMove(card, e.key === "ArrowLeft" ? -1 : 1);
        } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          onPriority(card, e.key === "ArrowUp" ? -1 : 1);
        }
      }}
    >
      <div class="card-top">
        {board === "punch" && card.sev && <span class={`sev sev-${card.sev}`}>{card.sev}</span>}
        {card.prio === "high" && (
          <span class="codicon codicon-arrow-up prio-icon" title="High priority" />
        )}
        {card.prio === "low" && (
          <span class="codicon codicon-arrow-down prio-icon" title="Low priority" />
        )}
        <span class="card-title">{card.title}</span>
      </div>
      {card.parentTitle && <div class="card-parent muted">{card.parentTitle}</div>}
      {card.blocked && (
        <div class="card-blocked">
          <span class="codicon codicon-circle-slash" /> {card.blocked}
        </div>
      )}
      <div class="card-meta">
        {card.id && <span class="card-id">{card.id}</span>}
        {card.milestone && board === "tasks" && <span class="chip">{card.milestone}</span>}
        {card.hours && <span title="actual/estimate">{card.hours}</span>}
        {card.subtasks && (
          <span title="subtasks done/total">
            <span class="codicon codicon-checklist" /> {card.subtasks.done}/{card.subtasks.total}
          </span>
        )}
        {card.due && (
          <span
            class={`due${overdue ? " late" : ""}`}
            title={overdue ? `late (today ${today})` : "due"}
          >
            <span class="codicon codicon-calendar" /> {card.due}
          </span>
        )}
        {card.overtime !== undefined && (
          <span
            class="card-ot"
            title={`${card.overtime} h of overtime or extra working days planned`}
          >
            <span class="codicon codicon-watch" /> {card.overtime}h OT
          </span>
        )}
        <span class="spacer" />
        {card.ownerInitials ? (
          <button
            class="owner"
            title={`${card.ownerName} – click to change the owner`}
            aria-label={`Owner ${card.ownerName}: change`}
            tabIndex={-1}
            style={{ "--owner-color": card.ownerColor }}
            onClick={(e) => {
              e.stopPropagation();
              send({ type: "assign", key: card.key });
            }}
          >
            {card.ownerInitials}
          </button>
        ) : (
          <button
            class="icon-btn assign-owner"
            title="Assign an owner"
            aria-label={`Assign an owner to ${card.title}`}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              send({ type: "assign", key: card.key });
            }}
          >
            <span class="codicon codicon-person-add" />
          </button>
        )}
      </div>
      {card.from && <div class="card-from muted">from {card.from}</div>}
      {card.tags.length > 0 && (
        <div class="card-tags">
          {card.tags.map((t) => (
            <span class="tag">#{t}</span>
          ))}
        </div>
      )}
      <button
        class="icon-btn card-open"
        title="Reveal in editor"
        aria-label={`Reveal ${card.title} in editor`}
        tabIndex={-1}
        onClick={() => send({ type: "reveal", key: card.key })}
      >
        <span class="codicon codicon-go-to-file" />
      </button>
    </div>
  );
}

function BlockedDialog({
  title,
  onOk,
  onCancel,
}: {
  title: string;
  onOk: (reason: string) => void;
  onCancel: () => void;
}) {
  useReturnFocus();
  const [reason, setReason] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div class="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="blocked-title">
      <form
        class="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onOk(reason.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      >
        <h2 id="blocked-title">Why is “{title}” blocked?</h2>
        <input
          ref={input}
          type="text"
          style={{ width: "100%" }}
          value={reason}
          placeholder="optional reason"
          aria-label="Reason (optional)"
          onInput={(e) => setReason(e.currentTarget.value)}
        />
        <div class="actions">
          <button type="button" class="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" class="btn primary">
            Block
          </button>
        </div>
      </form>
    </div>
  );
}
