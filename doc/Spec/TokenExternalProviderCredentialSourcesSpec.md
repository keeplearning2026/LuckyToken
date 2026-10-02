# External Provider Credential References

Status: implemented current contract, 2026-10-02. Authoritative model:
[Provider Credential Core Model](TokenProviderCredentialCoreModelPlan.md).
Related: [Provider Credential Profiles](TokenProviderCredentialProfilesPRD.md),
[Codex Provider Plan](TokenOpenAICodexProviderPlan.md).

## Contract

Every Profile references exactly one credential document:

```text
reference = { path, owner: "managed" | "external", revision? }
```

- `managed`: Token owns the document. The path is POSIX-style and relative to
  the credential root (`<pi directory>/credentials`). Token writes and rotates
  it with tmp+rename+fsync, commits the content revision with the record, and
  collects unreferenced documents under the existing grace rule.
- `external`: the source owner owns the document. The path is absolute. Token
  only reads it; it is never written, rotated, copied, backed up, moved,
  deleted or refreshed in place by Token, and it is never an orphan-collection
  candidate.

`revision` is the SHA-256 content hash observed at the last successful
publication or read. A changed external document is the owner's legitimate
update, not a stale binding: the next read resolves the new content.

## Unified reader

`read(profileRef) -> Credential` is provider-format-driven, never
kind-driven:

- Codex OAuth documents use the existing ChatGPT parser
  (`parseCodexInternalAuth`); non-ChatGPT modes are unsupported and never
  coerced.
- Other OAuth documents are the public Pi OAuth JSON shape.
- API-key documents are single-line text (trimmed, empty/CR/LF/NUL rejected)
  or the JSON shape when the credential carries provider-scoped `env`.

Resolution states are `ok | missing | invalid | unreadable`. A Profile whose
reference cannot be resolved is unavailable: it projects as
`reconnect_required`, fails closed in authentication, usage, Public Models and
attention, never falls back to ambient or another Profile, and cannot become
an automatic 429 candidate.

## Freshness

Token never refreshes an externally owned document. An external OAuth
document inside Pi's five-minute minimum-validity window
(`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`) is reported as unavailable rather than
used. Managed OAuth documents are refreshed by Pi's normal locked
`CredentialStore.modify` path, so Token does not gate them.

Pi's `CredentialStore` boundary:

- `read` resolves the selected Profile's reference and returns the parsed
  `Credential`; missing/unreadable/invalid references throw a typed error and
  never resolve `undefined`.
- `modify` runs Pi's callback for managed documents and persists the rotated
  document with a new revision. For external documents the callback is not
  executed; the owner's current document is returned, so Pi's refresh cannot
  write the file. It never returns `undefined` for an existing external
  Profile.
- `delete` is not used for Profile removal. Removal deletes the Profile
  reference and only collects managed documents; external files are untouched.

## Local Codex login

Local Codex login is the first `local_oauth` acquisition strategy. It reads
`<CODEX_HOME>/auth.json` once per acquisition inside the Provider lock and
records an external reference. Missing, unreadable, empty, invalid,
unsupported-mode or non-ChatGPT input fails the login and creates no Profile;
an existing local Profile blocks a second local login until it is
reconnected or removed. Reconnect keeps the Profile identity and replaces its
generation and reference; a failed reconnect leaves the existing reference
(and therefore its `reconnect_required` health) untouched.
