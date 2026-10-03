# Token Provider Credential Profiles Specification

**Status:** AUTHORITATIVE TARGET SPEC — NOT YET IMPLEMENTED  
**Date:** 2026-10-02  
**Scope:** Provider Profiles, credential references, acquisition, Profile credential read/modify operations, Pi CredentialStore adaptation, selection and lifecycle boundaries.

**Supersedes:** `TokenProviderCredentialCoreModelPlan.md`, `TokenExternalProviderCredentialSourcesSpec.md`, `TokenProviderCredentialProfilesPRD.md`, and `TokenProviderCredentialProfilesImplementationPlan.md`.

This document is the single authoritative specification for Token Provider credential Profiles.

## 1. Core rule

Token separates **how a credential reference is established** from **how that reference is later used**.

```text
Login / acquisition
        ↓
establish one new Profile credential reference
        ↓
Profile identity/reference lifetime becomes stable
(metadata, enablement, ordering and selection may still change)
        ↓
when used:
Profile → reference → current credential document → Credential → Pi AI
```

The central invariant is:

> **Acquisition establishes a reference. Runtime use resolves the reference.**

Token does not treat the credential bytes observed during acquisition as the long-lived Profile state.

A Profile therefore represents an identity and a reference, not a cached credential snapshot.

## 2. Pi boundary

Token owns Profiles. Pi AI does not.

Pi sees only its existing CredentialStore contract and Pi credential types:

```ts
CredentialStore.read(providerId)
CredentialStore.list()
CredentialStore.modify(providerId, callback)
CredentialStore.delete(providerId)

type Credential =
  | ApiKeyCredential
  | OAuthCredential;
```

Token adapts all four methods with the same Pi-facing method and Credential types, but Token deliberately narrows mutation authority at this ownership boundary. Pi never owns Token Profile lifecycle or externally owned credential documents.

In particular:

- `delete(providerId)` must not delete a Token Profile or any Token-managed credential document;
- `local_oauth.modify` does not execute a Pi mutation callback against externally owned state and instead resolves the current external reference again.

This is interface compatibility, not unrestricted Pi storage semantics.

The Profile selected for that operation, its acquisition kind, reference, ownership and concrete read/modify implementation are Token-internal facts. They are never added to Pi's interface.

Token may expose more acquisition kinds because multiple ways of establishing a Profile can resolve to the same Pi credential type:

```ts
type AcquisitionKind =
  | "api_key"
  | "oauth"
  | "local_oauth";
```

Current mapping:

| Token acquisition kind | Acquisition | Reference result | Pi credential type |
|---|---|---|---|
| `api_key` | user/provider setup supplies credential | Token writes managed document | `api_key` |
| `oauth` | Pi/provider OAuth login runs | Token writes managed document | `oauth` |
| `local_oauth` | Token locates an already-owned local auth document | Token records external reference | `oauth` |

`local_oauth` is a Token Profile acquisition concept. It is not a third Pi credential type.

No acquisition kind, Profile metadata, reference path, owner, or Profile credential-operation detail enters Pi AI IR.

## 3. Module boundaries

The design has six credential modules.

```text
Credential Management
    │ serializes user management operations
    ▼
Acquisition
    │ establishes
    ▼
Profile State
    │ owns
    ▼
Credential Reference
    │ used by
    ▼
Profile Credential Operations
    │ adapted by
    ▼
Pi CredentialStore Adapter
    │
    ▼
Pi AI
```

Credential Management controls only user-initiated management work. Runtime credential reads/refresh and 429 switching do not pass through it.

### 3.1 Acquisition module

Responsibility:

- expose Provider-supported Profile acquisition methods;
- establish the reference for a new Profile;
- never own runtime credential use.

There are two acquisition paths; Token does not force them behind one artificial strategy contract.

Managed `api_key` / `oauth` acquisition follows Pi's existing login path:

```text
Global Credential Management Guard
→ create AcquisitionBinding
→ Pi Models.login(providerId, api_key | oauth, interaction)
→ Provider login returns Credential
→ Pi calls CredentialStore.modify(providerId, callback)
→ AcquisitionBinding identifies this modify as publication of a new Profile
→ Token writes the managed credential document
→ Token establishes the managed reference
→ Token commits the new Profile
```

`local_oauth` is Token-owned local reference discovery and does not call Pi login or Pi `CredentialStore.modify`:

```ts
interface LocalOAuthRegistration {
  readonly providerId: string;
  readonly label: () => string | undefined;
  readonly icon: "key" | "account" | "terminal";
  acquire(signal?: AbortSignal): Promise<ExternalCredentialReference | null>;
  read(raw: string): OAuthCredential | undefined;
}
```

Provider packages register this contract once during `createProvider()` through
`input.host.registerLocalOAuth(registration)`. The public types are exported by
`@token/provider-contract/local-oauth`. Built-in local OAuth implementations use
the same contract. Providers supply reference discovery and a synchronous content
parser; neither callback receives a Profile, credential store, or Profile management
authority. `acquire` returns an absolute external file reference, or `null` when no
usable source is selected. Parser failure returns `undefined`.

Token canonicalizes the external path, performs a bounded read, validates the
registered parser's OAuth result, and commits one new Profile only on success.
Discovery/parser exceptions produce fixed secret-safe failures. Token owns all
credential-file I/O and all Profile identity, metadata, selection and persistence.
The durable result is only the external reference.

Each Provider may register at most one local OAuth method, and a package may only
register for the Provider it creates. Registration is staged with package loading:
invalid registration, duplicate registration, Provider ID mismatch, or package
creation failure publishes neither the package Providers nor their local OAuth
capabilities. The registration callback closes when `createProvider()` settles.
Functions are registered again at startup, never persisted. A Profile whose local
OAuth registration is missing remains visible, but credential use fails closed;
Token never guesses another Provider's parser or a generic file format.

Provider composition decides which acquisition methods exist.

If `openai-codex` registers `local_oauth`, that method is a Provider capability in Token. It is not additionally gated by a user setting.

There is no `integrations.codex.localLogin` capability switch.

Acquisition failure creates no Profile. Ordinary user acquisition/login always targets a new Profile.

#### 3.1.1 Developer guide: adding `local_oauth` to a Provider package

This extension concerns only `local_oauth`. Managed API-key/OAuth login continues
through the existing Pi login/publication path above. The persisted Profile shape,
selection, ordering, enablement and Pi CredentialStore interface are unchanged.

Provider developers implement two callbacks and register them while constructing
their existing Pi Provider. They do not construct a Profile or receive any Profile
state. The contract is:

| Field | Developer responsibility | Token responsibility |
|---|---|---|
| `providerId` | Use the ID of the Provider returned by this package | Check registration ownership and reject duplicates |
| `label` / `icon` | Supply a non-secret display label and one supported icon | Project the local-login option and Profile authentication label |
| `acquire(signal)` | Locate the external document and return `{ owner: "external", path: absolutePath }`; observe cancellation; return `null` if no source is selected | Canonicalize/validate the reference, read bounded current contents and validate the parser result before publishing a Profile |
| `read(raw)` | Synchronously parse file contents into Pi `OAuthCredential`; return `undefined` for invalid/unsupported content | Own file I/O, contain parser exceptions, validate/clone the returned credential, and use this same parser for later reads |

`read` is the Provider's content parser, not the Pi `CredentialStore.read` method.
It receives one string containing the current document contents, with no Profile,
file-write authority, or Token credential store. Its result is the existing Pi
OAuth credential shape (`type`, `access`, `refresh`, `expires`, plus any supported
Provider credential fields). `expires` is a finite Unix timestamp in milliseconds.
It must finish promptly and must not write or refresh the external document.

The reference code below assumes `createExampleProvider` is the package's existing
Pi Provider factory. Its existing Pi OAuth auth implementation must accept the
OAuth credentials produced by the parser. That factory and its managed login
functions do not need to be rewritten to add local login.

```ts
import type { OAuthCredential } from "@earendil-works/pi-ai";
import {
  PROVIDER_PACKAGE_CONTRACT_VERSION,
  type TokenProviderPackage,
} from "@token/provider-contract/package";
import type { LocalOAuthRegistration } from "@token/provider-contract/local-oauth";
import { homedir } from "node:os";
import { join } from "node:path";
import { createExampleProvider } from "./provider.js";

// This example external app writes access_token, refresh_token, and
// expires_at (milliseconds). Adapt only this parser to its actual format.
function parseLocalOAuthCredential(raw: string): OAuthCredential | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("access_token" in value) || typeof value.access_token !== "string" ||
    !("refresh_token" in value) || typeof value.refresh_token !== "string" ||
    !("expires_at" in value) || typeof value.expires_at !== "number" ||
    !Number.isFinite(value.expires_at)
  ) return undefined;
  return {
    type: "oauth",
    access: value.access_token,
    refresh: value.refresh_token,
    expires: value.expires_at,
  };
}

export const providerPackage = {
  contractVersion: PROVIDER_PACKAGE_CONTRACT_VERSION,
  createProvider(input) {
    const provider = createExampleProvider(input.configuration);
    const authPath = join(homedir(), ".example-app", "auth.json");
    const localOAuth: LocalOAuthRegistration = {
      providerId: provider.id,
      label: () => "Example app local account",
      icon: "terminal",
      async acquire(signal) {
        signal?.throwIfAborted();
        return { owner: "external", path: authPath };
      },
      read: parseLocalOAuthCredential,
    };
    input.host.registerLocalOAuth(localOAuth);
    return provider;
  },
} satisfies TokenProviderPackage;
```

The path/discovery logic belongs to the Provider. The example returns its known
path directly; Token then verifies that the file exists, is bounded/readable,
and parses successfully. Neither `acquire` nor `read` creates a Profile.

No Provider `modify` callback is registered: Token rereads the external reference
through the same parser when Pi calls `modify`, and ignores Pi's mutation callback.
The external application owns refresh. Registering also supplies the generic UI
capability; adding a Provider does not require a Provider-ID branch in the renderer.

At startup, register the functions again. Token dispatches existing Profiles using
the containing `providerId` and `acquisitionKind === "local_oauth"`; functions and
implementation IDs are never persisted. A missing registration or unreadable/invalid
document fails credential use while leaving the existing Profile intact.

Built-in reference implementation: `src/credentials/codex-local-oauth.ts` implements
the same discovery/parser contract for `openai-codex`, and Provider Runtime supplies
it to the same Token local OAuth operations used by package registrations.

### 3.2 Profile State module

Responsibility:

- own Profile identity and metadata;
- own Provider-local active selection;
- own enable/disable and Profile ordering;
- own Provider-level 429 switch policy;
- own acquisition kind needed for later read/modify dispatch;
- own the credential reference;
- never own credential bytes.

Target persisted Profile shape:

```ts
interface Profile {
  readonly credentialId: string;
  readonly acquisitionKind: AcquisitionKind;
  readonly reference: CredentialReference;

  readonly displayName: string;
  readonly note?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}
```

A Profile is already scoped by its containing Provider record, so `providerId` is not duplicated inside the persisted Profile.

Pi credential type is derived from `acquisitionKind` and is not persisted separately:

```text
api_key     → managed reference  → Pi api_key
oauth       → managed reference  → Pi oauth
local_oauth → external reference → Pi oauth
```

The owner/type pairing above is a persisted-state invariant; invalid combinations are rejected.

Profile ordering is represented once: the order of `profiles[]` in the Provider record is the user-visible order and the 429 fallback order. There is no persisted `priority` field and no independent set-priority operation.

Provider implementation identifiers, auth-method labels and identity hints are also not persisted Profile authority. In particular, persisted Profile state contains no `strategyId`, `authMethodLabel` or `identityHint`. Presentation labels and derived Pi auth type come from current Provider composition; current external-account identity, when needed, comes from the current referenced document.

A persisted Profile always has a reference.

Within one Provider, `displayName` is unique under case-insensitive comparison. Profile identity remains `credentialId`; the uniqueness rule exists to keep user-facing management unambiguous.

There is no persisted `unavailable | reference` carrier union.

If a referenced document cannot currently be read or parsed, the Profile still exists and still owns the same reference. The current operation fails closed.

### 3.3 Credential Reference infrastructure

A reference describes where the current credential document is and who owns writes.

```ts
type CredentialReference =
  | {
      readonly owner: "managed";
      readonly path: string;
    }
  | {
      readonly owner: "external";
      readonly path: string;
    };
```

The reference contains no persisted credential-content revision/hash.

Ownership rules:

- `managed`: Token owns the document and may atomically write it.
- `external`: another application owns the document; Token is read-only.
- Token never writes, deletes, moves, backs up, refreshes or garbage-collects an external document.

Infrastructure responsibilities are intentionally mechanical:

- bounded file read;
- path validation/canonicalization where required;
- parser input delivery;
- managed-file lock;
- managed-file atomic replace;
- external write prohibition;
- secret-safe failures.

It does not decide Profile read/modify semantics.

### 3.4 Profile Credential Operations module

This module is entirely internal to Token.

Each Profile type provides the default credential operations for that type:

```ts
interface ProfileCredentialOperations {
  read(
    profile: Profile,
    context: ProfileCredentialContext,
  ): Promise<Credential>;

  modify(
    profile: Profile,
    mutation: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
    context: ProfileCredentialContext,
  ): Promise<Credential | undefined>;
}
```

Current defaults are:

```text
api_key
→ default API-key read/modify

oauth
→ default managed OAuth read/modify

local_oauth
→ default external OAuth read/reread
```

A Provider may replace the default managed `api_key`/`oauth` `read`, `modify`, or
both. For `local_oauth`, Provider variation is supplied through the registered
content parser. Token implements the Profile read and reread operations itself.

Resolution is internal:

```text
Provider + Profile type has dedicated operations
→ use dedicated operations

otherwise
→ use Profile type defaults
```

This is implementation polymorphism inside Token. The persisted Profile contains only data and a reference; no function implementation is serialized into Profile state.

A dedicated Provider/Profile implementation may interpret the referenced document differently, but it cannot bypass reference ownership, bounded I/O, secret boundaries, or Pi AI IR isolation.

#### `api_key`

```text
read
→ read managed reference
→ parse API-key credential
→ return Credential

modify
→ serialize on the managed credential/reference
→ read current Credential
→ run Pi mutation callback
→ validate any returned Credential
→ before publication, reread authoritative Profile state under the required state/document locks
→ publish only if the same Profile still exists, is enabled, and still owns the same managed reference
→ otherwise discard the callback result
→ return the authoritative resulting Credential or no credential
```

#### `oauth`

```text
read
→ read managed reference
→ parse OAuth credential
→ return Credential

modify
→ serialize on the managed credential/reference
→ read current Credential
→ run Pi mutation callback
→ validate returned OAuth Credential
→ before publication, reread authoritative Profile state under the required state/document locks
→ publish only if the same Profile still exists, is enabled, and still owns the same managed reference
→ otherwise discard the callback result
→ return the authoritative resulting Credential or no credential
```

The post-callback publication check is mandatory because Provider refresh may perform network I/O while user management can independently disable or remove the Profile.

A late managed refresh must never resurrect a removed Profile or publish into a Profile that became disabled while refresh was in flight. The commit condition is based on current authoritative state, not the earlier ProfileBinding snapshot:

```text
same credentialId still exists
AND Profile is still enabled
AND reference.owner == managed
AND reference path is unchanged
→ publication may proceed

otherwise
→ discard callback result
→ do not write credential bytes
→ do not recreate Profile/reference state
→ fail closed / return no current credential
```

Managed credential publication and managed-file garbage collection must serialize on the same credential/document ownership boundary so an orphan collector cannot race a late refresh publication.

Pi/provider code decides when OAuth refresh is required and performs the Provider-specific refresh inside the callback. Token owns only the safe current-document read/write/publication boundary.

#### `local_oauth`

```text
read
→ read external reference
→ parse current OAuth credential
→ return Credential

modify
→ do not execute Pi's mutation callback
→ do not write external document
→ perform the selected Profile read again
→ return the current Credential from the reference
```

The default `local_oauth.modify` is therefore semantically just a fresh `read`.

This is intentional: Pi's `modify` contract returns the post-modification current Credential, and for an externally owned reference Token performs no modification. The external owner controls refresh.

Every `local_oauth` read uses that Provider's registered parser. The common
`local_oauth.modify` invokes the same read again. Providers do not register a
local OAuth `modify`; the external owner remains responsible for credential
refresh. Token never executes the Pi mutation callback or adopts its result.

For `openai-codex`, the registration locates Codex's `auth.json` and supplies its
Codex-specific parser. The Profile operations module has no Codex special case.

### 3.5 Pi CredentialStore Adapter

This is a thin composition-private Adapter.

Its Pi-facing contract remains Pi's existing four-method contract:

```text
CredentialStore.read(providerId)
CredentialStore.list()
CredentialStore.modify(providerId, callback)
CredentialStore.delete(providerId)
```

Token uses only two credential bindings internally:

```text
AcquisitionBinding
→ a managed api_key/oauth Pi login is publishing one new Profile

ProfileBinding
→ one runtime operation is fixed to one exact existing Profile
```

`local_oauth` acquisition does not require an AcquisitionBinding because it never enters Pi login or Pi `CredentialStore.modify`.

There is no AmbientBinding.

Internal `read(providerId)` behavior:

```text
ProfileBinding
→ resolve that exact Profile
→ resolve that Provider/Profile's credential operations
→ operations.read(profile)

no ProfileBinding
→ if the Provider has no Token Profiles, return undefined
→ otherwise fail closed because a Profile-bearing operation lost its binding
```

Returning `undefined` means only that Token has no Profile credential for Pi to read. Pi may then apply its own ambient authentication rules where supported.

Internal `modify(providerId, callback)` behavior:

```text
AcquisitionBinding
→ execute the acquisition publication path
→ callback yields the credential produced by Pi login when applicable
→ write/establish the credential reference
→ create the new Profile

ProfileBinding
→ resolve that exact Profile
→ resolve that Provider/Profile's credential operations
→ operations.modify(profile, callback)

no binding
→ reject; Token does not manage an ambient credential
```

Internal `list()` behavior:

```text
for each Provider with an active Token Profile
→ project exactly one Pi CredentialInfo for that active Profile

Provider has Profiles but no active Profile
→ project nothing for that Provider

Provider has no Token Profiles
→ project no Token credential entry
```

`list()` never exposes inactive Profiles, Token Profile identity, reference, acquisition kind or Provider-specific implementation details. Pi therefore retains its one-current-credential-per-Provider view.

Internal `delete(providerId)` behavior:

```text
Token-managed Profile exists
→ reject the Pi delete operation
→ never delete a Profile
→ never delete a managed credential document

no Token Profile
→ Token has no credential state to delete
```

Profile removal is exclusively a Token Profile-management operation. Pi logout/delete is not an ownership authority for Token data.

Token Profile management must not use Pi `Models.logout()` as its removal path. In Profile mode, logout/delete and Profile removal are deliberately separate authorities.

The internal binding, Profile, acquisition kind, reference and selected operations never cross the Pi interface.

The Adapter itself contains no Provider-specific credential parsing or mutation logic.

Pi sees only its normal `api_key | oauth` Credential.

The Adapter does not expose Profiles to Pi and does not expose Pi's CredentialStore to protocol layers.

## 4. Runtime reference semantics

Every real use resolves the current reference.

```text
request / catalog / usage operation
→ exact Profile binding
→ Profile.reference
→ read current document
→ parse current Credential
→ use
```

A previous failed read is not authority for a future read.

Therefore Token must not use a persistent or process-local `referenceHealth = unavailable` value to prevent a later reference resolution.

Health may describe the most recently observed state for UI/diagnostics, but:

> **Health is observation, not credential authority.**

Example:

```text
Codex auth.json temporarily invalid
→ one operation fails

Codex repairs auth.json

next operation
→ reads the same reference again
→ current file is valid
→ operation succeeds
```

Token does not need to monitor the file, subscribe to changes, maintain a content revision, or convert an external file update into a Profile generation change.

## 5. Revisions and selection generation

Only state versions that protect Token-owned state transitions remain.

### 5.1 Provider record revision

Keep the Provider Profile record `revision`.

Purpose:

- optimistic concurrency for Profile management commands;
- reject stale UI/CLI mutations.

It versions the Profile record, not credential file contents.

### 5.2 Credential identity

There is no `credentialGeneration`.

A Profile is one credential/reference lifetime and `credentialId` is sufficient to identify it. Ordinary login creates a new Profile with a new `credentialId`; OAuth refresh updates the managed document behind the same reference; external-owner content changes are observed through the same reference.

A `ProfileBinding` therefore pins the exact Profile identity used by the operation. It may also capture the selection generation when later selection-sensitive side effects need stale/ABA protection.

Changing the Provider's active Profile after an operation starts does not retarget or invalidate that operation: a request bound to Profile A continues to use Profile A even if the active selection becomes B.

### 5.3 Selection generation

Keep `selectionGeneration`.

Purpose:

- version Provider-local active selection;
- detect stale selection-sensitive side effects and A → B → A selection ABA.

It is not credential identity and does not make an already-bound request follow a later active selection.

### 5.4 Credential document revision

Remove persisted credential content revision/hash from the Profile/reference model.

Token does not need a long-lived hash to prove that a reference still points to the same credential bytes.

For managed documents, correctness comes from Token's locks and atomic writes.

For external documents, current content belongs to the external owner and is resolved when used.

A temporary hash may still be used internally by a bounded operation such as backup integrity verification, but it is not persisted as Profile state.

## 6. Runtime observations and 429 switching

Token has no generic Profile `CredentialHealth` state machine and no public Profile `health` field.

Credential validity is established by the current operation resolving the current reference. A previous success or failure is not durable authority for a later operation.

Subsystems may keep only the bounded ephemeral observations they actually own. For example, 429 switching may keep a cooldown deadline. Usage observations are semantically Profile-scoped: one usage observation belongs to one exact Provider Profile, while the Provider Usage module owns only acquisition, validation and cache mechanics. Usage is not persisted inside the credential Profile record.

A failed current credential read fails closed and never falls back to another credential implicitly. A later operation resolves the reference again.

429 switching remains an explicit Token runtime policy and may select another eligible Profile according to the existing Provider policy.

A runtime 429 switch must never publish from a stale Provider record or overwrite a user management change. The request captures the active Profile and its `selectionGeneration`. When switching, Token acquires the Provider selection/state lock, reads the latest record, and may change only selection-related state if the captured selection is still current.

```text
request captured:
active = A
selectionGeneration = G1

user later activates/disables/removes selection-relevant Profile state
→ selectionGeneration becomes G2

old request receives final 429
→ G1 != G2
→ stale
→ do not change active selection
```

Unrelated Profile metadata changes do not need to invalidate the request, but the 429 path must operate on the latest record and modify only its owned selection fields so it can never roll back newer metadata or other Profile state.

## 7. Acquisition creates Profiles

Token supports exactly three acquisition kinds:

```text
api_key
oauth
local_oauth
```

A user acquisition/login always creates a new Profile.

### 7.1 Global Credential Management Guard

All user-initiated Credential/Profile management operations share one global exclusive guard.

The guard is fail-fast, not a queue:

```text
operation starts
→ try to acquire Global Credential Management Guard

guard free
→ acquire it
→ perform the complete management operation
→ commit or fail/cancel
→ release in finally

guard already held
→ do not start the second operation
→ return management_operation_in_progress
→ return the active operationId plus bounded non-secret operation metadata
→ UI tells the user that the previous operation must be completed or cancelled first
```

Each guarded operation owns a unique opaque `operationId` for its lifetime.

`operationId` is a Credential Management domain identity. It is not a model/protocol request id, Control Plane transport correlation id, HTTP request id, or Pi request identity. It must not be reused from or derived from those transport/protocol identifiers. This keeps Credential Management independent of whichever interface initiated the operation.

The busy response must not expose credential secrets. It may expose bounded non-secret facts such as `operationId`, operation kind, Provider identity and start time.

The guard has no standalone public query/status API and is not projected into Profile/provider DTOs. It is an internal control mechanism. Active-operation metadata is exposed only when needed to reject a conflicting management operation or to address an explicit cancellation.

The management surface must support explicit cancellation by `operationId`:

```text
cancelManagementOperation(operationId)
→ if it identifies the current guarded operation:
     abort that operation
     let the operation unwind through its normal cancellation path
     release the guard in finally
→ otherwise:
     return not_found/stale without affecting the current operation
```

Cancellation never force-unlocks the guard independently of the operation. The operation must observe the abort, terminate, and release its own lease from `finally`.

The guard covers all user-initiated Credential/Profile mutations, including:

- `api_key`, `oauth` and `local_oauth` acquisition;
- activate;
- enable/disable;
- Profile metadata edits;
- reorder;
- remove.

While one guarded operation is active, no other user Credential/Profile management operation may start.

The guard is an in-process Credential Management lease owned by the Backend credential-management authority, not by the Control Plane transport and not by persisted credential state. It must never survive process restart as a stored lock.

#### Guard termination contract

Every guarded operation must have a terminal path. The guard must be released exactly once from a `finally` path after:

- success;
- validation/storage/provider failure;
- explicit user cancellation;
- auth interaction cancellation;
- Control Plane client/connection loss;
- operation timeout/deadline;
- any propagated abort.

The operation's abort signal must be propagated through every cancellable sub-operation, including Pi login and local acquisition. A caller must never abandon a still-running guarded operation without aborting it.

Interactive authentication is the only management operation expected to wait materially on the user. It must therefore have a finite overall deadline in addition to explicit cancellation. Provider-specific prompt/device-code expiry may end the flow earlier, but no Provider login may hold the global guard indefinitely. The concrete deadline is a Token control-plane policy, not a Provider/Profile data field.

Short non-interactive management operations must keep all storage/locking work bounded and release the guard on every error path.

This is the sole user-management serialization mechanism. Acquisition does not define a separate optimistic-concurrency snapshot, recheck phase, or acquisition-specific concurrency protocol. Its final Profile creation is simply part of the same guarded operation.

The guard does not cover runtime credential use. Request credential reads, managed OAuth refresh, usage/catalog work and explicit runtime 429 switching continue independently under exact Profile bindings and the appropriate state/document locks.

This remains true when the Provider already has other Profiles. A new OAuth login must not overwrite or reinterpret an existing Profile; it creates another Profile.

There is no separate Reconnect authentication type or fourth acquisition kind.

If acquisition fails, no new Profile is created and existing Profiles are unchanged.

Acquisition and selection are separate semantics:

```text
first Profile for a Provider
→ create Profile
→ make it active

additional Profile
→ create Profile
→ do not change the current active Profile
```

Activation after creation is a separate Profile-management action. Acquisition itself must not implicitly replace an existing active selection.

If the active Profile is later disabled or removed:

```text
active Profile disabled/removed
→ clear active selection
→ do not automatically choose another Profile
```

Disabling or removing a Profile does not proactively cancel requests that already started with that Profile.

```text
request already resolved the needed auth
→ it may continue

same in-flight operation later needs another credential read/modify
→ the Profile is now disabled/removed
→ fail closed
→ never recreate or republish the removed Profile
```

If other Profiles remain, the Provider simply has Profiles with no active selection until an explicit activation or explicit 429-switch policy selects one. If no Profiles remain, Token has no Profile credential for that Provider.

`local_oauth` acquisition does not call Pi login. Token locates and validates the externally owned credential document, establishes the external reference, and creates the Profile.

## 8. Singleton acquisition

`local_oauth` is singleton per Provider.

A Provider may have at most one Profile whose `acquisitionKind === "local_oauth"`. Disabled Profiles still count; after that Profile is removed, a new `local_oauth` Profile may be acquired.

```text
before local_oauth acquisition
→ read current Provider Profile state
→ if any local_oauth Profile already exists:
     return duplicate
     do not acquire
     do not read the external source
→ otherwise acquire and commit the new Profile
```

This rule is based on Profile type, not strategy implementation id or external path.

The singleton check executes while holding the Global Credential Management Guard. Because no other user Credential/Profile mutation can run until the guarded operation finishes, one authoritative singleton check is sufficient.

## 9. Profile removal and credential ownership

Removing a Profile is a Token Profile-management operation.

For a managed reference:

```text
remove Profile from authoritative Provider record
→ Profile removal becomes visible immediately
→ referenced Token-owned credential document becomes collectible
→ garbage collection may delete the now-unreferenced managed document later
```

Profile removal must not depend on physical file deletion succeeding in the same transaction. The Profile record is the visibility/authority point; managed-file collection is separate maintenance.

Garbage collection may delete only Token-owned managed credential documents that are no longer referenced by any current Profile and have passed the implementation's safety checks/grace rules.

For an external reference:

```text
remove Profile
→ remove only Token's reference/profile state
→ never delete, modify, move, back up or garbage-collect the external document
```

Pi `CredentialStore.delete(providerId)` is never a substitute for Profile removal and has no authority to delete Token Profile state or credential files.

## 10. No-Profile / ambient authentication

Ambient authentication is not a Token Profile and has no Token binding.

If a Provider has no Token Profiles, `CredentialStore.read(providerId)` returns `undefined`. Pi may then apply its own ambient authentication rules where supported.

If a ProfileBinding exists, that exact Profile is authoritative for the operation. If the Profile disappears, is disabled, or its reference cannot be read, the operation fails closed.

Token never converts a failed bound Profile into ambient authentication.

Ambient auth therefore has no Profile identity, reference, acquisition kind, Token read/modify implementation, Profile 429 eligibility or Profile attribution.

## 11. Public contracts

Public Profile DTOs may expose:

- Profile identity;
- `acquisitionKind`;
- derived Pi credential type and Provider auth-method label;
- display name/note;
- enabled state and list order;
- active selection state.

There is no generic Profile health projection. Usage/accounting is a runtime facet of one exact Profile. The Provider Usage module owns how usage is acquired and cached, but its observation identity is `providerId + credentialId`, and UI presentation attaches that usage to the matching Profile. Request/activity observations remain owned by their own authorities.

Derived Pi credential type/auth-method labels are presentation/runtime projections from `acquisitionKind` plus current Provider composition. They are not persisted Profile authority.

`activeCredentialId` remains Provider selection authority because runtime binding and 429 switching require one exact selected Profile. A Renderer derives the selected row and Provider-card presentation from it. The Provider card therefore shows the selected Profile and that Profile's usage, if observed; it does not need a second `active`/health status field or Provider-level usage identity.

They must not expose:

- reference path;
- reference owner;
- raw Credential;
- acquisition strategy implementation id unless explicitly required internally;
- Pi CredentialStore;
- Provider-specific credential-operation implementation details.

Acquisition options are projected from Provider composition.

No separate setting may hide a registered Provider acquisition capability unless there is an independent product requirement for such a setting.

## 12. Provider/Profile credential-operation overrides

Profile types own default `read` and `modify` semantics.

A Provider may supply dedicated managed credential operations when its referenced
document requires different parsing, validation or modification semantics.
Local OAuth Providers supply a content parser through `registerLocalOAuth`;
Token applies the common external read/reread semantics around that parser.

Example:

```text
local_oauth common Token operations
├─ read   → bounded file read → registered Provider parser
└─ modify → perform the same read again

openai-codex + local_oauth
├─ parser → Codex auth.json → Pi OAuthCredential
└─ read/modify → common Token operations
```

Each Provider's local OAuth registration supplies its own parser. No Provider
receives Profile state, and no function or parser identity is persisted.

This override mechanism is Token-internal. It does not create a Provider-specific Pi CredentialStore and does not alter Pi's `read(providerId)` / `modify(providerId, callback)` interface.

Provider-specific implementations must not place Provider-private types into Profile State, protocol layers, Pi AI IR, or public Control Plane contracts.

## 13. Required invariants

1. A persisted Profile always has exactly one credential reference.
2. User acquisition/login creates a new Profile and establishes its reference; runtime use resolves that reference.
3. Credential bytes are never Profile state.
4. Every use reads through the current reference.
5. A previous failed read cannot prevent a later read.
6. `managed` references may be written only by Token credential infrastructure.
7. `external` references are never written by Token, including Provider-specific branches.
8. Pi receives only Pi `api_key | oauth` Credentials.
9. `acquisitionKind` is persisted Profile type authority and determines both the default credential operations and the derived Pi credential type; `authType` is not separately persisted.
10. `api_key` and `oauth` Profiles own managed references; `local_oauth` Profiles own external references. Other owner/type combinations are invalid.
11. A Provider may replace managed Profile `read`, `modify`, or both; local OAuth variation uses the registered parser with Token-owned external read/reread semantics.
12. Provider/Profile operation selection is entirely Token-internal and never changes Pi's CredentialStore method/type interface.
13. Token's common external `modify` never adopts Pi callback output as authority; its returned current Credential comes from a fresh external read using the registered Provider parser.
14. `credentialGeneration` does not exist; `credentialId` identifies the Profile credential/reference lifetime, while Provider record `revision` and `selectionGeneration` protect different Token state transitions.
15. Persisted Profile state does not duplicate Provider identity, Pi auth type, ordering priority, Provider implementation ids, auth-method labels, identity hints, or credential content revision/hash.
16. `profiles[]` order is the single Profile ordering authority for UI reorder and 429 fallback.
17. A broken referenced credential fails closed; it never silently falls back to ambient or another Profile.
18. Profile/reference/operation-selection details never enter Pi AI IR or Pi's CredentialStore contract.
19. Token has only two credential bindings: `AcquisitionBinding` for managed Pi login publication and `ProfileBinding` for runtime use of one exact existing Profile; `local_oauth` acquisition needs no binding and there is no `AmbientBinding`.
20. No ProfileBinding plus zero Token Profiles may return `undefined` from Pi `read(providerId)`; an existing/bound Profile that disappears or becomes unreadable fails closed.
21. Pi `delete(providerId)` and `Models.logout()` never delete Token Profile state or credential documents; Token-managed Profile removal is owned exclusively by Token Profile management.
22. Removing an external Profile removes only Token's reference/state; the external document is never mutated or collected.
23. Removing a managed Profile makes its unreferenced Token-owned document eligible for separate safe garbage collection; physical deletion is not part of the Profile-removal commit.
24. A managed `modify` may publish after its callback only if the same enabled Profile still exists and still owns the same managed reference; otherwise the result is discarded and can never resurrect Profile state.
25. Managed credential publication and orphan collection serialize on the same credential/document ownership boundary.
26. The first Profile committed for a Provider becomes active; creating any later Profile does not change an existing active selection. User credential/Profile management is globally serialized, so concurrent first-Profile creation is not a supported state.
27. Disabling or removing the active Profile clears active selection and never automatically activates another Profile.
28. `local_oauth` is singleton per Provider, regardless of implementation or external path.
29. Within one Provider, `displayName` is case-insensitively unique; `credentialId` remains the actual Profile identity.
30. Every user-initiated Credential/Profile management mutation executes under one global exclusive Credential Management Guard; two such operations never overlap.
31. Every guarded operation has a unique opaque Credential Management `operationId`; it is independent of protocol/HTTP/Pi/Control Plane request identifiers.
32. Guard acquisition is fail-fast and never queued; a second operation returns `management_operation_in_progress` with bounded current non-secret operation metadata.
33. The current guarded operation can be explicitly cancelled by `operationId`; cancellation aborts the operation and the operation itself releases the guard from `finally`. Cancellation must never directly force-unlock a live operation.
34. Every guarded operation is abortable/bounded and releases the guard from `finally` on success, failure, cancellation, connection loss, timeout or propagated abort; an interactive login may never hold the guard indefinitely.
35. The global guard is the sole user-management serialization mechanism. Acquisition has no separate concurrency, snapshot or second-check protocol.
36. The Global Credential Management Guard has no standalone public query/status API and is not part of public Profile/provider state; its active-operation metadata is exposed only on a conflicting management operation or explicit cancellation path.
37. Runtime credential use does not acquire the global management guard and remains protected by Profile binding and state/document locking.
38. Profile state and public Profile DTOs have no generic `CredentialHealth` enum/field.
39. Usage observations are Profile-scoped runtime data: they belong to exactly one `providerId + credentialId`; Provider Usage owns acquisition/cache mechanics but never creates Provider-level usage detached from a Profile.
40. Ambient authentication has no Profile identity and therefore has no Profile Usage projection.
41. `activeCredentialId` is the single Provider selection authority; UI selection/card presentation and Provider-card usage are derived from the selected Profile and do not require a duplicate active-status field.
42. A runtime 429 switch may update selection only when its captured `selectionGeneration` is still current; it must use the latest Provider record and modify only selection-owned fields, so stale requests can never overwrite newer user management state.
43. Disabling or removing a Profile does not proactively cancel an already-running request; any later credential resolution against that disabled/removed Profile fails closed and can never recreate the Profile.
44. Pi `list()` exposes at most the active Token credential per Provider and never exposes inactive Profile multiplicity.
45. Protocol conversion layers never depend on concrete Profile credential-operation implementations.
46. All local OAuth Providers use one discovery/content-parser registration contract; Provider callbacks receive no Profile or credential-store authority.
47. Every local OAuth credential read and modify uses that Provider's current registered parser; a missing registration fails closed without deleting Profile state or guessing a parser.

## 14. Target module map

Recommended ownership:

| Module | Owns |
|---|---|
| `credentials/profile-state` | Profile records, identity, selection and metadata |
| `credentials/reference` | reference types, bounded read, managed atomic write, ownership enforcement |
| `credentials/management` | fail-fast global exclusive guard, Credential Management-owned operation IDs, active-operation metadata, explicit cancellation/deadline ownership and guaranteed release for all user Credential/Profile management mutations |
| `credentials/acquisition` | managed Pi-login publication orchestration plus Provider local-reference acquisition capabilities inside the guarded management workflow |
| `credentials/profile-credential-operations` | default `read`/`modify` operations per Profile type, managed Provider/Profile-specific replacements, and common local OAuth operations using the registered parser |
| `credentials/pi-store-adapter` | adapt Pi `CredentialStore.read/list/modify/delete`; dispatch read/modify internally while preventing Pi from owning Token Profile lifecycle |
| Provider composition | local OAuth discovery/parser registration plus any managed Provider/Profile credential-operation replacements |

Exact filenames may differ. The ownership boundaries are normative; filenames are not.

## 15. Implementation consequences for the current code

The current implementation should be simplified toward this contract.

Remove or redesign:

- `integrations.codex.localLogin`;
- the artificial idea that every acquisition kind is one `AcquisitionStrategy -> reference` path; managed `api_key/oauth` must follow Pi `Models.login() -> CredentialStore.modify()`, while `local_oauth` is direct external-reference acquisition;
- persisted external credential content revision/hash;
- persisted `unavailable | reference` Profile carrier;
- persisted Profile `providerId`, `authType`, `priority`, `strategyId`, `authMethodLabel` and `identityHint`; derive/scoped facts instead;
- `setPriority`; `profiles[]` order is the single ordering authority and `reorderProfiles` is the ordering mutation;
- the generic `CredentialHealth` enum/Profile `health` projection and `referenceHealth`/runtime-health state when used as credential authority; keep only subsystem-owned ephemeral facts that are mechanically required, such as a 429 cooldown;
- Credential Profile `recheck` commands, `captureForRecheck`, and their Profile-health transitions; normal use already resolves the current reference and explicit Catalog refresh remains a separate Catalog capability;
- Token-owned external OAuth five-minute pre-gate when it duplicates Pi credential resolution policy;
- `credentialGeneration` and generation-keyed credential paths/bindings;
- acquisition-time `useNow` coupling and acquisition-specific concurrency/second-check machinery; acquisition participates in the same global Credential Management Guard as every other user Profile mutation, while activation remains a separate Profile-management action except for the automatic first-Profile rule;
- reconnect-as-existing-Profile-replacement commands/bindings and other reconnect lifecycle machinery; ordinary acquisition creates a new Profile;
- legacy external/ambient binding/capture machinery that is no longer produced by real Profile bindings;
- Provider-specific parsing/mutation branches currently embedded in generic CredentialStore/document code; move them behind Profile credential operations.

Credential Profiles expose no separate recheck operation. If the product needs a manual Catalog refresh, it uses the existing Catalog authority directly and does not route that operation through Credential Profile state.

Retain:

- Profile identity;
- Provider record optimistic-concurrency revision for stale user-intent detection even though management execution itself is serialized;
- selection generation;
- managed/external ownership;
- bounded reads and safe parsing;
- managed locking and atomic writes;
- fail-closed resolution;
- active selection and explicit 429 switching;
- secret boundaries;
- exact request binding.

## 16. Acceptance model

The architecture is correct when these examples work without special cross-module state.

### Managed API key

```text
Add API key
→ Global Credential Management Guard
→ AcquisitionBinding
→ Pi Models.login(api_key)
→ Provider login produces api_key Credential
→ Pi CredentialStore.modify()
→ Token writes managed document
→ Token commits Profile with managed reference
→ later read resolves reference
→ Pi receives api_key Credential
```

### Managed OAuth

```text
OAuth login
→ Global Credential Management Guard
→ AcquisitionBinding
→ Pi Models.login(oauth)
→ Provider login produces OAuth Credential
→ Pi CredentialStore.modify()
→ Token writes managed document
→ Token commits Profile with managed reference

later:
Pi read → Profile oauth read
Pi decides refresh is needed
Pi modify(callback)
→ Profile oauth modify serializes this managed credential
→ callback performs Provider refresh
→ Token rechecks current authoritative Profile/reference
→ if the same Profile still exists, is enabled and owns the same managed reference:
     atomically publish refreshed credential
→ otherwise:
     discard the late callback result
     never recreate Profile state
```

### Codex local OAuth

```text
Add Local Codex
→ Token validates/locates Codex auth.json
→ Profile stores external reference

later:
Pi calls `read("openai-codex")`
→ Token resolves the bound `openai-codex + local_oauth` Profile
→ Token uses Codex-specific local OAuth `read`
→ current Codex auth.json is parsed
→ Pi receives oauth Credential

Codex changes auth.json
→ Token changes no Profile state
→ next read sees current auth.json

Pi calls `modify("openai-codex", callback)`
→ Token resolves the same bound Profile
→ selected `local_oauth.modify` performs no write
→ by default it invokes the selected Codex `read` again
→ does not run Pi refresh callback
→ returns the current Credential from Codex auth.json
```

This is the intended credential model.
