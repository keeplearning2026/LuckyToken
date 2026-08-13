# LuckyToken Frozen Protocol Conversion Refactor Tickets

**Created:** 2026-08-13

**Status:** approved, ready for implementation

## Authority

These tickets implement the frozen protocol audit, shared architecture policy, and the three protocol conversion methods dated 2026-08-13. If current code, a historical comparison, or an older ticket conflicts with the frozen specifications, the frozen specifications win.

## Architectural constraints

### Pi conversion profile

Pi is the only shared semantic contract between a Client Protocol and a Provider. No second conversion IR is allowed.

### Client Protocol isolation

Anthropic Messages and OpenAI Responses are independent modules. They MUST NOT share conversion configuration, policy objects, converters, discriminator tables, tool-correlation state, repair helpers, render state, session authority, passthrough classifiers, or protocol-specific tests. Identical defaults or fallback text remain independently owned and tested.

### Native passthrough

Native same-protocol passthrough is a separate non-conversion profile. Each Client Protocol independently owns compatibility selection, transport rules, rendering, and certification.

### Deep-module standard

Every ticket establishes or deepens one module behind a small interface. The interface includes invariants, ordering, errors, configuration, and lifetime—not just TypeScript types. Tests exercise the same interface callers use. Internal seams stay private. Do not add a port unless production and test adapters genuinely vary.

### Information lifecycle

Request-local information remains request-local. Prompts, tool outputs, opaque handles, errors, notices, and body snapshots have an explicit owner and destruction point. No process-global mutable “latest” slot is allowed.

## Delivery rules

- Land each ticket green and independently verifiable.
- Do not edit `pi-agent/`.
- Preserve unrelated worktree changes.
- Prefer replace-over-layer tests: once a deep interface has behavioural coverage, remove obsolete tests that reach through it.
- Run ticket-specific tests plus typecheck/lint/build when changing a public contract.
- Online evidence is required only where a ticket explicitly says so; lack of credentials remains “evidence insufficient.”

## Frontier

All four infrastructure tickets are complete. The next frontier is every
ticket whose dependencies are now satisfied:

- 05 — Preserve Anthropic message order and system-prompt semantics
- 07 — Map Anthropic sampling, thinking budgets, and cache policy
- 09 — Project Pi responses faithfully into Anthropic messages
- 11 — Certify and harden native Anthropic passthrough
- 12 — Rebuild Responses local response state
- 13 — Convert Responses privileged prompts, options, and handles
- 15 — Complete Responses function/custom/namespace tool lifecycles
- 17 — Build complete Pi-to-Responses objects and effective echoes
- 19 — Implement and certify native Responses passthrough
- 20 — Align CommandCode scalar options and synchronous execution
- 24 — Rebuild CommandCode JSONL event, identity, pause, and abort lifecycle

Anthropic, Responses, and CommandCode lanes can proceed independently from
here. See `INDEX.md` for the complete dependency graph.
