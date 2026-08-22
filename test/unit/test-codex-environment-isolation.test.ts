import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCodexHome } from "../../src/integrations/codex/home.js";

describe("test Codex environment isolation", () => {
  it("resolves a temporary Codex home instead of the user's real Codex home", async () => {
    const resolved = resolveCodexHome();
    const realDefault = resolve(join(homedir(), ".codex"));
    const relativeToTemp = relative(resolve(tmpdir()), resolved);
    const configPath = join(resolved, "config.toml");

    expect(process.env.LUCKYTOKEN_TEST_CODEX_SANDBOX).toBe("1");
    expect(resolved).not.toBe(realDefault);
    expect(relativeToTemp.startsWith("..")).toBe(false);
    if (existsSync(configPath)) {
      const config = readFileSync(configPath, "utf8");
      if (/^\s*model_catalog_json\s*=/mu.test(config)) {
        expect(config).toContain(
          `model_catalog_json = ${JSON.stringify(join(resolved, "luckytoken-model-catalog.json"))}`,
        );
      }
    }

    const reportPath = process.env.LUCKYTOKEN_CHILD_REPORT;
    if (reportPath !== undefined) {
      writeFileSync(reportPath, JSON.stringify({ codexHome: resolved }));
    }
    if (process.env.LUCKYTOKEN_TEST_HOLD_OPEN === "1") {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 30_000));
    }
  });
});
