// Deterministic generator of a large, realistic plan for performance checks (unit benchmark,
// extension integration test and scripts/perf). Default: 20 milestones × 5 sections × 20 task
// lines = 2,000 tasks, with subtasks, dependencies (some with lag), constraints, finished work
// with actuals, a test plan and a punch list.

export interface LargePlanOptions {
  /** Number of milestones (100 task lines each). Default 20 → 2,000 tasks. */
  milestones?: number;
  /** Owner ids. Default: eight generated people (team.md is written for them). */
  people?: string[];
  /** First milestone number (M<n>) and first task number (T<n>), to avoid clashes. */
  milestoneStart?: number;
  taskStart?: number;
  /** Write project.md, team.md, a test plan and a punch list too. Default true. */
  standalone?: boolean;
  /** File name prefix for the milestone files. Default "M". */
  filePrefix?: string;
}

export const LARGE_PLAN_TODAY = "2026-10-14";

const DEFAULT_PEOPLE = ["ann", "bob", "cyd", "dee", "eve", "fay", "gus", "hal"];
const TAGS = ["backend", "frontend", "integration", "notifications", "test", "docs"];
const UNITS = ["Accounts", "Checkout", "Billing", "Reporting", "Admin"];

/** Small deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDate(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Returns { plan-relative path: text } for the generated plan. */
export function largePlanFiles(options: LargePlanOptions = {}): Record<string, string> {
  const milestones = options.milestones ?? 20;
  const people = options.people ?? DEFAULT_PEOPLE;
  const mStart = options.milestoneStart ?? 1;
  const tStart = options.taskStart ?? 1;
  const standalone = options.standalone ?? true;
  const prefix = options.filePrefix ?? "M";
  const rnd = random(20261014);
  const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)];
  const files: Record<string, string> = {};

  if (standalone) {
    files["project.md"] = [
      "# Large plan",
      "",
      "code: P-PERF",
      "start: 2026-01-05",
      "end: 2027-12-17",
      "workweek: mon-fri",
      "hoursPerDay: 8",
      "holidays: 2026-12-25, 2026-12-26, 2027-01-01",
      "",
      "Generated plan for performance checks.",
      "",
    ].join("\n");
    files["team.md"] = [
      "# Team",
      "",
      ...people.flatMap((id, i) => [
        `## ${id[0].toUpperCase()}${id.slice(1)}`,
        "",
        `id: ${id}`,
        `capacity: ${i % 3 === 0 ? 32 : 40}h/week`,
        `skills: ${TAGS[i % TAGS.length]}, ${TAGS[(i + 2) % TAGS.length]}`,
        ...(i % 2 === 0 ? [`off: ${isoDate("2026-11-02", i * 7)}..${isoDate("2026-11-06", i * 7)}`] : []),
        "",
      ]),
    ].join("\n");
  }

  let n = tStart - 1;
  const today = LARGE_PLAN_TODAY;
  for (let m = 0; m < milestones; m++) {
    const mid = mStart + m;
    // The first quarter of the milestones is finished, the next one in progress, the rest open.
    const phase = m < milestones / 4 ? "done" : m < milestones / 4 + 1 ? "active" : "planned";
    const lines = [
      `# M${mid} – Work package ${mid}`,
      "",
      `id: M${mid}`,
      `target: ${isoDate("2026-03-02", m * 35)}`,
      `status: ${phase}`,
      ...(m > 0 ? [`depends: M${mid - 1}`] : []),
      "",
      `Work package ${mid}: control modules, phases, HMI and tests for one unit.`,
      "",
    ];
    for (let s = 0; s < 5; s++) {
      lines.push(`## ${UNITS[s]}`, "");
      const sectionFirst = n + 1;
      for (let i = 0; i < 20; ) {
        const owner = pick(people);
        const tag = pick(TAGS);
        const est = `${[2, 4, 6, 8, 12, 16][Math.floor(rnd() * 6)]}h`;
        const parent = i === 0;
        n++;
        const id = n;
        const attrs: string[] = [`@est:${parent ? "2d" : est}`, `@owner:${owner}`];
        if (id > sectionFirst && rnd() < 0.45) {
          const back = 1 + Math.floor(rnd() * Math.min(4, id - sectionFirst));
          attrs.push(`@dep:T${id - back}${rnd() < 0.1 ? "+1d" : ""}`);
        }
        if (phase === "planned" && rnd() < 0.05) attrs.push(`@start:${isoDate("2027-02-01", m * 7)}`);
        if (rnd() < 0.05) attrs.push(`@due:${isoDate("2026-12-01", m * 14)}`);
        if (rnd() < 0.08) attrs.push("@prio:high");
        let box = " ";
        if (phase === "done") {
          box = "x";
          const done = isoDate("2026-01-12", m * 21 + s * 3 + (i % 3));
          attrs.push(`@act:${Math.round((parseFloat(est) * (0.7 + rnd() * 0.8)) * 2) / 2}h`);
          attrs.push(`@started:${isoDate(done, -2)}`, `@done:${done}`);
        } else if (phase === "active") {
          const r = rnd();
          if (r < 0.3) {
            box = "x";
            attrs.push(`@act:${est}`, `@done:${isoDate(today, -1 - (i % 5))}`);
          } else if (r < 0.45) {
            box = "/";
            attrs.push(`@started:${isoDate(today, -(i % 4))}`, "@progress:40%");
          } else if (r < 0.5) {
            box = "?";
          } else if (r < 0.55) {
            box = "!";
            attrs.push('@blocked:"waiting for the customer"');
          }
        }
        lines.push(`- [${box}] ${parent ? "Design" : "Implement"} ${tag} item ${id} ${attrs.join(" ")} #${tag} ^T${id}`);
        i++;
        if (parent) {
          // Two subtasks under the first task of every section.
          for (let k = 0; k < 2; k++) {
            n++;
            lines.push(`  - [${box === "x" ? "x" : " "}] Step ${k + 1} of T${id} @est:6h${box === "x" ? ` @act:6h @done:${isoDate(today, -30)}` : ""} ^T${n}`);
            i++;
          }
          lines.push("        Notes under a task are its description; they are kept as they are.");
        }
      }
      lines.push("");
    }
    files[`milestones/${prefix}${mid}-work-package.md`] = lines.join("\n");
  }

  if (standalone) {
    const test = ["# FAT – Large plan", "", "id: FAT-LOAD", "type: FAT", `milestone: M${mStart + milestones - 1}`, ""];
    for (let c = 1; c <= 25; c++) {
      test.push(`## TC-${String(c).padStart(2, "0")} Case ${c}`, "");
      for (let k = 1; k <= 4; k++) {
        const result = c <= 10 ? (k === 4 && c % 4 === 0 ? " @result:fail" : " @result:pass") : "";
        test.push(`- [${result ? "x" : " "}] Step ${k} of case ${c}${result}`);
      }
      test.push("");
    }
    files["tests/FAT-LOAD.md"] = test.join("\n");
    const punch = ["# Punch list", ""];
    for (let p = 1; p <= 40; p++) {
      const done = p % 3 === 0;
      punch.push(
        `- [${done ? "x" : " "}] Punch item ${p} @sev:${"ABC"[p % 3]} @owner:${people[p % people.length]}${done ? ` @done:${isoDate(today, -p)}` : ""} @from:FAT-LOAD/TC-${String((p % 10) + 1).padStart(2, "0")} ^P${String(p).padStart(3, "0")}`
      );
    }
    files["punchlist.md"] = punch.join("\n") + "\n";
  }
  return files;
}
