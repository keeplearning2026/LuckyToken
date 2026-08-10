# 13 — Run CommandCode attempts, retries, timeouts, and cancellation

**What to build:** Execute a prepared CommandCode request with stable logical semantics and fresh physical state per attempt, honoring caller cancellation, whole-attempt timeouts, response callbacks, deterministic retry policy, and retry isolation.

**Blocked by:** 12 — Protect CommandCode request authority and serialization.

**Status:** ready-for-agent

- [ ] Fetch resolution happens once using request override, bound default, then global fallback; all attempts use the same function.
- [ ] `maxRetries`, `timeoutMs`, and `maxRetryDelayMs` are validated against safe-integer and timer-domain rules with the frozen defaults.
- [ ] Each attempt owns a fresh span, traceparent, headers, timeout scope, Request/Response, decoder, reader, buffer, and assembler while body and base headers remain stable.
- [ ] One attempt timeout covers fetch establishment, response callback, body consumption, decoding, and semantic terminal handling.
- [ ] `onResponse` runs once per physical response before body consumption and is awaited through an abort-aware timeout boundary.
- [ ] Retryability follows HTTP/network/stream/EOF rules; malformed protocol, wire abort, pause, callback rejection, and semantic-conversion failures are non-retryable unless explicitly specified.
- [ ] Retry delay honors `retry-after-ms`, then numeric/date `retry-after`, then fallback backoff; valid excessive delays fail instead of being silently clamped.
- [ ] Retry sleep and every attempt phase are caller-abort-aware; cancellation before the first attempt produces zero fetch calls.
- [ ] Failed-attempt response state never leaks into a later attempt or Pi semantic output.

