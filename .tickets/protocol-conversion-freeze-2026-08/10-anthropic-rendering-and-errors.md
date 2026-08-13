# 10 — Render Anthropic JSON, atomic SSE, and protocol errors

**What to build:** Anthropic clients receive semantically identical JSON or contract-correct atomic SSE, and every failure is rendered from protocol-neutral facts using a legal, safe Anthropic error envelope.

**Blocked by:** 02 — notices/journal; 03 — neutral failure contract; 09 — Pi-to-Anthropic projection.

**Status:** completed

## Module seam

JSON and SSE are two private adapters over the same converted Anthropic message. Error rendering accepts only Client input failures or neutral runtime failure facts. It never reads a Provider-specific observer/string.

## Information lifecycle

The converted message is immutable and lives until rendering finishes. SSE event indices/usage snapshots are request-local. Safe request IDs/headers are consumed once. Final failure facts go to the journal and are destroyed.

## Acceptance criteria

- [x] JSON renderer emits the complete selected Anthropic profile envelope.
- [x] Atomic SSE order is message_start → ordered block lifecycles → message_delta → message_stop.
- [x] message_start output_tokens is zero and contains only target-defined initial input/cache usage.
- [x] message_delta carries final stop reason and final cumulative usage exactly once.
- [x] Text, thinking, redacted thinking, and tool_use block events preserve JSON semantics.
- [x] A failure before first SSE byte returns non-streaming Anthropic error JSON; after commit uses Anthropic SSE error lifecycle.
- [x] Error envelope includes legal type/message/request_id and only fixed safe request/retry/rate headers.
- [x] Upstream provider type/code never becomes unchecked Anthropic error type; body-derived text is bounded/redacted.
- [x] Final failure writes one journal with Anthropic-local stage/notice facts.
- [x] JSON/SSE equality, incomplete/error, cancellation, header safety, and body-cap tests pass.
- [x] Renderer imports no Responses or CommandCode vocabulary.

## Out of scope

Legacy observer removal (27) and native passthrough (11).
