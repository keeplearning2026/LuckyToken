# 23 — Certify CommandCode request authority and payload hooks

**What to build:** A complete Pi invocation becomes one closed-world, authority-safe CommandCode HTTP request; optional payload replacement is fully recertified before any retry or network call.

**Blocked by:** 20 — scalar options; 21 — messages/results; 22 — tools/constraints.

**Status:** completed

## Module seam

The CommandCode request module exposes one prepare operation returning an immutable logical request consumed by attempts. It hides endpoint construction, headers, config/project derivation, body assembly, serialization, hook invocation, and recertification.

## Information lifecycle

Project/config facts are resolved once per logical request. Hook candidate/replacement exists only until JSON round-trip recertification. Certified body is frozen across retries; attempt-owned trace/span/timeout headers are added later.

## Acceptance criteria

- [x] Endpoint uses absolute root path `/alpha/generate`, replacing any base path and discarding query/fragment; path-prefixed bases are tested.
- [x] Provider-authoritative auth/content/session/project/permission/trace headers cannot be overridden by generic headers.
- [x] Valid non-reserved string headers pass; null removes generic values; invalid types error.
- [x] absent/empty/non-string projectDir omits slug; non-empty values follow documented normalization/root fallback only.
- [x] Body is a closed-world GenerateRequest containing only certified fields.
- [x] onPayload runs once before retries and may mutate/replace the candidate.
- [x] Replacement is JSON serialized/parsed and all schema, required fields, authority, model, session/project, lifecycle, and tool invariants are revalidated before fetch.
- [x] Hook failure/replacement failure yields typed neutral conversion/callback failure and zero fetches.
- [x] Retries reuse identical certified logical body/config while refreshing only attempt-owned facts.
- [x] Tests cover base paths, reserved headers, project cases, hook mutation/replacement/injection, JSON loss, zero-fetch failure, and retry body equality.
- [x] Interface/test code contains no Client Protocol terms.

## Out of scope

Actual attempt failure classification (26) and response reconstruction (24).
