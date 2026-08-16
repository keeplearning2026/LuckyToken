# 19 — Complete Requests page and request-detail contract

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Give users a real-time and historical Requests page with complete, stable request details. The backend preserves separate phase, outcome, clientHttpStatus, and piStopReason facts; the UI derives a primary Status while retaining all raw structured facts and the request-time model/auth snapshots.

**Blocked by:** 18 — Request Lifecycle Ledger tracer.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm Request Ledger list/detail queries and typed updates as seams. Prove behavior with known request scenarios and deterministic timestamps; do not test UI table implementation or storage queries directly.

## Acceptance criteria

- [x] The request list can show request ID, Client Protocol, external alias, actual Provider/model, primary Status, input/output/cache tokens, Cache Hit, accepted/completed times, and average output speed.
- [x] projectDir and clientSessionId show their actual client-scope value or `-`; effectiveSessionId remains a separately labeled internal detail.
- [x] Request detail preserves separate phase, outcome, clientHttpStatus, and piStopReason, and UI status derivation is deterministic and documented.
- [x] Average output speed is output tokens divided by terminalAt minus executionStartedAt; invalid/zero durations produce unavailable rather than an invented rate.
- [x] The record preserves conversion warnings/notices, attempt summaries, persistence warnings, and usage completeness without leaking credentials.
- [x] Request-time externalAlias, Provider ID, and real model ID snapshots never change when the current catalog or alias registry changes.
- [x] Users can page and filter permanent records by time range, Provider, real model, Client Protocol, project directory, and outcome.
- [x] Live list/detail updates remain ordered with snapshot re-sync after disconnect and do not require polling private stores.
