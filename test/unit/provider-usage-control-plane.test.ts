import { describe, expect, it } from "vitest";

import {
  controlPlaneVersion,
  decodeProviderUsageCommand,
  decodeProviderUsageCommandResult,
} from "@token/application-control-plane/control-plane";

describe("Provider Usage Control Plane contract", () => {
  it("ships on Control Plane v9", () => {
    expect(controlPlaneVersion).toBe(9);
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

  it("round-trips Profile-scoped observed facts", () => {
    const value = {
      outcome: "ok",
      snapshot: {
        profiles: [
          {
            providerId: "openrouter",
            credentialId: "profile-a",
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
        credentialId: "profile-a",
        outcome: "succeeded",
      },
    } as const;

    expect(decodeProviderUsageCommandResult(value)).toEqual(value);
  });

  it("rejects malformed percentages and credential-bearing fields", () => {
    expect(
      decodeProviderUsageCommandResult({
        outcome: "ok",
        snapshot: {
          profiles: [
            {
              providerId: "deepseek",
              credentialId: "profile-a",
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
          profiles: [
            {
              providerId: "deepseek",
              credentialId: "profile-a",
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
          profiles: [
            {
              providerId: "openrouter",
              credentialId: "profile-a",
              state: "unsupported",
              reason: "destination",
            },
            {
              providerId: "deepseek",
              credentialId: "profile-b",
              state: "unavailable",
              reason: "network",
            },
          ],
        },
      }),
    ).toMatchObject({
      snapshot: {
        profiles: [
          {
            credentialId: "profile-a",
            state: "unsupported",
            reason: "destination",
          },
          {
            credentialId: "profile-b",
            state: "unavailable",
            reason: "network",
          },
        ],
      },
    });

    expect(
      decodeProviderUsageCommandResult({
        outcome: "ok",
        snapshot: {
          profiles: [
            {
              providerId: "openrouter",
              credentialId: "profile-a",
              state: "unavailable",
              reason: "destination",
            },
          ],
        },
      }),
    ).toBeUndefined();
  });
});
