import type { FetchFunction } from "@earendil-works/pi-ai";

import type {
  ProviderUsageEligibilityContext,
  ProviderUsageProbe,
  ProviderUsageProbeInput,
  ProviderUsageWindow,
} from "../contract.js";
import {
  asRecord,
  canonicalUrl,
  fetchProviderUsageJson,
  normalizePercent,
  normalizeResetAt,
  toFiniteNumber,
} from "../wire.js";

const PROVIDER_ID = "minimax-cn";
const ORIGIN = "https://api.minimaxi.com";

export function createMiniMaxCnUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (context.binding.kind !== "managed" || context.binding.authType !== "api_key") {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, ORIGIN, ["/anthropic", "/v1"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const apiKey = auth.auth.apiKey?.trim();
      if (!apiKey) return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      const result = await fetchProviderUsageJson(
        fetch,
        `${ORIGIN}/v1/api/openplatform/coding_plan/remains`,
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
      if (body === undefined || asRecord(body.base_resp)?.status_code !== 0) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const rows = Array.isArray(body.model_remains) ? body.model_remains : [];
      const general = rows.map(asRecord).find((row) => row?.model_name === "general");
      if (general === undefined) {
        return Object.freeze({
          state: "unavailable" as const,
          reason: "schema" as const,
        });
      }
      const windows: ProviderUsageWindow[] = [];
      const fiveRemaining = toFiniteNumber(general.current_interval_remaining_percent);
      if (fiveRemaining !== undefined) {
        const usedPercent = normalizePercent(100 - fiveRemaining);
        if (usedPercent !== undefined) {
          const resetAt = normalizeResetAt(general.end_time);
          windows.push(Object.freeze({
            kind: "five_hour",
            usedPercent,
            ...(resetAt === undefined ? {} : { resetAt }),
          }));
        }
      }
      if (general.current_weekly_status === 1) {
        const weeklyRemaining = toFiniteNumber(general.current_weekly_remaining_percent);
        if (weeklyRemaining !== undefined) {
          const usedPercent = normalizePercent(100 - weeklyRemaining);
          if (usedPercent !== undefined) {
            const resetAt = normalizeResetAt(general.weekly_end_time);
            windows.push(Object.freeze({
              kind: "weekly",
              usedPercent,
              ...(resetAt === undefined ? {} : { resetAt }),
            }));
          }
        }
      }
      if (windows.length === 0) {
        return Object.freeze({
          state: "unavailable" as const,
          reason: "schema" as const,
        });
      }
      return Object.freeze({
        state: "observed" as const,
        facts: Object.freeze({ windows: Object.freeze(windows), budgets: Object.freeze([]) }),
      });
    },
  });
}
