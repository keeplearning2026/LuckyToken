# 27 — Remove the shared HTTP observer and legacy error side channels

**What to build:** Every converted route uses request-local neutral failure facts end to end; the process-global mutable HTTP observation slot, duplicate upstream mappers, and unconditional custom-fetch instrumentation are gone.

**Blocked by:** 10 — Anthropic rendering/errors; 18 — Responses rendering/errors; 26 — CommandCode neutral failures/retries.

**Status:** completed

## Refactor strategy

This is the contract half of ticket 03's expand–contract migration. Remove the old form only after all concrete producers/consumers use the neutral contract and route tests prove equivalent-or-better behaviour.

## Module seam

Runtime coordinates request-local execution facts only. Providers own failure acquisition; execution owns neutral promotion; each Client adapter owns its error envelope. There is no observer interface exposed to handlers and no central mapper containing Client protocol vocabulary.

## Information lifecycle

HTTP response facts live inside one Provider attempt. Only bounded neutral facts survive into execution/rendering/journal. On finalization, every fact is destroyed. A prefetch conversion/config failure has no HTTP fact and cannot read stale state.

## Acceptance criteria

- [x] Remove process-global/shared `latestObservation` state and all handler reads of it.
- [x] Remove or retire duplicate upstream-failure mappers that parse arbitrary bodies into Client types.
- [x] Client handlers no longer inject custom fetch solely for observation.
- [x] Pi adapters that reject custom fetch, including Google families, execute normally through Responses routes.
- [x] Prefetch conversion/config failure cannot acquire a prior request's status/body.
- [x] Concurrent Anthropic/Responses requests cannot cross-associate failure facts, headers, IDs, or bodies.
- [x] HTTP non-2xx and HTTP-200 stream error still render with the validated status/details supported by the neutral contract.
- [x] Instrumentation cannot unboundedly read/clone a response or change successful fetch semantics.
- [x] Caller cancellation, timeout, transport, Provider abort, and internal failure remain distinct.
- [x] Legacy unit tests reaching into observer internals are replaced by route/neutral-interface tests where appropriate.
- [x] Typecheck/lint/build/full offline tests pass with no dead observer imports or compatibility shims.

## Completion evidence

- Deleted the shared observer/acquisition modules, both legacy body mappers,
  every handler read of observation state, and their implementation-coupled
  unit tests.
- Conversion handlers pass no observation `fetch`; native Anthropic and
  Responses passthrough use a separate narrow `passthroughFetch` dependency.
- Route tests cover Google-family conversion without custom fetch, fixed
  generic 502 rendering without a structured fact, validated neutral HTTP
  rendering, prefetch isolation, and interleaved Anthropic/Responses failure
  isolation. Execution tests cover synchronous stream/iterator failures.
- Offline gates passed: certification 6/6; Vitest 91 files / 1187 tests;
  typecheck, lint, build, and `git diff --check`.
- Online CommandCode, Responses, and passthrough profiles were not run by
  explicit user decision; online evidence remains insufficient and is not
  claimed by this ticket.

## Out of scope

Changing native passthrough transport; tickets 11 and 19 own those profiles.
