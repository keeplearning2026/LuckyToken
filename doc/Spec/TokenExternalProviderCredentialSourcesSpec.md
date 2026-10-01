# External Provider Credential File Sources

Status: implemented current contract. Related: [Provider Credential Profiles](TokenProviderCredentialProfilesPRD.md), [Codex Provider Plan](TokenOpenAICodexProviderPlan.md).

Token can bind an explicitly supplied, externally owned credential file to any Provider. Codex is one adapter. The shared lifecycle does not recognize Codex paths, JSON branches, JWT claims, accounts or app-server RPCs.

## Evidence and extraction

Before this change, `external-credential-source.ts` imported the Codex reader, validity helpers and app-server refresher. `profile-authority.ts` selected that source only for `openai-codex`, reconstructed OAuth credentials from Codex fields and hard-coded its labels. Usage similarly assumed external OAuth and ChatGPT account identity.

The Codex parser now lives in `codex-auth.ts`. The old Codex-only file reader, snapshot type and freshness helpers were removed after their production consumers moved to the shared source. Tests exercise the actual resolver, including the exact five-minute boundary and unknown expiry; recent `last_refresh` alone cannot prove live OAuth. This preserves the old production source's fail-closed behavior, while removing standalone advisory rules that did not govern dispatch.

Pi 0.87.0's public `dist/auth/types.d.ts` defines `Credential` as `ApiKeyCredential | OAuthCredential`; Provider API-key resolution owns the meaning of `key` and `env`. Its `dist/auth/resolve.js` calls the credential writer inside the five-minute OAuth refresh window. Neither contract requires external files to use Codex's representation.

The repository reference `reference/opencodex/src/codex/auth-collision.ts` distinguishes missing, invalid and unreadable input to avoid treating a partial write as logout. `reference/opencodex/src/adapters/devin/cloud-direct/auth.ts` demonstrates different Provider auth lifetimes and refresh transport. These support retaining read states while keeping format, identity and refresh policy in adapters. Token does not adopt their account pools or compatibility readers.

## Shared boundary

`ExternalCredentialSource` supplies a static authentication branch and bounded display labels, plus two operations:

- `read()` reads local state only and returns `ok | missing | invalid | unreadable`. Success contains canonical path, non-secret `identityKey` and raw-file SHA-256 `tokenRevision`. It exposes no credential and performs no delegation or network request.
- `resolve()` returns a request-local public Pi `Credential`, or a structured unavailable result. Token never copies the source file into its storage, writes it through Pi, moves it, removes it or backs it up.

`createExternalCredentialSource()` owns bounded regular-file reads (maximum 1 MiB), canonical resolution, content hashing, bounded retries for invalid/unreadable reads, and freshness verification. An adapter supplies a decoder, fixed labels and auth branch, an optional stronger usability constraint, and optional owner-native in-place refresh.

The decoder owns the file grammar, identity evidence and translation into Pi `Credential`. It returns static bounded failure descriptions; raw parser exceptions are contained. It must not return a secret as identity or presentation metadata. The shared layer rejects mismatched credential/auth branches. An API-key credential has no imposed expiry; OAuth must exceed Pi's five-minute window, plus any stricter adapter constraint. Missing expiry cannot be treated as live OAuth.

Freshness is single-flight per source instance and canonical path, covering reread, delegation and verification. Composition supplies one source instance per Provider to all binding consumers. A late waiter rechecks the file before delegation. Cancellation detaches the waiter without canceling shared work. Delegates must bound their own process/network lifetime. A successful delegate is accepted only after rereading the original configured location and proving unchanged canonical path and identity, changed content revision and sufficient validity. Exceptions and failed verification fail closed; no error text implies terminal authentication.

The generic `createKeyedSingleFlight()` also supplies the Codex app-server delegate's existing one-shot RPC coalescing. That delegate remains usable independently by the Codex probe; file-source coalescing additionally covers the full verification lifecycle.

## Adapters and composition

- `codex-external-credential-source.ts` owns ChatGPT-only parsing, the nested account-claim intersection, the Codex display labels and the app-server refresh delegate. Codex `accountId` becomes the private generic `identityKey`. Its owned file remains at the original Codex home.
- `api-key-file-source.ts` reads a single non-empty plaintext key, trimming surrounding whitespace and rejecting embedded newlines or NUL. It supplies `{ type: "api_key", key }` and uses a key hash as grant identity. With no account evidence, a different key is a different grant; an old capture cannot consume it. Whitespace changes revision without changing identity. It has no refresh delegate.
- Another login JSON format supplies its own decoder to the same factory. A cloud-profile credential may supply Pi's API-key branch with Provider-owned `env`; the plaintext adapter does not interpret such documents.

`CreateProviderRuntimeOptions.externalCredentialSources` is an explicit Provider-id-to-source composition input. Runtime supplies the Codex adapter by default. `createProviderCredentialProfiles({ externalSources })` accepts the same contract. There is no global source registry, discovery, config migration or automatic import into managed Profiles. Other adapters are not automatically enabled merely because some file exists.

For a plaintext file, composition can supply:

```ts
externalCredentialSources: {
  "another-provider": createApiKeyFileSource({
    path: providerOwnedKeyPath,
    authMethodLabel: "Another Provider API key",
    displayName: "Local key file",
  }),
}
```

For a login document, use `createExternalCredentialSource({ path, authType: "oauth", decode, refresh, authMethodLabel, displayName })`. The decoder returns `{ state: "ok", document: { identityKey, credential } }` or `{ state: "invalid", reason }`; `refresh` returns `completed` or a bounded `unavailable` outcome after the source owner finishes its in-place operation.

## Binding, ownership and lanes

Managed Profiles always win. With any managed Profile present, invalid active selection fails closed without external fallback. With no managed Profiles, an explicitly supplied file source wins over ambient auth, including when the file is unavailable. Without such a source, the existing ambient contract applies.

Capture contains only source facts. Resolution must match captured canonical path, identity and auth branch. Publication must also match the revision actually resolved by that request, while no managed Profile has taken authority. `publishIfCurrent` supplies the lease assertion and immutable publication facts, including that resolved revision. Both successful observations and failures use those facts; a terminal refusal after refresh must be recorded against the refreshed revision, otherwise the next capture incorrectly resumes network attempts. Usage cache/in-flight identities contain Provider, auth branch, path, identity and revision; source identity without revision owns terminal recovery tracking. Neither path nor identity reaches Renderer.

Pi's external `modify()` path always rejects before executing its callback. The owner delegate is the sole external refresh writer. Managed non-Codex inline payloads, Codex managed incarnation layout and internal refresh remain unchanged.

The boundary lives in credential infrastructure. Provider Native and Semantic Conversion consume their existing Pi Model/auth or binding interfaces; they do not share request, response or semantic execution. Direct Mode does not use the credential authority. Native catalog acquisition and model overlays remain Codex integration responsibilities and are not credential-file concerns.

## Verification

`test/integration/external-provider-credentials.test.ts` exercises a plaintext key through actual Runtime, Pi auth and usage; an unrelated JSON login through real Pi auth; managed precedence; read states and size/type constraints; revision/grant changes; post-refresh path, identity, revision and validity checks; cancellation and coalescing; and exception secrecy. Existing Codex claim, app-server, file-source and real Pi resolver suites retain their behavior. Usage tests reject late failures after path changes even when account and content revision match.

Offline fixtures are synthetic in newly created temporary homes, with cleanup in `finally`. Runtime receives the temporary `codexHome` explicitly; repository guarded commands provide temporary `CODEX_HOME` to test processes. No real auth file is read or copied for offline verification. These tests certify composition and local lifecycle; they do not certify a new Provider's upstream refresh protocol or live entitlement.

With explicit user authorization, `test/online/run-openai-codex-provider.ts` supplies one Codex adapter through the generic Runtime source input to usage and both serving lanes. The authorized login file remains in place; model-discovery subprocesses, Runtime state and synthetic app-server probes use temporary homes. Only the real login's owner-native freshness delegate is configured against its original home, and only when freshness requires it. The suite asserts metadata-only reads and stable canonical identity, records actual source resolutions, hashes and file metadata, requires successful usage and completed HTTP 200 in both lanes, and leaves an untriggered rotation branch explicitly uncovered. Missing login records `skip`.
