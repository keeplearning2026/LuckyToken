# 19 — Implement and certify native Responses passthrough

**What to build:** A protocol-compatible Responses upstream can be used without Pi conversion, preserving native handles, hosted tools, background jobs, store semantics, and future wire fields under safe transport rules.

**Blocked by:** 01 — adapter-owned configuration; 02 — request-local notices/journal.

**Status:** completed

## Module seam

Define a Responses-local passthrough compatibility interface with production and test adapters. Selection precedes conversion and exposes a small execute operation. Compatibility, endpoint, authorization, SSE, and header policy remain Responses-owned.

Do not reuse or generalize the Anthropic passthrough classifier/config/renderer. Only protocol-neutral low-level HTTP/cancellation/logging primitives may be shared.

## Information lifecycle

Opaque native handles remain inside same-authority wire traffic and never enter Pi/session conversion state. Inbound Client credentials remain isolated from upstream authority. Raw body/header state ends after native delivery.

## Acceptance criteria

- [x] Selection uses declared Responses wire compatibility, not concrete Provider-name branches.
- [x] Native conversation/prompt/item references, file IDs, compaction/encrypted state, hosted tools, background, store, and future fields pass without conversion loss.
- [x] Endpoint/base-path, model selector rewrite, and upstream auth authority are explicit/tested.
- [x] Status/body and completed/incomplete/failed SSE are preserved.
- [x] Hop-by-hop, cookie/auth, stale length/encoding, and unsafe headers never cross.
- [x] Cancellation and pre/post commit body failure follow Responses native lifecycle.
- [x] Conversion/passthrough tests and metrics identify profile independently.
- [x] Final failure writes one bounded safe journal.
- [x] Architecture tests prove no Anthropic passthrough module/config/test import.
- [x] Passthrough success is never counted as Responses↔Pi coverage.

## Out of scope

Responses conversion and Anthropic passthrough.

## Re-verification note (2026-08-13)

Full re-verification of every acceptance criterion after the ticket was
marked completed. Two transport-semantics gaps were found and fixed, and one
architecture-test gap was closed:

- **Base-path prefix was dropped.** `new URL("/v1/responses", model.baseUrl)`
  replaced the configured path absolutely; a base URL such as
  `https://host/prefix` silently lost `/prefix`. Fixed with a
  Responses-owned `joinEndpoint` that preserves the prefix (architecture
  §1.2.7).
- **Qualified Lucky selectors leaked upstream.** The client selector
  (`my-responses/gpt-5`) was forwarded verbatim; the upstream wire addresses
  models by bare model id. Fixed with a Responses-owned
  `rewriteModelSelector` replacing the body `model` field with the registered
  `model.id` (byte-identical when unchanged). Tests: base-path preservation,
  selector rewrite, byte-identity when unchanged, and the future-field /
  native-handle verbatim test now asserts the rewritten selector.
- **Architecture test now proves config/renderer isolation.** The existing
  architecture test checked only `passthrough.ts`/`handler.ts`/contract test
  imports; it now also verifies `configuration.ts`, `sse.ts`, and
  `error-rendering.ts` import no Anthropic passthrough module (acceptance
  criterion "Architecture tests prove no Anthropic passthrough
  module/config/test import").

Passthrough success is never counted as Responses↔Pi conversion coverage:
the conformance record's scope describes only the conversion route, and no
conversion test imports passthrough behavior.

