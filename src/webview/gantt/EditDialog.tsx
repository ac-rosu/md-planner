// Inline edit of a task's title, owner and estimate (double-click a bar or press F2).
import { useEffect, useRef, useState } from "preact/hooks";
import { formatHours } from "../../core/duration";
import { type GanttModel, type GanttRow } from "../../core/views/gantt";
import { useReturnFocus } from "../shared/ui";
import { changedFields, editValues, type EditResult } from "./editFields";

const DURATION = /^\d+(\.\d+)?\s*[hdw]$/i;

export function EditDialog({
  row,
  model,
  onSave,
  onCancel,
  onAllFields,
}: {
  row: GanttRow;
  model: GanttModel;
  onSave: (r: EditResult) => void;
  onCancel: () => void;
  /** Opens the full edit form (status, dependencies, dates, tags …). */
  onAllFields: () => void;
}) {
  useReturnFocus();
  // The values it opened with. Only the fields changed from these are saved: the task can change
  // meanwhile (in the editor, by an agent), and a field left alone must not write an old value back.
  const [opened] = useState(() => editValues(row));
  const [title, setTitle] = useState(opened.title);
  const [owner, setOwner] = useState(opened.owner);
  const [estimate, setEstimate] = useState(opened.estimate);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.select(), []);
  const estimateValid = estimate.trim() === "" || DURATION.test(estimate.trim());
  const ownerIds = model.people.map((p) => p.id.toLowerCase());
  const save = () => {
    if (!estimateValid || !title.trim()) return;
    onSave(changedFields(opened, { title, owner, estimate }));
  };
  return (
    <div
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        class="dialog"
        aria-labelledby="edit-title"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id="edit-title">Edit {row.id ?? "task"}</h2>
        <div class="field">
          <label for="f-title">Title</label>
          <input
            id="f-title"
            ref={first}
            type="text"
            value={title}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="f-owner">Owner</label>
          <select id="f-owner" value={owner} onChange={(e) => setOwner(e.currentTarget.value)}>
            <option value="">— none —</option>
            {model.people.map((p) => (
              <option value={p.id.toLowerCase()}>{p.name}</option>
            ))}
            {owner && !ownerIds.includes(owner) && (
              <option value={owner}>{owner} (not in team.md)</option>
            )}
          </select>
        </div>
        <div class="field">
          <label for="f-est">Estimate</label>
          <input
            id="f-est"
            type="text"
            value={estimate}
            placeholder={
              row.budget !== undefined
                ? `${formatHours(row.budget)} (share of ${row.budgetOf ?? "the parent"}'s estimate)`
                : "e.g. 12h, 2d, 1w"
            }
            aria-invalid={!estimateValid}
            aria-describedby={row.budget !== undefined ? "f-est-share" : undefined}
            onInput={(e) => setEstimate(e.currentTarget.value)}
          />
        </div>
        {!estimateValid && <div class="muted">Use a number with h, d or w.</div>}
        {row.budget !== undefined && (
          <div class="muted" id="f-est-share">
            Its hours are a share of {row.budgetOf ?? "its parent"}'s estimate; an estimate of its
            own changes that estimate with it, so the other subtasks keep their hours.
          </div>
        )}
        <div class="actions">
          <button
            type="button"
            class="btn link"
            onClick={onAllFields}
            title="Status, dependencies, dates, priority, tags …"
          >
            All fields…
          </button>
          <span class="spacer" />
          <button type="button" class="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={!estimateValid || !title.trim()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
