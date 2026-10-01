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
  readBoundedJson,
  toFiniteNumber,
} from "../wire.js";
import { resolveCodexAccountIdentity } from "../../credentials/codex-auth.js";

const PROVIDER_ID = "openai-codex";
const ORIGIN = "https://chatgpt.com";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// Evidence pinned to reference/opencodex auth-api/pool-quota-probe.ts.
const TERMINAL_AUTH_CODES = new Set(["invalid_workspace_selected", "invalid_refresh_token"]);
function usableText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function accountIdFromAccessToken(accessToken: string): string | undefined {
  const identity = resolveCodexAccountIdentity(accessToken, undefined);
  return "accountId" in identity ? identity.accountId : undefined;
}

function planType(value: unknown): string | undefined {
  return usableText(value)?.toLowerCase();
}

interface WhamWindow {
  readonly percent?: number;
  readonly resetAt?: number;
  readonly seconds?: number;
}

function parseWindow(value: unknown): WhamWindow {
  const row = asRecord(value);
  if (row === undefined) return Object.freeze({});
  const percent = normalizePercent(row.used_percent);
  const resetAt = normalizeResetAt(row.reset_at);
  const seconds = toFiniteNumber(row.limit_window_seconds);
  return Object.freeze({
    ...(percent === undefined ? {} : { percent }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(seconds === undefined || seconds <= 0 ? {} : { seconds }),
  });
}

function toWindow(
  kind: "five_hour" | "weekly" | "monthly" | "custom",
  source: WhamWindow,
): ProviderUsageWindow | undefined {
  if (source.percent === undefined) return undefined;
  if (kind === "custom") {
    return Object.freeze({
      kind,
      usedPercent: source.percent,
      ...(source.resetAt === undefined ? {} : { resetAt: source.resetAt }),
      ...(source.seconds === undefined
        ? {}
        : { durationMinutes: Math.max(1, Math.round(source.seconds / 60)) }),
    });
  }
  return Object.freeze({
    kind,
    usedPercent: source.percent,
    ...(source.resetAt === undefined ? {} : { resetAt: source.resetAt }),
  });
}

export function createOpenAiCodexUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      const oauthBinding =
        (context.binding.kind === "managed" &&
          context.binding.authType === "oauth") ||
        (context.binding.kind === "external" &&
          context.binding.authType === "oauth");
      if (!oauthBinding) {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, ORIGIN, ["/backend-api"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const accessToken = auth.auth.apiKey?.trim();
      if (!accessToken) {
        return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      }
      const accountId = accountIdFromAccessToken(accessToken);
      if (accountId === undefined) {
        // The token is present but fails the account-claim contract
        // (section 3.4), so the resolved credential is not sufficiently valid
        // for the resource request.
        return Object.freeze({
          state: "unavailable" as const,
          reason: "insufficient_validity" as const,
        });
      }
      const result = await fetchProviderUsageJson(
        fetch,
        USAGE_URL,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": accountId,
          },
        },
        signal,
      );
      if (result.reason !== undefined) {
        if (result.reason === "auth" && result.response !== undefined) {
          let code: unknown;
          try {
            const body = asRecord(await readBoundedJson(result.response, signal));
            code = asRecord(body?.detail)?.code ?? asRecord(body?.error)?.code ?? body?.code;
          } catch {
            // Missing, malformed, oversized, or interrupted bodies are not evidence.
          }
          return Object.freeze({ state: "unavailable" as const,
            reason: typeof code === "string" && TERMINAL_AUTH_CODES.has(code)
              ? "terminal" as const : "temporary" as const });
        }
        return Object.freeze({ state: "unavailable" as const, reason: result.reason });
      }
      const body = asRecord(result.body);
      if (body === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }
      const rateLimit = asRecord(body.rate_limit);
      const primary = parseWindow(rateLimit?.primary_window);
      const secondary = parseWindow(rateLimit?.secondary_window);
      const tertiary = parseWindow(rateLimit?.tertiary_window);

      const windows: ProviderUsageWindow[] = [];
      const primarySeconds = primary.seconds;
      const primaryIsShort = primarySeconds !== undefined && primarySeconds < 86_400;
      const primaryIsMonthly =
        primarySeconds !== undefined && primarySeconds >= 28 * 86_400;
      const thirtyDayOnly = ["go", "free"].includes(planType(body.plan_type) ?? "");

      if (primaryIsShort) {
        const shortKind = primarySeconds === 18_000 ? "five_hour" : "custom";
        const short = toWindow(shortKind, primary);
        if (short !== undefined) windows.push(short);
      }

      const weeklySource = primaryIsMonthly
        ? secondary
        : primaryIsShort
          ? secondary
          : primary.percent !== undefined
            ? primary
            : secondary;
      const monthlySource =
        primaryIsMonthly && primary.percent !== undefined ? primary : tertiary;

      if (thirtyDayOnly) {
        const monthly = toWindow("monthly", monthlySource);
        if (monthly !== undefined) windows.push(monthly);
      } else {
        const weekly = toWindow("weekly", weeklySource);
        if (weekly !== undefined) windows.push(weekly);
        const monthly = toWindow("monthly", monthlySource);
        if (monthly !== undefined) windows.push(monthly);
      }

      const budgets: ProviderUsageBudget[] = [];
      const resetCredits = toFiniteNumber(asRecord(body.rate_limit_reset_credits)?.available_count);
      if (resetCredits !== undefined && resetCredits >= 0) {
        budgets.push(Object.freeze({
          kind: "reset_credits",
          available: resetCredits,
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
