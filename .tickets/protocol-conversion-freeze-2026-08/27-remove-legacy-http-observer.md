# 27 — Remove the shared HTTP observer and legacy error side channels

**What to build:** Every converted route uses request-local neutral failure facts end to end; the process-global mutable HTTP observation slot, duplicate upstream mappers, and unconditional custom-fetch instrumentation are gone.

**Blocked by:** 10 — Anthropic rendering/errors; 18 — Responses rendering/errors; 26 — CommandCode neutral failures/retries.

**Status:** ready-for-agent

## Refactor strategy

This is the contract half of ticket 03's expand–contract migration. Remove the old form only after all concrete producers/consumers use the neutral contract and route tests prove equivalent-or-better behaviour.

## Module seam

Runtime coordinates request-local execution facts only. Providers own failure acquisition; execution owns neutral promotion; each Client adapter owns its error envelope. There is no observer interface exposed to handlers and no central mapper containing Client protocol vocabulary.

## Information lifecycle

HTTP response facts live inside one Provider attempt. Only bounded neutral facts survive into execution/rendering/journal. On finalization, every fact is destroyed. A prefetch conversion/config failure has no HTTP fact and cannot read stale state.

## Acceptance criteria

- [ ] Remove process-global/shared `latestObservation` state and all handler reads of it.
- [ ] Remove or retire duplicate upstream-failure mappers that parse arbitrary bodies into Client types.
- [ ] Client handlers no longer inject custom fetch solely for observation.
- [ ] Pi adapters that reject custom fetch, including Google families, execute normally through Responses routes.
- [ ] Prefetch conversion/config failure cannot acquire a prior request's status/body.
- [ ] Concurrent Anthropic/Responses requests cannot cross-associate failure facts, headers, IDs, or bodies.
- [ ] HTTP non-2xx and HTTP-200 stream error still render with the validated status/details supported by the neutral contract.
- [ ] Instrumentation cannot unboundedly read/clone a response or change successful fetch semantics.
- [ ] Caller cancellation, timeout, transport, Provider abort, and internal failure remain distinct.
- [ ] Legacy unit tests reaching into observer internals are replaced by route/neutral-interface tests where appropriate.
- [ ] Typecheck/lint/build/full offline tests pass with no dead observer imports or compatibility shims.

## Out of scope

Changing native passthrough transport; tickets 11 and 19 own those profiles.

