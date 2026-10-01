export const PROVIDER_USAGE_MAX_WINDOWS = 32 as const;
export const PROVIDER_USAGE_MAX_BUDGETS = 16 as const;
export const PROVIDER_USAGE_MAX_MODEL_LABEL_LENGTH = 128 as const;
export const PROVIDER_USAGE_MAX_CURRENCY_LENGTH = 16 as const;

export type ProviderUsageUnsupportedReason =
  | "provider"
  | "binding"
  | "destination";

/**
 * Mirror of the Provider Usage authority's bounded failure classes
 * (src/provider-usage/contract.ts). `timeout`, `temporary`, `account_change`,
 * `insufficient_validity`, and `terminal` are the external Codex source
 * classes required by plan section 6; only `terminal` stops automatic
 * network attempts, and only until the external document revision changes.
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

export type ProviderUsageWindowProjection =
  | {
      readonly kind: "five_hour" | "weekly" | "monthly";
      readonly usedPercent: number;
      readonly resetAt?: number;
      readonly scope?: {
        readonly kind: "model";
        readonly modelLabel: string;
      };
    }
  | {
      readonly kind: "custom";
      readonly usedPercent: number;
      readonly resetAt?: number;
      readonly durationMinutes?: number;
      readonly scope?: {
        readonly kind: "model";
        readonly modelLabel: string;
      };
    };

export type ProviderUsageBudgetProjection =
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

export type ProviderUsageProviderProjection =
  | {
      readonly providerId: string;
      readonly state: "observed";
      readonly observedAt: number;
      readonly refreshable: boolean;
      readonly windows: readonly ProviderUsageWindowProjection[];
      readonly budgets: readonly ProviderUsageBudgetProjection[];
    }
  | {
      readonly providerId: string;
      readonly state: "unobserved";
    }
  | {
      readonly providerId: string;
      readonly state: "unsupported";
      readonly reason: ProviderUsageUnsupportedReason;
    }
  | {
      readonly providerId: string;
      readonly state: "unavailable";
      readonly reason: ProviderUsageUnavailableReason;
    };

export interface ProviderUsageSnapshotProjection {
  readonly providers: readonly ProviderUsageProviderProjection[];
}

export type ProviderUsageCommand =
  | { readonly command: "query" }
  | {
      readonly command: "refresh";
      readonly providerId: string;
    };

export type ProviderUsageRefreshProjection =
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

export interface ProviderUsageCommandResult {
  readonly outcome: "ok" | "unavailable";
  readonly snapshot: ProviderUsageSnapshotProjection;
  readonly refresh?: ProviderUsageRefreshProjection;
}

export type ProviderUsageCommandHandler = (
  command: ProviderUsageCommand,
  signal?: AbortSignal,
) => Promise<ProviderUsageCommandResult>;
