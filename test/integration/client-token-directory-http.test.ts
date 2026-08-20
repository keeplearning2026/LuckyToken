import { describe, expect, it } from "vitest";

import {
  createRequestIdentityObserver,
  projectRequestIdentity,
} from "../../src/request-observation/index.js";

describe("request identity project-context removal contract", () => {
  it("never records or projects projectDir", () => {
    const record = createRequestIdentityObserver({ now: () => 1 })
      .observe(
        "openai-responses",
        {
          clientSessionId: "00000000-0000-4000-8000-000000000001",
          projectDir: "C:/obsolete-project",
        } as never,
      )
      .list()[0]!;

    expect(record).not.toHaveProperty("projectDir");
    expect(projectRequestIdentity(record)).not.toHaveProperty("projectDir");
  });
});
