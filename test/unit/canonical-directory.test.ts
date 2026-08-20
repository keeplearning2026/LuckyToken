import { describe, expect, it } from "vitest";

import { resolveRequestIdentity } from "../../src/request-identity.js";

describe("request identity has no project-directory authority", () => {
  it("ignores project-looking headers and exposes only session identity", () => {
    const identity = resolveRequestIdentity(
      new Headers({
        "x-project-dir": "C:/obsolete-project",
        "x-session-id": "20000000-0000-4000-8000-000000000031",
      }),
      () => "30000000-0000-4000-8000-000000000032",
    );

    expect(identity).toEqual({
      clientSessionId: "20000000-0000-4000-8000-000000000031",
      effectiveSessionId: "20000000-0000-4000-8000-000000000031",
    });
    expect(identity).not.toHaveProperty("projectDir");
  });
});
