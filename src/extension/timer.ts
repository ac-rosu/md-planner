// Time tracking: one running timer per workspace, shown in the status bar; stopping it adds the
// rounded time to the task's @act. `Planner: Log time` adds hours manually.
import * as vscode from "vscode";
import { localToday } from "../core/dates";
import { formatHours } from "../core/duration";
import { lineAfter } from "../core/lineHistory";
import { isOpen, type ParsedFile, STATUS_LABEL, type Task } from "../core/model";
import { matchCheckbox } from "../core/parser/taskLine";
import { taskKey } from "../core/scheduler";
import { applyEdits, type TextEdit, TextLines } from "../core/text";
import {
  addActual,
  formatElapsed,
  parseLoggedTime,
  roundMinutes,
  timerRanLong,
  unreadableActual,
} from "../core/time";
import { editTaskLine, minimalLineEdit, setStatus, TaskLineEditor } from "../core/writer";
import { findAgain, findAt, resolveTask, type TaskArg } from "./commands/args";
import { confirmEarlyStart, rollUpParents } from "./commands/status";
import { type PlanService } from "./planService";
import { config } from "./util";

/** A line of the task's file as it was before and after the timer started. */
export interface StartedLine {
  line: number;
  before: string;
  after: string;
}

export interface RunningTimer {
  /** The task's id (`file#line` when it has none) and title, as on its line now. */
  key: string;
  title: string;
  /**
   * The task's file and line, followed through the edits of the file while VS Code runs (a copied
   * line has the same id), and the text of the line. When the line no longer has that text, the
   * file changed out of sight or the line was replaced: then the task is found by its key. Once
   * the line is copied (see copiesLine), it is no longer followed either, and the key and title
   * stay as they were.
   */
  file?: string;
  line?: number;
  text?: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /**
   * The lines starting the timer changed, the task's first: a to-do task went in progress, and its
   * parents followed (a done parent reopens). Put back when the timer is stopped within a minute.
   */
  started?: StartedLine[];
}

// The timed line is followed as the plan service follows items of earlier parses (see follow).
export { lineAfter };

const STATE_KEY = "planner.timer";

export class TimerService implements vscode.Disposable {
  readonly item = vscode.window.createStatusBarItem(
    "planner.timer",
    vscode.StatusBarAlignment.Left,
    49
  );
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly following: vscode.Disposable;
  private readonly planChanges: vscode.Disposable;
  /** When the timer started whose task was found finished (see noticeFinished). */
  private noticed: number | undefined;
  /** Clock, replaceable in tests. */
  now: () => number = () => Date.now();

  constructor(
    private readonly service: PlanService,
    private readonly memento: vscode.Memento
  ) {
    this.item.name = "Planner: timer";
    this.item.command = "planner.stopTimer";
    this.interval = setInterval(() => this.render(), 30_000);
    this.following = vscode.workspace.onDidChangeTextDocument((e) => this.follow(e));
    this.planChanges = service.onDidChange(() => this.noticeFinished());
    this.render();
  }

  get running(): RunningTimer | undefined {
    return this.memento.get<RunningTimer>(STATE_KEY);
  }

  /** Starts a timer on a task (stopping and logging a running one first). */
  async start(arg: TaskArg): Promise<boolean> {
    const r = resolveTask(this.service, arg);
    if (!r || (r.task.kind !== "task" && r.task.kind !== "punch")) {
      void vscode.window.showWarningMessage("Planner: select a task to time.");
      return false;
    }
    // Timing a to-do task starts it: ask first when an earlier milestone is not finished.
    if (!(await confirmEarlyStart(this.service.plan, r.task, "doing"))) return false;
    if (this.running && !(await this.stopped())) return false;
    const t = findAgain(this.service.plan, r.task);
    if (!t) return false;
    // Starting work on a task that is still "to do" moves it (and its parents) to "in progress".
    const lines = this.service.plan.file(t.file)!.lines;
    const edits =
      t.status === "todo"
        ? setStatus(lines, t, "doing", this.service.today(), { rollUp: rollUpParents() })
        : [];
    await this.memento.update(STATE_KEY, {
      key: taskKey(t),
      title: t.title,
      file: t.file,
      line: t.line,
      text: lines.line(t.line),
      startedAt: this.now(),
      started: edits.length ? changedLines(lines, edits) : undefined,
    } satisfies RunningTimer);
    if (edits.length && (await this.service.apply([{ path: t.file, edits }], { source: "view" }))) {
      // The edit is followed like any other; the line is read again in case VS Code opened the
      // file only for it. Saving gives a task without an id one, and a copied line a new one.
      const running = this.running;
      const file = this.service.plan.file(t.file);
      if (running?.line !== undefined && file)
        await this.track(running, { line: running.line, text: file.lines.line(running.line) });
    }
    this.render();
    return true;
  }

  /**
   * Stops the running timer and adds the rounded time to @act. Returns the hours added (0 when
   * nothing was logged on purpose); undefined when nothing was logged otherwise. A timer that ran
   * longer than a working day, into another day or backwards (the clock was set back) asks first;
   * cancelling that question, or an @act that cannot be added to, keeps it running.
   */
  async stop(): Promise<number | undefined> {
    const running = this.running;
    if (!running) return undefined;
    const name = timerName(running);
    const now = this.now();
    const elapsed = now - running.startedAt;
    if (elapsed >= 0 && elapsed < 60_000) {
      await this.clear();
      // Started by mistake: put back what starting it changed (the task to do again, and the
      // parents that followed it).
      const back = await this.putBack(running);
      void vscode.window.showInformationMessage(
        back
          ? `Planner: timer stopped after less than a minute; nothing logged, ${name} is back to To do.`
          : "Planner: timer stopped after less than a minute; nothing logged."
      );
      return 0;
    }
    const rounding = config().get<number>("time.roundingMinutes", 15);
    const rounded = elapsed < 0 ? undefined : roundMinutes(elapsed / 60_000, rounding) / 60;
    if (!(await this.target(running, rounded === undefined ? "the time" : formatHours(rounded))))
      return undefined;
    const answer = await this.confirmHours(running, now, rounded);
    // Cancelled: the timer runs on (unless it was stopped meanwhile).
    const latest = this.running;
    if (answer === undefined || latest?.startedAt !== running.startedAt) return undefined;
    if (answer === "discard") {
      await this.clear();
      void vscode.window.showInformationMessage(
        `Planner: timer on ${name} discarded; nothing logged.`
      );
      return 0;
    }
    // Found again: the plan may have changed while the question was open.
    const t = await this.target(latest, formatHours(answer));
    if (!t) return undefined;
    await this.clear();
    if (!(await this.addHours(t, answer))) return undefined;
    void vscode.window.setStatusBarMessage(
      `Planner: logged ${formatHours(answer)} on ${t.id ?? t.title}`,
      4000
    );
    return answer;
  }

  /**
   * Stops the running timer; false when it runs on: its question was cancelled, or its task's @act
   * needs fixing first.
   */
  private async stopped(): Promise<boolean> {
    await this.stop();
    return this.running === undefined;
  }

  /** Adds hours to a task's @act (asks when not given). */
  async log(arg: TaskArg, value?: string | number): Promise<number | undefined> {
    const r = resolveTask(this.service, arg);
    if (!r) return undefined;
    // Before asking: an @act that cannot be added to is fixed first.
    if (this.refuses(r.task)) return undefined;
    let hours =
      typeof value === "number" ? value : value !== undefined ? parseLoggedTime(value) : undefined;
    if (hours === undefined) {
      hours = await askHours(r.task.id ?? r.task.title);
      if (hours === undefined) return undefined;
    }
    const t = findAgain(this.service.plan, r.task);
    if (!t) return undefined;
    return (await this.addHours(t, hours)) ? hours : undefined;
  }

  /**
   * The task to log the timer's time on. Undefined, after saying why, when there is none: the task
   * is gone or cannot be told from a copy (then the timer stops, and `lost` is not logged), or its
   * @act cannot be added to (then it runs on, to be stopped again once that is fixed).
   */
  private async target(running: RunningTimer, lost: string): Promise<Task | undefined> {
    const [t, ...more] = this.timedTasks(running);
    if (!t || more.length > 0) {
      await this.clear();
      const id = timerId(running);
      const which = id ? `has the id ${id}` : `is called "${running.title}"`;
      void vscode.window.showWarningMessage(
        t
          ? `Planner: more than one task ${which}; ${lost} not logged.`
          : `Planner: task ${timerName(running)} no longer exists; ${lost} not logged.`
      );
      return undefined;
    }
    const why = unreadableActual(t);
    if (why) {
      void vscode.window.showWarningMessage(
        `Planner: ${t.id ?? t.title}: ${why}, then stop the timer again. It keeps running.`
      );
      return undefined;
    }
    return t;
  }

  /**
   * The hours to log for a timer stopped at `now`: `rounded`, after asking when it ran longer than
   * a working day or into another day, or another amount; when the clock was set back (`rounded`
   * undefined), the amount asked for. "discard" when the time is discarded; undefined when the
   * question was cancelled.
   */
  private async confirmHours(
    running: RunningTimer,
    now: number,
    rounded: number | undefined
  ): Promise<number | "discard" | undefined> {
    const name = timerName(running);
    const elapsed = formatElapsed(now - running.startedAt);
    const since = startedText(running.startedAt, now);
    const other = "Other amount…";
    const discard = "Discard";
    const keep = "Cancel keeps the timer running.";
    let pick: string | undefined;
    let log: string | undefined;
    if (rounded !== undefined && elapsed !== undefined) {
      const hoursPerDay = this.service.plan.project.hoursPerDay;
      const [from, to] = [running.startedAt, now].map((ms) => localToday(new Date(ms)));
      if (!timerRanLong(now - running.startedAt, hoursPerDay, from, to)) return rounded;
      log = `Log ${formatHours(rounded)}`;
      pick = await vscode.window.showWarningMessage(
        `The timer on ${name} has been running for ${elapsed}, since ${since}.`,
        {
          modal: true,
          detail: `Was it left running? ${log} on ${name}, enter the time you worked, or discard it. ${keep}`,
        },
        log,
        other,
        discard
      );
    } else {
      pick = await vscode.window.showWarningMessage(
        `The clock is now earlier than when the timer on ${name} started (${since}).`,
        {
          modal: true,
          detail: `It was set back while the timer ran, so the time worked is not known. Enter the time you worked, or discard the timer; ${name} stays as it is. ${keep}`,
        },
        other,
        discard
      );
    }
    if (pick === undefined) return undefined;
    if (pick === log) return rounded;
    if (pick === discard) return "discard";
    return askHours(name);
  }

  /** True, after saying why, when hours cannot be added to the task's @act. */
  private refuses(t: Task): boolean {
    const why = unreadableActual(t);
    if (why) void vscode.window.showWarningMessage(`Planner: ${t.id ?? t.title}: ${why}.`);
    return why !== undefined;
  }

  private async clear(): Promise<void> {
    await this.memento.update(STATE_KEY, undefined);
    this.render();
  }

  /**
   * Says once per timer when its task was finished (done or cancelled) while it runs, from the
   * editor, a view or another tool, and offers to stop it.
   */
  private noticeFinished(): void {
    const r = this.running;
    if (!r || this.noticed === r.startedAt) return;
    const [t, ...more] = this.timedTasks(r);
    if (!t || more.length > 0 || isOpen(t.status)) return;
    this.noticed = r.startedAt;
    const stop = "Stop timer";
    const elapsed = formatElapsed(this.now() - r.startedAt);
    void vscode.window
      .showInformationMessage(
        `Planner: ${t.id ?? t.title} is ${STATUS_LABEL[t.status].toLowerCase()}, but its timer is still running${elapsed ? ` (${elapsed})` : ""}.`,
        stop,
        "Keep running"
      )
      .then((pick) => {
        if (pick === stop && this.running?.startedAt === r.startedAt) void this.stop();
      });
  }

  /**
   * The tasks the timer may be on: the item on its line while the line is as last seen (see
   * RunningTimer). Otherwise the items with its id, by its file and title where a copied line has
   * the id too; a task without an id (a save may have given it one) by its title in its file.
   */
  private timedTasks(running: RunningTimer): Task[] {
    const plan = this.service.plan;
    const { file, line, text } = running;
    if (file !== undefined && line !== undefined && plan.file(file)?.lines.line(line) === text) {
      const t = findAt(plan, file, line);
      return t ? [t] : [];
    }
    const hash = running.key.lastIndexOf("#");
    if (hash > 0) {
      const items = plan.file(file ?? running.key.slice(0, hash))?.items ?? [];
      return items.filter((t) => t.title === running.title);
    }
    const all = [...plan.tasks, ...plan.punch, ...plan.inbox].filter((t) => t.id === running.key);
    if (all.length < 2) return all;
    const here = all.filter((t) => t.file === file && t.title === running.title);
    return here.length === 1 ? here : all;
  }

  /** Follows the timed line through an edit of its file, up to a copy of it (see RunningTimer). */
  private follow(e: vscode.TextDocumentChangeEvent): void {
    const r = this.running;
    if (r?.line === undefined || e.contentChanges.length === 0) return;
    if (this.service.relPath(e.document.uri) !== r.file) return;
    const copied = r.text !== undefined && copiesLine(r.text, r.line, e.contentChanges);
    const line = copied ? undefined : lineAfter(r.line, e.contentChanges);
    const doc = e.document;
    void this.track(
      r,
      line !== undefined && line < doc.lineCount ? { line, text: doc.lineAt(line).text } : undefined
    );
  }

  /**
   * Records where the timed line is and what it says, with the key and title on it now; without
   * it, the line is no longer followed.
   */
  private async track(r: RunningTimer, at?: { line: number; text: string }): Promise<void> {
    if (at?.line === r.line && at?.text === r.text) return;
    const now = at && lineState(at.text);
    await this.memento.update(STATE_KEY, {
      ...r,
      line: at?.line,
      text: at?.text,
      key: at && now ? (now.id ?? `${r.file}#${at.line + 1}`) : r.key,
      title: now?.title ?? r.title,
    } satisfies RunningTimer);
    this.render();
  }

  /**
   * Puts back what starting the timer changed, line by line (see lineNow): the task, and each
   * parent that followed it. True when the task is back to to do.
   */
  private async putBack(running: RunningTimer): Promise<boolean> {
    const path = running.file;
    const file = path === undefined ? undefined : this.service.plan.file(path);
    if (!running.started?.length || path === undefined || !file) return false;
    const edits: TextEdit[] = [];
    const used = new Set<number>();
    let task = false;
    for (const [i, s] of running.started.entries()) {
      const back = lineNow(file, s);
      if (!back || used.has(back.line)) continue;
      used.add(back.line);
      const edit = minimalLineEdit(back.line, file.lines.line(back.line), back.text);
      if (edit) edits.push(edit);
      if (i === 0) task = true;
    }
    return (await this.service.apply([{ path, edits }], { source: "view" })) && task;
  }

  /**
   * Adds hours to the task's @act. False, after saying why, when its @act cannot be added to: then
   * adding would replace it.
   */
  private async addHours(t: Task, hours: number): Promise<boolean> {
    const why = unreadableActual(t);
    if (why) {
      void vscode.window.showWarningMessage(
        `Planner: ${t.id ?? t.title}: ${why}; ${formatHours(hours)} not logged.`
      );
      return false;
    }
    const file = this.service.plan.file(t.file)!;
    const edits = editTaskLine(file.lines, t, (e) => e.setAttr("act", addActual(t.act, hours)));
    return this.service.apply([{ path: t.file, edits }], { source: "view" });
  }

  render(): void {
    const r = this.running;
    if (!r) {
      this.item.hide();
      return;
    }
    const now = this.now();
    const ms = now - r.startedAt;
    const elapsed = formatElapsed(ms);
    const [from, to] = [r.startedAt, now].map((x) => localToday(new Date(x)));
    // A timer that will ask before it logs (see confirmHours) stands out.
    const long = !elapsed || timerRanLong(ms, this.service.plan.project.hoursPerDay, from, to);
    this.item.text = `$(clock) ${r.key} ${elapsed ?? "?"}`;
    this.item.backgroundColor = long
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.item.tooltip = [
      `Timer on ${r.key} – ${r.title}`,
      `Started ${startedText(r.startedAt, now)}`,
      elapsed
        ? `Running for ${elapsed}`
        : "The clock is now earlier than when it started (it was set back)",
      "Click to stop and add the time to @act.",
    ].join("\n");
    this.item.accessibilityInformation = {
      label: `Timer running on ${r.title} for ${elapsed ?? "an unknown time"}. Activate to stop.`,
    };
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.interval);
    this.following.dispose();
    this.planChanges.dispose();
    this.item.dispose();
  }
}

/** The timed task's id; undefined when it has none (the key is then `file#line`). */
function timerId(r: RunningTimer): string | undefined {
  return r.key.includes("#") ? undefined : r.key;
}

/** The timed task's id, or its title when it has none. */
function timerName(r: RunningTimer): string {
  return timerId(r) ?? r.title;
}

/** When a timer started: the time, with the date when that was not the day of `now`. */
function startedText(startedAt: number, now: number): string {
  const at = new Date(startedAt);
  return localToday(at) === localToday(new Date(now))
    ? at.toLocaleTimeString(undefined, { timeStyle: "short" })
    : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Asks for time spent on a task (`1.5`, `90m`, `1h30m`, `1:30`); undefined when cancelled. */
async function askHours(name: string): Promise<number | undefined> {
  const text = await vscode.window.showInputBox({
    prompt: `Hours spent on ${name} (added to @act)`,
    placeHolder: "e.g. 1.5, 90m, 1h30m",
    validateInput: (v) =>
      parseLoggedTime(v) === undefined ? "Enter a positive duration such as 1.5 or 90m" : undefined,
  });
  return text ? parseLoggedTime(text) : undefined;
}

/**
 * True when a change copies the timed line (at `line`, reading `text`) next to itself: Copy Line
 * Down inserts the selected lines with the timed one before the first of them, Copy Line Up after
 * the last, and so does a paste right there. Then the line and its copy cannot be told apart: VS
 * Code leaves the cursor on the lines it takes for the original, which people then edit as the
 * copy. A copy pasted elsewhere leaves the timed line where it was.
 */
export function copiesLine(
  text: string,
  line: number,
  changes: readonly vscode.TextDocumentContentChangeEvent[]
): boolean {
  return changes.some((c) => {
    const lines = c.text.split(/\r?\n/);
    // The k lines copied end at the insertion (Up) or start there (Down).
    const k = lines.length - 1;
    const at = c.range.start.line;
    return k > 0 && line > at - k && line < at + k && lines.includes(text);
  });
}

/** The lines that edits within single lines (status changes) change, before and after. */
function changedLines(lines: TextLines, edits: TextEdit[]): StartedLine[] {
  const after = TextLines.parse(applyEdits(lines.serialize(), edits));
  // In the order of the edits: setStatus() changes the task's own line first.
  return [...new Set(edits.map((e) => e.range.start.line))].map((line) => ({
    line,
    before: lines.line(line),
    after: after.line(line),
  }));
}

/**
 * Where a line that starting the timer changed is now, and what to put back there. A line still as
 * the timer left it, apart from what saving does, gets back exactly what it was: on its line, or as
 * the only such line when lines moved. A line edited since gets back only its status and its status
 * dates, on its line (see statusBack). Undefined when neither applies.
 */
function lineNow(file: ParsedFile, s: StartedLine): { line: number; text: string } | undefined {
  const exactly = (line: number) => asBefore(file.lines.line(line), s);
  const here = exactly(s.line);
  if (here !== undefined) return { line: s.line, text: here };
  const moved = file.items.filter((t) => exactly(t.line) !== undefined);
  if (moved.length === 1) return { line: moved[0].line, text: exactly(moved[0].line)! };
  const text = moved.length === 0 ? statusBack(file.lines.line(s.line), s) : undefined;
  return text === undefined ? undefined : { line: s.line, text };
}

/**
 * The line before the timer started, when `now` is still as the timer left it apart from what
 * saving does: an id given or renumbered (kept), spaces trimmed at the end.
 */
function asBefore(now: string, s: StartedLine): string | undefined {
  const is = lineState(now);
  if (!is) return undefined;
  const trim = (text: string) => text.replace(/[ \t]+$/, "");
  const withId = (text: string) => trim(new TaskLineEditor(text).setId(is.id).toString());
  if (withId(s.after) !== trim(now)) return undefined;
  return withId(s.before) + now.slice(trim(now).length);
}

/**
 * `now` with its status as before the timer started (the checkbox, `@started`, `@done` and
 * `@blocked`), when it is still the same task (its title or its id) and its status is still as the
 * timer left it. Or when its status is back to what it was, with other dates: a done parent the
 * timer reopened is done again once its last open subtask is, and gets back its own `@done`.
 */
function statusBack(now: string, s: StartedLine): string | undefined {
  const [was, set, is] = [s.before, s.after, now].map(lineState);
  if (!was || !set || !is) return undefined;
  if (is.title !== set.title && (is.id === undefined || is.id !== set.id)) return undefined;
  const asSet = (k: string) => is.attrs.get(k) === set.attrs.get(k);
  const asLeft = is.status === set.status && STATUS_ATTRS.every(asSet);
  if (!asLeft && is.status !== was.status) return undefined;
  const e = new TaskLineEditor(now).setStatusChar(was.status);
  for (const k of STATUS_ATTRS)
    if (was.attrs.get(k) !== set.attrs.get(k)) e.setAttr(k, was.attrs.get(k));
  return e.toString();
}

/** The attributes a status change sets or removes along with the checkbox (see applyStatus). */
const STATUS_ATTRS = ["started", "done", "blocked"];

interface LineState {
  status: string;
  /** The first value of each of the STATUS_ATTRS on the line. */
  attrs: Map<string, string>;
  title: string;
  id?: string;
}

function lineState(text: string): LineState | undefined {
  const cb = matchCheckbox(text);
  if (!cb) return undefined;
  const state: LineState = { status: cb.statusChar, attrs: new Map(), title: "" };
  const title: string[] = [];
  for (const t of cb.tokens) {
    if (t.kind === "attr" && STATUS_ATTRS.includes(t.key) && !state.attrs.has(t.key))
      state.attrs.set(t.key, t.value);
    else if (t.kind === "text") title.push(t.text);
    else if (t.kind === "id") state.id = t.id;
  }
  state.title = title.join(" ");
  return state;
}
