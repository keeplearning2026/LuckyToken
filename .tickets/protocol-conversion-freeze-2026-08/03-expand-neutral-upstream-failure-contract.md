# 03 — Expand a protocol-neutral upstream failure contract

**What to build:** A Provider can report structured HTTP, stream, transport, timeout, protocol, configuration, callback, or cancellation facts through Pi diagnostics and execution, and a Client renderer can consume them without knowing which Provider produced them.

**Blocked by:** None — can start immediately.

**Status:** completed

## Refactor strategy

This is the expand half of an expand–contract migration. Add the neutral form beside legacy observer/error-message paths so existing routes stay green. Ticket 27 removes the old form after all producers and consumers migrate.

## Module seam

The interface is one small immutable failure fact carried by a Pi error diagnostic and preserved by execution failure. Provider-specific parsing stays behind each Provider adapter. Client-specific mapping stays behind each Client adapter. The fact contains no concrete protocol discriminants.

## Information lifecycle

Facts are created by the failing attempt/Provider, frozen at the Pi terminal, promoted by execution, rendered once, submitted to the failure journal, and destroyed. They never enter model history or session state.

## Acceptance criteria

- [x] Neutral discriminants cover HTTP, upstream stream, transport phase, timeout, configuration, protocol, conversion, callback, and caller cancellation.
- [x] The contract preserves validated status/statusText, opaque provider type/code, safe message, bounded snapshot metadata, allowlisted headers, retryability, attempt count, and truncation.
- [x] `errorMessage` remains a human fallback; no consumer reparses it to infer status/type/code.
- [x] Execution preserves the complete neutral fact rather than only a string diagnostic.
- [x] Caller cancellation is structurally distinct from an upstream event named abort/cancelled.
- [x] Invalid status, oversized fields, unsafe headers, mutable objects, or model-visible payloads are rejected/sanitized at construction.
- [x] Tests cover each failure class and prove facts survive Provider→Pi→execution unchanged.
- [x] Tests prove diagnostics are not replayed into historical model messages.
- [x] Legacy behaviour remains temporarily available until ticket 27.
- [x] No concrete Client Protocol or Provider import enters the neutral module.

## Out of scope

Migrating concrete producers or Client renderers.
