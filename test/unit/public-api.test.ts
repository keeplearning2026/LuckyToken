import { describe, expect, it } from "vitest";

import {
  createAuth,
  createLuckyTokenRuntime,
  startLuckyTokenHttpServer,
} from "../../src/index.js";

describe("package public API", () => {
  it("exports the Provider-blind composition seams from the package root", () => {
    expect(createAuth).toBeTypeOf("function");
    expect(createLuckyTokenRuntime).toBeTypeOf("function");
    expect(startLuckyTokenHttpServer).toBeTypeOf("function");
  });
});
