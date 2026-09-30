import { describe, expect, it } from "vitest";

import {
  controlPlaneVersion,
  decodeAgentIntegrationsCommandResult,
} from "@token/application-control-plane/control-plane";

describe("Agent integrations Control Plane contract", () => {
  it("ships Claude integration on Control Plane v7", () => {
    expect(controlPlaneVersion).toBe(7);
  });

  it("decodes Claude as a first-class Agent integration id", () => {
    expect(
      decodeAgentIntegrationsCommandResult({
        outcome: "ok",
        state: {
          agents: [
            {
              agentId: "claude",
              enabled: false,
              scope: "favorite",
              modelCount: 0,
              needsSync: false,
            },
          ],
        },
        results: [],
      }),
    ).toEqual({
      outcome: "ok",
      state: {
        agents: [
          {
            agentId: "claude",
            enabled: false,
            scope: "favorite",
            modelCount: 0,
            needsSync: false,
          },
        ],
      },
      results: [],
    });
  });
});
