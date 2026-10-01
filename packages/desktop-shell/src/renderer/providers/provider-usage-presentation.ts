import type { DesktopControlPlaneApi } from "../../shared/desktop-api.js";

type ProviderUsageCommandResult = Awaited<
  ReturnType<DesktopControlPlaneApi["executeProviderUsage"]>
>;
type ProviderUsageProviderProjection =
  ProviderUsageCommandResult["snapshot"]["providers"][number];
type ProviderUsageRefreshProjection = NonNullable<
  ProviderUsageCommandResult["refresh"]
>;
type ObservedProviderUsageProjection = Extract<
  ProviderUsageProviderProjection,
  { readonly state: "observed" }
>;
type ProviderUsageWindowProjection =
  ObservedProviderUsageProjection["windows"][number];
type ProviderUsageUnavailableReason = Extract<
  ProviderUsageProviderProjection,
  { readonly state: "unavailable" }
>["reason"];

export interface ProviderCardUsagePresentation {
  readonly primary: readonly string[];
  readonly secondary: readonly string[];
  readonly status?: string;
  readonly refreshable: boolean;
}

export interface ProviderUsagePresentationOptions {
  /** True when this Provider is served by the verified external Codex login
   * (`ambient.status === "connected"`). The bounded unavailable/transient
   * state then carries the "refresh through Codex" prompt; managed bindings
   * keep their previous presentation. */
  readonly externalSource?: boolean;
}

export function providerUsageRefreshFailureNotice(): string {
  return "Provider usage could not be refreshed.";
}

/** One bounded, actionable message per failure class (plan section 6). */
function unavailableUsagePrompt(
  reason: ProviderUsageUnavailableReason,
): string {
  switch (reason) {
    case "terminal":
      return "Codex sign-in was rejected. Refresh through Codex, then try again.";
    case "account_change":
      return "Codex sign-in changed accounts. Refresh through Codex, then try again.";
    case "insufficient_validity":
      return "Codex sign-in no longer satisfies the account contract. Refresh through Codex, then try again.";
    case "temporary":
      return "Codex sign-in is temporarily unreadable. Refresh through Codex, then try again.";
    case "timeout":
      return "Usage refresh timed out. Try again.";
    case "auth":
      return "Sign in to Codex, then try again.";
    case "network":
    case "upstream":
      return "Usage is temporarily unavailable. Try again.";
    case "schema":
      return "Usage response could not be read.";
  }
}

export function providerUsageRefreshNotice(
  refresh: ProviderUsageRefreshProjection | undefined,
  options: ProviderUsagePresentationOptions = {},
): string | undefined {
  if (refresh?.outcome === "unavailable") {
    return options.externalSource === true
      ? unavailableUsagePrompt(refresh.reason)
      : providerUsageRefreshFailureNotice();
  }
  if (refresh?.outcome === "unsupported") {
    return refresh.reason === "destination"
      ? "Provider usage cannot be refreshed for this endpoint."
      : refresh.reason === "binding"
        ? "Provider usage cannot be refreshed for this account type."
        : "Provider usage cannot be refreshed.";
  }
  return undefined;
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
  options: ProviderUsagePresentationOptions = {},
): ProviderCardUsagePresentation {
  if (provider === undefined || provider.state === "unobserved") {
    return Object.freeze({
      primary: Object.freeze([]),
      secondary: Object.freeze([]),
      status: "Usage not refreshed",
      refreshable: true,
    });
  }
  if (provider.state === "unsupported") {
    return Object.freeze({
      primary: Object.freeze([]),
      secondary: Object.freeze([]),
      refreshable: false,
    });
  }
  if (provider.state === "unavailable") {
    return Object.freeze({
      primary: Object.freeze([]),
      secondary: Object.freeze([]),
      ...(options.externalSource === true
        ? { status: unavailableUsagePrompt(provider.reason) }
        : {}),
      refreshable: true,
    });
  }

  const primary: string[] = [];
  const secondary: string[] = [];

  for (const window of provider.windows) {
    const label = windowLabel(window);
    primary.push(`${label} ${percent(window.usedPercent)}`);
    if (window.resetAt !== undefined) {
      const reset = resetText(window.resetAt, now);
      if (reset !== undefined) secondary.push(`${label} ${reset}`);
    }
  }

  // All currency balances share one "Balance" label:
  // `Balance CN¥9.39 · $0.00`.
  const balanceAmounts: string[] = [];
  for (const budget of provider.budgets) {
    if (budget.kind === "balance") {
      balanceAmounts.push(money(budget.amount, budget.currency));
    }
  }
  const balanceLine =
    balanceAmounts.length === 0 ? undefined : `Balance ${balanceAmounts.join(" · ")}`;
  let balanceLinePushed = false;

  for (const budget of provider.budgets) {
    if (budget.kind === "balance") {
      if (!balanceLinePushed && balanceLine !== undefined) {
        primary.push(balanceLine);
        balanceLinePushed = true;
      }
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
    refreshable: provider.refreshable,
  });
}
