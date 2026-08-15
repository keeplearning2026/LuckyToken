# 14 — Global Model Alias Registry

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Give users one global, transparent authority that maps a public model alias to exactly one canonical Provider/model target. Curated defaults form a lower layer, user mappings always win, one real target has at most one effective alias, and valid changes atomically hot-apply to new requests while in-flight work retains its captured mapping.

**Blocked by:** 02 — Windows Desktop Shell and empty Dashboard; 11 — Model catalog cache, refresh, and Provider error isolation.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm Model Alias Registry commands/queries/events as the test seam. Begin with failing mapping and snapshot behaviors; avoid testing map data structures or editor components directly.

## Acceptance criteria

- [ ] A LuckyToken-owned model-aliases.json is the manually editable authority for the global alias mapping.
- [ ] Each alias maps to exactly one canonical Provider/model target and each canonical target has at most one effective alias.
- [ ] Curated built-in mappings are the lower layer; explicit user mappings override them and remain stable across default upgrades.
- [ ] Updating an untouched curated default can change it on upgrade, while a user-modified mapping is never silently replaced.
- [ ] Models & Aliases shows every known model, its availability, effective alias, source layer, and validation error; unmapped models remain manageable.
- [ ] Valid mapping changes are locked, revision-checked, atomically persisted, and hot-applied for new request snapshots.
- [ ] Invalid, duplicate, ambiguous, or unknown canonical targets are rejected without replacing the active registry.
- [ ] Concurrency and snapshot tests prove UI/CLI updates cannot lose data and in-flight requests retain the alias/target captured at acceptance.
