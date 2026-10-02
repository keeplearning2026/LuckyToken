import {
  PROVIDER_USAGE_MAX_BUDGETS,
  PROVIDER_USAGE_MAX_CURRENCY_LENGTH,
  PROVIDER_USAGE_MAX_MODEL_LABEL_LENGTH,
  PROVIDER_USAGE_MAX_WINDOWS,
  type ProviderUsageBudgetProjection,
  type ProviderUsageCommand,
  type ProviderUsageCommandResult,
  type ProviderUsageProfileProjection,
  type ProviderUsageRefreshProjection,
  type ProviderUsageSnapshotProjection,
  type ProviderUsageUnavailableReason,
  type ProviderUsageUnsupportedReason,
  type ProviderUsageWindowProjection,
} from "./provider-usage-contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function providerId(value: unknown): string | undefined {
  return boundedText(value, 128);
}

function credentialId(value: unknown): string | undefined {
  return boundedText(value, 256);
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function percent(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100;
}

function decodeScope(
  value: unknown,
): Extract<
  ProviderUsageWindowProjection,
  { readonly scope?: unknown }
>["scope"] | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "modelLabel"]) ||
    value.kind !== "model"
  ) {
    return undefined;
  }
  const modelLabel = boundedText(
    value.modelLabel,
    PROVIDER_USAGE_MAX_MODEL_LABEL_LENGTH,
  );
  return modelLabel === undefined
    ? undefined
    : Object.freeze({ kind: "model" as const, modelLabel });
}

export function decodeProviderUsageWindowProjection(
  value: unknown,
): ProviderUsageWindowProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !percent(value.usedPercent)
  ) {
    return undefined;
  }
  if (
    value.resetAt !== undefined &&
    !positiveSafeInteger(value.resetAt)
  ) {
    return undefined;
  }
  const scope =
    value.scope === undefined ? undefined : decodeScope(value.scope);
  if (value.scope !== undefined && scope === undefined) return undefined;

  if (value.kind === "custom") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "usedPercent",
        "resetAt",
        "durationMinutes",
        "scope",
      ]) ||
      (value.durationMinutes !== undefined &&
        !positiveSafeInteger(value.durationMinutes))
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "custom",
      usedPercent: value.usedPercent,
      ...(value.resetAt === undefined ? {} : { resetAt: value.resetAt }),
      ...(value.durationMinutes === undefined
        ? {}
        : { durationMinutes: value.durationMinutes }),
      ...(scope === undefined ? {} : { scope }),
    });
  }

  if (
    value.kind !== "five_hour" &&
    value.kind !== "weekly" &&
    value.kind !== "monthly"
  ) {
    return undefined;
  }
  if (!hasOnlyKeys(value, ["kind", "usedPercent", "resetAt", "scope"])) {
    return undefined;
  }
  return Object.freeze({
    kind: value.kind,
    usedPercent: value.usedPercent,
    ...(value.resetAt === undefined ? {} : { resetAt: value.resetAt }),
    ...(scope === undefined ? {} : { scope }),
  });
}

export function decodeProviderUsageBudgetProjection(
  value: unknown,
): ProviderUsageBudgetProjection | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;

  if (value.kind === "balance") {
    if (
      !hasOnlyKeys(value, ["kind", "amount", "currency"]) ||
      !nonNegativeFinite(value.amount)
    ) {
      return undefined;
    }
    const currency = boundedText(
      value.currency,
      PROVIDER_USAGE_MAX_CURRENCY_LENGTH,
    );
    return currency === undefined
      ? undefined
      : Object.freeze({
          kind: "balance" as const,
          amount: value.amount,
          currency,
        });
  }

  if (value.kind === "reset_credits") {
    if (
      !hasOnlyKeys(value, ["kind", "available"]) ||
      !nonNegativeFinite(value.available)
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "reset_credits" as const,
      available: value.available,
    });
  }

  if (value.kind !== "credits") return undefined;
  if (
    !hasOnlyKeys(value, [
      "kind",
      "remaining",
      "used",
      "limit",
      "expiresAt",
      "currency",
    ]) ||
    !nonNegativeFinite(value.remaining) ||
    (value.used !== undefined && !nonNegativeFinite(value.used)) ||
    (value.limit !== undefined && !nonNegativeFinite(value.limit)) ||
    (value.expiresAt !== undefined &&
      !positiveSafeInteger(value.expiresAt))
  ) {
    return undefined;
  }

  const currency =
    value.currency === undefined
      ? undefined
      : boundedText(value.currency, PROVIDER_USAGE_MAX_CURRENCY_LENGTH);
  if (value.currency !== undefined && currency === undefined) return undefined;

  return Object.freeze({
    kind: "credits",
    remaining: value.remaining,
    ...(value.used === undefined ? {} : { used: value.used }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    ...(currency === undefined ? {} : { currency }),
  });
}

function unsupportedReason(
  value: unknown,
): ProviderUsageUnsupportedReason | undefined {
  return value === "provider" ||
    value === "binding" ||
    value === "destination"
    ? value
    : undefined;
}

function unavailableReason(
  value: unknown,
): ProviderUsageUnavailableReason | undefined {
  return value === "auth" ||
    value === "timeout" ||
    value === "temporary" ||
    value === "account_change" ||
    value === "insufficient_validity" ||
    value === "terminal" ||
    value === "network" ||
    value === "upstream" ||
    value === "schema"
    ? value
    : undefined;
}

export function decodeProviderUsageProfileProjection(
  value: unknown,
): ProviderUsageProfileProjection | undefined {
  if (!isRecord(value)) return undefined;
  const pid = providerId(value.providerId);
  const cid = credentialId(value.credentialId);
  if (
    pid === undefined ||
    cid === undefined ||
    typeof value.state !== "string"
  ) {
    return undefined;
  }

  if (value.state === "unobserved") {
    return hasOnlyKeys(value, ["providerId", "credentialId", "state"])
      ? Object.freeze({
          providerId: pid,
          credentialId: cid,
          state: "unobserved" as const,
        })
      : undefined;
  }

  if (value.state === "unsupported") {
    const reason = unsupportedReason(value.reason);
    return reason !== undefined &&
      hasOnlyKeys(value, [
        "providerId",
        "credentialId",
        "state",
        "reason",
      ])
      ? Object.freeze({
          providerId: pid,
          credentialId: cid,
          state: "unsupported" as const,
          reason,
        })
      : undefined;
  }

  if (value.state === "unavailable") {
    const reason = unavailableReason(value.reason);
    return reason !== undefined &&
      hasOnlyKeys(value, [
        "providerId",
        "credentialId",
        "state",
        "reason",
      ])
      ? Object.freeze({
          providerId: pid,
          credentialId: cid,
          state: "unavailable" as const,
          reason,
        })
      : undefined;
  }

  if (value.state !== "observed") return undefined;
  if (
    !hasOnlyKeys(value, [
      "providerId",
      "credentialId",
      "state",
      "observedAt",
      "refreshable",
      "windows",
      "budgets",
    ]) ||
    !nonNegativeSafeInteger(value.observedAt) ||
    typeof value.refreshable !== "boolean" ||
    !Array.isArray(value.windows) ||
    !Array.isArray(value.budgets) ||
    value.windows.length > PROVIDER_USAGE_MAX_WINDOWS ||
    value.budgets.length > PROVIDER_USAGE_MAX_BUDGETS
  ) {
    return undefined;
  }

  const windows = value.windows.map(decodeProviderUsageWindowProjection);
  const budgets = value.budgets.map(decodeProviderUsageBudgetProjection);
  if (
    windows.some((entry) => entry === undefined) ||
    budgets.some((entry) => entry === undefined)
  ) {
    return undefined;
  }

  return Object.freeze({
    providerId: pid,
    credentialId: cid,
    state: "observed",
    observedAt: value.observedAt,
    refreshable: value.refreshable,
    windows: Object.freeze(windows as ProviderUsageWindowProjection[]),
    budgets: Object.freeze(budgets as ProviderUsageBudgetProjection[]),
  });
}

export function decodeProviderUsageSnapshotProjection(
  value: unknown,
): ProviderUsageSnapshotProjection | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["profiles"]) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 512
  ) {
    return undefined;
  }

  const profiles = value.profiles.map(
    decodeProviderUsageProfileProjection,
  );
  if (profiles.some((entry) => entry === undefined)) return undefined;

  const identities = new Set<string>();
  for (const entry of profiles as ProviderUsageProfileProjection[]) {
    const key = `${entry.providerId}\u0000${entry.credentialId}`;
    if (identities.has(key)) return undefined;
    identities.add(key);
  }

  return Object.freeze({
    profiles: Object.freeze(
      profiles as ProviderUsageProfileProjection[],
    ),
  });
}

export function decodeProviderUsageCommand(
  value: unknown,
): ProviderUsageCommand | undefined {
  if (!isRecord(value) || typeof value.command !== "string") return undefined;
  if (value.command === "query") {
    return hasOnlyKeys(value, ["command"])
      ? Object.freeze({ command: "query" as const })
      : undefined;
  }
  if (
    value.command !== "refresh" ||
    !hasOnlyKeys(value, ["command", "providerId"])
  ) {
    return undefined;
  }
  const id = providerId(value.providerId);
  return id === undefined
    ? undefined
    : Object.freeze({
        command: "refresh" as const,
        providerId: id,
      });
}

function decodeRefresh(
  value: unknown,
): ProviderUsageRefreshProjection | undefined {
  if (!isRecord(value)) return undefined;
  const pid = providerId(value.providerId);
  if (pid === undefined || typeof value.outcome !== "string") {
    return undefined;
  }
  const cid =
    value.credentialId === undefined
      ? undefined
      : credentialId(value.credentialId);
  if (value.credentialId !== undefined && cid === undefined) {
    return undefined;
  }

  if (value.outcome === "succeeded" || value.outcome === "superseded") {
    return cid !== undefined &&
      hasOnlyKeys(value, ["providerId", "credentialId", "outcome"])
      ? Object.freeze({
          providerId: pid,
          credentialId: cid,
          outcome: value.outcome,
        })
      : undefined;
  }

  if (value.outcome === "unsupported") {
    const reason = unsupportedReason(value.reason);
    return reason !== undefined &&
      hasOnlyKeys(
        value,
        ["providerId", "credentialId", "outcome", "reason"],
      )
      ? Object.freeze({
          providerId: pid,
          ...(cid === undefined ? {} : { credentialId: cid }),
          outcome: "unsupported" as const,
          reason,
        })
      : undefined;
  }

  if (value.outcome === "unavailable") {
    const reason = unavailableReason(value.reason);
    return reason !== undefined &&
      hasOnlyKeys(
        value,
        ["providerId", "credentialId", "outcome", "reason"],
      )
      ? Object.freeze({
          providerId: pid,
          ...(cid === undefined ? {} : { credentialId: cid }),
          outcome: "unavailable" as const,
          reason,
        })
      : undefined;
  }

  return undefined;
}

export function decodeProviderUsageCommandResult(
  value: unknown,
): ProviderUsageCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" && value.outcome !== "unavailable") ||
    !hasOnlyKeys(value, ["outcome", "snapshot", "refresh"])
  ) {
    return undefined;
  }

  const snapshot = decodeProviderUsageSnapshotProjection(value.snapshot);
  if (snapshot === undefined) return undefined;
  const refresh =
    value.refresh === undefined ? undefined : decodeRefresh(value.refresh);
  if (value.refresh !== undefined && refresh === undefined) return undefined;

  return Object.freeze({
    outcome: value.outcome,
    snapshot,
    ...(refresh === undefined ? {} : { refresh }),
  });
}
