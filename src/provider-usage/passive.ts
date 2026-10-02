import type { Model } from "@earendil-works/pi-ai";

import {
  isProfileProviderAuthBindingCapture,
  type ProviderAuthBindingCapture,
} from "../credentials/profile-contract.js";
import type {
  ProviderUsageAuthority,
  ProviderUsageFacts,
  ProviderUsageWindow,
} from "./contract.js";
import {
  canonicalUrl,
  normalizeResetAt,
  toFiniteNumber,
} from "./wire.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utilizationFraction(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return Math.round(numeric * 10_000) / 100;
}

export function parseAnthropicPassiveUsage(
  response: unknown,
): ProviderUsageFacts | undefined {
  if (!isRecord(response)) return undefined;
  const status = response.status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 200 ||
    status >= 300
  ) {
    return undefined;
  }
  const rawHeaders = isRecord(response.headers) ? response.headers : undefined;
  if (rawHeaders === undefined) return undefined;
  const headers = new Map<string, unknown>();
  for (const [key, value] of Object.entries(rawHeaders)) {
    headers.set(key.toLowerCase(), value);
  }

  const windows: ProviderUsageWindow[] = [];
  const fiveHour = utilizationFraction(
    headers.get("anthropic-ratelimit-unified-5h-utilization"),
  );
  if (fiveHour !== undefined) {
    const resetAt = normalizeResetAt(
      headers.get("anthropic-ratelimit-unified-5h-reset"),
    );
    windows.push(Object.freeze({
      kind: "five_hour",
      usedPercent: fiveHour,
      ...(resetAt === undefined ? {} : { resetAt }),
    }));
  }

  const weekly = utilizationFraction(
    headers.get("anthropic-ratelimit-unified-7d-utilization"),
  );
  if (weekly !== undefined) {
    const resetAt = normalizeResetAt(
      headers.get("anthropic-ratelimit-unified-7d-reset"),
    );
    windows.push(Object.freeze({
      kind: "weekly",
      usedPercent: weekly,
      ...(resetAt === undefined ? {} : { resetAt }),
    }));
  }

  if (windows.length === 0) return undefined;
  return Object.freeze({
    windows: Object.freeze(windows),
    budgets: Object.freeze([]),
  });
}

export function createProviderUsageResponseObserver(
  authority: Pick<ProviderUsageAuthority, "observePassive">,
): (input: {
  readonly model: Model<string>;
  readonly capture: ProviderAuthBindingCapture;
  readonly response: unknown;
}) => Promise<void> {
  return async ({ model, capture, response }) => {
    if (
      model.provider !== "anthropic" ||
      !isProfileProviderAuthBindingCapture(capture) ||
      capture.facts.authType !== "api_key" ||
      !canonicalUrl(model.baseUrl, "https://api.anthropic.com", ["/"])
    ) {
      return;
    }
    const facts = parseAnthropicPassiveUsage(response);
    if (facts === undefined) return;
    await authority.observePassive(
      "anthropic",
      capture,
      model.baseUrl,
      facts,
    );
  };
}
