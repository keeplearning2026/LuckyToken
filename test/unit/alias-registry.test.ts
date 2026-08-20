import { describe, expect, it } from "vitest";

describe("retired Alias registry", () => {
  it("exports no registry implementation after PublicModelAuthority replacement", async () => {
    expect(Object.keys(await import("../../src/aliases/index.js"))).toEqual([]);
  });
});
