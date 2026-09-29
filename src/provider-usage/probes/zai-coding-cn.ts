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

const PROVIDER_ID = "zai-coding-cn";
const ORIGIN = "https://open.bigmodel.cn";

export function createZaiCodingCnUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (context.binding.kind !== "managed" || context.binding.authType !== "api_key") {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, ORIGIN, ["/","/api/coding/paas/v4","/api/v1"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const apiKey = auth.auth.apiKey?.trim();
      if (!apiKey) return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      const result = await fetchProviderUsageJson(
        fetch,
        `${ORIGIN}/api/monitor/usage/quota/limit`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: apiKey,
          },
        },
        signal,
      );
      if (result.reason !== undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: result.reason });
      }
      const body = asRecord(result.body);
      if (body === undefined || body.success === false) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const data = asRecord(body.data) ?? body;
      if (!Array.isArray(data.limits)) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const windows: ProviderUsageWindow[] = [];
      for (const raw of data.limits) {
        const row = asRecord(raw);
        if (row === undefined || (row.type !== "TOKENS_LIMIT" && row.type !== "CREDIT_LIMIT")) {
          continue;
        }
        let usedPercent = normalizePercent(row.percentage);
        if (usedPercent === undefined) {
          const used = toFiniteNumber(row.currentValue);
          const total = toFiniteNumber(row.usage);
          if (used !== undefined && total !== undefined && total > 0) {
            usedPercent = normalizePercent((used / total) * 100);
          }
        }
        if (usedPercent === undefined) continue;
        const unit = toFiniteNumber(row.unit);
        const number = toFiniteNumber(row.number);
        const kind =
          unit === 3 && number === 5
            ? "five_hour"
            : unit === 6 && number === 1
              ? "weekly"
              : undefined;
        if (kind === undefined) continue;
        const resetAt = normalizeResetAt(row.nextResetTime);
        windows.push(Object.freeze({
          kind,
          usedPercent,
          ...(resetAt === undefined ? {} : { resetAt }),
        }));
      }
      return Object.freeze({
        state: "observed" as const,
        facts: Object.freeze({
          windows: Object.freeze(windows),
          budgets: Object.freeze([]),
        }),
      });
    },
  });
}
