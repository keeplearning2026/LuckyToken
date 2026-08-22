# LuckyToken Provider Credential Profiles PRD v1.5

**Status:** FROZEN PRODUCT REQUIREMENTS
**Date:** 2026-08-22
**Scope:** Multiple managed Provider credential Profiles across Pi's `api_key` and `oauth` branches, credential metadata, lifecycle management, one active credential, request binding, Provider Native Pi-wire reconstruction, and desktop product flows
**Related specifications:**

- [LuckyToken Provider Activation Specification](./LuckyTokenProviderActivationSpec.md)
- [LuckyToken Electron Product Architecture Specification](./LuckyTokenElectronArchitectureSpec.md)
- [LuckyToken Core Architecture Specification](./LuckyTokenCoreSpec.md)
- [Repository architecture rules](../../AGENTS.md)

This document defines the target product contract. It is a PRD, not an implementation specification. It fixes the Provider-isolated authority and request behavior; exact file paths, package boundaries, and wire schemas must still be decided from source evidence during implementation design.

---

# 1. Executive summary

LuckyToken currently presents one effective stored credential per Provider. A second API key or OAuth login replaces the first, and the desktop product does not expose a complete remove/disconnect workflow. Users also cannot name or describe credentials, identify which credential served a request, or keep multiple authorized identities ready for the same Provider.

LuckyToken must introduce **Provider Credential Profiles**: multiple independently managed Provider credentials under one Provider. Pi's `api_key` branch includes literal API keys, bearer tokens, cloud profiles, service-account configuration, existing credential chains, and other Provider-declared non-OAuth methods; it is not a product assertion that every such Profile contains a literal key. Every managed Profile has a stable identity, a user-visible name, an optional note, a Provider-declared authentication-method label, an optional safe identity hint, lifecycle state, and request-selection eligibility. Users can add, rename, disable, reconnect, remove, or disconnect one Profile without mutating siblings.

The first release prioritizes control and safety over sophisticated load balancing. Each Provider has at most one active managed credential at a time across both Pi auth branches. Manual or automatic switching is a local, non-interactive update of that one active pointer for subsequent requests; a request that has already captured a managed or ambient binding keeps it for its lifetime. A managed OAuth request may perform Pi's non-interactive token refresh when needed, and Activity attributes only exact captured managed Profiles.

Automatic switching is limited to two Provider-scoped settings that are off by default: switching within the Provider's `api_key` branch and switching within its `oauth` branch after a final HTTP 429. The UI renders each setting with the Backend-projected Provider authentication-method label rather than hard-coded `API key` or `account` ontology. Automatic switching stays within the current Pi auth branch and already selected lane, with at most three Profile attempts for one client request. Round-robin, session-affine credential selection, quota optimization, team secret sharing, and cross-device sync are later or separate product decisions.

The current Data Plane accepts Client Protocol HTTP requests only on the fixed loopback host `127.0.0.1`. OpenAI Responses, Anthropic Messages, and other local API request wires describe the client-facing protocol; they do not declare which upstream Provider authentication method to use. The request's model/protocol capability selects Provider Native or Semantic Conversion, after which the selected lane consumes the Backend's managed or ambient auth binding. An inbound `Authorization` or other credential-shaped header never selects or overrides that binding.

Provider Native is not blind HTTP passthrough. Its client body remains the authoritative model-visible request and normally changes only at the boundary-required top-level `model` projection. The sole declared exception is first-party Anthropic Messages with a captured managed OAuth Profile, which applies only the pinned Pi Agent's confirmed OAuth-dependent Claude Code identity and tool-name projections. The outbound transport envelope is reconstructed as the pinned Pi Agent implementation would send it for the captured managed or ambient binding and resolved Pi Model. Binding/Pi-owned URL, authentication, account identity, Provider headers, version/beta headers, session headers, User-Agent, and content encoding never inherit conflicting client values.

Credential profiles are Provider-side infrastructure state. They never enter Pi AI IR or model-visible semantics, and they do not create a shared execution, credential, transport, or fallback abstraction across LuckyToken's independent data-plane lanes. Local Native credential behavior is outside this PRD.

---

# 2. Confirmed current product behavior

The following are confirmed by the current specifications and source:

1. Pi's current `CredentialStore` is keyed by `Provider.id` and stores one credential per Provider.
2. LuckyToken's file credential store persists `Record<providerId, Credential>` in `auth.json`.
3. LuckyToken's `LiveCredentialAuthority` exposes one bounded `ProviderAuthStatus` row per Provider.
4. Request auth currently resolves through `Models.getAuth(providerId)` or `Models.getAuth(model)`.
5. Backend and Control Plane contracts support deleting the Provider's stored slot through `logout`.
6. The Electron bridge exposes credential commands, but the current Providers page exposes login only; users cannot remove the stored API key or disconnect the OAuth account through the normal desktop flow.
7. Pi separates interactive Provider login from OAuth token refresh. `Models.login()` uses Provider-owned interaction callbacks and may open a browser or prompt the user; `Models.getAuth()` may perform a non-interactive network token exchange when a bound OAuth token is near expiry.
8. Pi request authentication resolves one credential at a time. A stored credential's `type` selects API-key or OAuth resolution, while an explicitly supplied request `apiKey` would override stored OAuth for Providers that support API keys.
9. Pi's `ApiKeyCredential` has optional `key` and `env` fields. `ApiKeyAuth.name` supplies the Provider method label and optional `apiKey.login` owns setup prompts. Current Bedrock and Vertex implementations use this branch for bearer tokens, cloud profiles, existing credential chains, ADC, service-account configuration, and literal keys.
10. Provider Native transports bypass Pi Provider semantic execution. They may consume `Models.getAuth()`, but each transport still owns the Provider-specific wire projection of the resolved authentication.
11. The production Data Plane host is fixed to `127.0.0.1`; current local Client Protocol routes include `POST /v1/responses`, `POST /v1/responses/compact`, and `POST /v1/messages`.
12. OpenAI Responses request identity is derived from bounded session headers or a generated UUID, not from inbound `Authorization`. Provider Native Responses creates fresh upstream headers from the resolved Pi `AuthResult`; it does not forward client authorization headers.
13. Pi `Models.refresh()` refreshes Provider model/catalog facts and may use the network. It does not change the active LuckyToken profile and is not required merely because `activeCredentialId` changed.
14. Provider Native Anthropic currently forwards a generic allowlist of client headers before applying composed Provider headers. This is a current implementation behavior, not the target contract; a generic inbound-header passthrough cannot prove Pi Agent wire fidelity or ownership for both `api_key` and OAuth Profiles.

Therefore this is not a small Renderer-only enhancement. Multiple profiles replace the current one-Provider/one-slot product contract and require a new authoritative representation.

---

# 3. Customer problem

## 3.1 Reported pain

Customers report three related failures:

- one Provider can use only one API key or one logged-in account;
- the product does not provide an obvious way to delete an API key or log out an account;
- multiple keys or accounts would still be difficult to use without names and notes.

## 3.2 What breaks for the customer

The current product forces users to overwrite working credentials, remember opaque key suffixes outside LuckyToken, and lose Provider access when the only credential expires or is rate-limited. It also weakens trust because a user who gives LuckyToken a secret cannot remove that secret through the same product surface.

Without profile names and request attribution, multi-credential support would remain unsafe: users could select, disable, or delete the wrong credential and could not explain cost, quota, or authentication failures.

## 3.3 Product opportunity

Credential Profiles let LuckyToken become a reliable Provider access manager rather than a single-credential setup screen. The differentiating value is not merely storing more secrets; it is keeping authorized identities understandable, healthy, removable, and predictably selected.

---

# 4. Target users and jobs

## 4.1 Primary users

- an individual developer with separate personal, work, and project credentials;
- an operator running LuckyToken continuously for several clients or workflows;
- a small team administrator who needs understandable credential ownership and failure recovery on one machine.

Team permissions and cloud sharing are not part of this PRD.

## 4.2 Jobs to be done

Users need to:

1. connect more than one authorized API key or account to the same Provider;
2. understand which credential is which without revealing the secret;
3. choose the one active credential and temporarily disable another;
4. keep a selected OAuth credential usable through non-interactive refresh when the Provider supports it;
5. continue serving through another eligible same-type credential when opt-in HTTP 429 handling is safe;
6. remove one API key or disconnect one account without affecting siblings;
7. see which credential profile served a request;
8. understand when LuckyToken removed only local material versus revoked remote authorization.

---

# 5. Product principles

## 5.1 User control before automation

Users must be able to see, name, disable, and remove every LuckyToken-managed credential before LuckyToken automatically selects among them.

## 5.2 Stable identity, editable presentation

Routing and lifecycle operations use an immutable `credentialId`. A user may rename a profile or edit its note without changing active identity, health history, request attribution, or selection behavior.

## 5.3 No secret redisplay

After capture, LuckyToken never returns a complete API key, access token, or refresh token to Renderer, Control Plane projections, Activity, diagnostics, logs, or error messages.

## 5.4 Honest logout semantics

LuckyToken distinguishes local removal from Provider-side revocation. It never claims that an API key was revoked remotely merely because the local copy was deleted.

## 5.5 Predictable selection

The first product contract uses one explicit active credential per Provider. All new requests use that profile until a manual or permitted automatic switch changes the active pointer. Without user opt-in, an unavailable or rate-limited credential fails and the user switches manually. Optional 429 switching follows user priority within the same credential type; it does not introduce session-local or opaque random rotation.

## 5.6 Lane isolation remains authoritative

Credential-profile management does not change protocol conversion or lane-isolation semantics. Provider Native and Semantic Conversion each resolve and capture the managed-or-ambient Provider binding through their own lane-owned seam. Provider Native applies only the explicit managed-OAuth Anthropic body exception defined in section 9; Semantic Conversion remains unchanged. The lanes do not receive a shared preselected credential object. Once the Client Protocol contract selects a lane, the binding cannot redirect that request to another lane; failure never falls through after execution begins.

## 5.7 Client request wire never selects Provider auth

Provider Native and Semantic Conversion never inspect or classify inbound client headers to decide the upstream Pi auth branch. They use the Backend-selected managed or ambient binding. Credential-shaped inbound headers are excluded from Pi `options.apiKey`, Pi CredentialStore, Provider headers, Activity attribution, and automatic switching. The loopback address is a transport exposure constraint, not a Provider-auth input.

## 5.8 No hidden interaction

Profile query, metadata editing, activation, enable/disable, priority changes, switching, and local removal are local state operations. They do not call Pi auth operations, contact a Provider, open a browser, or prompt the user. A token refresh is a non-interactive network exchange performed only while an exact OAuth profile is being consumed, explicitly rechecked, or used by the exact-profile post-login Catalog refresh defined below. Interactive login or reconnect begins only from an explicit user action.

---

# 6. Domain model

## 6.1 Provider Credential Profile

A **Provider Credential Profile** is one LuckyToken-managed credential belonging to one Provider. `authType` is Pi's two-branch authentication discriminant, not the product name or a claim about the credential payload's physical form.

Conceptual product shape:

```ts
interface CredentialProfile {
  readonly credentialId: string;
  readonly providerId: string;
  readonly authType: "api_key" | "oauth";
  readonly authMethodLabel: string;
  readonly displayName: string;
  readonly note?: string;
  readonly identityHint?: string;
  readonly enabled: boolean;
  readonly health: CredentialHealth;
  readonly priority: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt?: number;
  readonly lastSucceededAt?: number;
}
```

This shape is illustrative. Secrets and Provider-private credential material are intentionally absent.

## 6.2 Provider credential state

Each Provider owns one independent authoritative state record:

```ts
interface ProviderCredentialState {
  readonly providerId: string;
  readonly revision: string;
  readonly selectionGeneration: string;
  readonly activeCredentialId?: string;
  readonly profiles: readonly CredentialProfile[];
  readonly apiKeyOn429: boolean;
  readonly oauthOn429: boolean;
}
```

There is at most one `activeCredentialId` across both Pi auth branches. LuckyToken does not maintain separate active pointers by auth type, because that would recreate request-time ambiguity.

`revision` is the Provider's user-visible management concurrency token. It changes for committed add/reconnect, metadata, enable/disable, priority, removal, active-pointer, and switch-policy mutations. It is not captured by Data Plane requests and is not the 429 selection guard.

`selectionGeneration` is an opaque Provider selection token. It changes only when `activeCredentialId` actually changes, including first activation and clearing the active pointer. Re-selecting the already active Profile is not a selection change. The Data Plane captures it to detect manual/automatic races and `A → B → A` ABA changes without treating rename or note edits as selection conflicts.

Each persisted Profile also owns an opaque `credentialGeneration`, initialized on add and regenerated on reconnect or any other logical credential replacement. Silent OAuth token rotation preserves `credentialGeneration`, `selectionGeneration`, `revision`, and user-visible `updatedAt`. This distinguishes a new logical credential incarnation from maintenance of the same OAuth credential.

The common profile envelope is intentionally small. Provider-specific credential payloads remain opaque to the Profile State Owner's common lifecycle logic and are interpreted only through the composition-private Provider/Pi authentication contract. Providers are not required to share one credential payload schema merely because their profiles share lifecycle metadata.

## 6.3 Identity rules

- `credentialId` is opaque, immutable, and unique for the lifetime of the profile.
- `providerId` is immutable.
- `authType` is immutable; changing Pi auth branch creates a new Profile.
- `authMethodLabel` is a bounded Backend projection of the Provider-declared auth method, such as `OpenAI API key`, `AWS credentials or bearer token`, or `Anthropic (Claude Pro/Max)`. Renderer never derives it from Pi metadata directly.
- `displayName` is editable and case-insensitively unique within one Provider.
- `note` is editable, optional, and limited to 200 characters in v1.
- `identityHint` is optional, generated by LuckyToken, and never routing input. A literal key may use a safe masked suffix such as `•••• 7K2P`; a cloud profile, credential chain, service-account configuration, or opaque OAuth credential may have no safe hint.
- V1 does not claim a real OAuth account identity. The current Pi auth contract does not expose typed account metadata, and LuckyToken must not guess an email or account ID by parsing an opaque token.

## 6.4 Default names

- All auth methods use neutral deterministic suggestions such as `Profile 1`, `Profile 2`, and so on. The Provider-declared `authMethodLabel` is shown separately.
- The user may edit the suggested name before or after saving.

## 6.5 Credential health

The product needs bounded, actionable states rather than raw errors:

```text
ready
not_yet_verified
refreshing
cooling_down
reconnect_required
disabled
unavailable
```

Provider-specific error text does not become a new generic state. Backend maps only demonstrated, actionable conditions into the bounded product contract.

## 6.6 External auth source

Environment variables, `models.json`, command-derived configuration, cloud profiles, and other Provider ambient sources are not LuckyToken-managed credential profiles.

They are presented as **External auth sources** with locally known configuration and, when available, bounded last-known health. Side-effect-free query does not execute a credential command, contact a Provider, or claim live availability; unknown remains unknown until an actual request or explicit recheck supplies evidence. LuckyToken does not offer rename, notes, delete, logout, automatic pool selection, or remote revocation for a source it does not own. The UI explains where the user must edit or remove that source. An external source never replaces an active managed Profile.

Request selection mirrors Pi's stored-wins/otherwise-ambient contract exactly: when any managed Profile exists, a valid active managed Profile is required and missing/disabled/unavailable active state fails closed without ambient fallback; when zero managed Profiles exist, an operation-local ambient binding may allow Pi to resolve its existing external sources. Ambient binding is not a persisted selection or Profile and needs no product selector.

---

# 7. Core user experience

## 7.1 Provider summary

The Providers page keeps one card per Provider. A connected card shows a bounded summary such as:

```text
3 credentials · 2 ready · 1 needs attention
```

The card's primary action becomes `Manage credentials`. Provider model management remains a separate action.

The summary must not expand every profile into the Provider grid. Credential-level actions belong in one focused management view.

## 7.2 Credential management view

The view lists one row per managed profile and a separate read-only section for external auth sources.

Each managed row shows:

- display name;
- Backend-projected Provider authentication-method label;
- optional safe identity hint when one exists;
- status;
- optional note;
- last used time;
- active/priority position;
- actions: use now, enable/disable, edit details, reconnect when applicable, and remove/disconnect.

Users can search by display name, note, authentication-method label, or optional safe identity hint.

## 7.3 Add a Provider credential

1. User chooses the Provider-declared non-OAuth authentication method, for example `OpenAI API key`, `AWS credentials or bearer token`, or `Google Cloud credentials`.
2. LuckyToken shows the Provider-owned `api_key`-branch interaction without relabeling it as a literal key.
3. User supplies a display name and optional note.
4. Backend persists the returned Provider credential payload and Profile atomically in the Provider's independent record.
5. Backend validates only local shape and storage invariants; successful Provider-owned setup publication does not perform a separate Provider probe or Pi auth check.
6. The Profile begins as `not_yet_verified`; the first real attributed request supplies success/failure evidence, and LuckyToken does not spend tokens merely to test it.
7. The result returns only sanitized Profile metadata, including `authMethodLabel` and optional `identityHint`.

The first managed profile for a Provider becomes active. Adding a sibling profile does not replace an existing active profile unless the user explicitly chooses `Save and use now`.

An occupied Provider no longer triggers overwrite confirmation. A duplicate managed credential payload may be rejected without revealing which existing Profile owns it.

## 7.4 Add an OAuth Profile

1. User chooses the Provider-owned OAuth label, such as `Anthropic (Claude Pro/Max)` or `GitHub Copilot`; the UI does not assume every OAuth method is named `Account`.
2. Existing typed auth interactions continue to drive browser, device-code, progress, and prompt steps.
3. A profile is created only after successful login.
4. LuckyToken suggests a neutral name such as `Profile 1`; it does not parse token claims to guess a user identity.
5. User supplies or edits the name and optional note.
6. Each OAuth Profile stores and refreshes its own token set independently.
7. The first managed Profile for a Provider becomes active; a later login changes the active Profile only when the user explicitly chooses to use the new Profile now.

Cancelling or failing login leaves no partially created profile.

## 7.5 Edit name and note

- Editing metadata never requires secret re-entry.
- Renaming does not change `credentialId`, active selection, priority, or request history association.
- Names are 1–64 visible characters and unique within the Provider.
- Notes are optional, up to 200 characters, and never projected into requests, provider headers, Activity records, or logs.
- The product warns users not to put secrets in names or notes. Backend rejects metadata that contains a complete secret value already known to the Profile State Owner.

## 7.6 Enable and disable

- Disable removes the profile from new request selection without deleting secret material.
- In-flight requests that already resolved request-local Provider auth are not cancelled or rebound merely because the Profile is disabled.
- Re-enable returns the profile to selection only if its health is otherwise eligible.
- Disabling the active profile clears `activeCredentialId` and does not silently choose another profile. The user must select a replacement; until then, new requests that require a managed profile fail explicitly.

## 7.7 Remove a managed Provider credential

The destructive action is labeled `Remove from LuckyToken`.

Confirmation identifies the Provider, display name, authentication-method label, and optional identity hint and states:

- LuckyToken will delete its local copy;
- new requests will stop using this profile;
- the underlying Provider credential may remain valid and must be revoked or removed through the Provider/cloud source when required;
- models, aliases, Activity records, and sibling profiles are not deleted.

After confirmation, the secret and current profile metadata are deleted immediately. Removing the active profile clears `activeCredentialId`; no sibling is silently activated. The Profile State Owner does not keep a profile tombstone. Existing Activity records retain only their own bounded, sanitized request-time display-name/auth-method snapshots for the normal Request Ledger retention period; the confirmation discloses that historical Activity remains.

## 7.8 Disconnect an OAuth Profile

The destructive action is labeled `Disconnect from LuckyToken` and includes the Provider-declared OAuth method label.

V1 removes LuckyToken's local access and refresh tokens only. It does not claim to revoke authorization at the Provider because the current Pi OAuth contract exposes no standard remote-revocation operation. The confirmation directs the user to the Provider when remote revocation is required.

## 7.9 External-source removal

If the last managed Profile is removed while an environment, `models.json`, or other ambient source is locally configured, the Provider may still authenticate through Pi's existing ambient contract. The mutation result displays that configured source and its bounded last-known/unknown status without probing it, and must not show the false success message `Provider disconnected`.

---

# 8. Credential selection

## 8.1 One active credential per Provider

V1 has at most one active managed Profile per Provider across both Pi auth branches. Manual switching updates the Provider's authoritative `activeCredentialId`; it does not create a session override, request override, separate authentication-mode toggle, or second active pointer.

If the active profile is missing, disabled, or unavailable, the request fails explicitly. LuckyToken does not silently choose a lower-priority sibling or ambient source and does not choose a different data-plane lane because of the profile type.

When the Provider has zero managed Profiles, the request captures an operation-local `AmbientBinding` and Pi may resolve its existing ambient source. `AmbientBinding` has no `credentialId`, is not persisted, does not enter the Profile pool or Profile 429 switching, and produces no Profile attribution. There is no External Profile selector.

## 8.2 Request capture and switching

After the Client Protocol contract selects a Provider-backed lane, that lane captures exactly one discriminated `ProviderAuthBinding` before Provider authentication or execution begins:

```ts
type ProviderAuthBinding =
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

Every auth-consuming operation inside a managed lane execution resolves through that exact binding. Provider Native and Semantic Conversion establish independent bindings and do not pass a credential object between lanes. Management `revision` is not a Data Plane capture fact.

Changing `activeCredentialId` affects only requests that capture after the committed switch. In-flight requests retain their captured credential even when another user action or HTTP 429 switches the Provider globally. Display names and notes never participate in binding.

Capture retains Profile identity, not a second long-lived secret copy. A pointer switch leaves the captured Profile present, so the request continues under that Profile. Removal is different: if the request already resolved Provider auth, it may finish with its request-local value; if removal commits before the bound auth read/refresh, the missing Profile fails closed. LuckyToken does not resurrect or retain a deleted Profile merely to make an in-flight request succeed.

Manual activation and automatic 429 switching commit only the Provider record's active pointer, `selectionGeneration`, and management `revision`. They do not call `Models.getAuth()`, `Models.checkAuth()`, `Models.refresh()`, or `Models.login()`; they perform no Provider network request and cannot open a browser. Pi `Model` objects are Provider/model descriptors rather than credential containers, so switching Profiles does not recreate or update `Models`.

The implementation must fail closed if a Provider-backed auth operation that requires a managed profile executes without an exact profile binding. It must not fall back to the current active profile late in the operation, because the active pointer may have changed since request start.

## 8.3 Provider-scoped 429 settings

Each Provider exposes two independent settings in its credential-management surface:

```text
Automatic switching on HTTP 429

[ ] Try the next <Provider non-OAuth authMethodLabel> after HTTP 429
[ ] Try the next <Provider OAuth authMethodLabel> after HTTP 429
```

Both settings default to `off`. They are owned by the Provider Credential Profile capability, even if the UI presents them as settings. They are not one global application toggle because Provider billing, limits, and authentication-method semantics differ.

## 8.4 HTTP 429 switching contract

Automatic switching occurs only when all of the following are true:

- the matching Provider setting is enabled;
- the already selected lane's existing Provider/transport retry contract has returned a final HTTP 429;
- no client-visible response or model output has been committed;
- the alternative profile belongs to the same Provider, credential authority, selected lane, and auth type;
- the alternative is enabled, not cooling down, not known to require reconnect, and has not already been attempted for this request;
- request cancellation and the lane's total retry limits remain honored.

`api_key` Profiles switch only to `api_key` Profiles. `oauth` Profiles switch only to `oauth` Profiles. Eligible alternatives follow user priority, with equal priority broken deterministically by `credentialId`. Each Profile is attempted at most once, and `MAX_PROFILE_ATTEMPTS_PER_REQUEST` is fixed at `3`, including the initial Profile. Reaching that cap returns the final 429 even when more eligible Profiles exist. Each lane continues to enforce its own existing inner transport-retry limit, making the maximum Provider dispatch count for that lane calculable as `3 × (max transport retries + 1)`.

Before retrying with an alternative, LuckyToken enters the latest Provider record lock and verifies that the failed Profile still exists, its `credentialGeneration` equals the failed managed binding, the record's `selectionGeneration` equals the failed binding, and `activeCredentialId` still equals the failed `credentialId`. Only then does it use the latest switch setting, enabled state, priority, cooldown, reconnect state, and attempted set to choose a successor. It atomically updates `activeCredentialId`, advances `selectionGeneration` and management `revision`, and captures the successor. A mismatch is stale state and cannot overwrite reconnect, manual/automatic selection, or `A → B → A` ABA history; rename or note changes alone do not cause a selection conflict.

V1 does not switch credentials for 401, 403, 5xx, network failures, OAuth refresh failures, storage failures, or any inferred quota condition. If the committed OAuth successor cannot be resolved because its silent token refresh fails, that retry stops with the auth failure: LuckyToken does not try a third profile, roll back the committed active pointer, start login, or open a browser. Failure in the selected Provider Native or Semantic Conversion lane never falls through to the other lane.

## 8.5 Cooling-down behavior

A valid explicit `Retry-After` (or an equivalent typed Provider fact) may mark the attempted profile `cooling_down` until the declared time. Without that evidence, LuckyToken excludes the profile only from the current request attempt set and does not invent a cooldown duration.

## 8.6 Deferred policies

The following are not part of v1:

- round-robin rotation;
- least-recently-used selection;
- quota-aware or cost-aware optimization;
- randomized distribution;
- cross-Provider or cross-lane failover;
- automatic switching between Pi's `api_key` and `oauth` branches;
- automatic switching on non-429 failures;
- strategies marketed as bypassing Provider limits or account enforcement.

These require separate evidence, Provider contract review, and product controls.

---

# 9. Provider Native credential completeness

## 9.1 Product contract

The local HTTP request interface and Provider credential selection are separate facts. A client always sends the configured Client Protocol API wire to LuckyToken on `127.0.0.1`; it does not choose an upstream authentication mode. Selecting a managed Profile from either Pi auth branch, or using the permitted ambient binding, does not change Client Protocol semantics, lane selection, or response format.

The pinned Pi source confirms the intended rule. `Models.streamSimple()` calls its auth-preparation path, which calls `Models.getAuth(model)`. With no request-level `apiKey` override, `resolveProviderAuth()` reads the stored credential and branches on `stored.type`: `api_key` resolves through the Provider's non-OAuth auth implementation and `oauth` resolves through its OAuth implementation. When no stored credential exists, Pi may use ambient resolution. LuckyToken preserves this behavior by presenting the exact managed Profile or permitted ambient scope and by never constructing the override from the inbound HTTP request.

Provider Native uses the same selection rule without entering Pi Provider semantic execution: it calls `Models.getAuth(model)` under the captured Provider auth binding, then its own transport reconstructs the request envelope that the pinned Pi Agent Provider implementation would produce for that resolved auth. When that projection requires the Pi auth branch, it uses the managed binding's authoritative `authType` or the explicit ambient binding; it never tries to rediscover the type from the inbound request, `AuthResult` shape, or token text.

The Provider Native authority split is exact:

- the compatible client body owns model-visible request semantics;
- the resolved Pi Model owns the upstream Provider, API/protocol, Provider model id or deployment, base URL, static headers, and compatibility facts;
- the captured managed-or-ambient binding and bound `AuthResult` own authentication mode, credential material, auth-specific headers, account identity, and auth-specific base URL/environment facts;
- the selected operation and request-local lifecycle own method, endpoint suffix, session/request identity, cancellation, and response commitment;
- the pinned Pi Agent Provider implementation is the mirror reference for the resulting Provider wire.

Consequently, Provider Native is neither semantic conversion nor blind header passthrough. It preserves the body semantics while rebuilding the Pi-owned transport envelope.

The one exception to literal body preservation is `(providerId=anthropic, api=anthropic-messages, authType=oauth)`. Current pinned Pi source changes the request body for this authentication mode by adding the required Claude Code system identity and projecting recognized Claude Code tool names consistently through tool definitions and related message references. LuckyToken mirrors only that confirmed OAuth differential inside the Anthropic Native lane. The exception does not authorize general Anthropic normalization, Pi AI IR conversion, invented defaults, malformed-body repair, or changes to unrelated fields.

Provider Native nonetheless owns Provider-wire authentication. When an explicit `(providerId, provider api/protocol, operation)` transport contract claims a request, that claim includes every managed authentication type the same Provider exposes to the product. `api_key` and OAuth coverage are not separately selectable runtime capabilities.

Support for one authentication wire does not technically prove the other, so both still require implementation and tests. A generic `auth.apiKey` field is not evidence of API-key authentication because Pi may place an OAuth access token in that request-auth field. If a Native transport has not implemented every Provider-exposed managed auth type, that Provider Native transport is incomplete and must not ship as a claimed product capability.

## 9.2 Responses request flow

For the OpenAI Responses Client Protocol, the existing local-API lane contract remains authoritative:

```text
POST http://127.0.0.1:<port>/v1/responses
→ existing protocol/model capability selects one lane
    ├─ Provider Native Responses
    │    → capture managed or ambient Provider binding in the Native lane
    │    → Models.getAuth(model) under that binding
    │    → provider-native request and response wire
    │
    └─ Semantic Conversion
         → capture managed or ambient Provider binding in the Semantic lane
         → Pi Provider execution under that binding
         → Pi AI IR → Responses rendering
```

Provider Native does not perform a second credential-type eligibility decision and does not redirect to Semantic Conversion because of the selected auth branch or ambient binding. Semantic Conversion likewise does not inspect a Native result or credential choice. Once either lane begins, failure never falls through to the other. Local Native Responses is an independent contract and is not changed or otherwise specified by this PRD.

Provider Native Responses and Semantic Conversion/Pi AI IR are absolutely uncoupled execution paths. Neither may import, call, wrap, or reuse the other's request construction, credential-binding Adapter, execution, transport, retry state, response handling, or semantic types. They may independently consume the Backend-lifetime Pi `Models` capabilities and minimum request-lifecycle facts permitted by the repository architecture. Pi Agent source is a mirror reference for Native wire reconstruction, not a route into Pi Provider execution or Pi AI IR.

## 9.3 Provider Native execution

When Provider Native is eligible, the lane:

1. calls `Models.getAuth(model)` under the exact captured profile binding without an inbound/request-level `apiKey` override;
2. lets Pi perform a non-interactive network token refresh when the captured OAuth credential needs it and publish the result back to that exact profile;
3. receives Pi's resolved `AuthResult` plus the captured authoritative `authType` when the Provider-specific wire construction needs that discriminant;
4. parses the compatible client body only enough to validate and replace its top-level `model` selector with the resolved Provider model/deployment identity;
5. leaves every other body field, value, relationship, and model-visible semantic unchanged, except that first-party Anthropic Messages under the captured OAuth Profile applies the exact pinned OAuth identity/tool-name projection defined above;
6. reconstructs the upstream method, URL, auth, account identity, Provider/version/beta/session/User-Agent headers, and content encoding/compression from the resolved Model, captured managed-or-ambient binding, request-local lifecycle facts, and pinned Pi Agent wire rules;
7. preserves the provider-native response wire subject only to the existing safe response-boundary filtering and lifecycle rules.

Changing transport encoding, such as compressing the rewritten JSON, is permitted; changing decoded body semantics beyond the default `model` projection or the exact Anthropic OAuth exception is not. The Native transport does not read profile files, choose another profile, inspect notes/names, refresh OAuth itself, start login, or infer credential type from token shape, `AuthResult.source`, or the presence of `auth.apiKey`. The captured type is an input for correct wire projection and selects the closed Anthropic OAuth exception, never a reason to redirect the request to another lane.

## 9.4 Semantic Conversion execution

Semantic Conversion invokes the existing Pi Provider path under its own exact captured Provider auth binding and does not pass an inbound client credential as Pi `options.apiKey`. Pi owns Provider-specific `api_key`/OAuth/ambient resolution, non-interactive token refresh during auth consumption, and Provider wire construction. A refresh failure ends that semantic execution and never invokes interactive login. Credential Profiles never enter Pi AI IR.

## 9.5 Inbound request exclusion

Provider-backed lanes do not inspect an inbound `Authorization`, API-key, bearer, cookie, or proxy-credential header to determine auth type or Profile. Current loopback handlers do not use `Authorization` as request identity. The value never:

- selects a Provider profile;
- changes `activeCredentialId`;
- overrides the captured profile;
- becomes Pi `options.apiKey`;
- crosses into Provider Native upstream headers;
- determines Activity credential attribution.

Provider Native constructs a fresh upstream transport envelope. Any inbound header whose value is owned or influenced by the Profile, resolved Model, Provider implementation, or Pi Agent identity is discarded and reconstructed even if the client supplied the same name. In particular, client auth, account, Provider version/beta, SDK identity, User-Agent, session, host, content length, and content encoding values cannot override their outbound owners.

There is no generic request-header allowlist. A client header may affect the upstream request only when the explicit `(providerId, api/protocol, operation)` Native contract names it as client-owned model-visible input. The lane then validates and projects that fact through a named Interface; it does not forward the header generically, and the fact still cannot override a Profile/Pi-owned field. Semantic Conversion likewise receives no inbound credential override. This PRD adds no client-credential parser or auth-mode resolver.

## 9.6 Capability visibility and certification

The credential-management UI shows each Provider-declared authentication-method label projected by Backend. It does not expose a second per-lane authentication support selector: every active Profile must work on every Provider Native operation that the product claims for that Provider.

Release certification maintains an internal coverage matrix across `(providerId, provider api/protocol, operation, authType)` and requires independent default body-preservation, Anthropic OAuth body-differential, request-envelope parity, endpoint, response-fidelity, cancellation, secret-leakage, and failure-lifecycle tests against a pinned Pi Agent reference. The matrix proves completeness; it is not runtime routing state. A Provider Native transport cannot be declared release-ready while any Provider-exposed managed auth type is uncertified.

---

# 10. OAuth refresh and credential maintenance

## 10.1 Operation side-effect contract

OAuth token refresh and interactive login are different operations. The first is a Provider network token exchange without an `AuthInteraction`; the second is a user-driven Provider flow that may prompt or open a browser.

| Operation | Provider network | Browser/prompt | Credential effect |
|---|---:|---:|---|
| Query/status | Forbidden | Forbidden | Read sanitized local state only |
| Rename, note, priority, activate, enable/disable, remove, switch setting | Forbidden in the command | Forbidden | Local Provider-record mutation only |
| Bound Provider request | Allowed only when OAuth refresh is needed | Forbidden | Refresh may update the exact bound Profile |
| Explicit recheck/model refresh | Allowed | Forbidden | May refresh the exact bound OAuth Profile; never changes the active pointer |
| Explicit login/reconnect | Allowed | Allowed when the Provider requires it | Publishes only after successful user interaction |

V1 has no timer that refreshes every idle OAuth Profile and no Profile query that probes a Provider. Switching Profiles never triggers model/catalog refresh automatically. A separate explicit recheck may refresh credential-dependent model facts when the user needs them; its success or failure cannot change or roll back `activeCredentialId`.

## 10.2 Silent refresh correctness

- Refresh is serialized by a per-`credentialId` refresh lock, not merely by the Provider record/file lock. When cross-process record access is supported, this refresh lock is cross-process too.
- The refresh lock remains held through Pi's bounded `CredentialStore.modify()` callback so Pi's double-checked refresh contract remains intact. The Provider record/file lock does not remain held during Provider network I/O.
- Under the refresh lock, LuckyToken briefly acquires the Provider record lock to read the exact current payload and `credentialGeneration`, releases the record lock, runs the OAuth network refresh, then briefly reacquires the record lock to publish.
- Expiry is rechecked inside the per-credential serialization boundary so concurrent requests do not double-refresh a rotated token.
- Publication succeeds only when the Profile still exists and its `credentialGeneration` is unchanged. A missing or replaced Profile discards the late result and cannot be recreated or overwritten.
- Refreshed access and refresh tokens publish atomically before the per-credential refresh lock is released.
- Silent refresh does not change `credentialGeneration`, `selectionGeneration`, the Provider's management `revision`, or user-visible `updatedAt`; callers never overwrite the whole record from a stale snapshot.
- Refresh reads and writes through the exact captured managed binding; changing the Provider's active pointer while refresh is in flight cannot redirect the write to another Profile.
- Deleting or disconnecting a profile races safely with refresh; a removed profile cannot be recreated by a late refresh result.
- Refresh failure produces a bounded `reconnect_required` or transient status only when evidence supports that classification. Evidence is either a structured OAuth error code or an explicitly declared adapter for the repository-pinned Provider implementation (for example Kimi's fixed unauthorized-refresh error category); arbitrary message matching is forbidden.
- Refresh failure does not trigger automatic credential switching in v1.
- Refresh failure never invokes `Models.login()`, creates an `AuthInteraction`, opens a browser, or prompts the user.
- Refresh errors and Provider responses are scrubbed before entering diagnostics.
- A refreshed credential that cannot satisfy the request's minimum validity fails explicitly.

Pi's existing locked OAuth refresh behavior is the reference for these semantics, but its current Provider-keyed one-slot store is not sufficient as the unchanged authoritative multi-profile store.

## 10.3 Interactive login and reconnect

`Models.login()` is used only by an explicit Provider-declared authentication-method action or **Reconnect** command. The command owns the user-visible interaction lifecycle and cancellation. Query, activation, request failure, silent refresh failure, and HTTP 429 switching cannot synthesize or schedule an interactive login.

---

# 11. Activity and observability

## 11.1 Request attribution

For managed credentials, each execution records the opaque `credentialId`, internal auth type, Backend-projected auth-method label, selected lane, bounded request-time display-name snapshot, attempt result, and selection reason. It never records secret material, token claims, the note, or raw auth-source details. Ambient execution records no invented Profile attribution.

The stable `credentialId` provides exact internal attribution. The user recognizes the credential through the name they assigned and the captured Provider auth-method label. Activity shows a bounded attempt trail such as `Production — 429` followed by `Backup — Success`, with reason `HTTP 429 failover`.

Activity attribution is visible by default in the local product and has no separate v1 privacy setting. This does not authorize telemetry or external export. Deleting a profile does not delete already retained Activity snapshots; those disappear through normal Request Ledger retention.

## 11.2 User-visible events

Users can understand:

- which credential served a request;
- whether and why HTTP 429 selected another same-type credential;
- whether a profile is cooling down, disabled, or needs reconnection;
- whether local removal succeeded;
- whether an external source remains configured and may become applicable after removal.

## 11.3 No raw-provider error UI

Renderer does not infer profile health from raw error strings. Backend owners project typed, bounded states and safe user actions.

---

# 12. Security and privacy requirements

1. Secret material remains owned by the Backend Profile State Owner and its composition-private credential Adapter.
2. Renderer receives only sanitized profile projections and owns only form drafts, selection, filters, modal state, and pending interaction state.
3. Electron Main and preload expose narrow typed operations and do not read credential files.
4. API keys, access tokens, refresh tokens, credential commands, auth headers, and raw credential objects never enter status DTOs, Activity, logs, diagnostics, crash reports, notes, or search indexes.
5. Notes and names are untrusted user input, length-bounded, escaped at presentation, and scrubbed from error text.
6. Complete known secret values are rejected from name/note metadata.
7. All profile mutations use revision/conflict semantics so two desktop/CLI clients cannot lose concurrent changes.
8. Import and export are not added until a profile-aware, value-safe contract is explicitly specified.
9. Credentials are for Provider access the user is authorized to use. LuckyToken does not describe selection as quota circumvention.
10. Product certification proves that closing and reopening Renderer reconstructs current sanitized Backend state.
11. Provider-backed lanes never inspect inbound credential-shaped headers to choose Pi auth behavior; those values are permanently excluded from Provider Profile selection, Pi `options.apiKey`, Provider Native upstream authentication, and Provider Activity attribution.
12. One Provider's corrupt or unreadable credential record fails closed for that Provider and does not expose secrets or prevent independent Providers from loading.

---

# 13. Architecture constraints

## 13.1 Ownership

Backend Application owns the authoritative credential-profile lifecycle. The authority owns:

- stable profile identities;
- the one active managed profile pointer per Provider;
- metadata and secret association;
- status and eligibility facts;
- serialized profile mutations;
- known-value scrubbing;
- OAuth refresh publication;
- sanitized projection.

It does not own model-visible semantics, Provider wire construction, Client Protocol conversion, request history, Electron lifecycle, or Renderer interaction state.

## 13.2 Product dependency direction

The fixed direction remains:

```text
Renderer
  → typed preload
  → Electron Main
  → Application Control Plane
  → Backend Application
  → Core / Pi
```

No profile metadata or secret authority is duplicated in Electron.

## 13.3 Pi integration and request binding

LuckyToken does not modify Pi AI and does not create a new Pi `Models` collection when a profile changes. The one Backend-lifetime `Models` collection remains authoritative for Provider/model/auth behavior.

One Profile State Owner supplies separate consumer-specific Interfaces: a secret-free Management Interface, an opaque secret-free Binding Interface, and a composition-private Pi `CredentialStore` Adapter. The Management and Binding Interfaces never expose `Credential`, `AuthResult`, tokens, Provider-private payloads, or the CredentialStore itself. Composition injects the private Adapter into the one Backend-lifetime Pi `Models`; data-plane lanes receive only their own Binding Interface. Pi continues to read, refresh, and publish explicit login/reconnect results through its existing Provider-keyed `CredentialStore` contract, while the Adapter maps an intentionally bound Pi operation to the exact managed Profile or the allowed ambient scope. Local removal is owned directly by the State Owner. Pi does not know that sibling Profiles exist.

Only operations that intentionally invoke Pi establish an exact binding: Provider-backed request execution, explicit login/reconnect, and explicit auth/model recheck. Missing or stale managed bindings fail closed. An ambient binding is permitted only when the latest Provider record has zero managed Profiles. Query and local Profile mutations do not invoke Pi. OAuth refresh uses exact Profile identity, `credentialGeneration`, per-credential serialization, and short guarded record publication; login publication and local mutations use the Provider management `revision` so a late operation cannot update, replace, or recreate a different Profile.

Switching the active profile reuses the same Pi `Models` object and existing Pi `Model` descriptors. It does not call `Models.refresh()` or wait for Provider model discovery. Every lifecycle Catalog operation—not only Recheck or post-login—captures one exact managed-or-ambient Provider binding and generation-guards that Provider's publication. Dynamic network refreshes stage their cache result; static Provider availability is checked and published as its own exact child and never under another Provider's lease. Account-dependent catalog/availability re-evaluation occurs either through explicit Recheck or as a non-blocking child phase after a successful login/reconnect publishes the newly authenticated Profile as active. Explicit Recheck returns the target Provider's typed `succeeded`/`failed`/`skipped` outcome; only `succeeded` becomes product `ok`. The post-login phase captures that exact `credentialId`, `credentialGeneration`, and `selectionGeneration`; it never resolves whichever Profile happens to be active later. Every successful active login owns an independent queued child run; one login cannot replace another pending exact refresh. The Provider refresh revalidates selection-lock ownership immediately before committing its stage and served model slice. A post-commit failure rolls the cache back only when the stage is still the latest writer; rollback I/O failure is treated as unproven, not as a safe compare miss. Login success does not wait on or roll back for Catalog failure. If the Profile is inactive, removed, reconnected, or superseded before publication, the staged result is discarded, the authoritative cache remains unchanged, and the last complete served Catalog remains authoritative. If authoritative live-state restoration cannot be proven, only that Provider is quarantined behind its last complete served model slice until a later exact guarded publication succeeds; unrelated Providers continue to refresh and publish.

## 13.4 Data-plane isolation

- Local Native credentials and execution are outside this Provider profile PRD and remain unchanged.
- The fixed-loopback HTTP Data Plane accepts the client API request before Client Protocol/model capability routing selects Provider Native or Semantic Conversion; no request field selects Pi auth branch or ambient mode.
- Client Protocol routing selects Provider Native or Semantic Conversion from the existing protocol/model capability contract, not from credential facts.
- After selection, Provider Native and Semantic Conversion independently capture and consume the managed-or-ambient Provider binding through separate lane-owned seams.
- The Provider Native seam may receive a managed binding's captured `authType` needed for its own Provider-wire construction; an ambient binding has no invented `authType`. The seam does not receive a broad mutable profile store, and credential type does not select the lane.
- Provider Native Responses and Semantic Conversion/Pi AI IR share no request builder, credential-binding Adapter, execution wrapper, transport, retry state, response handling, or semantic type. Their separate lane-owned seams may depend on the same authoritative Profile state and allowed Backend-lifetime Pi `Models` capabilities without calling or wrapping each other.
- No generic cross-lane credential router, executor, transport, target, or fallback abstraction is introduced.
- Credential identity and selection reason are infrastructure/observation facts; neither enters Pi AI IR.
- Client Protocol code never reads Provider profile payloads or implements Provider-specific authentication wire rules.

## 13.5 Persistence contract

The current Provider-keyed `auth.json` shape cannot represent the target product unchanged. The new State Owner uses one independent logical file/record per Provider rather than one cross-Provider mutable credential object. Each Provider record owns its Profile envelopes, opaque Provider credential payloads, `credentialGeneration` values, active pointer, `selectionGeneration`, settings, management `revision`, and safe authentication-method label snapshots needed to manage an orphaned record.

The common persistence contract does not normalize all Provider payloads into one LuckyToken credential schema. It stores Provider-private material opaquely and exposes it only through the composition-private profile-bound Pi CredentialStore Adapter. Its Store Interface enumerates persisted Provider IDs without exposing payloads. Management query uses the union of runtime Provider IDs and persisted Provider IDs, so removing a Provider implementation cannot make its stored secrets undiscoverable.

An orphaned persisted Provider is projected with `Provider implementation unavailable`, its sanitized Profiles, and local removal actions. Login, reconnect, recheck, and request execution are unavailable until that Provider implementation exists again. Local removal of orphaned Profiles remains allowed and cannot be rejected merely as `unknown_provider`. One Provider's malformed record cannot corrupt, overwrite, or block an unrelated Provider's record.

There is one authoritative representation. LuckyToken does not dual-write profile state into legacy `auth.json`, and Pi never reads the new physical shape directly.

This PRD does not require migration or backward compatibility for the obsolete one-slot shape. If compatibility becomes a product requirement, it requires a separate explicit decision and specification before implementation.

---

# 14. Functional requirements

## 14.1 Must have

- multiple LuckyToken-managed Profiles in Pi's `api_key` branch per Provider, including Provider methods that are not literal API keys;
- multiple LuckyToken-managed OAuth profiles per Provider when the Provider exposes OAuth login;
- required display name and optional note;
- Backend-projected Provider authentication-method label and optional safe identity hint;
- add, rename, edit note, set priority, use now, enable, disable, reconnect, remove, and disconnect;
- at most one active managed Profile per Provider across both Pi auth branches, with explicit failure when managed Profiles exist but none is active;
- ambient binding only when zero managed Profiles exist, without fake Profile identity, persistence, switching, or Profile attribution;
- request-start capture of exact credential and selection generations so active-Profile changes, reconnect, and ABA history affect only valid later decisions;
- non-interactive OAuth refresh only while an exact bound Profile is consumed, explicitly rechecked, or used by its exact-profile post-login Catalog phase;
- per-credential OAuth refresh serialization with no Provider record/file lock held during network I/O and generation-guarded publication;
- profile-bound Pi authentication without modifying Pi AI or rebuilding the Backend-lifetime `Models` collection;
- Provider-isolated authoritative records with opaque Provider credential payloads;
- persisted Provider enumeration and sanitized local removal for orphaned Provider records;
- secret-free Management and Binding Interfaces, with the Pi CredentialStore Adapter private to composition;
- complete managed-auth support for every claimed Provider Native transport;
- Provider Native body preservation with boundary-required `model` projection and only the closed Anthropic OAuth body exception;
- Pi Agent-compatible reconstruction of every Profile/Pi-owned Provider Native transport fact;
- absolute execution, credential-binding-Adapter, transport, retry, response, and semantic-type separation between Provider Native Responses and Semantic Conversion/Pi AI IR;
- no generic inbound-header passthrough and no inspection, classification, override, or forwarding of inbound credential-shaped headers for Provider authentication;
- separate, default-off `api_key`-branch and `oauth`-branch 429-switching settings per Provider, rendered with Provider authentication-method labels;
- generation-aware same-branch HTTP 429 switching only under the fixed conditions in section 8.4, with at most three Profile attempts per request;
- sanitized profile status while Data Plane is stopped or failed;
- Activity attribution by stable profile identity;
- explicit external-source presentation;
- typed concurrent-mutation conflicts;
- no secret projection.

## 14.2 Should have

- search by name, note, authentication-method label, and optional safe identity hint;
- explicit model/auth recheck action with clear network use and no interactive login;
- actionable `reconnect_required` and `cooling_down` states;
- request-attempt attribution by user-assigned name.

## 14.3 Could have later

- profile usage totals and budget labels;
- quota signals where Providers expose reliable APIs;
- team ownership and permissions;
- cross-device encrypted sync;
- bulk import/export;
- typed Provider account identity and remote OAuth revocation if Pi later exposes explicit contracts;
- additional selection policies.

---

# 15. Non-goals

- changing Anthropic or OpenAI Responses semantic conversion;
- semantically reconstructing or default-filling a Provider Native request body outside the exact Anthropic OAuth exception;
- changing a Provider Native body field other than the boundary-required top-level `model` projection or the exact pinned Anthropic OAuth identity/tool-name differential;
- adding credentials to Pi AI IR;
- unifying the three data-plane lanes;
- choosing a data-plane lane from the active credential type;
- introducing a generic Provider Native credential transport shared across independent Native lanes;
- importing, calling, wrapping, or reusing Semantic Conversion/Pi AI IR implementation from Provider Native Responses, or the reverse;
- rebuilding Provider-owned OAuth protocol logic in Renderer or Client Protocol code;
- Provider-side API-key creation or revocation without an explicit Provider operation;
- automatic account sharing among machines or users;
- billing reconciliation or chargeback;
- team RBAC;
- opaque auto-rotation;
- background refresh timers for idle Profiles;
- Provider login, browser launch, or prompting triggered by query, local mutation, request failure, refresh failure, or HTTP 429 switching;
- automatic model/catalog refresh caused only by changing `activeCredentialId`;
- automatic switching for non-429 failures;
- automatic cross-auth-type switching;
- Provider account-identity discovery or remote OAuth revocation in v1;
- importing external auth sources as managed profiles;
- using fuzzy Provider identity, payload resemblance, or cross-lane failure to choose an alternative execution path;
- compatibility shims, dual persistence, or silent migration for the old one-slot credential shape.

---

# 16. Release slices

## Slice 1 — close the existing lifecycle gap

- expose `Remove from LuckyToken` for managed Provider credentials;
- expose `Disconnect from LuckyToken` for OAuth Profiles;
- show the effective remaining source after removal;
- preserve model, alias, and Activity facts;
- certify value-free results.

## Slice 2 — credential profiles and metadata

- replace the one-slot product contract with multiple managed profiles;
- add stable identity, Provider authentication-method label, name, note, optional identity hint, status, and enable/disable;
- add one authoritative active profile across both authentication types;
- persist one independent logical record per Provider with opaque Provider payloads, credential generations, and selection generation;
- enumerate persisted Provider IDs and keep orphaned Profiles locally removable;
- add the credential management view;
- support independent `api_key`-branch and OAuth Profile creation/removal;
- keep Provider management available independently of Data Plane listener state.

## Slice 3 — request binding and Provider Native completeness

- manual active/priority selection;
- exact managed/ambient request-start binding through the one Backend-lifetime Pi `Models` collection;
- separate secret-free Management/Binding Interfaces and a composition-private Pi CredentialStore Adapter;
- serialized per-Profile OAuth refresh with short generation-guarded record publication;
- explicit Provider-scoped model/auth recheck when the user requests current credential-dependent facts;
- complete managed-auth wire support and certification for each claimed Provider Native transport;
- preserve each Provider Native body except for model identity projection and the closed Anthropic OAuth differential, then reconstruct its Pi Agent-compatible transport envelope;
- strict inbound-client/outbound-Provider credential separation;
- Activity attribution by captured profile and lane.

## Slice 4 — explicit 429 switching

- separate Provider-scoped `api_key`/`oauth` 429 settings, default off and rendered with Provider auth labels;
- generation-aware same-branch, same-lane final-429 switching;
- atomic update of the Provider's global active profile;
- maximum three Profile attempts per request;
- Activity attempt attribution and 429 selection reasons.

Advanced balancing remains outside these slices.

---

# 17. Success measures

## 17.1 Product measures

- successful addition of a second credential without replacing the first;
- successful removal/disconnection of one profile without mutating siblings;
- percentage of multi-profile Providers whose profiles have user-edited names;
- reduction in Provider-unavailable requests caused by expired or disabled credentials;
- successful self-service recovery from `reconnect_required`;
- percentage of managed requests with credential attribution visible in Activity.

These measures require telemetry/privacy review before collection. They are product questions, not permission to add telemetry automatically.

## 17.2 Release blockers

- any complete secret appears outside the credential owner;
- deletion can be undone by a racing refresh;
- a profile mutation can overwrite or delete a sibling profile;
- a Provider operation reads or writes a profile other than the exact bound `credentialId`;
- a Data Plane capture or 429 transition uses management `revision` instead of exact credential/selection generations;
- a stale request 429 can override a reconnect, a later manual/automatic selection, or `A → B → A` selection history;
- changing the active profile changes an already in-flight request;
- selection can cross data-plane lanes after execution begins;
- an inbound client credential selects, overrides, or reaches an upstream Provider credential path;
- Provider Native changes any decoded request-body semantic other than the boundary-required top-level `model` projection or the exact certified Anthropic OAuth identity/tool-name differential;
- Anthropic OAuth body projection is selected from token text, changes unrelated client semantics, guesses or repairs malformed state, or is reused by another Provider/API/auth type;
- Provider Native forwards a generic client-header allowlist or lets a client value override a Profile/Pi-owned transport fact;
- a claimed Provider Native combination does not match its pinned Pi Agent request method, URL, auth/account projection, required headers, or content-encoding behavior;
- Provider Native Responses and Semantic Conversion/Pi AI IR share or call through a request builder, credential-binding Adapter, execution wrapper, transport, retry state, response handler, or semantic type;
- a claimed Provider Native transport fails to support a managed auth type exposed by that Provider;
- Provider Native infers credential type from token shape, `AuthResult.source`, or the presence of `auth.apiKey` instead of using the captured profile type when a discriminant is required;
- Renderer hard-codes `API key`/`account` as the product auth-method name instead of consuming the Backend-projected Provider label;
- a required masked identity is invented for a credential that has no safely displayable identity hint;
- Renderer becomes authoritative for profile facts;
- removing a stored profile reports `disconnected` while an external source remains configured/applicable under the ambient contract;
- a renamed profile changes routing identity;
- credentials switch on any status other than a final pre-output HTTP 429;
- automatic switching crosses between `api_key` and `oauth` branches;
- a committed manual or automatic switch fails to update the Provider's active profile for subsequent requests;
- one Provider's malformed credential record prevents an unrelated Provider from loading or serving;
- a persisted Provider record becomes undiscoverable or locally irremovable because its Provider implementation is absent;
- a Management or Binding Interface exposes a Pi CredentialStore, `Credential`, `AuthResult`, or Provider-private credential payload;
- Activity exposes a note, secret, token claim, or guessed Provider account identity;
- management becomes unavailable merely because the Data Plane listener is stopped or failed;
- query, metadata editing, activation, enable/disable, priority changes, removal, or switch-setting changes contact a Provider or open a browser;
- changing `activeCredentialId` automatically calls `Models.refresh()` or makes switch success depend on catalog refresh;
- silent OAuth refresh failure starts login, opens a browser, switches again, or rolls back a committed active pointer;
- Provider OAuth network refresh runs while the Provider record/file lock is held, a late refresh publishes after removal/reconnect, or silent refresh advances credential/selection generation;
- an ambient binding is created while any managed Profile exists, receives a fake `credentialId`, enters Profile switching, or produces Profile attribution;
- one request attempts more than `MAX_PROFILE_ATTEMPTS_PER_REQUEST = 3` Profiles;

---

# 18. Acceptance scenarios

1. **Two Provider-auth Profiles:** Add two managed Profiles through one Provider's `api_key` branch with distinct names and notes. Both persist independently; any literal key value is never redisplayed, and adding the second does not replace the first active Profile unless `Save and use now` is explicitly chosen.
2. **Two OAuth Profiles:** Log in through the same Provider OAuth method twice. Each Profile has independent status, refresh lifecycle, and removal; the second login does not implicitly replace an existing active Profile.
3. **Both Pi auth branches:** Store `api_key` and `oauth` Profiles under one dual-auth Provider. Exactly one Profile is active, and manually choosing the other updates the same `activeCredentialId` regardless of auth branch.
4. **Rename safety:** Rename a profile while a request is active. The request and future routing remain associated with the same `credentialId`.
5. **Request capture:** Start request A with profile A, switch the Provider to profile B, then start request B. Request A uses A for its complete lifetime and request B uses B.
6. **Disable:** Disable the active profile. `activeCredentialId` is cleared, new managed requests fail until the user selects a replacement, and existing in-flight requests are not cancelled or rebound.
7. **Remove one:** Remove one of three profiles. Its secret is deleted, siblings remain byte-for-byte and behaviorally unchanged, and removing the active profile does not silently activate a sibling.
8. **Disconnect OAuth:** Disconnect one OAuth profile during a concurrent refresh. The late refresh cannot recreate the removed credential or write its tokens into another profile.
9. **Ambient source after last removal:** Remove the last managed Profile while an environment source is configured. UI shows the configured source with last-known or unknown availability, performs no hidden probe, and does not claim the Provider is disconnected; a later request captures `AmbientBinding` and lets Pi establish live evidence without creating a Profile.
10. **Provider record isolation:** Corrupt one Provider's record. That Provider fails closed with sanitized status while another Provider's profiles continue to load and serve.
11. **Refresh concurrency:** Concurrent requests for one expiring OAuth Profile serialize by `credentialId`, perform at most one effective token refresh, preserve `credentialGeneration`, and observe the published rotated credential in that exact Profile.
12. **`api_key`-branch 429 switching:** Enable only the Provider-labeled `api_key` setting. After a final pre-output 429, LuckyToken atomically makes the next enabled same-branch Profile active, retries under its exact binding, and never selects OAuth. Concurrent requests already bound to the previous Profile remain unchanged.
13. **OAuth 429 switching:** Enable only the Provider-labeled OAuth setting. After a final pre-output 429, LuckyToken atomically makes the next enabled OAuth Profile active, retries under its exact binding, and never selects the `api_key` branch.
14. **Settings off:** With the matching setting off, a final 429 is returned without changing the active profile.
15. **Concurrent switch conflict:** A manual switch and automatic 429 switch race on the same `selectionGeneration`. One selection commits and advances it; the stale 429 cannot overwrite the newer active choice even when management-only metadata changed independently.
16. **Bounded attempts:** Each eligible same-branch Profile is attempted once at most and no request exceeds `MAX_PROFILE_ATTEMPTS_PER_REQUEST = 3`; reaching the cap returns the final 429 even when more eligible Profiles exist.
17. **Explicit cooldown:** A valid `Retry-After` creates a bounded cooldown; a 429 without one creates no guessed cooldown beyond the current request.
18. **Unsafe switching:** Upstream acceptance is uncertain or output has begun. LuckyToken returns the failure without selecting another profile or lane.
19. **Non-429 failure:** A 401, 403, 5xx, network error, or OAuth refresh failure never triggers automatic switching in v1.
20. **Inbound credential-shaped header with active OAuth:** A Responses client sends an `Authorization` value to the loopback API while the selected Provider Profile is OAuth. Provider Native or Semantic Conversion uses the active OAuth Profile; the inbound value does not become Pi `options.apiKey`, does not reach upstream Provider auth, and does not affect Activity attribution.
21. **Provider Native Responses with `api_key` branch:** A claimed Provider Native Responses transport resolves the selected `api_key` Profile through `Models.getAuth(model)`, applies the correct Provider wire authentication, and preserves the native response without assuming `AuthResult.auth.apiKey` proves a literal API key.
22. **Provider Native Responses with OAuth:** The same claimed Provider Native Responses transport resolves the selected OAuth Profile, performs Pi's non-interactive token refresh when required, applies the correct Provider-specific OAuth wire, and preserves the native response. It does not redirect to Semantic Conversion because the Profile is OAuth and never starts interactive login from the request path.
23. **Provider Native completeness:** For every Provider Native operation claimed by the product, all managed auth types exposed by that Provider pass the internal coverage matrix before release.
24. **Semantic Conversion independence:** The same Provider's `api_key` and OAuth Profiles both execute through the Pi Provider path without importing or observing Provider Native transport state.
25. **Lane isolation:** A Provider Native or Semantic Conversion failure remains in the already selected lane and never uses the other lane as fallback.
26. **Activity:** Activity shows captured request-time credential names, Backend auth-method labels, selected lanes, attempt outcomes, and `HTTP 429 failover` without note, secret, token claim, inbound client credential, or guessed account identity; ambient execution shows no Profile attribution.
27. **Profile deletion:** Deleting a profile removes current credential/profile state immediately; existing bounded Activity snapshots remain only for normal ledger retention.
28. **Desktop reconstruction:** Close and reopen the management window. Renderer queries the authoritative profiles and does not rely on stale local state.
29. **Backend lifecycle:** Stop or fail the Data Plane listener. Profile query, login, editing, removal, settings, and status remain available through the Backend Control Plane.
30. **Concurrent clients:** Two clients mutate the same Provider management revision. One succeeds; the stale mutation receives a conflict and no change is lost.
31. **Secret hygiene:** Control Plane frames, status, logs, diagnostics, Activity, crash output, and test snapshots contain no complete API key, access token, or refresh token.
32. **Test isolation:** Every test that can reach Codex state uses a new temporary `CODEX_HOME`, copies only explicitly permitted fixtures, passes that home to every spawned process, and removes it in `finally`.
33. **Offline query:** Disconnect Provider network access and query Profile state. The query succeeds from local authoritative state and calls none of `Models.getAuth()`, `Models.checkAuth()`, `Models.refresh()`, or `Models.login()`.
34. **Offline manual switch:** With Provider network unavailable, switch from Profile A to B. The local revision and active pointer commit successfully, later requests capture B, and no browser or prompt appears.
35. **No automatic catalog refresh:** Switch the active Profile and verify that Pi `Models` identity and existing `Model` descriptors are retained and `Models.refresh()` is not called. An explicit recheck may later update account-dependent model facts without changing the active pointer.
36. **Silent refresh failure:** A 429 switch commits OAuth Profile B, but B's bound token refresh fails. The request stops with a sanitized auth failure; LuckyToken does not try C, roll back B, invoke login, open a browser, or prompt the user.
37. **Explicit reconnect only:** A Profile marked `reconnect_required` remains local and queryable until the user chooses Reconnect. Only that command creates the Provider-owned interactive login flow.
38. **Removal race:** Request A captures Profile A but has not resolved auth when A is removed. Its later bound read fails closed and cannot use another Profile or recreate A. If auth was already resolved before removal, the bounded in-memory request may finish, but no later request can acquire A.
39. **Refresh does not stale management:** Open the Profile manager at management revision R, then let a request silently refresh one OAuth token. A metadata edit still compares against R and may commit over the latest record without overwriting the refreshed payload; 429 switching uses captured credential/selection generations rather than R.
40. **Default Provider Native body preservation:** For every claimed combination except first-party Anthropic OAuth, send a compatible Native request containing nested tools, instructions, metadata, extension fields, and a qualified model selector. The decoded upstream body differs only in the top-level `model` projection; no other field, value, relationship, default, or extension is changed.
41. **Responses Pi-wire reconstruction:** For each certified managed auth type, send conflicting inbound auth, account, base-URL-like, session, User-Agent, SDK, version/beta, and content-encoding headers. The upstream Responses request uses the captured binding, resolved Model, request-local lifecycle facts, and pinned Pi Agent rules; no conflicting client value overrides them.
42. **Anthropic Pi-wire reconstruction:** For each certified Anthropic/Copilot auth type, the Native request emits the pinned Pi Agent auth form, endpoint, required identity/version/beta headers, and SDK identity. Generic `x-stainless-*` or other client transport headers are not passed through; an explicitly contracted model-visible client header is validated and reprojected only through its named rule.
43. **Transport encoding is not body mutation:** A Provider Native sender may encode or compress the body as the pinned Pi Agent does. Decoding the bytes yields the preserved client body with only the permitted default `model` projection or, for first-party Anthropic OAuth, its certified identity/tool-name differential.
44. **Responses/Semantic architecture isolation:** Architecture tests prove Provider Native Responses has no import or call path into Pi AI IR, Client Wire ↔ Pi AI IR adapters, Pi Provider execution, or Semantic request/credential-binding/execution/transport/retry/response modules, and prove the reverse dependency is also absent.
45. **Anthropic OAuth body exception:** With the first-party Anthropic Messages model and a captured managed OAuth Profile, Native output matches the pinned Pi Agent OAuth differential for Claude Code system identity and tool-name references while preserving every unrelated client-authored semantic. The same body under a managed `api_key` Profile or ambient binding receives no OAuth projection, and no token-shape check selects the exception.
46. **Provider auth ontology:** Create Bedrock bearer-token, AWS-profile, existing-chain, Vertex API-key, ADC, and service-account Profiles through Pi's `api_key` branch. Each row uses the Backend-projected Provider `authMethodLabel`; only credentials with a safely displayable identity receive `identityHint`, and the UI never invents a masked key suffix.
47. **Managed-versus-ambient binding:** With zero managed Profiles, a request captures `AmbientBinding` and Pi may resolve ambient auth. After adding any managed Profile, clearing or disabling the active Profile causes requests to fail closed and never fall back to ambient auth.
48. **Credential generation protects reconnect:** Request R captures active Profile A at credential generation C1. Reconnect replaces A with C2 without changing its ID. R's later 429 and late refresh are stale and cannot switch away from or overwrite C2.
49. **Selection generation protects ABA:** Request R captures A at selection generation S1. A manual `A → B → A` sequence produces S3 even though A is active again. R's later 429 cannot overwrite the newer selection history.
50. **Refresh does not lock Provider management:** While Profile A waits on OAuth network refresh, rename/activate operations for Profile B and removal of A commit through short Provider record locks. A late refresh of removed A is discarded.
51. **Orphan Provider lifecycle:** Persist Profiles for Provider `foo`, then remove its implementation. Query still enumerates the sanitized orphan record and permits local removal, while login, reconnect, recheck, and request execution are unavailable.
52. **Secret-free Interfaces:** Management and Binding consumers cannot obtain `CredentialStore`, `Credential`, `AuthResult`, or Provider-private payloads. Only composition can connect the profile-bound CredentialStore Adapter to Pi `Models`.

---

# 19. Accepted product decisions

V1 product decisions are closed:

1. `authType: "api_key" | "oauth"` remains Pi's internal authentication discriminant; `api_key` does not mean the stored payload is necessarily a literal API key.
2. Backend projects a bounded Provider-declared `authMethodLabel`; `identityHint` is optional and is never invented when no safe identity exists. Renderer derives neither fact from Pi metadata or credential payloads.
3. Profile default names are ontology-neutral. UI actions, rows, search, removal, and 429 settings use projected Provider method labels rather than hard-coded `API key`/`account` product types.
4. Every Provider has one authoritative active managed-Profile pointer across both Pi auth branches; it references at most one Profile and there are no separate active pointers by auth type.
5. Manual switching updates that Provider-wide active pointer for subsequent requests. V1 has no session-affine credential selection.
6. Provider auth capture is a discriminated union: exact managed binding when a valid active managed Profile exists; fail closed when managed Profiles exist without one; operation-local ambient binding only when zero managed Profiles exist.
7. Ambient binding has no `credentialId`, persistence, Profile-pool membership, Profile switching, or Profile attribution.
8. A managed binding captures `credentialGeneration` and `selectionGeneration`, not management `revision`.
9. `credentialGeneration` changes on add/reconnect/logical credential replacement and is preserved by silent token refresh. `selectionGeneration` changes whenever the active pointer actually changes and protects manual/automatic races and ABA history.
10. Management `revision` remains the Desktop/CLI optimistic concurrency token and may change for metadata and settings that do not stale a Data Plane binding.
11. Adding a sibling Profile does not replace an existing active Profile unless the user explicitly chooses to use it now.
12. Every Provider has separate `api_key`-branch and `oauth`-branch 429 settings; both default to off and the UI renders Provider method labels.
13. Automatic switching is limited to a final pre-output HTTP 429 after the selected lane's existing retry behavior and stays inside the same Provider, auth branch, credential authority, and selected lane.
14. A 429 transition verifies exact credential and selection generations plus current active identity, then recomputes eligibility from the latest record. Rename/note do not cause selection conflict; reconnect, later selection, and ABA state do.
15. `MAX_PROFILE_ATTEMPTS_PER_REQUEST` is `3`, including the initial Profile. Each lane retains its own independent inner transport-retry contract.
16. A committed automatic switch updates the Provider-wide active pointer and advances selection generation; it is not a request-only or session-only override.
17. V1 does not switch automatically across auth branches or for 401, 403, 5xx, network, refresh, or storage failures.
18. Client Protocol/lane selection and Provider credential selection are independent. Local Native behavior is outside this PRD.
19. A claimed Provider Native transport must support every managed auth type exposed by that Provider. Auth-type coverage is release certification, not runtime routing or fallback state.
20. Provider-backed lanes do not inspect inbound credential-shaped headers to choose auth type or Profile; those headers never override or become outbound Provider authentication.
21. LuckyToken retains one Backend-lifetime Pi `Models` collection and presents only the exact operation binding through a composition-private Pi-compatible CredentialStore Adapter; Pi AI is not modified and does not know about sibling Profiles.
22. One Profile State Owner exposes separate secret-free Management and opaque Binding Interfaces. Neither exposes CredentialStore, `Credential`, `AuthResult`, tokens, or Provider-private payloads.
23. Each Provider has one independent authoritative record. The Store enumerates persisted Provider IDs, and orphaned Provider records remain queryable and locally removable while Provider-dependent operations are unavailable.
24. `Retry-After` or an equivalent typed fact may establish cooldown; LuckyToken invents no delay when it is absent.
25. V1 uses user-assigned names as human Profile identity. It does not parse tokens to guess account identity.
26. V1 OAuth disconnect removes local tokens only; remote Provider revocation is not claimed.
27. The Profile State Owner keeps no deleted-Profile tombstone. Activity owns bounded request-time name/auth-method snapshots for its normal retention period.
28. Activity attribution is visible by default locally and never includes notes, inbound client credentials, or secret/token material. Ambient execution does not invent Profile attribution.
29. External auth sources are not imported automatically as managed Profiles and need no external-source selector.
30. Profile query and local mutations, including manual/automatic switching, perform no Provider network call and cannot start login, browser, or prompt interaction.
31. OAuth refresh holds a per-credential serialization lock through Pi's callback, holds the Provider record/file lock only for short read/publish sections, and publishes only when the exact Profile and credential generation remain current.
32. `Models.getAuth()` may perform only non-interactive OAuth token refresh while an exact managed Profile is consumed. Refresh failure stops the operation and never becomes automatic login or another Profile switch.
33. Changing `activeCredentialId` reuses the existing Pi `Models` and `Model` descriptors and does not call `Models.refresh()`. Credential-dependent model recheck is a separate explicit operation.
34. Interactive login/reconnect is entered only through an explicit user command and publishes credential state only after successful interaction.
35. A successful login/reconnect schedules Catalog refresh only when the newly published Profile is active. The non-blocking run remains bound to that exact credential and selection generation; stale results are discarded, and Catalog failure does not change the successful auth result.
36. Provider Native keeps the compatible client body authoritative and normally changes only its boundary-required top-level `model` selector. It reconstructs every Profile/Pi-owned transport fact from the captured binding, resolved Model, request lifecycle, and pinned Pi Agent Provider rules; it does not use a generic inbound-header passthrough.
37. Provider Native Responses and Semantic Conversion/Pi AI IR are absolutely uncoupled execution paths. Pi source is a Native mirror reference only; neither lane imports, calls, wraps, or reuses the other's credential-binding Adapter, request construction, execution, transport, retry, response handling, or semantic types.
38. First-party Anthropic `anthropic-messages` with a captured managed OAuth Profile is the sole Provider Native body-projection exception. Its lane-owned implementation mirrors only the pinned Pi Agent OAuth-dependent Claude Code identity/tool-name differential, preserves unrelated semantics, and does not enter or reuse Pi AI IR/Pi Provider execution.

Any change to these decisions requires new product evidence and an explicit PRD revision.
