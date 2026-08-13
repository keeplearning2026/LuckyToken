# 12 — Rebuild Responses local response state

**What to build:** Responses clients can safely continue known local responses, receive a precise error for unknown IDs, and control `store:false` through the frozen honor/memory/persist policy without corrupting or overgrowing state.

**Blocked by:** 01 — adapter-owned configuration; 02 — request-local notices/journal.

**Status:** completed

## Module seam

The Responses state module exposes a small interface for expand, remember, and flush. It hides wire-item storage, bearer-ID generation, TTL/capacity, commit scheduling, persistence, corruption handling, and admission rules. Callers never receive its Map or snapshot schema.

This module is Responses-owned. No Anthropic state/policy is imported, and Runtime only binds the state capability.

## Information lifecycle

Raw Responses wire items are copied into owned immutable entries. Pi Context is not stored. A response ID is a bearer capability with high entropy and TTL/capacity bounds. `honor` retains nothing reusable; `memory` dies with process; `persist` enters memory/disk and emits notice when caller said false.

## Acceptance criteria

- [x] Known previous_response_id prepends stored items in exact order before new input.
- [x] Unknown, expired, evicted, corrupt, or unresolvable previous_response_id returns a typed conversion error; no naked-increment fail-open.
- [x] IDs are high entropy, non-enumerable, safe for file/log correlation, and not bound to auth/project scope.
- [x] `store:false=honor` stores neither memory nor disk; memory stores process-only; persist stores and emits notice.
- [x] true/null/absence follows documented normal storage policy and response reports only effective behaviour.
- [x] First response does not wait for commit; a deterministic test demonstrates/document the immediate-continuation race.
- [x] Entry TTL, count/byte caps, total snapshot cap, and load cap form a closed contract; module never writes an unloadable snapshot.
- [x] Writes are serialized, temp+atomic rename, and graceful flush is supported.
- [x] Corrupt state is quarantined; a referenced missing entry still errors.
- [x] Concurrent expansion/remember/flush tests use the public state interface and prove no mutable entry escapes.
- [x] No Anthropic or Provider imports enter the module.

## Out of scope

Converting expanded items to Pi (13–16).

