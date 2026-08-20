import { describe, expect, it } from "vitest";

import * as luckyToken from "../../src/index.js";
import { resolveRequestIdentity } from "../../src/request-identity.js";

describe("client authentication removal contract", () => {
  it("exposes request identity but no LuckyToken client-auth surface", () => {
    expect("createAuth" in luckyToken).toBe(false);
    expect(resolveRequestIdentity(new Headers(), () => "00000000-0000-4000-8000-000000000012")).toEqual({
      effectiveSessionId: "00000000-0000-4000-8000-000000000012",
    });
  });
});
