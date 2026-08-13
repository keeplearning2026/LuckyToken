# 11 — Certify and harden native Anthropic passthrough

**What to build:** A protocol-compatible Anthropic upstream can be used in native passthrough mode with full native semantics and safe transport behaviour, independently of Anthropic↔Pi conversion.

**Blocked by:** 01 — adapter-owned configuration; 02 — request-local notices/journal.

**Status:** completed

## Module seam

Define an Anthropic-local passthrough compatibility interface with production and test adapters. Selection occurs before conversion. It exposes only compatibility and one request execution operation; path/header/body/SSE complexity stays behind it.

Do not generalize this into a cross-Client passthrough module. Protocol-neutral low-level HTTP primitives may be reused, but the classifier, header policy, and conformance tests remain Anthropic-owned.

## Information lifecycle

Inbound raw body and approved headers flow directly to the compatible upstream and are destroyed after delivery. Client credentials never become upstream credentials. Response bytes/headers are bounded/filtered only as transport safety requires, not converted into Pi.

## Acceptance criteria

- [x] Passthrough selection uses declared Anthropic wire compatibility, not scattered concrete Provider-name checks.
- [x] Configured base path and endpoint semantics are explicit and tested.
- [x] Model selector/body rewrite policy is explicit; no qualified Lucky selector leaks unless intentionally supported.
- [x] Anthropic version/beta and approved end-to-end headers follow documented rules.
- [x] Hop-by-hop, cookie, auth, stale content-length/encoding, and unsafe headers never cross.
- [x] Status/body/SSE are preserved for normal native responses.
- [x] Pre-commit body/read failure produces legal Anthropic error; post-commit failure uses native SSE lifecycle.
- [x] Cancellation aborts upstream work and writes no closed response.
- [x] Conversion and passthrough tests/metrics identify profile separately.
- [x] Final failure writes one bounded safe journal.
- [x] No Responses passthrough classifier/config/test/helper is imported.

## Out of scope

Anthropic↔Pi conversion and Responses native passthrough.
