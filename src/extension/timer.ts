// Time tracking: one running timer per workspace, shown in the status bar; stopping it adds the
// rounded time to the task's @act. `Planner: Log time` adds hours manually.
import * as vscode from "vscode";
import { type Task } from "../core/model";
import { findTaskByKey, taskKey } from "../core/scheduler";
import { addActual, formatElapsed, parseLoggedTime, roundMinutes } from "../core/time";
import { editTaskLine, setStatus } from "../core/writer";
import { resolveTask, type TaskArg } from "./commands/args";
import { confirmEarlyStart, rollUpParents } from "./commands/status";
import { type PlanService } from "./planService";
import { config } from "./util";

export interface RunningTimer {
  key: string;
  title: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** The timer moved the task from to do to in progress (undone when nothing is logged). */
  startedTask?: boolean;
  /** Keys of the parents that followed the task to in progress (undone along with it). */
  startedParents?: string[];
}

const STATE_KEY = "planner.timer";

export class TimerService implements vscode.Disposable {
  readonly item = vscode.window.createStatusBarItem(
    "planner.timer",
    vscode.StatusBarAlignment.Left,
    49
  );
  private readonly interval: ReturnType<typeof setInterval>;
  /** Clock, replaceable in tests. */
  now: () => number = () => Date.now();

  constructor(
    private readonly service: PlanService,
    private readonly memento: vscode.Memento
  ) {
    this.item.name = "Planner: timer";
    this.item.command = "planner.stopTimer";
    this.interval = setInterval(() => this.render(), 30_000);
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
    if (this.running) await this.stop();
    const t = resolveTask(this.service, taskKey(r.task))?.task ?? r.task;
    // Starting work on a task that is still "to do" moves it (and its to-do parents) to "in progress".
    const rollUp = t.status === "todo" && rollUpParents();
    const parents: string[] = [];
    for (let p = t.parent; rollUp && p?.status === "todo"; p = p.parent) parents.push(taskKey(p));
    await this.memento.update(STATE_KEY, {
      key: taskKey(t),
      title: t.title,
      startedAt: this.now(),
      startedTask: t.status === "todo",
      startedParents: parents.length ? parents : undefined,
    } satisfies RunningTimer);
    if (t.status === "todo") {
      const file = this.service.plan.file(t.file)!;
      const edits = setStatus(file.lines, t, "doing", this.service.today(), { rollUp });
      await this.service.apply([{ path: t.file, edits }], { source: "view" });
    }
    this.render();
    return true;
  }

  /** Stops the running timer and adds the rounded time to @act. Returns the hours added. */
  async stop(): Promise<number | undefined> {
    const running = this.running;
    if (!running) return undefined;
    await this.memento.update(STATE_KEY, undefined);
    this.render();
    const minutes = (this.now() - running.startedAt) / 60_000;
    if (minutes < 1) {
      // Started by mistake: put a task the timer moved to in progress back to to do, with the
      // parents that followed it.
      const t = running.startedTask ? findTaskByKey(this.service.plan, running.key) : undefined;
      if (t?.status === "doing") {
        const plan = this.service.plan;
        const back = [t, ...(running.startedParents ?? []).map((k) => findTaskByKey(plan, k))];
        const file = plan.file(t.file)!;
        const edits = back
          .filter((x): x is Task => x?.status === "doing" && x.file === t.file)
          .flatMap((x) => setStatus(file.lines, x, "todo", this.service.today()));
        await this.service.apply([{ path: t.file, edits }], { source: "view" });
      }
      void vscode.window.showInformationMessage(
        t?.status === "doing"
          ? `Planner: timer stopped after less than a minute; nothing logged, ${t.id ?? t.title} is back to To do.`
          : "Planner: timer stopped after less than a minute; nothing logged."
      );
      return 0;
    }
    const rounded = roundMinutes(minutes, config().get<number>("time.roundingMinutes", 15));
    const hours = rounded / 60;
    const t = findTaskByKey(this.service.plan, running.key);
    if (!t) {
      void vscode.window.showWarningMessage(
        `Planner: task ${running.key} no longer exists; ${hours}h not logged.`
      );
      return undefined;
    }
    await this.addHours(t, hours);
    void vscode.window.setStatusBarMessage(`Planner: logged ${hours}h on ${t.id ?? t.title}`, 4000);
    return hours;
  }

  /** Adds hours to a task's @act (asks when not given). */
  async log(arg: TaskArg, value?: string | number): Promise<number | undefined> {
    const r = resolveTask(this.service, arg);
    if (!r) return undefined;
    let hours =
      typeof value === "number" ? value : value !== undefined ? parseLoggedTime(value) : undefined;
    if (hours === undefined) {
      const text = await vscode.window.showInputBox({
        prompt: `Hours spent on ${r.task.id ?? r.task.title} (added to @act)`,
        placeHolder: "e.g. 1.5, 90m, 1h30m",
        validateInput: (v) =>
          parseLoggedTime(v) === undefined
            ? "Enter a positive duration such as 1.5 or 90m"
            : undefined,
      });
      if (!text) return undefined;
      hours = parseLoggedTime(text);
    }
    if (hours === undefined) return undefined;
    await this.addHours(r.task, hours);
    return hours;
  }

  private async addHours(t: Task, hours: number): Promise<void> {
    const file = this.service.plan.file(t.file)!;
    const edits = editTaskLine(file.lines, t, (e) => e.setAttr("act", addActual(t.act, hours)));
    await this.service.apply([{ path: t.file, edits }], { source: "view" });
  }

  render(): void {
    const r = this.running;
    if (!r) {
      this.item.hide();
      return;
    }
    const elapsed = formatElapsed(this.now() - r.startedAt);
    this.item.text = `$(clock) ${r.key} ${elapsed}`;
    this.item.tooltip = `Timer on ${r.key} – ${r.title}\nStarted ${new Date(r.startedAt).toLocaleTimeString()}\nClick to stop and add the time to @act.`;
    this.item.accessibilityInformation = {
      label: `Timer running on ${r.title} for ${elapsed}. Activate to stop.`,
    };
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.interval);
    this.item.dispose();
  }
}
