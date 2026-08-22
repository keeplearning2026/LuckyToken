import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCodexHome } from "../../src/integrations/codex/home.js";

describe("test Codex environment isolation", () => {
  it("resolves a temporary Codex home instead of the user's real Codex home", () => {
    const resolved = resolveCodexHome();
    const realDefault = resolve(join(homedir(), ".codex"));
    const relativeToTemp = relative(resolve(tmpdir()), resolved);

    expect(process.env.LUCKYTOKEN_TEST_CODEX_SANDBOX).toBe("1");
    expect(resolved).not.toBe(realDefault);
    expect(relativeToTemp.startsWith("..")).toBe(false);
  });
});
