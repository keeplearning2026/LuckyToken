# Token Provider Credential Core Model Plan

Status: implemented current contract, 2026-10-02.

Supersedes: `doc/Spec/local codex auto login.md`.

This document is the authoritative design and implementation plan for the
Provider credential/profile core. Other specs are updated to point here for
the acquisition, credential-reference, profile-operation and Pi-boundary
contracts.

## 1. Goal and core model

The Provider core has two responsibilities:

```text
Acquisition Strategy  ->  Profile  ->  Unified Profile Operations
```

Acquisition is how a credential is obtained. A Profile is the only
user-visible credential unit. Operations are one command surface over
Profiles. Provider-specific behavior lives behind explicit seams; it does not
leak into the public command or DTO shape.

```text
Acquisition Strategies
  api_key / oauth / local_oauth
            |  acquire() -> credential reference
            v
Profile
  metadata + authType + credentialRef + acquisitionKind
  + internal strategyId + health + selection
            |
            +-- generic operations: activate/select/enable/disable/reorder/delete
            +-- typed operations: reconnect / rename / recheck
            +-- Pi CredentialStore
                  read(profileRef) -> Credential
```

### 1.1 Layers

Public layer:

- Acquisition options expose generic kinds: `api_key`, `oauth`, `local_oauth`,
  with presentation labels/icons and availability state.
- The Profile projection exposes a uniform shape plus the public
  `acquisitionKind`. It never exposes the internal strategy id, credential
  path, owner or raw credential.
- Profiles share one list, one selection field, one health/usage/429 model and
  one command surface.

Profile layer:

- A Profile owns metadata, `authType`, a credential reference, the public
  `acquisitionKind`, an internal `strategyId`, health and selection.
- The internal `strategyId` is persisted only to dispatch reconnect/rename/
  recheck behavior.
- The Profile does not own where a credential file lives, who writes it or how
  it is parsed.

Credential layer:

- Every credential is a referenced document: `{ path, owner, revision? }`.
- `owner` is `managed` (Token owns the file) or `external` (the source owner
  owns the file).
- A unified reader resolves `read(profileRef) -> Credential`. The parser is
  selected by provider/authType/format.
- `revision` is a content hash used for capture freshness and fail-closed
  publication.

Pi boundary:

- Token implements Pi's `CredentialStore`: `read`, `list`, `modify`, `delete`.
- Pi calls `read` during auth resolution, `modify` during OAuth refresh,
  catalog refresh and login persistence, and `delete` during `Models.logout`.
- Token also supplies `AuthContext`, `ModelsStore`, `AuthInteraction` and
  Provider composition; Pi supplies Models, provider auth flows, OAuth refresh
  implementation and Provider wire adapters.

## 2. Public contracts and decisions

### 2.1 Acquisition kinds and options

Public kinds:

```text
acquisitionKind = "api_key" | "oauth" | "local_oauth"
```

Provider options are projected as:

```text
acquisitionOptions: [
  { kind, label, icon, authType, interactive, state }
]
```

`state` is `available` or `already_connected`. `codex_local` is an internal
strategy id and never appears in options, DTOs or Renderer logic.

Local login is available only for Providers with a registered local strategy
(currently Codex). It is gated by
`integrations.codex.localLogin`, boolean, default true, hot-apply, under
Settings -> `.codex agent`. The setting controls option visibility only; it
does not create, remove or refresh existing Profiles.

### 2.2 Login and singleton behavior

Login forms a Profile. All three login methods are explicit user actions.
There is no startup auto-login.

Each ProfileType declares:

```text
singleton: true | false
```

`local_oauth` is singleton per Provider. `api_key` and `oauth` are not.

The add/login flow for a singleton type:

1. Pre-check for an existing Profile of the same strategy.
2. In the Provider-locked commit transaction, re-check the singleton
   condition.
3. If an existing Profile is present, do not call `acquire()`, do not read the
   source file, and do not modify any Profile. Return the generic `duplicate`
   outcome with:

   `A local login Profile already exists. Reconnect it to refresh, or remove it first.`

4. If no Profile exists, call `acquire()`, create the Profile, and commit.

For `local_oauth`, the existence check, the bounded source-file read and the
Profile commit happen inside the same Provider-locked transaction so a second
concurrent click cannot create a second Profile. A `reconnect_required`
existing Profile still blocks a new add; the user must Reconnect or Remove.

The UI shows `already_connected` on the option and, when clicked, shows the
reminder instead of entering the login flow. The Backend enforces the same
rule for CLI/API callers.

### 2.3 Credential references

Carrier contract:

```text
reference = { path, owner: "managed" | "external", revision? }
```

- `managed`: Token owns the document. Token may write/refresh it; it is
  included in backup and GC.
- `external`: the source owner owns the document. Token only reads it; it is
  never written, backed up or deleted by Token.
- API keys are stored as single-line text documents. The reader trims the
  value and rejects empty, CR/LF or NUL content. A credential carrying
  provider-scoped `env` (for example Cloudflare account/gateway ids) is
  serialized as the JSON document shape instead, so no credential field is
  dropped; the reader accepts both shapes.
- OAuth documents use the provider's auth.json format. Codex uses the existing
  ChatGPT parser.
- The path, owner, revision and raw credential never enter public DTOs, logs,
  diagnostics, Activity or Pi semantic state.

### 2.4 Unified reader and freshness

`read(profileRef) -> Credential`:

- No Profile exists -> `undefined`.
- A Profile exists but its reference is missing, unreadable or invalid -> throw
  a typed error. Do not return `undefined`; that would let Pi fall back to
  ambient auth.
- An externally owned OAuth document with less than Pi's 5-minute minimum
  validity (`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`) is unavailable: Token cannot
  refresh it, so it must not hand a dying token to a request. Managed OAuth
  documents are not gated here because Pi's locked `modify` path owns their
  refresh.
- A fresh credential -> return the parsed `Credential`.

For external OAuth credentials, Token never refreshes and never writes the
file. The owner (for Codex, the Codex CLI/session) refreshes it. A later read
sees the owner-refreshed content through the recorded revision.

### 2.5 Pi CredentialStore semantics

- `read`: resolve the active Profile's reference and return a parsed
  Credential. Missing Profile -> `undefined`; broken reference -> typed error.
- `list`: return non-secret metadata only.
- `modify`: serialized write. For `managed`, run Pi's callback, rotate the
  document and return the new credential. For `external`, do not execute Pi's
  callback: resolve and return the owner's current document (a no-op refresh)
  and throw a typed error when it is unavailable. Never return `undefined` for
  an existing external Profile, because Pi interprets `undefined` as
  "logged out".
- `delete`: Token does not use Pi logout for Profile removal. Profile removal
  is the Token `remove` operation; it deletes the Profile reference and only
  GC-managed files. External files are untouched.

### 2.6 Operations

Generic, no type branch:

```text
activate / select, enable, disable, reorder, delete
```

Typed, with default implementations plus per-type hooks:

```text
reconnect -> acquire()
rename    -> normalizeDisplayName?()
recheck   -> recheck?()
```

Default generic behavior is written once. A future ProfileType may override a
hook at an explicit seam, but the override runs inside the shared invariants:
revision, existence, active/enabled state, selection generation, secret
boundaries, commit and outcome mapping. Whole-operation replacement is a last
resort and must pass the shared conformance suite.

Decisions:

- `rename` is fully generic. The public `acquisitionKind` in the Profile row
  carries the source marker; there is no `(LOCAL CODEX)` suffix.
- `recheck` uses the existing credential. No usable credential returns
  `reconnect_required`; it never re-reads or re-imports the local source.
- 429 candidates, usage and selection use the unified Profile state and
  `authType`, not `acquisitionKind`.
- Missing local source on first login fails and creates no Profile. Missing
  source on Reconnect fails and leaves the existing Profile in
  `reconnect_required`.

### 2.7 Schema and compatibility

- Record `schemaVersion` remains 2.
- The current validator is the only accepted contract. Obsolete carriers and
  old local Profiles are not migrated, not dual-read and not compatibility
  targets.
- The control-plane wire decoder/validator is updated for `acquisitionKind`
  and `acquisitionOptions`; it must reject `strategyId`, `path`, `owner` and
  raw credentials in the public wire.

## 3. Implementation phases

### Phase 1: Acquisition seam, options, settings, UI

- Add the ProfileType/strategy seam and the `singleton` capability.
- Add `acquisitionKind` to the Profile projection and `acquisitionOptions` to
  provider options; update the control-plane contract, wire decoder/validator
  and desktop typed API.
- Add the three login entries with icons and the `already_connected` state.
- Add `integrations.codex.localLogin` (default true, hot-apply); delete
  `integrations.codex.autoLoginOnStartup` and the startup
  `loginFromLocalCodex()` call.
- Implement the singleton pre-check and locked add path; map duplicates to the
  generic `duplicate` outcome.

This phase does not change credential storage; it establishes the public
model and the control flow.

### Phase 2: Reference carrier, reader, binding owner

- Replace the carrier contract with `unavailable | reference`; add managed
  and external owners plus revision.
- Implement the unified reader and parsers (single-line API key text and
  provider auth.json).
- Add `carrierOwner` to managed binding facts; reject external writes in
  `modify` before Pi's callback.
- Implement the 5-minute freshness gate and typed errors.
- Update backup, recovery and GC: managed references only; external
  references are never touched.
- Local Codex login references the external `.codex/auth.json`; manual OAuth
  and API keys write managed Token files.

This is the cross-module phase and must be completed before local_oauth is
declared read-only end to end.

### Phase 3: Operation convergence

- Keep stable Profile identity; reconnect replaces the credential generation
  and reference instead of deleting/recreating the Profile.
- Remove the old new-ID rebuild, selection transfer and old-result handling.
- Dispatch reconnect by the internal `strategyId`.
- Remove the rename suffix branch; the kind is rendered in the Profile row.
- Add the optional `recheck` hook and keep the default generic path.

### Phase 4: UI, docs, cleanup

- Render `acquisitionKind` in the Profile row and the `already_connected`
  reminder in the login options.
- Update the PRD, Codex plan, external credential source spec, release notes
  and implementation plan to point to this document.
- Delete superseded files and dead code paths.
- Add the conformance suite and the integration/desktop coverage below.

## 4. Test plan

Unit:

- Acquire for each kind; singleton pre-check and locked check; duplicate add
  does not read the source or call `acquire`.
- Acquisition-option projection and `available`/`already_connected`.
- Wire decoder accepts the new public fields and rejects internal fields.
- Settings default and hot-apply behavior.
- Reader/parsers; managed write and external read-only/no-op; freshness gate;
  typed errors vs `undefined`.
- Generic operations; generic rename; recheck hook; 429/usage unaffected by
  acquisitionKind.
- Public DTO/options never contain `codex_local`, strategyId, path or owner.

Integration:

- Manual API key/OAuth login; local login success and missing-file failure.
- Existing local Profile blocks a second add; `reconnect_required` still
  blocks; Remove restores availability.
- Reconnect replaces the credential generation on the same Profile.
- External file changes produce revision/stale behavior; Pi `modify` does not
  write external files; removal leaves the external file intact.
- Settings visibility changes take effect without restart; startup does not
  import local credentials.
- Provider Native and Semantic Conversion both resolve the same parsed
  Credential through the binding; Direct Mode is unaffected.
- No ambient fallback when a referenced external credential is unavailable.

Concurrency:

- Two concurrent local_oauth adds: one creates, one returns duplicate; the
  check, bounded read and commit are serialized by the Provider lock.

Contract:

- Shared conformance suite for every ProfileType covering revision, selection
  generation, fail-closed behavior, secret boundaries and 429/usage.

Desktop:

- Three login icons; already-connected reminder; Profile-row kind; settings
  checkbox; existing Profile operations and the Profiles-dialog 429 switch.

Safety:

- Codex-related tests use a newly created temporary `CODEX_HOME`, synthetic
  credentials and explicit paths. They never read or copy the user's real
  `auth.json`. Paths and raw credentials never appear in DTOs, logs,
  diagnostics or Activity.

Acceptance commands:

```text
npm run typecheck
npm run lint
npm test
```

Run the repository's guarded commands. Record and treat known timing-sensitive
integration tests as such rather than silently skipping them.

## 5. Assumptions and defaults

- This document is authoritative; `doc/Spec/local codex auto login.md` is
  superseded.
- Public kinds: `api_key`, `oauth`, `local_oauth`; internal strategy id:
  `codex_local`.
- Setting: `integrations.codex.localLogin`, default true, hot-apply.
- All credentials use references; owners are managed or external; Codex local
  is external/read-only.
- Rename is generic; `acquisitionKind` is the source marker.
- Schema remains 2; obsolete carriers and old local Profiles are not
  migrated or dual-read.
- Strategies are an explicit, closed set registered by composition; no
  generic plugin registry is introduced.

## 6. Implementation status

All four phases are implemented on `codex/selectable-external-credential-source`:

- `src/credentials/acquisition.ts` owns the public kinds, the closed local
  strategy set and the Codex `local_oauth` strategy.
- `src/credentials/credential-document.ts` owns the reference contract, the
  bounded reader and the per-provider parsers/serializers.
- `src/credentials/profile-record-store.ts` persists `strategyId` plus the
  `unavailable | reference` carrier and publishes/reads/collects managed and
  external references under the existing locks.
- `src/credentials/profile-authority.ts` owns the singleton acquisition
  transaction, generation/reference replacement on reconnect, the external
  read-only `CredentialStore.modify` no-op and the freshness gate.
- The control-plane contract/wire decoder expose `acquisitionKind` and
  `acquisitionOptions` and reject internal fields; the Renderer renders the
  three login entries, the `already_connected` reminder and the Profile-row
  kind.
- `integrations.codex.localLogin` (default true, hot-apply) replaces
  `integrations.codex.autoLoginOnStartup`; startup calls no acquisition.

Verification: `npm run typecheck`, `npm run lint`, `npm run test:unit`,
`npm run test:integration` and the guarded `npm test` (only the documented
timing-sensitive integration files fail under parallel load and pass when run
serially). The assembled release backend is rebuilt before the release-serve
certification.
