// An agent entering a project that is already under way gives finished work its real day.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpSession, startServer } from "./server";

let s: McpSession;
const call = (name: string, args: Record<string, unknown> = {}) => s.call(name, args);
const M5 = "milestones/M5-launch.md";
const line = (rel: string, title: string) =>
  s
    .file(rel)
    .split("\n")
    .find((l) => l.includes(title));

beforeAll(async () => {
  s = await startServer();
}, 60_000);

afterAll(async () => {
  await s?.close();
});

describe("MCP done and started dates", () => {
  it("creates finished and ongoing work with its real days", async () => {
    const r = await call("create_tasks", {
      milestone: "M5",
      tasks: [
        { title: "Old kick-off", status: "done", estimate: "4h", done: "2026-10-01" },
        { title: "Ongoing audit", status: "doing", estimate: "2d", started: "2026-10-05" },
      ],
    });
    expect(r.isError).toBe(false);
    expect(line(M5, "Old kick-off")).toContain("@done:2026-10-01");
    expect(line(M5, "Ongoing audit")).toContain("@started:2026-10-05");
  });

  it("finishes a task on its real day, and corrects the day of one that is done", async () => {
    const created = (
      await call("create_tasks", {
        milestone: "M5",
        tasks: [{ title: "Smoke test", estimate: "2h" }],
      })
    ).json;
    const id = created.created[0].id;
    // M5 waits for M4, which still has open work: finishing it needs startEarly, as always.
    const fin = await call("update_task", {
      id,
      status: "done",
      done: "2026-10-02",
      startEarly: true,
    });
    expect(fin.isError).toBe(false);
    expect(line(M5, "Smoke test")).toContain("@done:2026-10-02");
    expect((await call("update_task", { id, done: "2026-10-03" })).isError).toBe(false);
    expect(line(M5, "Smoke test")).toContain("@done:2026-10-03");
  });

  it("refuses days that cannot be: after today, a start after the finish, a done date on open work", async () => {
    const future = await call("create_tasks", {
      milestone: "M5",
      tasks: [{ title: "Too early", status: "done", done: "2099-01-01" }],
    });
    expect(future.isError).toBe(true);
    expect(future.text).toContain("is after today");
    const reversed = await call("create_tasks", {
      milestone: "M5",
      tasks: [{ title: "Reversed", status: "done", started: "2026-10-05", done: "2026-10-01" }],
    });
    expect(reversed.isError).toBe(true);
    expect(reversed.text).toContain("is after done");
    const open = (await call("create_tasks", { milestone: "M5", tasks: [{ title: "Still open" }] }))
      .json;
    const r = await call("update_task", { id: open.created[0].id, done: "2026-10-01" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("a done date needs status done");
  });
});
