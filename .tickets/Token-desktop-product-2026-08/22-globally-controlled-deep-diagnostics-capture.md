# 22 — Globally controlled Deep Diagnostics capture

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/Token/issues/1)

**What to build:** Let users deliberately enable a global Deep Diagnostics window for future requests. While enabled, all requests capture raw request/response bodies, safe headers, and event timing under bounded retention; requests accepted before enablement or after disablement do not gain raw capture retroactively. Structured history remains permanent and independent.

**Blocked by:** 07 — Permanent Runtime Diagnostics and universal credential redaction; 18 — Request Lifecycle Ledger tracer.

**Status:** integrated

## Implementation method

Use the `$tdd` skill. Confirm Deep Diagnostics control/query behavior plus Request detail capture projection as seams. Use deterministic clocks, capacity limits, and known secret literals; test captured/exported results rather than retention helpers.

## Acceptance criteria

- [ ] Deep Diagnostics has one global enable/disable state and applies to every request accepted while enabled.
- [ ] Enabling capture affects only subsequently accepted requests; disabling it does not erase already captured data.
- [ ] Captures may include original request/response bodies, non-credential headers, and ordered event timing for debugging.
- [ ] Universal redaction removes every authentication capability value before any capture reaches disk or events.
- [ ] Raw capture retention is bounded by configurable age and capacity even though the associated structured Request Ledger record is permanent.
- [ ] Evicting raw capture leaves request metadata intact and marks capture as expired/unavailable rather than deleting the request.
- [ ] Request detail distinguishes no capture, captured, partial capture, capture failed, and capture expired states.
- [ ] Tests cover enable/disable acceptance boundaries, simultaneous requests, capacity/age eviction, redaction, structured-history independence, and capture write failure.
