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

const PROVIDER_ID = "deepseek";
const ORIGIN = "https://api.deepseek.com";

export function createDeepSeekUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (context.binding.kind !== "managed" || context.binding.authType !== "api_key") {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, ORIGIN, ["/", "/v1"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const apiKey = auth.auth.apiKey?.trim();
      if (!apiKey) return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      const result = await fetchProviderUsageJson(
        fetch,
        `${ORIGIN}/user/balance`,
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
      const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : undefined;
      if (infos === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const rows = infos
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => row !== undefined);
      const pick = (currency: string) =>
        rows.find((row) => String(row.currency ?? "").toUpperCase() === currency);
      const row = pick("USD") ?? pick("CNY") ?? rows.find((candidate) => {
        const amount =
          toFiniteNumber(candidate.total_balance) ??
          toFiniteNumber(candidate.granted_balance) ??
          toFiniteNumber(candidate.topped_up_balance);
        return amount !== undefined && amount >= 0;
      });
      if (row === undefined) {
        return Object.freeze({
          state: "observed" as const,
          facts: Object.freeze({ windows: Object.freeze([]), budgets: Object.freeze([]) }),
        });
      }
      const amount =
        toFiniteNumber(row.total_balance) ??
        toFiniteNumber(row.granted_balance) ??
        toFiniteNumber(row.topped_up_balance);
      if (amount === undefined || amount < 0) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const currency = String(row.currency ?? "").trim().toUpperCase();
      if (currency.length === 0 || currency.length > 16) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      return Object.freeze({
        state: "observed" as const,
        facts: Object.freeze({
          windows: Object.freeze([]),
          budgets: Object.freeze([
            Object.freeze({ kind: "balance" as const, amount, currency }),
          ]),
        }),
      });
    },
  });
}
