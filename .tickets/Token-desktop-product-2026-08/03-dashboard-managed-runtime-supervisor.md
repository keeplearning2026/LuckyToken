# 03 — Dashboard-managed Runtime Supervisor

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/Token/issues/1)

**What to build:** Let users start, stop, and restart the model gateway from Dashboard or CLI while the management application remains available. Opening the desktop application attempts to start the gateway even with no configured Provider. The supervisor owns one stable listener, reports lifecycle state and port conflicts, and starts Anthropic Messages and OpenAI Responses by default.

**Blocked by:** 01 — Versioned local Control Plane status tracer; 02 — Windows Desktop Shell and empty Dashboard.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm Runtime Supervisor commands, queries, and lifecycle events as the primary seam; use the real local HTTP seam only to prove serving starts and stops. Work red → green without testing process-private state.

## Acceptance criteria

- [x] Opening the desktop application requests Data Plane startup even when no Provider or usable model exists.
- [x] Dashboard and CLI can issue Start, Stop, and Restart through the same Control Plane commands.
- [x] The snapshot and events distinguish stopped, starting, running, stopping, and failed lifecycle states.
- [x] Anthropic Messages and OpenAI Responses routes are enabled by default on one configured origin and port.
- [x] Starting on an occupied fixed port enters a visible failed state with the original port and actionable error; no random fallback port is selected.
- [x] Stopping the gateway leaves Control Plane queries, configuration, Requests, Analytics, and Diagnostics available.
- [x] Concurrent or repeated lifecycle commands are serialized and have deterministic idempotent/conflict behavior.
- [x] Integration tests prove Dashboard-observable transitions and real HTTP reachability through the public seams.
