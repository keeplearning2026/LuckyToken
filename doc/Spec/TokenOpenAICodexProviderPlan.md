# Token OpenAI Codex Provider Plan: Ordinary Profiles and Native Model Catalog

Status: current implementation contract, revised 2026-10-01. This replaces the former Codex external-selector/delegated-refresh design. Provider Native, Semantic Conversion and Direct Mode remain independent.

## 1. Decisions

All Profiles have the same data model, list, selected ID and PROFILE ACTIONS. Acquisition is private Backend metadata. Local Codex auto-login imports an ordinary OAuth Profile; it never supplies a runtime external binding. The obsolete Codex external adapter, reserved selection value, special card and app-server refresher are removed.

`integrations.codex.autoLoginOnStartup` is boolean, default true, restart-required, under Settings → `.codex agent`. Backend startup invokes acquisition after Provider registration and before initial authentication/catalog checks. Off skips acquisition completely, preserving existing items and avoiding any auth-file read. Reconnect is explicit and unaffected by the switch. Settings opening, Renderer remount and Data Plane restart do not acquire credentials; removal in a running Backend does not immediately recreate an item.

## 2. Shared acquisition

`src/credentials/codex-local-login.ts` owns one operation used by startup and local Reconnect:

1. Stage removal of all `acquisition: "codex_local"` Profiles in the Provider record.
2. Read the current source using the bounded regular-file reader and ChatGPT parser.
3. Create a fresh ordinary Profile and, when valid, a Token-owned credential incarnation.
4. Commit the complete updated record once, publishing the list atomically.

The store's narrow `rebuildCredential` transaction locks the new credential ID then the Provider record, matching publication and GC lock order. Its async preparation callback performs the source read under the Provider lock. It uses internal write primitives, never nested public locked methods. Failed storage publication leaves the previous committed record intact; an unreferenced newly written incarnation is collected after the existing grace period.

Each operation generates a fresh credential ID and generation, the smallest unused `Profile N` base with the ` (LOCAL CODEX)` display suffix, no note, default enabled state and an appended priority. Renaming a local Profile appends the same suffix only when the submitted name differs from the current display name; an unchanged name is preserved without duplication. No account or token comparison and no old metadata/credential preservation apply. Siblings retain their metadata and order. If the removed item was selected, select the fresh item; otherwise preserve the selected sibling. A new record selects the item; an existing unselected record remains unselected. Reconnect validates the old target ID and expected revision before removal/read, and returns the actual new ID/generation privately for post-login checks.

## 3. Credential contract

Only the ChatGPT branch is supported: `auth_mode == "chatgpt"` with access and refresh tokens and a finite JWT expiry. The nested `https://api.openai.com/auth.chatgpt_account_id` claim is required; optional top-level and `tokens.account_id` values must match. No JWT or Provider-header widening applies.

Missing, unreadable, directory, oversized, empty, invalid JSON, unsupported auth mode or unparseable credential input still creates one ordinary Profile with `kind: "unavailable"`. It carries no token or incarnation reference and projects ordinary `reconnect_required` health. Selected unavailable Profiles fail closed, and disabled/unavailable items are excluded from automatic 429 switching. Acquisition never keeps old token material in the live record.

Parseable expired OAuth is imported unchanged. Acquisition performs no network login or refresh. Subsequent requests, Recheck, catalog checks and usage resolve the selected owned incarnation through ordinary Pi OAuth; refresh uses the existing per-credential lock and revision/publication guards. Token never rewrites, deletes or refreshes the original Codex auth.json. Changes to that source do not affect the imported Profile until the next explicit acquisition.

SchemaVersion remains 2. Optional private `acquisition?: "codex_local"` is valid only for Codex OAuth, with at most one such Profile per Provider. It never enters public DTOs, Renderer, logs or Pi semantic state. `CredentialProfileCarrier` adds `unavailable`, and publication accepts `Credential | null`; existing ordinary records remain valid with one current validator and no migration/dual reader.

Rename/note, Enable/Disable, Remove, ordering and selection use ordinary implementations. Recheck uses existing credential material and does not read the source. Manual Profile Reconnect uses Provider login; local acquisition Reconnect calls the same shared operation as startup. Public outcomes remain ordinary Profile state. Automatic switching remains bounded to the same Provider, auth branch and lane, with no acquisition filter.

### 3.5 Generations

Separate authoritative facts:

- `incarnation.relativePath`: the Token-owned credential file reference.
- `selectionGeneration`: changes only when the selected Profile ID changes.
- `credentialGeneration`: the logical incarnation. Changes on login, reconnect,
  replace, or delete. A normal token rotation does **not** change it.
- `tokenRevision`: a content hash of the token document. It changes when the
  content changes; rewriting identical bytes intentionally leaves it
  unchanged. No separate write counter is defined.

Capture carries identity only; secrets stay request-local. Catalog composition
and selection are keyed by `credentialGeneration`. Managed usage publication guards and cache identities use the captured Profile
identity and generations. Reconstruction creates new IDs/generations, so observations
are never adopted by a replacement account. In-flight requests pin the snapshot they
resolved.

### 3.6 Internal storage, commit, recovery, and backup

- Layout:
  `<Token state>/credentials/<providerId>/<credentialId>/<credentialGeneration>.auth.json`,
  one file per committed logical incarnation, plus the Provider record that
  references the active incarnation. The record remains the authority for
  identity, selection, generations, and the active path; the file is the token
  material.
- Normal rotation (same incarnation): under the per-credential lock, write the
  referenced file via tmp+rename+fsync, then publish the record update with the
  new `tokenRevision`. If the record update fails, the file is newer but
  uncommitted; the next read may reconcile it **only because the record still
  references the same incarnation path**.
- Add/reconnect/replace (new incarnation): while holding the same
  per-credential lock, write the new generation's file at its unique path
  first, then switch the record reference and `credentialGeneration` in one
  record commit. That record commit is the visibility point. A crash before it
  leaves the new file unreferenced; a crash after it makes the new file
  authoritative. Recovery must never adopt an unreferenced file by hash, and
  an old capture must never consume the new grant.
- Crash recovery: only the referenced incarnation path is reconciled. If the
  record references incarnation G1, files of G2 are ignored (and later
  collected); a referenced but missing/invalid file marks the credential
  unavailable and never falls back to another file or payload.
- Delete: remove the record reference (the commit point), then let orphan
  collection delete the file after a grace period. Deletion resolves the
  canonical path and refuses Windows reparse points/symlinks and paths outside
  the credential directory; the ownership string alone is not trusted.
- Orphan collection and publication are mutually exclusive: GC acquires the
  same per-credential lock used by incarnation publication, then under the
  record lock re-checks that the file is still unreferenced before deleting.
  The lock order is credential lock → record lock, matching publication; a
  writer between file write and record commit holds the credential lock, so GC
  cannot delete its file. Grace alone is never sufficient evidence that a
  writer has stopped.
- Backup: ordinary backup continues to exclude secrets entirely. A full
  sensitive backup must capture the record and every referenced credential file
  consistently (hash-verify after read, retry on mismatch). External files are
  never copied or included, only their reference; restore reconciles by
  revision and never silently reattaches an external path.

### 3.7 Provider scope

Only `openai-codex` uses this envelope. Other Providers retain their opaque
payload contract and their existing storage behavior.

## 4. Model catalog

### 4.1 Data flow

```text
shared Codex native source (one generation per refresh)
  strategies: bundled CLI → models_cache.json → (future method) → unavailable
        │  immutable snapshot: runtime / source / entries / warnings
        ├──────────────────────────────────────────────┐
        ▼                                              ▼
injection projection                        provider overlay projection
(keeps all native rows)                     (filter listable, append Pi-missing)
        ▼                                              ▼
token-model-catalog.json                    internal overlay → composition
                                                       ▼
                                            served catalog, /v1/models,
                                            Public Model, both lanes
```

### 4.2 Field sources for appended models

| Field | Source |
| --- | --- |
| `id`, `name` | native `slug`, `display_name` |
| `reasoning`, `thinkingLevelMap` | native `supported_reasoning_levels` (see 4.3) |
| `input` | native `input_modalities` |
| `contextWindow` | native `context_window` (not `max_context_window`) |
| `api`, `provider`, `baseUrl` | inherited from the provider/base |
| `cost`, `maxTokens` | same-generation Pi sibling, else `cost=0` / `maxTokens=16384` |
| `compat` | same-generation sibling, else explicit closed conservative set (4.4) |

`cost=0` affects Pi usage accounting but is accepted (D12). The Codex adapter
does not send `maxTokens` upstream. `inputLimits` is omitted until a consumer
exists or the internal schema is extended.

### 4.3 Reasoning map

- Build an explicit map for every Pi level that matters:
  `off/minimal/low/medium/high/xhigh/max`. A level with no native evidence is
  `null`, not omitted; omission means "use provider default" and can still send
  an unverified effort.
- `minimal → "low"` only when the native ladder actually contains `low`.
- `off` is `null` unless the native row proves a disable/`none` representation.
- Every enabled level must be verified through Pi's public helpers and the real
  adapter before certification. No Client Protocol payload patching.

### 4.4 Compat rules

- Copy only from a **same-generation** sibling and record which sibling and
  which evidence were used.
- No cross-generation fallback. If no same-generation sibling exists, write an
  explicit closed conservative set (for example `supportsStrictMode: false`
  plus the four optional capability flags `false`) and emit a bounded warning.
  This is required because Pi's adapter default for strict mode is enabled,
  so an omitted `compat` is **not** conservative by itself.
- A copied `true` participates in Semantic Conversion and is not proof; it must
  be included in the certification scope or not copied.

### 4.5 Merge rules

- Shared candidate set: the immutable, unfiltered set of native
  `visibility=list` / `supported_in_api=true` rows whose id is absent from
  Pi's bundled list. It is independent of any user configuration and is
  published once per acquisition generation.
- Per-view merge: the served view and the edit preview each apply the same
  rule against their own user config — drop candidates whose id is defined in
  that config, append the rest, and keep the user definition as the single
  definition for that id. The two views may produce different final fragments;
  they must not share a pre-filtered fragment.
- The user's configuration remains the topmost layer and keeps its existing
  semantics (full `models` definitions and partial `modelOverrides`). No
  duplicate definitions for the same id are created.
- Model headers must resolve from the same definition as the model facts; the
  merge guarantees a single definition per id so `config.models.find()` cannot
  pick a different source.

### 4.6 Composition publication

- One refresh computes one acquisition generation from fixed inputs: the
  native snapshot generation and the shared automatic candidate set. The
  candidate set is not filtered by any user configuration.
- Two management views are distinct but share the acquisition generation. The
  **served catalog** applies the per-view merge rule against the
  startup-effective user config; the **models.json edit preview** applies the
  same rule against the current disk file (explicitly next-start). Their final
  overlays may differ; neither view hot-applies edits to the served catalog.
- Both views include the acquisition generation (candidate set) in their cache
  invalidation; replacing only the composer closure is not sufficient.
- Publication is staged and committed as one unit; a failed publication keeps
  the previous generation. In-flight requests keep their captured snapshot.
- The existing contract that user `models.json` edits take effect at startup is
  preserved; this plan does not introduce hot-reload of user configuration.

### 4.7 Overlay mechanics

The shared state is an in-memory, immutable **candidate set**, not a
pre-filtered `models.json` fragment. Each view derives its own fragment at
composition time by the same rule:

```ts
candidates: Model[]                       // shared, unfiltered by user config
viewOverlay = candidates.filter(m => !viewUserConfigDefines(m.id))
```

Merge points:

- Served/runtime registration: startup user config snapshot + candidates →
  derived fragment → `registerTokenProviders(mutableModels, { modelsJson })`
  ([runtime.ts:218](../../src/providers/runtime.ts)).
- Management edit preview: current-disk user config + the same candidates →
  derived fragment →
  `createModelsJsonAuthority({ compose: (providers) => composeEffectiveCatalog(providers) })`
  ([application.ts:631](../../src/application.ts)); its preview keeps the
  existing "takes effect at next start" meaning.

### 4.8 Shared native source

- `CodexNativeCatalogSource.load()` returns one immutable snapshot with
  `runtimeIdentity` (command + version + home + strategy-relevant inputs),
  `source`, `entries`, and `warnings`. Nested entry data is deeply immutable.
- Candidate ordering: explicit `codexCommand` and `CODEX_CLI_PATH` remain
  first (user intent). Otherwise discovered candidates are ordered by their
  resolved `--version` (descending), with file mtime as the tie-break. File
  mtime alone is a heuristic, not a version guarantee; the chosen identity is
  recorded in the snapshot.
- One refresh acquires one snapshot and publishes one generation; both
  projections consume exactly that value. TTL/single-flight only reduce
  acquisitions and must not be the consistency mechanism.
- Explicit invalidation exists for runtime change, Codex home change, strategy
  failure, and manual refresh.
- The injection projection keeps every native row; it must not receive the
  provider overlay's filtered view.
- The catalog validator must validate against the target runtime identity used
  for the snapshot. If it can only resolve a different runtime, the injection
  is not committed: parsing with runtime B does not prove runtime A can use the
  injected catalog. No "record and continue" allowance.
- Credential acquisition is independent: when the catalog
  snapshot is cache-based or unavailable, the refresh boundary still resolves
  the Codex runtime through the same discovery strategy.
- Direct Mode recognition continues to use the ids updated by a successful
  injection ([integration.ts:505](../../src/integrations/codex/integration.ts)).

## 5. Lane behavior

- **Responses → Provider Native:** does not enter Pi IR or Pi Provider
  execution, but does consume Pi Model facts (id/api/baseUrl) and the binding's
  resolved auth. It does not read `compat`.
- **Anthropic Messages → Semantic Conversion:** Pi AI builds the provider
  request and consumes `compat`/`thinkingLevelMap`. Appended models must carry
  the explicit values from 4.3/4.4.
- **Direct Mode:** unchanged and independent.

## 6. Usage and availability

Usage uses the selected ordinary managed binding and `models.getAuth`; it never reads auth.json itself. Existing credential/selection-generation guards reject old observations after rebuild or switching. Public Model availability and Operational Attention inspect only the selected Profile when Profiles exist; another ambient/source state cannot mask an unavailable selected item. Profile names, cards, counts, radio controls and actions use one public DTO without acquisition-specific UI branches.

## 7. Verification

Offline fixtures use new temporary CODEX_HOME and synthetic credentials, with explicit paths and cleanup. Cover startup/Reconnect sharing, unique forced replacement including same credentials and account changes, unavailable input, selected/unselected transitions, ordinary actions, 429 candidates, stale command/publication rejection, failed commits, GC and owned-only refresh. Settings must persist a pending value and apply it on the next Backend load.

Run `npm run typecheck`, `npm run lint` and guarded `npm test`. With explicit user authorization, `test/online/run-openai-codex-provider.ts` reads the real local Codex login into isolated Token storage and exercises usage plus Provider Native and Semantic Conversion through the ordinary Profile. All native-catalog subprocesses use the temporary home. Verify the original auth file's hash/metadata after the run. Missing login or upstream entitlement/network failure is incomplete online coverage, never a pass.

The Codex-native catalog overlay and response framing contracts in section 4 remain unchanged. The earlier app-server contract research in `doc/Research/TokenOpenAICodexP1AppServerContract.md` records a prior design's evidence; Token no longer invokes that credential refresh mechanism.

## 8. Implementation evidence (2026-10-01)

- `npm run typecheck` and `npm run lint` passed.
- Guarded `npm test` passed 77 certification tests, 312 Backend test files / 2903 cases, and 23 Desktop test files / 154 cases.
- `codex-local-login.test.ts` covers forced replacement, default metadata, selected/unselected preservation, unavailable inputs, expired imports, stale commands, cross-store concurrency, atomic publication failure, GC, old-refresh rejection, priority overflow, startup settings and ordinary 429 switching.
- The authorized real local-login run used temporary Token state and temporary CODEX_HOME for native-catalog processes. Imported credentials used an ordinary managed binding; usage succeeded and `gpt-6.1-sol` Native Responses and Semantic Messages each returned HTTP 200 with positive completion.
- A second ordinary storage fixture used the same authorized OAuth grant. Switching to it and back produced successful usage and HTTP 200 completion in both lanes each time. This proves bidirectional selection by Profile ID, not two distinct live accounts or the interactive browser-login flow.
- The original local auth.json content hash, size and mtime remained unchanged. OAuth rotation was not required in this live run, so real expired-token refresh remains uncovered; isolated tests cover expired import and owned-only rotation.
- Independent model-catalog, Provider Native framing, compaction and lane-isolation behavior remains governed by the existing section-4 contracts and architecture certification.
