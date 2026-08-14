# 18 — Render Responses atomic SSE and protocol errors

**What to build:** Responses clients receive schema-correct atomic SSE with completed/incomplete/failed terminals and safe non-streaming errors derived solely from neutral failure facts.

**Blocked by:** 02 — notices/journal; 03 — neutral failure contract; 17 — complete Response object.

**Status:** completed

## Module seam

JSON/SSE and error rendering are private adapters over one complete Response object or one neutral failure fact. They do not reach back into Pi/Provider or session internals.

## Information lifecycle

Sequence numbers and event objects are request-local. Safe headers/request IDs are consumed once. Final facts/notices flow to the failure journal and are destroyed.

## Acceptance criteria

- [x] Atomic SSE emits response.created, ordered output_item.done events, the status-matching terminal, then [DONE].
- [x] Every schema event has a monotonically increasing sequence_number.
- [x] completed has error/incomplete_details null; incomplete has legal details/error null; failed has non-null error.
- [x] Execution failure before first SSE byte returns non-2xx Responses JSON and does not fabricate response.failed.
- [x] A formed failed Response or future post-commit failure emits response.failed, not incomplete/completed.
- [x] Non-streaming error preserves distinct message/type/code/param fields.
- [x] Validated upstream status and safe x-request-id/retry/rate-limit headers are preserved; unsafe headers/body text are bounded/redacted.
- [x] No Provider code is moved into Responses type and no string is reparsed for status.
- [x] Final failure writes one Responses-local journal record through the generic sink.
- [x] Tests cover every terminal, sequence monotonicity, pre/post commit failures, cancellation, code/type distinction, header safety, and JSON/SSE semantics.
- [x] No Anthropic or concrete Provider renderer/import is reused.

## Out of scope

Legacy observer removal (27) and live per-delta streaming.

