# 11 — Model catalog cache, refresh, and Provider error isolation

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Keep model management usable across restarts and Provider outages. The catalog restores cached dynamic models at startup, refreshes in the background after login and when the model page opens, supports manual Refresh, atomically swaps successful catalog snapshots, and isolates Provider failures while displaying precise warnings.

**Blocked by:** 10 — Pinned Pi modelOverrides, headers, and authentication compatibility.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm catalog refresh commands, catalog queries, and resulting events as seams. Use controlled Pi Providers and a deterministic clock; test cache/refresh outcomes rather than cache implementation details.

## Acceptance criteria

- [ ] Startup restores the last valid cached dynamic catalog before network refresh completes.
- [ ] Successful Provider login schedules a background refresh for the relevant catalog.
- [ ] Opening Models & Aliases schedules a non-blocking background refresh, and Manual Refresh produces observable per-Provider progress/results.
- [ ] A fully successful refresh atomically replaces the active catalog for new requests while in-flight requests retain their captured Model snapshot.
- [ ] A Provider refresh failure preserves usable cached/built-in models from unaffected Providers and records a warning.
- [ ] Invalid models.json refresh behavior matches pinned Pi: compatible built-ins remain, affected custom Providers disappear, invalid state is not silently repaired, and errors are aggregated visibly.
- [ ] Catalog queries distinguish known, available, unavailable, cached, refreshing, and failed Provider/model states.
- [ ] Deterministic tests cover restart restoration, background triggers, manual refresh, partial Provider failure, invalid configuration, and snapshot isolation.
