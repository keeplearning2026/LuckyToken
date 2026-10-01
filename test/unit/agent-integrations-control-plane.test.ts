import { describe, expect, it } from "vitest";

import {
  controlPlaneVersion,
  decodeAgentIntegrationsCommandResult,
} from "@token/application-control-plane/control-plane";

describe("Agent integrations Control Plane contract", () => {
  it("ships Claude integration on Control Plane v7", () => {
    expect(controlPlaneVersion).toBe(8);
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

  it("decodes DSH as a scoped Agent integration", () => {
    expect(
      decodeAgentIntegrationsCommandResult({
        outcome: "ok",
        state: { agents: [{
          agentId: "dsh", enabled: true, scope: "favorite", modelCount: 1, needsSync: false,
        }] },
        results: [],
      })?.state.agents[0]?.agentId,
    ).toBe("dsh");
  });

  it("decodes Claude Desktop as an independent scoped integration", () => {
    expect(
      decodeAgentIntegrationsCommandResult({
        outcome: "ok",
        state: { agents: [{
          agentId: "claude-desktop", enabled: true, scope: "full", modelCount: 2, needsSync: false,
        }] },
        results: [],
      })?.state.agents[0],
    ).toMatchObject({ agentId: "claude-desktop", scope: "full" });
  });
});
