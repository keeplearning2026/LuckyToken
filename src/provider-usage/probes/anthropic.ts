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

const PROVIDER_ID = "anthropic";
const ORIGIN = "https://api.anthropic.com";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.280 (external, cli)";
const ANTHROPIC_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05";

function bucket(
  value: unknown,
  kind: "five_hour" | "weekly",
  scope?: string,
): ProviderUsageWindow | undefined {
  const row = asRecord(value);
  if (row === undefined) return undefined;
  const usedPercent = normalizePercent(row.utilization);
  if (usedPercent === undefined) return undefined;
  const resetAt = normalizeResetAt(row.resets_at);
  return Object.freeze({
    kind,
    usedPercent,
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(scope === undefined
      ? {}
      : { scope: Object.freeze({ kind: "model" as const, modelLabel: scope }) }),
  });
}

function recognizedModelLabel(value: unknown): "Fable" | "Opus" | "Sonnet" | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim().toLowerCase();
  if (lower.includes("fable")) return "Fable";
  if (lower.includes("opus")) return "Opus";
  if (lower.includes("sonnet")) return "Sonnet";
  return undefined;
}

export function createAnthropicUsageProbe(fetch: FetchFunction): ProviderUsageProbe {
  return Object.freeze({
    providerId: PROVIDER_ID,
    eligibility(context: ProviderUsageEligibilityContext) {
      if (context.binding.kind !== "managed" || context.binding.authType !== "oauth") {
        return Object.freeze({ state: "unsupported_binding" as const });
      }
      return canonicalUrl(context.effectiveBaseUrl, ORIGIN, ["/"])
        ? Object.freeze({ state: "eligible" as const })
        : Object.freeze({ state: "unsupported_destination" as const });
    },
    async acquire({ auth, signal }: ProviderUsageProbeInput) {
      const accessToken = auth.auth.apiKey?.trim();
      if (!accessToken) {
        return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
      }
      const result = await fetchProviderUsageJson(
        fetch,
        USAGE_URL,
        {
          method: "GET",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "User-Agent": CLAUDE_CLI_USER_AGENT,
            "anthropic-beta": ANTHROPIC_BETA,
            Authorization: `Bearer ${accessToken}`,
          },
        },
        signal,
      );
      if (result.reason !== undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: result.reason });
      }
      const body = asRecord(result.body);
      if (body === undefined) {
        return Object.freeze({ state: "unavailable" as const, reason: "schema" as const });
      }

      const windows: ProviderUsageWindow[] = [];
      const five = bucket(body.five_hour, "five_hour");
      const week = bucket(body.seven_day, "weekly");
      if (five !== undefined) windows.push(five);
      if (week !== undefined) windows.push(week);

      const scoped = new Map<string, ProviderUsageWindow>();
      for (const [field, label] of [
        ["seven_day_fable", "Fable"],
        ["seven_day_opus", "Opus"],
        ["seven_day_sonnet", "Sonnet"],
      ] as const) {
        const parsed = bucket(body[field], "weekly", label);
        if (parsed !== undefined) scoped.set(label, parsed);
      }
      for (const raw of Array.isArray(body.limits) ? body.limits : []) {
        const row = asRecord(raw);
        if (String(row?.kind ?? "").trim().toLowerCase() !== "weekly_scoped") continue;
        const model = asRecord(asRecord(row?.scope)?.model);
        const label = recognizedModelLabel(model?.display_name);
        const usedPercent = normalizePercent(row?.percent);
        if (label === undefined || usedPercent === undefined || scoped.has(label)) continue;
        const resetAt = normalizeResetAt(row?.resets_at);
        scoped.set(label, Object.freeze({
          kind: "weekly",
          usedPercent,
          ...(resetAt === undefined ? {} : { resetAt }),
          scope: Object.freeze({ kind: "model" as const, modelLabel: label }),
        }));
      }
      windows.push(...scoped.values());

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
