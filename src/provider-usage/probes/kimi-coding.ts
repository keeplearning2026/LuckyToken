import type { FetchFunction } from "@earendil-works/pi-ai";

import type {
  ProviderUsageBudget,
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

const PROVIDER_ID = "kimi-coding";
const ORIGIN = "https://api.kimi.com";
const USAGE_URL = "https://api.kimi.com/coding/v1/usages";

function rowPercent(value: unknown): {
  readonly usedPercent: number;
  readonly resetAt?: number;
  readonly used?: number;
  readonly limit?: number;
  readonly remaining?: number;
} | undefined {
  const row = asRecord(value);
  if (row === undefined) return undefined;
  const limit = toFiniteNumber(row.limit);
  let used = toFiniteNumber(row.used);
  const remaining = toFiniteNumber(row.remaining);
  if (used === undefined && limit !== undefined && remaining !== undefined) {
    used = limit - remaining;
  }
  let usedPercent =
    limit !== undefined && limit > 0 && used !== undefined
      ? normalizePercent((used / limit) * 100)
      : undefined;
  usedPercent ??= normalizePercent(
    row.utilization ?? row.percent ?? row.usedPercent ?? row.used_percent,
  );
  if (usedPercent === undefined) return undefined;
  const resetAt = normalizeResetAt(
    row.resetTime ?? row.resetAt ?? row.reset_time ?? row.reset_at,
  );
  return Object.freeze({
    usedPercent,
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
  });
}

function labelOf(item: Record<string, unknown>, detail: Record<string, unknown>): string {
  return [item.name, item.title, item.scope, detail.name, detail.title]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function isFiveHour(item: Record<string, unknown>, detail: Record<string, unknown>): boolean {
  const window = asRecord(item.window) ?? {};
  const duration = toFiniteNumber(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "").toUpperCase();
  return (
    (unit.includes("MINUTE") && duration === 300) ||
    (unit.includes("HOUR") && duration === 5) ||
    /(^|\b)5\s*(?:h|hour)/u.test(labelOf(item, detail))
  );
}

function isWeekly(item: Record<string, unknown>, detail: Record<string, unknown>): boolean {
  const window = asRecord(item.window) ?? {};
  const duration = toFiniteNumber(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "").toUpperCase();
  return (
    (unit.includes("DAY") && duration === 7) ||
    (unit.includes("HOUR") && duration === 168) ||
    /weekly|7\s*(?:d|day)/u.test(labelOf(item, detail))
  );
}

export function createKimiCodingUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (
        context.binding.kind !== "managed" ||
        (context.binding.authType !== "api_key" && context.binding.authType !== "oauth")
      ) {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, ORIGIN, ["/coding"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const bearer = auth.auth.apiKey?.trim();
      if (!bearer) return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      const result = await fetchProviderUsageJson(
        fetch,
        USAGE_URL,
        {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
        },
        signal,
      );
      if (result.reason !== undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: result.reason });
      }
      const outer = asRecord(result.body);
      if (outer === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const nested = asRecord(outer.data);
      const body =
        nested !== undefined &&
        outer.usage == null &&
        outer.limits == null &&
        outer.totalQuota == null
          ? nested
          : outer;

      const windows: ProviderUsageWindow[] = [];
      let weekly = rowPercent(body.usage);
      let fiveHour: ReturnType<typeof rowPercent>;
      if (Array.isArray(body.limits)) {
        for (const raw of body.limits) {
          const item = asRecord(raw);
          if (item === undefined) continue;
          const detail = asRecord(item.detail) ?? item;
          if (fiveHour === undefined && isFiveHour(item, detail)) {
            fiveHour = rowPercent(detail);
          }
          if (weekly === undefined && isWeekly(item, detail)) {
            weekly = rowPercent(detail);
          }
        }
      }
      if (fiveHour !== undefined) {
        windows.push(Object.freeze({
          kind: "five_hour",
          usedPercent: fiveHour.usedPercent,
          ...(fiveHour.resetAt === undefined ? {} : { resetAt: fiveHour.resetAt }),
        }));
      }
      if (weekly !== undefined) {
        windows.push(Object.freeze({
          kind: "weekly",
          usedPercent: weekly.usedPercent,
          ...(weekly.resetAt === undefined ? {} : { resetAt: weekly.resetAt }),
        }));
      }

      const budgets: ProviderUsageBudget[] = [];
      const total = rowPercent(body.totalQuota);
      if (total?.limit !== undefined && total.used !== undefined) {
        const remaining = Math.max(
          0,
          total.remaining ?? total.limit - total.used,
        );
        budgets.push(Object.freeze({
          kind: "credits",
          remaining,
          used: Math.max(0, total.used),
          limit: total.limit,
          ...(total.resetAt === undefined ? {} : { expiresAt: total.resetAt }),
        }));
      } else if (total !== undefined) {
        windows.push(Object.freeze({
          kind: "custom",
          usedPercent: total.usedPercent,
          ...(total.resetAt === undefined ? {} : { resetAt: total.resetAt }),
        }));
      }

      if (windows.length === 0 && budgets.length === 0) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      return Object.freeze({
        state: "observed" as const,
        facts: Object.freeze({
          windows: Object.freeze(windows),
          budgets: Object.freeze(budgets),
        }),
      });
    },
  });
}
