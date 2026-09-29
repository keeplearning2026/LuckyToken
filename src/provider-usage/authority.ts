import type { Models } from "@earendil-works/pi-ai";

import {
  type ProviderAuthBindingAuthority,
  type ProviderAuthBindingCapture,
  ProviderAuthBindingError,
} from "../credentials/profile-contract.js";
import {
  normalizeProviderUsageFacts,
  type ProviderUsageAuthority,
  type ProviderUsageBindingContext,
  type ProviderUsageEligibilityContext,
  type ProviderUsageObservation,
  type ProviderUsageProbe,
  type ProviderUsageRefreshResult,
  type ProviderUsageSnapshot,
  type ProviderUsageState,
} from "./contract.js";

export const PROVIDER_USAGE_REFRESH_TIMEOUT_MS = 8_000 as const;

interface CacheSlot {
  readonly bindingIdentity: string;
  readonly effectiveBaseUrl?: string;
  readonly observation: ProviderUsageObservation;
}

export interface CreateProviderUsageAuthorityOptions {
  readonly models: Pick<
    Models,
    "getProvider" | "getProviders" | "getModels" | "getAuth"
  >;
  readonly binding: ProviderAuthBindingAuthority;
  readonly probes: readonly ProviderUsageProbe[];
  readonly now?: () => number;
  readonly refreshTimeoutMs?: number;
}

function bindingIdentity(capture: ProviderAuthBindingCapture): string {
  const facts = capture.facts;
  return facts.kind === "ambient"
    ? `${facts.providerId}\u0000ambient`
    : `${facts.providerId}\u0000managed\u0000${facts.credentialId}\u0000${facts.credentialGeneration}`;
}

function inflightIdentity(capture: ProviderAuthBindingCapture): string {
  const facts = capture.facts;
  return facts.kind === "ambient"
    ? bindingIdentity(capture)
    : `${bindingIdentity(capture)}\u0000${facts.selectionGeneration}`;
}

function bindingContext(capture: ProviderAuthBindingCapture): ProviderUsageBindingContext {
  return capture.facts.kind === "ambient"
    ? Object.freeze({ kind: "ambient" })
    : Object.freeze({ kind: "managed", authType: capture.facts.authType });
}

function unavailable(providerId: string): ProviderUsageState {
  return Object.freeze({ state: "unavailable", providerId, reason: "auth" });
}

function passiveWindowKey(
  window: ProviderUsageObservation["windows"][number],
): string {
  const scope =
    window.scope?.kind === "model" ? window.scope.modelLabel : "";
  const duration =
    window.kind === "custom" ? window.durationMinutes ?? "" : "";
  return `${window.kind}\u0000${scope}\u0000${duration}`;
}

function passiveBudgetKey(
  budget: ProviderUsageObservation["budgets"][number],
): string {
  return budget.kind === "balance"
    ? `${budget.kind}\u0000${budget.currency}`
    : budget.kind === "credits"
      ? `${budget.kind}\u0000${budget.currency ?? ""}`
      : budget.kind;
}

function mergePassiveFacts(
  previous: ProviderUsageObservation | undefined,
  incoming: Pick<ProviderUsageObservation, "windows" | "budgets">,
): Pick<ProviderUsageObservation, "windows" | "budgets"> {
  if (previous === undefined) {
    return Object.freeze({
      windows: incoming.windows,
      budgets: incoming.budgets,
    });
  }
  const windows = new Map(
    previous.windows.map((window) => [passiveWindowKey(window), window] as const),
  );
  for (const window of incoming.windows) {
    windows.set(passiveWindowKey(window), window);
  }
  const budgets = new Map(
    previous.budgets.map((budget) => [passiveBudgetKey(budget), budget] as const),
  );
  for (const budget of incoming.budgets) {
    budgets.set(passiveBudgetKey(budget), budget);
  }
  return Object.freeze({
    windows: Object.freeze([...windows.values()]),
    budgets: Object.freeze([...budgets.values()]),
  });
}

export function createProviderUsageAuthority(
  options: CreateProviderUsageAuthorityOptions,
): ProviderUsageAuthority {
  const probes = new Map<string, ProviderUsageProbe>();
  for (const probe of options.probes) {
    if (probes.has(probe.providerId)) {
      throw new Error(`Duplicate Provider Usage probe: ${probe.providerId}`);
    }
    probes.set(probe.providerId, probe);
  }

  const cache = new Map<string, CacheSlot>();
  const inflight = new Map<string, Promise<ProviderUsageRefreshResult>>();
  const now = options.now ?? Date.now;
  const timeoutMs = options.refreshTimeoutMs ?? PROVIDER_USAGE_REFRESH_TIMEOUT_MS;

  const effectiveBaseUrl = (providerId: string): string | undefined => {
    const provider = options.models.getProvider(providerId);
    if (provider?.baseUrl !== undefined) return provider.baseUrl;
    const modelBaseUrls = new Set(
      options.models
        .getModels(providerId)
        .map((model) => model.baseUrl)
        .filter((baseUrl): baseUrl is string => typeof baseUrl === "string"),
    );
    return modelBaseUrls.size === 1 ? [...modelBaseUrls][0] : undefined;
  };

  const eligibilityFor = (
    providerId: string,
    probe: ProviderUsageProbe,
    capture: ProviderAuthBindingCapture,
    baseUrl: string | undefined,
  ) => {
    if (options.models.getProvider(providerId) === undefined) {
      return Object.freeze({ state: "unsupported_destination" as const });
    }
    const context: ProviderUsageEligibilityContext = Object.freeze({
      providerId,
      ...(baseUrl === undefined ? {} : { effectiveBaseUrl: baseUrl }),
      binding: bindingContext(capture),
    });
    return probe.eligibility(context);
  };

  const queryProvider = async (
    providerId: string,
    retry: boolean,
  ): Promise<ProviderUsageState> => {
    const probe = probes.get(providerId);
    if (probe === undefined) {
      return Object.freeze({
        state: "unsupported",
        providerId,
        reason: "provider",
      });
    }
    let capture: ProviderAuthBindingCapture;
    try {
      capture = await options.binding.capture(providerId);
    } catch {
      return unavailable(providerId);
    }
    const baseUrl = effectiveBaseUrl(providerId);
    const eligibility = eligibilityFor(providerId, probe, capture, baseUrl);
    const slot = cache.get(providerId);
    const matchingSlot =
      slot !== undefined &&
      slot.bindingIdentity === bindingIdentity(capture) &&
      slot.effectiveBaseUrl === baseUrl
        ? slot
        : undefined;
    const candidate: ProviderUsageState =
      matchingSlot !== undefined
        ? Object.freeze({
            state: "observed",
            observation: matchingSlot.observation,
            refreshable: eligibility.state === "eligible",
          })
        : eligibility.state === "unsupported_binding"
          ? Object.freeze({
              state: "unsupported",
              providerId,
              reason: "binding",
            })
          : eligibility.state === "unsupported_destination"
            ? Object.freeze({
                state: "unsupported",
                providerId,
                reason: "destination",
              })
            : Object.freeze({ state: "unobserved", providerId });

    let published: ProviderUsageState | undefined;
    const current = await options.binding.publishIfCurrent(capture, () => {
      published = candidate;
    });
    if (current && published !== undefined) return published;
    if (retry) return queryProvider(providerId, false);
    return Object.freeze({ state: "unobserved", providerId });
  };

  const query = async (): Promise<ProviderUsageSnapshot> => {
    const providerIds = options.models.getProviders().map((provider) => provider.id);
    const states = await Promise.all(providerIds.map((providerId) => queryProvider(providerId, true)));
    return Object.freeze({ providers: Object.freeze(states) });
  };

  const refreshCurrent = async (
    providerId: string,
    probe: ProviderUsageProbe,
    capture: ProviderAuthBindingCapture,
  ): Promise<ProviderUsageRefreshResult> => {
    const baseUrl = effectiveBaseUrl(providerId);
    const eligibility = eligibilityFor(providerId, probe, capture, baseUrl);
    if (eligibility.state === "unsupported_binding") {
      return Object.freeze({
        providerId,
        outcome: "unsupported",
        reason: "binding",
      });
    }
    if (eligibility.state === "unsupported_destination") {
      return Object.freeze({
        providerId,
        outcome: "unsupported",
        reason: "destination",
      });
    }

    const key = inflightIdentity(capture);
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;

    const pending = (async (): Promise<ProviderUsageRefreshResult> => {
      const signal = AbortSignal.timeout(timeoutMs);
      let acquired;
      try {
        acquired = await options.binding.runBound(capture, async () => {
          const auth = await options.models.getAuth(providerId, { signal });
          if (auth === undefined) {
            return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
          }
          return probe.acquire({ auth, signal });
        });
      } catch (error) {
        if (signal.aborted) {
          return Object.freeze({
            providerId,
            outcome: "unavailable",
            reason: "network",
          });
        }
        if (error instanceof ProviderAuthBindingError) {
          return Object.freeze({
            providerId,
            outcome: "unavailable",
            reason: "auth",
          });
        }
        return Object.freeze({
          providerId,
          outcome: "unavailable",
          reason: "upstream",
        });
      }

      if (acquired.state === "unavailable") {
        return Object.freeze({
          providerId,
          outcome: "unavailable",
          reason: acquired.reason,
        });
      }
      const facts = normalizeProviderUsageFacts(acquired.facts);
      if (facts === undefined) {
        return Object.freeze({
          providerId,
          outcome: "unavailable",
          reason: "schema",
        });
      }
      const observation: ProviderUsageObservation = Object.freeze({
        providerId,
        observedAt: now(),
        windows: facts.windows,
        budgets: facts.budgets,
      });
      if (effectiveBaseUrl(providerId) !== baseUrl) {
        return Object.freeze({ providerId, outcome: "superseded" });
      }
      let committed = false;
      const current = await options.binding.publishIfCurrent(capture, () => {
        cache.set(providerId, Object.freeze({
          bindingIdentity: bindingIdentity(capture),
          ...(baseUrl === undefined ? {} : { effectiveBaseUrl: baseUrl }),
          observation,
        }));
        committed = true;
      });
      if (!current || !committed) {
        return Object.freeze({ providerId, outcome: "superseded" });
      }
      return Object.freeze({ providerId, outcome: "succeeded" });
    })().finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });

    inflight.set(key, pending);
    return pending;
  };

  const observePassive = async (
    providerId: string,
    capture: ProviderAuthBindingCapture,
    rawFacts: Parameters<ProviderUsageAuthority["observePassive"]>[2],
  ): Promise<boolean> => {
    if (
      capture.facts.providerId !== providerId ||
      !probes.has(providerId)
    ) {
      return false;
    }
    const facts = normalizeProviderUsageFacts(rawFacts);
    if (facts === undefined) return false;
    const baseUrl = effectiveBaseUrl(providerId);
    let committed = false;
    const current = await options.binding.publishIfCurrent(capture, () => {
      if (effectiveBaseUrl(providerId) !== baseUrl) return;
      const identity = bindingIdentity(capture);
      const previousSlot = cache.get(providerId);
      const previous =
        previousSlot !== undefined &&
        previousSlot.bindingIdentity === identity &&
        previousSlot.effectiveBaseUrl === baseUrl
          ? previousSlot.observation
          : undefined;
      const merged = mergePassiveFacts(previous, facts);
      const observation: ProviderUsageObservation = Object.freeze({
        providerId,
        observedAt: now(),
        windows: merged.windows,
        budgets: merged.budgets,
      });
      cache.set(
        providerId,
        Object.freeze({
          bindingIdentity: identity,
          ...(baseUrl === undefined ? {} : { effectiveBaseUrl: baseUrl }),
          observation,
        }),
      );
      committed = true;
    });
    return current && committed;
  };

  const refresh = async (providerId: string) => {
    const probe = probes.get(providerId);
    let refreshResult: ProviderUsageRefreshResult;
    if (probe === undefined) {
      refreshResult = Object.freeze({
        providerId,
        outcome: "unsupported",
        reason: "provider",
      });
    } else {
      let capture: ProviderAuthBindingCapture | undefined;
      try {
        capture = await options.binding.capture(providerId);
      } catch {
        refreshResult = Object.freeze({
          providerId,
          outcome: "unavailable",
          reason: "auth",
        });
      }
      if (capture !== undefined) {
        refreshResult = await refreshCurrent(providerId, probe, capture);
      }
    }
    return Object.freeze({
      snapshot: await query(),
      refresh: refreshResult!,
    });
  };

  return Object.freeze({ query, refresh, observePassive });
}
