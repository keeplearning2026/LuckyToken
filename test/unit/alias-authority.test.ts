import { describe, expect, it } from "vitest";

describe("retired Alias Authority", () => {
  it("exports no runtime authority after PublicModelAuthority replacement", async () => {
    expect(Object.keys(await import("../../src/aliases/authority.js"))).toEqual([]);
  });
});
