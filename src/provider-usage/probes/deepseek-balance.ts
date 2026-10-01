import type { FetchFunction } from "@earendil-works/pi-ai";

import {
  PROVIDER_USAGE_MAX_CURRENCY_LENGTH,
  type ProviderUsageBudget,
  type ProviderUsageEligibilityContext,
  type ProviderUsageProbe,
  type ProviderUsageProbeInput,
} from "../contract.js";
import {
  asRecord,
  canonicalUrl,
  fetchProviderUsageJson,
  toFiniteNumber,
} from "../wire.js";

const ORIGIN = "https://api.deepseek.com";

export interface DeepSeekBalanceProbeDefinition {
  /** Token Provider identity this probe acquires balance for. */
  readonly providerId: string;
  /** Canonical model base paths this Provider may be served through. */
  readonly acceptedBasePaths: readonly string[];
}

interface DeepSeekBalanceRow {
  readonly currency: string;
  readonly amount: number;
}

function currencyRank(currency: string): number {
  if (currency === "USD") return 0;
  if (currency === "CNY") return 1;
  return 2;
}

/**
 * Reads one valid row per currency. `total_balance` stays the amount
 * authority; granted/topped-up components are only fallbacks when it is
 * absent or unparseable.
 *
 * Ordering never follows the upstream array order (observed to change
 * between calls): funded rows first, then USD, then CNY, then other
 * currencies by code. A zero row is a real observation and stays visible;
 * only a response with no valid row is a schema failure.
 */
function balanceRows(body: unknown): readonly DeepSeekBalanceRow[] | undefined {
  const record = asRecord(body);
  const infos = Array.isArray(record?.balance_infos) ? record.balance_infos : undefined;
  if (infos === undefined) return undefined;
  const rows: DeepSeekBalanceRow[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    const row = asRecord(info);
    if (row === undefined) continue;
    const amount =
      toFiniteNumber(row.total_balance) ??
      toFiniteNumber(row.granted_balance) ??
      toFiniteNumber(row.topped_up_balance);
    if (amount === undefined || amount < 0) continue;
    const currency = String(row.currency ?? "").trim().toUpperCase();
    if (
      currency.length === 0 ||
      currency.length > PROVIDER_USAGE_MAX_CURRENCY_LENGTH
    ) {
      continue;
    }
    if (seen.has(currency)) continue;
    seen.add(currency);
    rows.push({ currency, amount });
  }
  if (rows.length === 0) return undefined;
  rows.sort(
    (left, right) =>
      Number(right.amount > 0) - Number(left.amount > 0) ||
      currencyRank(left.currency) - currencyRank(right.currency) ||
      (left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0),
  );
  return Object.freeze(rows);
}

/**
 * The one DeepSeek balance acquisition shared by the Pi built-in `deepseek`
 * Provider and Token's `deepseek-anthropic` / `deepseek-response` Providers.
 * A Provider definition only contributes its identity and the canonical
 * model base paths its binding is allowed to use; the endpoint, credential
 * handling, parsing, display facts, and ordering are identical.
 */
export function createDeepSeekBalanceUsageProbe(
  fetch: FetchFunction,
  definition: DeepSeekBalanceProbeDefinition,
): ProviderUsageProbe {
  return Object.freeze({
    providerId: definition.providerId,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (context.binding.kind !== "managed" || context.binding.authType !== "api_key") {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(
        context.effectiveBaseUrl,
        ORIGIN,
        definition.acceptedBasePaths,
      )
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
      const rows = balanceRows(result.body);
      if (rows === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const budgets: ProviderUsageBudget[] = rows.map((row) =>
        Object.freeze({ kind: "balance" as const, amount: row.amount, currency: row.currency }),
      );
      return Object.freeze({
        state: "observed" as const,
        facts: Object.freeze({
          windows: Object.freeze([]),
          budgets: Object.freeze(budgets),
        }),
      });
    },
  });
}
