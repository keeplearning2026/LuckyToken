import { describe, expect, it } from "vitest";

import * as Token from "../../src/index.js";

describe("package public API", () => {
  it("exports session identity without a client-auth public surface", () => {
    expect("createAuth" in Token).toBe(false);
    expect(Token.resolveRequestIdentity).toBeTypeOf("function");
    expect(Token.createTokenRuntime).toBeTypeOf("function");
    expect(Token.startTokenHttpServer).toBeTypeOf("function");
  });
});
