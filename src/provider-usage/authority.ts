import type { Models } from "@earendil-works/pi-ai";

import {
  isProfileProviderAuthBindingCapture,
  type CredentialProfilesProjection,
  type ProviderAuthBindingAuthority,
  type ProviderAuthBindingCapture,
  type ProviderProfileBindingFacts,
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
  type ProviderUsageUnavailableReason,
} from "./contract.js";

export const PROVIDER_USAGE_REFRESH_TIMEOUT_MS = 45_000 as const;

interface ProviderUsageSlot {
  readonly bindingIdentity: string;
  readonly destinationKey: string;
  readonly observation?: ProviderUsageObservation;
  readonly unavailable?: {
    readonly bindingIdentity: string;
    readonly reason: ProviderUsageUnavailableReason;
  };
}

export interface CreateProviderUsageAuthorityOptions {
  readonly models: Pick<
    Models,
    "getProvider" | "getProviders" | "getModels" | "getAuth"
  >;
  readonly binding: ProviderAuthBindingAuthority;
  readonly profileSnapshot: () => CredentialProfilesProjection;
  readonly probes: readonly ProviderUsageProbe[];
  readonly now?: () => number;
  readonly refreshTimeoutMs?: number | (() => number);
}

function profileKey(providerId: string, credentialId: string): string {
  return `${providerId}\u0000${credentialId}`;
}

function bindingIdentity(facts: ProviderProfileBindingFacts): string {
  return JSON.stringify([
    facts.providerId,
    facts.credentialId,
    facts.referenceOwner,
    facts.externalContentRevision ?? null,
  ]);
}

function inflightIdentity(
  facts: ProviderProfileBindingFacts,
  destinationKey: string,
): string {
  return JSON.stringify([
    bindingIdentity(facts),
    facts.selectionGeneration,
    destinationKey,
  ]);
}

function bindingContext(
  facts: ProviderProfileBindingFacts,
): ProviderUsageBindingContext {
  return Object.freeze({
    kind: facts.referenceOwner,
    authType: facts.authType,
  });
}

function findBindingFailure(error: unknown): ProviderAuthBindingError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof ProviderAuthBindingError) return current;
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current)
    ) {
      return undefined;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
}

function classifyBindingFailure(error: unknown): ProviderUsageUnavailableReason {
  const failure = findBindingFailure(error);
  if (failure?.outcome === "stale_binding") return "account_change";
  if (failure?.outcome === "credential_unavailable") return "auth";
  return failure === undefined ? "upstream" : "auth";
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

  const cache = new Map<string, ProviderUsageSlot>();
  const inflight = new Map<string, Promise<ProviderUsageRefreshResult>>();
  const lifecycleAbort = new AbortController();
  let closed = false;
  const now = options.now ?? Date.now;

  const resolveRefreshTimeoutMs = (): number => {
    const configured =
      typeof options.refreshTimeoutMs === "function"
        ? options.refreshTimeoutMs()
        : options.refreshTimeoutMs;
    return configured === undefined ||
      !Number.isSafeInteger(configured) ||
      configured <= 0
      ? PROVIDER_USAGE_REFRESH_TIMEOUT_MS
      : configured;
  };

  const pruneRemovedProfiles = (): void => {
    const existing = new Set<string>();
    for (const provider of options.profileSnapshot().providers) {
      for (const profile of provider.profiles) {
        existing.add(profileKey(provider.providerId, profile.credentialId));
      }
    }
    for (const key of cache.keys()) {
      if (!existing.has(key)) cache.delete(key);
    }
  };

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
    if (modelBaseUrls.size > 0) {
      return Object.freeze([...modelBaseUrls].sort());
    }
    const providerBaseUrl = options.models.getProvider(providerId)?.baseUrl;
    return typeof providerBaseUrl === "string" &&
      providerBaseUrl.trim().length > 0
      ? Object.freeze([providerBaseUrl])
      : Object.freeze([]);
  };

  const destinationKey = (baseUrls: readonly string[]): string =>
    JSON.stringify(baseUrls);

  const eligibilityFor = (
    providerId: string,
    probe: ProviderUsageProbe,
    facts: ProviderProfileBindingFacts,
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
        binding: bindingContext(facts),
      });
      const eligibility = probe.eligibility(context);
      if (eligibility.state !== "eligible") return eligibility;
    }
    return Object.freeze({ state: "eligible" });
  };

  const stateIdentity = (
    facts: ProviderProfileBindingFacts,
  ): { readonly providerId: string; readonly credentialId: string } => ({
    providerId: facts.providerId,
    credentialId: facts.credentialId,
  });

  const queryProvider = async (
    providerId: string,
    retry: boolean,
  ): Promise<ProviderUsageState | undefined> => {
    let capture: ProviderAuthBindingCapture;
    try {
      capture = await options.binding.capture(providerId);
    } catch {
      return undefined;
    }
    if (!isProfileProviderAuthBindingCapture(capture)) return undefined;

    const facts = capture.facts;
    const identity = stateIdentity(facts);
    const probe = probes.get(providerId);
    if (probe === undefined) {
      return Object.freeze({
        ...identity,
        state: "unsupported" as const,
        reason: "provider" as const,
      });
    }

    const baseUrls = servedBaseUrls(providerId);
    const destination = destinationKey(baseUrls);
    let eligibility: ProviderUsageEligibility;
    try {
      eligibility = eligibilityFor(providerId, probe, facts, baseUrls);
    } catch {
      eligibility = Object.freeze({ state: "unsupported_binding" as const });
    }

    const slot = cache.get(profileKey(providerId, facts.credentialId));
    const exactBinding = bindingIdentity(facts);
    const matchingSlot =
      slot !== undefined &&
      slot.bindingIdentity === exactBinding &&
      slot.destinationKey === destination
        ? slot
        : undefined;

    const candidate: ProviderUsageState =
      matchingSlot?.observation !== undefined
        ? Object.freeze({
            ...identity,
            state: "observed" as const,
            observation: matchingSlot.observation,
            refreshable: eligibility.state === "eligible",
          })
        : matchingSlot?.unavailable !== undefined
          ? Object.freeze({
              ...identity,
              state: "unavailable" as const,
              reason: matchingSlot.unavailable.reason,
            })
          : eligibility.state === "unsupported_binding"
            ? Object.freeze({
                ...identity,
                state: "unsupported" as const,
                reason: "binding" as const,
              })
            : eligibility.state === "unsupported_destination"
              ? Object.freeze({
                  ...identity,
                  state: "unsupported" as const,
                  reason: "destination" as const,
                })
              : Object.freeze({
                  ...identity,
                  state: "unobserved" as const,
                });

    let published: ProviderUsageState | undefined;
    const current = await options.binding.publishIfCurrent(capture, () => {
      if (destinationKey(servedBaseUrls(providerId)) !== destination) return;
      published = candidate;
    });
    if (current && published !== undefined) return published;
    if (retry) return queryProvider(providerId, false);
    return undefined;
  };

  const query = async (): Promise<ProviderUsageSnapshot> => {
    pruneRemovedProfiles();
    const states = await Promise.all(
      options.models
        .getProviders()
        .map((provider) => queryProvider(provider.id, true)),
    );
    return Object.freeze({
      profiles: Object.freeze(
        states.filter(
          (state): state is ProviderUsageState => state !== undefined,
        ),
      ),
    });
  };

  const unavailableRefresh = (
    providerId: string,
    credentialId?: string,
    reason: ProviderUsageUnavailableReason = "network",
  ): ProviderUsageRefreshResult =>
    Object.freeze({
      providerId,
      ...(credentialId === undefined ? {} : { credentialId }),
      outcome: "unavailable" as const,
      reason,
    });

  const recordUnavailable = (
    facts: ProviderProfileBindingFacts,
    destination: string,
    reason: ProviderUsageUnavailableReason,
  ): void => {
    if (closed) return;
    const key = profileKey(facts.providerId, facts.credentialId);
    const identity = bindingIdentity(facts);
    const previous = cache.get(key);
    const observation =
      previous?.bindingIdentity === identity &&
      previous.destinationKey === destination
        ? previous.observation
        : undefined;
    cache.set(
      key,
      Object.freeze({
        bindingIdentity: identity,
        destinationKey: destination,
        ...(observation === undefined ? {} : { observation }),
        unavailable: Object.freeze({
          bindingIdentity: identity,
          reason,
        }),
      }),
    );
  };

  const startRefresh = (
    providerId: string,
    probe: ProviderUsageProbe,
    capture: ProviderAuthBindingCapture,
  ): Promise<ProviderUsageRefreshResult> => {
    if (!isProfileProviderAuthBindingCapture(capture)) {
      return Promise.resolve(
        Object.freeze({
          providerId,
          outcome: "unsupported" as const,
          reason: "binding" as const,
        }),
      );
    }

    const facts = capture.facts;
    if (closed || lifecycleAbort.signal.aborted) {
      return Promise.resolve(
        unavailableRefresh(providerId, facts.credentialId),
      );
    }

    const baseUrls = servedBaseUrls(providerId);
    if (baseUrls.length === 0) {
      return Promise.resolve(
        Object.freeze({
          providerId,
          credentialId: facts.credentialId,
          outcome: "unsupported" as const,
          reason: "destination" as const,
        }),
      );
    }

    let eligibility: ProviderUsageEligibility;
    try {
      eligibility = eligibilityFor(providerId, probe, facts, baseUrls);
    } catch {
      return Promise.resolve(
        unavailableRefresh(providerId, facts.credentialId, "upstream"),
      );
    }
    if (eligibility.state !== "eligible") {
      return Promise.resolve(
        Object.freeze({
          providerId,
          credentialId: facts.credentialId,
          outcome: "unsupported" as const,
          reason:
            eligibility.state === "unsupported_destination"
              ? ("destination" as const)
              : ("binding" as const),
        }),
      );
    }

    const destination = destinationKey(baseUrls);
    const profileCacheKey = profileKey(providerId, facts.credentialId);
    const existingSlot = cache.get(profileCacheKey);
    if (
      existingSlot?.destinationKey === destination &&
      existingSlot.bindingIdentity === bindingIdentity(facts) &&
      existingSlot.unavailable?.reason === "terminal"
    ) {
      return Promise.resolve(
        unavailableRefresh(providerId, facts.credentialId, "terminal"),
      );
    }

    const key = inflightIdentity(facts, destination);
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;

    const pending = (async (): Promise<ProviderUsageRefreshResult> => {
      const timeoutSignal = AbortSignal.timeout(resolveRefreshTimeoutMs());
      const signal = AbortSignal.any([
        timeoutSignal,
        lifecycleAbort.signal,
      ]);

      const fail = async (
        reason: ProviderUsageUnavailableReason,
      ): Promise<ProviderUsageRefreshResult> => {
        let committed = false;
        const current = await options.binding.publishIfCurrent(
          capture,
          (assertCurrent, publicationFacts) => {
            if (
              publicationFacts.kind !== "profile" ||
              closed ||
              destinationKey(servedBaseUrls(providerId)) !== destination
            ) {
              return;
            }
            assertCurrent();
            recordUnavailable(publicationFacts, destination, reason);
            committed = true;
          },
        );
        return !current || !committed
          ? Object.freeze({
              providerId,
              credentialId: facts.credentialId,
              outcome: "superseded" as const,
            })
          : unavailableRefresh(providerId, facts.credentialId, reason);
      };

      let acquired:
        | ProviderUsageProbeResult
        | { readonly state: "unsupported_destination" };
      try {
        acquired = await options.binding.runBound(capture, async () => {
          const auth = await options.models.getAuth(providerId, { signal });
          if (auth === undefined) {
            return Object.freeze({
              state: "unavailable" as const,
              reason: "auth" as const,
            });
          }
          const authBaseUrl = auth.auth.baseUrl?.trim();
          if (authBaseUrl !== undefined && authBaseUrl.length > 0) {
            const authEligibility = eligibilityFor(
              providerId,
              probe,
              facts,
              [authBaseUrl],
            );
            if (authEligibility.state !== "eligible") {
              return Object.freeze({
                state: "unsupported_destination" as const,
              });
            }
          }
          return probe.acquire({ auth, signal });
        });
      } catch (error) {
        if (signal.aborted) {
          return timeoutSignal.aborted
            ? fail("timeout")
            : unavailableRefresh(
                providerId,
                facts.credentialId,
                "network",
              );
        }
        return fail(classifyBindingFailure(error));
      }

      if (acquired.state === "unsupported_destination") {
        return Object.freeze({
          providerId,
          credentialId: facts.credentialId,
          outcome: "unsupported" as const,
          reason: "destination" as const,
        });
      }
      if (acquired.state === "unavailable") {
        return fail(acquired.reason);
      }
      const normalized = normalizeProviderUsageFacts(acquired.facts);
      if (normalized === undefined) return fail("schema");

      const observation: ProviderUsageObservation = Object.freeze({
        providerId,
        credentialId: facts.credentialId,
        observedAt: now(),
        windows: normalized.windows,
        budgets: normalized.budgets,
      });
      if (destinationKey(servedBaseUrls(providerId)) !== destination) {
        return Object.freeze({
          providerId,
          credentialId: facts.credentialId,
          outcome: "superseded" as const,
        });
      }

      let committed = false;
      const current = await options.binding.publishIfCurrent(
        capture,
        (assertCurrent, publicationFacts) => {
          if (
            publicationFacts.kind !== "profile" ||
            destinationKey(servedBaseUrls(providerId)) !== destination
          ) {
            return;
          }
          assertCurrent();
          cache.set(
            profileKey(
              publicationFacts.providerId,
              publicationFacts.credentialId,
            ),
            Object.freeze({
              bindingIdentity: bindingIdentity(publicationFacts),
              destinationKey: destination,
              observation,
            }),
          );
          committed = true;
        },
      );
      if (!current || !committed) {
        return Object.freeze({
          providerId,
          credentialId: facts.credentialId,
          outcome: "superseded" as const,
        });
      }
      return Object.freeze({
        providerId,
        credentialId: facts.credentialId,
        outcome: "succeeded" as const,
      });
    })().finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });

    inflight.set(key, pending);
    return pending;
  };

  const waitForRefresh = (
    pending: Promise<ProviderUsageRefreshResult>,
    providerId: string,
    credentialId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ProviderUsageRefreshResult> => {
    if (signal === undefined) return pending;
    if (signal.aborted) {
      return Promise.resolve(
        unavailableRefresh(providerId, credentialId),
      );
    }
    return new Promise<ProviderUsageRefreshResult>((resolve) => {
      let settled = false;
      const finish = (value: ProviderUsageRefreshResult): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void =>
        finish(unavailableRefresh(providerId, credentialId));
      signal.addEventListener("abort", onAbort, { once: true });
      void pending.then(
        (value) => finish(value),
        () => finish(unavailableRefresh(providerId, credentialId)),
      );
    });
  };

  const observePassive = async (
    providerId: string,
    capture: ProviderAuthBindingCapture,
    observedBaseUrl: string,
    rawFacts: Parameters<ProviderUsageAuthority["observePassive"]>[3],
  ): Promise<boolean> => {
    if (
      closed ||
      !isProfileProviderAuthBindingCapture(capture) ||
      capture.facts.providerId !== providerId ||
      !probes.has(providerId)
    ) {
      return false;
    }
    const normalized = normalizeProviderUsageFacts(rawFacts);
    if (normalized === undefined) return false;
    const baseUrls = servedBaseUrls(providerId);
    if (baseUrls.length !== 1 || observedBaseUrl !== baseUrls[0]) return false;

    const destination = destinationKey(baseUrls);
    const observation: ProviderUsageObservation = Object.freeze({
      providerId,
      credentialId: capture.facts.credentialId,
      observedAt: now(),
      windows: normalized.windows,
      budgets: normalized.budgets,
    });
    let committed = false;
    const current = await options.binding.publishIfCurrent(
      capture,
      (assertCurrent, publicationFacts) => {
        if (
          publicationFacts.kind !== "profile" ||
          closed ||
          destinationKey(servedBaseUrls(providerId)) !== destination
        ) {
          return;
        }
        assertCurrent();
        cache.set(
          profileKey(
            publicationFacts.providerId,
            publicationFacts.credentialId,
          ),
          Object.freeze({
            bindingIdentity: bindingIdentity(publicationFacts),
            destinationKey: destination,
            observation,
          }),
        );
        committed = true;
      },
    );
    return current && committed;
  };

  const refresh = async (
    providerId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly snapshot: ProviderUsageSnapshot;
    readonly refresh: ProviderUsageRefreshResult;
  }> => {
    if (closed) {
      return Object.freeze({
        snapshot: await query(),
        refresh: unavailableRefresh(providerId),
      });
    }

    const probe = probes.get(providerId);
    let capture: ProviderAuthBindingCapture | undefined;
    try {
      capture = await options.binding.capture(providerId);
    } catch {
      capture = undefined;
    }
    const credentialId =
      capture !== undefined &&
      isProfileProviderAuthBindingCapture(capture)
        ? capture.facts.credentialId
        : undefined;

    let refreshResult: ProviderUsageRefreshResult;
    if (probe === undefined) {
      refreshResult = Object.freeze({
        providerId,
        ...(credentialId === undefined ? {} : { credentialId }),
        outcome: "unsupported" as const,
        reason: "provider" as const,
      });
    } else if (capture === undefined || !isProfileProviderAuthBindingCapture(capture)) {
      refreshResult = Object.freeze({
        providerId,
        outcome: "unsupported" as const,
        reason: "binding" as const,
      });
    } else {
      refreshResult = await waitForRefresh(
        startRefresh(providerId, probe, capture),
        providerId,
        credentialId,
        signal,
      );
    }

    return Object.freeze({
      snapshot: await query(),
      refresh: refreshResult,
    });
  };

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    lifecycleAbort.abort();
    closePromise = Promise.allSettled([...inflight.values()]).then(
      () => undefined,
    );
    return closePromise;
  };

  return Object.freeze({ query, refresh, observePassive, close });
}
