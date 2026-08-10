import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["pi-agent/**", "node_modules/**", "dist/**"],
  },
});
