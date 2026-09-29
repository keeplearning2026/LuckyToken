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
  type ProviderUsageEligibility,
  type ProviderUsageEligibilityContext,
  type ProviderUsageObservation,
  type ProviderUsageProbe,
  type ProviderUsageProbeResult,
  type ProviderUsageRefreshResult,
  type ProviderUsageSnapshot,
  type ProviderUsageState,
} from "./contract.js";

export const PROVIDER_USAGE_REFRESH_TIMEOUT_MS = 8_000 as const;

interface CacheSlot {
  readonly bindingIdentity: string;
  readonly destinationKey: string;
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

function inflightIdentity(
  capture: ProviderAuthBindingCapture,
  destinationKey: string,
): string {
  const facts = capture.facts;
  const binding =
    facts.kind === "ambient"
      ? bindingIdentity(capture)
      : `${bindingIdentity(capture)}\u0000${facts.selectionGeneration}`;
  return `${binding}\u0000${destinationKey}`;
}

function bindingContext(capture: ProviderAuthBindingCapture): ProviderUsageBindingContext {
  return capture.facts.kind === "ambient"
    ? Object.freeze({ kind: "ambient" })
    : Object.freeze({ kind: "managed", authType: capture.facts.authType });
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

  const servedBaseUrls = (providerId: string): readonly string[] => {
    const modelBaseUrls = new Set(
      options.models
        .getModels(providerId)
        .map((model) => model.baseUrl)
        .filter(
          (baseUrl): baseUrl is string =>
            typeof baseUrl === "string" && baseUrl.trim().length > 0,
        ),
    );
    if (modelBaseUrls.size > 0) return Object.freeze([...modelBaseUrls].sort());
    const providerBaseUrl = options.models.getProvider(providerId)?.baseUrl;
    return typeof providerBaseUrl === "string" && providerBaseUrl.trim().length > 0
      ? Object.freeze([providerBaseUrl])
      : Object.freeze([]);
  };

  const destinationKey = (baseUrls: readonly string[]): string =>
    JSON.stringify(baseUrls);

  const eligibilityFor = (
    providerId: string,
    probe: ProviderUsageProbe,
    capture: ProviderAuthBindingCapture,
    baseUrls: readonly string[],
  ): ProviderUsageEligibility => {
    if (
      options.models.getProvider(providerId) === undefined ||
      baseUrls.length === 0
    ) {
      return Object.freeze({ state: "unsupported_destination" as const });
    }
    for (const baseUrl of baseUrls) {
      const context: ProviderUsageEligibilityContext = Object.freeze({
        providerId,
        effectiveBaseUrl: baseUrl,
        binding: bindingContext(capture),
      });
      const eligibility = probe.eligibility(context);
      if (eligibility.state !== "eligible") return eligibility;
    }
    return Object.freeze({ state: "eligible" });
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
      if (retry) return queryProvider(providerId, false);
      return Object.freeze({ state: "unobserved", providerId });
    }
    const baseUrls = servedBaseUrls(providerId);
    const key = destinationKey(baseUrls);
    let eligibility: ProviderUsageEligibility;
    try {
      eligibility = eligibilityFor(providerId, probe, capture, baseUrls);
    } catch {
      if (retry) return queryProvider(providerId, false);
      return Object.freeze({ state: "unobserved", providerId });
    }
    const slot = cache.get(providerId);
    const matchingSlot =
      slot !== undefined &&
      slot.bindingIdentity === bindingIdentity(capture) &&
      slot.destinationKey === key
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
      if (destinationKey(servedBaseUrls(providerId)) !== key) return;
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
    const baseUrls = servedBaseUrls(providerId);
    if (baseUrls.length === 0) {
      return Object.freeze({
        providerId,
        outcome: "unsupported",
        reason: "destination",
      });
    }
    let eligibility: ProviderUsageEligibility;
    try {
      eligibility = eligibilityFor(providerId, probe, capture, baseUrls);
    } catch {
      return Object.freeze({
        providerId,
        outcome: "unavailable",
        reason: "upstream",
      });
    }
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

    const destination = destinationKey(baseUrls);
    const key = inflightIdentity(capture, destination);
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;

    const pending = (async (): Promise<ProviderUsageRefreshResult> => {
      const signal = AbortSignal.timeout(timeoutMs);
      let acquired:
        | ProviderUsageProbeResult
        | { readonly state: "unsupported_destination" };
      try {
        acquired = await options.binding.runBound(capture, async () => {
          const auth = await options.models.getAuth(providerId, { signal });
          if (auth === undefined) {
            return Object.freeze({ state: "unavailable" as const, reason: "auth" as const });
          }
          const authBaseUrl = auth.auth.baseUrl?.trim();
          if (authBaseUrl !== undefined && authBaseUrl.length > 0) {
            const authEligibility = eligibilityFor(
              providerId,
              probe,
              capture,
              [authBaseUrl],
            );
            if (authEligibility.state !== "eligible") {
              return Object.freeze({ state: "unsupported_destination" as const });
            }
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

      if (acquired.state === "unsupported_destination") {
        return Object.freeze({
          providerId,
          outcome: "unsupported",
          reason: "destination",
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
      if (destinationKey(servedBaseUrls(providerId)) !== destination) {
        return Object.freeze({ providerId, outcome: "superseded" });
      }
      let committed = false;
      const current = await options.binding.publishIfCurrent(capture, () => {
        if (destinationKey(servedBaseUrls(providerId)) !== destination) return;
        cache.set(providerId, Object.freeze({
          bindingIdentity: bindingIdentity(capture),
          destinationKey: destination,
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
    observedBaseUrl: string,
    rawFacts: Parameters<ProviderUsageAuthority["observePassive"]>[3],
  ): Promise<boolean> => {
    if (
      capture.facts.providerId !== providerId ||
      !probes.has(providerId)
    ) {
      return false;
    }
    const facts = normalizeProviderUsageFacts(rawFacts);
    if (facts === undefined) return false;
    const baseUrls = servedBaseUrls(providerId);
    if (baseUrls.length !== 1 || observedBaseUrl !== baseUrls[0]) return false;
    const destination = destinationKey(baseUrls);
    const observation: ProviderUsageObservation = Object.freeze({
      providerId,
      observedAt: now(),
      windows: facts.windows,
      budgets: facts.budgets,
    });
    let committed = false;
    const current = await options.binding.publishIfCurrent(capture, () => {
      if (destinationKey(servedBaseUrls(providerId)) !== destination) return;
      cache.set(
        providerId,
        Object.freeze({
          bindingIdentity: bindingIdentity(capture),
          destinationKey: destination,
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
