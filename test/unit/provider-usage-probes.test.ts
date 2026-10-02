import type { AuthResult, FetchFunction } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import type {
  ProviderUsageEligibilityContext,
  ProviderUsageProbe,
} from "../../src/provider-usage/contract.js";
import { createAnthropicUsageProbe } from "../../src/provider-usage/probes/anthropic.js";
import { createCommandCodeGoatUsageProbe } from "../../src/provider-usage/probes/commandcode-goat.js";
import { createCommandCodePrivateUsageProbe } from "../../src/provider-usage/probes/commandcode-private.js";
import { createDeepSeekAnthropicUsageProbe } from "../../src/provider-usage/probes/deepseek-anthropic.js";
import { createDeepSeekResponseUsageProbe } from "../../src/provider-usage/probes/deepseek-response.js";
import { createDeepSeekUsageProbe } from "../../src/provider-usage/probes/deepseek.js";
import { createKimiCodingUsageProbe } from "../../src/provider-usage/probes/kimi-coding.js";
import { createMiniMaxUsageProbe } from "../../src/provider-usage/probes/minimax.js";
import { createMiniMaxCnUsageProbe } from "../../src/provider-usage/probes/minimax-cn.js";
import { createMoonshotAiUsageProbe } from "../../src/provider-usage/probes/moonshotai.js";
import { createMoonshotAiCnUsageProbe } from "../../src/provider-usage/probes/moonshotai-cn.js";
import { createOpenAiCodexUsageProbe } from "../../src/provider-usage/probes/openai-codex.js";
import { createOpenCodeGoUsageProbe } from "../../src/provider-usage/probes/opencode-go.js";
import { createOpenRouterUsageProbe } from "../../src/provider-usage/probes/openrouter.js";
import { createXaiUsageProbe } from "../../src/provider-usage/probes/xai.js";
import { createZaiUsageProbe } from "../../src/provider-usage/probes/zai.js";
import { createZaiCodingCnUsageProbe } from "../../src/provider-usage/probes/zai-coding-cn.js";
import { createBuiltInProviderUsageProbes } from "../../src/provider-usage/registry.js";
import { PROVIDER_USAGE_RESPONSE_MAX_BYTES } from "../../src/provider-usage/wire.js";

const API_KEY_AUTH: AuthResult = Object.freeze({
  auth: Object.freeze({ apiKey: "fixture-secret" }),
  source: "fixture",
});

function context(
  providerId: string,
  effectiveBaseUrl: string,
  authType: "api_key" | "oauth" = "api_key",
): ProviderUsageEligibilityContext {
  return Object.freeze({
    providerId,
    effectiveBaseUrl,
    binding: Object.freeze({ kind: "managed" as const, carrierOwner: "managed" as const, authType }),
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): {
  readonly fetch: FetchFunction;
  readonly calls: Array<{ readonly url: string; readonly init?: RequestInit }>;
} {
  const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  const fetch: FetchFunction = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    return handler(url, init);
  };
  return { fetch, calls };
}

async function acquire(
  probe: ProviderUsageProbe,
  auth: AuthResult = API_KEY_AUTH,
  signal: AbortSignal = new AbortController().signal,
) {
  return probe.acquire({ auth, signal });
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function probeFixtures(fetch: FetchFunction): readonly {
  readonly name: string;
  readonly probe: ProviderUsageProbe;
  readonly baseUrl: string;
  readonly authType: "api_key" | "oauth";
  readonly auth: AuthResult;
}[] {
  return [
    {
      name: "CommandCode Goat",
      probe: createCommandCodeGoatUsageProbe(fetch),
      baseUrl: "https://api.commandcode.ai/provider",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "CommandCode Private",
      probe: createCommandCodePrivateUsageProbe(fetch),
      baseUrl: "https://api.commandcode.ai",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "OpenCode Go",
      probe: createOpenCodeGoUsageProbe(fetch),
      baseUrl: "https://opencode.ai/zen/go/v1",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "Kimi Coding",
      probe: createKimiCodingUsageProbe(fetch),
      baseUrl: "https://api.kimi.com/coding",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "DeepSeek",
      probe: createDeepSeekUsageProbe(fetch),
      baseUrl: "https://api.deepseek.com",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "DeepSeek (Anthropic)",
      probe: createDeepSeekAnthropicUsageProbe(fetch),
      baseUrl: "https://api.deepseek.com/anthropic",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "DeepSeek (Responses)",
      probe: createDeepSeekResponseUsageProbe(fetch),
      baseUrl: "https://api.deepseek.com",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "OpenRouter",
      probe: createOpenRouterUsageProbe(fetch),
      baseUrl: "https://openrouter.ai/api/v1",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "MiniMax",
      probe: createMiniMaxUsageProbe(fetch),
      baseUrl: "https://api.minimax.io/anthropic",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "MiniMax CN",
      probe: createMiniMaxCnUsageProbe(fetch),
      baseUrl: "https://api.minimaxi.com/anthropic",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "Moonshot",
      probe: createMoonshotAiUsageProbe(fetch),
      baseUrl: "https://api.moonshot.ai/v1",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "Moonshot CN",
      probe: createMoonshotAiCnUsageProbe(fetch),
      baseUrl: "https://api.moonshot.cn/v1",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "Z.AI",
      probe: createZaiUsageProbe(fetch),
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "Z.AI Coding CN",
      probe: createZaiCodingCnUsageProbe(fetch),
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      authType: "api_key",
      auth: API_KEY_AUTH,
    },
    {
      name: "Anthropic",
      probe: createAnthropicUsageProbe(fetch),
      baseUrl: "https://api.anthropic.com",
      authType: "oauth",
      auth: API_KEY_AUTH,
    },
    {
      name: "xAI",
      probe: createXaiUsageProbe(fetch),
      baseUrl: "https://api.x.ai/v1",
      authType: "oauth",
      auth: {
        auth: { apiKey: jwt({ sub: "user-123" }) },
        source: "oauth",
      },
    },
    {
      name: "OpenAI Codex",
      probe: createOpenAiCodexUsageProbe(fetch),
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      auth: {
        auth: {
          apiKey: jwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct-123",
            },
          }),
        },
        source: "oauth",
      },
    },
  ];
}

describe("Provider Usage probes", () => {
  it("accepts every canonical model destination served by supported Pi built-ins", () => {
    const fetch: FetchFunction = async () => { throw new Error("no network expected"); };
    const probes = new Map(createBuiltInProviderUsageProbes(fetch).map((probe) => [probe.providerId, probe]));
    const oauthProviders = new Set(["anthropic", "xai", "openai-codex"]);
    for (const provider of builtinProviders()) {
      const probe = probes.get(provider.id);
      if (probe === undefined) continue;
      for (const baseUrl of new Set(provider.getModels().map((model) => model.baseUrl))) {
        expect(
          probe.eligibility({
            providerId: provider.id,
            effectiveBaseUrl: baseUrl,
            binding: {
              kind: "managed",
              authType: oauthProviders.has(provider.id) ? "oauth" : "api_key",
            },
          }),
          `${provider.id}: ${baseUrl}`,
        ).toEqual({ state: "eligible" });
      }
    }
  });

  it("keeps CommandCode Goat and Private identities/destinations isolated", async () => {
    const transport = createFetch((url) => {
      if (url.endsWith("/alpha/whoami")) return json({ org: { id: "org-a" } });
      if (url.includes("/alpha/billing/credits")) {
        return json({
          credits: { monthlyCredits: 40, purchasedCredits: 0, freeCredits: 5 },
          windowLimits: {
            fiveHour: { cap: 10, used: 5, resetAt: "2026-09-29T12:00:00Z" },
            weekly: { cap: 20, used: 4, resetAt: "2026-10-01T00:00:00Z" },
          },
        });
      }
      if (url.includes("/alpha/billing/subscriptions")) {
        return json({
          currentPeriodStart: "2026-09-20T00:00:00Z",
          currentPeriodEnd: "2026-10-20T00:00:00Z",
        });
      }
      if (url.includes("/alpha/usage/summary")) return json({ totalCost: 15 });
      return json({}, 404);
    });
    const goat = createCommandCodeGoatUsageProbe(transport.fetch);
    const privateProbe = createCommandCodePrivateUsageProbe(transport.fetch);

    expect(goat.providerId).toBe("commandcode-goat");
    expect(privateProbe.providerId).toBe("commandcode-private");
    expect(
      goat.eligibility(context("commandcode-goat", "https://api.commandcode.ai/provider")),
    ).toEqual({ state: "eligible" });
    expect(
      goat.eligibility(context("commandcode-goat", "https://api.commandcode.ai")),
    ).toEqual({ state: "unsupported_destination" });
    expect(
      privateProbe.eligibility(
        context("commandcode-private", "https://api.commandcode.ai"),
      ),
    ).toEqual({ state: "eligible" });
    expect(
      privateProbe.eligibility(
        context("commandcode-private", "https://api.commandcode.ai/provider"),
      ),
    ).toEqual({ state: "unsupported_destination" });

    const goatResult = await acquire(goat);
    const privateResult = await acquire(privateProbe);
    expect(goatResult).toMatchObject({
      state: "observed",
      facts: {
        windows: [
          { kind: "five_hour", usedPercent: 50 },
          { kind: "weekly", usedPercent: 20 },
        ],
        budgets: [{ kind: "credits", remaining: 45, used: 15, limit: 60 }],
      },
    });
    expect(privateResult).toMatchObject({
      state: "observed",
      facts: {
        windows: [
          { kind: "five_hour", usedPercent: 50 },
          { kind: "weekly", usedPercent: 20 },
        ],
      },
    });
  });

  it("normalizes OpenCode Go rolling, weekly and monthly windows", async () => {
    const transport = createFetch(() =>
      json({
        usage: {
          rolling: { percent: 12.5, resetsAt: "2026-09-29T12:00:00Z" },
          weekly: { percent: 8 },
          monthly: { percent: 3 },
        },
      }),
    );
    const probe = createOpenCodeGoUsageProbe(transport.fetch);
    expect(
      probe.eligibility(context("opencode-go", "https://opencode.ai/zen/go/v1")),
    ).toEqual({ state: "eligible" });
    expect(await acquire(probe)).toMatchObject({
      state: "observed",
      facts: {
        windows: [
          { kind: "five_hour", usedPercent: 12.5 },
          { kind: "weekly", usedPercent: 8 },
          { kind: "monthly", usedPercent: 3 },
        ],
      },
    });
  });

  it("does not publish empty facts from malformed Goat, Private, or OpenCode responses", async () => {
    const transport = createFetch((url) =>
      json(
        url.endsWith("/alpha/whoami")
          ? {}
          : url.includes("opencode.ai")
            ? { usage: {} }
            : { credits: {}, windowLimits: {} },
      ),
    );
    for (const probe of [
      createCommandCodeGoatUsageProbe(transport.fetch),
      createCommandCodePrivateUsageProbe(transport.fetch),
      createOpenCodeGoUsageProbe(transport.fetch),
    ]) {
      expect(await acquire(probe), probe.providerId).toEqual({
        state: "unavailable",
        reason: "schema",
      });
    }
  });

  it("normalizes Kimi Code windows and total credits", async () => {
    const transport = createFetch(() =>
      json({
        limits: [
          {
            name: "5h",
            detail: {
              limit: 100,
              used: 25,
              resetTime: "2026-09-29T12:00:00Z",
            },
          },
          {
            name: "weekly",
            detail: { limit: 1000, used: 200 },
          },
        ],
        totalQuota: { limit: 2000, used: 500, remaining: 1500 },
      }),
    );
    const probe = createKimiCodingUsageProbe(transport.fetch);
    expect(
      probe.eligibility(context("kimi-coding", "https://api.kimi.com/coding", "oauth")),
    ).toEqual({ state: "eligible" });
    expect(await acquire(probe)).toMatchObject({
      state: "observed",
      facts: {
        windows: [
          { kind: "five_hour", usedPercent: 25 },
          { kind: "weekly", usedPercent: 20 },
        ],
        budgets: [
          { kind: "credits", remaining: 1500, used: 500, limit: 2000 },
        ],
      },
    });
  });

  it("does not treat missing DeepSeek balance rows as authoritative empty", async () => {
    const transport = createFetch(() => json({ balance_infos: [] }));
    const probe = createDeepSeekUsageProbe(transport.fetch);
    expect(await acquire(probe)).toEqual({
      state: "unavailable",
      reason: "schema",
    });
  });

  it("projects every DeepSeek currency balance without fabricating a percentage", async () => {
    const transport = createFetch(() =>
      json({
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "100.00",
          },
          {
            currency: "USD",
            total_balance: "42.50",
            granted_balance: "10.00",
            topped_up_balance: "32.50",
          },
        ],
      }),
    );
    const probe = createDeepSeekUsageProbe(transport.fetch);
    expect(await acquire(probe)).toEqual({
      state: "observed",
      facts: {
        windows: [],
        budgets: [
          { kind: "balance", amount: 42.5, currency: "USD" },
          { kind: "balance", amount: 100, currency: "CNY" },
        ],
      },
    });
  });

  it("orders DeepSeek balances independently of the upstream row order", async () => {
    const payloads = [
      [
        { currency: "USD", total_balance: "0.00" },
        { currency: "CNY", total_balance: "9.39" },
      ],
      [
        { currency: "CNY", total_balance: "9.39" },
        { currency: "USD", total_balance: "0.00" },
      ],
    ];
    for (const balance_infos of payloads) {
      const transport = createFetch(() => json({ balance_infos }));
      expect(await acquire(createDeepSeekUsageProbe(transport.fetch))).toEqual({
        state: "observed",
        facts: {
          windows: [],
          budgets: [
            { kind: "balance", amount: 9.39, currency: "CNY" },
            { kind: "balance", amount: 0, currency: "USD" },
          ],
        },
      });
    }
  });

  it("keeps zero and single-currency DeepSeek balances visible", async () => {
    const zeroTransport = createFetch(() =>
      json({
        balance_infos: [
          { currency: "CNY", total_balance: "0.00" },
          { currency: "USD", total_balance: "0.00" },
        ],
      }),
    );
    expect(await acquire(createDeepSeekUsageProbe(zeroTransport.fetch))).toEqual({
      state: "observed",
      facts: {
        windows: [],
        budgets: [
          { kind: "balance", amount: 0, currency: "USD" },
          { kind: "balance", amount: 0, currency: "CNY" },
        ],
      },
    });

    const singleTransport = createFetch(() =>
      json({ balance_infos: [{ currency: "CNY", total_balance: "0.37" }] }),
    );
    expect(await acquire(createDeepSeekUsageProbe(singleTransport.fetch))).toEqual({
      state: "observed",
      facts: {
        windows: [],
        budgets: [{ kind: "balance", amount: 0.37, currency: "CNY" }],
      },
    });
  });

  it("shares one DeepSeek balance result across the three DeepSeek Providers", async () => {
    const expected = {
      state: "observed",
      facts: {
        windows: [],
        budgets: [
          { kind: "balance", amount: 9.39, currency: "CNY" },
          { kind: "balance", amount: 0, currency: "USD" },
        ],
      },
    } as const;
    for (const createProbe of [
      createDeepSeekUsageProbe,
      createDeepSeekAnthropicUsageProbe,
      createDeepSeekResponseUsageProbe,
    ]) {
      const transport = createFetch(() =>
        json({
          balance_infos: [
            { currency: "USD", total_balance: "0.00" },
            { currency: "CNY", total_balance: "9.39" },
          ],
        }),
      );
      expect(await acquire(createProbe(transport.fetch)), createProbe.name).toEqual(expected);
    }
  });

  it("keeps the three DeepSeek Provider destinations on their canonical base paths", () => {
    const fetch: FetchFunction = async () => {
      throw new Error("network must not be reached");
    };
    const builtIn = createDeepSeekUsageProbe(fetch);
    const anthropicProvider = createDeepSeekAnthropicUsageProbe(fetch);
    const responseProvider = createDeepSeekResponseUsageProbe(fetch);
    expect(
      builtIn.eligibility(context("deepseek", "https://api.deepseek.com")),
    ).toEqual({ state: "eligible" });
    expect(
      builtIn.eligibility(context("deepseek", "https://api.deepseek.com/v1")),
    ).toEqual({ state: "eligible" });
    expect(
      builtIn.eligibility(context("deepseek", "https://api.deepseek.com/anthropic")),
    ).toEqual({ state: "unsupported_destination" });
    expect(
      anthropicProvider.eligibility(
        context("deepseek-anthropic", "https://api.deepseek.com/anthropic"),
      ),
    ).toEqual({ state: "eligible" });
    expect(
      anthropicProvider.eligibility(
        context("deepseek-anthropic", "https://api.deepseek.com"),
      ),
    ).toEqual({ state: "unsupported_destination" });
    expect(
      responseProvider.eligibility(
        context("deepseek-response", "https://api.deepseek.com"),
      ),
    ).toEqual({ state: "eligible" });
    expect(
      responseProvider.eligibility(
        context("deepseek-response", "https://api.deepseek.com/v1"),
      ),
    ).toEqual({ state: "eligible" });
    expect(
      responseProvider.eligibility(
        context("deepseek-response", "https://api.deepseek.com/anthropic"),
      ),
    ).toEqual({ state: "unsupported_destination" });
  });

  it("treats OpenRouter uncapped success as authoritative empty", async () => {
    let capped = true;
    const transport = createFetch(() =>
      json({
        data: capped
          ? { limit: 100, limit_remaining: 73.5, usage: 1000 }
          : { limit: null, usage: 26.5 },
      }),
    );
    const probe = createOpenRouterUsageProbe(transport.fetch);
    expect(await acquire(probe)).toEqual({
      state: "observed",
      facts: {
        windows: [],
        budgets: [
          {
            kind: "credits",
            remaining: 73.5,
            used: 26.5,
            limit: 100,
            currency: "USD",
          },
        ],
      },
    });
    capped = false;
    expect(await acquire(probe)).toEqual({
      state: "observed",
      facts: { windows: [], budgets: [] },
    });
    expect(
      probe.eligibility(
        context("openrouter", "https://openrouter.ai/api/v1", "oauth"),
      ),
    ).toEqual({ state: "unsupported_binding" });
  });

  for (const fixture of [
    {
      name: "MiniMax international",
      probe: createMiniMaxUsageProbe,
      baseUrl: "https://api.minimax.io/anthropic",
    },
    {
      name: "MiniMax China",
      probe: createMiniMaxCnUsageProbe,
      baseUrl: "https://api.minimaxi.com/anthropic",
    },
  ] as const) {
    it(`normalizes ${fixture.name} Coding Plan remaining percentages`, async () => {
      const transport = createFetch(() =>
        json({
          base_resp: { status_code: 0 },
          model_remains: [
            {
              model_name: "general",
              current_interval_remaining_percent: 63.5,
              end_time: "2026-09-29T12:00:00Z",
              current_weekly_status: 1,
              current_weekly_remaining_percent: 81.2,
              weekly_end_time: "2026-10-01T00:00:00Z",
            },
          ],
        }),
      );
      const probe = fixture.probe(transport.fetch);
      expect(
        probe.eligibility(context(probe.providerId, fixture.baseUrl)),
      ).toEqual({ state: "eligible" });
      const result = await acquire(probe);
      expect(result).toMatchObject({
        state: "observed",
        facts: {
          windows: [
            { kind: "five_hour", usedPercent: 36.5 },
            { kind: "weekly" },
          ],
        },
      });
      if (result.state !== "observed") {
        throw new Error("Expected observed MiniMax usage");
      }
      expect(result.facts.windows[1]?.usedPercent).toBeCloseTo(18.8, 10);
    });
  }

  for (const fixture of [
    {
      name: "MiniMax international missing plan",
      probe: createMiniMaxUsageProbe,
      baseUrl: "https://api.minimax.io/anthropic",
    },
    {
      name: "MiniMax China missing plan",
      probe: createMiniMaxCnUsageProbe,
      baseUrl: "https://api.minimaxi.com/anthropic",
    },
  ] as const) {
    it(`does not treat ${fixture.name} as authoritative empty`, async () => {
      const transport = createFetch(() =>
        json({
          base_resp: { status_code: 0 },
          model_remains: [{ model_name: "video" }],
        }),
      );
      const probe = fixture.probe(transport.fetch);
      expect(await acquire(probe)).toEqual({
        state: "unavailable",
        reason: "schema",
      });
    });
  }

  for (const fixture of [
    {
      name: "Moonshot international",
      probe: createMoonshotAiUsageProbe,
      baseUrl: "https://api.moonshot.ai/v1",
      currency: "USD",
    },
    {
      name: "Moonshot China",
      probe: createMoonshotAiCnUsageProbe,
      baseUrl: "https://api.moonshot.cn/v1",
      currency: "CNY",
    },
  ] as const) {
    it(`normalizes ${fixture.name} balance`, async () => {
      const transport = createFetch(() =>
        json({
          data: {
            available_balance: 120.5,
            voucher_balance: 20.5,
            cash_balance: 100,
          },
        }),
      );
      const probe = fixture.probe(transport.fetch);
      expect(
        probe.eligibility(context(probe.providerId, fixture.baseUrl)),
      ).toEqual({ state: "eligible" });
      expect(await acquire(probe)).toEqual({
        state: "observed",
        facts: {
          windows: [],
          budgets: [
            { kind: "balance", amount: 120.5, currency: fixture.currency },
          ],
        },
      });
    });
  }

  for (const fixture of [
    {
      name: "Z.AI international",
      probe: createZaiUsageProbe,
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      authorization: "Bearer fixture-secret",
    },
    {
      name: "Z.AI China",
      probe: createZaiCodingCnUsageProbe,
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      authorization: "fixture-secret",
    },
  ] as const) {
    it(`normalizes ${fixture.name} token windows and exact auth scheme`, async () => {
      const transport = createFetch((_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          fixture.authorization,
        );
        return json({
          success: true,
          data: {
            limits: [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 31.5,
                nextResetTime: 1_800_000_000_000,
              },
              {
                type: "CREDIT_LIMIT",
                unit: 6,
                number: 1,
                currentValue: 120,
                usage: 1000,
              },
              {
                type: "TIME_LIMIT",
                unit: 5,
                number: 1,
                percentage: 99,
              },
            ],
          },
        });
      });
      const probe = fixture.probe(transport.fetch);
      expect(
        probe.eligibility(context(probe.providerId, fixture.baseUrl)),
      ).toEqual({ state: "eligible" });
      expect(await acquire(probe)).toMatchObject({
        state: "observed",
        facts: {
          windows: [
            { kind: "five_hour", usedPercent: 31.5 },
            { kind: "weekly", usedPercent: 12 },
          ],
        },
      });
    });
  }

  it("treats Z.AI TIME_LIMIT-only payload as authoritative empty", async () => {
    const transport = createFetch(() =>
      json({
        success: true,
        data: {
          limits: [{ type: "TIME_LIMIT", percentage: 100 }],
        },
      }),
    );
    expect(await acquire(createZaiUsageProbe(transport.fetch))).toEqual({
      state: "observed",
      facts: { windows: [], budgets: [] },
    });
  });

  it("normalizes Anthropic OAuth usage and only recognized model scopes", async () => {
    const transport = createFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer fixture-secret");
      expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
      return json({
        five_hour: { utilization: 31.5, resets_at: "2026-09-29T12:00:00Z" },
        seven_day: { utilization: 22 },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 10,
            scope: { model: { display_name: "Claude Opus" } },
          },
          {
            kind: "weekly_scoped",
            percent: 99,
            scope: { model: { display_name: "attacker supplied arbitrary" } },
          },
        ],
      });
    });
    const probe = createAnthropicUsageProbe(transport.fetch);
    expect(
      probe.eligibility(context("anthropic", "https://api.anthropic.com", "oauth")),
    ).toEqual({ state: "eligible" });
    expect(
      probe.eligibility(context("anthropic", "https://api.anthropic.com", "api_key")),
    ).toEqual({ state: "unsupported_binding" });
    expect(await acquire(probe)).toMatchObject({
      state: "observed",
      facts: {
        windows: [
          { kind: "five_hour", usedPercent: 31.5 },
          { kind: "weekly", usedPercent: 22 },
          {
            kind: "weekly",
            usedPercent: 10,
            scope: { kind: "model", modelLabel: "Opus" },
          },
        ],
      },
    });
  });

  it("derives xAI user id only from the resolved OAuth access token", async () => {
    const access = jwt({ sub: "user-123" });
    const transport = createFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-userid")).toBe("user-123");
      return json({
        config: {
          creditUsagePercent: 12,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            end: "2026-10-01T00:00:00Z",
          },
        },
      });
    });
    const probe = createXaiUsageProbe(transport.fetch);
    expect(
      probe.eligibility(context("xai", "https://api.x.ai/v1", "oauth")),
    ).toEqual({ state: "eligible" });
    expect(
      await acquire(probe, {
        auth: { apiKey: access },
        source: "oauth",
      }),
    ).toMatchObject({
      state: "observed",
      facts: { windows: [{ kind: "weekly", usedPercent: 12 }] },
    });
  });

  it("derives Codex account id from JWT and normalizes WHAM windows", async () => {
    const access = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    });
    const transport = createFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("chatgpt-account-id")).toBe("acct-123");
      return json({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 42,
            reset_at: 1_800_000_000,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 17,
            reset_at: 1_800_500_000,
            limit_window_seconds: 604_800,
          },
          tertiary_window: {
            used_percent: 4,
            reset_at: 1_802_000_000,
            limit_window_seconds: 2_592_000,
          },
        },
        rate_limit_reset_credits: { available_count: 2 },
      });
    });
    const probe = createOpenAiCodexUsageProbe(transport.fetch);
    expect(
      probe.eligibility(
        context("openai-codex", "https://chatgpt.com/backend-api", "oauth"),
      ),
    ).toEqual({ state: "eligible" });
    expect(
      await acquire(probe, {
        auth: { apiKey: access },
        source: "oauth",
      }),
    ).toMatchObject({
      state: "observed",
      facts: {
        windows: [
          { kind: "five_hour", usedPercent: 42 },
          { kind: "weekly", usedPercent: 17 },
          { kind: "monthly", usedPercent: 4 },
        ],
        budgets: [{ kind: "reset_credits", available: 2 }],
      },
    });
  });

  it("certifies supported managed Profile eligibility for every registered probe", () => {
    const transport = createFetch(() => {
      throw new Error("network must not be reached");
    });
    for (const fixture of probeFixtures(transport.fetch)) {
      expect(
        fixture.probe.eligibility(
          context(
            fixture.probe.providerId,
            fixture.baseUrl,
            fixture.authType,
          ),
        ),
        fixture.name,
      ).toEqual({ state: "eligible" });
    }
    expect(transport.calls).toEqual([]);
  });

  it("returns typed auth failure without network when eligible acquisition lacks auth", async () => {
    const transport = createFetch(() => {
      throw new Error("network must not be reached");
    });
    const missingAuth = { auth: {}, source: "fixture" } as AuthResult;
    for (const fixture of probeFixtures(transport.fetch)) {
      await expect(
        acquire(fixture.probe, missingAuth),
        fixture.name,
      ).resolves.toEqual({
        state: "unavailable",
        reason: "auth",
      });
    }
    expect(transport.calls).toEqual([]);
  });

  for (const [status, reason] of [
    [401, "auth"],
    [403, "auth"],
    [429, "upstream"],
    [500, "upstream"],
  ] as const) {
    it(`classifies HTTP ${status} for every registered probe without leaking credentials`, async () => {
      const transport = createFetch(() => json({}, status));
      for (const fixture of probeFixtures(transport.fetch)) {
        const result = await acquire(fixture.probe, fixture.auth);
        expect(result, fixture.name).toEqual({
          state: "unavailable",
          reason: fixture.probe.providerId === "openai-codex" && reason === "auth" ? "temporary" : reason,
        });
        expect(JSON.stringify(result), fixture.name).not.toContain(
          "fixture-secret",
        );
      }
    });
  }

  it.each([
    [401, "{}", "temporary"],
    [403, "<html>blocked</html>", "temporary"],
    [401, '{"error":{"code":"invalid_refresh_token"}}', "terminal"],
    [403, '{"detail":{"code":"invalid_workspace_selected"}}', "terminal"],
    [403, '{"error":{"code":"model_not_available"}}', "temporary"],
  ] as const)("requires terminal evidence for Codex HTTP %s (%s)", async (status, body, reason) => {
    const access = `header.${Buffer.from(JSON.stringify({
      exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    })).toString("base64url")}.signature`;
    const transport = createFetch(() => new Response(body, { status }));
    expect(await acquire(createOpenAiCodexUsageProbe(transport.fetch), {
      auth: { apiKey: access }, source: "oauth",
    })).toEqual({ state: "unavailable", reason });
  });

  it("rejects malformed provider schemas for every registered probe", async () => {
    const transport = createFetch(() => json({}));
    for (const fixture of probeFixtures(transport.fetch)) {
      await expect(
        acquire(fixture.probe, fixture.auth),
        fixture.name,
      ).resolves.toEqual({
        state: "unavailable",
        reason: "schema",
      });
    }
  });

  it("classifies malformed JSON and oversized responses for every registered probe", async () => {
    const malformedTransport = createFetch(
      () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    for (const fixture of probeFixtures(malformedTransport.fetch)) {
      await expect(
        acquire(fixture.probe, fixture.auth),
        fixture.name,
      ).resolves.toEqual({
        state: "unavailable",
        reason: "schema",
      });
    }

    const oversizedTransport = createFetch(
      () =>
        new Response("", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(PROVIDER_USAGE_RESPONSE_MAX_BYTES + 1),
          },
        }),
    );
    for (const fixture of probeFixtures(oversizedTransport.fetch)) {
      await expect(
        acquire(fixture.probe, fixture.auth),
        fixture.name,
      ).resolves.toEqual({
        state: "unavailable",
        reason: "schema",
      });
    }
  });

  it("honors parent-signal abort for every registered probe", async () => {
    const fetch: FetchFunction = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      });

    for (const fixture of probeFixtures(fetch)) {
      const controller = new AbortController();
      const pending = acquire(fixture.probe, fixture.auth, controller.signal);
      controller.abort(new Error("parent abort"));
      await expect(pending, fixture.name).resolves.toEqual({
        state: "unavailable",
        reason: "network",
      });
    }
  });

  it("rejects non-canonical effective destinations in every registered probe", () => {
    const transport = createFetch(() => {
      throw new Error("network must not be reached");
    });
    const probes = [
      createCommandCodeGoatUsageProbe(transport.fetch),
      createCommandCodePrivateUsageProbe(transport.fetch),
      createOpenCodeGoUsageProbe(transport.fetch),
      createKimiCodingUsageProbe(transport.fetch),
      createDeepSeekUsageProbe(transport.fetch),
      createDeepSeekAnthropicUsageProbe(transport.fetch),
      createDeepSeekResponseUsageProbe(transport.fetch),
      createOpenRouterUsageProbe(transport.fetch),
      createMiniMaxUsageProbe(transport.fetch),
      createMiniMaxCnUsageProbe(transport.fetch),
      createMoonshotAiUsageProbe(transport.fetch),
      createMoonshotAiCnUsageProbe(transport.fetch),
      createZaiUsageProbe(transport.fetch),
      createZaiCodingCnUsageProbe(transport.fetch),
      createAnthropicUsageProbe(transport.fetch),
      createXaiUsageProbe(transport.fetch),
      createOpenAiCodexUsageProbe(transport.fetch),
    ];
    for (const probe of probes) {
      const authType =
        probe.providerId === "anthropic" ||
        probe.providerId === "xai" ||
        probe.providerId === "openai-codex"
          ? "oauth"
          : "api_key";
      expect(
        probe.eligibility(
          context(probe.providerId, "https://credential-sink.invalid/v1", authType),
        ),
        probe.providerId,
      ).toEqual({ state: "unsupported_destination" });
    }
    expect(transport.calls).toEqual([]);
  });
});
