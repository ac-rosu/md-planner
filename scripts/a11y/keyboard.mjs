// Keyboard scenarios for scripts/a11y/check.mjs, against the sample project's view models. Each
// scenario reaches its controls with Tab only, uses the documented keys, and checks the message
// the webview posts to the host. Dialogs must take focus, pass axe, and give focus back.

const ALT = 1;

async function tabTo(c, test, what, max = 200) {
  for (let i = 0; i < max; i++) {
    if (await c.evaluate(`(() => { const el = document.activeElement; return !!(${test}); })()`))
      return;
    await c.press("Tab", "Tab", 0, 9);
  }
  throw new Error(`Tab never reached ${what}`);
}

async function arrowTo(c, key, test, what, max = 120) {
  for (let i = 0; i < max; i++) {
    if (await c.evaluate(`(() => { const el = document.activeElement; return !!(${test}); })()`))
      return;
    await c.press(key, key, 0, key === "ArrowDown" ? 40 : 38);
  }
  throw new Error(`${key} never reached ${what}`);
}

async function lastPosted(c, type) {
  return c.evaluate(`window.__posted.filter((m) => m.type === ${JSON.stringify(type)}).at(-1)`);
}

function expectEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

async function dialogChecks(c, axe) {
  const inside = await c.evaluate(`!!document.activeElement?.closest('[role="dialog"]')`);
  if (!inside) throw new Error("the dialog did not take focus");
  const violations = await axe('[role="dialog"]');
  if (violations.length) throw new Error(`dialog: ${violations.join("; ")}`);
}

export const KEYBOARD_SCENARIOS = [
  {
    view: "gantt",
    name: "tree navigation, Alt+→ moves a bar, F2 edits, Escape returns focus",
    async run(c, axe) {
      await tabTo(c, `el?.getAttribute("role") === "treeitem"`, "the task tree");
      await arrowTo(c, "ArrowDown", `el?.dataset.row === "T105"`, "T105");
      await c.press("ArrowRight", "ArrowRight", ALT, 39);
      const move = await lastPosted(c, "move");
      expectEqual(move, { type: "move", key: "T105", start: "2026-11-11" }, "move");
      await c.press("F2", "F2", 0, 113);
      await dialogChecks(c, axe);
      await c.press("Escape", "Escape", 0, 27);
      const back = await c.evaluate(
        `!document.querySelector('[role="dialog"]') && document.activeElement?.dataset.row === "T105"`
      );
      if (!back) throw new Error("focus did not return to the row after Escape");
    },
  },
  {
    view: "kanban",
    name: "Alt+→ moves a card, the block reason dialog works from the keyboard",
    async run(c, axe) {
      await tabTo(c, `el?.dataset.key === "T005"`, "card T005 (review)");
      await c.press("ArrowRight", "ArrowRight", ALT, 39);
      await dialogChecks(c, axe);
      await c.send("Input.insertText", { text: "waiting for review" });
      await c.press("Enter", "Enter", 0, 13);
      const move = await lastPosted(c, "move");
      if (move?.key !== "T005" || move.status !== "blocked" || move.reason !== "waiting for review")
        throw new Error(`unexpected move ${JSON.stringify(move)}`);
      const back = await c.evaluate(`document.activeElement?.dataset.key === "T005"`);
      if (!back) throw new Error("focus did not return to the card");
    },
  },
  {
    view: "resources",
    name: "one tab stop, arrow keys move between cells, Enter shows the tasks",
    async run(c) {
      await tabTo(c, `el?.classList.contains("cell-btn")`, "the heatmap");
      const label = () => c.evaluate(`document.activeElement.getAttribute("aria-label")`);
      const start = await label();
      await c.press("ArrowRight", "ArrowRight", 0, 39);
      const right = await label();
      if (right === start) throw new Error("ArrowRight did not move");
      await c.press("ArrowDown", "ArrowDown", 0, 40);
      const down = await label();
      if (down.split(",")[0] === right.split(",")[0]) throw new Error("ArrowDown did not move");
      await c.press("Enter", "Enter", 0, 13);
      const details = await c.evaluate(`document.querySelector(".details-title")?.textContent`);
      if (!details?.includes(down.split(",")[0])) throw new Error("Enter did not show the tasks");
      await c.press("Tab", "Tab", 0, 9);
      const left = await c.evaluate(`!document.activeElement?.classList.contains("cell-btn")`);
      if (!left) throw new Error("Tab did not leave the grid (more than one tab stop)");
    },
  },
  {
    view: "testRunner",
    name: "P records a pass on the focused step",
    async run(c) {
      await tabTo(c, `el?.classList.contains("step")`, "a test step");
      const key = await c.evaluate(`document.activeElement.getAttribute("aria-label")`);
      await c.press("p", "KeyP", 0, 80);
      const result = await lastPosted(c, "result");
      if (result?.result !== "pass") throw new Error(`unexpected result ${JSON.stringify(result)}`);
      if (!key) throw new Error("the step has no accessible name");
    },
  },
  {
    view: "dashboard",
    name: "toolbar opens views, list items reveal tasks",
    async run(c) {
      await tabTo(c, `el?.tagName === "BUTTON" && el.textContent.includes("Gantt")`, "Gantt");
      await c.press("Enter", "Enter", 0, 13);
      expectEqual(await lastPosted(c, "open"), { type: "open", view: "gantt" }, "open");
      await tabTo(c, `el?.tagName === "A" && el.closest(".list")`, "a list item");
      await c.press("Enter", "Enter", 0, 13);
      const reveal = await lastPosted(c, "reveal");
      if (!reveal?.key) throw new Error("Enter on a list item did not reveal a task");
    },
  },
];
