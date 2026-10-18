import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type McpSession, startServer } from "./server";

const sessions: McpSession[] = [];
async function empty(): Promise<McpSession> {
  const s = await startServer({ sample: false });
  sessions.push(s);
  return s;
}

afterAll(async () => {
  for (const s of sessions) await s.close();
});

const DESCRIPTION = {
  project: {
    name: "Mobile App 3",
    code: "P-2026-030",
    start: "2026-10-19",
    end: "2027-03-31",
    holidays: ["2026-12-25", "2026-12-26"],
  },
  people: [
    { name: "Alex", role: "Project lead", capacity: "32h/week", skills: ["backend"] },
    { name: "Sam", role: "Backend developer", timeOff: ["2026-11-16..2026-11-20"] },
    { name: "Priya", role: "Frontend developer" },
  ],
  milestones: [
    {
      name: "Discovery",
      target: "2026-11-20",
      sections: [
        {
          title: "Specification",
          tasks: [
            {
              ref: "integration",
              title: "Integration inventory (APIs, SSO, CRM)",
              estimate: "3d",
              owner: "Sam",
            },
            {
              ref: "spec",
              title: "Specification document",
              owner: "alex",
              dependsOn: ["integration"],
              subtasks: [
                { ref: "stories", title: "User stories and acceptance criteria", estimate: "2d" },
                { title: "Internal review", estimate: "4h", dependsOn: ["stories"] },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "Backend",
      target: "2027-01-29",
      depends: ["Discovery"],
      tasks: [
        {
          ref: "lib",
          title: "Shared API library",
          estimate: "1w",
          owner: "sam",
          dependsOn: ["spec+2d"],
        },
        { title: "Services", estimate: "2w", owner: "Sam", dependsOn: ["lib"], priority: "high" },
      ],
    },
    {
      name: "Frontend",
      target: "2027-02-12",
      tasks: [
        {
          title: "Screens",
          estimate: "2w",
          owner: "Priya",
          dependsOn: ["Integration inventory (APIs, SSO, CRM)"],
        },
      ],
    },
  ],
  inbox: ["Ask for the payment provider keys #customer"],
};

describe("building a plan from nothing", () => {
  it("says there is no plan and offers the templates", async () => {
    const s = await empty();
    const o = (await s.call("get_plan_overview")).json;
    expect(o.exists).toBe(false);
    expect((await s.call("list_tasks")).text).toContain("There is no plan");
    const names = (await s.call("list_templates")).json.map((t: { name: string }) => t.name);
    expect(names).toEqual(["empty", "blank", "software"]);
  });

  it("checks with a dry run, then builds everything in one call", async () => {
    const s = await empty();
    const dry = (await s.call("build_plan", { ...DESCRIPTION, dryRun: true })).json;
    expect(dry.dryRun).toBe(true);
    expect(dry.wouldFail).toEqual([]);
    expect(dry.created.tasks).toHaveLength(7);
    expect(existsSync(join(s.planDir, "project.md"))).toBe(false);

    const r = (await s.call("build_plan", DESCRIPTION)).json;
    expect(r.created).toMatchObject({
      project: true,
      people: ["alex", "sam", "priya"],
      milestones: ["M1", "M2", "M3"],
    });
    expect(r.created.tasks.map((t: { ref?: string; id: string }) => [t.ref, t.id])).toEqual([
      ["integration", "T1"],
      ["spec", "T2"],
      ["stories", "T3"],
      [undefined, "T4"],
      ["lib", "T5"],
      [undefined, "T6"],
      [undefined, "T7"],
    ]);
    expect(r.milestones.map((m: { id: string; late: boolean }) => [m.id, m.late])).toEqual([
      ["M1", false],
      ["M2", false],
      ["M3", false],
    ]);
    expect(s.file("project.md")).toContain(
      "# Mobile App 3\n\ncode: P-2026-030\nstart: 2026-10-19\nend: 2027-03-31"
    );
    expect(s.file("project.md")).toContain("holidays: 2026-12-25, 2026-12-26");
    expect(s.file("team.md")).toContain(
      "## Sam\n\nid: sam\nrole: Backend developer\noff: 2026-11-16..2026-11-20\n"
    );
    expect(s.file("milestones/M1-discovery.md")).toBe(
      "# M1 – Discovery\n\nid: M1\ntarget: 2026-11-20\nstatus: planned\n\n## Specification\n\n- [ ] Integration inventory (APIs, SSO, CRM) @est:3d @owner:sam ^T1\n- [ ] Specification document @owner:alex @dep:T1 ^T2\n  - [ ] User stories and acceptance criteria @est:2d ^T3\n  - [ ] Internal review @est:4h @dep:T3 ^T4\n"
    );
    expect(s.file("milestones/M2-backend.md")).toContain(
      "depends: M1\n\n- [ ] Shared API library @est:1w @owner:sam @dep:T2+2d ^T5\n- [ ] Services @est:2w @owner:sam @dep:T5 @prio:high ^T6\n"
    );
    expect(s.file("milestones/M3-frontend.md")).toContain(
      "- [ ] Screens @est:2w @owner:priya @dep:T1 ^T7"
    );
    expect(s.file("inbox.md")).toContain("- [ ] Ask for the payment provider keys #customer");
    expect((await s.call("validate_plan")).json.errors).toBe(0);
  });

  it("extends an existing plan and refuses invalid input without writing", async () => {
    const s = await empty();
    await s.call("build_plan", DESCRIPTION);
    const before = s.file("milestones/M2-backend.md");
    const bad = await s.call("build_plan", {
      milestones: [
        { id: "M2", tasks: [{ title: "Unit tests", owner: "nobody", dependsOn: ["ghost"] }] },
        { name: "Bad dates", target: "31.03.2027" },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("invalid target date");
    expect(s.file("milestones/M2-backend.md")).toBe(before);
    const more = (
      await s.call("build_plan", {
        people: [
          { name: "Sam", capacity: "36h/week" },
          { name: "Maria", role: "Test engineer" },
        ],
        milestones: [
          {
            id: "M2",
            status: "active",
            sections: [
              {
                title: "Tests",
                tasks: [{ title: "Unit tests", owner: "Maria", dependsOn: ["Services"] }],
              },
            ],
          },
          {
            name: "Acceptance test",
            target: "2027-03-05",
            depends: ["M2", "Frontend"],
            tasks: [
              {
                title: "Acceptance test with key users",
                estimate: "3d",
                dependsOn: ["Unit tests"],
              },
            ],
          },
        ],
      })
    ).json;
    expect(more.created.people).toEqual(["maria"]);
    expect(more.updated.people).toEqual(["sam"]);
    expect(more.created.milestones).toEqual(["M4"]);
    expect(more.updated.milestones).toEqual(["M2"]);
    expect(s.file("milestones/M2-backend.md")).toContain("status: active");
    expect(s.file("milestones/M2-backend.md")).toContain(
      "## Tests\n\n- [ ] Unit tests @owner:maria @dep:T6 ^T8\n"
    );
    expect(s.file("milestones/M4-acceptance-test.md")).toContain(
      "depends: M2, M3\n\n- [ ] Acceptance test with key users @est:3d @dep:T8 ^T9\n"
    );
    expect((await s.call("create_project", { name: "Again" })).text).toContain("already a plan");
  });

  it("creates a project from the software template", async () => {
    const s = await empty();
    const r = (
      await s.call("create_project", {
        name: "Mobile App",
        template: "software",
        lead: "Robin Lee",
        start: "2026-11-02",
      })
    ).json;
    expect(r.template).toBe("software");
    const o = (await s.call("get_plan_overview")).json;
    expect(o.milestones.map((m: { id: string }) => m.id)).toEqual(["M1", "M2", "M3", "M4", "M5"]);
    expect(o.people.map((p: { id: string }) => p.id)).toEqual(["robin-lee"]);
    expect(o.tests.map((t: { id: string }) => t.id)).toEqual(["UAT-01"]);
  });
});
