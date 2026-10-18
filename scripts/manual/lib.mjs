// Shared helpers for the user manual screenshots: a DevTools-protocol session, input events, and an
// in-page overlay that draws highlight boxes, numbered badges and arrows onto the page before the
// screenshot is taken (so annotations are pixel-exact on both webviews and the VS Code workbench).
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connects to a DevTools page target (`webSocketDebuggerUrl`). */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.error ? { error: m.error } : m.result);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "error");
    return r.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

// Browser-side code, injected once per page as `window.__mp`. A target is a CSS selector or
// { sel, text, exact, aria, title, within, index, all, closest, grow, rect }: the matching visible
// elements inside `within` (another target), innermost ones when matching text, optionally climbed
// to `closest`, unioned when `all`.
const OVERLAY = String.raw`
window.__mp = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const COLOR = "#ff2d95";
  const HALO = "rgba(0,0,0,0.6)";
  const FONT = '600 13px -apple-system, "Segoe UI", system-ui, sans-serif';
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    return (r.width > 0 || r.height > 0) && getComputedStyle(e).visibility !== "hidden";
  };
  function els(t) {
    if (typeof t === "string") t = { sel: t };
    const scope = t.within ? els(t.within)[0] : document;
    if (!scope) return [];
    let list = [...scope.querySelectorAll(t.sel || "*")].filter(visible);
    const byText = t.text !== undefined || t.exact !== undefined;
    if (t.text !== undefined) list = list.filter((e) => norm(e.textContent).includes(t.text));
    if (t.exact !== undefined) list = list.filter((e) => norm(e.textContent) === t.exact);
    if (t.aria !== undefined)
      list = list.filter((e) => (e.getAttribute("aria-label") || "").includes(t.aria));
    if (t.title !== undefined)
      list = list.filter((e) => (e.getAttribute("title") || "").includes(t.title));
    if (byText) list = list.filter((e) => !list.some((o) => o !== e && e.contains(o)));
    if (t.closest) list = [...new Set(list.map((e) => e.closest(t.closest)).filter(Boolean))];
    return list;
  }
  function rect(t) {
    if (!t) return null;
    if (t.rect) return t.rect;
    const list = els(t);
    const i = t.index || 0;
    const chosen = t.all ? list : list.slice(i, i + 1);
    if (!chosen.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const e of chosen) {
      const r = e.getBoundingClientRect();
      x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
      x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
    }
    const g = t.grow || 0;
    return { x: x1 - g, y: y1 - g, w: x2 - x1 + 2 * g, h: y2 - y1 + 2 * g };
  }
  function union(rects) {
    const r = rects.filter(Boolean);
    if (!r.length) return null;
    const x1 = Math.min(...r.map((a) => a.x)), y1 = Math.min(...r.map((a) => a.y));
    const x2 = Math.max(...r.map((a) => a.x + a.w)), y2 = Math.max(...r.map((a) => a.y + a.h));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  const el = (name, attrs, parent) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (parent) parent.appendChild(e);
    return e;
  };
  let measureCtx;
  const textWidth = (s) => {
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = FONT;
    return measureCtx.measureText(s).width;
  };
  function badge(svg, n, label) {
    const g = el("g", {}, svg);
    g.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,0.7))";
    const hasN = n !== undefined && n !== null && n !== "";
    if (!label) {
      const w = Math.max(26, textWidth(String(n)) + 14);
      el("rect", { x: 0, y: 0, width: w, height: 26, rx: 13, fill: COLOR, stroke: "#fff", "stroke-width": 2 }, g);
      const t = el("text", { x: w / 2, y: 17.5, "text-anchor": "middle", fill: "#fff" }, g);
      t.style.font = FONT; t.style.fontSize = "13.5px"; t.style.fontWeight = "700";
      t.textContent = String(n);
      return { g, w, h: 26 };
    }
    const tw = textWidth(label);
    const w = (hasN ? 30 : 12) + tw + 12;
    el("rect", { x: 0, y: 0, width: w, height: 26, rx: 13, fill: COLOR, stroke: "#fff", "stroke-width": 2 }, g);
    if (hasN) {
      el("circle", { cx: 14, cy: 13, r: 9.5, fill: "#fff" }, g);
      const tn = el("text", { x: 14, y: 17.5, "text-anchor": "middle", fill: COLOR }, g);
      tn.style.font = FONT; tn.style.fontSize = "12.5px"; tn.style.fontWeight = "800";
      tn.textContent = String(n);
    }
    const tl = el("text", { x: hasN ? 30 : 12, y: 17.5, fill: "#fff" }, g);
    tl.style.font = FONT;
    tl.textContent = label;
    return { g, w, h: 26 };
  }
  function arrow(svg, s, e) {
    const dx = e.x - s.x, dy = e.y - s.y, len = Math.hypot(dx, dy);
    if (len < 6) return;
    const ux = dx / len, uy = dy / len, head = 11, half = 6;
    const bx = e.x - ux * head, by = e.y - uy * head;
    const pts = [e.x + "," + e.y, bx - uy * half + "," + (by + ux * half), bx + uy * half + "," + (by - ux * half)].join(" ");
    el("line", { x1: s.x, y1: s.y, x2: bx, y2: by, stroke: HALO, "stroke-width": 6, "stroke-linecap": "round" }, svg);
    el("polygon", { points: pts, fill: HALO, stroke: HALO, "stroke-width": 3, "stroke-linejoin": "round" }, svg);
    el("line", { x1: s.x, y1: s.y, x2: bx, y2: by, stroke: COLOR, "stroke-width": 3, "stroke-linecap": "round" }, svg);
    el("polygon", { points: pts, fill: COLOR }, svg);
  }
  function clear() {
    document.getElementById("__mp_overlay")?.remove();
  }
  function annotate(specs) {
    clear();
    const W = innerWidth, H = innerHeight;
    const svg = el("svg", { id: "__mp_overlay", width: W, height: H, viewBox: "0 0 " + W + " " + H });
    Object.assign(svg.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none" });
    document.documentElement.appendChild(svg);
    const boxes = el("g", {}, svg), arrows = el("g", {}, svg), badges = el("g", {}, svg);
    const missing = [];
    for (const s of specs) {
      const targets = s.targets || (s.target ? [s.target] : []);
      const found = targets.map(rect);
      if (found.some((r) => !r)) missing.push(s.n ?? s.label ?? JSON.stringify(targets));
      const r = union(found);
      if (!r) continue;
      const pad = s.pad ?? 3;
      const b = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
      if (s.box !== false) {
        const attrs = { x: b.x, y: b.y, width: b.w, height: b.h, rx: s.round ?? 5, fill: "none" };
        el("rect", { ...attrs, stroke: HALO, "stroke-width": 5 }, boxes);
        const line = el("rect", { ...attrs, stroke: COLOR, "stroke-width": 2.5 }, boxes);
        if (s.dashed) line.setAttribute("stroke-dasharray", "6 4");
      }
      if ((s.n === undefined || s.n === null) && !s.label) continue;
      const bd = badge(badges, s.n, s.label);
      const d = s.d ?? 30, k = 0.75;
      // Placement is relative to the box, or to another element ("from", e.g. the whole row).
      const fr = s.from ? rect(s.from) : null;
      const p = fr ? { x: fr.x - pad, y: fr.y - pad, w: fr.w + 2 * pad, h: fr.h + 2 * pad } : b;
      const cx0 = p.x + p.w / 2, cy0 = p.y + p.h / 2;
      const at = s.at || "s";
      let cx = cx0, cy = cy0;
      if (at === "n") cy = p.y - d - bd.h / 2;
      else if (at === "s") cy = p.y + p.h + d + bd.h / 2;
      else if (at === "e") cx = p.x + p.w + d + bd.w / 2;
      else if (at === "w") cx = p.x - d - bd.w / 2;
      else if (at === "ne") { cx = p.x + p.w + d * k + bd.w / 2; cy = p.y - d * k - bd.h / 2; }
      else if (at === "nw") { cx = p.x - d * k - bd.w / 2; cy = p.y - d * k - bd.h / 2; }
      else if (at === "se") { cx = p.x + p.w + d * k + bd.w / 2; cy = p.y + p.h + d * k + bd.h / 2; }
      else if (at === "sw") { cx = p.x - d * k - bd.w / 2; cy = p.y + p.h + d * k + bd.h / 2; }
      else if (at === "in-ne") { cx = p.x + p.w - bd.w / 2 - 4; cy = p.y + bd.h / 2 + 4; }
      else if (at === "in-nw") { cx = p.x + bd.w / 2 + 4; cy = p.y + bd.h / 2 + 4; }
      cx += s.dx || 0; cy += s.dy || 0;
      cx = Math.min(Math.max(cx, bd.w / 2 + 3), W - bd.w / 2 - 3);
      cy = Math.min(Math.max(cy, bd.h / 2 + 3), H - bd.h / 2 - 3);
      bd.g.setAttribute("transform", "translate(" + (cx - bd.w / 2) + "," + (cy - bd.h / 2) + ")");
      const inside = cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
      if (s.arrow !== false && !inside && !at.startsWith("in-") && at !== "c") {
        const tx = Math.min(Math.max(cx, b.x), b.x + b.w), ty = Math.min(Math.max(cy, b.y), b.y + b.h);
        const ex = tx + (s.ax || 0), ey = ty + (s.ay || 0);
        const dx = ex - cx, dy = ey - cy;
        const t = Math.min(Math.abs(dx) > 0.01 ? bd.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 0.01 ? bd.h / 2 / Math.abs(dy) : Infinity);
        const sx = cx + dx * Math.min(1, t), sy = cy + dy * Math.min(1, t);
        if (Math.hypot(ex - sx, ey - sy) > 8) arrow(arrows, { x: sx, y: sy }, { x: ex, y: ey });
      }
    }
    return missing;
  }
  return { rect, els: (t) => els(t).length, annotate, clear };
})();
`;

const KEYS = {
  Enter: [13, "Enter", "\r"],
  Escape: [27, "Escape"],
  Tab: [9, "Tab"],
  Backspace: [8, "Backspace"],
  Delete: [46, "Delete"],
  ArrowLeft: [37, "ArrowLeft"],
  ArrowUp: [38, "ArrowUp"],
  ArrowRight: [39, "ArrowRight"],
  ArrowDown: [40, "ArrowDown"],
  Home: [36, "Home"],
  End: [35, "End"],
  " ": [32, "Space", " "],
  ".": [190, "Period", "."],
  ",": [188, "Comma", ","],
  "/": [191, "Slash", "/"],
  F1: [112, "F1"],
  F2: [113, "F2"],
  F12: [123, "F12"],
};
const MODS = { alt: 1, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

/** Page helpers on a CDP session ({ send, evaluate }). */
export function pageTools(cdp) {
  const ev = cdp.evaluate;
  const inject = async () => {
    if (!(await ev("!!window.__mp"))) await ev(OVERLAY);
  };
  const t = {
    cdp,
    async rect(target) {
      await inject();
      return ev(`__mp.rect(${JSON.stringify(target)})`);
    },
    async exists(target) {
      return !!(await t.rect(target));
    },
    async waitFor(target, timeout = 15000) {
      const end = Date.now() + timeout;
      for (;;) {
        const r = await t.rect(target);
        if (r) return r;
        if (Date.now() > end) throw new Error(`Timed out waiting for ${JSON.stringify(target)}`);
        await sleep(150);
      }
    },
    async waitGone(target, timeout = 10000) {
      const end = Date.now() + timeout;
      while ((await t.rect(target)) && Date.now() < end) await sleep(150);
    },
    async mouse(type, x, y, extra = {}) {
      await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "none", ...extra });
    },
    /** Moves to the target (or {x, y}); `at` = fraction of the box ({x: 0.5, y: 0.5}). */
    async point(target, at = {}) {
      if (target && target.x !== undefined && target.w === undefined && !target.sel) return target;
      const r = await t.waitFor(target);
      return {
        x: r.x + r.w * (at.x ?? 0.5) + (at.dx ?? 0),
        y: r.y + r.h * (at.y ?? 0.5) + (at.dy ?? 0),
      };
    },
    /** Moves onto the target in a few small steps (editors show hovers only after movement). */
    async hover(target, at) {
      const p = await t.point(target, at);
      for (let i = 3; i >= 0; i--) {
        await t.mouse("mouseMoved", p.x - i, p.y);
        await sleep(60);
      }
      return p;
    },
    async click(target, opts = {}) {
      const p = await t.point(target, opts.at);
      const button = opts.button ?? "left";
      const modifiers = mods(opts.mods);
      await t.mouse("mouseMoved", p.x, p.y, { modifiers });
      for (let i = 1; i <= (opts.count ?? 1); i++) {
        await t.mouse("mousePressed", p.x, p.y, {
          button,
          clickCount: i,
          buttons: button === "right" ? 2 : 1,
          modifiers,
        });
        await t.mouse("mouseReleased", p.x, p.y, { button, clickCount: i, modifiers });
      }
      await sleep(opts.wait ?? 250);
      return p;
    },
    /** Presses, moves in steps and optionally releases (keep `release: false` for mid-drag shots). */
    async drag(from, to, opts = {}) {
      const a = await t.point(from, opts.fromAt);
      const b =
        to.dx !== undefined && to.sel === undefined
          ? { x: a.x + to.dx, y: a.y + (to.dy ?? 0) }
          : await t.point(to, opts.toAt);
      await t.mouse("mouseMoved", a.x, a.y);
      await t.mouse("mousePressed", a.x, a.y, { button: "left", clickCount: 1, buttons: 1 });
      const steps = opts.steps ?? 8;
      for (let i = 1; i <= steps; i++) {
        const x = a.x + ((b.x - a.x) * i) / steps;
        const y = a.y + ((b.y - a.y) * i) / steps;
        await t.mouse("mouseMoved", x, y, { button: "left", buttons: 1 });
        await sleep(20);
      }
      if (opts.release !== false)
        await t.mouse("mouseReleased", b.x, b.y, { button: "left", clickCount: 1 });
      await sleep(200);
      return { from: a, to: b };
    },
    async release(p) {
      await t.mouse("mouseReleased", p.x, p.y, { button: "left", clickCount: 1 });
    },
    /** Key press, e.g. key("p", "cmd+shift"), key("Enter"), key("ArrowRight", "alt"). */
    async key(key, modifiers, opts = {}) {
      const m = mods(modifiers);
      const named = KEYS[key];
      const upper = key.length === 1 ? key.toUpperCase() : key;
      const keyCode = named ? named[0] : upper.charCodeAt(0);
      const code = named
        ? named[1]
        : /[A-Z]/.test(upper)
          ? `Key${upper}`
          : /[0-9]/.test(upper)
            ? `Digit${upper}`
            : key;
      const typed = named ? named[2] : key.length === 1 ? key : undefined;
      const text = m & 7 ? undefined : typed; // no text with Alt, Ctrl or Cmd held
      const base = {
        key,
        code,
        modifiers: m,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      };
      await cdp.send("Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        ...base,
        text,
        unmodifiedText: text,
      });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(opts.wait ?? 120);
    },
    async type(text, opts = {}) {
      if (opts.slow) {
        for (const ch of text) {
          await cdp.send("Input.insertText", { text: ch });
          await sleep(opts.slow);
        }
      } else {
        await cdp.send("Input.insertText", { text });
      }
      await sleep(opts.wait ?? 150);
    },
    async annotate(specs) {
      await inject();
      const missing = await ev(`__mp.annotate(${JSON.stringify(specs)})`);
      if (missing.length) console.warn(`  ! annotation targets not found: ${missing.join(", ")}`);
      return missing;
    },
    async clear() {
      await inject();
      await ev("__mp.clear()");
    },
    /**
     * Annotates (optional), captures, clears. `clip` = target or {x, y, w, h} (CSS px), grown by
     * `pad` and kept inside the viewport.
     */
    async shot(file, opts = {}) {
      if (opts.annotations) await t.annotate(opts.annotations);
      await sleep(opts.settle ?? 120);
      const view = await ev("({ w: innerWidth, h: innerHeight })");
      let clip = { x: 0, y: 0, w: view.w, h: view.h };
      if (opts.clip) {
        const c = opts.clip.w !== undefined && !opts.clip.sel ? opts.clip : await t.rect(opts.clip);
        if (!c) throw new Error(`clip target not found for ${file}`);
        const pad = opts.pad ?? 0;
        const x = Math.max(0, Math.floor(c.x - pad)),
          y = Math.max(0, Math.floor(c.y - pad));
        clip = {
          x,
          y,
          w: Math.min(view.w - x, Math.ceil(c.w + 2 * pad)),
          h: Math.min(view.h - y, Math.ceil(c.h + 2 * pad)),
        };
      }
      const r = await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: opts.scale ?? 1 },
      });
      if (!r || r.error) throw new Error(`screenshot failed: ${JSON.stringify(r?.error)}`);
      writeFileSync(file, Buffer.from(r.data, "base64"));
      if (opts.annotations && opts.keep !== true) await t.clear();
      console.log(`  ${file.split("/").slice(-1)[0]}`);
    },
  };
  return t;
}

function mods(spec) {
  if (!spec) return 0;
  if (typeof spec === "number") return spec;
  return spec.split("+").reduce((m, k) => m | (MODS[k.trim().toLowerCase()] ?? 0), 0);
}
