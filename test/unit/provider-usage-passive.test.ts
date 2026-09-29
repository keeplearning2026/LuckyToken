import { describe, expect, it, vi } from "vitest";

import type { ProviderAuthBindingCapture } from "../../src/credentials/profile-contract.js";
import {
  createProviderUsageResponseObserver,
  parseAnthropicPassiveUsage,
} from "../../src/provider-usage/passive.js";

const capture: ProviderAuthBindingCapture = Object.freeze({
  facts: Object.freeze({
    kind: "managed" as const,
    providerId: "anthropic",
    credentialId: "credential-a",
    authType: "api_key" as const,
    authMethodLabel: "Anthropic API key",
    displayName: "Primary",
    credentialGeneration: "generation-a",
    selectionGeneration: "selection-a",
  }),
});

describe("Provider Usage passive observation", () => {
  it("normalizes Anthropic unified utilization fractions and epoch-second resets", () => {
    expect(
      parseAnthropicPassiveUsage({
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.315",
          "anthropic-ratelimit-unified-5h-reset": "1800000000",
          "anthropic-ratelimit-unified-7d-utilization": "0.22",
          "anthropic-ratelimit-unified-7d-reset": "1800500000",
        },
      }),
    ).toEqual({
      windows: [
        {
          kind: "five_hour",
          usedPercent: 31.5,
          resetAt: 1_800_000_000_000,
        },
        {
          kind: "weekly",
          usedPercent: 22,
          resetAt: 1_800_500_000_000,
        },
      ],
      budgets: [],
    });
  });

  it("rejects non-success responses, invalid scales, and headerless responses", () => {
    expect(
      parseAnthropicPassiveUsage({
        status: 429,
        headers: { "anthropic-ratelimit-unified-5h-utilization": "0.5" },
      }),
    ).toBeUndefined();
    expect(
      parseAnthropicPassiveUsage({
        status: 200,
        headers: { "anthropic-ratelimit-unified-5h-utilization": "50" },
      }),
    ).toBeUndefined();
    expect(parseAnthropicPassiveUsage({ status: 200, headers: {} })).toBeUndefined();
  });

  it("publishes only managed Anthropic API-key observations", async () => {
    const observePassive = vi.fn(async () => true);
    const observer = createProviderUsageResponseObserver({ observePassive });
    const response = {
      status: 200,
      headers: { "anthropic-ratelimit-unified-5h-utilization": "0.5" },
    };

    await observer({
      model: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      } as never,
      capture,
      response,
    });
    expect(observePassive).toHaveBeenCalledWith(
      "anthropic",
      capture,
      "https://api.anthropic.com",
      {
        windows: [{ kind: "five_hour", usedPercent: 50 }],
        budgets: [],
      },
    );

    observePassive.mockClear();
    await observer({
      model: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      } as never,
      capture,
      response,
    });
    expect(observePassive).not.toHaveBeenCalled();

    observePassive.mockClear();
    await observer({
      model: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      } as never,
      capture: {
        facts: { kind: "ambient", providerId: "anthropic" },
      },
      response,
    });
    expect(observePassive).not.toHaveBeenCalled();

    observePassive.mockClear();
    await observer({
      model: {
        provider: "anthropic",
        baseUrl: "https://credential-sink.invalid/v1",
      } as never,
      capture,
      response,
    });
    expect(observePassive).not.toHaveBeenCalled();
  });
});
