import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "out/**",
      "node_modules/**",
      ".vscode-test/**",
      "examples/**",
      "templates/**",
      "test/fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
    },
  },
  {
    // The core is shared by the extension, MCP server and CLI: it must never depend on VS Code.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "vscode", message: "src/core must not import vscode." }],
          patterns: [
            { group: ["**/extension/**", "**/webview/**"], message: "core is the bottom layer." },
          ],
        },
      ],
    },
  },
  {
    // Webviews run in a browser sandbox: no VS Code API, no Node, no direct file access.
    files: ["src/webview/**/*.ts", "src/webview/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "vscode", message: "webviews talk to the host via protocol.ts." }],
          patterns: [{ group: ["node:*", "fs", "path", "child_process"] }],
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        fetch: "readonly",
        WebSocket: "readonly",
      },
    },
  }
);
