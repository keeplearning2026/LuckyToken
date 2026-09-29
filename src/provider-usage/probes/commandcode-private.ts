import type { FetchFunction } from "@earendil-works/pi-ai";

import type {
  ProviderUsageBudget,
  ProviderUsageEligibilityContext,
  ProviderUsageFacts,
  ProviderUsageProbe,
  ProviderUsageProbeInput,
  ProviderUsageProbeResult,
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

const PROVIDER_ID = "commandcode-private";
const ORIGIN = "https://api.commandcode.ai";

function parseWindow(value: unknown, kind: "five_hour" | "weekly"): ProviderUsageWindow | undefined {
  const row = asRecord(value);
  if (row === undefined) return undefined;
  const cap = toFiniteNumber(row.cap);
  const used = toFiniteNumber(row.used);
  if (cap === undefined || used === undefined || cap <= 0 || used < 0) return undefined;
  const usedPercent = normalizePercent((used / cap) * 100);
  if (usedPercent === undefined) return undefined;
  const resetAt = normalizeResetAt(row.resetAt);
  return Object.freeze({
    kind,
    usedPercent,
    ...(resetAt === undefined ? {} : { resetAt }),
  });
}

async function optionalJson(
  fetch: FetchFunction,
  url: string,
  bearer: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const result = await fetchProviderUsageJson(
    fetch,
    url,
    {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
    },
    signal,
  );
  if (result.body === undefined) return undefined;
  const raw = asRecord(result.body);
  return asRecord(raw?.data) ?? raw;
}

function remainingCredits(credits: Record<string, unknown>): {
  readonly remaining: number;
  readonly purchased: number;
} | undefined {
  const values = [
    credits.monthlyCredits,
    credits.purchasedCredits,
    credits.freeCredits,
  ]
    .map(toFiniteNumber)
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  return Object.freeze({
    remaining: values.reduce((sum, value) => sum + Math.max(0, value), 0),
    purchased: Math.max(0, toFiniteNumber(credits.purchasedCredits) ?? 0),
  });
}

async function acquireCommandCodePrivate(
  fetch: FetchFunction,
  bearer: string,
  signal: AbortSignal,
): Promise<ProviderUsageProbeResult> {
  const whoami = await optionalJson(fetch, `${ORIGIN}/alpha/whoami`, bearer, signal);
  const orgId = (() => {
    const org = asRecord(whoami?.org);
    return typeof org?.id === "string" && org.id.trim().length > 0
      ? org.id.trim()
      : undefined;
  })();
  const orgQuery = orgId === undefined ? "" : `?orgId=${encodeURIComponent(orgId)}`;

  const creditsResult = await fetchProviderUsageJson(
    fetch,
    `${ORIGIN}/alpha/billing/credits${orgQuery}`,
    {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
    },
    signal,
  );
  if (creditsResult.reason !== undefined) {
    return Object.freeze({ state: "unavailable", reason: creditsResult.reason });
  }
  const raw = asRecord(creditsResult.body);
  const body = asRecord(raw?.data) ?? raw;
  const credits = asRecord(body?.credits);
  const limits = asRecord(body?.windowLimits);
  if (credits === undefined && limits === undefined) {
    return Object.freeze({ state: "unavailable", reason: "schema" });
  }

  const windows: ProviderUsageWindow[] = [];
  const fiveHour = parseWindow(limits?.fiveHour, "five_hour");
  const weekly = parseWindow(limits?.weekly, "weekly");
  if (fiveHour !== undefined) windows.push(fiveHour);
  if (weekly !== undefined) windows.push(weekly);

  const budgets: ProviderUsageBudget[] = [];
  if (credits !== undefined) {
    const pool = remainingCredits(credits);
    const subscription = await optionalJson(
      fetch,
      `${ORIGIN}/alpha/billing/subscriptions${orgQuery}`,
      bearer,
      signal,
    );
    const periodStart =
      typeof subscription?.currentPeriodStart === "string"
        ? subscription.currentPeriodStart.trim()
        : "";
    if (pool !== undefined && periodStart.length > 0) {
      const separator = orgQuery.length > 0 ? "&" : "?";
      const summary = await optionalJson(
        fetch,
        `${ORIGIN}/alpha/usage/summary${orgQuery}${separator}since=${encodeURIComponent(periodStart)}`,
        bearer,
        signal,
      );
      const used =
        toFiniteNumber(summary?.totalCost) ??
        toFiniteNumber(summary?.totalMonthlyCredits);
      if (used !== undefined && used >= 0) {
        const limit = used + pool.remaining;
        const expiresAt = normalizeResetAt(subscription?.currentPeriodEnd);
        budgets.push(
          Object.freeze({
            kind: "credits",
            remaining: pool.remaining,
            used,
            limit,
            ...(expiresAt === undefined || pool.purchased > 0 ? {} : { expiresAt }),
          }),
        );
      }
    }
  }

  const facts: ProviderUsageFacts = Object.freeze({
    windows: Object.freeze(windows),
    budgets: Object.freeze(budgets),
  });
  return Object.freeze({ state: "observed", facts });
}

export function createCommandCodePrivateUsageProbe(
  fetch: FetchFunction,
): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (
        context.binding.kind !== "managed" ||
        context.binding.authType !== "api_key"
      ) {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(
        context.effectiveBaseUrl,
        ORIGIN,
        ["/"],
      )
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const bearer = auth.auth.apiKey?.trim();
      if (bearer === undefined || bearer.length === 0) {
        return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      }
      return acquireCommandCodePrivate(fetch, bearer, signal);
    },
  });
}
