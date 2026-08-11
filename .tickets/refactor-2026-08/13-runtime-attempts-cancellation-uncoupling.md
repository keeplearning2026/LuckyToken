# 13 — Keep runtime, attempts, and cancellation uncoupled from either side

**What to build:** HTTP attempt execution, retries, timeouts, cancellation,
and the runtime composition glue work against the Pi IR and the narrow
prepared-request contract only — never absorbing Anthropic or CommandCode
semantic policy, and never letting one side's state leak into the other.

**Blocked by:** 10 — CommandCode final request assembly and serialization
(for the request path) and 11 — CommandCode response reconstruction (for the
response path). Runtime work may start once 10 and 11 land; no dependency on
the Anthropic side tickets.

**Status:** ready-for-agent

- [ ] Attempt execution consumes the prepared request (endpoint, stable
  headers, bodyText, signal, fetch impl) and produces an attempt-local
  result via the reconstruction contract; retry starts a fresh
  reconstruction state and reuses the prepared payload without re-running
  semantic conversion or `onPayload`.
- [ ] `traceparent` is attempt-owned: constructed per attempt from logical
  trace context (valid W3C format) or omitted; never part of the stable
  semantic body/headers; retry attempts may have different span IDs.
- [ ] Cancellation cleanly terminates request-local state: discards
  incomplete reconstruction state, does not preserve partial tool calls,
  cancels upstream work via the attempt signal, never writes to closed
  responses, and distinguishes cancellation (`aborted`) from ordinary
  failure (`error`).
- [ ] Timeout/retry-delay handling follows the documented controls
  (`timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `retry-after(-ms)` parsing,
  capped server-requested delays) without introducing protocol-specific
  policy into the runtime.
- [ ] The composition root binds a concrete Anthropic handler and a concrete
  CommandCode provider but performs no conversion itself; runtime modules do
  not import provider or client-protocol internals.
- [ ] Unit/integration tests cover attempt retry, timeout, cancellation,
  traceparent-per-attempt, and state isolation across attempts.

**Out of scope:** the semantic conversions themselves (06–12) and the
Anthropic rendering pipeline (05).
