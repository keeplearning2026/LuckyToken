# 15 — Convert committed CommandCode results into a Pi lifecycle

**What to build:** Convert only a committed CommandCode result into a trustworthy Pi `AssistantMessage`, then replay a legal Pi event lifecycle that preserves ordered text, reasoning, tool identity, finish semantics, usage, pricing, and late-failure accounting.

**Blocked by:** 14 — Atomically assemble CommandCode JSONL responses.

**Status:** complete

- [x] Finish maps `tool-calls → toolUse`, `length → length`, and all other defined/future finish strings to the frozen fallback while retaining raw reason diagnostically.
- [x] Input usage is partitioned into uncached input, cache read, and cache write without double counting; explicit partitions are consistency-checked.
- [x] Output and optional reasoning usage are non-negative integers with reasoning bounded by output; total tokens are recomputed from Pi categories.
- [x] Cost uses a callback-isolated, pre-hook pricing basis including tiers and one-hour cache-write semantics.
- [x] Text and reasoning map in original order without invented signatures; tool input must be a non-null object and is never repaired from preview deltas.
- [x] Usage failure yields zero failure usage; content failure after trustworthy usage yields empty content while preserving that trustworthy usage.
- [x] Successful replay emits start, complete per-block lifecycles with stable `contentIndex`, then exactly one consistent done terminal.
- [x] Failure replay emits exactly one error/aborted terminal; generic `end()` only closes the container and does not create a second semantic result.
- [x] Tests cover all usage partitions, pricing mutation, invalid tool inputs, replay ordering, and terminal/result resolution.
