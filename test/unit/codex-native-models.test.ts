import { describe, expect, it } from "vitest";

import type { CodexNativeModelSource } from "../../src/codex-native-seam.js";

describe("Codex Local Native model seam", () => {
  it("requires only read-only membership and no Pi model collection", () => {
    const native: CodexNativeModelSource = Object.freeze({
      has: (modelId: string) => modelId === "gpt-native",
    });

    expect(native.has("gpt-native")).toBe(true);
    expect(native.has("other")).toBe(false);
    expect(Object.keys(native)).toEqual(["has"]);
  });
});
