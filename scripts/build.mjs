// Bundles every target with esbuild.
//
//   node scripts/build.mjs              extension, mcp-server, cli and all webviews -> dist/
//   node scripts/build.mjs --watch      rebuild on change
//   node scripts/build.mjs --tests      also bundle the integration tests -> out/test/integration/
//   node scripts/build.mjs --production minified, no source maps (used by vscode:prepublish)
import esbuild from "esbuild";
import { existsSync, readdirSync, rmSync, mkdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { templateFiles } from "./lib/templates.mjs";
import { readFileSync } from "node:fs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const production = args.includes("--production");
const withTests = args.includes("--tests");

const common = {
  bundle: true,
  logLevel: "warning",
  sourcemap: production ? false : "linked",
  minify: production,
  absWorkingDir: root,
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const nodeTarget = {
  ...common,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: { PLANNER_VERSION: JSON.stringify(pkg.version) },
};

/** @type {import("esbuild").BuildOptions[]} */
const builds = [];

function addNode(entry, outfile, extra = {}) {
  if (!existsSync(join(root, entry))) return;
  builds.push({ ...nodeTarget, entryPoints: [entry], outfile, external: ["vscode"], ...extra });
}

addNode("src/extension/activate.ts", "dist/extension.js");
addNode("src/mcp/server.ts", "dist/mcp-server.js", {
  banner: { js: "#!/usr/bin/env node" },
  define: {
    ...nodeTarget.define,
    PLANNER_TEMPLATES: JSON.stringify(templateFiles(join(root, "templates"))),
  },
});
addNode("src/cli/index.ts", "dist/cli.js", { banner: { js: "#!/usr/bin/env node" } });

// One bundle per webview: src/webview/<name>/main.tsx -> dist/webview/<name>.js (+ .css).
const webviewDir = join(root, "src/webview");
if (existsSync(webviewDir)) {
  for (const name of readdirSync(webviewDir)) {
    const entry = join("src/webview", name, "main.tsx");
    if (name === "shared" || !existsSync(join(root, entry))) continue;
    builds.push({
      ...common,
      platform: "browser",
      format: "iife",
      target: "es2022",
      entryPoints: { [name]: entry },
      outdir: "dist/webview",
      loader: { ".ttf": "file" },
      assetNames: "[name]",
      jsx: "automatic",
      jsxImportSource: "preact",
    });
  }
}

if (withTests) {
  const testDir = join(root, "test/integration");
  const entries = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(f)) entries.push(relative(root, p));
    }
  };
  if (existsSync(testDir)) walk(testDir);
  rmSync(join(root, "out"), { recursive: true, force: true });
  builds.push({
    ...nodeTarget,
    sourcemap: "inline",
    minify: false,
    entryPoints: entries,
    outdir: "out/test/integration",
    outbase: "test/integration",
    external: ["vscode", "mocha"],
  });
}

if (!watch) {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  mkdirSync(join(root, "dist"), { recursive: true });
}

const started = Date.now();
if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context({ ...options, logLevel: "info" });
    await ctx.watch();
  }
  console.log(`watching ${builds.length} bundles…`);
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log(`built ${builds.length} bundles in ${Date.now() - started} ms`);
}
