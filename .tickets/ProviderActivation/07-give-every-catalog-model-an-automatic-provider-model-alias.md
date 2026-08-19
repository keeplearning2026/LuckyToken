# 07 — Give every Catalog model an automatic Provider-scoped Model name

**What to build:** Every model that enters the authoritative Catalog is immediately addressable through exactly one generated default alias, with no curated model table and no user file entry required.

**Blocked by:** 04 — Keep the authoritative Catalog alive for the Backend lifetime.

**Status:** ready-for-agent

- [ ] Add RED tests proving every Catalog canonical target receives one `${providerId}/${defaultModelName}` alias with exactly one `/`.
- [ ] Derive the base Model name by replacing `/` inside canonical `modelId` with `-`; for example `deepseek/deepseek-v4-flash` becomes `deepseek-deepseek-v4-flash`.
- [ ] Resolve same-Provider normalized/shortened-name collisions deterministically with numeric suffixes without taking another model's natural normalized name or a valid user-owned Model name.
- [ ] Keep every generated alias within the 128-character Alias contract by deterministically shortening the normalized Model-name base before suffix allocation.
- [ ] Only Providers whose IDs are one safe 1–64 character namespace segment may enter the authoritative Catalog.
- [ ] Alias resolution carries the canonical `{ provider, model }` target explicitly and never parses the generated alias string to reconstruct identity.
- [ ] Generated defaults are derived state and are never persisted to `model-aliases.json`; current Catalog targets provide canonical identity and valid user-owned Model names reserve Provider-local external names that generated defaults must route around.
- [ ] A newly published Catalog model automatically receives its generated alias; a model leaving the Catalog no longer contributes a generated default.
- [ ] Remove the selected-model `curatedAliasDefaults` table and any defaults-generation counter that has no independent meaning after Catalog-derived defaults become authoritative; do not retain a compatibility layer.
- [ ] The one-effective-alias-per-canonical-target invariant remains intact.
- [ ] Existing malformed user-file and unavailable-target behavior remains fail-closed without inventing or persisting repaired defaults.
