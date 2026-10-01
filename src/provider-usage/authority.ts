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
  type ProviderUsageUnavailableReason,
} from "./contract.js";

export const PROVIDER_USAGE_REFRESH_TIMEOUT_MS = 45_000 as const;

interface ProviderUsageSlot {
  readonly bindingIdentity: string;
  /** Identity of the account the observation belongs to. A new token
   * revision for the same account may keep displaying the last-known
   * observation as stale; a different account never carries over. */
  readonly accountKey: string;
  readonly destinationKey: string;
  readonly observation?: ProviderUsageObservation;
  /** Bounded failure classification for an external capture, recorded only for
   * the exact credential revision that produced it. Managed and ambient
   * bindings keep the previous behavior: a failed refresh is returned but not
   * persisted as Provider state. */
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
  readonly probes: readonly ProviderUsageProbe[];
  readonly now?: () => number;
  readonly refreshTimeoutMs?: number | (() => number);
}

function bindingIdentity(capture: ProviderAuthBindingCapture): string {
  const facts = capture.facts;
  if (facts.kind === "ambient") return `${facts.providerId}\u0000ambient`;
  if (facts.kind === "external") {
    return `${facts.providerId}\u0000external\u0000${facts.accountId}\u0000${facts.tokenRevision}`;
  }
  return `${facts.providerId}\u0000managed\u0000${facts.credentialId}\u0000${facts.credentialGeneration}`;
}

function bindingAccountKey(capture: ProviderAuthBindingCapture): string {
  const facts = capture.facts;
  if (facts.kind === "ambient") return `${facts.providerId}\u0000ambient`;
  if (facts.kind === "external") {
    return `${facts.providerId}\u0000external\u0000${facts.accountId}`;
  }
  return `${facts.providerId}\u0000managed\u0000${facts.credentialId}\u0000${facts.credentialGeneration}`;
}

function inflightIdentity(
  capture: ProviderAuthBindingCapture,
  destinationKey: string,
): string {
  const facts = capture.facts;
  const binding =
    facts.kind !== "managed"
      ? bindingIdentity(capture)
      : `${bindingIdentity(capture)}\u0000${facts.selectionGeneration}`;
  return `${binding}\u0000${destinationKey}`;
}

function bindingContext(capture: ProviderAuthBindingCapture): ProviderUsageBindingContext {
  if (capture.facts.kind === "ambient") return Object.freeze({ kind: "ambient" });
  if (capture.facts.kind === "external") {
    return Object.freeze({ kind: "external", authType: "oauth" });
  }
  return Object.freeze({ kind: "managed", authType: capture.facts.authType });
}

/** Follow `cause` links so a Pi `ModelsError` wrapper still exposes the
 * credential boundary's typed outcome. Message text is never inspected. */
function findBindingFailure(error: unknown): ProviderAuthBindingError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof ProviderAuthBindingError) return current;
    if (typeof current !== "object" || current === null || !("cause" in current)) {
      return undefined;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
}

/** Credential-boundary failure classification (plan section 6). The external
 * boundary reports a structured `externalReason`; classification never
 * inspects message text. Read/parse failures, an unavailable delegation, and
 * post-refresh verification failures stay bounded transient. Only documented
 * terminal evidence (a verified credential rejected by the resource server)
 * stops network attempts. Managed and ambient bindings keep their previous
 * classification. */
function classifyBindingFailure(
  capture: ProviderAuthBindingCapture,
  error: unknown,
): ProviderUsageUnavailableReason {
  const failure = findBindingFailure(error);
  if (capture.facts.kind !== "external") {
    return failure === undefined ? "upstream" : "auth";
  }
  switch (failure?.externalReason) {
    case "account_changed":
      return "account_change";
    case "timeout":
      return "timeout";
    case "insufficient_validity":
      return "insufficient_validity";
    default:
      return failure?.outcome === "stale_binding" ? "account_change" : "temporary";
  }
}

/** Only a probe's explicit terminal evidence stops retries. Missing auth and
 * bare HTTP authentication failures are transient for external bindings. */
function classifyProbeFailure(
  capture: ProviderAuthBindingCapture,
  reason: ProviderUsageUnavailableReason,
): ProviderUsageUnavailableReason {
  return capture.facts.kind === "external" && reason === "auth"
    ? "temporary"
    : reason;
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
    const configured = typeof options.refreshTimeoutMs === "function"
      ? options.refreshTimeoutMs()
      : options.refreshTimeoutMs;
    return configured === undefined ||
      !Number.isSafeInteger(configured) ||
      configured <= 0
      ? PROVIDER_USAGE_REFRESH_TIMEOUT_MS
      : configured;
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
    const identity = bindingIdentity(capture);
    const accountKey = bindingAccountKey(capture);
    const matchingSlot =
      slot !== undefined && slot.destinationKey === key &&
      (slot.bindingIdentity === identity || slot.accountKey === accountKey)
        ? slot
        : undefined;
    // A recorded failure describes one exact revision: it is shown until the
    // external document (or the managed credential) changes, and never for a
    // different account or destination.
    const unavailable =
      matchingSlot?.unavailable !== undefined &&
      matchingSlot.unavailable.bindingIdentity === identity
        ? matchingSlot.unavailable.reason
        : undefined;
    const candidate: ProviderUsageState =
      matchingSlot?.observation !== undefined
        ? Object.freeze({
            state: "observed",
            observation: matchingSlot.observation,
            refreshable: eligibility.state === "eligible",
          })
        : unavailable !== undefined
          ? Object.freeze({
              state: "unavailable",
              providerId,
              reason: unavailable,
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

  const unavailableRefresh = (
    providerId: string,
  ): ProviderUsageRefreshResult =>
    Object.freeze({
      providerId,
      outcome: "unavailable",
      reason: "network",
    });

  /** Publish the bounded failure state of an external capture. Managed and
   * ambient bindings are not persisted, matching the previous behavior. An
   * observation for the same account and destination is preserved so the
   * last-known windows stay displayed as stale. */
  const recordUnavailable = (
    capture: ProviderAuthBindingCapture,
    destination: string,
    reason: ProviderUsageUnavailableReason,
  ): void => {
    if (closed || capture.facts.kind !== "external") return;
    const identity = bindingIdentity(capture);
    const accountKey = bindingAccountKey(capture);
    const previous = cache.get(capture.facts.providerId);
    const observation =
      previous !== undefined &&
      previous.destinationKey === destination &&
      previous.accountKey === accountKey
        ? previous.observation
        : undefined;
    cache.set(
      capture.facts.providerId,
      Object.freeze({
        bindingIdentity: identity,
        accountKey,
        destinationKey: destination,
        ...(observation === undefined ? {} : { observation }),
        unavailable: Object.freeze({ bindingIdentity: identity, reason }),
      }),
    );
  };

  const startRefresh = (
    providerId: string,
    probe: ProviderUsageProbe,
    capture: ProviderAuthBindingCapture,
  ): Promise<ProviderUsageRefreshResult> => {
    if (closed || lifecycleAbort.signal.aborted) {
      return Promise.resolve(unavailableRefresh(providerId));
    }
    const baseUrls = servedBaseUrls(providerId);
    if (baseUrls.length === 0) {
      return Promise.resolve(Object.freeze({
        providerId,
        outcome: "unsupported",
        reason: "destination",
      }));
    }
    let eligibility: ProviderUsageEligibility;
    try {
      eligibility = eligibilityFor(providerId, probe, capture, baseUrls);
    } catch {
      return Promise.resolve(Object.freeze({
        providerId,
        outcome: "unavailable",
        reason: "upstream",
      }));
    }
    if (eligibility.state === "unsupported_binding") {
      return Promise.resolve(Object.freeze({
        providerId,
        outcome: "unsupported",
        reason: "binding",
      }));
    }
    if (eligibility.state === "unsupported_destination") {
      return Promise.resolve(Object.freeze({
        providerId,
        outcome: "unsupported",
        reason: "destination",
      }));
    }

    const destination = destinationKey(baseUrls);
    const current = cache.get(providerId);
    if (
      capture.facts.kind === "external" &&
      current?.destinationKey === destination &&
      current.unavailable?.bindingIdentity === bindingIdentity(capture) &&
      current.unavailable.reason === "terminal"
    ) {
      // Documented terminal evidence stops automatic network attempts for
      // this exact credential revision; a changed revision retries.
      return Promise.resolve(
        Object.freeze({
          providerId,
          outcome: "unavailable" as const,
          reason: "terminal" as const,
        }),
      );
    }
    const key = inflightIdentity(capture, destination);
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;

    const pending = (async (): Promise<ProviderUsageRefreshResult> => {
      // The bounded deadline is the authority's own failure class; a lifecycle
      // abort only ends the run.
      const timeoutSignal = AbortSignal.timeout(resolveRefreshTimeoutMs());
      const signal = AbortSignal.any([timeoutSignal, lifecycleAbort.signal]);
      const fail = async (reason: ProviderUsageUnavailableReason): Promise<ProviderUsageRefreshResult> => {
        if (capture.facts.kind === "external") {
          let committed = false;
          const current = await options.binding.publishIfCurrent(capture, (assertCurrent) => {
            if (closed || destinationKey(servedBaseUrls(providerId)) !== destination) return;
            assertCurrent();
            recordUnavailable(capture, destination, reason);
            committed = true;
          });
          if (!current || !committed) return Object.freeze({ providerId, outcome: "superseded" });
        }
        return Object.freeze({ providerId, outcome: "unavailable", reason });
      };
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
          return timeoutSignal.aborted ? fail("timeout") : unavailableRefresh(providerId);
        }
        return fail(classifyBindingFailure(capture, error));
      }

      if (acquired.state === "unsupported_destination") {
        return Object.freeze({
          providerId,
          outcome: "unsupported",
          reason: "destination",
        });
      }
      if (acquired.state === "unavailable") {
        return fail(classifyProbeFailure(capture, acquired.reason));
      }
      const facts = normalizeProviderUsageFacts(acquired.facts);
      if (facts === undefined) {
        return fail("schema");
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
          accountKey: bindingAccountKey(capture),
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

  const waitForRefresh = (
    pending: Promise<ProviderUsageRefreshResult>,
    providerId: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderUsageRefreshResult> => {
    if (signal === undefined) return pending;
    if (signal.aborted) {
      return Promise.resolve(unavailableRefresh(providerId));
    }
    return new Promise<ProviderUsageRefreshResult>((resolve) => {
      let settled = false;
      const finish = (value: ProviderUsageRefreshResult): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish(unavailableRefresh(providerId));
      signal.addEventListener("abort", onAbort, { once: true });
      void pending.then(
        (value) => finish(value),
        () => finish(unavailableRefresh(providerId)),
      );
    });
  };

  const observePassive = async (
    providerId: string,
    capture: ProviderAuthBindingCapture,
    observedBaseUrl: string,
    rawFacts: Parameters<ProviderUsageAuthority["observePassive"]>[3],
  ): Promise<boolean> => {
    if (closed) return false;
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
      if (closed) return;
      if (destinationKey(servedBaseUrls(providerId)) !== destination) return;
      cache.set(
        providerId,
        Object.freeze({
          bindingIdentity: bindingIdentity(capture),
          accountKey: bindingAccountKey(capture),
          destinationKey: destination,
          observation,
        }),
      );
      committed = true;
    });
    return current && committed;
  };

  const refresh = async (providerId: string, signal?: AbortSignal) => {
    if (closed) {
      return Object.freeze({
        snapshot: await query(),
        refresh: unavailableRefresh(providerId),
      });
    }
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
        refreshResult = await waitForRefresh(
          startRefresh(providerId, probe, capture),
          providerId,
          signal,
        );
      }
    }
    return Object.freeze({
      snapshot: await query(),
      refresh: refreshResult!,
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
