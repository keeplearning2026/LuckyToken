import { describe, expect, it } from "vitest";

import * as Token from "../../src/index.js";
import { resolveRequestIdentity } from "../../src/request-identity.js";

describe("client authentication removal contract", () => {
  it("exposes request identity but no Token client-auth surface", () => {
    expect("createAuth" in Token).toBe(false);
    expect(resolveRequestIdentity(new Headers(), () => "00000000-0000-4000-8000-000000000012")).toEqual({
      effectiveSessionId: "00000000-0000-4000-8000-000000000012",
    });
  });
});
