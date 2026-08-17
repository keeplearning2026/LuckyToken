# ADR 0002: Control Plane-managed model gateway lifecycle

- Status: Accepted
- Date: 2026-08-15
- Ticket: Desktop 03

## Context

LuckyToken's management application must remain reachable while the model gateway is stopped or cannot bind its configured port. Dashboard and CLI also need one lifecycle contract; neither may learn Node listener objects, mutable configuration, credentials, or process-private state.

## Decision

The Node background owns one Runtime Supervisor and the HTTP listener. The Supervisor is a deep module with one command interface (`start`, `stop`, `restart`), an injected listener adapter, and one authoritative promise queue. The versioned Application Control Plane is the public seam: it supplies commands, status queries, and ordered `status_changed` events to CLI and desktop adapters.

Control Plane v1 status keeps the existing `modelDataPlane` fact and adds `starting` and `failed` to the lifecycle. Supervisor-owned snapshots also include the fixed configured origin and port. A failed snapshot contains only one of the closed codes `port_in_use`, `start_failed`, or `stop_failed` and its fixed actionable message. Raw runtime errors never enter the contract. Older Ticket 01 hosts may omit the optional `dataPlane` facts.

Commands are serialized in arrival order. `start` while running and `stop` while stopped return `unchanged`. `restart` requires running state and otherwise returns the closed `restart_requires_running` conflict. A successful restart closes the prior listener before constructing its replacement. After `stop_failed`, `start` returns `application_restart_required` because the old listener's closure is uncertain. Other listener failures produce a `failed` lifecycle result while the Control Plane and discovery descriptor remain alive; no fallback port is selected.

The serving CLI starts and publishes Control Plane discovery before it asks the same Supervisor command handler to start the Data Plane. Process signals request `stop` through that handler before Control Plane disposal. The shipped configuration enables the current Anthropic Messages and OpenAI Responses routes on one configured listener. Provider registration or usable credentials are not prerequisites for binding that listener; model requests retain their existing explicit protocol/provider errors.

The Tauri host remains a native-only adapter. Its first successful Control Plane connection sends exactly one `start` command before subscribing. Renderer snapshot/retry calls do not start the gateway, preventing React remounts from creating command storms. Dashboard actions invoke only the no-argument native commands `shell_start`, `shell_stop`, and `shell_restart`; Rust performs discovery, capability authentication, wire validation, and an allowlisted status projection.

## Consequences

- Stopping or failing the Data Plane does not remove Control Plane access.
- The fixed configured endpoint remains visible and actionable after bind failure.
- CLI, desktop, and automatic desktop startup share one lifecycle implementation and event sequence.
- Rust mirrors the extended Control Plane v1 wire and must remain covered by the real native executable smoke.
- Tray behavior, backend process spawning/ownership, graceful application exit policy, settings UI, and diagnostics persistence remain in Tickets 04–07.
