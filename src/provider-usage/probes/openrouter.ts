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

const PROVIDER_ID = "openrouter";
const ORIGIN = "https://openrouter.ai";

export function createOpenRouterUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (context.binding.kind !== "managed" || context.binding.authType !== "api_key") {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, ORIGIN, ["/api/v1"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const apiKey = auth.auth.apiKey?.trim();
      if (!apiKey) return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      const result = await fetchProviderUsageJson(
        fetch,
        `${ORIGIN}/api/v1/key`,
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
      if (data === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const limit = toFiniteNumber(data.limit);
      if (limit === undefined || limit <= 0) {
        return Object.freeze({
          state: "observed" as const,
          facts: Object.freeze({ windows: Object.freeze([]), budgets: Object.freeze([]) }),
        });
      }
      const remainingRaw = toFiniteNumber(data.limit_remaining);
      const usage = toFiniteNumber(data.usage);
      const used =
        remainingRaw !== undefined
          ? Math.max(0, limit - remainingRaw)
          : usage !== undefined && usage >= 0
            ? usage
            : undefined;
      if (used === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const remaining = Math.max(0, limit - used);
      return Object.freeze({
        state: "observed" as const,
        facts: Object.freeze({
          windows: Object.freeze([]),
          budgets: Object.freeze([
            Object.freeze({
              kind: "credits" as const,
              remaining,
              used,
              limit,
              currency: "USD",
            }),
          ]),
        }),
      });
    },
  });
}
