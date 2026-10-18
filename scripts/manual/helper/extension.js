// Helper extension for the user manual screenshots (scripts/manual/capture.mjs), loaded next to
// md-planner with a second --extensionDevelopmentPath. It pins "today" through the extension API so
// every screenshot shows the same schedule, and answers AI requests with recorded replies, because
// the screenshot instance of VS Code has no language model. Never packaged.
/* global require, module, process, setTimeout */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- VS Code loads extensions as CommonJS
const vscode = require("vscode");

/** Recorded AI replies per request purpose (JSON matching the schemas in src/ai/schemas.ts). */
const REPLIES = {
  "break down task": {
    subtasks: [
      {
        ref: "N1",
        title: "Invoice drafts and numbering",
        estimate: "6h",
        tags: ["billing"],
        owner: "sam",
        dependsOn: [],
        notes: "",
      },
      {
        ref: "N2",
        title: "Issue and send invoices with VAT rules",
        estimate: "12h",
        tags: ["billing"],
        owner: "sam",
        dependsOn: ["N1"],
        notes: "VAT rates and rounding come from the finance spreadsheet.",
      },
      {
        ref: "N3",
        title: "Credit notes",
        estimate: "8h",
        tags: ["billing"],
        owner: "sam",
        dependsOn: ["N2"],
        notes: "",
      },
      {
        ref: "N4",
        title: "Invoice PDF layout",
        estimate: "6h",
        tags: ["billing"],
        owner: "sam",
        dependsOn: ["N3"],
        notes: "",
      },
      {
        ref: "N5",
        title: "Invoice end-to-end test",
        estimate: "8h",
        tags: ["billing", "test"],
        owner: "maria",
        dependsOn: ["N4"],
        notes: "",
      },
    ],
    rationale:
      "One subtask per invoice step so each step can be tested on its own; 40 h in total, as the original 5d estimate.",
  },
  "suggest owners": {
    assignments: [
      {
        id: "T112",
        owner: "alex",
        reason:
          "Owns the account services T110 and T111 it depends on; skills backend and architecture.",
      },
      {
        id: "T209",
        owner: "priya",
        reason: "Frontend developer (skill frontend) with free capacity after the pages.",
      },
    ],
  },
};

async function activate() {
  const planner = vscode.extensions.getExtension("acro.md-planner");
  if (!planner) return;
  const api = await planner.activate();
  const today = process.env.MD_PLANNER_MANUAL_TODAY;
  if (today) api.setToday(today);
  api.ai.useProvider({
    label: "recorded replies (manual screenshots)",
    async complete(request) {
      const reply = REPLIES[request.purpose];
      if (!reply) throw new Error(`No recorded reply for "${request.purpose}".`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return JSON.stringify(reply);
    },
  });
}

module.exports = { activate, deactivate() {} };
