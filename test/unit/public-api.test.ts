import { describe, expect, it } from "vitest";

import * as luckyToken from "../../src/index.js";

describe("package public API", () => {
  it("exports session identity without a client-auth public surface", () => {
    expect("createAuth" in luckyToken).toBe(false);
    expect(luckyToken.resolveRequestIdentity).toBeTypeOf("function");
    expect(luckyToken.createLuckyTokenRuntime).toBeTypeOf("function");
    expect(luckyToken.startLuckyTokenHttpServer).toBeTypeOf("function");
  });
});
