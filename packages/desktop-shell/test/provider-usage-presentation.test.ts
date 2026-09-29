import { describe, expect, it } from "vitest";

import { projectProviderCardUsage } from "../src/renderer/providers/provider-usage-presentation.js";

describe("Provider usage presentation", () => {
  it("formats structured windows and balances without Provider wire knowledge", () => {
    expect(
      projectProviderCardUsage(
        {
          providerId: "deepseek",
          state: "observed",
          observedAt: 1,
          refreshable: true,
          windows: [
            {
              kind: "five_hour",
              usedPercent: 53.16,
              resetAt: 3_600_000,
            },
          ],
          budgets: [
            { kind: "balance", amount: 42.5, currency: "USD" },
          ],
        },
        0,
      ),
    ).toMatchObject({
      primary: ["5h 53%", "Balance $42.50"],
      secondary: ["5h resets in 1h"],
      refreshable: true,
    });
  });

  it("distinguishes authoritative empty from unobserved", () => {
    expect(
      projectProviderCardUsage(
        {
          providerId: "openrouter",
          state: "observed",
          observedAt: 1,
          refreshable: true,
          windows: [],
          budgets: [],
        },
        0,
      ),
    ).toMatchObject({
      status: "No current limit reported",
      refreshable: true,
    });
    expect(
      projectProviderCardUsage(
        {
          providerId: "openrouter",
          state: "unobserved",
        },
        0,
      ),
    ).toMatchObject({
      status: "Usage not refreshed",
      refreshable: true,
    });
  });

  it("does not offer refresh for passive-only observations, unsupported bindings, or destinations", () => {
    expect(
      projectProviderCardUsage(
        {
          providerId: "anthropic",
          state: "observed",
          observedAt: 1,
          refreshable: false,
          windows: [{ kind: "weekly", usedPercent: 22 }],
          budgets: [],
        },
        0,
      ),
    ).toMatchObject({
      primary: ["Week 22%"],
      refreshable: false,
    });
    expect(
      projectProviderCardUsage(
        {
          providerId: "anthropic",
          state: "unsupported",
          reason: "binding",
        },
        0,
      ),
    ).toMatchObject({
      status: "Usage unavailable for this account type",
      refreshable: false,
    });
    expect(
      projectProviderCardUsage(
        {
          providerId: "deepseek",
          state: "unsupported",
          reason: "destination",
        },
        0,
      ),
    ).toMatchObject({
      status: "Usage unavailable for this endpoint",
      refreshable: false,
    });
  });
});
