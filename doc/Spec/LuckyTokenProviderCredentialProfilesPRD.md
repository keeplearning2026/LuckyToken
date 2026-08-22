# LuckyToken Provider Credential Profiles PRD v1.0

**Status:** ACCEPTED PRODUCT REQUIREMENTS  
**Date:** 2026-08-21  
**Scope:** Multiple managed API keys and OAuth accounts per Provider, credential metadata, lifecycle management, request selection, and desktop product flows  
**Related specifications:**

- [LuckyToken Provider Activation Specification](./LuckyTokenProviderActivationSpec.md)
- [LuckyToken Electron Product Architecture Specification](./LuckyTokenElectronArchitectureSpec.md)
- [LuckyToken Core Architecture Specification](./LuckyTokenCoreSpec.md)
- [Repository architecture rules](../../AGENTS.md)

This document defines the target product contract. It is a PRD, not an implementation specification. Exact persistence, package, and wire shapes must be decided from source evidence during implementation design.

---

# 1. Executive summary

LuckyToken currently presents one effective stored credential per Provider. A second API key or OAuth login replaces the first, and the desktop product does not expose a complete remove/disconnect workflow. Users also cannot name or describe credentials, identify which credential served a request, or keep multiple authorized identities ready for the same Provider.

LuckyToken must introduce **Provider Credential Profiles**: multiple independently managed API keys or OAuth accounts under one Provider. Every managed profile has a stable identity, a user-visible name, an optional note, a sanitized account/key identifier, lifecycle state, and request-selection eligibility. Users can add, rename, disable, reconnect, remove, or disconnect one profile without mutating sibling profiles.

The first release prioritizes control and safety over sophisticated load balancing. It provides one explicit default credential, manual switching, session affinity, OAuth refresh before use, and clear Activity attribution. Automatic switching is limited to two Provider-scoped settings that are off by default: API-key switching on a final HTTP 429 and account switching on a final HTTP 429. Switching stays within the selected credential type and lane, and a successful switch changes only the current session affinity, never the configured global default. Round-robin, quota optimization, team secret sharing, and cross-device sync are later or separate product decisions.

Credential profiles are infrastructure state. They never enter Pi AI IR or model-visible semantics, and they do not create a shared credential or fallback abstraction across LuckyToken's three independent data-plane lanes.

---

# 2. Confirmed current product behavior

The following are confirmed by the current specifications and source:

1. Pi's current `CredentialStore` is keyed by `Provider.id` and stores one credential per Provider.
2. LuckyToken's file credential store persists `Record<providerId, Credential>` in `auth.json`.
3. LuckyToken's `LiveCredentialAuthority` exposes one bounded `ProviderAuthStatus` row per Provider.
4. Request auth currently resolves through `Models.getAuth(providerId)`.
5. Backend and Control Plane contracts support deleting the Provider's stored slot through `logout`.
6. The Electron bridge exposes credential commands, but the current Providers page exposes login only; users cannot remove the stored API key or disconnect the OAuth account through the normal desktop flow.
7. Pi already owns Provider-declared login and OAuth refresh semantics, including serialized refresh to avoid concurrent refresh-token rotation.

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
3. choose a default credential and temporarily disable another;
4. keep OAuth credentials refreshed when the Provider supports refresh;
5. continue serving through another eligible credential when failure handling is safe;
6. remove one API key or disconnect one account without affecting siblings;
7. see which credential profile served a request;
8. understand when LuckyToken removed only local material versus revoked remote authorization.

---

# 5. Product principles

## 5.1 User control before automation

Users must be able to see, name, disable, and remove every LuckyToken-managed credential before LuckyToken automatically selects among them.

## 5.2 Stable identity, editable presentation

Routing and lifecycle operations use an immutable `credentialId`. A user may rename a profile or edit its note without changing request affinity, health history, or selection behavior.

## 5.3 No secret redisplay

After capture, LuckyToken never returns a complete API key, access token, or refresh token to Renderer, Control Plane projections, Activity, diagnostics, logs, or error messages.

## 5.4 Honest logout semantics

LuckyToken distinguishes local removal from Provider-side revocation. It never claims that an API key was revoked remotely merely because the local copy was deleted.

## 5.5 Predictable selection

The first product contract uses an explicit default and session affinity. Without user opt-in, an unavailable or rate-limited credential fails and the user switches manually. Optional 429 switching follows user priority within the same credential type; it does not introduce opaque random rotation.

## 5.6 Lane isolation remains authoritative

Credential-profile management does not change protocol conversion or native preservation semantics. Selection happens only through the credential authority already permitted by the selected lane, and failure never falls through to another lane.

---

# 6. Domain model

## 6.1 Provider Credential Profile

A **Provider Credential Profile** is one LuckyToken-managed API key or OAuth account belonging to one Provider.

Conceptual product shape:

```ts
interface CredentialProfile {
  readonly credentialId: string;
  readonly providerId: string;
  readonly authType: "api_key" | "oauth";
  readonly displayName: string;
  readonly note?: string;
  readonly maskedIdentity: string;
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

## 6.2 Identity rules

- `credentialId` is opaque, immutable, and unique for the lifetime of the profile.
- `providerId` is immutable.
- `authType` is immutable; changing API key to OAuth creates a new profile.
- `displayName` is editable and case-insensitively unique within one Provider.
- `note` is editable, optional, and limited to 200 characters in v1.
- `maskedIdentity` is generated by LuckyToken; it is not user-authored routing input.
- API keys use a safe masked suffix when one can be captured without redisplaying the secret, for example `•••• 7K2P`.
- V1 does not claim a real OAuth account identity. The current Pi auth contract does not expose typed account metadata, and LuckyToken must not guess an email or account ID by parsing an opaque token.

## 6.3 Default names

- API key: Provider label plus a deterministic ordinal, such as `OpenAI API Key 1`, with a masked suffix shown separately.
- OAuth: `Account 1`, `Account 2`, and so on.
- The user may edit the suggested name before or after saving.

## 6.4 Credential health

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

## 6.5 External auth source

Environment variables, `models.json`, command-derived configuration, cloud profiles, and other Provider ambient sources are not LuckyToken-managed credential profiles.

They are presented as **External auth sources** with their effective source and availability. LuckyToken does not offer rename, notes, delete, logout, automatic pool selection, or remote revocation for a source it does not own. The UI explains where the user must edit or remove that source.

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
- API key or account type;
- masked key suffix for an API key or the user-assigned name for an account;
- status;
- optional note;
- last used time;
- default/priority position;
- actions: set default, enable/disable, edit details, reconnect when applicable, and remove/disconnect.

Users can search by display name, note, or safe masked API-key identity.

## 7.3 Add API key

1. User chooses `Add API key`.
2. LuckyToken shows the Provider-owned API-key prompt.
3. User supplies a display name and optional note.
4. Backend persists the secret and profile atomically.
5. LuckyToken performs only a Provider-declared, side-effect-free validation when available.
6. Without such validation, the profile is `not_yet_verified`; LuckyToken does not spend tokens merely to test a key.
7. The result returns only sanitized profile metadata.

An occupied Provider no longer triggers overwrite confirmation. A duplicate key value may be rejected without revealing which existing profile owns it.

## 7.4 Add OAuth account

1. User chooses the Provider-owned account/subscription login option.
2. Existing typed auth interactions continue to drive browser, device-code, progress, and prompt steps.
3. A profile is created only after successful login.
4. LuckyToken suggests `Account 1`, `Account 2`, and so on; it does not parse token claims to guess account identity.
5. User supplies or edits the name and optional note.
6. Each OAuth account stores and refreshes its own token set independently.

Cancelling or failing login leaves no partially created profile.

## 7.5 Edit name and note

- Editing metadata never requires secret re-entry.
- Renaming does not change `credentialId`, priority, session affinity, or request history association.
- Names are 1–64 visible characters and unique within the Provider.
- Notes are optional, up to 200 characters, and never projected into requests, provider headers, Activity records, or logs.
- The product warns users not to put secrets in names or notes. Backend rejects metadata that contains a complete secret value already known to the Credential Authority.

## 7.6 Enable and disable

- Disable removes the profile from new request selection without deleting secret material.
- In-flight requests that already captured request-local auth are not cancelled.
- Re-enable returns the profile to selection only if its health is otherwise eligible.
- Disabling the current default does not silently choose another profile. The user must select a replacement default; until then, new requests that require a managed profile fail explicitly.

## 7.7 Remove API key

The destructive action is labeled `Remove from LuckyToken`.

Confirmation identifies the Provider, display name, and masked identity and states:

- LuckyToken will delete its local copy;
- new requests will stop using this profile;
- the key may remain valid at the Provider and must be revoked there if required;
- models, aliases, Activity records, and sibling profiles are not deleted.

After confirmation, the secret and current profile metadata are deleted immediately. The Credential Authority does not keep a profile tombstone. Existing Activity records retain only their own bounded, sanitized request-time display-name snapshot for the normal Request Ledger retention period; the confirmation discloses that historical Activity remains.

## 7.8 Disconnect OAuth account

The destructive action is labeled `Disconnect account`.

V1 removes LuckyToken's local access and refresh tokens only. It does not claim to revoke authorization at the Provider because the current Pi OAuth contract exposes no standard remote-revocation operation. The confirmation directs the user to the Provider when remote revocation is required.

## 7.9 External-source removal

If a managed profile is removed but an environment, `models.json`, or other ambient source remains effective, the Provider may remain connected. The product must display the new effective source and must not show the false success message `Provider disconnected`.

---

# 8. Credential selection

## 8.1 Manual/default policy

V1 has one explicit configured default profile per Provider. A session retains its session-affine profile when that profile remains enabled and eligible; otherwise it uses the configured default. If neither is eligible, the request fails explicitly. LuckyToken does not silently choose a lower-priority profile or an external source.

An external auth source may be used only when the user has explicitly selected that source through a supported product flow and the selected lane's existing auth contract permits it.

## 8.2 Session affinity

One conversation/session should continue using the same credential profile where possible. This avoids unexpected account changes, Provider-side cache changes, inconsistent account-specific model access, and confusing cost attribution.

Affinity is infrastructure state keyed to a stable `credentialId`; display names and notes never participate.

## 8.3 Provider-scoped 429 settings

Each Provider exposes two independent settings in its credential-management surface:

```text
Automatic switching on HTTP 429

[ ] Try the next API key after an API-key request returns 429
[ ] Try the next account after an account request returns 429
```

Both settings default to `off`. They are owned by the Provider Credential Profile capability, even if the UI presents them as settings. They are not one global application toggle because Provider billing, limits, and account semantics differ.

## 8.4 HTTP 429 switching contract

Automatic switching occurs only when all of the following are true:

- the matching Provider setting is enabled;
- the already selected lane's existing Provider/transport retry contract has returned a final HTTP 429;
- no client-visible response or model output has been committed;
- the alternative profile belongs to the same Provider, credential authority, selected lane, and auth type;
- the alternative is enabled and has not already been attempted for this request;
- request cancellation and the lane's total retry limits remain honored.

API keys switch only to API keys. OAuth accounts switch only to OAuth accounts. Eligible alternatives follow user priority, with equal priority broken deterministically by `credentialId`. Each eligible profile is attempted at most once for one request. If every eligible profile returns 429, LuckyToken returns the final 429 and does not loop.

A successful switch updates only the current session affinity. It never changes the configured global default credential.

V1 does not switch credentials for 401, 403, 5xx, network failures, OAuth refresh failures, storage failures, or any inferred quota condition. Failure in Local Native, Provider Native, or Semantic Conversion never falls through to another lane.

## 8.5 Cooling-down behavior

A valid explicit `Retry-After` (or an equivalent typed Provider fact) may mark the attempted profile `cooling_down` until the declared time. Without that evidence, LuckyToken excludes the profile only from the current request attempt set and does not invent a cooldown duration.

## 8.6 Deferred policies

The following are not part of v1:

- round-robin rotation;
- least-recently-used selection;
- quota-aware or cost-aware optimization;
- randomized distribution;
- cross-Provider or cross-lane failover;
- switching between API-key and OAuth authentication;
- automatic switching on non-429 failures;
- strategies marketed as bypassing Provider limits or account enforcement.

These require separate evidence, Provider contract review, and product controls.

---

# 9. OAuth refresh and credential maintenance

## 9.1 Product promise

When the Provider supports OAuth refresh, LuckyToken automatically refreshes a selected credential before use. V1 does not promise background refresh for every idle account.

## 9.2 Correctness requirements

- Refresh is serialized per `credentialId`, not merely per Provider.
- Expiry is rechecked inside the serialization boundary so concurrent requests do not double-refresh a rotated token.
- Refreshed access and refresh tokens publish atomically before the lock is released.
- Deleting or disconnecting a profile races safely with refresh; a removed profile cannot be recreated by a late refresh result.
- Refresh failure produces a bounded `reconnect_required` or transient status only when evidence supports that classification.
- Refresh failure does not trigger automatic credential switching in v1.
- Refresh errors and Provider responses are scrubbed before entering diagnostics.
- A refreshed credential that cannot satisfy the request's minimum validity fails explicitly.

Pi's existing locked OAuth refresh behavior is the reference for these semantics, but its current Provider-keyed one-slot store is not sufficient as the unchanged authoritative multi-profile store.

---

# 10. Activity and observability

## 10.1 Request attribution

For managed credentials, each execution records the opaque `credentialId`, auth type, bounded request-time display-name snapshot, attempt result, and selection reason. It never records secret material, token claims, the note, or raw auth-source details.

The stable `credentialId` provides exact internal attribution. The user recognizes the credential through the name they assigned. Activity shows a bounded attempt trail such as `Production Key — 429` followed by `Backup Key — Success`, with reason `HTTP 429 failover`.

Activity attribution is visible by default in the local product and has no separate v1 privacy setting. This does not authorize telemetry or external export. Deleting a profile does not delete already retained Activity snapshots; those disappear through normal Request Ledger retention.

## 10.2 User-visible events

Users can understand:

- which credential served a request;
- whether and why HTTP 429 selected another same-type credential;
- whether a profile is cooling down, disabled, or needs reconnection;
- whether local removal succeeded;
- whether an external source remains effective after removal.

## 10.3 No raw-provider error UI

Renderer does not infer profile health from raw error strings. Backend owners project typed, bounded states and safe user actions.

---

# 11. Security and privacy requirements

1. Secret material remains owned by the Backend Credential Authority.
2. Renderer receives only sanitized profile projections and owns only form drafts, selection, filters, modal state, and pending interaction state.
3. Electron Main and preload expose narrow typed operations and do not read credential files.
4. API keys, access tokens, refresh tokens, credential commands, auth headers, and raw credential objects never enter status DTOs, Activity, logs, diagnostics, crash reports, notes, or search indexes.
5. Notes and names are untrusted user input, length-bounded, escaped at presentation, and scrubbed from error text.
6. Complete known secret values are rejected from name/note metadata.
7. All profile mutations use revision/conflict semantics so two desktop/CLI clients cannot lose concurrent changes.
8. Import and export are not added until a profile-aware, value-safe contract is explicitly specified.
9. Credentials are for accounts and keys the user is authorized to use. LuckyToken does not describe selection as quota circumvention.
10. Product certification proves that closing and reopening Renderer reconstructs current sanitized Backend state.

---

# 12. Architecture constraints

## 12.1 Ownership

Backend Application owns the authoritative credential-profile lifecycle. The authority owns:

- stable profile identities;
- metadata and secret association;
- status and eligibility facts;
- serialized profile mutations;
- known-value scrubbing;
- OAuth refresh publication;
- sanitized projection.

It does not own model-visible semantics, Provider wire construction, Client Protocol conversion, request history, Electron lifecycle, or Renderer interaction state.

## 12.2 Product dependency direction

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

## 12.3 Data-plane isolation

- Local Native credentials remain owned by their explicit local integration and are outside this Provider profile pool.
- This PRD does not expand which Provider credentials Provider Native or Semantic Conversion may consume.
- Profile selection occurs only after lane selection through a lane-authorized narrow seam.
- No generic cross-lane credential router, executor, transport, target, or fallback abstraction is introduced.
- Credential identity and selection reason are infrastructure/observation facts; neither enters Pi AI IR.

## 12.4 Persistence contract

The current Provider-keyed `auth.json` shape cannot represent the target product unchanged. Implementation design must choose one authoritative profile representation rather than add dual readers/writers or keep two mutable credential truths.

This PRD does not require migration or backward compatibility for the obsolete one-slot shape. If compatibility becomes a product requirement, it requires a separate explicit decision and specification before implementation.

---

# 13. Functional requirements

## 13.1 Must have

- multiple LuckyToken-managed API-key profiles per Provider;
- multiple LuckyToken-managed OAuth profiles per Provider when the Provider exposes OAuth login;
- required display name and optional note;
- safe masked identity;
- add, rename, edit note, set priority/default, enable, disable, reconnect, remove, and disconnect;
- automatic OAuth refresh before use;
- explicit manual default and session affinity;
- separate, default-off API-key and account 429-switching settings per Provider;
- same-type HTTP 429 switching only under the fixed conditions in section 8.4;
- sanitized profile status while Data Plane is stopped or failed;
- Activity attribution by stable profile identity;
- explicit external-source presentation;
- typed concurrent-mutation conflicts;
- no secret projection.

## 13.2 Should have

- search by name, note, and safe masked API-key identity;
- manual refresh/recheck action;
- actionable `reconnect_required` and `cooling_down` states;
- request-attempt attribution by user-assigned name.

## 13.3 Could have later

- profile usage totals and budget labels;
- quota signals where Providers expose reliable APIs;
- team ownership and permissions;
- cross-device encrypted sync;
- bulk import/export;
- typed Provider account identity and remote OAuth revocation if Pi later exposes explicit contracts;
- additional selection policies.

---

# 14. Non-goals

- changing Anthropic or OpenAI Responses semantic conversion;
- adding credentials to Pi AI IR;
- unifying the three data-plane lanes;
- rebuilding Provider-owned OAuth protocol logic in Renderer or Client Protocol code;
- Provider-side API-key creation or revocation without an explicit Provider operation;
- automatic account sharing among machines or users;
- billing reconciliation or chargeback;
- team RBAC;
- opaque auto-rotation;
- automatic switching for non-429 failures;
- cross-auth-type switching;
- Provider account-identity discovery or remote OAuth revocation in v1;
- importing external auth sources as managed profiles;
- using fuzzy Provider identity, payload resemblance, or cross-lane failure to choose an alternative execution path;
- compatibility shims, dual persistence, or silent migration for the old one-slot credential shape.

---

# 15. Release slices

## Slice 1 — close the existing lifecycle gap

- expose `Remove from LuckyToken` for stored API keys;
- expose `Disconnect account` for OAuth;
- show the effective remaining source after removal;
- preserve model, alias, and Activity facts;
- certify value-free results.

## Slice 2 — credential profiles and metadata

- replace the one-slot product contract with multiple managed profiles;
- add stable identity, name, note, masked identity, status, and enable/disable;
- add the credential management view;
- support independent API-key and OAuth profile creation/removal;
- keep Provider management available independently of Data Plane listener state.

## Slice 3 — explicit 429 switching and maintenance

- manual default/priority selection;
- session affinity;
- serialized per-profile OAuth refresh;
- separate Provider-scoped API-key/account 429 settings, default off;
- same-type, same-lane final-429 switching;
- Activity attempt attribution and 429 selection reasons.

Advanced balancing remains outside these slices.

---

# 16. Success measures

## 16.1 Product measures

- successful addition of a second credential without replacing the first;
- successful removal/disconnection of one profile without mutating siblings;
- percentage of multi-profile Providers whose profiles have user-edited names;
- reduction in Provider-unavailable requests caused by expired or disabled credentials;
- successful self-service recovery from `reconnect_required`;
- percentage of managed requests with credential attribution visible in Activity.

These measures require telemetry/privacy review before collection. They are product questions, not permission to add telemetry automatically.

## 16.2 Release blockers

- any complete secret appears outside the credential owner;
- deletion can be undone by a racing refresh;
- a profile mutation can overwrite or delete a sibling profile;
- selection can cross data-plane lanes after execution begins;
- Renderer becomes authoritative for profile facts;
- removing a stored profile reports `disconnected` while an external source remains effective;
- a renamed profile changes routing identity;
- credentials switch on any status other than a final pre-output HTTP 429;
- an API key switches to an account or an account switches to an API key;
- a successful 429 switch changes the configured global default;
- Activity exposes a note, secret, token claim, or guessed Provider account identity;
- management becomes unavailable merely because the Data Plane listener is stopped or failed.

---

# 17. Acceptance scenarios

1. **Two API keys:** Add two API keys to one Provider with distinct names and notes. Both persist, remain independently selectable, and never redisplay complete key values.
2. **Two OAuth accounts:** Log in to two accounts for one Provider. Each has independent status, refresh lifecycle, and removal.
3. **Rename safety:** Rename one profile while a session is active. The session remains bound to the same `credentialId`.
4. **Disable:** Disable the default profile. New requests fail until the user selects a replacement default; existing in-flight requests are not cancelled.
5. **Remove one:** Remove one of three profiles. Its secret is deleted and siblings remain byte-for-byte and behaviorally unchanged.
6. **Disconnect OAuth:** Disconnect one OAuth profile during a concurrent refresh. The late refresh cannot recreate the removed credential.
7. **External source remains:** Remove the last managed profile while an environment source remains. UI shows that external source as effective and does not claim the Provider is disconnected.
8. **Refresh concurrency:** Concurrent requests for one expiring OAuth profile perform at most one effective token refresh and observe the published rotated credential.
9. **API-key 429 switching:** Enable only the API-key setting. After a final pre-output 429, LuckyToken attempts the next enabled API key in priority order and never selects an OAuth account.
10. **Account 429 switching:** Enable only the account setting. After a final pre-output 429, LuckyToken attempts the next enabled OAuth account and never selects an API key.
11. **Settings off:** With the matching setting off, a final 429 is returned without credential switching.
12. **Session-only change:** A successful 429 switch binds the current session to the successful profile and leaves the configured global default unchanged.
13. **Bounded attempts:** Each eligible same-type profile is attempted once at most; if all return 429, LuckyToken returns the final 429 without looping.
14. **Explicit cooldown:** A valid `Retry-After` creates a bounded cooldown; a 429 without one creates no guessed cooldown beyond the current request.
15. **Unsafe switching:** Upstream acceptance is uncertain or output has begun. LuckyToken returns the failure without selecting another profile or lane.
16. **Non-429 failure:** A 401, 403, 5xx, network error, or OAuth refresh failure never triggers automatic switching in v1.
17. **Activity:** Activity shows request-time credential names, auth types, attempt outcomes, and `HTTP 429 failover` without note, secret, token claim, or guessed account identity.
18. **Profile deletion:** Deleting a profile removes current credential/profile state immediately; existing bounded Activity snapshots remain only for normal ledger retention.
19. **Desktop reconstruction:** Close and reopen the management window. Renderer queries the authoritative profiles and does not rely on stale local state.
20. **Backend lifecycle:** Stop or fail the Data Plane listener. Profile query, login, editing, removal, settings, and status remain available through the Backend Control Plane.
21. **Concurrent clients:** Two clients mutate the same profile revision. One succeeds; the stale mutation receives a conflict and no change is lost.
22. **Secret hygiene:** Control Plane frames, status, logs, diagnostics, Activity, crash output, and test snapshots contain no complete API key, access token, or refresh token.
23. **Test isolation:** Every test that can reach Codex state uses a new temporary `CODEX_HOME`, copies only explicitly permitted fixtures, passes that home to every spawned process, and removes it in `finally`.

---

# 18. Accepted product decisions

V1 product decisions are closed:

1. Manual/default selection is authoritative. Automatic switching is opt-in.
2. Every Provider has separate API-key and OAuth-account 429 settings; both default to off.
3. Automatic switching is limited to a final pre-output HTTP 429 after the selected lane's existing retry behavior.
4. Switching remains inside the same Provider, auth type, credential authority, and selected lane.
5. Successful switching updates only current session affinity and never the configured global default.
6. `Retry-After` or an equivalent typed fact may establish cooldown; LuckyToken invents no delay when it is absent.
7. V1 uses user-assigned names as the human credential identity. It does not parse tokens to guess account identity.
8. V1 OAuth disconnect removes local tokens only; remote Provider revocation is not claimed.
9. The Credential Authority keeps no deleted-profile tombstone. Activity owns bounded request-time name snapshots for its normal retention period.
10. Activity attribution is visible by default locally and never includes notes or secret/token material.
11. External auth sources are not imported automatically as managed profiles.

Any change to these decisions requires new product evidence and an explicit PRD revision.
