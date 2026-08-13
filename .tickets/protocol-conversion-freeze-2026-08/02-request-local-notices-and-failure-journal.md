# 02 — Add request-local notices and per-failure journals

**What to build:** Every invocation can collect safe conversion notices and, when it finally fails, writes exactly one useful JSON failure journal without leaking prompts, credentials, files, or another request's state.

**Blocked by:** 01 — Establish adapter-owned configuration seams.

**Status:** completed

## Module seam

Define one protocol-neutral invocation diagnostics interface created at request ingress. Callers submit bounded structured notices/facts and finalize success or failure. The module hides ID generation, redaction, limits, retention, atomic filesystem writes, and stderr fallback.

Protocol adapters construct their own notice codes and JSON paths. The journal module never interprets protocol policy. No adapter reads facts submitted by another adapter.

## Information lifecycle

The internal request ID and collector are created after HTTP request acceptance and destroyed after finalization. Success destroys journal payload state without writing a failure file. Failure writes one file after bounded redaction. Retries append summaries to the same invocation.

## Acceptance criteria

- [x] Approved xrepair, configurable ignore, hard-control degradation, missing Anthropic signature, and `store:false=persist` can emit request-local structured notices without entering Pi Context or client output.
- [x] A final failed request creates one JSON file named only by an internally generated safe ID; a successful request creates none.
- [x] Safe mode records classification, stage, selector, status, notice paths/actions, attempts, safe IDs, hashes/counts/lengths, truncation, and a redacted exception chain.
- [x] Safe mode excludes credentials, auth/cookie headers, prompt/message/tool-output text, raw bodies, image/file bytes, and caller-controlled file-name material.
- [x] Full mode still permanently excludes credentials, cookies, and binary file/image data and emits a startup warning.
- [x] Size, count, retention, and cancellation logging policies are enforced from immutable configuration.
- [x] Writes use same-directory temporary files and atomic rename with restrictive permissions where supported.
- [x] Journal write failure reports through stderr/telemetry and preserves the original protocol response/error.
- [x] Concurrent and sequential request tests prove no notice, request ID, retry, or payload fact crosses invocations.
- [x] Tests exercise the public invocation diagnostics interface, not internal buffers.

## Out of scope

Provider failure classification and Client error envelopes.
