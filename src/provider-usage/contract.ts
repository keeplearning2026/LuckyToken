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
  readonly credentialId: string;
  readonly observedAt: number;
}

export type ProviderUsageUnsupportedReason =
  | "provider"
  | "binding"
  | "destination";

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

interface ProviderUsageProfileIdentity {
  readonly providerId: string;
  readonly credentialId: string;
}

export type ProviderUsageState =
  | (ProviderUsageProfileIdentity & {
      readonly state: "observed";
      readonly observation: ProviderUsageObservation;
      readonly refreshable: boolean;
    })
  | (ProviderUsageProfileIdentity & {
      readonly state: "unobserved";
    })
  | (ProviderUsageProfileIdentity & {
      readonly state: "unsupported";
      readonly reason: ProviderUsageUnsupportedReason;
    })
  | (ProviderUsageProfileIdentity & {
      readonly state: "unavailable";
      readonly reason: ProviderUsageUnavailableReason;
    });

export type ProviderUsageBindingContext = {
  readonly kind: "managed" | "external";
  readonly authType: "api_key" | "oauth";
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
  /** At most one current active Profile row per Provider. Every row carries
   * exact Profile identity. */
  readonly profiles: readonly ProviderUsageState[];
}

export type ProviderUsageRefreshResult =
  | {
      readonly providerId: string;
      readonly credentialId: string;
      readonly outcome: "succeeded" | "superseded";
    }
  | {
      readonly providerId: string;
      readonly credentialId?: string;
      readonly outcome: "unsupported";
      readonly reason: ProviderUsageUnsupportedReason;
    }
  | {
      readonly providerId: string;
      readonly credentialId?: string;
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
    return Object.freeze({
      kind,
      usedPercent: value.usedPercent,
      ...(value.resetAt === undefined ? {} : { resetAt: value.resetAt }),
      ...(durationMinutes === undefined ? {} : { durationMinutes }),
      ...(scope === undefined ? {} : { scope }),
    });
  }
  return Object.freeze({
    kind,
    usedPercent: value.usedPercent,
    ...(value.resetAt === undefined ? {} : { resetAt: value.resetAt }),
    ...(scope === undefined ? {} : { scope }),
  });
}

function normalizeBudget(value: unknown): ProviderUsageBudget | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case "credits": {
      if (
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
        kind: "credits" as const,
        remaining: value.remaining,
        ...(value.used === undefined ? {} : { used: value.used }),
        ...(value.limit === undefined ? {} : { limit: value.limit }),
        ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
        ...(value.currency === undefined ? {} : { currency: value.currency }),
      });
    }
    case "balance":
      return isFiniteNonNegative(value.amount) &&
        boundedString(value.currency, PROVIDER_USAGE_MAX_CURRENCY_LENGTH)
        ? Object.freeze({
            kind: "balance" as const,
            amount: value.amount,
            currency: value.currency,
          })
        : undefined;
    case "reset_credits":
      return isFiniteNonNegative(value.available)
        ? Object.freeze({
            kind: "reset_credits" as const,
            available: value.available,
          })
        : undefined;
    default:
      return undefined;
  }
}

export function normalizeProviderUsageFacts(
  value: unknown,
): ProviderUsageFacts | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.windows) ||
    !Array.isArray(value.budgets) ||
    value.windows.length > PROVIDER_USAGE_MAX_WINDOWS ||
    value.budgets.length > PROVIDER_USAGE_MAX_BUDGETS
  ) {
    return undefined;
  }
  const windows = value.windows.map(normalizeWindow);
  const budgets = value.budgets.map(normalizeBudget);
  if (
    windows.some((entry) => entry === undefined) ||
    budgets.some((entry) => entry === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    windows: Object.freeze(windows as ProviderUsageWindow[]),
    budgets: Object.freeze(budgets as ProviderUsageBudget[]),
  });
}
