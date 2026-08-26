import { describe, expect, it } from "vitest";

import type { CodexDirectModelSource } from "../../src/codex-direct-seam.js";

describe("Codex Direct Mode model seam", () => {
  it("requires only read-only membership and no Pi model collection", () => {
    const direct: CodexDirectModelSource = Object.freeze({
      has: (modelId: string) => modelId === "gpt-native",
    });

    expect(direct.has("gpt-native")).toBe(true);
    expect(direct.has("other")).toBe(false);
    expect(Object.keys(direct)).toEqual(["has"]);
  });
});
