import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: {
    include: ["test/unit/**/*.test.ts", "test/unit/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20000,
  },
});
