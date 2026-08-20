import { describe, expect, it } from "vitest";

import { resolveRequestIdentity } from "../../src/request-identity.js";

describe("removed live Client Token authority", () => {
  it("keeps request identity session-only even when authorization headers are present", () => {
    const identity = resolveRequestIdentity(
      new Headers({
        authorization: "Bearer obsolete-client-token",
        "x-api-key": "obsolete-api-key",
      }),
      () => "30000000-0000-4000-8000-000000000032",
    );

    expect(identity).toEqual({
      effectiveSessionId: "30000000-0000-4000-8000-000000000032",
    });
    expect(identity).not.toHaveProperty("authorized");
    expect(identity).not.toHaveProperty("projectDir");
  });
});
