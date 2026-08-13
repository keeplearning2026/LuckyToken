# 26 — Move CommandCode failures and retries onto the neutral contract

**What to build:** CommandCode HTTP, stream, transport, timeout, protocol, callback, and cancellation failures retain their safe structured facts through Pi/execution; retries obey Provider-owned policy and never leak another request's state.

**Blocked by:** 03 — neutral failure contract; 23 — certified request; 24 — JSONL lifecycle; 25 — Pi normalization.

**Status:** ready-for-agent

## Module seam

The attempts module consumes one immutable prepared logical request plus Provider transport config and emits either one committed CommandCode result or one neutral failure. Fetch/body-reader/timer are injected only where production and test adapters genuinely differ.

## Information lifecycle

Each attempt owns response/status/body reader/span/timeout facts. A bounded final/attempt summary is promoted into the invocation neutral failure and journal. All raw body/header state is destroyed after the attempt; nothing is stored in a global observer.

## Acceptance criteria

- [ ] HTTP non-2xx preserves validated status/statusText, opaque type/code, safe message, bounded/truncated body metadata, retryability, and fixed allowlisted headers.
- [ ] HTTP-200 stream error preserves message/statusCode/isRetryable/type/code/body facts instead of flattening to message.
- [ ] Invalid stream status cannot be used as an HTTP response status.
- [ ] Fetch/connect, response-body, unexpected EOF, timeout, protocol, configuration, and callback failures have distinct neutral classes/phases.
- [ ] Wire abort remains upstream-stream failure; only caller signal produces cancellation/Pi aborted.
- [ ] Retry count/delay/timeout/body-read/body-size/client-message limits come from immutable CommandCode request/response config and are range-tested.
- [ ] Retried attempts reuse logical body, refresh attempt span, respect cancellation, and retry only classified retryable failures.
- [ ] Error capture never unboundedly clones/reads a response and cannot turn a readable upstream response into instrumentation failure.
- [ ] Provider emits Pi error terminal with neutral diagnostic; execution receives the same fact.
- [ ] Concurrent/sequential tests prove zero cross-request status/body/header leakage.
- [ ] Final failure submits all attempt summaries to exactly one journal.

## Out of scope

Client-specific error envelopes and deletion of legacy observer code (27).

