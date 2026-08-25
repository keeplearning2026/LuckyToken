# Token Provider Credential Profiles Implementation Plan v1.5

**Status:** FROZEN — READY FOR TDD IMPLEMENTATION

**Date:** 2026-08-22

**Source requirements:** [Token Provider Credential Profiles PRD v1.5](./TokenProviderCredentialProfilesPRD.md)
**Related specifications:**

- [Token Provider Activation Specification](./TokenProviderActivationSpec.md)
- [Token Electron Product Architecture Specification](./TokenElectronArchitectureSpec.md)
- [Token Core Architecture Specification](./TokenCoreSpec.md)
- [Repository architecture rules](../../AGENTS.md)

This document turns the accepted product contract into a test-driven implementation sequence. It defines the target Modules, Interfaces, information ownership, persistence shape, vertical delivery slices, and release gates. It does not revise the PRD.

---

# 1. Conclusion

The PRD is implementable without modifying Pi AI and without rebuilding Pi `Models` when the active credential changes.

The implementation will replace the current Provider-to-one-`auth.json`-slot contract with one deep **Provider Profile State Owner**. That owner maintains one independent record per Provider, exact Profile lifecycle, management revision, credential and selection generations, active selection, 429 settings, and sanitized projections. Consumers receive separate narrow Management and Binding Interfaces; only the composition root receives the secret-bearing profile-bound Pi `CredentialStore` Adapter. The existing Backend-lifetime Pi `Models` object remains unchanged in identity and receives only that Adapter.

All Provider-backed traffic begins as a local Client Protocol HTTP request on `127.0.0.1`. The client supplies the protocol wire and model selector, never an upstream auth-mode choice. After the existing model/protocol contract selects a lane, that lane captures either the Provider's one active managed Profile or, only when no managed Profiles exist, an ambient binding. A managed `api_key` Profile selects Pi's non-OAuth credential branch; it does not imply that the stored payload is a literal API key. An OAuth Profile selects Pi's OAuth branch. No new request field, auth-mode router, client-credential parser, or per-lane Profile setting is required.

Provider Native preserves the compatible client body's decoded semantics and normally replaces only its top-level `model` identity. The sole exception is first-party Anthropic Messages under a captured managed OAuth Profile, whose Anthropic-owned implementation mirrors the pinned Pi Agent's OAuth-dependent Claude Code identity/tool-name body differential. Each Native lane then independently rebuilds the request envelope that its pinned Pi Agent Provider implementation would send for the resolved Model and captured managed-or-ambient binding. It does not reuse client transport/auth headers or introduce a shared Native request/body builder.

Each Provider-backed lane keeps its own execution lifecycle:

```text
127.0.0.1 Client Protocol API request
             │
             └─ existing model/protocol lane selection
                    ├─ Provider Native Responses ── its own capture Adapter ─┐
                    ├─ Anthropic Provider Native ─ its own capture Adapter ──┼─> Binding Interface
                    └─ Semantic Conversion ─────── its own execution Adapter ┘       │
                                                                                     ▼
                                                                          Profile State Owner
                                                                                     │
                                                                                     ▼
                                                         composition-private CredentialStore
                                                                                     │
                                                                                     ▼
                                                                       one Pi Models collection
```

The State Owner shares credential state transitions, not execution. It does not become a shared lane router, retry executor, native transport, or Pi AI IR representation. Its `api_key`/`oauth` values remain Pi-compatible internal discriminants. Product surfaces use Backend-projected Provider auth-method labels and optional identity hints instead of assuming literal keys or generic accounts.

Provider Native Responses and Semantic Conversion/Pi AI IR remain absolutely uncoupled. The two lane-owned Adapters independently consume authoritative Profile state and allowed Pi `Models` capabilities; neither imports, calls, wraps, or reuses the other's credential-binding Adapter, request construction, execution wrapper, transport, retry state, response handling, or semantic types. Pi Provider source is a Native test/reference oracle only, never its runtime implementation.

The first release candidate is produced only after persistence, Pi binding, Control Plane, desktop lifecycle, lane binding, Activity attribution, and Provider Native auth coverage are complete. Automatic HTTP 429 switching is then added as the final capability slice. Its outer loop is capped at `MAX_PROFILE_ATTEMPTS_PER_REQUEST = 3`, independent of the number of stored Profiles and of each lane's inner transport retry limit.

---

# 2. Confirmed source baseline

The following are current implementation facts, not proposals:

1. `src/pi/file-credential-store.ts` stores `Record<providerId, Credential>` in one `auth.json` file and implements Pi's one-credential-per-Provider `CredentialStore` contract.
2. `src/credentials/authority.ts` owns one stored slot per Provider, one coarse global numeric revision, Provider-wide login/logout, and obsolete profile-unaware import commands.
3. `src/providers/runtime.ts` creates one Backend-lifetime Pi `Models`, injects the current credential store, and exposes the same runtime to login, catalog, and requests.
4. Pi `Models.getAuth()` reads and refreshes credentials only through the injected `CredentialStore`. Without an explicit `apiKey` override, `resolveProviderAuth()` branches on the stored credential's `type`: API-key credentials use the Provider's API-key resolver and OAuth credentials use its OAuth resolver. OAuth refresh uses serialized `modify()` with a second expiry check.
5. Pi `Models.login(providerId, authType, interaction)` runs the Provider-owned `apiKey.login` or OAuth login implementation and then persists the returned credential through `CredentialStore.modify()`. `ApiKeyAuth.name`/`OAuthAuth.name` supply Provider method labels; `apiKey.login` is optional for ambient-only methods.
6. `src/provider-native-responses/index.ts` resolves auth once through `Models.getAuth(model)` and owns a bounded transport retry loop.
7. `src/provider-native-anthropic/index.ts` resolves auth through `Models.getAuth(model)` but currently has no equivalent transport retry loop.
8. Semantic Conversion executes through `src/execution.ts` and receives a structured final `UpstreamFailureFact`, including a trustworthy HTTP status and safe `retry-after` header when the Provider supplied them.
9. `src/providers/catalog-refresh.ts` already supports Provider-scoped forced refresh and atomically swaps served model snapshots for new requests while preserving captured model objects for in-flight requests.
10. The current Control Plane and desktop wire expose login interactions and Provider-wide logout, while `ProvidersPage.tsx` exposes login but no credential management view.
11. The Request Ledger already owns request lifecycle and bounded facts, but has no credential Profile or lane attribution.
12. Pi `Models.streamSimple()` lazily calls its auth-preparation path, then `Models.getAuth(model)`, and applies the resolved `apiKey`, headers, environment, and auth-specific base URL to the Provider request. Token Semantic Conversion already enters this path and must not pass inbound HTTP authorization as `options.apiKey`.
13. Token Provider Native Responses explicitly calls `Models.getAuth(model)` and creates fresh upstream headers from the returned `AuthResult`; the Client Protocol handler passes no inbound request headers into that sender.
14. Provider Native Anthropic currently constructs `x-api-key` auth generically. Pi's reference implementation has distinct Provider/auth rules, including Anthropic OAuth bearer headers and GitHub Copilot bearer behavior, so Native auth coverage must use an authoritative managed Profile type or an explicit ambient contract plus pinned Provider rules rather than inbound headers or rediscovery from token text.
15. The Data Plane host is fixed to `127.0.0.1`. OpenAI Responses first selects Direct Mode by explicit local claim; otherwise it resolves the model and chooses Provider Native by explicit model/API capability or Semantic Conversion before execution begins.
16. Responses Native already constructs fresh upstream headers and its model rewriter preserves the original JSON text outside top-level `model` string spans. Anthropic Native currently passes `passthroughRequestHeaders(input.request)` and rewrites a changed model through object serialization; both are implementation-specific behaviors that must be tested or corrected against the new body-preservation and Pi-wire contracts.
17. The pinned Pi Anthropic implementation makes authentication-dependent body changes only for its first-party OAuth branch: it prepends the required Claude Code system identity and canonicalizes recognized Claude Code tool names through definitions and related message references. OpenAI Responses, Codex Responses, Azure Responses, Anthropic API-key, and GitHub Copilot Native auth do not have a Profile-selected body differential.

These facts justify a storage/authority replacement and request binding. They do not justify modifying Pi or merging the data-plane lanes.

---

# 3. Target Modules and Interfaces

## 3.1 Module map

| Module | Responsibility | Stable Interface | Implementation notes |
|---|---|---|---|
| Provider Profile State Owner | Own Profile identity, metadata, generations, active pointer, management revision, switch policy, runtime health, and authoritative mutation state | Internal capability used only to compose the three views below | Replaces `LiveCredentialAuthority`; one owner, not three competing authorities |
| Credential Profile Management Module | Project sanitized Provider/Profile state and accept local or explicit auth lifecycle commands | `CredentialProfileManagement` | Secret-free; owns product labels, identity hints, orphan-Provider availability, and optimistic management concurrency |
| Provider Auth Binding Module | Capture one managed or ambient request binding and guard 429 transitions | `ProviderAuthBindingAuthority` plus consumer-owned narrower lane seams | Secret-free facts plus opaque handles; never returns a credential payload or Pi Store |
| Provider Credential Record Store | Discover, persist, and atomically mutate one Provider record | `listProviderIds`, `read`, revision-checked management mutation, and generation-guarded exact payload mutation | Production file Adapter plus in-memory test Adapter; Provider file locks are never held over network I/O |
| Profile-bound Pi Credential Store | Present exactly one operation-bound Profile or ambient absence as Pi's Provider-keyed slot | Pi `CredentialStore` | Composition-private Adapter only; Pi does not learn sibling Profiles and no public Authority returns this Adapter |
| Catalog runtime handle | Run existing lifecycle refresh, explicit Recheck, and post-login refresh under an exact managed-or-ambient binding | Narrow refresh operation plus generation-guarded served model snapshot | Never runs merely because `activeCredentialId` changed; keeps credential scope out of Catalog Controller |
| Credential Control Plane | Project sanitized state and accept typed Profile mutations | Versioned credential/auth commands | No file access, secret return, import, or compatibility DTO |
| Provider Native Responses binding seam | Capture safe binding facts and run lane-owned `Models.getAuth()` inside the exact scope | Consumer-owned narrow Binding Interface | `AuthResult` remains internal to the lane; preserves body except model and keeps its own transport/retry lifecycle |
| Anthropic Provider Native binding seam | Capture safe binding facts and run lane-owned `Models.getAuth()` inside the exact scope | Consumer-owned narrow Binding Interface | `AuthResult` remains internal to the lane; owns the sole OAuth body exception and is not shared with Responses transport |
| Semantic Conversion credential seam | Run one complete Pi semantic execution under one captured Provider binding | Consumer-owned narrow Interface around `ExecutionOperation` | Does not put Profile facts in Pi AI IR |
| Request Ledger Profile facts | Own managed request-time name/id/auth-method/lane snapshots and Profile attempts | `credentialCaptured()` and `credentialAttempt()` | Stored in existing bounded facts JSON; ambient execution adds no Profile facts and no SQLite schema migration is needed |
| Desktop credential manager | Own form drafts and interaction state for one selected Provider | Typed preload Control Plane operations | Renderer never owns authoritative Profile state |

## 3.2 One state owner, three consumer views

The Provider Profile State Owner is the high-depth Module, but no consumer receives a broad aggregate Authority. Composition exposes two secret-free Interfaces and keeps the Pi Store Adapter private. The exact TypeScript spelling may change during implementation, but the knowledge boundaries must remain equivalent:

```ts
interface CredentialProfileManagement {
  query(providerIds?: readonly string[]): Promise<CredentialProfilesProjection>;
  snapshot(): CredentialProfilesProjection;

  updateMetadata(input: UpdateProfileMetadata): Promise<ProfileMutationResult>;
  activate(input: ActivateProfile): Promise<ProfileMutationResult>;
  setEnabled(input: SetProfileEnabled): Promise<ProfileMutationResult>;
  setPriority(input: SetProfilePriority): Promise<ProfileMutationResult>;
  remove(input: RemoveProfile): Promise<ProfileMutationResult>;
  setSwitchPolicy(input: SetProviderSwitchPolicy): Promise<ProfileMutationResult>;
  recheck(input: RecheckProfile): Promise<ProfileMutationResult>;
}

interface ProviderAuthBindingAuthority {
  capture(providerId: string): Promise<ProviderAuthBindingCapture>;
  runBound<T>(capture: ProviderAuthBindingCapture, operation: () => Promise<T>): Promise<T>;
  advanceAfterFinal429(input: AdvanceAfter429): Promise<AdvanceAfter429Result>;
  createLoginBinding(input: AddOrReconnectProfile): CredentialLoginBinding;
}
```

`ProviderAuthBindingCapture` is an opaque execution handle plus one of two bounded fact shapes:

```ts
type ProviderAuthBindingFacts =
  | {
      readonly kind: "managed";
      readonly providerId: string;
      readonly credentialId: string;
      readonly authType: "api_key" | "oauth";
      readonly displayName: string;
      readonly credentialGeneration: string;
      readonly selectionGeneration: string;
    }
  | {
      readonly kind: "ambient";
      readonly providerId: string;
    };
```

Neither Interface contains a credential payload, note, token claim, auth header, inbound client credential, or Pi `CredentialStore`. The opaque handle is valid only for its Provider and operation scope. Management `revision` is intentionally absent from Data Plane capture; it is a wider Desktop/CLI optimistic-concurrency token and is not a request-binding generation.

Managed capture does not copy the secret payload. The composition-private Store resolves it when Pi auth is actually consumed. Therefore a pointer-only switch preserves an existing captured Profile, while removal or reconnect before that bound read makes the old generation fail closed. Auth already resolved into a bounded in-flight Provider request may finish, but the State Owner never retains or resurrects a removed or replaced Profile for it. Ambient capture is possible only when the Provider has zero managed Profiles and carries no fake `credentialId`, Profile attribution, or switch eligibility.

The composition root alone constructs the profile-bound Pi `CredentialStore` from an internal State Owner capability and injects it into the Backend-lifetime Pi `Models`. The Management Module, Binding Module, lanes, Renderer, Electron Main, and Control Plane cannot retrieve that Store. Consumer-owned lane Adapters receive only the binding operations they actually use.

## 3.3 Internal persistence record

Each safe Provider ID maps to one file:

```text
<piDirectory>/credential-profiles/<providerId>.json
```

The existing `isSafeProviderId` rule prevents path traversal and bounds file names. The record includes its own `providerId`, and readers must verify that it matches the requested Provider and filename.

Target v1 shape:

```ts
interface PersistedProviderCredentialRecordV1 {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly revision: string;
  readonly selectionGeneration: string;
  readonly activeCredentialId?: string;
  readonly switchPolicy: {
    readonly apiKeyOn429: boolean;
    readonly oauthOn429: boolean;
  };
  readonly profiles: readonly {
    readonly credentialId: string;
    readonly credentialGeneration: string;
    readonly authType: "api_key" | "oauth";
    readonly authMethodLabel: string;
    readonly displayName: string;
    readonly note?: string;
    readonly identityHint?: string;
    readonly enabled: boolean;
    readonly priority: number;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly credential: unknown;
  }[];
}
```

The Record Store Interface separates the two lifecycles rather than overloading one generic write:

```ts
interface ProviderCredentialRecordStore {
  listProviderIds(): Promise<readonly string[]>;
  read(providerId: string): Promise<PersistedProviderCredentialRecordV1 | undefined>;
  modifyManagement<T>(
    providerId: string,
    expectedRevision: string,
    mutation: (current: PersistedProviderCredentialRecordV1 | undefined) => ManagementMutation<T>,
  ): Promise<ManagementMutationResult<T>>;
  modifyCredential(
    providerId: string,
    credentialId: string,
    mutation: (current: unknown) => Promise<unknown | undefined>,
  ): Promise<unknown | undefined>;
}
```

`modifyManagement` advances `revision` on commit. `modifyCredential` acquires a per-`credentialId` refresh lock, performs only a short Provider-file read before the async callback, and performs only a short generation-guarded Provider-file publication afterward. It preserves `revision`, `selectionGeneration`, `credentialGeneration`, all management fields, and sibling payloads. The exact result types remain internal and closed; neither operation accepts a caller-owned replacement record.

Implementation invariants:

- `revision` is an opaque management UUID regenerated by committed add/reconnect, metadata, enable/disable, priority, remove, active-pointer, and switch-policy mutations; Desktop/CLI clients compare it but never order or calculate it, and Data Plane capture never uses it;
- `credentialGeneration` is an opaque logical-credential-incarnation UUID created on add and regenerated on reconnect or credential identity replacement; silent OAuth refresh preserves it;
- `selectionGeneration` is an opaque Provider-selection UUID regenerated only when the active pointer's value actually changes, including clear/set transitions; it prevents an old request from treating A→B→A as an unchanged selection;
- silent OAuth refresh rewrites only the exact Profile's opaque `credential` after verifying that the Profile still exists and its `credentialGeneration` is unchanged; it does not change either generation, `revision`, or user-visible `updatedAt`;
- every mutation is a narrow function over the latest locked record, never a write-back of a caller snapshot, so a management mutation can preserve a concurrently refreshed payload while checking the unchanged management revision;
- the Provider record is one authoritative representation; there is no second active pointer or auth-mode toggle;
- `credential` preserves the complete Pi/Provider payload, including Provider-private fields;
- the common parser validates the Pi discriminant and minimum required base fields, verifies `credential.type === authType`, and preserves unknown Provider fields unchanged;
- Profile names are case-insensitively unique within the Provider;
- equal numeric priorities are legal and break by `credentialId`;
- persisted state excludes request counters, `lastUsedAt`, `lastSucceededAt`, cooldown timers, and raw failures;
- `authMethodLabel` is a Backend-owned sanitized snapshot derived from Provider auth metadata when the Profile is created or reconnected; it remains usable if the Provider implementation later becomes unavailable;
- `identityHint` is optional because Pi's `api_key` branch may represent a literal key, bearer token, AWS profile/credential chain, ADC, service-account configuration, or another Provider-declared non-OAuth source with no meaningful suffix;
- internal `api_key`/OAuth switch settings live in this Provider record, not the global Settings Registry; product surfaces render the Provider-declared auth-method labels;
- one Provider's parse/load failure becomes that Provider's sanitized error projection and never blocks another file.

The production Store uses the current proven file mechanics: directory mode `0700`, file mode `0600`, a per-file cross-process lock, a restrictive temporary sibling, and atomic rename. It revalidates lock ownership immediately before rename, including both the Provider-record and per-credential refresh leases for a token publication. It also uses a cross-process per-credential refresh lock where the platform supports the production file-lock contract. A Provider file lock protects only bounded local read/commit work and is never held through OAuth network I/O. It never creates or locks an unrelated Provider record while modifying one Provider. If release reports degradation after a successful atomic rename, the mutation remains a committed success and the degradation is reported separately; it is never misreported as a failed credential write.

`listProviderIds()` owns persisted record discovery. The Management Module queries the union of runtime Provider IDs and persisted Provider IDs. A valid stored record for a Provider whose implementation is no longer installed remains visible with `Provider implementation unavailable`; local query and `Remove from Token` remain available, while login, reconnect, recheck, and request execution fail with a typed unavailable outcome. This prevents a stored secret from becoming undiscoverable or undeletable.

## 3.4 Derived and runtime-only facts

Information remains with the Module that owns its lifecycle:

- the Profile State Owner derives static Profile eligibility and OAuth expiry from the Provider record;
- `refreshing`, a demonstrated reconnect condition, and explicit `Retry-After` cooldown are Backend-lifetime runtime facts owned by the Profile State Owner;
- `lastUsedAt`, `lastSucceededAt`, and retained request-attempt history are derived by the Request Ledger, not written to the secret-bearing Provider file on every request;
- detailed credential queries may merge a narrow Ledger usage summary into the sanitized projection at the Application Control Plane seam;
- the synchronous status snapshot contains Provider/Profile summaries and errors, not a duplicated request history.

A newly added managed non-OAuth credential begins as `not_yet_verified`. A successful attributed request is sufficient for the query projection to show it as ready. No model request is sent only to validate a credential.

## 3.5 External auth sources

Ambient sources remain read-only and are never converted to managed Profiles.

The request rule is:

1. when one or more managed Profiles exist and a valid active Profile exists, capture `ManagedProfileBinding` and do not consult ambient auth;
2. when one or more managed Profiles exist but none has a valid active selection, fail before calling Pi so Pi cannot silently fall back to environment, `models.json`, or another ambient source;
3. when the Provider has zero managed Profiles, capture `AmbientBinding` and preserve Pi's existing ambient auth behavior;
4. removing the last managed Profile makes a later operation eligible for `AmbientBinding`; the mutation itself does not probe, refresh, or claim live ambient effectiveness.

`AmbientBinding` contains only `kind` and `providerId`. It has no `credentialId`, does not belong to the Profile pool, is not persisted as a selection, does not participate in Profile 429 switching, and produces no Profile attribution. No persisted `externalCredentialId`, external selector, or second active mode is introduced.

---

# 4. Pi integration without modifying Pi

## 4.1 Binding mechanism

The Profile-bound Pi `CredentialStore` uses an internal async operation scope. The scope maps a Provider ID to exactly one of:

- an existing captured managed `credentialId` plus its `credentialGeneration` and `selectionGeneration`;
- an `AmbientBinding` for a Provider with zero managed Profiles;
- a pending Profile creation;
- an exact Profile reconnect/replacement;

Every auth-consuming Pi call must run inside a scope. An unbound or Provider-mismatched `read`, `modify`, or `delete` fails closed.

For a managed binding, `read(providerId)` returns only the exact Profile payload when its `credentialGeneration` still matches the capture. `list()` returns only bounded metadata visible in the current scope. Pi `modify(providerId, fn)` maps to generation-guarded `modifyCredential` and writes back only that exact Profile without advancing management revision or either generation. Under a pending add/reconnect binding, the same Pi call maps to a revision-checked management publication that creates or replaces one logical credential incarnation.

For `AmbientBinding`, `read(providerId)` intentionally returns `undefined` and `list()` exposes no managed entry, allowing Pi's existing environment/config/Provider ambient resolution to run. Ambient `modify()` and `delete()` are forbidden because Token does not own that source. `delete(providerId)` is otherwise permitted only under an exact explicit removal binding and removes only that managed Profile; ordinary local removal calls the Management Interface directly.

This preserves Pi's contract while changing Token's mapping:

```text
Pi view:        providerId -> one Credential
Token:     providerId + bound credentialId -> exact Profile payload
```

## 4.2 Side-effect contract

Profile state operations and Provider auth operations are separate Interfaces:

| Operation | Pi auth call | Provider network | Interaction/browser |
|---|---:|---:|---:|
| `query` / status projection | Forbidden | Forbidden | Forbidden |
| metadata, priority, activate, enable/disable, remove, switch policy | Forbidden | Forbidden in the command | Forbidden |
| Provider-backed request | `getAuth()` under exact binding | Only request traffic and any required silent OAuth refresh | Forbidden |
| explicit model/auth recheck | Bound refresh/check operation | Allowed | Forbidden; returns `reconnect_required` when appropriate |
| explicit login/reconnect | `Models.login()` under pending/exact binding | Allowed | Allowed by the user-started Provider flow |

Query and local mutations read or CAS-update only the Provider record and runtime facts. In particular, they never call `Models.getAuth()`, `Models.checkAuth()`, `Models.getAvailable()`, `Models.refresh()`, or `Models.login()`. This makes Profile management available offline and prevents a status screen or switch from silently refreshing tokens or opening interaction.

`Models.getAuth()` is allowed only when an exact Profile is actually consumed by a Provider-backed request, explicit Recheck, or its post-login Catalog child phase. It may perform Pi's silent network token refresh, but it has no `AuthInteraction` and cannot start login. A refresh failure ends that operation and projects only bounded health evidence. It never calls `Models.login()`.

## 4.3 OAuth refresh safety

Pi's current double-checked OAuth refresh remains authoritative. The Adapter adds Profile identity safety without holding a Provider file lock across network I/O:

```text
cross-process refresh lock for (providerId, credentialId)
        │
        ▼
short Provider-file lock
→ read exact payload + credentialGeneration
→ release file lock
        │
        ▼
Pi bounded modify callback / OAuth network refresh
        │
        ▼
short Provider-file lock
→ Profile still exists?
→ credentialGeneration unchanged?
→ yes: publish exact refreshed payload
→ no: discard late result
```

The per-credential refresh lock, not the Provider file lock, remains held through Pi's bounded callback. This preserves same-credential serialization and Pi's second expiry check while allowing rename, note, activation, sibling operations, remove, and reconnect to commit during the network call. A later waiter rereads the newest payload only after acquiring the refresh lock, so it normally observes the first refresh and avoids a duplicate refresh.

Silent refresh changes no management revision, `credentialGeneration`, `selectionGeneration`, active pointer, or user-visible `updatedAt`. Switching the active pointer does not redirect a refresh already bound to another Profile. Remove can complete while refresh is in flight; a late result sees the missing Profile and is discarded. Reconnect creates a new `credentialGeneration`; a refresh of the old incarnation cannot overwrite it. No late refresh can create a missing Profile or write into a sibling.

## 4.4 Login and reconnect

Before `Models.login()`:

1. Control Plane validates Provider/auth capability, metadata, expected Provider revision, and duplicate name.
2. The State Owner allocates an immutable `credentialId` for add, or identifies one exact Profile for reconnect.
3. The Binding Module establishes a pending login binding carrying sanitized metadata and `useNow` intent.
4. Pi runs the Provider-owned interaction.
5. Pi calls `CredentialStore.modify()` only after login returns a credential.
6. The Adapter atomically creates or replaces the exact Profile under the expected Provider revision, assigns a new `credentialGeneration`, and advances `selectionGeneration` only if `useNow` actually changes the active pointer.

Provider failure or cancellation occurs before publication and leaves no Profile. Storage conflict returns a typed conflict and never replaces a sibling. The first Profile becomes active; later additions become active only when `useNow` is true.

## 4.5 Active switch and binding-aware Catalog refresh

Manual activation and automatic 429 switching change only the Provider record and affect subsequent captures. An actual active-pointer change regenerates `selectionGeneration` and management `revision`; selecting the already-active Profile changes neither selection generation. These mutations do not call Pi, use the network, create a new Pi `Models` collection, or mutate any Pi `Model` descriptor.

The existing Catalog lifecycle still needs a narrow binding-aware runtime handle because model refresh and availability checks can consume auth. Every startup, page-open, global/manual, explicit Recheck, and post-login Provider operation first captures an opaque exact managed-or-ambient view for that Provider. Dynamic model network refreshes use an isolated cache stage; static Provider availability checks are separate exact children with no borrowed binding from another Provider. Every Provider publishes its own model/availability slice under its own generation guard; the default lifecycle path has no unguarded cache writer or cross-Provider publication. A successful login/reconnect also schedules a non-blocking Provider-scoped refresh only when the newly published Profile is active; the scheduled operation carries the exact post-publication Profile capture rather than resolving the active Profile later. Changing `activeCredentialId` by itself does not schedule Catalog work. The handle may call Provider model discovery and Pi's silent token refresh for a managed OAuth binding, but never `Models.login()` or an interaction callback.

Catalog publication remains generation-guarded and Provider-isolated: new requests see refreshed model facts, while in-flight requests keep their already captured `Model` and credential binding. Every Provider network refresh writes only to an isolated cache stage. Under that Provider's selection lock, Token revalidates the captured credential and selection, passes a narrow ownership assertion to the publisher, revalidates immediately before the cache rename and served-snapshot capture, then commits the staged Provider entry and its slice of the snapshot. A process exit or stale binding before this commit leaves the authoritative cache unchanged. A failure after durable cache publication uses a compare-and-restore rollback that cannot overwrite a newer Catalog writer, then restores live facts from the resulting authoritative cache. Rollback I/O failure is distinct from a compare miss and makes cache/live state unproven. If restoration cannot be proven, only that Provider is quarantined: its last complete captured model slice remains served while other Providers continue publishing; only its own successful exact guarded publication clears the quarantine. If the Profile is removed, reconnected, or superseded, the staged result is discarded and the Provider's live facts are restored from the authoritative cache without rewriting it. Recheck failure leaves the last usable Catalog snapshot and committed active pointer unchanged and returns a sanitized warning. Each successful active login/reconnect owns an independent queued child run, so a later login cannot overwrite an earlier exact refresh. Login success and switch success never wait on, depend on, or roll back because of Catalog state.

---

# 5. Data-plane integration

## 5.1 Common rule

The fixed-loopback Client Protocol request supplies only its protocol wire and model selector. The existing Client Protocol/model contract selects the lane first. Neither the handler nor a lane inspects inbound `Authorization` to decide `api_key` versus OAuth behavior; credential type never participates in lane selection. Direct Mode remains unchanged and receives no Provider Profile dependency.

Each Provider-backed lane Adapter performs this sequence independently:

```text
resolved Model
  -> capture managed Profile or zero-managed ambient binding
  -> if managed, record bounded request-time Profile facts
  -> run complete auth/execution lifecycle under that binding
  -> if managed, record Profile attempt result
```

For a managed binding, the captured display name is only an Activity snapshot and routing uses `credentialId`. An ambient binding has neither fact.

There is no request-level `credentialId`, `authType`, or auth-mode field. For every managed Provider-backed attempt, the authoritative captured Profile is the only source of upstream auth selection: `api_key` means use Pi's Provider-declared non-OAuth branch, and `oauth` means use its OAuth branch. An ambient binding is allowed only for zero managed Profiles and delegates to Pi's existing ambient resolution; it is not assigned an invented auth type.

“Common rule” describes equal obligations, not a shared data-plane Module. Responses Native and Semantic Conversion each own a separate capture/binding Adapter and complete execution lifecycle. Neither Adapter may import, delegate to, wrap, or return the other's request, credential, execution, retry, transport, response, or semantic representation. The only common dependencies permitted here are authoritative Profile state, minimum request-lifecycle/observation facts, and the Backend-lifetime Pi `Models` capabilities explicitly allowed by `AGENTS.md`.

## 5.2 Semantic Conversion

The existing semantic `ExecutionOperation` remains the Pi execution seam. Composition supplies a Semantic-only Adapter that:

1. captures the managed-or-ambient Provider binding after model resolution and before `Models.streamSimple()`;
2. runs the entire lazy stream creation and iteration inside the binding scope without populating Pi `options.apiKey` from the inbound request;
3. reports safe Profile capture/attempt facts to the handler-owned Request Ledger only for managed binding;
4. returns Pi's semantic terminal unchanged.

Anthropic Messages, OpenAI Responses, and Responses Compact semantic paths use this same Semantic-lane operation. Profile identity never enters Pi AI IR, `Context`, model-visible options, Provider diagnostics, or response conversion.

## 5.3 Provider Native Responses

The Responses Native lane keeps its own sender and transport retry loop. Composition gives its private Adapter only a narrow Binding Interface and the already allowed Backend-lifetime Pi `Models` capability. For one execution the Adapter:

- captures the exact safe managed-or-ambient binding facts;
- enters that binding's opaque operation scope;
- calls `Models.getAuth(model)` inside the lane;
- keeps the resulting `AuthResult` inside the Native lane while reconstructing and sending its wire.

No State Owner, Management, or Binding Interface returns `AuthResult`, the credential payload, the Profile collection, or inbound authorization. A managed `authType` comes from the safe binding facts and is used only where the native Provider wire needs a reliable discriminant; it is not inferred from request headers, token text, or `AuthResult.source`. Ambient Native execution is permitted only where the explicit Provider/protocol contract already defines a complete ambient projection from the resolved Model, Provider metadata, and lane-local `AuthResult`; it cannot select a managed-Profile-only differential.

For each send, the lane keeps the client's JSON text authoritative, validates it, and replaces only the top-level `model` string span with the resolved Provider model/deployment. It does not parse/re-serialize the whole body, insert Pi defaults, remove extension fields, or normalize model-visible content. It then builds a fresh request envelope from:

- the resolved Pi Model and effective auth-specific Model projection;
- the captured managed `authType` when present and the bound `AuthResult`;
- the Responses/Compact operation and request-local session identity;
- the pinned Pi Agent Provider request implementation.

That envelope owns method, endpoint/base URL, auth/account headers, Provider/model headers, beta/version/intent headers, session/request headers, User-Agent, accept/content type, and compression/content encoding. Client values with those names are not sender inputs and cannot override the projection. Compression is permitted only when decoding produces the preserved body with the projected model.

The inner transport retry loop continues to retry the same sender/auth binding. Only after it returns a final pre-output HTTP 429 under a managed binding may the outer Profile loop ask the Binding Authority for a same-type successor. Ambient bindings never enter Profile switching. Each successor creates a new binding, resolves fresh auth, and creates a new sender. The selected lane never changes.

## 5.4 Anthropic Provider Native

The Anthropic Native lane receives its own safe Binding Interface and owns its lane-local `Models.getAuth()` use, Provider wire, and body projection. It must stop inferring auth from token form and must remove `passthroughRequestHeaders(input.request)` as a generic sender input.

At minimum, its transport rules must distinguish:

- managed Anthropic `api_key` Profile: `x-api-key` plus required Anthropic headers;
- managed Anthropic OAuth Profile: bearer auth plus the Pi-reference Claude OAuth identity/beta headers;
- GitHub Copilot on Anthropic wire: Provider-specific bearer and required Copilot headers;
- zero-managed ambient auth and configured header-owned auth where the explicit Provider contract permits them.

The exact rules must mirror the pinned Pi request implementation and Provider metadata. A private pure implementation inside the Anthropic Native Module owns this narrow Interface:

```ts
interface AnthropicNativeBodyProjectionInput {
  readonly rawBody: string;
  readonly modelId: string;
  readonly mode: "model_only" | "anthropic_oauth";
}

interface AnthropicNativeBodyProjectionResult {
  readonly body: string;
  readonly applied: "model_only" | "anthropic_oauth";
}
```

For managed `api_key`, ambient, and non-first-party Provider cases it replaces only the top-level `model` span and preserves all other JSON text/semantics. For first-party managed Anthropic OAuth it additionally:

- prepends the pinned Claude Code identity to the `system` request semantics without discarding existing client system content;
- canonicalizes only the pinned recognized Claude Code tool names across `tools`, assistant `tool_use`, and related tool-reference semantics;
- preserves every other body field, value, extension, ordering relationship, and client meaning;
- fails before `fetch` when it cannot apply the required differential without guessing, repair, or semantic loss.

The Anthropic lane selects `anthropic_oauth` only when `binding.kind === "managed"`, `model.provider === "anthropic"`, `model.api === "anthropic-messages"`, and the captured authoritative `authType === "oauth"`; every other tuple, including ambient binding, selects `model_only`. The implementation never examines token text. It is internal to Anthropic Native because no second Adapter exists and no other lane may reuse it. A future pinned Pi change does not silently expand the projection; it requires source review, contract revision, and new golden fixtures.

The transport then creates fresh Pi-compatible method, endpoint, authentication, identity, version/beta, SDK/User-Agent, accept/content-type, and encoding facts. The Responses Native transport is not imported or reused.

If an Anthropic client header carries model-visible semantics that the Native contract must preserve, that exact header/fact is specified, validated, and projected by name after proving it cannot override any Profile/Pi-owned value. Generic `x-stainless-*`, account, auth, SDK identity, and transport header passthrough is removed.

## 5.5 Provider Native coverage certification

Coverage is a release test, not a production router or registry.

A test-only matrix enumerates every product-claimed managed `(providerId, api/protocol operation, declared authType)` combination plus each explicitly supported ambient Native contract. It must prove:

- the lane claims from the existing explicit protocol/model capability only;
- managed `api_key` and OAuth fixtures both reach the same claimed lane when both are declared;
- the decoded upstream body equals the client body except for the top-level `model` projection and, only for first-party Anthropic OAuth, the certified identity/tool-name differential;
- method, URL, auth/account projection, required Provider/version/beta/session/SDK headers, User-Agent, accept/content type, and content encoding match the pinned Pi Agent request behavior;
- token text, `AuthResult.source`, and presence of `auth.apiKey` are not used to infer `authType`;
- conflicting client transport/auth headers cannot alter the reconstructed envelope;
- changing managed `authType` from `api_key` to OAuth changes an Anthropic body only through the closed certified differential, while identical changes on every other claimed Provider/API combination leave body semantics unchanged;
- ambient binding has no Profile ID, Profile attribution, Profile switching, or Anthropic managed-OAuth body exception;
- adding a new claimed Provider auth type without a certification case fails the release suite.

Custom Provider Packages remain eligible only when that Native lane has explicit Provider/protocol projection rules and certification fixtures for them; otherwise the product must not claim that Provider/protocol operation.

## 5.6 Inbound request exclusion

Tests must prove that client `Authorization`, API-key, cookie, proxy-auth, account, SDK/User-Agent, Provider version/beta, session, host, content-length, and content-encoding headers:

- are never classified as API-key versus OAuth input by a Provider-backed lane;
- never select a Profile;
- never become Pi `options.apiKey`;
- never enter a Provider Native sender as generic headers or override Profile/Pi-owned facts;
- never appear in Activity attribution or switch decisions.

No generic Native request-header allowlist remains. Any client-owned, model-visible header input is a named, validated field in that Provider/operation's own narrow Interface and is tested with active managed `api_key` and OAuth Profiles. This is re-projection of an explicit semantic fact, not header forwarding.

---

# 6. HTTP 429 switching

## 6.1 Authority transition

`advanceAfterFinal429()` owns only managed-Profile state transition and deterministic eligibility. It receives the failed managed capture, attempted IDs, and an optional validated cooldown deadline. Ambient bindings are rejected before this Interface. It does not execute a request.

Under the Provider file lock it:

1. verifies the failed Profile still exists and matches the captured auth type;
2. verifies its `credentialGeneration` equals the captured `credentialGeneration`;
3. verifies the record's `selectionGeneration` equals the captured `selectionGeneration`;
4. verifies `activeCredentialId` still equals the failed `credentialId`;
5. using the latest record, re-evaluates the matching switch setting, enabled state, priority, cooldown, demonstrated `reconnect_required` state, and request attempted set;
6. optionally records a Backend-lifetime cooldown only from a valid `Retry-After` fact;
7. orders eligible unattempted same-type Profiles by priority then `credentialId`;
8. commits the successor, regenerates `selectionGeneration` and management `revision`, and returns its fresh managed binding capture.

Closed outcomes are `switched`, `disabled`, `exhausted`, `stale_binding`, and `storage_failure`. Any failure of steps 1–4 returns `stale_binding`; the old 429 cannot follow or overwrite a reconnect, manual/automatic selection, or A→B→A selection history. Rename, note, priority, and other management-only edits do not independently stale the transition because management `revision` is not compared. Eligibility is always recomputed from the newest locked record.

## 6.2 Lane-owned retry loops

No shared Profile retry executor is created.

- Responses Native performs switching outside its existing same-Profile transport retry loop.
- Anthropic Native performs switching around its own buffered pre-commit execution.
- Semantic Conversion performs switching around complete Pi semantic executions and recognizes 429 only from a trusted `UpstreamFailureFact` with `status === 429`.

Each Profile is attempted at most once per request. Each bound Profile invocation retains that lane's existing internal retry policy. Independently, every outer loop enforces `MAX_PROFILE_ATTEMPTS_PER_REQUEST = 3`, including the initial Profile, even when more same-type Profiles are eligible. Cancellation is checked before capture, switch, delay, and retry.

No switch occurs for a network error, uncertain upstream acceptance, 401, 403, 5xx, refresh failure, storage failure, malformed failure, or after client/model output commit. After a successor is committed, its bound `getAuth()` may silently refresh OAuth. If that refresh fails, the lane stops: it does not try another Profile, invoke login, open a browser, or roll back the committed pointer. A rollback could overwrite a newer manual choice; any health publication therefore uses a fresh guarded mutation and never changes selection.

---

# 7. Control Plane contract replacement

## 7.1 Projection

Replace the current `CredentialProjection`, `ProviderAuthStatus`, global revision, `auth.json` path, and import DTOs with:

- `CredentialProfilesProjection` containing independent Provider states;
- `ProviderCredentialStateProjection` with an opaque management revision, active ID, switch policy, sanitized Profile rows, bounded ambient summary, Provider-implementation availability, summary, and optional record error;
- `CredentialProfileProjection` with ID, name, note, Backend-projected `authMethodLabel`, optional `identityHint`, internal Pi auth type, enabled, priority, bounded health, timestamps, and request-derived last-used facts;
- no credential payload, raw file path, token claim, environment variable name, command text, or auth header.

One corrupt Provider state is represented as one invalid Provider row; the global query still succeeds for independent Providers. Runtime Provider IDs are unioned with `ProviderCredentialRecordStore.listProviderIds()`, so an orphaned valid record remains queryable. Its row shows `Provider implementation unavailable`, preserves the persisted safe auth-method labels and optional identity hints, and permits local removal only.

`query` and synchronous status projections are side-effect-free local reads. Their implementation must not call Pi `getAuth`, `checkAuth`, availability, refresh, or login operations. OAuth expiry and previously demonstrated health are projected from Profile/runtime facts; unknown remains unknown rather than being probed.

## 7.2 Commands

The profile management command union replaces the current Provider-wide logout/import contract:

```text
query
update_metadata
activate
set_enabled
set_priority
remove
set_switch_policy
recheck
```

Every mutation includes `providerId`, `credentialId` when applicable, and `expectedRevision`. Results use closed outcomes such as `ok`, `conflict`, `invalid`, `duplicate`, `unknown_provider`, `unknown_profile`, `storage_failure`, and `unavailable`.

`recheck` is the only non-interactive management command allowed to contact the Provider. It is an explicit user action, binds the selected/active Profile, may silently refresh OAuth or model facts, and never creates an `AuthInteraction`. When interaction is required it returns `reconnect_required`; the user must then issue `reconnect` separately.

Provider-owned interactive auth remains on `AuthCommand`, updated to support:

```text
login      { providerId, authType, displayName, note?, useNow, expectedRevision }
reconnect  { providerId, credentialId, expectedRevision }
query
```

`login` runs Pi `Models.login(providerId, authType, interaction)` under a pending publication binding. This invokes the Provider-declared `apiKey.login` or OAuth login implementation, so bearer-token, cloud-profile, ADC, service-account, literal-key, and OAuth flows retain their own prompts and payloads. A Provider method without `login` remains ambient-only and cannot be fabricated as a managed Profile. Reconnect uses the selected Profile's authoritative auth type and exact replacement binding. After successful publication, an active newly authenticated Profile schedules the exact-profile Catalog child phase described in §4.5; inactive additions/reconnects do not alter the served Catalog. The auth command returns success independently of that background result. `authType` remains an internal Backend discriminant; Renderer action text comes from `authMethodLabel` and never hard-codes `API key` or `Account`. Import/export commands and decoders are deleted. No compatibility aliases or dual command readers remain.

## 7.3 Desktop bridge

The same semantic contract flows through:

```text
Renderer -> typed preload -> Electron Main -> Control Plane -> Backend
```

`desktop-api.ts`, preload, and Electron Main forward the new typed commands only. They do not parse Provider payloads, access files, cache authoritative Profiles, or implement Provider-specific auth.

---

# 8. Desktop product implementation

The Provider grid remains a summary surface. Each card shows Profile counts/attention and opens one focused credential manager.

Implementation responsibilities:

- `ProvidersPage.tsx` owns Provider selection and high-level page refresh only;
- a credential-management feature Module owns the selected Provider's sanitized rows, filters, mutation drafts, confirmations, conflicts, and re-query after mutation;
- the existing auth interaction UI is extracted as a reusable login/reconnect Module without moving Provider auth logic into Renderer;
- every add, reconnect, 429-setting, search, row, and confirmation label uses Backend-projected `authMethodLabel`; default display names remain neutral `Profile N` suggestions;
- destructive confirmations distinguish local `Remove from Token` from OAuth `Disconnect from Token`, use the Provider-declared auth label, and never claim remote revocation;
- closing/reopening the view performs a fresh query and reconstructs all state from Backend authority;
- management remains usable when the Data Plane listener is stopped or failed.

Required UI states include loading, empty managed list, ambient-only, active, disabled, reconnect required, cooling down, Provider record error, orphaned Provider implementation, stale-revision conflict, login cancellation, storage failure, and successful local removal. An orphaned Provider permits query and local removal but disables login, reconnect, recheck, and request actions.

Search operates only over already sanitized name, note, `authMethodLabel`, and optional `identityHint`. Notes are never copied into Activity or errors.

---

# 9. Activity and Request Ledger

Extend the existing bounded `facts` JSON rather than changing the SQLite table or schema version.

Add these request-local facts:

```ts
interface LedgerCredentialCapture {
  readonly credentialId: string;
  readonly displayName: string;
  readonly authType: "api_key" | "oauth";
  readonly authMethodLabel: string;
  readonly lane: "provider_native" | "semantic_conversion";
  readonly selectionReason: "active" | "http_429_switch";
}

interface LedgerCredentialAttempt extends LedgerCredentialCapture {
  readonly attempt: number;
  readonly outcome: "success" | "http_429" | "failed" | "aborted";
}
```

`RequestLedgerEntry` gains consumer-owned `credentialCaptured()` and `credentialAttempt()` operations. Native and Semantic lane Adapters call these operations only for managed binding; ambient execution records no invented Profile capture or attempt. Provider diagnostics do not call them.

Validation bounds every string and accepts absent facts for ambient execution, early failures, and older records. The Ledger may retain the internal auth type, but the wire projection and desktop Activity UI identify the method through the request-time Backend-projected `authMethodLabel`; they also show the name snapshot, lane, attempt trail, and `HTTP 429 failover`. They reject notes, secrets, token claims, and inbound auth material.

A narrow Ledger usage query returns latest use/success times by `credentialId` for current Profile projection. Deleting a Profile does not mutate retained Ledger facts; normal Ledger retention/delete behavior remains authoritative.

---

# 10. TDD execution contract

The earlier architecture sections define the target; this section defines how production code is allowed to reach it. Development proceeds as small vertical behavior slices, not as separate test, persistence, runtime, UI, and cleanup phases.

## 10.1 Agreed test seams

These Interfaces are the stable observation points for this feature. Tests may construct real Adapters behind them, but must not assert private helper calls, private binding-context layout, or intermediate object shapes.

| Behavior boundary | Test seam | Observable result |
| --- | --- | --- |
| Durable Provider state | `ProviderCredentialRecordStore` contract, exercised with both file and in-memory Adapters | exact record outcome, revision conflict, isolated error |
| Profile lifecycle | `CredentialProfileManagement` | sanitized Provider projection or typed failure |
| Request binding and 429 transition | `ProviderAuthBindingAuthority` | exact managed/ambient facts, generation guard, or typed closed outcome |
| Pi credential resolution | Pi `CredentialStore` contract through the Backend-lifetime `Models`/`Models.getAuth()` use site | auth for the exact bound Profile and persisted silent refresh |
| Management API | Application Control Plane public query/command wire | strict secret-free response or typed command failure |
| Desktop flow | Renderer behavior through the typed preload API | visible state, enabled action, confirmation, and authoritative re-query |
| Semantic request | Semantic Conversion execution/handler seam | captured upstream request/response and Ledger facts |
| Responses Native request | `ProviderResponsesLane.execute()` | captured upstream wire/response and Ledger facts |
| Anthropic Native request | `AnthropicProviderNativeLane.execute()` | captured upstream wire/response and Ledger facts |
| Request attribution | Request Ledger query/projection Interface | bounded credential capture and attempt trail |
| Architecture | import/dependency contract test | forbidden lane, credential, or legacy dependency is absent |

Changing one of these seams is a contract change: update this plan and its acceptance test before continuing that slice. A production convenience helper is not a new test seam.

## 10.2 Per-behavior cycle

For every behavior listed in section 11:

1. **RED:** add one focused test through the owning seam, run the narrowest guarded command, and confirm that it fails for the missing behavior with an intelligible assertion;
2. **GREEN:** implement only enough production behavior to pass that test without adding a speculative abstraction or compatibility path;
3. repeat RED and GREEN for the next behavior in the same slice;
4. **REVIEW:** after the slice is behavior-complete and green, review module depth, names, duplication, information ownership, forbidden dependencies, and obsolete code; any review change that alters observable behavior starts a new RED step;
5. run the slice gate before beginning a dependent slice.

Refactoring is therefore a review activity after a coherent green slice, not a third step mixed into each RED/GREEN loop. A whole slice must never begin with all of its tests failing at once.

## 10.3 Test-double boundary

Use controllable Adapters only for boundaries outside the Module under test:

- Provider HTTP/network capture;
- browser, prompt, and login interaction;
- clock, random IDs, retry delay, and cancellation scheduling;
- filesystem, using either the real temporary directory Adapter or the in-memory Store contract Adapter;
- OS compression/content-encoding where deterministic injection is required.

Do not mock the State Owner's private collaborators, a lane's private body/header projectors, Pi AI IR conversion internals, lock helpers, or binding-context storage. Native body and envelope behavior is tested through the owning lane's `execute()` seam. Counting an external Adapter is permitted only when the public behavior is the presence or absence of that external side effect.

## 10.4 Fixtures and independent oracles

Test names describe caller-visible behavior. Every Provider Native expected request is a literal, reviewed fixture captured from the pinned Pi Agent source/reference run; expected values must not be generated by the same production projector being tested.

The Anthropic OAuth golden fixture records the exact allowed Claude Code identity/tool-name differential. The corresponding API-key fixture uses the same input body and proves that the exception is absent. Misleading token text is fixture data only and cannot select behavior.

Secret canaries are distinct for API key, access token, refresh token, Provider-private credential data, inbound authorization, display name, and note. Tests inspect every external projection, error, diagnostic, Activity fact, and persisted non-secret field without snapshotting raw secrets.

## 10.5 State-safety and commands

Every state-reaching test creates a new temporary `CODEX_HOME`, copies only `config.toml` and `token-model-catalog.json` when required, creates all other fixtures explicitly, passes that path to every spawned process, and removes it in `finally`. It never copies or writes the user's `auth.json`, Profile records, caches, sessions, logs, or credentials.

Use only repository-guarded test entry points:

```text
npm run test:unit
npm run test:integration
npm test
npm run test:release
npm run lint
npm run typecheck
```

During RED/GREEN, run the narrowest guarded target that contains the test. Run broader commands only at the stated slice gate and release gate.

## 10.6 Test homes

Keep tests organized by owning seam rather than implementation file:

```text
test/unit/provider-credential-profile-management.test.ts
test/unit/provider-auth-binding-authority.test.ts
test/unit/provider-credential-record-store-contract.test.ts
test/unit/profile-bound-pi-credential-store.test.ts
test/integration/provider-credential-profiles-control-plane.test.ts
test/integration/provider-credential-profiles-pi-binding.test.ts
test/integration/provider-credential-semantic-binding.test.ts
test/integration/provider-credential-request-capture.test.ts
test/integration/provider-credential-catalog-refresh.test.ts
test/integration/provider-credential-activity.test.ts
test/integration/provider-credential-429-switching.test.ts
test/certification/provider-native-auth-coverage.test.mjs
packages/desktop-shell/test/credential-profiles.test.tsx
```

Existing Provider Native, request-composition, Request Ledger, Providers page, lifecycle, architecture, and secret-hygiene suites are extended at their public seams. Replace obsolete expectations in place; do not preserve them in a parallel legacy suite.

---

# 11. Vertical TDD delivery slices

The order below is the implementation dependency order. Each numbered behavior is its own RED/GREEN cycle. A later behavior may use only seams made green by earlier slices.

## Slice 0 — harness and architecture fences

This slice changes test infrastructure and contract tests only; it does not pre-write feature tests.

1. Prove a state-reaching test receives a newly created explicit temporary `CODEX_HOME` and cleans it on success, failure, and cancellation.
2. Add import-contract assertions that can identify dependencies among Direct Mode, Provider Native Responses, Anthropic Provider Native, Semantic Conversion/Pi AI IR, and legacy `auth.json` authority code.
3. Add fixture loaders that treat pinned Pi request fixtures as immutable literal input.

Gate: the harness self-tests pass, a deliberately invalid dependency fixture is detected, and production behavior remains unchanged.

## Slice 1 — first durable multi-Profile management tracer

Primary production seams: `CredentialProfileManagement` plus `ProviderCredentialRecordStore` file and in-memory Adapters.

1. **RED:** add two Provider-declared non-OAuth Profiles and keep both with the first active; **GREEN:** implement the minimum Provider record, safe auth-method projection, optional identity hint, credential/selection generations, add operation, active pointer, and atomic file replacement.
2. **RED:** restart the State Owner, enumerate the persisted Provider ID, and query the same two sanitized Profiles; **GREEN:** implement Store-owned `listProviderIds()`, parsing, and stable per-Provider filename mapping.
3. **RED:** add an OAuth Profile beside an `api_key` Profile without changing either opaque auth payload; **GREEN:** add the Pi-discriminated credential payload record and validation without assuming `api_key` contains a literal key.
4. **RED:** mutate Providers A and B independently while A is corrupt; **GREEN:** add per-Provider locks, atomic revision CAS, and error isolation.

Gate: the same contract suite passes against the in-memory and file Store Adapters; Provider enumeration is owned by the Store; no Management result exposes a credential payload or invents a masked suffix; every file test uses isolated `CODEX_HOME`.

## Slice 2 — complete offline Profile lifecycle

Primary seam: `CredentialProfileManagement`. Add exactly one failing lifecycle behavior before its implementation.

1. rename and note one Profile without modifying a sibling;
2. reject a complete known secret used as name/note metadata;
3. change priority and active Profile with revision protection; prove metadata/priority changes preserve `selectionGeneration`, while a real active-pointer change advances it; disabling the active Profile clears the pointer without selecting a sibling;
4. remove an inactive Profile without touching siblings, then remove the active Profile and prove the pointer is cleared without selecting a sibling;
5. expose ambient-only, reconnect-required, disabled, cooling-down, and record-error projections without inventing credential state;
6. remove a runtime Provider implementation and prove the persisted orphan remains listed with safe labels/hints and local removal, while login, reconnect, recheck, and execution are unavailable;
7. return typed stale-revision, missing-Profile, cross-Provider, and duplicate failures;
8. prove two clients racing the same Provider produce one winner, while two Providers do not share a lock.

For each cycle, inject external Pi auth, Catalog, network, browser, and prompt Adapters that fail if invoked. Query, metadata changes, activation, enable/disable, priority, removal, and settings remain local operations.

Gate: all local lifecycle tests pass offline, no local mutation causes an interaction or Catalog refresh, and the Management Interface remains secret-free and cannot retrieve the Pi `CredentialStore`.

## Slice 3 — exact Pi binding and credential lifecycle

Primary seams: `ProviderAuthBindingAuthority` and the composition-private Pi `CredentialStore` as consumed by the single Backend-lifetime Pi `Models` object.

1. Bind managed `api_key` Profile A and prove `Models.getAuth()` resolves A even after the global active pointer changes to B; implement the minimum exact async binding with captured credential and selection generations.
2. With zero managed Profiles, capture `AmbientBinding` and prove Pi's original ambient path remains available; add one managed Profile with no valid active selection and prove the same operation now fails closed without ambient fallback.
3. Prove ambient facts have no fake `credentialId`, Profile attribution, persisted selection, `authType`, or Profile switching capability.
4. Start request A under Profile A, switch to B, start request B, and prove A remains on A while B uses B; extend binding lifetime across lazy stream consumption.
5. Resolve an OAuth Profile and persist a silent refresh only to that exact Profile without changing management revision, `credentialGeneration`, `selectionGeneration`, or user-visible `updatedAt`.
6. Hold one refresh callback in flight, perform rename/activation/remove through short Provider-file locks, and prove those management operations do not wait for OAuth network completion.
7. Race two refreshes of the same Profile and prove the per-credential refresh lock plus Pi's second expiry check produces at most one effective network refresh and one current payload.
8. Race refresh with rename/note and preserve both the refreshed payload and the metadata mutation.
9. Race refresh with remove and reconnect; prove remove completes immediately, reconnect regenerates `credentialGeneration`, and the late old refresh result is discarded without resurrecting or overwriting the Profile.
10. Prove missing, disabled, deleted, old-generation, and cross-Provider managed bindings fail closed before Pi ambient fallback.
11. Prove the Management and Binding Interfaces expose neither secret payloads nor a `credentialStore()` escape hatch; only composition can construct/inject the Pi Adapter.
12. Prove add/switch never reconstructs Provider registration, `Models`, or `Model` descriptors and never calls `Models.refresh()`.
13. Prove explicit Provider-scoped recheck may use network/silent refresh for later Catalog captures, never opens login interaction, changes the active pointer, or changes an in-flight request binding.

Gate: managed `api_key`, managed OAuth, and zero-managed ambient resolution use the one Pi Provider invocation contract; Data Plane stop/start does not recreate the State Owner or `Models`; Provider file locks are absent during network refresh; all concurrency and side-effect tests are green.

## Slice 4 — secret-free Application Control Plane cutover

Primary seam: strict public Control Plane query/command wire.

1. Query runtime and orphaned Providers and return the authoritative sanitized list, Backend-projected auth-method labels, optional identity hints, settings, availability, and bounded ambient facts.
2. Add a Provider-declared `api_key`-branch credential through `Models.login()` and its typed write-only interaction prompts; prove the returned frame contains only the sanitized Profile without assuming a literal key or mandatory masked suffix.
3. Publish a successful OAuth add through an exact pending add binding; cancellation publishes nothing.
4. Exercise rename/note, priority, activate, enable/disable, remove, and settings commands one at a time with authoritative post-mutation responses.
5. Exercise reconnect as an interactive exact-Profile operation and prove it is distinct from offline local removal.
6. Exercise explicit recheck as a labeled network operation that cannot open login interaction.
7. Remove an orphaned Provider Profile locally and reject its login/reconnect/recheck commands as unavailable.
8. Return typed conflict, cancellation, storage, ambient, and unavailable outcomes through the strict decoder.
9. Add wire-level secret canaries, then remove Provider-wide overwrite/import DTOs, decoders, CLI commands, and handlers only after the replacement commands are green.

Gate: no raw secret crosses the Control Plane; management works while the Data Plane listener is stopped or failed; no old and new mutation contract coexist.

## Slice 5 — desktop credential manager tracer

Primary seam: rendered user behavior through the typed preload API. Backend authority remains real or a public Control Plane test Adapter; Electron Main and preload are not reimplemented in test mocks.

1. Open a Provider card, query, add two Provider credential Profiles, name/note them, select one for use, and close/reopen to prove authoritative reconstruction.
2. Render mixed managed `api_key`/OAuth methods through Backend labels plus ambient-only, disabled, reconnect-required, cooling-down, loading, empty, orphaned-Provider, and Provider-record-error states.
3. Remove one Profile after a `Remove from Token` confirmation and leave its sibling unchanged.
4. Run OAuth `Disconnect from Token`/Reconnect through the explicit interaction flow, use the Provider auth-method label, and show ambient eligibility after last removal without claiming remote revocation.
5. Search by sanitized name, note, `authMethodLabel`, and optional `identityHint`; prove absent hints produce no invented masked identity.
6. Remove an orphaned Profile locally while provider-dependent actions remain visibly unavailable.
7. Surface stale revisions by re-querying authoritative state without silently replaying a destructive mutation.
8. Prove keyboard, focus, labeling, disabled-action, cancellation, and Backend-stopped behavior.

Gate: Renderer state contains sanitized projections only; secrets are write-only; typed preload/Main merely forward commands and do not gain Provider logic or file access.

## Slice 6 — Semantic Conversion request binding

Primary seam: Semantic Conversion execution/handler with a captured Provider-network Adapter.

1. Send the same client-protocol request with an active managed `api_key` Profile and prove the Pi Provider receives that exact bound credential.
2. Switch to an OAuth Profile and prove the same Semantic lane invokes the same Pi Provider contract with OAuth-resolved auth; auth type does not reroute the request.
3. Remove all managed Profiles and prove a later request uses `AmbientBinding`; add a managed Profile with no active selection and prove the request fails closed instead of falling back.
4. Switch while request A is streaming and prove request A retains its captured Profile while request B captures the new active Profile.
5. Inject conflicting inbound authorization/api-key headers and prove they neither select auth type nor become Pi `options.apiKey` or outbound Provider auth.
6. Add architecture assertions that Semantic Conversion imports neither Native lane's request, binding, retry, transport, response, nor Provider-native semantic types.

Gate: the Semantic seam alone proves managed `api_key`, managed OAuth, ambient/fail-closed binding, stream lifetime, inbound-auth exclusion, and lane independence. Ambient execution creates no Profile attribution. No Native implementation is imported as a test helper.

## Slice 7 — Provider Native Responses Pi-wire certification

Primary seam: `ProviderResponsesLane.execute()` with literal pinned Pi fixtures and a captured Provider-network Adapter.

Implement one certified managed `(provider, api/protocol, authType)` fixture per RED/GREEN cycle, including OpenAI `api_key`, Codex OAuth, Azure, or every other claimed combination. Add one explicit ambient contract cycle for each Native Provider/protocol combination that claims ambient support.

For each cycle:

1. prove the selected Profile auth type changes only the lane-owned Provider envelope, never lane routing;
2. prove the raw compatible body preserves every nested field/value/relationship and changes only the top-level `model`; where uncompressed, text outside the model span remains byte-identical;
3. compare method, URL, auth/account headers, Provider version/intent headers, session/request identity, SDK/User-Agent, accept/content type, and encoding with the literal pinned Pi fixture;
4. inject conflicting client transport/auth headers and prove no transport-owned field is overridden;
5. prove request A remains bound through the complete Native execution after an active switch.

Add the direct architecture fence in the first cycle: Responses Native and Semantic Conversion/Pi AI IR cannot import, call, wrap, or reuse each other's binding, request, execution, retry, transport, response, or semantic Modules.

Gate: the certification matrix contains no inferred or untested auth claim, no token-shape classifier, no generic inbound header passthrough, and no shared Native/Semantic executor.

## Slice 8 — Anthropic Provider Native and the sole body exception

Primary seam: `AnthropicProviderNativeLane.execute()` with literal pinned Pi fixtures.

1. For managed Anthropic `api_key` auth, prove the body changes only top-level `model` and the envelope matches pinned Pi behavior.
2. Add each required named, validated client-owned semantic header projection—starting with session identity—one at a time; reject generic header copying.
3. For first-party managed Anthropic OAuth only, make the literal golden differential fail, then implement the minimum Anthropic-owned Claude Code system identity and recognized tool-name projection.
4. Reuse the identical input under managed `api_key` and ambient bindings and prove the OAuth body projection is absent.
5. Put OAuth-shaped text in a managed `api_key` credential/body and prove captured `authType`, not token/body shape, selects the exception.
6. Certify GitHub Copilot and every other claimed Anthropic-native auth combination independently against pinned Pi wire fixtures.
7. Add fences proving the OAuth projector is private to Anthropic Native and imports no Pi AI IR, Pi Provider execution, Semantic Conversion, Responses Native, or Direct Mode Module.

Gate: every Anthropic-native body follows either the default model-only rule or the one exact OAuth exception; unrelated body semantics remain equal; all transport fields have an explicit owner.

## Slice 9 — request-time Activity attribution

Primary seam: Request Ledger query/projection Interface, reached first through one real Semantic request and then through each Native lane.

1. For a managed request, record the exact request-time `credentialId`, display-name snapshot, Backend auth-method label, internal auth type, lane, selection reason, attempt, and outcome.
2. Rename and delete the Profile after execution and prove retained Activity remains readable from its bounded snapshot.
3. Add latest-use/latest-success aggregation by `credentialId` without changing the Ledger schema version.
4. Surface the sanitized facts through Control Plane and desktop Activity using `authMethodLabel`, not hard-coded auth-type product copy.
5. Run an ambient request and prove no fake Profile capture, attempt, or identity appears.
6. Inject secret/note canaries and prove they are absent from Ledger facts, wire, UI, diagnostics, errors, and snapshots.

Gate: early failures may have absent facts, retained facts survive Profile lifecycle changes, validation bounds every string, and no lane imports another lane to report Activity.

Completion of slices 0–9 is the first complete non-429 release candidate.

## Slice 10 — switching policy and atomic successor selection

Primary seam: `ProviderAuthBindingAuthority`, with settings projected/mutated through `CredentialProfileManagement`.

1. Query default settings and prove internal `api_key`-branch and OAuth-branch automatic switching are independently off while product copy uses Provider auth-method labels.
2. Change each setting through revision-protected local CAS with no Pi, network, browser, prompt, or Catalog side effect.
3. On a final-429 fact whose credential generation, selection generation, and active identity still match, select the deterministic next enabled same-Provider, same-auth-type Profile, advance selection generation, and atomically update the global active pointer.
4. Reconnect the failed Profile without changing the active ID and prove its old 429 returns `stale_binding` because `credentialGeneration` changed.
5. Perform A→B→A and prove A's old 429 returns `stale_binding` because `selectionGeneration` changed even though the active ID matches again.
6. Rename/note or reprioritize while preserving credential/selection generations, then prove the transition uses the newest settings, enabled state, priority, cooldown, reconnect state, and attempted set rather than conflicting on management revision.
7. Race manual activation with automatic switching and prove the stale transition cannot overwrite the newer selection or roll it back.
8. Prove disabled, exhausted, ambient, unsafe, stale, and cross-Provider/type candidates do not switch.
9. Add runtime-only cooldown and validated `Retry-After` facts without persisting transient health as credential payload state.
10. Expose the immutable product limit `MAX_PROFILE_ATTEMPTS_PER_REQUEST = 3` without introducing shared retry state or an executor.

Gate: `advanceAfterFinal429()` owns only the state transition; it performs no retry, request dispatch, auth refresh, login, delay, or lane selection.

## Slice 11 — three independent final-429 retry integrations

Use the real Binding Authority seam with captured external Provider network, clock/delay, interaction, and cancellation Adapters. Do not create a shared retry executor.

1. **Semantic Conversion:** final 429 triggers its own outer Profile loop; the successor request receives a fresh exact Semantic binding and the first binding remains immutable.
2. **Provider Native Responses:** add the same observable policy through its independent Native loop and request builder.
3. **Anthropic Provider Native:** add the same observable policy through its independent Anthropic loop, re-evaluating auth-type-owned envelope/body behavior for the successor Profile.
4. For each lane, prove disabled policy returns the final 429 unchanged; non-429, partial-stream, unsafe-replay, exhausted, and storage-failure cases never switch.
5. For each lane, prove ambient binding never enters the Profile loop and a stale generation/selection result returns the final 429 without following another actor's selection.
6. For each lane, prove each Profile is attempted at most once and the total never exceeds `MAX_PROFILE_ATTEMPTS_PER_REQUEST = 3`, even when four or more alternatives are eligible; retain that lane's independent inner transport retry bound.
7. For each lane, prove cancellation is honored before delay/alternate dispatch, and successor auth/refresh failure stops without another switch, login interaction, or active-pointer rollback.
8. Record every managed attempt and `http_429_switch` reason through the lane's own Ledger calls.
9. Extend dependency fences to the three retry implementations.

Gate: all PRD 429 scenarios pass for managed `api_key` and OAuth pools; no request exceeds three outer Profile attempts; no switch crosses Provider, auth type, credential authority, or lane; equality of policy does not create shared retry state or a shared execution abstraction.

## Slice 12 — obsolete authority removal and release certification

Confirm the cutover assertions added by earlier slices are green. For any obsolete path not already removed with its replacement, add a failing repository/architecture assertion before deleting it:

1. production reads/writes through global `auth.json` and `src/pi/file-credential-store.ts` after reusable payload validation is relocated;
2. the old one-slot `src/credentials/authority.ts` implementation;
3. Provider-wide login/logout/import DTOs, wire decoders, CLI handlers, fixtures, and UI;
4. tests asserting global `auth.json` revision, overwrite, or import behavior;
5. compatibility readers, dual writers, legacy fallbacks, and automatic migration/deletion behavior.

An existing `auth.json` remains untouched obsolete user-owned state. Release notes state that Token ignores it and describe optional manual removal.

Release gate:

- run lint, typecheck, unit, integration, desktop, certification, full, and release suites through guarded commands;
- run the complete concurrency matrix: same-Provider management CAS, independent Providers, refresh/refresh, refresh/metadata, refresh/delete, refresh/reconnect, old-credential 429, manual/automatic switch, A→B→A ABA, capture/switch, remove/capture, and cancellation boundaries;
- run secret canaries across persistence projections, Control Plane, IPC, status, Activity, diagnostics, logs, errors, crash snapshots, Catalog, backups, and test snapshots;
- run the complete literal-fixture Provider Native auth/body/envelope matrix;
- run persisted/runtime Provider enumeration, orphan removal, managed/ambient fail-closed, and three-attempt cap matrices;
- verify repository dependency tests and searches show no production legacy authority and no cross-lane coupling;
- verify Direct Mode tests and imports remain unchanged by the feature.

---

# 12. Pull request sequence

PRs follow the vertical slices; they must not regroup work into storage-only, test-only, or UI-only horizontal batches. A PR may contain several adjacent small RED/GREEN commits, but every commit that changes behavior includes the focused test that drove it.

1. **Harness + durable management tracer** — slices 0–1.
2. **Offline Profile lifecycle** — slice 2.
3. **Exact Pi binding and lifecycle** — slice 3.
4. **Control Plane cutover** — slice 4; replacement and obsolete command removal land together.
5. **Desktop credential manager** — slice 5.
6. **Semantic Conversion binding** — slice 6.
7. **Responses Native certification** — slice 7.
8. **Anthropic Native certification** — slice 8.
9. **Activity attribution** — slice 9; this completes the non-429 release candidate.
10. **Switch policy and successor CAS** — slice 10, kept inaccessible/off until lane integration is green.
11. **Independent lane 429 loops** — slice 11.
12. **Legacy removal + release certification** — slice 12.

PRs 1–4 are an internal contract cutover and are not independently releasable. Both Native certification PRs must land before the first Profile-enabled release. Automatic switching ships only after PRs 10–11 pass the full matrix; until then both settings remain absent or off.

---

# 13. Definition of done

Implementation is complete only when:

1. one Provider stores and manages multiple Pi `api_key`-branch and OAuth Profiles independently without treating every non-OAuth payload as a literal key;
2. Backend projects bounded Provider `authMethodLabel` values and optional `identityHint` values, and Renderer never derives or invents them;
3. exactly one managed Profile may be active; managed Profiles with no valid active selection fail closed, while zero managed Profiles capture an ID-less `AmbientBinding` and preserve Pi ambient auth;
4. add, reconnect, rename, note, priority, activate, enable, disable, remove, disconnect, and settings mutations are protected by the Provider management `revision`;
5. `credentialGeneration` changes only for logical credential replacement, `selectionGeneration` changes only for actual active-pointer changes, and Data Plane capture uses both instead of management `revision`;
6. one Backend-lifetime Pi `Models` resolves and refreshes only the exact managed binding or uses Pi ambient auth only under a zero-managed ambient binding;
7. OAuth refresh serializes per `credentialId`, performs no network I/O under a Provider file lock, and publishes only if the Profile still exists with the same `credentialGeneration`;
8. silent OAuth refresh preserves both generations, management revision, active pointer, and user-visible timestamp; deletion/reconnect cannot be undone by a late refresh and no mutation can touch a sibling;
9. Management and Binding Interfaces are secret-free, and the secret-bearing Pi `CredentialStore` Adapter is constructible/retrievable only inside composition;
10. persisted Provider IDs are Store-enumerable, and orphaned valid records remain sanitized, queryable, and locally removable while Provider-dependent actions are unavailable;
11. Provider Native and Semantic Conversion retain independent execution and failure lifecycles;
12. every claimed managed Provider Native auth type and every claimed ambient Native contract is certified without token-shape or `AuthResult.source` inference;
13. each Provider Native body follows the default top-level `model`-only rule or the sole managed Anthropic OAuth identity/tool-name exception, and every reconstructed transport envelope matches the pinned Pi Agent behavior for the selected binding;
14. Provider Native Responses and Semantic Conversion/Pi AI IR do not import, call, wrap, or reuse each other's credential-binding Adapter, request construction, execution, transport, retry, response handling, or semantic types;
15. Provider-backed lanes never inspect inbound request credentials to choose auth type, never use them for outbound Provider auth, and expose no generic Native header passthrough;
16. Activity records exact managed request-time Profile/auth-method/lane/attempt facts without secrets or notes, while ambient execution invents no Profile attribution;
17. default-off HTTP 429 switching is managed-only, same-Provider, same-type, same-lane, pre-commit, generation-guarded, and limited to `MAX_PROFILE_ATTEMPTS_PER_REQUEST = 3` outer attempts per request;
18. Provider management works while the Data Plane is stopped or failed, and one corrupt Provider record does not affect another;
19. obsolete `auth.json` production reads/writes, import DTOs, and compatibility code are removed;
20. query and local mutations are offline, non-interactive operations; only explicit login/reconnect may open an interaction;
21. changing the active Profile never refreshes Catalog or recreates Pi `Models`/`Model` descriptors;
22. successful login/reconnect schedules only an exact-active-Profile background Catalog run; stale results/cache writes are discarded and auth success is independent of Catalog outcome;
23. every new behavior is backed by a seam-level test observed failing before implementation, Native wire expectations come from independent literal fixtures, and all guarded test/release gates pass.
