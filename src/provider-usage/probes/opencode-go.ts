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
} from "../wire.js";

const PROVIDER_ID = "opencode-go";
const ORIGIN = "https://opencode.ai";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

function parseWindow(
  value: unknown,
  kind: "five_hour" | "weekly" | "monthly",
): ProviderUsageWindow | undefined {
  const row = asRecord(value);
  if (row === undefined) return undefined;
  const usedPercent = normalizePercent(row.percent);
  if (usedPercent === undefined) return undefined;
  const resetAt = normalizeResetAt(row.resetsAt);
  return Object.freeze({
    kind,
    usedPercent,
    ...(resetAt === undefined ? {} : { resetAt }),
  });
}

export function createOpenCodeGoUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (context.binding.kind !== "managed" || context.binding.authType !== "api_key") {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, ORIGIN, ["/zen/go", "/zen/go/v1"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const apiKey = auth.auth.apiKey?.trim();
      if (!apiKey) return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      const result = await fetchProviderUsageJson(
        fetch,
        USAGE_URL,
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
      const usage = asRecord(body?.usage);
      if (usage === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const windows = [
        parseWindow(usage.rolling, "five_hour"),
        parseWindow(usage.weekly, "weekly"),
        parseWindow(usage.monthly, "monthly"),
      ].filter((value): value is ProviderUsageWindow => value !== undefined);
      if (windows.length === 0) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
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
