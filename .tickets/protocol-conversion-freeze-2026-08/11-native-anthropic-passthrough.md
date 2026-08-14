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

## Re-verification note (2026-08-13)

Re-verified every acceptance criterion against code and tests after the
ticket was marked completed. The completed status was confirmed with one
substantive gap fixed:

- Pre-commit upstream body-read failure previously fell through to a generic
  500 with an empty body instead of a legal Anthropic error. Fixed:
  `passthroughAnthropicRequest` wraps the body read in a Responses-style
  pre-commit marker (`AnthropicPassthroughBodyReadError`) and the handler's
  passthrough branch renders 502 `api_error`; caller cancellation keeps its
  own identity.
- Added certification tests for: byte-for-byte SSE fidelity, pre-commit
  body-read failure, `x-stainless-*` approved request headers, one bounded
  failure journal on a final upstream failure, and HTTP-boundary cancellation
  that aborts upstream work without writing a closed response.

## Second re-verification note (2026-08-13)

Second full re-verification of every acceptance criterion found and fixed
two remaining transport-semantics gaps:

- **Base-path prefix was dropped.** `new URL("/v1/messages", model.baseUrl)`
  is an absolute-path replacement: a configured base path such as
  `https://host/prefix` silently became `https://host/v1/messages`, losing
  the prefix. The Anthropic SDK resolves `baseURL + path` by concatenation,
  so this diverged from the SDK's endpoint semantics (architecture §1.2:
  "URL construction preserves the configured base path unless the upstream
  contract explicitly defines an absolute endpoint"). Fixed with an
  Anthropic-owned `joinEndpoint` that preserves the prefix.
- **Qualified Lucky selectors leaked upstream.** The client selector
  (`provider/model_id`, e.g. `my-anthropic/claude-sonnet`) was forwarded
  verbatim in the body; the upstream wire addresses models by their bare
  model id and cannot resolve a Lucky selector. Acceptance criterion: "no
  qualified Lucky selector leaks unless intentionally supported" — nothing
  documented or tested that as intentional. Fixed with an Anthropic-owned
  `rewriteModelSelector` that replaces the body `model` field with the
  registered `model.id` (byte-identical when the selector already equals the
  model id). Tests: base-path preservation, selector rewrite, byte-identity
  when unchanged.

No Responses passthrough classifier/config/test/helper is imported.
