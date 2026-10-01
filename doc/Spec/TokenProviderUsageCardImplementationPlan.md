# Token Provider Usage Card Implementation Plan v0.6

**Status:** IMPLEMENTED — CANONICAL DESTINATIONS AND CONFIGURABLE AUTOMATIC REFRESH

**Date:** 2026-09-29

**Source research:** [Provider Quota Acquisition Inventory](../Research/ProviderQuotaAcquisitionInventory.md)

**Related specifications:**

- [Token Electron Product Architecture Specification](./TokenElectronArchitectureSpec.md)
- [Token Provider Credential Profiles Implementation Plan](./TokenProviderCredentialProfilesImplementationPlan.md)
- [Repository architecture rules](../../AGENTS.md)

**Implementation certification (2026-09-29):**

Pre-hardening v0.3 baseline:

- `npm run typecheck` — passed;
- `npm run lint` — passed;
- `npm run test:release` — passed;
- release certification: 73/73 passed;
- root Vitest under release concurrency: 277 files / 2487 tests passed;
- Desktop Vitest: 21 files / 122 tests passed.

Post-review v0.4 validation:

- `npm run lint` — passed;
- Application Control Plane build — passed;
- Provider Usage focused suite: 7 files / 74 tests passed;
- Desktop Vitest: 21 files / 125 tests passed.

Self-review v0.5 validation:

- root `tsc --noEmit` — passed;
- Application Control Plane and Desktop typecheck — passed;
- Provider Usage / Anthropic Native focused suite: 8 files / 99 tests passed;
- Desktop Vitest: 21 files / 127 tests passed;
- targeted ESLint on all v0.5 touched files — passed;
- full repository lint is currently blocked only by unrelated concurrent edits in `responses-native-provider-pi-parity.test.ts`.

Destination correction (2026-09-29): The bundled Goat Provider serves Anthropic models at `/provider` and OpenAI models at `/provider/v1`. Pi's OpenCode Go and OpenRouter built-ins also serve models through two canonical paths each. Active usage checks every served model destination against its own probe's accepted paths and keeps the complete destination set in the cache/in-flight identity. A non-canonical member still rejects refresh before auth. Passive publication remains restricted to one unambiguous served destination. The focused Provider Usage suite passed 78/78 tests, desktop Provider-card tests passed 32/32, and root/Desktop typecheck and targeted ESLint passed.

Automatic refresh amendment (2026-09-29): The v0.5 references below to “first release,” explicit-only refresh, and no background refresh describe the historical first release. The current application adds a Backend-owned automatic refresh timer for eligible Providers, defaulting to 15 minutes. `providerUsage.refreshIntervalMinutes` is a hot-applied integer setting from 1 to 1440 minutes in General settings. `providerUsage.refreshTimeoutSeconds` is a hot-applied integer setting from 5 to 600 seconds, defaults to 45 seconds, and must remain below the automatic refresh interval in seconds. The timer starts after Backend startup, refreshes eligible Providers immediately, then repeats after each configured interval, limits each cycle to three concurrent Provider refreshes, skips unsupported and passive-only Providers, and stops on Backend shutdown. The Providers page reads Backend cache every 30 seconds while mounted, without causing an upstream quota request. Double-clicking a refreshable card's usage area (or pressing Enter or Space while it is focused) requests a manual per-Provider refresh. Goat's existing card metrics and labels are unchanged. Empty or malformed Goat, Private, and OpenCode Go quota payloads are unavailable/schema rather than an authoritative empty observation, retaining valid same-binding last-good data. Provider Usage Authority owns the lifecycle of shared in-flight refreshes; a Control Plane waiter signal only releases that waiter and never becomes the shared refresh's cancellation owner. Application shutdown closes Provider Usage before waiting for automatic refresh and the Control Plane.

v0.6 validation: focused root tests 73/73, Desktop tests 129/129, certification tests 74/74, root/Desktop typecheck, targeted ESLint, and Windows `npm run build` succeeded with version 1.3.2. The full release Vitest run had two CLI process startup timeouts under parallel load; the settings contract failure it also exposed was corrected and its focused test passed. Full repository lint remains blocked by three pre-existing unused-variable errors in `responses-native-provider-pi-parity.test.ts`.

---

# 1. Conclusion

Implement Provider quota, credit, and balance display as a new independent **Provider Usage** vertical module.

```text
Provider-specific acquisition
          │
          ▼
 ProviderUsageObservation
          │
          ▼
 ProviderUsageAuthority
          │
          ▼
 Application Control Plane
          │
          ▼
 Provider Card Presentation
          │
          ▼
     Provider Card UI
```

The fixed architecture rules are:

1. Every supported Provider owns its own acquisition implementation.
2. Acquisition returns normalized structured facts, never final card text.
3. Provider cards know nothing about quota endpoints, Authorization rules, OAuth details, upstream JSON, or credential payloads.
4. The central Authority may bind `providerId` to probes, cache results, de-duplicate in-flight work, and contain failures. It must not contain Provider endpoint or response-schema policy.
5. Managed observations are bound to the exact captured credential identity and generation. An old Profile result must never publish as the new active Profile's usage.
6. `commandcode-goat` and `commandcode-private` are completely separate Provider implementations. They do not share a probe, credential binding, Provider identity, cache entry, observation, Provider-specific parser, or tests.
7. Unsupported Providers perform no quota network request and receive no fabricated quota.
8. First release is explicit-refresh only. Opening the Providers page reads Backend cache only and does not trigger upstream quota calls or OAuth refresh.
9. Provider Usage never enters Pi AI IR and never changes request routing, request execution, Catalog state, or credential state.

This plan supersedes only the research document's provisional `ProviderQuotaObservation.text` proposal. The research document remains the evidence source for endpoint, credential, wire-shape, and normalization rules.

---

# 2. Goals

## 2.1 Product goal

Display verified Provider account usage on each Provider card when the Provider exposes reliable information:

- 5-hour usage and reset;
- weekly usage and reset;
- monthly usage and reset;
- Provider-defined custom windows;
- credits used / remaining / limit;
- account balance;
- reset-credit counts where available.

Examples of presentation output:

```text
5h 53% · Week 60%
48.8 credits remaining
```

or:

```text
Balance $42.50
```

The probe never produces those strings.

## 2.2 Architecture goal

Keep ownership separate:

```text
Credential ownership       Usage acquisition          Usage presentation
---------------------      --------------------       ------------------
Profile State Owner        Provider-specific probes   Card projector
Models.getAuth()            ProviderUsageAuthority     React UI
binding generations         normalized facts           labels/formatting
```

## 2.3 Correctness goal

A displayed observation must belong to the exact Provider and credential identity that produced it.

Example:

```text
OpenRouter Profile A → 90%
switch active Profile
OpenRouter Profile B → 12%
```

A late probe for A must never overwrite or appear as B.

---

# 3. Non-goals

The first implementation does not:

- modify Pi or `pi-agent/`;
- add quota fields to Pi AI IR;
- make quota affect routing or automatic failover;
- reject model requests because a displayed quota is exhausted;
- merge usage into Catalog state;
- merge usage into Credential Profile state;
- reuse `packages/provider-contract/src/usage.ts` terminal token usage;
- persist quota observations across Backend restarts;
- poll quota endpoints while the page is idle;
- trigger interactive login;
- guess a generic quota endpoint for arbitrary `models.json` Providers;
- extend the user Provider Package contract;
- expose raw credentials, auth headers, raw upstream bodies, raw upstream errors, or token claims to the Control Plane or renderer.

Quota-aware routing, historical quota storage, alerts, charts, and Provider Package quota capabilities are future work.

---

# 4. Confirmed current baseline

The plan is based on the current repository implementation:

1. `src/providers/runtime.ts` owns the Backend-lifetime Provider Runtime and exposes served Pi `Models` plus the Provider credential binding authority.
2. `ProviderAuthBindingCapture` already carries managed `providerId`, `credentialId`, `credentialGeneration`, and `selectionGeneration`, or an ambient Provider binding.
3. `ProviderAuthBindingAuthority.runBound()` is the existing seam for resolving auth under one exact captured Provider binding.
4. `ProvidersPage.tsx` currently composes independent Credential Profile, Catalog, and Public Model facts into each Provider card.
5. Catalog owns model discovery, refresh, and model availability.
6. Credential Profiles own account/Profile lifecycle, active selection, health, and 429 switch policy.
7. `packages/provider-contract/src/usage.ts` describes per-request terminal token counts, not account quota or balance.
8. Electron management goes through the versioned Application Control Plane.
9. The current Control Plane version is `5`.
10. Pi `Models.getAuth(providerId, { signal })` accepts an abort signal, so one Provider Usage refresh signal can cover OAuth refresh and the subsequent quota acquisition.
11. `models.json` can overlay a Pi built-in Provider's effective `baseUrl`; therefore `providerId` alone does not prove that a credential is safe to send to that Provider's canonical quota endpoint.
12. Pi's public `StreamOptions.onResponse` exposes HTTP status/headers, which is sufficient for Anthropic API-key passive rate-limit observation. The current OpenAI Responses stream processor does not expose unknown SSE events such as Meta `response.subscription_usage` to Token.
13. The research inventory proves reliable acquisition methods for only a subset of Providers; the remaining Providers must stay unsupported.

Provider Usage therefore becomes a fourth independent card input:

```text
Credential Profiles → authentication/account state
Catalog             → model availability
Public Models       → publish/favorite state
Provider Usage      → quota/credits/balance
```

---

# 5. Target module architecture

## 5.1 Backend acquisition

Proposed files:

```text
src/provider-usage/
  contract.ts
  authority.ts
  wire.ts
  probes/
    commandcode-goat.ts
    commandcode-private.ts
    opencode-go.ts
    kimi-coding.ts
    deepseek.ts
    openrouter.ts
    minimax.ts
    minimax-cn.ts
    moonshotai.ts
    moonshotai-cn.ts
    zai.ts
    zai-coding-cn.ts
    anthropic.ts
    xai.ts
    openai-codex.ts
    meta.ts
```

`wire.ts` may contain Provider-neutral mechanics only:

- bounded response reading that honors a caller-owned abort signal;
- finite-number parsing;
- percentage clamp;
- timestamp normalization;
- safe failure-code helpers where the failure is Provider-neutral.

The Authority owns the one refresh lifecycle timeout/AbortSignal. Shared wire helpers and ordinary probes do not start independent timers. A Provider-specific multi-stage protocol may derive a narrower child deadline only when that protocol requires it, and it must remain subordinate to the Authority signal.

It must not contain endpoint selection or a `providerId` switch.

## 5.2 Provider Usage Authority

`ProviderUsageAuthority` owns:

- fixed `providerId -> probe` registration;
- Provider-level unsupported detection when no exact probe is registered;
- exact credential-binding capture;
- construction of the secret-free eligibility context;
- delegation of binding/destination eligibility to the exact Provider probe;
- one current in-memory cache slot per Provider;
- in-flight identity/de-duplication;
- the one refresh timeout/AbortSignal;
- failure containment;
- current-binding guarded query/publication;
- sanitized query/refresh results.

It does not own:

- endpoint URLs;
- Authorization schemes;
- Provider-specific headers;
- query parameters;
- upstream response schemas;
- Provider normalization rules;
- display strings.

## 5.3 Presentation

Add a pure presentation module under the desktop Provider UI:

```text
packages/desktop-shell/src/renderer/providers/
  provider-usage-presentation.ts
  ProvidersPage.tsx
```

The presentation module owns all user-facing labels and formatting. It receives only normalized Control Plane data.

---

# 6. Normalized semantic contract

The contract must be structured enough to separate acquisition from presentation, but no wider than verified product needs.

Do not use:

```ts
{ text: "5h 53% · Week 60%" }
```

Do not carry raw Provider JSON or an untyped `metadata` bag.

Target normalized facts:

```ts
export interface ProviderUsageModelScope {
  readonly kind: "model";
  readonly modelLabel: string; // bounded source model identity, not UI prose
}

export type ProviderUsageWindow =
  | {
      readonly kind: "five_hour" | "weekly" | "monthly";
      readonly usedPercent: number; // normalized 0..100
      readonly resetAt?: number;    // valid positive epoch ms
      readonly scope?: ProviderUsageModelScope;
    }
  | {
      readonly kind: "custom";
      readonly usedPercent: number;
      readonly resetAt?: number;
      readonly durationMinutes?: number; // only when structurally declared upstream
      readonly scope?: ProviderUsageModelScope;
    };

export type ProviderUsageBudget =
  | {
      readonly kind: "credits";
      readonly remaining: number;
      readonly used?: number;
      readonly limit?: number;
      readonly expiresAt?: number;
      readonly currency?: string; // present only for verified monetary credit pools
    }
  | {
      readonly kind: "balance";
      readonly amount: number;
      readonly currency: string; // bounded ISO/provider currency code from verified source
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
  readonly providerId: string; // added by Authority
  readonly observedAt: number; // added by Authority at successful publication
}
```

Contract rules:

- probe implementations return `ProviderUsageFacts`; they do not declare `providerId` or `observedAt`;
- omit fields with no verified source;
- never encode unknown usage as `0%`;
- balance-only Providers produce `{ kind: "balance", amount, currency }`, not a fake usage window and not a synthetic `remaining`;
- invalid, zero, or negative reset timestamps are omitted;
- percentages are normalized to `0..100`;
- an arbitrary Provider string never becomes presentation text through the common contract;
- a custom duration is carried structurally as `durationMinutes`;
- Anthropic/model-scoped facts may carry a bounded source `modelLabel` only after structural scope recognition;
- raw upstream objects do not survive normalization;
- `{ windows: [], budgets: [] }` is a valid **authoritative empty success**. It clears an older bar/budget for the same current binding when a successful upstream response proves the prior fact no longer exists, for example an OpenRouter key that is now uncapped;
- if a new stable semantic is genuinely required later, widen the typed contract explicitly rather than adding a generic bag or display label.

Provider query state:

```ts
export type ProviderUsageUnsupportedReason =
  | "provider"
  | "binding"
  | "destination";

export type ProviderUsageUnavailableReason =
  | "auth"
  | "network"
  | "upstream"
  | "schema";

export type ProviderUsageState =
  | {
      readonly state: "observed";
      readonly observation: ProviderUsageObservation;
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
```

Meaning:

- `unobserved`: the current Provider/binding/destination is eligible, but this Backend lifetime has no successful observation for it yet;
- `observed`: last successful observation for the current binding;
- `unsupported/provider`: no verified probe exists;
- `unsupported/binding`: a probe exists, but the current binding kind/auth type has no verified active acquisition path;
- `unsupported/destination`: the effective Provider destination is not the canonical/accepted destination required by that probe, so auth resolution and network are skipped;
- `unavailable`: an eligible refresh failed and no usable current-binding observation exists.

A failed refresh does not erase an already successful current-binding observation. The refresh result reports the failure separately; the old observation remains visibly timestamped by its original `observedAt`. An authoritative empty success does replace the old observation with empty facts.

---

# 7. Probe interface and Provider isolation

The probe seam has two stages: **eligibility before auth resolution**, then acquisition.

```ts
export type ProviderUsageBindingContext =
  | {
      readonly kind: "managed";
      readonly authType: "api_key" | "oauth";
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
  eligibility(
    context: ProviderUsageEligibilityContext,
  ): ProviderUsageEligibility;
  acquire(
    input: ProviderUsageProbeInput,
  ): Promise<ProviderUsageProbeResult>;
}
```

The eligibility context is narrow and secret-free. `effectiveBaseUrl` is the currently served effective Provider destination, after the existing `models.json` overlay semantics. It is inspected **before** `Models.getAuth()`.

This prevents two unsafe cases:

- a built-in Provider ID overlaid to a third-party proxy must not cause that proxy credential to be sent to the official quota host;
- a Provider probe must not follow an arbitrary overlaid base URL with a credential intended for the canonical Provider quota API.

Each probe decides which binding/auth types and destinations it has verified. Examples:

- Anthropic active usage: managed OAuth is eligible; API-key active refresh is unsupported;
- xAI active usage: only the verified OAuth path is eligible;
- OpenRouter: verified API-key path is eligible; OAuth remains unsupported until proven;
- a built-in whose effective destination no longer matches the probe's accepted canonical destination returns `unsupported_destination`.

Ambient auth is not assumed to be API-key or OAuth. A probe may accept ambient only when that Provider's ambient acquisition semantics are explicitly verified; otherwise it returns `unsupported_binding` without resolving auth.

Construction may inject `fetch` and a narrow Provider-owned identity reader for testability. Those remain implementation dependencies.

The Authority guarantees:

1. a probe is invoked only for its own Provider ID;
2. eligibility runs before auth resolution and performs no network;
3. unsupported binding/destination performs no `Models.getAuth()` and no quota request;
4. eligible acquisition runs under the exact captured Provider auth binding;
5. the Authority passes its one refresh `AbortSignal` to both `Models.getAuth(providerId, { signal })` and `probe.acquire({ auth, signal })`;
6. `AuthResult` never leaves the Backend;
7. expected Provider acquisition failures are returned by the probe as typed `unavailable(reason)`, not inferred by the Authority from arbitrary error text;
8. the Authority adds `providerId` and `observedAt` only when a successful result is published as current;
9. publication happens only while the capture is still current.

Auth-resolution failures are classified by the Authority at the operation it owns: an unsuccessful/throwing `Models.getAuth()` becomes safe `auth` unavailability unless the shared signal was aborted. Probe implementations own network/upstream/schema classification for their own Provider wire.

The probe owns all Provider-specific wire behavior.

## 7.1 CommandCode isolation

`commandcode-goat` and `commandcode-private` each get:

- their own module;
- their own probe instance;
- their own Provider ID;
- their own canonical-destination validation;
- their own credential capture;
- their own in-flight identity;
- their own cache entry;
- their own parser implementation;
- their own unit/integration tests.

They may share only Provider-neutral helpers from `wire.ts`.

Do not introduce a shared "CommandCode quota probe" or a shared Provider-specific parser. Controlled local duplication is preferred because these are separate product Providers with separate credentials and observations.

## 7.2 Unsupported Providers

No placeholder probe is required.

If no exact probe is registered:

```text
state = unsupported
auth resolution = none
network = none
```

This also applies to arbitrary `models.json` Providers and user Provider Packages in the first release.

---

# 8. Credential binding, cache identity, and races

## 8.1 Managed Profile identity

A managed observation belongs to:

```text
providerId
+ credentialId
+ credentialGeneration
```

`selectionGeneration` is additionally used as the active-selection publication guard.

Refresh flow:

```text
capture(providerId)
      ↓
derive exact binding identity
      ↓
read effective Provider destination
      ↓
probe eligibility(binding + destination)
      ↓
eligible only:
join/create in-flight work for that exact binding + effective-destination identity
      ↓
runBound(capture, same Authority signal)
      ↓
Models.getAuth(providerId, { signal })
      ↓
probe.acquire({ auth, signal })
      ↓
Provider-owned normalization / typed result
      ↓
publishIfCurrent(capture)
      ↓
replace this Provider's current slot
```

If the active Profile switches, reconnects, is removed, or changes generation before completion, the old result is discarded.

## 8.2 Ambient auth

Ambient observations are Provider-scoped and valid only while the Provider continues to resolve through ambient auth.

If managed Profiles appear, the previous ambient observation is no longer current and must not be projected for the managed active Profile.

No raw ambient credential is used as a renderer-visible identity.

## 8.3 Current-binding query correctness

Generation guarding is required for **query as well as refresh**.

A cache lookup must never be `providerId -> observation` without a current-binding check. Otherwise Profile A usage can remain visible after Profile B becomes active.

For each supported Provider, cache-only query performs:

```text
capture current binding
      ↓
derive binding identity
      ↓
read Provider cache slot only if identity matches
      ↓
publishIfCurrent(capture, project result)
      ↓
if guard failed: retry capture/query once
      ↓
if still unstable: return unobserved
```

The retry is bounded to one retry. Query performs no `Models.getAuth()` and no quota network.

This closes both races:

```text
cache A
capture A
switch to B
attempt to return A
→ publishIfCurrent rejects
→ retry against B or return unobserved
```

and:

```text
cache A exists
B already active
query
→ B identity does not match A cache slot
→ unobserved for B
```

## 8.4 Cache policy

First release uses one Backend-memory **current slot per Provider**:

```ts
providerId -> {
  bindingIdentity,
  destinationKey,
  observation
}
```

The Authority does not retain an unbounded history of credential generations. In-flight work uses the complete binding identity **plus the sorted set of served model destinations** as its key, so a destination change cannot join an older request. Only the current Provider slot is retained after publication.

There is no acquisition TTL in the first release because:

- `query` never refreshes;
- `refresh(providerId)` always means explicit refresh;
- no background refresh policy exists yet.

The Authority stores `observedAt`; presentation may show age/staleness. A TTL can be introduced later when a real background/conditional refresh policy needs one.

Important behavior:

- successful observed facts replace the current slot;
- passive observations also replace the whole current slot; partial passive merging is not allowed while the contract has only one observation-level `observedAt`, because carrying forward an absent old fact would falsely refresh its age;
- an authoritative empty success replaces the current slot only when the Provider response positively proves the prior fact no longer exists; missing or malformed expected rows are `unavailable/schema`, not empty success;
- OpenRouter explicit uncapped state and Z.AI well-formed inference-empty limits are examples of authoritative empty; missing MiniMax `general` rows and missing DeepSeek balance rows are not;
- failed refresh does not erase a valid last-success observation for the same current binding;
- when no same-binding success exists, the refresh response may report `unavailable`, but the Authority does not retain a separate unbounded failure history; a later cache-only query may return `unobserved`;
- a different binding never reuses the previous slot;
- a changed effective Provider destination never reuses the previous slot, even if the credential binding is unchanged;
- Backend restart clears Provider Usage cache.

No new durable file format is introduced.

---

# 9. Auth policy

The complete active-refresh sequence is:

```text
capture Provider binding
      ↓
derive effective Provider destination from served Models:
  1. collect distinct non-empty served model baseUrls;
  2. check each served model destination with the exact Provider probe;
  3. any rejected destination → unsupported/destination before auth;
  4. no model destination → check Provider baseUrl
      ↓
probe.eligibility({
  providerId,
  effectiveBaseUrl,
  binding kind/auth type
})
      ↓
unsupported? return without auth/network
      ↓
runBound(capture, async () => {
  auth = models.getAuth(providerId, { signal })
  if auth.auth.baseUrl exists:
    re-check probe eligibility against that credential-scoped destination
  probe.acquire({ auth, signal })
})
      ↓
publishIfCurrent(capture)
```

Eligibility is intentionally before `Models.getAuth()`: an unsupported auth type or unsafe destination must not trigger OAuth refresh and must not expose a credential to a quota endpoint. Provider-level `baseUrl` must never override a conflicting served model-level destination for this safety decision. Multiple served model destinations are accepted only when the exact Provider probe independently accepts every one. Goat's `/provider` and `/provider/v1` are both canonical; a proxy or unverified path is rejected.

Pi auth may additionally return a credential-scoped `auth.baseUrl` that overrides the request model at execution time. After auth resolution, but still before quota network acquisition, the Authority must re-run destination eligibility against that override when present. A non-canonical credential-scoped destination returns `unsupported/destination` and the probe is not invoked.

The probe owns how `AuthResult` maps to the quota request. The Authority must not assume Bearer auth.

Because `Models.getAuth()` may perform non-interactive OAuth refresh:

- page open does not resolve auth;
- cached query does not resolve auth;
- explicit usage refresh may resolve/refresh auth;
- Provider Usage never starts interactive login.

Some Providers require facts not present in generic `AuthResult`:

- `openai-codex`: ChatGPT account ID;
- `xai`: user ID when it cannot be safely derived from the access token;
- `meta`: Muse identity token for proactive acquisition.

For these, use the narrowest Provider-owned solution:

1. strictly derive from the already resolved token when verified;
2. otherwise expose one narrow Provider-owned fact reader;
3. never expose the complete credential record to the generic Authority;
4. never expose refresh/identity tokens to Control Plane or renderer.

---

# 10. Active and passive acquisition

## 10.1 Active probes

First implementation focuses on explicit active probes with verified endpoints and credentials.

Each active probe:

- validates canonical destination when required;
- constructs exact Provider headers/query;
- uses bounded body reading;
- strictly validates response schema;
- normalizes to the common observation;
- fails rather than guesses.

## 10.2 Passive observations

Passive acquisition is split by actual observability in the current source baseline.

### Anthropic API-key passive observation — implemented

Pi's public `StreamOptions.onResponse` exposes HTTP response status/headers, and the Anthropic Messages adapter invokes it before consuming the body. Token's semantic execution has a fail-open Provider response observation seam. Anthropic Provider Native also owns exact Profile capture plus upstream HTTP status/headers, so it feeds the same neutral response-observation callback.

Therefore Anthropic API-key rate-limit headers are observed in both Semantic Conversion and Anthropic Provider Native without modifying Pi or coupling either lane to Provider Usage internals.

The Authority accepts already-normalized facts through:

```ts
observePassive(
  providerId: string,
  capture: ProviderAuthBindingCapture,
  effectiveBaseUrl: string,
  facts: ProviderUsageFacts,
): Promise<boolean>
```

Passive publication uses the same current-binding/generation checks as active acquisition and is additionally accepted only when the **actual request Model destination** equals the Provider's current unambiguous served destination. Pi's public `onResponse(response, model)` second argument supplies the resolved request Model in Semantic Conversion; Anthropic Provider Native passes its resolved `requestModel`. A mixed/moved destination therefore cannot publish or display a stale/incorrect Anthropic observation. Observation failure is fail-open and never affects request success.

A passive-only observation may be displayed even though the current binding has no proactive refresh path. The Control Plane therefore carries an observed-state `refreshable: boolean`; Anthropic API-key passive observations render normally with `refreshable: false`.

Because Provider Usage is intentionally not part of `StatusSnapshot`, a successful Request Journey with a Provider/Profile attribution triggers a **cache-only** Provider Usage `query` in the Providers page. The Renderer applies only that Provider's row under its existing local epoch guard. This makes newly observed passive usage visible without any automatic quota/OAuth network request.

### Meta `response.subscription_usage` — gated/deferred

The current Meta semantic path uses Pi's OpenAI Responses adapter. The current `processResponsesStream()` consumes recognized Responses events and does not expose arbitrary/unknown SSE events to Token. `onResponse` exposes HTTP metadata only, not stream body events.

Therefore Meta `response.subscription_usage` is **not an implementable passive source under the current public Pi seam**.

Do not implement it unless one of these becomes true:

1. an accepted Pi public observation seam exposes the event;
2. an upgraded pinned Pi version exposes it;
3. a separately justified Native lane that already owns the raw SSE can observe it without coupling Semantic Conversion to Native implementation.

Until then Meta passive usage remains deferred. This plan does not modify or fork Pi to obtain it.

---

# 11. Control Plane design

Add a dedicated command family and define every Provider Usage wire projection explicitly:

```ts
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

export type ProviderUsageCommand =
  | { readonly command: "query" }
  | {
      readonly command: "refresh";
      readonly providerId: string;
    };

export interface ProviderUsageSnapshotProjection {
  readonly providers: readonly ProviderUsageProviderProjection[];
}

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
```

These projections mirror only the bounded normalized semantics in section 6. They do not carry Backend binding identities or Provider wire fields. Currency/model strings are bounded and validated by the wire decoder.

Do not add Provider Usage fields to Catalog or Credential Profile DTOs.

Because this adds a new request/result command family, increment:

```text
controlPlaneVersion: 5 → 6
```

Do not add a v5 compatibility shim unless a separate compatibility requirement is approved.

Keep the new semantic/wire implementation out of the already large generic files:

```text
packages/application-control-plane/src/provider-usage-contract.ts
packages/application-control-plane/src/wire-provider-usage.ts
packages/application-control-plane/src/client.ts
packages/application-control-plane/src/application-status-host.ts
packages/application-control-plane/src/control-plane.ts
```

`contracts.ts` and `wire.ts` receive only the minimum integration needed by the global Control Plane version/frame union if required. `control-plane.ts` re-exports the Provider Usage public contract, following the existing split-module pattern used by other Control Plane domains.

Provider Usage does not need to be merged into continuously published `StatusSnapshot` in the first release. It remains an explicit query/refresh surface.

---

# 12. Backend composition

Create the Authority after `providerRuntime` exists.

Conceptually:

```ts
const providerUsage = createProviderUsageAuthority({
  models: providerRuntime.models,
  binding: providerRuntime.providerAuthBindings,
  probes: createBuiltInProviderUsageProbes(...),
  fetch: globalThis.fetch,
  now: Date.now,
  refreshTimeoutMs: PROVIDER_USAGE_REFRESH_TIMEOUT_MS,
});
```

The Authority creates the single timeout/AbortSignal for each shared refresh. It resolves `providerUsage.refreshTimeoutSeconds` at refresh start so changes apply to the next refresh without restarting the Backend. That signal covers auth resolution and all probe network work, and the Authority's own lifecycle controls cancellation for all joined callers. A caller-owned signal may stop that caller waiting, but it does not cancel shared work.

`src/application.ts` exposes only two operations to the Control Plane:

```text
query   → providerUsage.query()
refresh → providerUsage.refresh(providerId)
```

Provider Usage startup/runtime failure must not prevent:

- Backend startup;
- Data Plane startup;
- Catalog;
- login;
- Provider requests;
- other Control Plane commands.

---

# 13. Desktop and Provider card behavior

Add one independent IPC path following the existing direction:

```text
ProvidersPage
  ↓
preload Desktop API
  ↓
Electron Main IPC
  ↓
Control Plane client
  ↓
Provider Usage command
```

Expected files:

```text
packages/desktop-shell/src/shared/desktop-api.ts
packages/desktop-shell/src/shared/ipc-channels.ts
packages/desktop-shell/src/preload/preload.ts
packages/desktop-shell/src/main/desktop-ipc.ts
packages/desktop-shell/src/renderer/providers/provider-usage-presentation.ts
packages/desktop-shell/src/renderer/providers/ProvidersPage.tsx
packages/desktop-shell/src/renderer/renderer.css
```

## 13.1 Page open and binding changes

On page load:

1. query Credential Profiles;
2. query Catalog;
3. query Public Models;
4. query Provider Usage cache;
5. perform no quota network request.

A supported Provider without data shows a restrained "Usage not refreshed" state.

Renderer correctness requires one additional rule because Provider Usage is intentionally not part of `StatusSnapshot`.

For each Provider, derive a renderer-local binding key from the already projected Credential Profile state, including at least:

```text
revision
selectionGeneration
activeCredentialId
managed-vs-ambient state
```

Whenever a Profile command result or Backend credential-status publication changes that key:

1. immediately remove that Provider's currently displayed Usage;
2. increment a renderer-local per-Provider Usage epoch;
3. issue one cache-only Provider Usage `query`;
4. apply the returned Provider row only if the local epoch still matches.

This covers explicit activate/reconnect/remove/add-with-`useNow` and automatic HTTP-429 Profile switching.

Every asynchronous Usage query **and refresh result** is epoch-guarded in the renderer. A stale response started before a binding change is discarded even if it arrives after the new Profile state.

The Backend query guard in section 8.3 remains authoritative; the renderer epoch is a second, UI-local protection against retaining a previously rendered observation while Profile state changes between Control Plane calls.

## 13.2 Refresh

Do not change the current Catalog Refresh button into a quota fan-out.

First release uses a per-card usage refresh action:

- refreshes exactly one Provider;
- only that card becomes busy;
- other cards remain usable;
- one Provider failure does not block another;
- cached last-good data remains visible if refresh fails.

A future explicit "Refresh all usage" action may be added later with bounded concurrency.

## 13.3 Presentation projector

Example:

```ts
export interface ProviderCardUsagePresentation {
  readonly primary: readonly string[];
  readonly secondary: readonly string[];
  readonly status?: string;
}

export function projectProviderCardUsage(
  provider: ProviderUsageProviderProjection,
  now: number,
): ProviderCardUsagePresentation;
```

This is the only module that owns text such as:

```text
5h 53%
Week 60%
Balance $42.50
48.8 credits remaining
resets in 2h 14m
```

An observed authoritative-empty fact set is distinct from `unobserved`: presentation may render no metric rows (or a bounded "No current limit reported" state), but it must not resurrect the previous bar and must not claim the Provider was never refreshed.

Probe tests never assert those strings. UI presentation tests never parse upstream Provider fixtures.

---

# 14. Provider implementation order

Use the research inventory as the evidence source.

## Phase A — architecture + first proven Provider

1. normalized contract;
2. Provider-neutral bounded wire helpers;
3. probe eligibility/security contract using binding kind/auth type plus effective Provider destination;
4. Provider Usage Authority with typed probe outcomes and one refresh signal;
5. refresh and cache-only query current-binding race guards;
6. Control Plane v6;
7. desktop binding invalidation/epoch plumbing;
8. presentation projector;
9. `commandcode-goat`.

Goat is first because the current project key was live-probed successfully against the required accounting routes.

## Phase B — API-key readers with established reference contracts

Implement independently:

- `opencode-go`;
- `kimi-coding`;
- `deepseek`;
- `openrouter`;
- `minimax`;
- `minimax-cn`;
- `moonshotai`;
- `moonshotai-cn`;
- `zai`;
- `zai-coding-cn`.

## Phase C — CommandCode Private

Implement `commandcode-private` as a separate probe and separate test suite.

The Goat live result is not evidence that a Private credential is authorized. Private must report its own actual result.

## Phase D — OAuth/narrow identity facts

Implement:

- `anthropic` OAuth active usage;
- `xai`;
- `openai-codex`.

Before Codex, settle the narrow ChatGPT account-ID acquisition seam.

## Phase E — passive acquisition

Implement:

- Anthropic API-key response-header observations through the existing Pi `onResponse`/Token fail-open response observation seam.

Do **not** schedule Meta `response.subscription_usage` as an implementation item under the current Pi contract. It remains gated/deferred until the observability condition in section 10.2 is satisfied.

Optional Meta proactive acquisition is also separate and may proceed only after the Muse identity-token seam is explicitly accepted and destination/auth safety is proven.

## Phase F — unsupported Providers

All remaining current built-ins stay `unsupported` until a Provider-specific acquisition contract is verified.

There is no generic fallback reader.

---

# 15. Probe implementation requirements

Every active Provider probe must own and test:

1. exact endpoint construction;
2. canonical destination validation where required;
3. exact Authorization scheme;
4. required Provider headers;
5. bounded response reading;
6. HTTP-status handling;
7. strict response-shape validation;
8. normalization;
9. reset-time validation;
10. percentage normalization;
11. omission of unavailable optional facts;
12. abort/timeout behavior;
13. safe failure classification;
14. absence of raw upstream error text in output.

When a required normalized fact cannot be constructed, fail rather than guess.

A partially usable response may publish its independently valid subset only when that Provider's verified contract supports such independence.

---

# 16. Failure semantics

Provider Usage is observational and fail-open with respect to Token execution.

A quota timeout, 401, 429, 5xx, DNS error, schema change, or pre-auth destination eligibility rejection must not modify:

- Provider login state;
- Catalog state;
- model availability;
- Public Models state;
- request routing;
- request credentials;
- request outcome;
- Data Plane lifecycle.

The UI receives fixed safe reason codes only.

Never expose:

- upstream response bodies;
- upstream error strings;
- Authorization values;
- token claims;
- Provider account IDs unless a separate sanitized product requirement is approved.

---

# 17. Test plan

## 17.1 Probe and shared wire tests

Every supported Provider receives Provider-owned tests for:

- eligible managed auth type;
- unsupported managed auth type where applicable;
- ambient eligibility/denial according to that Provider's verified contract;
- canonical effective destination;
- overlaid/non-canonical destination rejection before auth;
- success fixture;
- malformed Provider schema;
- missing auth after eligible resolution;
- authoritative empty success where the Provider can legitimately remove a prior limit;
- partial valid response where supported;
- Provider-specific headers/query/auth construction;
- Provider-specific normalization and omission of invalid optional facts;
- no credential leakage from typed results.

The shared Provider Usage wire layer is tested once, independently of Provider semantics, for:

- malformed JSON;
- oversized body;
- body-read failure;
- parent-signal timeout/abort and body cancellation;
- 401/403 → `auth`;
- 429/5xx → `upstream`;
- redirect rejection;
- invalid reset timestamps;
- out-of-range percentages.

In addition, every registered probe is run through a common HTTP-failure matrix (401/403/429/5xx, malformed JSON, oversized response, parent abort) to certify that each probe preserves the shared typed failure contract.

## 17.2 CommandCode separation

Explicitly prove:

- Goat cannot run under Private binding;
- Private cannot run under Goat binding;
- Goat cache cannot satisfy Private;
- Private cache cannot satisfy Goat;
- Goat credential changes do not invalidate/replace Private observations;
- identical wire payloads still produce separate Provider-owned observations.

## 17.3 Credential/query race matrix

Active Profile switch during refresh:

```text
capture A
start probe A
switch active to B
probe A completes
→ A result not published as current
```

Reconnect during refresh:

```text
capture credential generation G1
start probe
reconnect same credentialId → G2
G1 completes
→ G1 result discarded
```

Removal during refresh:

```text
capture managed Profile
start probe
remove Profile / transition to ambient
old probe completes
→ old managed result not projected as ambient/current
```

Stable refresh:

```text
capture unchanged binding
probe succeeds
→ exactly one observation committed
```

Profile switch before query:

```text
cache slot belongs to A
B becomes active
query
→ A slot identity does not match B
→ B returns unobserved
```

Profile switch during query:

```text
capture A
read A slot
B becomes active
publishIfCurrent(A) rejects
→ retry once against B or return unobserved
→ never return A as current
```

Renderer stale-query race:

```text
UI epoch 7 starts cache-only query for A
Profile state changes to B
UI clears Usage and advances epoch to 8
epoch-7 query returns
→ renderer discards it
→ epoch-8 cache-only query may populate only current B data
```

Renderer stale-refresh race follows the same epoch rule.

## 17.4 Authority tests

Prove:

- unsupported Provider performs zero auth and zero fetch;
- unsupported binding performs zero auth and zero fetch;
- unsupported/unsafe effective destination performs zero auth and zero fetch;
- eligibility sees the served effective `baseUrl`, not only `providerId`;
- served model destinations take precedence over Provider-level `baseUrl`, and every distinct model destination is checked before auth; one rejected destination rejects the refresh;
- an auth-resolved `baseUrl` override is checked again before probe network;
- `query` performs zero auth and zero fetch;
- `query` returns only a cache slot whose binding identity matches the current capture;
- query current-guard failure retries at most once and otherwise returns `unobserved`;
- concurrent same-binding, same-destination refreshes join one in-flight operation;
- a destination change never joins older in-flight work;
- query and refresh publication re-check the effective destination inside the final current-binding publication guard;
- different Providers never share in-flight work;
- different credential generations never share in-flight work;
- the Authority's one abort signal is passed to both `Models.getAuth(..., { signal })` and probe acquisition;
- expected probe failures arrive as typed reasons rather than Authority parsing exception text;
- failed refresh does not erase current-binding last-good data;
- authoritative empty success replaces/clears old current-binding facts;
- one throwing probe cannot fail other Providers;
- only one current cache slot per Provider is retained;
- cache remains Backend-memory only.

## 17.5 Control Plane tests

Prove:

- v6 handshake;
- strict Provider Usage command/result decoding;
- `ProviderUsageProviderProjection` is fully defined and decoded;
- malformed observations rejected;
- non-finite numbers rejected;
- invalid percentages do not cross the boundary;
- `modelLabel` and currency strings are bounded;
- unsupported reason and unavailable reason are separate closed sets;
- authoritative empty observed facts survive round-trip;
- no credential-bearing fields exist.

## 17.6 Desktop tests

Prove:

- page open calls `query` but not `refresh`;
- each card renders only its own observation;
- unsupported Providers display no invented percentage;
- balance-only Providers have no usage bar;
- refresh targets exactly one Provider;
- per-card busy state does not disable other Providers;
- failed refresh keeps same-binding last-good display;
- Profile revision/selection/active identity change clears that Provider's displayed Usage immediately;
- binding change triggers a cache-only Usage query, never an automatic refresh;
- stale Usage query results are rejected by renderer-local epoch;
- stale refresh results are rejected by renderer-local epoch;
- automatic 429 Profile switching follows the same invalidation path;
- a successful Provider Request Journey triggers only a cache-only Usage requery so passive observations become visible;
- post-auth `unsupported/binding|destination` refresh outcomes produce presentation-owned user feedback even when cache-only query cannot observe the auth-local reason;
- all display strings come from the projector.

## 17.7 Non-interference

Existing Catalog, Credential Profile, Public Models, Semantic Conversion, Provider Native, and Direct Mode tests must remain green.

Provider Usage modules must not be imported by Client Protocol conversion or Pi AI IR modules.

---

# 18. TDD implementation sequence

## Slice 1 — contract

Create normalized observation types and validators.

Acceptance:

- verified windows/budgets are representable;
- no display text;
- no raw Provider wire;
- no metadata bag.

## Slice 2 — Authority with fake probes

Implement registration, Provider/binding/destination eligibility, binding capture, one-slot-per-Provider memory cache, in-flight identity, one refresh AbortSignal, typed failure handling, current-binding query guard, and current-binding publication.

Acceptance: the complete refresh/query race matrix passes before any real Provider network implementation is added.

## Slice 3 — Control Plane v6

Add command/result wire, strict decoders, host handler, client method, and tests.

## Slice 4 — Desktop vertical path

Add IPC/preload method, Provider Usage page query, per-card refresh, binding-key invalidation, renderer-local Usage epochs, and presentation projector using fake Backend results.

## Slice 5 — CommandCode Goat

Implement the first real probe and certify:

```text
card refresh
→ Control Plane
→ ProviderUsageAuthority
→ Goat credential binding
→ Goat /alpha endpoints
→ normalized observation
→ Control Plane projection
→ card projector
```

## Slice 6 — Phase B API-key Providers

Add one Provider at a time with independent tests.

## Slice 7 — CommandCode Private

Add separate implementation and separation certification.

## Slice 8 — OAuth Providers

Add accepted narrow identity-fact seams and active probes.

## Slice 9 — Anthropic passive acquisition

Add Anthropic API-key response-header observation through the existing public Pi/Token response observation seam without affecting request success.

Meta passive acquisition remains deferred and is not part of this slice unless the section 10.2 gate has been satisfied by an accepted public observation seam.

## Slice 10 — release certification

Run unit, integration, Control Plane, renderer, packaged Electron Provider-page, Provider activation, and request-lane regression suites.

---

# 19. Acceptance criteria

The feature is complete when:

1. A supported and eligible Provider card shows verified quota/credit/balance after explicit refresh.
2. Acquisition and presentation share only structured normalized facts.
3. No probe emits final card text.
4. No renderer code knows a quota endpoint or auth scheme.
5. No generic Authority branch contains Provider endpoint/schema behavior.
6. Probe eligibility sees current binding kind/auth type and effective Provider destination before auth resolution.
7. Unsupported binding or unsafe destination performs no `Models.getAuth()` and no quota request.
8. The Authority passes one refresh signal through `Models.getAuth(..., { signal })` and probe acquisition.
9. Goat and Private are independently implemented and cached.
10. Refresh publication and cache-only query are both current-binding guarded.
11. Active Profile changes cannot publish or continue displaying old Profile usage as current.
12. Renderer binding changes clear Usage immediately and stale async query/refresh results are epoch-rejected.
13. Only one current cache slot per Provider is retained; credential-generation history does not accumulate.
14. Authoritative empty success clears an obsolete same-binding limit/budget.
15. Unsupported Providers perform no quota network request and show no invented percentage.
16. Page open performs no quota/OAuth refresh.
17. Provider Usage failure cannot affect Catalog, authentication, routing, requests, or Data Plane lifecycle.
18. No raw credential or raw upstream error reaches Control Plane or renderer.
19. Balance-only Providers are not represented as `0%` usage.
20. Control Plane version is updated for the new command family and Provider Usage uses split contract/wire modules.
21. Anthropic passive observation uses an existing public observation seam; Meta passive observation remains deferred until a real public/raw-SSE seam exists.
22. Existing request-lane tests remain green.
23. Pi and `pi-agent/` remain unmodified.

---

# 20. Expected implementation footprint

New Backend files:

```text
src/provider-usage/contract.ts
src/provider-usage/authority.ts
src/provider-usage/wire.ts
src/provider-usage/probes/*
```

Expected Backend/Control Plane changes:

```text
src/application.ts
packages/application-control-plane/src/provider-usage-contract.ts
packages/application-control-plane/src/wire-provider-usage.ts
packages/application-control-plane/src/contracts.ts                 # minimal version/frame integration if needed
packages/application-control-plane/src/wire.ts                      # minimal frame integration if needed
packages/application-control-plane/src/client.ts
packages/application-control-plane/src/application-status-host.ts
packages/application-control-plane/src/control-plane.ts
```

Expected Desktop changes:

```text
packages/desktop-shell/src/shared/desktop-api.ts
packages/desktop-shell/src/shared/ipc-channels.ts
packages/desktop-shell/src/preload/preload.ts
packages/desktop-shell/src/main/desktop-ipc.ts
packages/desktop-shell/src/renderer/providers/provider-usage-presentation.ts
packages/desktop-shell/src/renderer/providers/ProvidersPage.tsx
packages/desktop-shell/src/renderer/renderer.css
```

Tests are added beside the existing unit/integration/Desktop suites. Do not create a parallel test-only quota architecture.

---

# 21. Decisions that should survive review

These are deliberate architectural choices:

- structured facts instead of `text`;
- probe eligibility before auth resolution;
- effective-destination validation instead of trusting `providerId`;
- typed probe outcomes instead of Authority inference from arbitrary errors;
- exact Provider probes instead of a generic quota executor;
- controlled local duplication for Goat/Private instead of shared CommandCode Provider semantics;
- refresh **and query** guarded by current credential binding;
- one current Provider cache slot instead of historical credential-generation cache;
- renderer-local invalidation/epoch protection when Profile binding changes;
- authoritative empty success as a first-class successful observation;
- independent Provider Usage Control Plane command instead of Catalog/Profile fields;
- split Provider Usage Control Plane contract/wire modules;
- explicit refresh instead of idle polling;
- no first-release acquisition TTL because there is no background refresh policy;
- one Authority-owned timeout/AbortSignal for the whole refresh lifecycle;
- fixed safe failure categories instead of raw upstream errors;
- unsupported binding/destination instead of unsafe auth resolution or guessed support;
- Anthropic passive observation only where the existing public seam actually exposes data;
- Meta passive observation gated/deferred under the current Pi public contract;
- no quota influence on routing/request execution.

They are the minimum design needed to satisfy Provider isolation, credential correctness, and acquisition/presentation separation without building a broader quota platform than the current product requires.
