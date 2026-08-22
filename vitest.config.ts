import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["pi-agent/**", "node_modules/**", "dist/**"],
    globalSetup: ["test/setup-codex-sandbox.ts"],
    setupFiles: ["test/setup-clean-env.ts"],
  },
});
