import type { DesktopControlPlaneApi } from "../../shared/desktop-api.js";

type ProviderUsageCommandResult = Awaited<
  ReturnType<DesktopControlPlaneApi["executeProviderUsage"]>
>;
type ProviderUsageProviderProjection =
  ProviderUsageCommandResult["snapshot"]["providers"][number];
type ObservedProviderUsageProjection = Extract<
  ProviderUsageProviderProjection,
  { readonly state: "observed" }
>;
type ProviderUsageWindowProjection =
  ObservedProviderUsageProjection["windows"][number];

export interface ProviderCardUsagePresentation {
  readonly primary: readonly string[];
  readonly secondary: readonly string[];
  readonly status?: string;
  readonly refreshable: boolean;
}

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

function resetText(resetAt: number, now: number): string | undefined {
  const remaining = resetAt - now;
  if (remaining <= 0) return undefined;
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return `resets in ${hours}h${rest === 0 ? "" : ` ${rest}m`}`;
  const days = Math.floor(hours / 24);
  return `resets in ${days}d`;
}

function windowLabel(window: ProviderUsageWindowProjection): string {
  let base: string;
  if (window.kind === "five_hour") {
    base = "5h";
  } else if (window.kind === "weekly") {
    base = "Week";
  } else if (window.kind === "monthly") {
    base = "Month";
  } else if ("durationMinutes" in window && window.durationMinutes !== undefined) {
    const durationMinutes = window.durationMinutes;
    base =
      durationMinutes % 60 === 0
        ? `${durationMinutes / 60}h`
        : `${durationMinutes}m`;
  } else {
    base = "Usage";
  }
  const scope = window.scope?.modelLabel;
  return scope === undefined ? base : `${scope} ${base}`;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function projectProviderCardUsage(
  provider: ProviderUsageProviderProjection | undefined,
  now: number,
): ProviderCardUsagePresentation {
  if (provider === undefined || provider.state === "unobserved") {
    return Object.freeze({
      primary: Object.freeze([]),
      secondary: Object.freeze([]),
      status: "Usage not refreshed",
      refreshable: provider !== undefined,
    });
  }
  if (provider.state === "unsupported") {
    return Object.freeze({
      primary: Object.freeze([]),
      secondary: Object.freeze([]),
      status:
        provider.reason === "destination"
          ? "Usage unavailable for this endpoint"
          : provider.reason === "binding"
            ? "Usage unavailable for this account type"
            : "Usage unavailable",
      refreshable: false,
    });
  }
  if (provider.state === "unavailable") {
    return Object.freeze({
      primary: Object.freeze([]),
      secondary: Object.freeze([]),
      status: "Usage refresh unavailable",
      refreshable: true,
    });
  }

  const primary: string[] = [];
  const secondary: string[] = [];

  for (const window of provider.windows) {
    primary.push(`${windowLabel(window)} ${percent(window.usedPercent)}`);
    if (window.resetAt !== undefined) {
      const reset = resetText(window.resetAt, now);
      if (reset !== undefined) secondary.push(`${windowLabel(window)} ${reset}`);
    }
  }

  for (const budget of provider.budgets) {
    if (budget.kind === "balance") {
      primary.push(`Balance ${money(budget.amount, budget.currency)}`);
      continue;
    }
    if (budget.kind === "reset_credits") {
      primary.push(`${budget.available} reset credits`);
      continue;
    }
    const remaining =
      budget.currency === undefined
        ? `${budget.remaining.toFixed(budget.remaining >= 100 ? 0 : 1)} credits remaining`
        : `${money(budget.remaining, budget.currency)} remaining`;
    primary.push(remaining);
    if (budget.expiresAt !== undefined) {
      const reset = resetText(budget.expiresAt, now);
      if (reset !== undefined) secondary.push(reset);
    }
  }

  return Object.freeze({
    primary: Object.freeze(primary),
    secondary: Object.freeze(secondary),
    ...(primary.length === 0 && secondary.length === 0
      ? { status: "No current limit reported" }
      : {}),
    refreshable: provider.refreshable,
  });
}
