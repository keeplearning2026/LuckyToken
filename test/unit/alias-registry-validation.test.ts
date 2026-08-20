import { describe, expect, it } from "vitest";

describe("retired Alias validation", () => {
  it("has no independent validation layer after PublicModelAuthority replacement", async () => {
    expect(Object.keys(await import("../../src/aliases/domain.js"))).toEqual([]);
  });
});
