import { describe, expect, it } from "vitest";

import {
  controlPlaneVersion,
  decodeProviderUsageCommand,
  decodeProviderUsageCommandResult,
} from "@token/application-control-plane/control-plane";

describe("Provider Usage Control Plane contract", () => {
  it("ships on Control Plane v7", () => {
    expect(controlPlaneVersion).toBe(7);
  });

  it("strictly decodes query and refresh commands", () => {
    expect(decodeProviderUsageCommand({ command: "query" })).toEqual({
      command: "query",
    });
    expect(
      decodeProviderUsageCommand({
        command: "refresh",
        providerId: "openrouter",
      }),
    ).toEqual({
      command: "refresh",
      providerId: "openrouter",
    });
    expect(
      decodeProviderUsageCommand({
        command: "refresh",
        providerId: "openrouter",
        secret: "forbidden",
      }),
    ).toBeUndefined();
  });

  it("round-trips authoritative empty observed facts", () => {
    expect(
      decodeProviderUsageCommandResult({
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "openrouter",
              state: "observed",
              observedAt: 123,
              refreshable: true,
              windows: [],
              budgets: [],
            },
          ],
        },
        refresh: {
          providerId: "openrouter",
          outcome: "succeeded",
        },
      }),
    ).toEqual({
      outcome: "ok",
      snapshot: {
        providers: [
          {
            providerId: "openrouter",
            state: "observed",
            observedAt: 123,
            refreshable: true,
            windows: [],
            budgets: [],
          },
        ],
      },
      refresh: {
        providerId: "openrouter",
        outcome: "succeeded",
      },
    });
  });

  it("rejects malformed percentages and credential-bearing fields", () => {
    expect(
      decodeProviderUsageCommandResult({
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "deepseek",
              state: "observed",
              observedAt: 1,
              refreshable: true,
              windows: [{ kind: "weekly", usedPercent: 101 }],
              budgets: [],
            },
          ],
        },
      }),
    ).toBeUndefined();

    expect(
      decodeProviderUsageCommandResult({
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "deepseek",
              state: "unobserved",
              apiKey: "must-not-cross",
            },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it("keeps unsupported and unavailable reasons distinct", () => {
    expect(
      decodeProviderUsageCommandResult({
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "openrouter",
              state: "unsupported",
              reason: "destination",
            },
            {
              providerId: "deepseek",
              state: "unavailable",
              reason: "network",
            },
          ],
        },
      }),
    ).toMatchObject({
      snapshot: {
        providers: [
          { state: "unsupported", reason: "destination" },
          { state: "unavailable", reason: "network" },
        ],
      },
    });

    expect(
      decodeProviderUsageCommandResult({
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "openrouter",
              state: "unavailable",
              reason: "destination",
            },
          ],
        },
      }),
    ).toBeUndefined();
  });
});
