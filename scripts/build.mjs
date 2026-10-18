// Bundles every target with esbuild.
//
//   node scripts/build.mjs              extension, mcp-server, cli and all webviews -> dist/
//   node scripts/build.mjs --watch      rebuild on change
//   node scripts/build.mjs --tests      also bundle the integration tests -> out/test/integration/
//   node scripts/build.mjs --production minified, no source maps (used by vscode:prepublish); also
//                                       writes THIRD-PARTY-NOTICES.md for the bundled packages
import esbuild from "esbuild";
import { existsSync, readdirSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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

/**
 * exceljs loads unzipper only for its streaming workbook reader, which the planner never uses (it
 * only writes workbooks). A stub keeps unzipper and its dependencies, one of which declares no
 * license, out of the bundles.
 */
const noUnzipper = {
  name: "no-unzipper",
  setup(build) {
    build.onResolve({ filter: /^unzipper$/ }, () => ({ path: "unzipper", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "module.exports = { Parse() { throw new Error('Reading Excel files is not supported.'); } };",
      loader: "js",
    }));
  },
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const nodeTarget = {
  ...common,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: { PLANNER_VERSION: JSON.stringify(pkg.version) },
  plugins: [noUnzipper],
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
  const results = await Promise.all(
    builds.map((options) => esbuild.build({ ...options, metafile: production }))
  );
  console.log(`built ${builds.length} bundles in ${Date.now() - started} ms`);
  if (production) writeNotices(results.map((r) => r.metafile));
}

/**
 * THIRD-PARTY-NOTICES.md: every npm package that ended up in a bundle, with its license texts, as
 * the licenses of the bundled code require. Derived from esbuild's metafile, so it lists exactly
 * what ships in dist/.
 */
function writeNotices(metafiles) {
  const dirs = new Set();
  for (const meta of metafiles)
    for (const input of Object.keys(meta.inputs)) {
      const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, "/"));
      if (m) dirs.add(m[1]);
    }
  const packages = [...dirs]
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
      const licenses = readdirSync(join(root, dir))
        .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))
        .sort()
        .map((f) =>
          readFileSync(join(root, dir, f), "utf8")
            .replace(/\r\n?/g, "\n")
            .trim()
        );
      const license =
        typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "");
      const a = manifest.author;
      const author =
        typeof a === "string" ? a : a?.name ? `${a.name}${a.email ? ` <${a.email}>` : ""}` : "";
      return { name: manifest.name, version: manifest.version, license, author, licenses };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const unique = packages.filter(
    (p, i) => packages.findIndex((q) => q.name === p.name && q.version === p.version) === i
  );
  const lines = [
    "# Third-party notices",
    "",
    "Markdown Project Planner bundles the following open-source packages in `dist/`. Their licenses",
    "follow. This file is generated by `node scripts/build.mjs --production`.",
    "",
  ];
  for (const p of unique) {
    lines.push(`## ${p.name} ${p.version}`, "", `License: ${p.license || "not declared"}`);
    if (p.author) lines.push(`Author: ${p.author}`);
    lines.push("");
    if (p.licenses.length === 0)
      lines.push(
        p.license
          ? `The package includes no license file; it is distributed under the ${p.license} license declared in its package.json.`
          : "The package includes no license file and declares no license.",
        ""
      );
    for (const text of p.licenses) lines.push("```text", text, "```", "");
  }
  writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), lines.join("\n"));
  console.log(`THIRD-PARTY-NOTICES.md: ${unique.length} packages`);
}
