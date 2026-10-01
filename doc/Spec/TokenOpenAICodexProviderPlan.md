# Token OpenAI Codex Provider Plan: Auth Sources and Native Model Catalog

**Status:** Draft v3.3 (2026-10-01). P1 gate evidence recorded (section 11);
P0–P3 implemented on branch `codex/openai-codex-auth-native-catalog`. The
implementation review repairs are recorded in section 13. Actual delegated
rotation coverage remains open (see section 12); historical smoke success is
not full P4 certification.

**Scope:** the `openai-codex` provider inside Token — credential sources and
model catalog as consumed by Provider Native Responses and Semantic Conversion
(Anthropic Messages). Codex Direct Mode keeps its own model recognition,
caller credential envelope, and transport and is not changed.

**References:** [AGENTS.md](../../AGENTS.md),
[TokenProviderCredentialProfilesPRD.md](./TokenProviderCredentialProfilesPRD.md),
[TokenCodexModelCatalogSpec.md](./TokenCodexModelCatalogSpec.md).
For the implementation repair, the user selected the in-repo
`reference/opencodex` as the opencodex reference. Earlier review evidence from
the standalone checkout is historical. The Codex reference is
`reference/codex` (codex-rs sources cited below).

## 0. What changed in v3

- Reconnect/add/replace now use an incarnation-specific credential path; the
  record reference switch is the visibility commit. Hash reconciliation is
  limited to normal rotation inside the referenced incarnation and can no
  longer adopt an uncommitted logical replacement.
- The account-claim contract is the intersection of the three consumers: the
  nested claim is required and any top-level/`tokens.account_id` value must
  match.
- External freshness moved to the private binding boundary: the adapter's
  `read` ensures freshness, `modify` refuses instead of replacing Pi's refresh
  callback, and one shared single-flight covers all entry points.
- The app-server "no other mutation" promise is narrowed; its startup side
  effects are recorded as a P1 gate.
- Management edit preview and the served catalog are separate representations
  with different user-config inputs.
- The catalog validator must use the target runtime; a different runtime must
  not commit the injection.
- Error classification has a P1 evidence gate; only documented terminal
  evidence stops network retries.
- Minor fixes: acceptance 8/10/14, the opencodex evidence link, and the
  `tokenRevision` definition.

v3.1 local fixes:

- The automatic overlay is a shared, unfiltered candidate set; the served view
  and the edit preview each apply the same per-id exclusion rule against their
  own user configuration, so a pre-filtered fragment can no longer go stale
  when the user adds or removes a colliding id.
- Orphan collection and incarnation publication share one lock protocol; GC
  re-checks references under the record lock before deleting.
- Pi's 5-minute window is described as a refresh trigger, not a hard validity
  guarantee; the sufficient-validity constraint is Token's own.
- Acceptance 9 is a computable union assertion with a Pi-missing native model.

v3.2 evidence:

- The P1 app-server contract and error-classification evidence were recorded
  in `doc/Research/TokenOpenAICodexP1AppServerContract.md` and
  `doc/Research/TokenOpenAICodexP1ErrorClassification.md`.
- Startup side effects were inventoried; the narrowed "only intended
  mutation" wording stands.
- Terminal classification remains evidence-limited: insufficient evidence
  stays bounded transient.

## 1. Decisions

- **D1 — Credential carrier.** A credential is an `auth.json` document in the
  Codex ChatGPT-branch shape. Token's own login writes an internal
  `auth.json`; `<CODEX_HOME>/auth.json` is the external document. Same payload
  family, different path and ownership.
- **D2 — Ownership.** `internal`: Token writes and refreshes it. `external`:
  Codex owns the file. Token may request an in-place Codex-native refresh
  (section 3.2), but never copies or moves it, never rewrites it itself, and
  never refreshes it through Pi OAuth. The external CredentialStore path never
  executes Pi's refresh callback; it refuses instead.
- **D3 — Freshness and capture.** A request captures the credential identity
  first and resolves the secret only when needed, in this order: capture
  identity → ensure freshness in the private binding boundary (owned
  refresher) → resolve request-local auth value → first dispatch. A
  near-expiry external credential is never handed to Pi; if freshness cannot
  be ensured the binding fails before Pi's refresh path is reached. Secrets
  never enter public capture facts. A request that has already resolved its
  credential completes even if the credential is removed afterwards; a request
  that has not yet resolved it fails closed.
- **D4 — Model list.** Keep Pi's `openai-codex` provider (same id, auth, API
  adapter). Extend only its model list through a Token-internal overlay in the
  `models.json` shape. Append-only: models Pi already ships are never modified.
  The user's `models.json` is never written.
- **D5 — Model sources.** Shared local Codex native catalog first
  (`codex debug models --bundled`, read-only `models_cache.json` fallback), Pi's
  bundled list as fallback. Filter native rows to `visibility=list` and
  `supported_in_api=true`.
- **D6 — New-model fields.** Identity and capability fields come from the
  native row. `cost`/`maxTokens`/`compat` are copied only from a
  **same-generation** Pi sibling with recorded evidence. With no same-generation
  sibling, the model is still appended with an explicit closed set of
  conservative values and a bounded warning. No cross-generation fallback.
- **D7 — No compatibility work.** Old credential/profile documents are
  replaced, not migrated. No dual readers, shims, or deprecated aliases.
- **D8 — Upstream untouched.** No patch or fork of the installed Pi package.
  No new provider id. Direct Mode unchanged.
- **D9 — Shared native source.** Local Codex model acquisition is one
  abstraction with a swappable strategy chain. One refresh publishes one
  immutable snapshot/generation consumed by both projections. TTL and
  single-flight only optimize acquisition; they are not the consistency
  contract.
- **D10 — Usage card.** The WHAM probe serves both sources through the same
  captured binding. External freshness uses the same Codex-native delegation as
  requests; Pi never refreshes an external credential. No cross-account
  observation reuse.
- **D11 — Scope.** The credential-envelope change applies only to
  `openai-codex`. Other Providers keep the opaque Provider payload contract
  ([PRD:194](./TokenProviderCredentialProfilesPRD.md)).
- **D12 — Cost.** Missing `cost` is not a blocker, but it is not "display
  only": Pi computes usage cost from it
  ([models.js:533](../../node_modules/@earendil-works/pi-ai/dist/models.js)).
  Zero/unknown cost values are an accepted accounting degradation.

## 2. Verified facts

### 2.1 Resource-request authentication

- A Codex resource request needs `Authorization: Bearer <access token>` and a
  ChatGPT account-id header. The account id is derivable from the access-token
  JWT; Token's Native transport decodes
  `https://api.openai.com/auth.chatgpt_account_id`
  ([codex.ts:29](../../src/provider-native-responses/codex.ts)).
- That is the **authentication** input, not the whole request. Native also
  sets transport headers such as originator, User-Agent, content type, and
  session facts ([codex.ts:129](../../src/provider-native-responses/codex.ts)).
  opencodex likewise forwards its own allowlisted headers in addition to the
  auth pair (standalone checkout
  `D:\project\opencodex\src\codex\auth-context.ts`).
- The refresh token is sent only to the OAuth token endpoint, never to resource
  requests. Pi's `toAuth` returns the access token only
  ([openai-codex.ts:541](../../pi-agent/packages/ai/src/auth/oauth/openai-codex.ts));
  the refresh exchange posts `refresh_token`
  ([openai-codex.ts:171](../../pi-agent/packages/ai/src/auth/oauth/openai-codex.ts)).
- Account-claim acceptance differs today: Native requires the nested claim,
  while the usage probe accepts top-level or nested claims
  ([usage:42](../../src/provider-usage/probes/openai-codex.ts)). The plan
  unifies this contract (section 3.4).

### 2.2 Codex `auth.json` and native refresh

- Payload shape `AuthDotJson`: `auth_mode`, `OPENAI_API_KEY`, `tokens`
  (`id_token`, `access_token`, `refresh_token`, `account_id`), `last_refresh`,
  plus newer optional fields
  ([storage.rs:41](../../reference/codex/codex-rs/login/src/auth/storage.rs)).
- Default store is `file`; `keyring`/`auto`/`ephemeral` are opt-in
  ([types.rs](https://github.com/openai/codex/blob/8ea2428c38f8994e18d789669f5cbc5df75e1f17/codex-rs/config/src/types.rs)).
- File writes are `truncate` + `write` + `flush`, not atomic rename
  ([storage.rs:154](../../reference/codex/codex-rs/login/src/auth/storage.rs),
  [:206](../../reference/codex/codex-rs/login/src/auth/storage.rs)).
- Native refresh: refresh when the access token has ≤5 minutes of validity, or
  when expiry is unparseable and `last_refresh` is older than 8 days
  ([manager.rs:3004](../../reference/codex/codex-rs/login/src/auth/manager.rs));
  re-read the file under the AuthManager semaphore before refreshing and adopt
  a changed credential instead of exchanging
  ([manager.rs:2848](../../reference/codex/codex-rs/login/src/auth/manager.rs));
  replace only the token fields actually returned and update `last_refresh`
  ([manager.rs:1598](../../reference/codex/codex-rs/login/src/auth/manager.rs));
  write back the original path ([storage.rs:212](../../reference/codex/codex-rs/login/src/auth/storage.rs)).
- App-server exposes this refresh:
  `{"id":1,"method":"account/read","params":{"refreshToken":true}}`
  ([account.rs:551](../../reference/codex/codex-rs/app-server-protocol/src/protocol/v2/account.rs)).
  It applies to Codex-managed auth; Codex's `chatgptAuthTokens` external mode
  ignores the parameter.
- Caveats: RPC success does not prove the refresh succeeded (Token must
  re-read and verify); the semaphore is per AuthManager instance, so multiple
  Codex processes can still race; the file may not be byte- or
  layout-stable after refresh because Codex re-serializes known fields.

### 2.3 Pi OAuth resolution

- Pi's default refresh trigger is a 5-minute window: when
  `expires - now ≤ max(5 min, minOAuthValidityMs)` it calls
  `CredentialStore.modify()` and the callback may call `oauth.refresh()`
  ([resolve.js:70](../../node_modules/@earendil-works/pi-ai/dist/auth/resolve.js)).
  The post-refresh validity check runs only when an explicit minimum is
  supplied ([resolve.js:102](../../node_modules/@earendil-works/pi-ai/dist/auth/resolve.js));
  Pi does not guarantee five minutes of validity after a normal refresh. The
  sufficient-validity requirement in section 3.2 is Token's own added
  constraint.
- Pi's `oauth.refresh()` returns normalized token data; persistence is owned by
  the CredentialStore ([openai-codex.ts:142](../../pi-agent/packages/ai/src/auth/oauth/openai-codex.ts)).
- Pi's `CredentialStore.modify(providerId, fn)` is the only write path and
  executes `fn` with the current credential; Pi's OAuth path passes a callback
  that calls `oauth.refresh()` ([types.d.ts:69](../../node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts),
  [resolve.js:77](../../node_modules/@earendil-works/pi-ai/dist/auth/resolve.js)).
  Token must not ignore or replace that callback for an external credential.
- Consequence: an external credential must never be handed to Pi while near or
  past expiry, and the external CredentialStore path must never call Pi's
  `oauth.refresh()`. The adapter either resolves a credential with sufficient
  validity or fails before dispatch.

### 2.4 Native model catalog source

- Strategy order: installed `codex debug models --bundled` across discovered
  runtimes → read-only `models_cache.json` → `unavailable`
  ([native-catalog-source.ts:244](../../src/integrations/codex/native-catalog-source.ts)).
- The source currently validates only `slug`; all other native fields are
  observed values, not a guaranteed schema
  ([native-catalog-source.ts:45](../../src/integrations/codex/native-catalog-source.ts)).
- The snapshot has no selected runtime identity and the rows are only
  shallow-frozen ([native-catalog-source.ts:15](../../src/integrations/codex/native-catalog-source.ts)).
- Runtime candidates may fail over; the catalog validator can resolve a
  different runtime than the snapshot used for publication
  ([native-catalog-source.ts:247](../../src/integrations/codex/native-catalog-source.ts),
  [catalog-validator.ts:201](../../src/integrations/codex/catalog-validator.ts)).
- Host measurements: 2026-09-30 (codex-cli 0.158.0: 10 rows, 7 listable) and
  2026-10-01 (codex-cli 0.159.2: 11 rows, 8 listable, adding `gpt-6.1-sol`).
  Both are historical evidence, not a contract; a re-measurement records the
  runtime version and snapshot
  ([P1 contract evidence](../Research/TokenOpenAICodexP1AppServerContract.md)).
- Pi 0.87.0 ships six `openai-codex` entries and is generated from a
  hand-maintained script, not from the local Codex install
  ([openai-codex.json](../../node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json)).

### 2.5 Token provider composition

- Reserved bundled provider ids are only `commandcode-private` and
  `commandcode-goat` ([bundled.ts:34](../../src/providers/bundled.ts)).
- A same-id `models.json` entry overlays a Pi builtin: stream/refresh/filter
  behavior and unknown fields come from the base; name/baseUrl/auth/models are
  recomposed ([catalog.ts:112](../../src/providers/catalog.ts)). OAuth
  composition keeps the base flow and applies configured headers **and**
  `authHeader` ([request-composition.ts:302](../../src/providers/request-composition.ts)).
- Layers are `builtin | overlaid | user`; the layer describes the composition
  input, not a guarantee that runtime and management saw the same generation.
- New model definitions default to `reasoning=false`, `input=["text"]`,
  zero cost, `contextWindow=128000`, `maxTokens=16384`; `api`/`baseUrl`
  resolve model → provider → base model, and `inputLimits` is inherited only on
  upsert ([effective-composition.ts:208](../../src/providers/effective-composition.ts)).
- Compat merges provider-level and definition-level values
  ([effective-composition.ts:243](../../src/providers/effective-composition.ts)).
  Pi's adapter default for `supportsStrictMode` is not `false`; the adapter
  enables strict behavior unless told otherwise
  ([adapter:374](../../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js)).
  A missing `compat` therefore is **not** a fully conservative default.
- `modelOverrides` is the partial field-wise update path
  ([effective-composition.ts:151](../../src/providers/effective-composition.ts)).
- Model headers resolve through `config.models.find(...)` (first definition
  wins), so duplicate ids across layers can make headers and model facts come
  from different definitions
  ([request-composition.ts:357](../../src/providers/request-composition.ts)).
- `inputLimits` is not expressible in the config schema; in pinned pi-ai
  0.87.0 no production code reads it (only the faux provider copies it)
  ([models-json-schema.ts:172](../../src/providers/models-json-schema.ts),
  [faux.js:327](../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js)).
- `cost` participates in Pi usage computation
  ([models.js:533](../../node_modules/@earendil-works/pi-ai/dist/models.js)).

### 2.6 Usage pipeline

- The usage authority captures the provider binding, then runs the probe under
  `binding.runBound(capture, ...)` and resolves auth with
  `models.getAuth(providerId)`
  ([authority.ts:273](../../src/provider-usage/authority.ts)).
- Binding context today is `managed | ambient` only
  ([contract.ts:92](../../src/provider-usage/contract.ts),
  [authority.ts:60](../../src/provider-usage/authority.ts)); the probe accepts
  only managed OAuth.
- Refresh failures are returned but not persisted as state; auto-refresh
  selects `unobserved` or `refreshable observed` providers
  ([authority.ts:165](../../src/provider-usage/authority.ts),
  [auto-refresh.ts:29](../../src/provider-usage/auto-refresh.ts)). 401/403 are
  both mapped to `auth` with no terminal/non-terminal split
  ([wire.ts:153](../../src/provider-usage/wire.ts)).
- The Renderer hides the usage card unless a managed profile exists
  ([ProvidersPage.tsx:1170](../../packages/desktop-shell/src/renderer/providers/ProvidersPage.tsx)),
  and Public Model availability treats a provider as usable only via an active
  managed profile or configured ambient source
  ([runtime-facts.ts:31](../../src/public-models/runtime-facts.ts)).

### 2.7 Reference behavior (standalone opencodex)

- Main account: reads `~/.codex/auth.json` read-only, distinguishes
  `ok/missing/invalid/unreadable`, uses `access_token` + account id for WHAM,
  caches with a TTL, and on terminal auth failure marks reauth instead of
  refreshing; an unparseable expiry is treated as live
  (`D:\project\opencodex\src\codex\auth-collision.ts`,
  `...\main-account.ts`, `...\auth-api.ts`).
- The previous claim "sharing one auth.json always invalidates the second
  refresher" is too strong: the supported evidence is a race between
  independent refreshers presenting the same old refresh grant
  ([issue-analysis.yml:35](../../pi-agent/.github/workflows/issue-analysis.yml)).

## 3. Credential contract

### 3.1 Payload and ownership

```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "..."
}
```

`id_token` is optional for Token's own internal use; the compatibility is
one-way. External documents are Codex's and are never rewritten by Token.
The public Pi OAuth credential does not retain `id_token` or a refresh
timestamp. The internal codec therefore omits `id_token` and writes
`last_refresh: null` (unknown); it never manufactures either fact. It verifies
the nested account claim and JWT expiry before persisting the ChatGPT envelope.

| Mark | Writer | Refresh | Delete |
| --- | --- | --- | --- |
| `internal` | Token | Token, via Pi OAuth, atomic write | reference + file |
| `external` | Codex | requested from Codex, in place (3.2) | reference only |

### 3.2 External freshness: delegate to Codex, never to Pi

1. **Trigger.** Access token expires within 5 minutes, or expiry is
   unparseable and `last_refresh` is older than 8 days — the same thresholds
   Codex uses.
2. **Delegate.** Token starts a bounded one-shot `codex app-server` against the
   same `CODEX_HOME`, performs the JSON-RPC initialize handshake, calls
   `account/read {"refreshToken": true}`, and terminates. One-shot is the
   decision; process reuse is out of scope. Runtime selection for the refresh
   is resolved independently of the catalog snapshot so a catalog failure does
   not disable refresh.
3. **Verify by re-reading.** After the RPC returns, Token re-reads the same
   canonical path and requires: same canonical path and account identity; a
   valid access-token expiry with more than the minimum validity; the refresh
   actually advanced the revision. RPC success alone is not accepted.
4. **Fail closed.** If delegation is unavailable, times out, or verification
   fails, the external source is unavailable for that request. Token must not
   fall back to Pi OAuth, must not use the refresh token itself, and must not
   use another source silently.
5. **Concurrency.** Codex's semaphore is per AuthManager instance and the file
   write is not atomic. Token treats a failed read/parse as transient, retries
   within a bounded budget, and never assumes byte or layout stability after an
   allowed refresh. Independent Codex processes may still race; Token does not
   claim cross-process exclusion.
6. **Coverage.** All auth entry points — session streaming, Native responses
   and compact, Semantic Conversion, catalog/refresh, recheck/post-login, and
   usage — resolve external credentials through this one binding path. No
   entry point may hand a near-expiry external credential to Pi or call Pi's
   `oauth.refresh()` for it.
7. **Enforcement.** Freshness lives in the private binding boundary. The
   external CredentialStore adapter's `read` returns a credential only when it
   has sufficient validity; if freshness cannot be ensured it returns
   unavailable instead of a near-expiry credential. `modify` refuses with a
   bounded error: it never executes Pi's refresh callback and never calls Pi's
   `oauth.refresh()`. Real `expires` and `refresh` values are passed unchanged;
   no field is fabricated.
8. **Shared coordination.** One single-flight keyed by the canonical path
   covers Native, Semantic, catalog/recheck, and usage. Waiters join the same
   run; cancelling one waiter must not abort a refresh other requests need.
   After the run, every waiter re-reads and re-validates the file revision.

App-server startup is not side-effect free: it initializes its state database
and may move a corrupt database during recovery
([lib.rs:655](../../reference/codex/codex-rs/app-server/src/lib.rs:655),
[:1422](../../reference/codex/codex-rs/app-server/src/lib.rs:1422)). The plan's
guarantee is therefore narrowed: Token's only *intended* mutation is the auth
refresh. P1 must record the observed lifecycle side effects and either prove an
isolation configuration that leaves other user state unchanged while auth still
uses the original `CODEX_HOME`, or drop the "no other state" claim. Copying the
auth file is never an option.

The one-shot sequence, temp-home echo, exit behavior, and the actual startup
side-effect inventory were verified on codex-cli 0.159.2
([P1 contract evidence](../Research/TokenOpenAICodexP1AppServerContract.md));
the inventory confirms the narrowed guarantee above.

### 3.3 Internal refresh

Internal credentials keep the existing managed-OAuth contract: Pi performs the
non-interactive refresh under the per-credential lock; Token publishes the
refreshed credential with the existing generation/revision guards. Silent
rotation does not change the logical credential generation, selection
generation, management revision, or user-visible `updatedAt`.

### 3.4 Parse and validation contract

- Result states: `ok | missing | invalid | unreadable`, never a single null.
- Only bounded retry applies to `invalid`/transient read failures; a
  permission/ENOENT class failure is not retried indefinitely.
- Required branch: `auth_mode == "chatgpt"` with a ChatGPT token set. API-key,
  agent-identity, PAT, Bedrock, and similar modes are unsupported for this
  source and are never coerced into ChatGPT tokens.
- Expiry: access-token `exp` must parse to a numeric epoch value. Missing,
  wrong-typed, or unparseable expiry is not treated as live; Token attempts the
  Codex delegation (subject to 3.2), re-reads, and otherwise fails closed.
- Account identity — intersection contract: the nested
  `https://api.openai.com/auth.chatgpt_account_id` claim must exist, because
  Pi's adapter reads only that path
  ([adapter:1250](../../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js)).
  A top-level `chatgpt_account_id`, when present, must equal the nested value;
  `tokens.account_id`, when present, must also match. A top-level-only document
  is rejected consistently by Native, Semantic, and usage. Token does not
  rewrite the JWT or inject headers to widen Pi's acceptance.
- Codex delegation applies only to external sources. Internal credentials
  refresh through Pi OAuth and may lack `id_token`; the external delegation
  contract is never applied to them.
- Terminal vs transient: terminal auth rejection stops further automatic
  network attempts until the file revision changes (local re-read recovery);
  transient parse/read errors do not become permanent reconnect state.
- After every delegated refresh, re-verify the canonical path, account, and
  validity; never reuse a result that no longer matches the captured
  identity.

### 3.5 Generations

Three separate facts:

- `sourceRef`: the canonical path and ownership mark.
- `credentialGeneration`: the logical incarnation. Changes on login, reconnect,
  replace, or delete. A normal token rotation does **not** change it.
- `tokenRevision`: a content hash of the token document. It changes when the
  content changes; rewriting identical bytes intentionally leaves it
  unchanged. No separate write counter is defined.

Capture carries identity only; secrets stay request-local. Catalog composition
and selection are keyed by `credentialGeneration`. Usage publication guards and
cache identity use the account identity plus `tokenRevision`; observations are
never carried across accounts. In-flight requests pin the snapshot they
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
- External refresh runtime resolution is independent: when the catalog
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

## 6. Usage card (full chain)

- Binding: extend the usage binding context with the external OAuth kind.
  Acquisition uses the same captured binding and `models.getAuth` path; the
  probe never reads `auth.json` itself.
- Freshness: manual refresh and auto-refresh may trigger the same Codex-native
  delegation as 3.2, never Pi refresh. Auto-refresh only when near expiry. The
  single-flight is the shared one from 3.2 item 8, keyed by canonical path and
  used by every entry point — not a usage-only flight.
- Cache and in-flight identity: account identity + `tokenRevision`; a late
  response from a previous revision must not publish. A Codex-side refresh
  invalidates the observation, but the last-known observation for the same
  account may remain displayed as stale.
- Failure classes: timeout, temporary read/parse errors, account change,
  insufficient validity after a delegated refresh, and explicit terminal
  rejection are distinct. Only documented terminal evidence stops network
  attempts (until the file revision changes); anything else stays bounded
  transient. Never classify by parsing stderr text. No cross-account quota
  carryover.
- Control Plane / product: the usage DTO, Public Model availability,
  Operational Attention, and Renderer gating must all accept the external
  source. The Renderer must no longer hide the card solely because no managed
  profile exists.

## 7. Non-goals

- No patch or fork of the installed Pi package.
- No new provider id; no second provider definition.
- No writes to the user's `models.json`.
- No migration, dual reader, shim, or deprecated alias for old credential or
  profile documents.
- No second independent native-catalog loader.
- No changes to Direct Mode, Client Protocol conversion, or diagnostics
  contracts.

## 8. Implementation phases

1. **P0 — Specs.** Update the PRD and release notes: external read-only source
   becomes external source with Codex-delegated in-place refresh; record the
   generation model, commit protocol, overlay generation, and usage chain.
2. **P1 — Credentials.** Payload type, tolerant parser, generation/token
   revision model, internal commit/recovery/delete/backup, external binding
   adapter with Codex-delegated refresh, and the entry-point coverage above.
3. **P2 — Model overlay.** Shared native snapshot generation, strategy key,
   overlay generation, merge rules, both composition entry points, fallback.
4. **P3 — Usage.** Binding context, probe eligibility, cache/in-flight
   identity, Control Plane DTO, Public Model, Operational Attention, Renderer.
5. **P4 — Verification.** Offline suites plus the dedicated `openai-codex`
   online suite in section 9.

## 9. Acceptance criteria

1. With only Codex logged in (file store), Token starts with `openai-codex`
   connected via the external source.
2. Token never writes or deletes `<CODEX_HOME>/auth.json`; an allowed Codex
   refresh may change its bytes.
3. Near-expiry external credentials are refreshed by delegating to Codex and
   verified by re-reading; no Pi OAuth refresh is ever invoked for external.
4. If delegation is unavailable, times out, or verification fails, the request
   enters a bounded transient state with a Codex-refresh prompt and retries
   within budget; it never falls back to Pi refresh or another source.
5. Token's own login refreshes independently without touching Codex's file.
6. Responses requests for appended models succeed through Provider Native.
7. Anthropic Messages requests build through Pi with the explicit reasoning
   map and compat values.
8. The automatic overlay appends only native `visibility=list` and
   `supported_in_api=true` rows absent from Pi and from the user's definitions;
   it never removes or modifies Pi or user models.
9. With no user config and a fresh native snapshot, the served ids equal
   `PiIds ∪ {native listable ids ∉ PiIds}`; existing Pi model facts are
   unchanged; the test includes at least one Pi-missing native model so a
   missing append implementation is falsifiable.
10. With the native source unavailable, the automatic overlay is absent and
    the user configuration composition is preserved; the served list equals
    Pi's bundled list only when no user overrides are present.
11. Runtime registration and the management projection consume the same
    generation; replacing the acquisition strategy requires no consumer
    change; a refresh does not hot-apply user `models.json` edits.
12. Every appended model has explicit reasoning nulls and an explicit compat
    set; copied `true` values are within the certified scope.
13. With only an external Codex login, the usage card shows WHAM windows, and
    Renderer/Public Model/Attention treat the external source as usable.
14. Expired/invalid external tokens produce a bounded state with a
    Codex-refresh prompt. Only documented terminal evidence stops network
    retries until the file revision changes; without that evidence the state
    stays transient.
15. No patch, fork, or modification of `node_modules/@earendil-works/pi-ai`.
16. Every test that can reach Codex state uses a fresh temporary `CODEX_HOME`
    and never copies the user's `auth.json`, catalogs, caches, or sessions.
17. The dedicated online suite proves external refresh, appended models, and
    both lanes end to end with a dedicated test login; it is skipped, not
    mocked, when that login is unavailable.
18. The claim matrix is consistent across Native, Semantic, and usage:
    nested-only is accepted; top-level-only is rejected; matching top-level and
    `tokens.account_id` are accepted; any conflict is rejected.
19. Reconnect with the new incarnation file written but the record commit
    failed: after restart the old incarnation remains authoritative, an old
    capture cannot consume the new grant, and the unreferenced file is
    collected after the grace period.
20. Native, Semantic, usage, and recheck triggering freshness concurrently
    start exactly one shared helper; cancelling one waiter does not abort the
    run other waiters need.
21. After startup, editing `models.json`: the edit preview shows the edited
    configuration while the served catalog keeps the startup-effective
    configuration; an overlay refresh does not hot-apply the edit; a failed
    publication keeps the previous overlay generation.
22. Model certification covers every reasoning level, omitted reasoning,
    strict tool constraints, a normal tool round-trip, images, and
    full-history continuity — not build success alone.
23. Usage covers transient read-failure recovery, terminal no-network-retry,
    file-change recovery, same-account stale display, no display after an
    account change, and rejection of a late response from an old revision.
24. Child-process isolation is verified: every spawned helper actually
    receives the temporary `CODEX_HOME`, including the native catalog runner.
25. After startup, adding or deleting a user definition whose id collides with
    an automatic candidate: the preview has no duplicate definition, headers
    and facts come from the same definition, and the served catalog keeps the
    startup configuration.
26. Fault injection around an incarnation commit: pause the writer after the
    new file is written, run GC, then resume the commit; the record must never
    reference a collected file, and GC must not delete a file whose
    publication lock is held.
27. A real-Pi resolver test covers the 5-minute boundary, an explicit larger
    minimum, and time advancing after `read`; the external OAuth refresh
    callback is invoked zero times, and an unsatisfiable case fails
    explicitly.
28. Rotation/delete/reconnect/backup interleavings, including a sensitive
    backup during a reference switch, always recover a consistent record/file
    pair.
29. App-server non-atomic-write windows (empty file, truncated JSON,
    temporarily unreadable) recover within bounds and are never classified as
    terminal.
30. The online suite records success/failure/skip separately; the presence of
    a dedicated login is not treated as proof of rotation — the run must
    observe Codex delegation and the subsequent re-read verification.
31. A listable model for which the test account lacks entitlement is rejected
    without pushing the shared credential into a terminal state; terminal
    classification still follows section 6's evidence rules.

## 10. Review dispositions

| Review item | Disposition |
| --- | --- |
| B2 incarnation commit | Section 3.6: incarnation-specific paths, record reference switch is the commit, reconciliation limited to the referenced incarnation, no hash adoption, orphan GC. |
| M2 claim intersection | Section 3.4: nested claim required, top-level/`tokens.account_id` must match, top-level-only rejected, no JWT/header widening; delegation limited to external. |
| B1 modify semantics | Section 2.3 and 3.2 items 7–8: freshness in `read`, `modify` refuses, callback and `oauth.refresh` never used, shared single-flight across all entry points. |
| App-server side effects | Section 3.2 narrowed promise plus section 11 P1 gate: record state-DB init/repair, prove isolation or drop the "no other state" claim, never copy auth. |
| M3 preview vs served | Sections 4.6–4.7: served catalog uses startup-effective config + committed overlay generation; edit preview keeps current-disk/next-start semantics and the same overlay generation. |
| M7 validator runtime | Section 4.8: validation must use the target runtime; a different runtime does not commit the injection; refresh runtime resolution is independent of the catalog snapshot. |
| M8 error taxonomy | Sections 3.4, 6, and 11 P1 gate: timeout/temporary/account-change/insufficient-validity/terminal are separate; insufficient evidence stays transient; no stderr parsing. |
| M4 acceptance conflict | Section 9 items 8/10: fallback preserves user configuration; `supported_in_api` is explicit. |
| N1 evidence link | Section 2.1 now refers to the standalone opencodex checkout instead of the repo copy. |
| tokenRevision | Section 3.5: content hash that changes only when content changes; no write counter. |
| 3rd-review M1 candidate-set merge | Sections 4.5–4.7: shared unfiltered candidate set; served and preview each exclude their own user-defined ids; a single definition per id is guaranteed. |
| 3rd-review M2 GC vs commit | Section 3.6: publication holds the credential lock from file write through record commit; GC acquires the same lock and re-checks references under the record lock. |
| 3rd-review N1 Pi window wording | Section 2.3: 5-minute default trigger; explicit-minimum post-refresh check; Token's sufficient-validity constraint. |
| 3rd-review N2 acceptance 9 | Section 9 item 9: computable union assertion including a Pi-missing native model. |

## 11. Open items and P1 gates

1. **App-server contract — evidence recorded (P1 gate); P1 implementation
   closed.** On codex-cli
   0.159.2: initialize/initialized/account-read are accepted; the temp
   `CODEX_HOME` is echoed; closing stdin exits with code 0 within 5 s;
   initialize took 0.2–4.0 s and account/read ~64 ms. Startup side effects
   were inventoried inside the temp home (state DBs/WAL, `installation_id`,
   `plugins.sync.lock`, `.tmp` scratch, copied system skills; writes outside
   the temp home were not monitored), and no isolation configuration was
   found, so the narrowed guarantee stands
   ([evidence](../Research/TokenOpenAICodexP1AppServerContract.md)). Remaining:
   test whether configuration flags can bound the startup writes while auth
   stays in the original home. Token's implementation keeps the narrowed
   guarantee: the only intended mutation is the auth refresh, and every helper
   is spawned with an explicit `CODEX_HOME` (section 12, acceptance 24).
2. **Error classification — evidence recorded (P1 gate); P1 implementation
   closed.** Missing, invalid
   JSON, unreadable path, and a rejected refresh all return the same
   `account: null / requiresOpenaiAuth: true`; a rejected refresh is visible
   only as stderr message text and left `auth.json` unchanged in the tested
   case (save-failure/crash windows untested); and
   `refreshToken: false` did not suppress refresh attempts for an expired
   credential. Terminal classification is therefore not derivable from this
   channel: insufficient evidence stays bounded transient, RPC success is not
   refresh success, and verification is by re-read
   ([evidence](../Research/TokenOpenAICodexP1ErrorClassification.md)). P4 must
   repeat the matrix with a dedicated login. The existing `--use-codex-auth`
   branch that copied the user's real `auth.json` has been removed; the online
   suite now requires `TOKEN_CODEX_TEST_AUTH_HOME` and records an explicit
   skip when that dedicated login is unavailable.
3. **Online test login (P4 gate) — RESOLVED for the local-login path.** By
   user decision the `openai-codex` online suite uses the local Codex login
   (`CODEX_HOME` or `~/.codex`) unless `TOKEN_CODEX_TEST_AUTH_HOME` names a
   dedicated home. The suite reads the document, never copies it, and a
   Codex-native refresh may rewrite it in place exactly as Codex itself would.
   The guarded script still records
   `{"result":"skip","reason":"codex_login_unavailable"}` when it finds no
   ChatGPT login. A successful **delegated rotation** has still not been
   observed: the local access token is valid until 2026-10-08, so the run
   reported `rotation: "not_required"`. Rotating deliberately requires an
   account whose access token is inside the five-minute window, or a dedicated
   test credential; that remains the one unobserved P4 branch.

## 12. Implementation record (branch `codex/openai-codex-auth-native-catalog`)

Implemented modules:

- Credentials — `src/credentials/external-auth.ts` (Codex ChatGPT payload
  parser, claim-intersection contract, five-minute/eight-day freshness trigger,
  content-hash `tokenRevision`), `src/credentials/codex-app-server-refresh.ts`
  (bounded one-shot app-server handshake, shared single-flight keyed by
  canonical path, waiter cancellation that never aborts the shared run),
  `src/credentials/external-credential-source.ts` (identity capture → freshness
  → request-local secret, verification by re-read), and the external binding
  variant of `ProviderAuthBindingFacts` in
  `src/credentials/profile-contract.ts`.
- Internal storage — `src/credentials/profile-record-store.ts` schema v2:
  only `openai-codex` uses AuthDotJson incarnation documents at
  `<pi directory>/credentials/openai-codex/<credentialId>/<credentialGeneration>.auth.json`
  with the record reference switch as the commit point, referenced-path-only
  recovery, per-credential-lock-confined orphan collection, and a consistent
  sensitive-backup snapshot. Other Providers retain opaque inline credentials.
  The one record schema discriminates `kind: inline | incarnation` and rejects
  both/neither carriers and Provider/carrier scope mismatches. There is no
  migration or dual-format reader.
- Model overlay — `src/integrations/codex/codex-model-candidates.ts`,
  `src/providers/automatic-model-overlay.ts`, and the runtime/publication
  wiring in `src/providers/runtime.ts` and `src/application.ts`. One native
  acquisition generation feeds both the served catalog (startup user config)
  and the models.json edit preview (current-disk config).
- Usage — `external` binding context in `src/provider-usage/contract.ts`, the
  account+revision cache/in-flight identity in `src/provider-usage/authority.ts`,
  the claim-intersection account check in
  `src/provider-usage/probes/openai-codex.ts`, and the product chain
  (Public Model availability, Operational Attention, Renderer gating).

Clarifications recorded while implementing:

1. **External-versus-managed precedence.** A managed `openai-codex` record with
   at least one Profile stays authoritative. The external source is captured
   only when the record is absent or has zero Profiles, and a non-`ok` external
   read fails closed with `external_unavailable` rather than degrading to an
   ambient binding.
2. **Conservative compat set.** "The four optional capability flags" is read as
   every optional capability flag in the pinned OpenAI Responses compat schema:
   `supportsStrictMode`, `supportsDeveloperRole`, `supportsLongCacheRetention`,
   `supportsAdditionalTools`, `supportsToolSearch`, and
   `supportsOpenAIGrammarTools`, all `false`.
3. **Same-generation sibling rule.** Two Pi model ids share a generation when
   the id with its trailing `-<variant>` segment removed is equal
   (`gpt-6.1-sol` → `gpt-6.1`). A sibling is used only when it defines
   `compat`; otherwise the conservative default applies. No cross-generation
   fallback exists.
4. **Publication revision guard.** For an external capture the usage
   publication guard compares the current document revision with the revision
   the bound operation actually resolved (not the capture-time revision), so
   an allowed in-place refresh does not block its own publication while a late
   result from a superseded revision is still rejected.
5. **Buffered response shape without a content type (found by the P4 online
   run).** The Codex Responses backend answers a successful request with
   `200` and a buffered SSE body **without** any `content-type` header. The
   Provider Native Responses boundary previously gated both the SSE lifecycle
   normalization and the model-alias projection on that header, so the alias
   projection took the JSON path, failed, and returned
   `502 Upstream response could not be projected safely` for every
   `openai-codex` request. One authoritative decision now lives in
   `nativeResponsesWireShape(body, contentType)` in
   `src/protocols/openai-responses/native-response.ts`: an explicit content
   type wins; otherwise the first non-whitespace bytes decide (`event:` /
   `data:` / `id:` / `retry:` / `:` → SSE, everything else → JSON, with a
   leading UTF-8 BOM skipped). The scan is bounded to the head of the buffered
   body and never parses or rewrites content.

P4 online evidence (2026-10-01, `codex-cli 0.159.2`, local Codex login at
`%USERPROFILE%\.codex`):

| Observation | Result |
| --- | --- |
| Credential source | `connected`; the document was read, never written |
| `auth.json` after the run | byte-identical (same length, mtime, SHA-256) |
| Native listable models | 8 |
| Pi-missing native models appended | `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna` |
| Served `openai-codex` model count | 9 (6 Pi bundled + 3 appended) |
| Responses → Provider Native for `gpt-6.1-sol` | HTTP 200, `response.completed` |
| Anthropic Messages → Semantic Conversion for `gpt-6.1-sol` | HTTP 200, completed message |
| Usage (WHAM) through the external binding | `succeeded` |
| Delegated rotation | `not_required` (access token valid until 2026-10-08) |
| Delegation mechanics (real `codex app-server`, temp home, synthetic tokens) | handshake completed; outcome `verification_failed:revision_unchanged`, i.e. RPC success alone was rejected by the re-read verification; the user's home was not written |
| Credential after a lane probe | still usable and non-terminal |

A lane probe that fails with a transport/5xx error fails the suite; a 4xx is
recorded as a rejection and the run additionally proves the credential stayed
usable and its usage state stayed non-terminal (acceptance 31). The document
was byte-identical after both online runs (length 4157, unchanged mtime,
SHA-256 `C485F8041760B38FFAC753AF45A95C51FAA98DE0EC731360314D894CEB5E3CEB`).

The run also recorded that the Codex backend rejects `max_output_tokens`
(`Unsupported parameter: max_output_tokens`), which Pi's adapter never sends;
the online probes therefore use the Codex client body shape.

Online procedure:

- Local login (this machine): `npm run test:online-openai-codex:local`.
- Dedicated test login / CI: `TOKEN_CODEX_TEST_AUTH_HOME=<home>` with
  `npm run test:online-openai-codex` (guarded). The suite records
  `{"result":"skip", ...}` when no ChatGPT login is present and never mocks a
  login or copies the document into the repository.

P4 status:

- The local-login path was explicitly authorized for the historical online
  run above. The guarded command uses a temporary `CODEX_HOME` and skips when
  no dedicated login is available; no command copies `auth.json`.
- The repaired smoke gate requires usage `succeeded`, HTTP 200 with protocol
  completion from both lanes, and a still-usable, non-terminal binding.
  Structured entitlement rejection is `incomplete`, never whole-run `pass`;
  other failures and a failed required delegation fail the gate.
- `rotation: not_required` is recorded with `rotationCoverage: uncovered`.
  Smoke success does not certify actual rotation. A successful delegated
  rotation has not yet been observed in this environment.

## 13. Implementation review repair (2026-10-01)

| Finding | Repair and falsifiable regression evidence |
| --- | --- |
| S1 write-path escape | Validate canonical ancestors and reject junctions/symlinks before staging and rename; `provider-credential-incarnation-commit.test.ts` proves no secret is written outside the owned root. |
| S2 stale tokenRevision | Reconcile only the still-referenced path under credential → record locks, including backup collection; commit and backup fault-injection tests require matching record/content hashes without a management revision change. |
| P1 carrier/scope | Codex-only AuthDotJson codec and incarnation layout; other Providers inline; `provider-credential-storage-scope.test.ts` requires roundtrip and rejects XOR/scope violations. |
| P2 double acquisition | One explicitly acquired immutable snapshot scopes both consumers, including zero TTL; the real integration/runtime test checks injection rows, served additions, target validator runtime, and Direct ids. |
| P3 preview cache | Acquisition generation joins the preview cache key without changing the disk revision; `models-preview-generation.test.ts` checks unchanged bytes with new facts. |
| P4 override-only id | Only full model definitions suppress additions; override keys still apply to appended rows. `automatic-model-overlay.test.ts` requires the candidate to remain present. |
| P5 late unavailable publication | Failure publication uses the same binding guard as success; external usage tests reject delayed failures after account or token-revision changes. |
| P6 terminal evidence | Bare 401/403 stays temporary; only bounded structured known terminal codes stop retries. Probe tests distinguish entitlement, plain denial, and terminal evidence using `reference/opencodex`. |
| P7 other Provider reset | Refresh recomposes only `openai-codex`; runtime regression preserves Radius dynamic models. |
| P8 permissive online gate | Positive completion/status/usage assertions and explicit incomplete/rotation coverage; `openai-codex-online-gate.test.ts` rejects false-pass cases. |
| P9 runtime ordering | Explicit overrides first; otherwise resolved numeric CLI versions descending, mtime as tie/fallback; catalog-source tests select newer PATH over older Desktop. |
| P10 dropped warnings | Bounded diagnostics publication at startup/refresh, once per generation/warning batch, with observer failures contained; runtime test observes the conservative-template warning. |

This repair does not replace the historical online evidence or claim a newly
observed rotation. Repository-wide validation results are reported separately.
The user's compaction change is included: its helper and SSE framing live at
neutral `src/responses-compaction.ts` / `src/responses-sse.ts` boundaries,
without dependencies on lane execution or response-conversion owners. The
isolation certification checks both helper closures and prohibits Direct Mode
from reaching them.

Validation after repair (2026-10-01):

- `npm run typecheck` and `npm run lint` passed.
- Guarded `npm test` passed all 75 certification tests, 310 Vitest files /
  2843 cases, and 23 Desktop files / 152 cases.
- At the user's explicit request, `test:online-openai-codex:local` passed
  against the local login: usage `succeeded`; `gpt-6.1-sol` Native Responses
  and Semantic Messages both HTTP 200 / completed; 8 native-listable rows,
  3 Pi-missing rows, 9 served models; binding remained usable/non-terminal.
- The local auth document's SHA-256, length (4157), and mtime were unchanged
  before and after both real runs. No credential was copied or relocated.
- Rotation was `not_required` / `uncovered`. The synthetic temporary-home
  delegation completed its handshake and correctly failed verification on an
  unchanged revision; this is not successful real-rotation certification.
- The real run exposed the adapter's retained WebSocket session: the suite
  now calls Pi's public `closeOpenAICodexWebSocketSessions()` during teardown.
  The repeated real run exited with code 0 after cleanup.
