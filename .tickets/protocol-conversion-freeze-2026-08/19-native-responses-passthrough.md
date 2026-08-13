# 19 — Implement and certify native Responses passthrough

**What to build:** A protocol-compatible Responses upstream can be used without Pi conversion, preserving native handles, hosted tools, background jobs, store semantics, and future wire fields under safe transport rules.

**Blocked by:** 01 — adapter-owned configuration; 02 — request-local notices/journal.

**Status:** ready-for-agent

## Module seam

Define a Responses-local passthrough compatibility interface with production and test adapters. Selection precedes conversion and exposes a small execute operation. Compatibility, endpoint, authorization, SSE, and header policy remain Responses-owned.

Do not reuse or generalize the Anthropic passthrough classifier/config/renderer. Only protocol-neutral low-level HTTP/cancellation/logging primitives may be shared.

## Information lifecycle

Opaque native handles remain inside same-authority wire traffic and never enter Pi/session conversion state. Inbound Client credentials remain isolated from upstream authority. Raw body/header state ends after native delivery.

## Acceptance criteria

- [ ] Selection uses declared Responses wire compatibility, not concrete Provider-name branches.
- [ ] Native conversation/prompt/item references, file IDs, compaction/encrypted state, hosted tools, background, store, and future fields pass without conversion loss.
- [ ] Endpoint/base-path, model selector rewrite, and upstream auth authority are explicit/tested.
- [ ] Status/body and completed/incomplete/failed SSE are preserved.
- [ ] Hop-by-hop, cookie/auth, stale length/encoding, and unsafe headers never cross.
- [ ] Cancellation and pre/post commit body failure follow Responses native lifecycle.
- [ ] Conversion/passthrough tests and metrics identify profile independently.
- [ ] Final failure writes one bounded safe journal.
- [ ] Architecture tests prove no Anthropic passthrough module/config/test import.
- [ ] Passthrough success is never counted as Responses↔Pi coverage.

## Out of scope

Responses conversion and Anthropic passthrough.

