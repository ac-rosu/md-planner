// Test runner: step through a test plan case by case, record pass / fail / n.a. with notes,
// raise punch items from failures and append a run log.
import { useEffect, useRef, useState } from "preact/hooks";
import { type RunnerCase, type RunnerModel, type RunnerStep } from "../../core/views/testRunner";
import { type HostToRunner, type RunnerToHost } from "../shared/protocol";
import { Notice, UndoRedo, useReturnFocus } from "../shared/ui";
import { getState, onMessage, post, setState } from "../shared/vscode";

const send = (m: RunnerToHost) => post(m);

export function App() {
  const [model, setModel] = useState<RunnerModel | undefined>();
  const [caseId, setCaseId] = useState<string | undefined>(getState<{ caseId?: string }>()?.caseId);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [notice, setNotice] = useState<
    { level: "info" | "error"; message: string; at: number } | undefined
  >();
  const [punchFor, setPunchFor] = useState<RunnerStep | undefined>();
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    const off = onMessage<HostToRunner>((m) => {
      if (m.type === "model") setModel(m.model);
      else if (m.type === "history") setHistory({ canUndo: m.canUndo, canRedo: m.canRedo });
      else if (m.type === "notice")
        setNotice({ level: m.level, message: m.message, at: Date.now() });
    });
    send({ type: "ready" });
    return off;
  }, []);
  useEffect(() => setState({ caseId }), [caseId]);

  if (!model) return <div class="empty">Loading the test plan…</div>;
  const plan = model.plan;
  if (!plan) {
    return (
      <div class="empty">
        {model.plans.length ? "Select a test plan." : "No test plans in plan/tests/ yet."}
        <PlanSelect model={model} />
      </div>
    );
  }
  const index = Math.max(
    0,
    plan.cases.findIndex((c) => c.id === caseId)
  );
  const current = plan.cases[index];
  const c = plan.counts;
  const pct = (n: number) => (c.steps ? (n / c.steps) * 100 : 0);

  return (
    <>
      <div class="toolbar" role="toolbar" aria-label="Test run">
        <PlanSelect model={model} />
        <span class="muted">
          {[
            plan.type,
            plan.milestone,
            plan.eq ? `eq ${plan.eq}` : "",
            plan.witness ? `witness: ${plan.witness}` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span class="spacer" />
        <button
          class="btn primary"
          onClick={() => setFinishing(true)}
          title="Append a run summary to the test plan"
        >
          <span class="codicon codicon-check-all" /> Finish run…
        </button>
        <button
          class="btn"
          onClick={() => send({ type: "reset" })}
          title="Clear all results and notes for a new run (asks first)"
        >
          <span class="codicon codicon-debug-restart" /> Reset results
        </button>
        <button
          class="btn"
          onClick={() => send({ type: "export", format: "pdf" })}
          title="Test report as PDF (HTML when no browser is available)"
        >
          <span class="codicon codicon-file-pdf" /> Export report
        </button>
        <button class="btn" onClick={() => send({ type: "openFile" })}>
          <span class="codicon codicon-go-to-file" /> Open file
        </button>
        <UndoRedo
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onUndo={() => send({ type: "undo" })}
          onRedo={() => send({ type: "redo" })}
        />
      </div>
      <div class="summary" aria-label="Results">
        <div
          class="bar"
          role="img"
          aria-label={`${c.pass} pass, ${c.fail} fail, ${c.na} not applicable, ${c.open} open`}
        >
          <div class="seg pass" style={{ width: `${pct(c.pass)}%` }} />
          <div class="seg fail" style={{ width: `${pct(c.fail)}%` }} />
          <div class="seg na" style={{ width: `${pct(c.na)}%` }} />
        </div>
        <span>
          <b>{c.pass}</b> pass · <b class={c.fail ? "bad" : ""}>{c.fail}</b> fail · <b>{c.na}</b>{" "}
          n.a. · <b>{c.open}</b> open of {c.steps} steps
        </span>
      </div>
      <div class="runner">
        <nav class="cases" aria-label="Test cases">
          {plan.cases.map((tc, i) => (
            <button
              class={`case-link${i === index ? " active" : ""}`}
              aria-current={i === index ? "true" : undefined}
              onClick={() => setCaseId(tc.id)}
            >
              <span class={`codicon ${caseIcon(tc)}`} />
              <span class="case-name">
                <b>{tc.id}</b> {tc.title}
              </span>
              <span class="muted">
                {tc.counts.steps - tc.counts.open}/{tc.counts.steps}
              </span>
            </button>
          ))}
          {plan.runs.length > 0 && (
            <div class="runs">
              <h3>Runs</h3>
              {plan.runs.map((r) => (
                <div class="run">
                  <b>{r.date || r.title}</b>
                  <div class="muted small">{r.summary}</div>
                </div>
              ))}
            </div>
          )}
          {plan.linkedTasks.length > 0 && (
            <div class="runs">
              <h3>Linked tasks</h3>
              {plan.linkedTasks.map((t) => (
                <div class="run">
                  <a
                    href="#"
                    onClick={(e) => (e.preventDefault(), send({ type: "reveal", key: t.key }))}
                  >
                    {t.id ? `${t.id} · ` : ""}
                    {t.title}
                  </a>{" "}
                  <span class="muted small">{t.status}</span>
                </div>
              ))}
            </div>
          )}
        </nav>
        {current ? (
          <section class="case" aria-labelledby="case-title">
            <h2 id="case-title">
              {current.id} {current.title}
            </h2>
            {current.pre && (
              <div class="pre">
                <span class="muted">Pre-condition:</span> {current.pre}
              </div>
            )}
            <ol class="steps">
              {current.steps.map((s, i) => (
                <Step step={s} n={i + 1} onPunch={() => setPunchFor(s)} />
              ))}
            </ol>
            {current.steps.length === 0 && (
              <div class="muted">This case has no steps (checkbox items) yet.</div>
            )}
            <div class="nav">
              <button
                class="btn"
                disabled={index === 0}
                onClick={() => setCaseId(plan.cases[index - 1].id)}
              >
                <span class="codicon codicon-arrow-left" /> Previous case
              </button>
              <button
                class="btn"
                disabled={index >= plan.cases.length - 1}
                onClick={() => setCaseId(plan.cases[index + 1].id)}
              >
                Next case <span class="codicon codicon-arrow-right" />
              </button>
              <span class="muted small">
                Keys on a step: P pass · F fail · N n.a. · Backspace clear
              </span>
            </div>
          </section>
        ) : (
          <div class="empty">This test plan has no test cases (## headings).</div>
        )}
      </div>
      {punchFor && current && (
        <PunchDialog
          step={punchFor}
          tc={current}
          model={model}
          onCancel={() => setPunchFor(undefined)}
          onOk={(p) => {
            send({ type: "createPunch", step: punchFor.key, ...p });
            setPunchFor(undefined);
          }}
        />
      )}
      {finishing && (
        <FinishDialog
          model={model}
          onCancel={() => setFinishing(false)}
          onOk={(r) => {
            send({ type: "finishRun", ...r });
            setFinishing(false);
          }}
        />
      )}
      <Notice notice={notice} />
    </>
  );
}

function caseIcon(tc: RunnerCase): string {
  if (tc.counts.fail > 0) return "codicon-error bad";
  if (tc.counts.steps > 0 && tc.counts.open === 0) return "codicon-pass-filled good";
  if (tc.counts.open < tc.counts.steps) return "codicon-circle-large-filled";
  return "codicon-circle-large-outline";
}

function PlanSelect({ model }: { model: RunnerModel }) {
  return (
    <select
      aria-label="Test plan"
      value={model.plan?.id ?? ""}
      onChange={(e) => send({ type: "selectPlan", id: e.currentTarget.value })}
    >
      {!model.plan && <option value="">Select…</option>}
      {model.plans.map((p) => (
        <option value={p.id}>
          {p.id} – {p.title}
        </option>
      ))}
    </select>
  );
}

function Step({ step, n, onPunch }: { step: RunnerStep; n: number; onPunch: () => void }) {
  const [note, setNote] = useState(step.note ?? "");
  useEffect(() => setNote(step.note ?? ""), [step.note]);
  const result = (r: "pass" | "fail" | "na" | null) =>
    send({
      type: "result",
      step: step.key,
      result: r,
      note: note !== (step.note ?? "") ? note : undefined,
    });
  const saveNote = () => {
    if (note !== (step.note ?? "")) send({ type: "note", step: step.key, note });
  };
  return (
    <li
      class={`step result-${step.result ?? "open"}${step.level ? " sub" : ""}`}
      tabIndex={0}
      aria-label={`Step ${n}: ${step.text}, ${step.result ?? "open"}`}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === "INPUT") return;
        const k = e.key.toLowerCase();
        if (k === "p") result("pass");
        else if (k === "f") result("fail");
        else if (k === "n") result("na");
        else if (k === "backspace" || k === "delete") result(null);
        else return;
        e.preventDefault();
      }}
    >
      <div class="step-text">{step.text}</div>
      <div class="step-actions" role="group" aria-label="Result">
        <button
          class="res pass"
          aria-pressed={step.result === "pass"}
          onClick={() => result(step.result === "pass" ? null : "pass")}
        >
          <span class="codicon codicon-check" /> Pass
        </button>
        <button
          class="res fail"
          aria-pressed={step.result === "fail"}
          onClick={() => result(step.result === "fail" ? null : "fail")}
        >
          <span class="codicon codicon-close" /> Fail
        </button>
        <button
          class="res na"
          aria-pressed={step.result === "na"}
          onClick={() => result(step.result === "na" ? null : "na")}
        >
          N.a.
        </button>
        <input
          type="text"
          class="note"
          aria-label="Note"
          placeholder="note"
          value={note}
          onInput={(e) => setNote(e.currentTarget.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              saveNote();
            }
          }}
        />
        {step.punch ? (
          <span
            class={`punch-link${step.punchStatus === "done" ? " closed" : ""}`}
            title={`Punch item ${step.punch} (${step.punchStatus ?? "unknown"})`}
          >
            <span class="codicon codicon-bug" /> {step.punch}
          </span>
        ) : (
          step.result === "fail" && (
            <button class="btn" onClick={onPunch}>
              <span class="codicon codicon-bug" /> Create punch item
            </button>
          )
        )}
      </div>
    </li>
  );
}

function PunchDialog({
  step,
  tc,
  model,
  onOk,
  onCancel,
}: {
  step: RunnerStep;
  tc: RunnerCase;
  model: RunnerModel;
  onOk: (p: { title: string; sev: "A" | "B" | "C"; owner?: string; due?: string }) => void;
  onCancel: () => void;
}) {
  useReturnFocus();
  const [title, setTitle] = useState(step.note ? `${step.text}: ${step.note}` : step.text);
  const [sev, setSev] = useState<"A" | "B" | "C">("B");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.select(), []);
  const dueValid = due === "" || /^\d{4}-\d{2}-\d{2}$/.test(due);
  return (
    <div class="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="punch-title">
      <form
        class="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() && dueValid)
            onOk({ title: title.trim(), sev, owner: owner || undefined, due: due || undefined });
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      >
        <h2 id="punch-title">Create punch item from {tc.id}</h2>
        <div class="field">
          <label for="p-title">Title</label>
          <input
            id="p-title"
            ref={first}
            type="text"
            value={title}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="p-sev">Severity</label>
          <select
            id="p-sev"
            value={sev}
            onChange={(e) => setSev(e.currentTarget.value as "A" | "B" | "C")}
          >
            <option value="A">A – blocks acceptance</option>
            <option value="B">B – fix before go-live</option>
            <option value="C">C – after launch</option>
          </select>
        </div>
        <div class="field">
          <label for="p-owner">Owner</label>
          <select id="p-owner" value={owner} onChange={(e) => setOwner(e.currentTarget.value)}>
            <option value="">— none —</option>
            {model.people.map((p) => (
              <option value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="p-due">Due</label>
          <input
            id="p-due"
            type="text"
            placeholder="YYYY-MM-DD (optional)"
            value={due}
            aria-invalid={!dueValid}
            onInput={(e) => setDue(e.currentTarget.value)}
          />
        </div>
        <div class="muted small">
          Writes a ^P item to punchlist.md with @from:{model.plan?.id}/{tc.id} and links it to the
          step.
        </div>
        <div class="actions">
          <button type="button" class="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={!title.trim() || !dueValid}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

function FinishDialog({
  model,
  onOk,
  onCancel,
}: {
  model: RunnerModel;
  onOk: (r: { date: string; tester: string; witness?: string }) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(model.today);
  const [tester, setTester] = useState(model.tester ?? "");
  const [witness, setWitness] = useState(model.plan?.witness ?? "");
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && tester.trim() !== "";
  const c = model.plan!.counts;
  return (
    <div class="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="finish-title">
      <form
        class="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onOk({ date, tester: tester.trim(), witness: witness.trim() || undefined });
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      >
        <h2 id="finish-title">Finish run of {model.plan!.id}</h2>
        <div class="field">
          <label for="r-date">Date</label>
          <input
            id="r-date"
            type="text"
            value={date}
            onInput={(e) => setDate(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="r-tester">Tester</label>
          <input
            id="r-tester"
            type="text"
            value={tester}
            onInput={(e) => setTester(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="r-witness">Witness</label>
          <input
            id="r-witness"
            type="text"
            value={witness}
            onInput={(e) => setWitness(e.currentTarget.value)}
          />
        </div>
        <div class="muted small">
          Appends “## Run {date}” with {c.pass} pass, {c.fail} fail, {c.na} n.a., {c.open} open.
        </div>
        <div class="actions">
          <button type="button" class="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={!valid}>
            Append run log
          </button>
        </div>
      </form>
    </div>
  );
}
