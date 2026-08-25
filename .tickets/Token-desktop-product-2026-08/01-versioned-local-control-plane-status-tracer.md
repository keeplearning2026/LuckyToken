# 01 — Versioned local Control Plane status tracer

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/Token/issues/1)

**What to build:** Give local users and future desktop clients one authoritative way to discover and observe the active Token application. A local CLI client can connect, negotiate a contract version, query a status snapshot, subscribe to an ordered typed event stream, and recover from a disconnect by reading a fresh snapshot. The interface remains local-only and does not expose model-serving routes.

**Blocked by:** None — can start immediately.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm the Application Control Plane command/query/event interface as the public test seam, then work red → green one behavior at a time. Do not test transport helpers, in-memory collections, or persistence internals directly.

## Acceptance criteria

- [x] A local client can negotiate the supported Control Plane contract version and receive explicit application identity and version facts.
- [x] An unsupported client version is rejected with a structured incompatibility result rather than partially executing a command.
- [x] A local status query returns a typed snapshot even when the Model Data Plane is stopped or no Provider is configured.
- [x] Typed events carry a monotonically ordered application sequence and never include credential values.
- [x] After losing the event connection, a client can read a fresh snapshot and resume without treating missed events as current state.
- [x] The same public interface is consumable by CLI and desktop adapters without importing application implementation state.
- [x] Remote/LAN callers cannot reach the Control Plane even when a future Data Plane listener is configured for LAN.
- [x] Contract tests use deterministic adapters and verify externally observable query, command, event-order, and reconnect behavior.
