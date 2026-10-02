# Token Provider Credential Profiles Implementation Plan

**Status:** PLANNED — NOT STARTED
**Date:** 2026-10-02
**Authority:** [Token Provider Credential Profiles Specification](./TokenProviderCredentialProfilesSpec.md)

This document is an implementation sequence only. If it conflicts with the Specification, the Specification wins.

## 1. Implementation objective

Replace the current credential/Profile implementation with the smallest design that satisfies the target contract:

```text
Credential Management
→ Acquisition
→ Profile State
→ Credential Reference
→ Profile Credential Operations
→ Pi CredentialStore Adapter
```

The implementation must remove duplicate credential authority rather than preserve old behavior through compatibility layers.

No migration, dual-read, reconnect shim, legacy Profile carrier, or old Control Plane compatibility path is required.

## 2. Phase 1 — Shrink Profile State and storage

Primary files:

- `src/credentials/profile-record-store.ts`
- `src/credentials/profile-contract.ts`
- backup code that reads Provider credential records

Target persisted Profile:

```ts
interface Profile {
  readonly credentialId: string;
  readonly acquisitionKind: "api_key" | "oauth" | "local_oauth";
  readonly reference: CredentialReference;
  readonly displayName: string;
  readonly note?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}
```

Remove persisted:

- `credentialGeneration`;
- `authType`;
- `priority`;
- `strategyId`;
- `authMethodLabel`;
- `identityHint`;
- credential-content revision/hash;
- `unavailable | reference` carrier.

Rules:

- `profiles[]` order is the only Profile ordering authority.
- `activeCredentialId` remains the only active-selection authority.
- `revision` remains stale-user-intent protection.
- `selectionGeneration` remains 429/selection ABA protection.
- `api_key/oauth` must own managed references.
- `local_oauth` must own an external reference.
- Provider-local `displayName` remains case-insensitively unique.
- No v2 compatibility reader is retained; advance the credential-record schema for the new current format.

Backup must stop depending on a persisted reference hash. If a backup needs integrity verification, compute a temporary hash from the managed document during that backup operation.

Gate:

- focused record/store tests prove strict target-shape validation, ordering, selection, duplicate-name rejection and managed/external ownership constraints.

## 3. Phase 2 — Separate reference I/O from credential semantics

Primary files:

- `src/credentials/credential-document.ts`
- new or refactored Profile credential-operation code
- Provider composition for Codex local OAuth

Credential-reference infrastructure owns only:

- bounded reads;
- path safety/canonicalization;
- managed locking;
- managed atomic write;
- external read-only enforcement;
- safe file lifecycle/GC primitives.

It must not dispatch on concrete Provider identity.

Profile Credential Operations own:

```text
api_key     → managed read/modify
oauth       → managed read/modify
local_oauth → external read / modify-as-fresh-read
```

Provider composition may replace `read`, `modify`, or both for one Provider/Profile type.

Move Codex-specific `auth.json` parsing out of generic credential-document infrastructure and behind the `openai-codex + local_oauth` operation.

External operations must never write the reference or adopt a Pi callback result as current state. Any returned Credential must come from a current external-reference read.

Gate:

- generic reference tests have no Provider-specific cases;
- Codex local OAuth tests exercise the Provider/Profile override;
- external write attempts remain impossible.

## 4. Phase 3 — Simplify bindings and Pi CredentialStore adaptation

Primary files:

- `src/credentials/profile-authority.ts`
- `src/credentials/profile-contract.ts`
- composition/runtime wiring

Retain only:

```text
AcquisitionBinding
→ managed api_key/oauth login publication

ProfileBinding
→ exact runtime Profile
```

`local_oauth` acquisition has no AcquisitionBinding because it does not enter Pi login or Pi `CredentialStore.modify()`.

Remove:

- `credentialGeneration` from bindings;
- reconnect mode/bindings;
- AmbientBinding;
- legacy external-as-separate-Profile binding state;
- persisted reference-health authority.

The Pi adapter remains the normal four-method interface:

```text
read
list
modify
delete
```

Behavior:

- `read`: exact bound Profile; no Profile + zero Token Profiles may return undefined for Pi ambient resolution.
- `modify`: AcquisitionBinding publishes a new managed Profile; ProfileBinding dispatches selected Profile operations.
- `list`: at most the active Profile per Provider.
- `delete`: never deletes Token Profile state or managed documents.
- Token Profile removal never uses `Models.logout()`.

Usage is Profile-scoped runtime data. Provider Usage may use short-lived external account/document fingerprints to prevent cross-account cache attribution, but every observation is attached to one exact `providerId + credentialId`. These facts are not persisted credential Profile state.

Gate:

- Pi read/list/modify/delete tests match the Specification;
- external/local OAuth remains read-only;
- no protocol layer receives Profile/private operation types.

## 5. Phase 4 — Global Credential Management Guard and acquisition

Primary files:

- credential management/control-plane orchestration
- `src/credentials/acquisition.ts`
- `src/credentials/profile-control-plane.ts`

Implement one Backend-lifetime, fail-fast Global Credential Management Guard.

Minimal active-operation state:

```ts
{
  operationId,
  kind,
  providerId?,
  startedAt,
  abortController
}
```

`operationId` belongs to Credential Management. It is independent of HTTP, Pi, model-protocol and Control Plane request identifiers.

The guard owns only operation lifecycle:

- fail-fast acquire;
- explicit cancel by `operationId`;
- abort/deadline propagation;
- release from `finally`.

It does not own Profile state, credentials, Provider parsing or runtime retries.

Guarded operations:

- `api_key/oauth/local_oauth` acquisition;
- activate;
- enable/disable;
- metadata edit;
- reorder;
- remove;
- switch-policy mutation.

Not guarded:

- query;
- runtime credential read/refresh;
- Profile-scoped Provider Usage acquisition/cache work;
- Catalog work;
- 429 switching;
- cancellation of the current guarded operation.

Acquisition paths:

```text
api_key/oauth
→ Guard
→ AcquisitionBinding
→ Models.login()
→ CredentialStore.modify()
→ managed document/reference
→ create new Profile
```

```text
local_oauth
→ Guard
→ singleton check
→ validate/read Provider-owned local source
→ external reference
→ create new Profile
```

Remove acquisition `useNow`, acquisition-start `expectedRevision`, reconnect and strategy-id persistence.

Selection rule:

- first Profile becomes active;
- later acquired Profile does not change active selection.

Gate:

- second management operation returns `management_operation_in_progress` without starting or queueing;
- cancel aborts the active operation and the operation releases the guard itself;
- connection loss, timeout and all failures release the guard;
- one Provider's management operation blocks a simultaneous user management operation for another Provider.

## 6. Phase 5 — Runtime correctness: managed modify and 429 switching

Primary files:

- record/store managed credential mutation
- Profile binding/429 switching
- Provider Usage consumers of Profile binding facts
- Catalog consumers of Profile binding facts

Managed `modify` must tolerate Provider refresh network latency without holding stale authority.

Flow:

```text
serialize on managed credential
→ read current Profile/reference/Credential
→ run Pi callback
→ reacquire/read current authoritative Profile state
→ publish only if:
     same credentialId exists
     Profile is still enabled
     reference is still managed
     reference path is unchanged
→ otherwise discard callback result
```

A late refresh must never:

- recreate a removed Profile;
- write into a disabled Profile;
- publish into a replaced/different reference.

Managed publication and orphan collection must share the credential/document lock boundary already used by storage; do not introduce another transaction framework.

429 switching:

```text
capture active credentialId + selectionGeneration
→ final 429
→ read latest Provider record under selection lock
→ generation still matches
→ choose next eligible Profile in profiles[] order
→ update selection-owned state only
```

Metadata-only changes must not be overwritten by a stale 429 path.

There is no generic Profile health state machine. Keep only subsystem-owned ephemeral state that is mechanically necessary, such as a 429 cooldown. Provider Usage is not Provider-level state: cache/observations are keyed to the exact Profile (`providerId + credentialId`). External-account fingerprints may refine that Profile slot to prevent carrying usage across an external account change.

Delete Credential Profile `recheck`. Every actual use resolves the current reference. Manual Catalog refresh, if exposed by the product, goes directly through the existing Catalog authority.

Gate:

- refresh/remove and refresh/disable race tests;
- GC/publication race tests;
- selection ABA tests;
- metadata mutation does not get rolled back by 429 switching;
- repaired external files succeed on a later read without any recheck command;
- switching Profile A → B never shows A usage as B;
- switching back to an existing Profile may reuse only that Profile's own last observation, subject to its current destination/account identity;
- removing a Profile prunes its usage cache entry.

## 7. Phase 6 — Current-contract cutover and UI cleanup

Only after Backend authorities above are stable, change public contracts in one coordinated cutover.

Primary files:

- `packages/application-control-plane/src/credential-profiles-contract.ts`
- `packages/application-control-plane/src/wire-credential-profiles.ts`
- `packages/application-control-plane/src/provider-usage-contract.ts`
- `packages/application-control-plane/src/wire-provider-usage.ts`
- `packages/application-control-plane/src/contracts.ts`
- `src/credentials/profile-cli.ts`
- `src/cli.ts`
- `packages/desktop-shell/src/renderer/providers/ProvidersPage.tsx`
- corresponding tests/previews

Advance the Control Plane contract version because the credential wire contract changes incompatibly.

Remove public/CLI/UI concepts:

- reconnect;
- `set_priority` / Profile priority;
- `useNow`;
- acquisition `expectedRevision`;
- Credential Profile `recheck`;
- generic `CredentialHealth` / `profile.health`;
- duplicate Active/Ready/Connected Profile status indicators.

Retain management `expectedRevision` for stale user intent on existing-state mutations such as rename, activate, enable/disable, reorder, remove and switch policy.

Add/change:

- `management_operation_in_progress` with bounded non-secret active-operation metadata;
- explicit cancellation by Credential Management `operationId`;
- every public Usage observation carries exact Profile identity (`providerId + credentialId`); there is no detached Provider-level usage projection and no ambient Profile Usage.

UI behavior:

- `activeCredentialId` is the only selection fact.
- The selected Profile row and Provider card are derived from `activeCredentialId`; no second active/health badge is needed.
- Usage is rendered for the matching Profile, and the Provider card shows the selected Profile's usage rather than a Provider-level usage value.
- Disabled is derived from `enabled === false`.
- Profile order is the returned array order.
- Catalog refresh remains a Catalog action, not a Profile verification action.

## 8. Final deletion pass

After all callers use the new authorities, remove the obsolete implementation completely:

```text
credentialGeneration
priority / setPriority
reconnect lifecycle
useNow
acquisition expectedRevision
persisted authType
persisted strategyId
persisted authMethodLabel
persisted identityHint
persisted credential hash/revision
unavailable carrier
CredentialHealth / profile.health
referenceHealth authority
Profile recheck / captureForRecheck
AmbientBinding
legacy external Profile-binding branch
integrations.codex.localLogin
generic Codex parser branch
```

Do not retain dead compatibility types or adapters.

## 9. Verification

Run focused tests after each phase. Final gate:

```text
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm test --workspace @token/desktop-shell
npm run test:product-e2e:run --workspace @token/desktop-shell
git diff --check
```

All tests touching Codex authentication must continue to run under a fresh temporary `CODEX_HOME`; never use the real user credential/cache.

Also run a final repository grep for every deleted concept and inspect every remaining occurrence. Historical/spec wording is acceptable only when it explicitly describes removed behavior.

## 10. Implementation rule

Do not perform a big-bang rewrite and do not preserve the old architecture through shims.

The sequence is:

```text
establish the new authority
→ move existing callers to it
→ prove the new contract
→ delete the old authority
```

Module boundaries are normative; creating one class/file per box is not. Split code only where responsibility and ownership become clearer.
