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
  normalizePercent,
  normalizeResetAt,
  toFiniteNumber,
} from "../wire.js";

const PROVIDER_ID = "xai";
const PROVIDER_ORIGIN = "https://api.x.ai";
const BILLING_ORIGIN = "https://cli-chat-proxy.grok.com";
const BILLING_URL = `${BILLING_ORIGIN}/v1/billing`;

function jwtSubject(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" && payload.sub.trim().length > 0
      ? payload.sub.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function centsValue(value: unknown): number | undefined {
  return toFiniteNumber(asRecord(value)?.val);
}

export function createXaiUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (context.binding.kind !== "managed" || context.binding.authType !== "oauth") {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, PROVIDER_ORIGIN, ["/v1"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const accessToken = auth.auth.apiKey?.trim();
      if (!accessToken) {
        return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      }

      const userId = jwtSubject(accessToken);
      if (userId !== undefined) {
        const weeklyResult = await fetchProviderUsageJson(
          fetch,
          `${BILLING_URL}?format=credits`,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${accessToken}`,
              "x-xai-token-auth": "xai-grok-cli",
              "x-authenticateresponse": "authenticate-response",
              "x-userid": userId,
              "x-grok-client-version": "0.2.93",
            },
          },
          signal,
        );
        if (weeklyResult.reason === undefined) {
          const config = asRecord(asRecord(weeklyResult.body)?.config);
          const period = asRecord(config?.currentPeriod);
          if (config !== undefined && period?.type === "USAGE_PERIOD_TYPE_WEEKLY") {
            const usedPercent =
              config.creditUsagePercent === undefined
                ? 0
                : normalizePercent(config.creditUsagePercent);
            if (usedPercent !== undefined) {
              const resetAt = normalizeResetAt(period.end);
              return Object.freeze({
                state: "observed" as const,
                facts: Object.freeze({
                  windows: Object.freeze([
                    Object.freeze({
                      kind: "weekly" as const,
                      usedPercent,
                      ...(resetAt === undefined ? {} : { resetAt }),
                    }),
                  ]),
                  budgets: Object.freeze([]),
                }),
              });
            }
          }
        }
      }

      const legacy = await fetchProviderUsageJson(
        fetch,
        BILLING_URL,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
        },
        signal,
      );
      if (legacy.reason !== undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: legacy.reason });
      }
      const config = asRecord(asRecord(legacy.body)?.config);
      if (config === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const limit = centsValue(config.monthlyLimit);
      const used = centsValue(config.used);
      if (limit === undefined || used === undefined || limit <= 0) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const usedPercent = normalizePercent((used / limit) * 100);
      if (usedPercent === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const resetAt = normalizeResetAt(config.billingPeriodEnd);
      return Object.freeze({
        state: "observed" as const,
        facts: Object.freeze({
          windows: Object.freeze([
            Object.freeze({
              kind: "monthly" as const,
              usedPercent,
              ...(resetAt === undefined ? {} : { resetAt }),
            }),
          ]),
          budgets: Object.freeze([]),
        }),
      });
    },
  });
}
