// Webview screenshots for the user manual: each view of the sample project rendered in headless
// Chrome with the recorded host messages (scripts/manual/models.ts), driven with real input events
// and annotated in the page before capture.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, webviewPage } from "../lib/chrome.mjs";
import { pageTools, sleep } from "./lib.mjs";

const WIDE = 0.5; // full-width shots: 1 image px per CSS px (pages render at 2x)
const CROP = 0.75; // crops: 1.5 image px per CSS px

export async function captureWebviews({ root, out, pages, models, only }) {
  const chrome = await launchChrome();
  const t = pageTools(chrome);
  const img = (name) => join(out, `${name}.png`);
  const bar = (key, part = "rect.bar") => `g.row[data-key="${key}"] ${part}`;
  const card = (key, part = "") => `.card[data-key="${key}"] ${part}`.trim();
  const tb = (text) => ({ sel: ".toolbar .btn", text });
  const label = (text) => ({ sel: ".toolbar label", text });
  /** A crop around a target: margins { l, t, r, b } in CSS px. */
  const around = async (target, m) => {
    const r = await t.waitFor(target);
    return { x: r.x - m.l, y: r.y - m.t, w: r.w + m.l + m.r, h: r.h + m.t + m.b };
  };

  async function open(variant, width, height) {
    await chrome.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const file = join(pages, `${variant}.html`);
    writeFileSync(
      file,
      webviewPage({
        root,
        view: variant.split("-")[0],
        messages: models[variant],
        themeCss: join(root, "scripts/screenshots/theme-dark.css"),
        bodyClass: "vscode-dark",
      })
    );
    await chrome.open(file);
    if (chrome.errors.length) throw new Error(`${variant}: ${chrome.errors.join("\n")}`);
    await sleep(250);
  }

  const shots = {
    // ----------------------------------------------------------------------------- Gantt
    "gantt-overview": async () => {
      await open("gantt", 1500, 860);
      await t.shot(img("gantt-overview"), {
        scale: WIDE,
        annotations: [
          { target: ".toolbar", label: "Toolbar", n: 1, at: "s", d: 4, dx: -380, pad: 0 },
          { target: ".list", label: "Task tree", n: 2, at: "e", d: 14, dy: -258, pad: -2 },
          { target: ".timeline-header", label: "Months and ISO weeks", n: 3, at: "in-ne" },
          { target: ".header line.today", label: "Today", n: 4, at: "e", d: 16, box: false },
          {
            target: { rect: { x: 800, y: 300, w: 1, h: 1 } },
            label: "Bars, roll-ups and dependencies",
            n: 5,
            at: "c",
            box: false,
          },
          {
            target: ".statusline",
            label: "Mouse and keyboard help",
            n: 6,
            at: "n",
            d: 8,
            dx: 590,
          },
        ],
      });
    },

    "gantt-toolbar": async () => {
      await open("gantt", 1500, 860);
      const s = (target, n, extra = {}) => ({ target, n, at: "s", d: 12, ...extra });
      await t.shot(img("gantt-toolbar"), {
        scale: WIDE,
        clip: { x: 0, y: 0, w: 1500, h: 92 },
        annotations: [
          s(label("Group"), 1),
          s(label("Order"), 2),
          s(label("Colour"), 3),
          s('[aria-label="Zoom"]', 4),
          s(tb("Fit"), 5),
          s(tb("Today"), 6),
          s({ sel: ".toolbar .btn", exact: "Critical path" }, 7),
          s({ sel: ".toolbar .btn", exact: "Hide done" }, 8),
          s(label("Baseline"), 9),
          s(".late-badge", 10),
          s({ sel: ".toolbar .icon-btn", all: true }, 11),
        ],
      });
    },

    "gantt-anatomy": async () => {
      await open("gantt", 1500, 860);
      await t.shot(img("gantt-anatomy"), {
        scale: CROP,
        clip: { x: 320, y: 40, w: 760, h: 440 },
        annotations: [
          {
            target: "g.row.milestone .rollup",
            label: "Milestone roll-up",
            at: "s",
            d: 4,
            dx: 290,
          },
          { target: "g.row.milestone path.diamond", label: "Target ◆", at: "e", d: 18 },
          { target: "g.row.group .rollup", label: "Section roll-up", at: "e", d: 150 },
          { target: bar("T002"), label: "Done", at: "s", d: 18, dx: -30 },
          { target: bar("T005", "rect.progress"), label: "Progress fill", at: "e", d: 200 },
          { target: bar("T006", ".rollup"), label: "Parent roll-up", at: "e", d: 120 },
          { target: bar("T008", "rect.baseline"), label: "Baseline", at: "s", d: 16, dx: -60 },
          { target: bar("T008", "text.slip"), label: "Slip vs baseline", at: "e", d: 60 },
          { target: bar("T008", "text.bar-label"), label: "Owner", at: "nw", d: 20 },
          {
            target: 'g.link[data-link="T011→T012"] .link-line',
            label: "Dependency",
            at: "e",
            d: 80,
          },
          { target: ".header line.today", label: "Today", at: "e", d: 8, box: false },
        ],
      });
    },

    "gantt-tree": async () => {
      await open("gantt", 1500, 860);
      await t.hover('[data-row="T005"]');
      await t.shot(img("gantt-tree"), {
        scale: CROP,
        clip: { x: 0, y: 40, w: 470, h: 360 },
        annotations: [
          { target: ".list-row.milestone .twisty", label: "Collapse / expand", at: "e", d: 300 },
          { target: '[data-row="T005"] .row-id', label: "Id", at: "s", d: 30, dx: -40 },
          { target: '[data-row="T005"] .row-owner', label: "Owner", at: "s", d: 66, dx: 0 },
          { target: '[data-row="T005"] .row-open', label: "Reveal in editor", at: "e", d: 40 },
        ],
      });
    },

    "gantt-critical": async () => {
      await open("gantt-month", 1500, 720);
      for (const title of ["M1 –", "M2 –", "M3 –"]) {
        await t.click(
          { sel: ".list-row.milestone", text: title, closest: ".list-row" },
          { at: { x: 0, dx: 14 } }
        );
      }
      await t.shot(img("gantt-critical"), {
        scale: WIDE,
        clip: { x: 0, y: 0, w: 1500, h: 620 },
        annotations: [
          { target: '[aria-label="Zoom"]', label: "Month zoom", at: "s", d: 10 },
          { target: tb("Hide done"), label: "Done tasks hidden", at: "s", d: 46 },
          { target: ".late-badge", label: "Milestones forecast late", at: "s", d: 12, dx: -90 },
          {
            target: { sel: ".list-row.milestone", text: "M2 –", closest: ".list-row" },
            label: "Collapsed milestone",
            at: "e",
            d: 40,
          },
          {
            target: { sel: "rect.bar.critical", index: 0 },
            label: "Critical path",
            at: "w",
            d: 90,
          },
          { target: "path.diamond.forecast", label: "Forecast ◆", at: "s", d: 60 },
          {
            target: { sel: "path.diamond.late", index: 0 },
            label: "Target ◆ (red = late)",
            at: "n",
            d: 40,
            dx: -60,
          },
        ],
      });
    },

    "gantt-tooltip": async () => {
      await open("gantt", 1500, 860);
      const r = await t.rect(bar("T107"));
      await t.hover(bar("T107"), { x: 0.3 });
      await sleep(200);
      const tip = await t.rect(".tooltip.visible");
      const x = Math.min(r.x, tip.x) - 30;
      const y = Math.min(r.y, tip.y) - 20;
      await t.shot(img("gantt-tooltip"), {
        scale: CROP,
        clip: {
          x,
          y,
          w: Math.max(r.x + r.w, tip.x + tip.w) - x + 30,
          h: Math.max(r.y + r.h, tip.y + tip.h) - y + 20,
        },
      });
    },

    "gantt-overtime": async () => {
      await open("gantt-ot", 1500, 700);
      const group = 'g.row.group[data-key="owner:sam"]';
      const roll = await t.rect(`${group} rect.rollup`);
      await t.hover({ rect: { x: 1290, y: roll.y + roll.h / 2, w: 1, h: 1 } });
      await sleep(300);
      await t.waitFor(".tooltip.visible", 3000);
      await t.shot(img("gantt-overtime"), {
        scale: WIDE,
        clip: { x: 0, y: 300, w: 1500, h: 340 },
        annotations: [
          {
            target: { sel: `${group} rect.overtime`, all: true },
            label: "Sam's overtime days",
            at: "w",
            d: 60,
          },
          {
            target: { sel: 'g.row[data-key="T114"] rect.overtime', all: true },
            label: "T114: 4.8 h overtime",
            at: "w",
            d: 120,
          },
          {
            target: { sel: 'g.row[data-key="T105"] rect.overtime', all: true },
            label: "T105: 1.6 h",
            at: "e",
            d: 30,
          },
          { target: ".tooltip.visible", label: "Which tasks", at: "s", d: 20 },
        ],
      });
    },

    "gantt-drag-move": async () => {
      await open("gantt", 1500, 860);
      const d = await t.drag(bar("T121"), { dx: 7 * 14 }, { fromAt: { x: 0.4 }, release: false });
      await t.shot(img("gantt-drag-move"), {
        scale: CROP,
        clip: { x: d.from.x - 200, y: d.from.y - 70, w: 560, h: 130 },
        annotations: [
          { target: ".bar-ghost", label: "Drag the bar", at: "n", d: 14, dx: -80 },
          { target: ".ghost-label", label: "New dates", at: "s", d: 14 },
        ],
      });
      await t.release(d.to);
    },

    "gantt-drag-resize": async () => {
      await open("gantt", 1500, 860);
      const d = await t.drag(bar("T121", ".resize-handle"), { dx: 3 * 14 }, { release: false });
      await t.shot(img("gantt-drag-resize"), {
        scale: CROP,
        clip: { x: d.from.x - 240, y: d.from.y - 70, w: 560, h: 130 },
        annotations: [
          { target: ".bar-ghost", label: "Drag the right end", at: "n", d: 14, dx: 40 },
          { target: ".ghost-label", label: "New finish", at: "s", d: 14 },
        ],
      });
      await t.release(d.to);
    },

    "gantt-drag-link": async () => {
      await open("gantt", 1500, 860);
      const target = await t.rect(bar("T105"));
      const d = await t.drag(
        bar("T121", ".link-handle"),
        { x: target.x + 8, y: target.y + target.h / 2 },
        { release: false }
      );
      await t.shot(img("gantt-drag-link"), {
        scale: CROP,
        clip: { x: d.from.x - 120, y: d.from.y - 40, w: 470, h: target.y - d.from.y + 90 },
        annotations: [
          { target: bar("T121", ".link-handle"), label: "Start at the dot", at: "e", d: 30 },
          { target: ".link-ghost-end", label: "Drop on the successor", at: "w", d: 30 },
        ],
      });
      await t.release(d.to);
    },

    "gantt-edit": async () => {
      await open("gantt", 1500, 860);
      await t.click('[data-row="T121"]');
      await t.key("F2");
      await t.shot(img("gantt-edit"), {
        scale: CROP,
        clip: await around(".dialog", { l: 30, t: 30, r: 250, b: 70 }),
        annotations: [
          { target: "#f-title", label: "Title", n: 1, at: "e", d: 30 },
          { target: "#f-owner", label: "Owner (team.md)", n: 2, at: "e", d: 30 },
          { target: "#f-est", label: "Estimate: h, d or w", n: 3, at: "e", d: 30 },
          { target: ".dialog .btn.primary", label: "Save", n: 4, at: "s", d: 20 },
          { target: ".dialog .btn.link", label: "All fields…", n: 5, at: "s", d: 20 },
        ],
      });
    },

    "gantt-dependency": async () => {
      await open("gantt", 1650, 860);
      await t.click('g.link[data-link="T121→T122"] .link-hit', {
        at: { x: 1, dx: -8, y: 1 },
      });
      await t.waitFor({ sel: ".toolbar .btn", text: "Remove dependency" });
      await t.shot(img("gantt-dependency"), {
        scale: WIDE,
        clip: { x: 0, y: 0, w: 1650, h: 640 },
        annotations: [
          {
            target: "g.link.selected .link-line",
            label: "Click a dependency to select it",
            at: "e",
            d: 150,
          },
          {
            target: tb("Remove dependency"),
            label: "Remove it (or press Delete)",
            at: "s",
            d: 40,
            dx: -60,
          },
        ],
      });
    },

    "gantt-owner": async () => {
      await open("gantt-owner", 1500, 700);
      await t.shot(img("gantt-owner"), {
        scale: WIDE,
        annotations: [
          { target: label("Group"), label: "Group: Owner", at: "s", d: 14 },
          { target: label("Colour"), label: "Colour: Status", at: "s", d: 50 },
          {
            target: { sel: ".list-row.group", index: 0 },
            label: "One group per person",
            at: "e",
            d: 210,
            dy: 30,
          },
          { target: bar("T002"), label: "Done", at: "s", d: 14 },
          { target: bar("T005"), label: "Review", at: "e", d: 60 },
          { target: bar("T008"), label: "In progress", at: "e", d: 60 },
          { target: bar("T012"), label: "To do", at: "e", d: 60 },
        ],
      });
    },

    // ----------------------------------------------------------------------------- Kanban
    "kanban-overview": async () => {
      await open("kanban", 1500, 640);
      const s = (target, n, extra = {}) => ({ target, n, at: "s", d: 10, ...extra });
      await t.shot(img("kanban-overview"), {
        scale: WIDE,
        annotations: [
          s('[aria-label="Board"]', 1, { dx: -60 }),
          s(label("Swimlanes"), 2),
          s(label("Cards"), 3, { dx: -60 }),
          s({ sel: ".toolbar .btn", exact: "Cancelled" }, 4),
          s('[aria-label="Owner filter"]', 5),
          s('[aria-label="Tag filter"]', 6),
          s('[aria-label="Milestone filter"]', 7),
          s('[aria-label="Text filter"]', 8),
          s({ sel: ".toolbar .muted", text: "cards" }, 9),
          s({ sel: ".toolbar .icon-btn", all: true }, 10, { dx: -20 }),
          { target: { sel: ".column-count", index: 1 }, n: 11, at: "s", d: 160, dx: -60 },
          { target: { sel: ".column-count", index: 0 }, n: 12, at: "s", d: 100, dx: 20 },
        ],
      });
    },

    "kanban-card": async () => {
      await open("kanban-frontend", 1500, 640);
      await t.hover(card("T106"));
      await t.shot(img("kanban-card"), {
        scale: 1,
        clip: { x: 600, y: 40, w: 600, h: 290 },
        annotations: [
          { target: card("T106", ".card-open"), label: "Reveal in editor", at: "n", d: 2, dx: -80 },
          { target: card("T106", ".card-blocked"), label: "Blocked reason", at: "w", d: 40 },
          { target: card("T106", ".card-id"), label: "Id", at: "w", d: 40, dy: 50 },
          { target: card("T106", ".chip"), label: "Milestone", at: "s", d: 56, dx: -20 },
          {
            target: card("T106", 'span[title="actual/estimate"]'),
            label: "Actual / estimate",
            at: "s",
            d: 92,
            dx: 10,
          },
          { target: card("T106", ".due"), label: "Due date", at: "s", d: 128, dx: 30 },
          { target: card("T106", ".owner"), label: "Owner", at: "s", d: 56, dx: -40 },
          { target: card("T106", ".card-tags"), label: "Tags", at: "s", d: 18, dx: -30 },
        ],
      });
    },

    "kanban-add": async () => {
      await open("kanban", 1500, 640);
      // An unowned card at the bottom of the board; the column headers are sticky.
      await t.cdp.evaluate(
        `document.querySelector('.card[data-key="T112"]').scrollIntoView({ block: "end" })`
      );
      await sleep(300);
      await t.hover(card("T112"));
      await t.shot(img("kanban-add"), {
        scale: CROP,
        clip: { x: 0, y: 40, w: 760, h: 600 },
        annotations: [
          {
            target: { sel: ".column-add", index: 0 },
            label: "New task in this column",
            at: "e",
            d: 40,
          },
          {
            target: card("T112", ".assign-owner"),
            label: "No owner yet: assign one",
            at: "e",
            d: 60,
          },
          {
            target: card("T110", ".owner"),
            label: "Click the owner to change it",
            at: "e",
            d: 60,
          },
          {
            target: card("T112", ".card-title"),
            label: "Double-click or F2: edit · right-click: all actions",
            at: "e",
            d: 100,
            dy: -50,
          },
        ],
      });
    },

    "kanban-blocked": async () => {
      await open("kanban", 1500, 640);
      await t.click(card("T005"));
      await t.key("ArrowRight", "alt");
      await t.shot(img("kanban-blocked"), {
        scale: CROP,
        clip: await around(".dialog", { l: 40, t: 40, r: 40, b: 70 }),
        annotations: [
          { target: ".dialog input", label: 'Reason → @blocked:"…"', at: "s", d: 46, dx: -60 },
        ],
      });
    },

    "kanban-swimlanes": async () => {
      await open("kanban-owner", 1500, 560);
      await t.shot(img("kanban-swimlanes"), {
        scale: WIDE,
        annotations: [
          { target: label("Swimlanes"), label: "Swimlanes: Owner", at: "s", d: 30 },
          {
            target: '[aria-label="Milestone filter"]',
            label: "Filtered to M1",
            at: "s",
            d: 30,
          },
          {
            target: { sel: ".lane-header", index: 1 },
            label: "Drop a card in another lane = new @owner",
            at: "s",
            d: 6,
            dx: 360,
            pad: 1,
          },
        ],
      });
    },

    "kanban-punch": async () => {
      await open("kanban-punch", 1500, 470);
      await t.shot(img("kanban-punch"), {
        scale: WIDE,
        annotations: [
          { target: '[aria-label="Board"]', label: "Punch list board", at: "s", d: 30 },
          {
            target: { sel: ".lane-header", index: 0 },
            label: "Severity lanes",
            at: "s",
            d: 6,
            dx: 160,
            pad: 1,
          },
          { target: { sel: ".card .sev", index: 0 }, label: "Severity", at: "w", d: 40 },
          { target: { sel: ".card-from", index: 0 }, label: "@from test case", at: "e", d: 120 },
        ],
      });
    },

    // ----------------------------------------------------------------------------- Team load
    "resources-overview": async () => {
      await open("resources", 1500, 470);
      await t.click('[aria-label^="Alex, 2026-W44"]');
      await t.shot(img("resources-overview"), {
        scale: WIDE,
        annotations: [
          { target: '[aria-label="Mode"]', n: 1, at: "s", d: 10 },
          { target: ".legend", n: 2, at: "s", d: 10 },
          { target: { sel: "th.person", index: 0 }, n: 3, at: "s", d: 196, dx: 40 },
          { target: { sel: "td.cell.current", index: 5 }, n: 4, at: "s", d: 20 },
          { target: '[aria-label^="Sam, 2026-W47"]', n: 5, at: "s", d: 110 },
          { target: '[aria-label^="Alex, 2026-W44"]', n: 6, at: "e", d: 300, dy: 30 },
          { target: ".details", n: 7, at: "in-ne", pad: -2 },
        ],
      });
    },

    "resources-overtime": async () => {
      await open("resources", 1500, 470);
      await t.click('[aria-label^="Sam, 2026-W45"]');
      const details = await t.rect(".details");
      await t.shot(img("resources-overtime"), {
        scale: WIDE,
        clip: { x: 0, y: 0, w: 1500, h: details.y + details.h },
        annotations: [
          { target: { sel: ".legend .swatch.ot" }, label: "Overtime marker", at: "s", d: 30 },
          {
            target: '[aria-label^="Sam, 2026-W45"]',
            label: "+8 OT: overtime hours scheduled",
            at: "e",
            d: 330,
            dy: -20,
          },
          {
            target: '[aria-label^="Maria, 2026-W48"]',
            label: "Extra working day (Friday)",
            at: "e",
            d: 150,
          },
          { target: ".details-overtime", label: "Normal + overtime capacity", at: "e", d: 60 },
          {
            target: ".details-actions",
            label: "Add overtime or a working day for this week",
            at: "e",
            d: 60,
          },
        ],
      });
    },

    "resources-demand": async () => {
      await open("resources-demand", 1500, 400);
      await t.shot(img("resources-demand"), {
        scale: WIDE,
        clip: { x: 0, y: 0, w: 1500, h: 330 },
        annotations: [
          { target: '[aria-label="Mode"]', label: "Demand", at: "s", d: 20 },
          { target: { sel: "td.cell.over", index: 0 }, label: "Over capacity", at: "s", d: 140 },
          {
            target: { sel: ".over-count", index: 0 },
            label: "Weeks over",
            at: "s",
            d: 155,
            dx: 60,
          },
        ],
      });
    },

    // ----------------------------------------------------------------------------- Dashboard
    "dashboard-top": async () => {
      await open("dashboard", 1500, 1320);
      const ms = await t.rect(".milestones");
      const late = ".ms-card.late";
      await t.shot(img("dashboard-top"), {
        scale: WIDE,
        clip: { x: 0, y: 0, w: 1500, h: ms.y + ms.h + 12 },
        annotations: [
          { target: label("Baseline"), n: 1, at: "s", d: 8 },
          { target: tb("Save baseline"), n: 2, at: "s", d: 8 },
          { target: { sel: ".toolbar .btn", text: "Gantt" }, n: 3, at: "s", d: 8 },
          { target: tb("Kanban"), n: 4, at: "s", d: 8 },
          { target: tb("Team load"), n: 5, at: "s", d: 8 },
          { target: ".kpis", n: 6, at: "e", d: 30, pad: 2 },
          { target: `${late} .progress`, n: 7, at: "e", d: 24 },
          { target: { sel: `${late} .ms-row`, index: 1 }, n: 8, at: "e", d: 70 },
          { target: { sel: `${late} .ms-row`, index: 2 }, n: 9, at: "e", d: 116 },
          { target: { sel: `${late} .ms-row`, index: 3 }, n: 10, at: "e", d: 162 },
        ],
      });
    },

    "dashboard-charts": async () => {
      await open("dashboard", 1500, 1320);
      const burn = await t.rect('section[aria-labelledby="burn-title"]');
      await t.shot(img("dashboard-charts"), {
        scale: WIDE,
        clip: { x: 0, y: burn.y - 6, w: 1500, h: burn.h + 12 },
        annotations: [
          {
            target: '[aria-label="Burn-up scope"]',
            label: "Whole project or one milestone",
            at: "s",
            d: 30,
          },
          { target: ".chart-legend", label: "Legend", at: "e", d: 30 },
          {
            target: { sel: "table.accuracy th", exact: "act/est" },
            label: "Red = underestimated · green = overestimated",
            at: "n",
            d: 6,
            dx: -110,
          },
        ],
      });
    },

    "dashboard-budget": async () => {
      await open("dashboard", 1500, 1320);
      const panel = await t.rect(".budget-panel");
      await t.shot(img("dashboard-budget"), {
        scale: WIDE,
        clip: { x: 0, y: panel.y - 6, w: 1500, h: panel.h + 12 },
        annotations: [
          { target: ".budget-meter", n: 1, at: "n", d: 8, dx: -200 },
          { target: ".budget-figures", n: 2, at: "s", d: 4, dx: 160 },
          { target: ".budget-why", n: 3, at: "s", d: 8 },
          { target: "table.budget-table caption", n: 4, at: "e", d: 12 },
          { target: ".budget-panel .list h3", n: 5, at: "e", d: 12 },
          { target: { sel: ".budget-panel .btn", text: "Edit budget" }, n: 6, at: "w", d: 8 },
        ],
      });
    },

    "dashboard-lists": async () => {
      await open("dashboard", 1500, 1320);
      const lists = await t.rect(".lists");
      const main = await t.rect("main.dashboard");
      await t.shot(img("dashboard-lists"), {
        scale: WIDE,
        clip: { x: 0, y: lists.y - 6, w: 1500, h: main.y + main.h - lists.y + 6 },
        annotations: [
          { target: { sel: ".list h3 .count", index: 3 }, label: "Count", at: "e", d: 20 },
          {
            target: { sel: ".list a", index: 0 },
            label: "Click to open the task",
            at: "s",
            d: 30,
            dx: 40,
          },
          {
            target: { sel: ".list h3", text: "Critical path" },
            label: "The chain that sets the end date",
            at: "e",
            d: 340,
            dy: 80,
          },
          {
            target: { sel: ".list h3", text: "Planned overtime" },
            label: "Tasks that use overtime",
            at: "e",
            d: 30,
          },
          {
            target: { sel: ".test-row", index: 0 },
            label: "Pass / fail / n.a. / open",
            at: "e",
            d: -280,
            dy: 52,
          },
          {
            target: { sel: ".panel-head .btn", text: "Board" },
            label: "Punch-list board",
            at: "w",
            d: 40,
          },
        ],
      });
    },

    // ----------------------------------------------------------------------------- Test runner
    "testrunner-overview": async () => {
      await open("testRunner-fail", 1400, 430);
      const s = (target, n, extra = {}) => ({ target, n, at: "s", d: 10, ...extra });
      await t.shot(img("testrunner-overview"), {
        scale: WIDE,
        annotations: [
          s('[aria-label="Test plan"]', 1),
          s({ sel: ".toolbar > .muted" }, 2),
          s(tb("Finish run"), 3),
          s(tb("Reset results"), 4),
          s(tb("Export report"), 5),
          s(tb("Open file"), 6),
          s({ sel: ".toolbar .icon-btn", all: true }, 7, { dx: -10 }),
          { targets: [".summary .bar", ".summary > span"], n: 8, at: "e", d: 14 },
          { target: { sel: ".case-link", all: true }, n: 9, at: "e", d: 14 },
          { target: { sel: ".runs", index: 0 }, n: 10, at: "e", d: 14 },
          { target: { sel: ".runs", index: 1 }, n: 11, at: "e", d: 14 },
          { target: ".pre", n: 12, at: "e", d: 10, dx: -500 },
          { target: { sel: ".steps > li:first-child .res", all: true }, n: 13, at: "w", d: 6 },
          { target: { sel: ".step .note", index: 0 }, n: 14, at: "n", d: 4, dx: 200 },
          { target: ".punch-link", n: 15, at: "n", d: 4 },
          { target: { sel: ".step .btn", text: "Create punch item" }, n: 16, at: "n", d: 4 },
          { target: { sel: ".nav .btn", all: true }, n: 17, at: "s", d: 8 },
          { target: ".nav .muted", n: 18, at: "s", d: 8 },
        ],
      });
    },

    "testrunner-punch": async () => {
      await open("testRunner-fail", 1400, 560);
      await t.click({ sel: ".step .btn", text: "Create punch item" });
      await t.shot(img("testrunner-punch"), {
        scale: CROP,
        clip: await around(".dialog", { l: 30, t: 30, r: 170, b: 40 }),
        annotations: [
          { target: "#p-sev", label: "A / B / C", at: "e", d: 30 },
          { target: "#p-owner", label: "@owner", at: "e", d: 30 },
          { target: "#p-due", label: "@due", at: "e", d: 30 },
        ],
      });
    },

    "testrunner-finish": async () => {
      await open("testRunner-fail", 1400, 560);
      await t.click(tb("Finish run"));
      await t.shot(img("testrunner-finish"), {
        scale: CROP,
        clip: await around(".dialog", { l: 30, t: 30, r: 230, b: 40 }),
        annotations: [
          { target: "#r-tester", label: "Default: planner.me", at: "e", d: 30 },
          { target: "#r-witness", label: "Default: the plan's witness", at: "e", d: 30 },
        ],
      });
    },
  };

  try {
    for (const [name, run] of Object.entries(shots)) {
      if (only && !only.some((o) => name.startsWith(o))) continue;
      await run();
    }
  } finally {
    await chrome.close();
  }
}
