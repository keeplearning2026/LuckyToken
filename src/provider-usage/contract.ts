import type { AuthResult } from "@earendil-works/pi-ai";
import type { ProviderAuthBindingCapture } from "../credentials/profile-contract.js";

export const PROVIDER_USAGE_MAX_WINDOWS = 32 as const;
export const PROVIDER_USAGE_MAX_BUDGETS = 16 as const;
export const PROVIDER_USAGE_MAX_MODEL_LABEL_LENGTH = 128 as const;
export const PROVIDER_USAGE_MAX_CURRENCY_LENGTH = 16 as const;

export interface ProviderUsageModelScope {
  readonly kind: "model";
  readonly modelLabel: string;
}

export type ProviderUsageWindow =
  | {
      readonly kind: "five_hour" | "weekly" | "monthly";
      readonly usedPercent: number;
      readonly resetAt?: number;
      readonly scope?: ProviderUsageModelScope;
    }
  | {
      readonly kind: "custom";
      readonly usedPercent: number;
      readonly resetAt?: number;
      readonly durationMinutes?: number;
      readonly scope?: ProviderUsageModelScope;
    };

export type ProviderUsageBudget =
  | {
      readonly kind: "credits";
      readonly remaining: number;
      readonly used?: number;
      readonly limit?: number;
      readonly expiresAt?: number;
      readonly currency?: string;
    }
  | {
      readonly kind: "balance";
      readonly amount: number;
      readonly currency: string;
    }
  | {
      readonly kind: "reset_credits";
      readonly available: number;
    };

export interface ProviderUsageFacts {
  readonly windows: readonly ProviderUsageWindow[];
  readonly budgets: readonly ProviderUsageBudget[];
}

export interface ProviderUsageObservation extends ProviderUsageFacts {
  readonly providerId: string;
  readonly observedAt: number;
}

export type ProviderUsageUnsupportedReason =
  | "provider"
  | "binding"
  | "destination";

/**
 * Bounded failure classification (plan section 6). Each class stays distinct
 * end to end: usage authority → Control Plane DTO → Public Model/Attention →
 * Renderer.
 *
 * - `auth`: the credential was missing or unusable for the resource request.
 *   Managed and ambient bindings keep this class unchanged.
 * - `timeout`: the authority's own bounded refresh deadline elapsed.
 * - `temporary`: a bounded transient failure of the external Codex source.
 *   The credential boundary reports read/parse failures, an unavailable
 *   delegation, and post-refresh verification failures (including
 *   insufficient validity after a delegated refresh) as one
 *   `external_unavailable` outcome, so they all stay transient here and never
 *   become a permanent reconnect state.
 * - `account_change`: the Codex-owned document no longer belongs to the
 *   account captured for the request; last-known usage is never carried over.
 * - `insufficient_validity`: the resource request received a credential that
 *   does not satisfy the account-claim contract, so it cannot be used.
 * - `terminal`: an explicit structured rejection of a credential the external
 *   boundary had already resolved and verified — the usage probe's HTTP
 *   401/403 class. Only this evidence stops automatic network attempts, and
 *   only until the external document's revision changes. Diagnostics text
 *   (stderr) is never parsed for classification
 *   ([P1 error-classification evidence](../../doc/Research/TokenOpenAICodexP1ErrorClassification.md)).
 * - `network`, `upstream`, `schema`: transport, upstream status, and response
 *   shape failures.
 */
export type ProviderUsageUnavailableReason =
  | "auth"
  | "timeout"
  | "temporary"
  | "account_change"
  | "insufficient_validity"
  | "terminal"
  | "network"
  | "upstream"
  | "schema";

export type ProviderUsageState =
  | {
      readonly state: "observed";
      readonly observation: ProviderUsageObservation;
      readonly refreshable: boolean;
    }
  | {
      readonly state: "unobserved";
      readonly providerId: string;
    }
  | {
      readonly state: "unsupported";
      readonly providerId: string;
      readonly reason: ProviderUsageUnsupportedReason;
    }
  | {
      readonly state: "unavailable";
      readonly providerId: string;
      readonly reason: ProviderUsageUnavailableReason;
    };

export type ProviderUsageBindingContext =
  | {
      readonly kind: "managed";
      readonly authType: "api_key" | "oauth";
    }
  | {
      /** Codex-owned external ChatGPT credential consumed through the shared
       * binding path. Freshness is delegated to Codex, never to Pi OAuth. */
      readonly kind: "external";
      readonly authType: "oauth";
    }
  | {
      readonly kind: "ambient";
    };

export interface ProviderUsageEligibilityContext {
  readonly providerId: string;
  readonly effectiveBaseUrl?: string;
  readonly binding: ProviderUsageBindingContext;
}

export type ProviderUsageEligibility =
  | { readonly state: "eligible" }
  | { readonly state: "unsupported_binding" }
  | { readonly state: "unsupported_destination" };

export type ProviderUsageProbeResult =
  | {
      readonly state: "observed";
      readonly facts: ProviderUsageFacts;
    }
  | {
      readonly state: "unavailable";
      readonly reason: ProviderUsageUnavailableReason;
    };

export interface ProviderUsageProbeInput {
  readonly auth: AuthResult;
  readonly signal: AbortSignal;
}

export interface ProviderUsageProbe {
  readonly providerId: string;
  eligibility(context: ProviderUsageEligibilityContext): ProviderUsageEligibility;
  acquire(input: ProviderUsageProbeInput): Promise<ProviderUsageProbeResult>;
}

export interface ProviderUsageSnapshot {
  readonly providers: readonly ProviderUsageState[];
}

export type ProviderUsageRefreshResult =
  | {
      readonly providerId: string;
      readonly outcome: "succeeded" | "superseded";
    }
  | {
      readonly providerId: string;
      readonly outcome: "unsupported";
      readonly reason: ProviderUsageUnsupportedReason;
    }
  | {
      readonly providerId: string;
      readonly outcome: "unavailable";
      readonly reason: ProviderUsageUnavailableReason;
    };

export interface ProviderUsageAuthority {
  query(): Promise<ProviderUsageSnapshot>;
  refresh(providerId: string, signal?: AbortSignal): Promise<{
    readonly snapshot: ProviderUsageSnapshot;
    readonly refresh: ProviderUsageRefreshResult;
  }>;
  observePassive(
    providerId: string,
    capture: ProviderAuthBindingCapture,
    effectiveBaseUrl: string,
    facts: ProviderUsageFacts,
  ): Promise<boolean>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function normalizeScope(value: unknown): ProviderUsageModelScope | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.kind !== "model") {
    return undefined;
  }
  if (!boundedString(value.modelLabel, PROVIDER_USAGE_MAX_MODEL_LABEL_LENGTH)) {
    return undefined;
  }
  return Object.freeze({ kind: "model", modelLabel: value.modelLabel });
}

function normalizeWindow(value: unknown): ProviderUsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (
    kind !== "five_hour" &&
    kind !== "weekly" &&
    kind !== "monthly" &&
    kind !== "custom"
  ) {
    return undefined;
  }
  if (
    typeof value.usedPercent !== "number" ||
    !Number.isFinite(value.usedPercent) ||
    value.usedPercent < 0 ||
    value.usedPercent > 100
  ) {
    return undefined;
  }
  if (value.resetAt !== undefined && !isPositiveSafeInteger(value.resetAt)) {
    return undefined;
  }
  const scope = value.scope === undefined ? undefined : normalizeScope(value.scope);
  if (value.scope !== undefined && scope === undefined) return undefined;
  if (kind === "custom") {
    const durationMinutes = value.durationMinutes;
    if (
      durationMinutes !== undefined &&
      (typeof durationMinutes !== "number" ||
        !Number.isSafeInteger(durationMinutes) ||
        durationMinutes <= 0)
    ) {
      return undefined;
    }
    const keys = new Set(["kind", "usedPercent", "resetAt", "durationMinutes", "scope"]);
    if (Object.keys(value).some((key) => !keys.has(key))) return undefined;
    return Object.freeze({
      kind,
      usedPercent: value.usedPercent,
      ...(value.resetAt === undefined ? {} : { resetAt: value.resetAt }),
      ...(durationMinutes === undefined ? {} : { durationMinutes }),
      ...(scope === undefined ? {} : { scope }),
    });
  }
  const keys = new Set(["kind", "usedPercent", "resetAt", "scope"]);
  if (Object.keys(value).some((key) => !keys.has(key))) return undefined;
  return Object.freeze({
    kind,
    usedPercent: value.usedPercent,
    ...(value.resetAt === undefined ? {} : { resetAt: value.resetAt }),
    ...(scope === undefined ? {} : { scope }),
  });
}

function normalizeBudget(value: unknown): ProviderUsageBudget | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "balance") {
    if (
      Object.keys(value).some((key) => !["kind", "amount", "currency"].includes(key)) ||
      !isFiniteNonNegative(value.amount) ||
      !boundedString(value.currency, PROVIDER_USAGE_MAX_CURRENCY_LENGTH)
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "balance",
      amount: value.amount,
      currency: value.currency,
    });
  }
  if (value.kind === "reset_credits") {
    if (
      Object.keys(value).some((key) => !["kind", "available"].includes(key)) ||
      !isFiniteNonNegative(value.available)
    ) {
      return undefined;
    }
    return Object.freeze({ kind: "reset_credits", available: value.available });
  }
  if (value.kind !== "credits") return undefined;
  if (
    Object.keys(value).some(
      (key) => !["kind", "remaining", "used", "limit", "expiresAt", "currency"].includes(key),
    ) ||
    !isFiniteNonNegative(value.remaining) ||
    (value.used !== undefined && !isFiniteNonNegative(value.used)) ||
    (value.limit !== undefined && !isFiniteNonNegative(value.limit)) ||
    (value.expiresAt !== undefined && !isPositiveSafeInteger(value.expiresAt)) ||
    (value.currency !== undefined &&
      !boundedString(value.currency, PROVIDER_USAGE_MAX_CURRENCY_LENGTH))
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "credits",
    remaining: value.remaining,
    ...(value.used === undefined ? {} : { used: value.used }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    ...(value.currency === undefined ? {} : { currency: value.currency }),
  });
}

export function normalizeProviderUsageFacts(
  value: unknown,
): ProviderUsageFacts | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "windows" && key !== "budgets") ||
    !Array.isArray(value.windows) ||
    !Array.isArray(value.budgets) ||
    value.windows.length > PROVIDER_USAGE_MAX_WINDOWS ||
    value.budgets.length > PROVIDER_USAGE_MAX_BUDGETS
  ) {
    return undefined;
  }
  const windows = value.windows.map(normalizeWindow);
  const budgets = value.budgets.map(normalizeBudget);
  if (windows.some((entry) => entry === undefined) || budgets.some((entry) => entry === undefined)) {
    return undefined;
  }
  return Object.freeze({
    windows: Object.freeze(windows as ProviderUsageWindow[]),
    budgets: Object.freeze(budgets as ProviderUsageBudget[]),
  });
}
