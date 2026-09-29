import type { FetchFunction } from "@earendil-works/pi-ai";

import type {
  ProviderUsageEligibilityContext,
  ProviderUsageProbe,
  ProviderUsageProbeInput,
} from "../contract.js";
import {
  asRecord,
  canonicalUrl,
  fetchProviderUsageJson,
  toFiniteNumber,
} from "../wire.js";

const PROVIDER_ID = "moonshotai-cn";
const ORIGIN = "https://api.moonshot.cn";

export function createMoonshotAiCnUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (context.binding.kind !== "managed" || context.binding.authType !== "api_key") {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, ORIGIN, ["/v1"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const apiKey = auth.auth.apiKey?.trim();
      if (!apiKey) return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      const result = await fetchProviderUsageJson(
        fetch,
        `${ORIGIN}/v1/users/me/balance`,
        {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        },
        signal,
      );
      if (result.reason !== undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: result.reason });
      }
      const body = asRecord(result.body);
      const data = asRecord(body?.data) ?? body;
      const amount = toFiniteNumber(data?.available_balance);
      if (amount === undefined || amount < 0) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      return Object.freeze({
        state: "observed" as const,
        facts: Object.freeze({
          windows: Object.freeze([]),
          budgets: Object.freeze([
            Object.freeze({ kind: "balance" as const, amount, currency: "CNY" }),
          ]),
        }),
      });
    },
  });
}
