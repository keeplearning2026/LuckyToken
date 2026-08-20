import { describe, expect, it } from "vitest";

describe("retired Alias Model seam", () => {
  it("exports no request-resolution seam after PublicModelSource replacement", async () => {
    expect(Object.keys(await import("../../src/alias-model-seam.js"))).toEqual([]);
  });
});
