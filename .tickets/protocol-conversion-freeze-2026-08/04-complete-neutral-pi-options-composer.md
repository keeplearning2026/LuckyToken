# 04 — Complete the protocol-neutral Pi options composer

**What to build:** Any Client adapter can pass every frozen public Pi option through one validated composition interface, while source-protocol policy remains outside the composer.

**Blocked by:** None — can start immediately.

**Status:** completed

## Module seam

The composer accepts protocol-neutral Client-produced Pi options plus infrastructure facts and returns one immutable `SimpleStreamOptions` snapshot. It owns Pi validation and precedence only. It does not know the source wire field.

## Information lifecycle

Client source fields cease before this seam. Only Pi facts cross it. Infrastructure credentials/headers/session/project are added by explicit precedence rules, frozen once, and handed to Models/Provider.

## Acceptance criteria

- [x] Composer accepts and preserves `samplingParams`, `cacheRetention`, `thinkingBudgets`, every Pi `ThinkingLevel` including `minimal`, approved metadata, callbacks, and cancellation fields required by frozen routes.
- [x] `minimal` no longer converts successfully and then fails as an internal composition 500.
- [x] Absence remains absence; composer invents no Client- or Provider-owned defaults.
- [x] Client options cannot override credentials, reserved headers, signal, or request lifetime authority.
- [x] Unknown keys are rejected or explicitly omitted according to the Pi public contract; they never become a cross-protocol generic bag.
- [x] Returned nested objects are immutable snapshots and safe across retries.
- [x] Tests cover precedence, null/absence, every thinking level, sampling, budgets, cache, metadata, mutation resistance, and invalid ranges.
- [x] Existing handlers can migrate independently; no Client wire vocabulary enters the composer.
- [x] Typecheck, lint, build, and option-composition tests pass.

## Out of scope

Deciding how a Client wire field maps to Pi.
