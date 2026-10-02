import { describe, expect, it } from "vitest";

import {
  projectProviderCardUsage,
  providerUsageRefreshFailureNotice,
  providerUsageRefreshNotice,
} from "../src/renderer/providers/provider-usage-presentation.js";

describe("Provider usage presentation", () => {
  it("keeps explicit refresh reachable before the initial cache query succeeds", () => {
    expect(projectProviderCardUsage(undefined, 0)).toMatchObject({
      status: "Usage not refreshed",
      refreshable: true,
    });
    expect(providerUsageRefreshFailureNotice()).toBe(
      "Provider usage could not be refreshed.",
    );
    expect(
      providerUsageRefreshNotice({
        providerId: "anthropic",
        outcome: "unsupported",
        reason: "destination",
      }),
    ).toBe("Provider usage cannot be refreshed for this endpoint.");
  });

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

  it("keeps the initial refresh cue while leaving empty observations quiet", () => {
    const emptyObservation = projectProviderCardUsage(
      {
        providerId: "openrouter",
        state: "observed",
        observedAt: 1,
        refreshable: true,
        windows: [],
        budgets: [],
      },
      0,
    );
    expect(emptyObservation.refreshable).toBe(true);
    expect(emptyObservation.status).toBeUndefined();
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

  it("keeps failure messages independent of credential acquisition", () => {
    expect(projectProviderCardUsage({ providerId: "openai-codex", state: "unavailable", reason: "temporary" }, 0))
      .toEqual({ primary: [], secondary: [], refreshable: true });
    expect(providerUsageRefreshNotice({ providerId: "openai-codex", outcome: "unavailable", reason: "terminal" }))
      .toBe("Provider usage could not be refreshed.");
  });

  it("groups every currency balance under one Balance label", () => {
    expect(
      projectProviderCardUsage(
        {
          providerId: "deepseek",
          state: "observed",
          observedAt: 1,
          refreshable: true,
          windows: [],
          budgets: [
            { kind: "balance", amount: 9.39, currency: "CNY" },
            { kind: "balance", amount: 0, currency: "USD" },
          ],
        },
        0,
      ),
    ).toMatchObject({
      primary: ["Balance CN¥9.39 · $0.00"],
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
    const unsupportedBinding = projectProviderCardUsage(
      {
        providerId: "anthropic",
        state: "unsupported",
        reason: "binding",
      },
      0,
    );
    expect(unsupportedBinding).toMatchObject({ refreshable: false });
    expect(unsupportedBinding.status).toBeUndefined();
    const unsupportedDestination = projectProviderCardUsage(
      {
        providerId: "deepseek",
        state: "unsupported",
        reason: "destination",
      },
      0,
    );
    expect(unsupportedDestination).toMatchObject({ refreshable: false });
    expect(unsupportedDestination.status).toBeUndefined();
  });
});
