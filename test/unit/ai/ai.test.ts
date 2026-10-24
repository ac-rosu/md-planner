import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../../src/ai/anthropic";
import {
  breakDownProposal,
  breakDownRequest,
  calibrateProposal,
  calibrateRequest,
  calibrationRows,
  estimateProposal,
  estimateRequest,
  ownersProposal,
  ownersRequest,
  planFromTextProposal,
  planFromTextRequest,
  readSummary,
  reviewMarkdown,
  scheduleReviewRequest,
  statusSummaryRequest,
  unassignedTasks,
} from "../../../src/ai/commands";
import { AiError, parseJsonReply, redact } from "../../../src/ai/provider";
import { BREAKDOWN_SCHEMA, PLAN_FROM_TEXT_SCHEMA } from "../../../src/ai/schemas";
import { schedulePlan } from "../../../src/core/scheduler";
import { applyEdits } from "../../../src/core/text";
import { type FileEdit } from "../../../src/core/writer";
import { loadSample, task, TODAY } from "../helpers";

const plan = loadSample().plan;
const schedule = schedulePlan(plan, { today: TODAY });
const demand = schedulePlan(plan, { today: TODAY, mode: "demand" });

function applied(edits: FileEdit[], path: string): string {
  const fe = edits.find((e) => e.path === path)!;
  return applyEdits(plan.file(path)!.lines.serialize(), fe.edits);
}

describe("reply parsing and redaction", () => {
  it("parses JSON with or without fences and prose", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('Here:\n```json\n{"a": [1]}\n```')).toEqual({ a: [1] });
    expect(parseJsonReply('Sure! {"a": 2} hope it helps')).toEqual({ a: 2 });
    expect(() => parseJsonReply("no json")).toThrow(AiError);
  });

  it("redacts literal terms case-insensitively and regex patterns", () => {
    expect(redact("Portal Acme release 3 for ACME", ["acme"])).toBe(
      "Portal [redacted] release 3 for [redacted]"
    );
    expect(redact("PO 4500012345 and PO 4500099999", ["/45\\d{8}/"])).toBe(
      "PO [redacted] and PO [redacted]"
    );
    expect(redact("a.b", ["."])).toBe("a[redacted]b");
    expect(redact("x", ["/([/"])).toBe("x");
  });

  it("has strict schemas (all properties required, no extras)", () => {
    expect(BREAKDOWN_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ["subtasks", "rationale"],
    });
    const item = (
      PLAN_FROM_TEXT_SCHEMA.properties as Record<string, { items: { required: string[] } }>
    ).tasks.items;
    expect(item.required).toContain("parent");
  });
});

describe("break down", () => {
  const t = task(plan, "T107");

  it("sends the task, its milestone, the team and the project skeleton", () => {
    const r = breakDownRequest(plan, schedule, t);
    expect(r.prompt).toContain('Break down task T107 "Checkout flow (cart, pay, confirm)"');
    expect(r.prompt).toContain("Milestone M2: M2 – Backend (target 2026-12-15)");
    expect(r.prompt).toContain("- sam (Sam, Backend developer)");
    expect(r.prompt).toContain("Typical project work");
    expect(r.system).toContain("Never invent or compute dates");
  });

  it("turns the reply into subtasks with new ids, mapped dependencies and validated values", () => {
    const p = breakDownProposal(plan, t, {
      rationale: "Three steps plus integration.",
      subtasks: [
        {
          ref: "N1",
          title: "Cart step",
          estimate: "12h",
          tags: ["#Checkout"],
          owner: "",
          dependsOn: [],
          notes: "",
        },
        {
          ref: "N2",
          title: "Payment step",
          estimate: "1.5d",
          tags: [],
          owner: "sam",
          dependsOn: ["N1"],
          notes: "Reuse the payment client.",
        },
        {
          ref: "N3",
          title: "Confirmation step",
          estimate: "soon",
          tags: [],
          owner: "zed",
          dependsOn: ["N2", "T999", "T105"],
          notes: "",
        },
      ],
    });
    expect(p.warnings).toEqual([
      '"Confirmation step": invalid estimate "soon" dropped.',
      '"Confirmation step": unknown owner "zed" dropped.',
      '"Confirmation step": unknown dependency "T999" dropped.',
    ]);
    const out = applied(p.edits, "milestones/M2-backend.md");
    expect(out).toContain(
      [
        "- [ ] Checkout flow (cart, pay, confirm) @est:1w @owner:alex @dep:T102,T105 @eq:checkout #checkout ^T107",
        "  - [ ] Cart step @est:12h #checkout ^T408",
        "  - [ ] Payment step @est:1.5d @owner:sam @dep:T408 ^T409",
        "        Reuse the payment client.",
        "  - [ ] Confirmation step @dep:T409,T105 ^T410",
        "- [ ] Checkout integration tests",
      ].join("\n")
    );
    expect(p.notes[0]).toBe("Three steps plus integration.");
    expect(() => breakDownProposal(plan, t, { subtasks: [], rationale: "" })).toThrow(
      /no subtasks/
    );
  });
});

describe("estimate", () => {
  const targets = [task(plan, "T121"), task(plan, "T122")];

  it("includes reference tasks and estimate accuracy", () => {
    const r = estimateRequest(plan, targets);
    expect(r.prompt).toContain("- T121 | Shared API library");
    expect(r.prompt).toContain("person alex: actual/estimate 1.14 (n = 4)");
    expect(r.prompt).not.toMatch(/Estimated tasks in this plan \(reference\):[\s\S]*- T121 \|/);
  });

  it("writes valid estimates and rejects the rest", () => {
    const p = estimateProposal(plan, targets, {
      estimates: [
        { id: "T121", estimate: "4d", rationale: "Library of 12 CM types." },
        { id: "T122", estimate: "lots", rationale: "?" },
        { id: "T001", estimate: "1h", rationale: "not asked" },
      ],
    });
    expect(p.warnings).toEqual([
      'T122: invalid estimate "lots" ignored.',
      'Estimate for unknown or unrequested task "T001" ignored.',
    ]);
    expect(applied(p.edits, "milestones/M2-backend.md")).toContain(
      "- [ ] Shared API library (auth, validation, logging) @est:4d @owner:sam #backend ^T121"
    );
    expect(p.notes).toEqual([
      "T121 Shared API library (auth, validation, logging): @est:4d — Library of 12 CM types.",
    ]);
  });
});

describe("calibrate", () => {
  it("computes calibrated estimates deterministically and lets the AI comment and skip", () => {
    const { rows, accuracy } = calibrationRows(plan);
    expect(rows.map((r) => [r.key, r.raw, r.calibrated, r.value])).toEqual([
      ["T012", 4, 4.5, "4.5h"],
      ["T107", 40, 45.5, "45.5h"],
      ["T110", 32, 36.5, "36.5h"],
      ["T111", 24, 27.5, "27.5h"],
      ["T304", 24, 27.5, "27.5h"],
      ["T403", 40, 45.5, "45.5h"],
    ]);
    expect(rows[0].basis).toBe("Alex ×1.14 (n = 4)");
    const req = calibrateRequest(plan, rows, accuracy);
    expect(req.prompt).toContain(
      "T304 Acceptance test with key users: 24h → 27.5h (Alex ×1.14 (n = 4))"
    );
    const p = calibrateProposal(plan, rows, {
      insights: ["Alex's tasks take 14% longer than estimated (n = 4)."],
      skip: [
        { id: "T304", reason: "FAT duration is fixed by the customer." },
        { id: "T999", reason: "?" },
      ],
    });
    expect(p.notes[0]).toBe("Alex's tasks take 14% longer than estimated (n = 4).");
    expect(p.notes).toContain(
      "T304 Acceptance test with key users: kept at 24h — FAT duration is fixed by the customer."
    );
    expect(p.warnings).toEqual(['Skip for unknown task "T999" ignored.']);
    expect(applied(p.edits, "milestones/M1-discovery-design.md")).toContain(
      "Stakeholder sign-off @est:4.5h @owner:alex"
    );
    expect(p.edits.find((e) => e.path === "milestones/M4-acceptance-test.md")).toBeUndefined();
  });
});

describe("suggest owners", () => {
  const tasks = unassignedTasks(plan);

  it("asks only about unassigned tasks, with skills, load and time off", () => {
    expect(tasks.map((t) => t.id)).toEqual(["T112", "T209"]);
    const r = ownersRequest(plan, schedule, tasks);
    expect(r.prompt).toContain("time off 2026-12-22..2027-01-02");
    expect(r.prompt).toMatch(/scheduled load 2026-W42 \d+\/\d+h/);
  });

  it("requires a known person and a reason for every assignment", () => {
    const p = ownersProposal(plan, tasks, {
      assignments: [
        { id: "T112", owner: "alex", reason: "Owns the account services." },
        { id: "T209", owner: "priya", reason: "" },
      ],
    });
    expect(p.warnings).toEqual([
      "T209: assignment to priya without an explanation ignored.",
      "T209: no owner proposed.",
    ]);
    expect(applied(p.edits, "milestones/M2-backend.md")).toContain(
      "- [ ] Password reset and e-mail verification @est:12h @owner:alex @dep:T111 #accounts ^T112"
    );
  });
});

describe("plan from text", () => {
  const m3 = plan.milestoneById("M3")!;

  it("adds a new section with tasks and subtasks", () => {
    expect(planFromTextRequest(plan, m3, "Customer wants a usage report page.").prompt).toContain(
      "<<<\nCustomer wants a usage report page.\n>>>"
    );
    const p = planFromTextProposal(plan, m3, {
      section: "Reporting",
      tasks: [
        {
          ref: "N1",
          title: "Usage report page",
          estimate: "2d",
          tags: ["frontend"],
          owner: "priya",
          dependsOn: ["T201"],
          notes: "",
          parent: "",
        },
        {
          ref: "N2",
          title: "Report layout",
          estimate: "4h",
          tags: [],
          owner: "",
          dependsOn: [],
          notes: "",
          parent: "N1",
        },
        {
          ref: "N3",
          title: "Export to PDF",
          estimate: "6h",
          tags: [],
          owner: "",
          dependsOn: ["N2"],
          notes: "",
          parent: "N1",
        },
      ],
    });
    expect(p.warnings).toEqual([]);
    expect(
      applied(p.edits, "milestones/M3-frontend.md").endsWith(
        [
          "## Reporting",
          "",
          "- [ ] Usage report page @est:2d @owner:priya @dep:T201 #frontend ^T408",
          "  - [ ] Report layout @est:4h ^T409",
          "  - [ ] Export to PDF @est:6h @dep:T409 ^T410",
          "",
        ].join("\n")
      )
    ).toBe(true);
  });
});

describe("summary and review", () => {
  it("builds the status summary prompt from computed metrics only", () => {
    const r = statusSummaryRequest(plan, schedule, undefined, 7);
    expect(r.prompt).toContain(
      "Overall: 9% complete (hours-weighted); forecast finish 2027-03-31, planned end 2027-03-31 (on time)"
    );
    expect(r.prompt).toContain(
      "- M5 – Launch: 0% done, target 2027-03-26, forecast 2027-03-31 (3 d late)"
    );
    expect(r.prompt).toContain(
      "Blocked: Payment form (waiting for the payment provider API keys · Priya · can stay blocked until 2026-12-14)."
    );
    expect(r.prompt).toContain(
      "Hours: budget 800 h; planned 820 h; logged 82 h; forecast 826 h (26 h over budget). Why over: The estimates add up to 820 h, 20 h over the budget."
    );
    expect(readSummary({ summary: " On track. " })).toBe("On track.");
    expect(() => readSummary({ summary: "" })).toThrow();
  });

  it("builds the schedule review from the computed schedule and renders the risks", () => {
    const r = scheduleReviewRequest(plan, schedule, demand);
    expect(r.prompt).toContain("- sam: 2026-W43, 2026-W44");
    expect(r.prompt).toContain(
      "Critical path:\n- T304 Acceptance test with key users 2027-02-01..2027-02-04 (alex)"
    );
    const md = reviewMarkdown(
      plan,
      {
        risks: [
          { severity: "low", title: "Small", detail: "x", tasks: [] },
          { severity: "high", title: "M5 late", detail: "3 days late", tasks: ["T407", "M5"] },
        ],
      },
      TODAY,
      "test model"
    );
    expect(md).toContain(
      "## HIGH: M5 late\n\n3 days late\n\n- `T407` Release notes and runbook\n- `M5`"
    );
    expect(md.indexOf("HIGH")).toBeLessThan(md.indexOf("LOW"));
  });
});

describe("Anthropic provider", () => {
  type CreateParams = Record<string, unknown>;
  const fake = (reply: Partial<Anthropic.Beta.BetaMessage> | Error) => {
    const calls: CreateParams[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: CreateParams) => {
            calls.push(params);
            if (reply instanceof Error) throw reply;
            return {
              stop_reason: "end_turn",
              stop_details: null,
              content: [{ type: "text", text: '{"summary":"ok"}' }],
              ...reply,
            };
          },
        },
      },
    } as unknown as Pick<Anthropic, "beta">;
    return { client, calls };
  };
  const request = { purpose: "t", system: "sys", prompt: "p", schema: { type: "object" } };

  it("uses structured output, the default model and the server-side refusal fallback", async () => {
    const { client, calls } = fake({});
    const p = new AnthropicProvider({ apiKey: "k", client });
    expect(p.label).toBe("Claude API (claude-sonnet-5-5)");
    expect(await p.complete(request)).toBe('{"summary":"ok"}');
    expect(calls[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system: "sys",
      messages: [{ role: "user", content: "p" }],
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const other = fake({});
    await new AnthropicProvider({
      apiKey: "k",
      client: other.client,
      model: "claude-haiku-5-5",
    }).complete(request);
    expect(other.calls[0]).not.toHaveProperty("fallbacks");
  });

  it("reports refusals, truncation and API errors as readable errors", async () => {
    await expect(
      new AnthropicProvider({
        apiKey: "k",
        client: fake({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: null } as never,
        }).client,
      }).complete(request)
    ).rejects.toThrow("The model declined this request (cyber). Nothing was changed.");
    await expect(
      new AnthropicProvider({
        apiKey: "k",
        client: fake({ stop_reason: "max_tokens" }).client,
      }).complete(request)
    ).rejects.toThrow(/cut off/);
    const auth = new Anthropic.AuthenticationError(
      401,
      undefined,
      "invalid x-api-key",
      new Headers()
    );
    await expect(
      new AnthropicProvider({ apiKey: "k", client: fake(auth).client }).complete(request)
    ).rejects.toThrow('The Claude API key was rejected. Run "Planner: Set API key".');
    const rate = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    await expect(
      new AnthropicProvider({ apiKey: "k", client: fake(rate).client }).complete(request)
    ).rejects.toThrow(/rate-limiting/);
  });
});
