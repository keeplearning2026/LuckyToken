# 07 — Give every Catalog model an automatic `providerId/modelId` alias

**What to build:** Every model that enters the authoritative Catalog is immediately addressable through exactly one generated default alias, with no curated model table and no user file entry required.

**Blocked by:** 04 — Keep the authoritative Catalog alive for the Backend lifetime.

**Status:** ready-for-agent

- [ ] Add RED tests deriving the expected default alias for every Catalog canonical target as exactly `providerId/modelId`.
- [ ] Models whose `modelId` itself contains `/` retain the full text, for example `commandcode-private/deepseek/deepseek-v4-flash`.
- [ ] Alias resolution carries the canonical `{ provider, model }` target explicitly and never parses the generated alias string to reconstruct identity.
- [ ] Generated defaults are a pure lower layer derived from the current Catalog and are never persisted to `model-aliases.json`.
- [ ] A newly published Catalog model automatically receives its generated alias; a model leaving the Catalog no longer contributes a generated default.
- [ ] Remove the selected-model `curatedAliasDefaults` table and any defaults-generation counter that has no independent meaning after Catalog-derived defaults become authoritative; do not retain a compatibility layer.
- [ ] The one-effective-alias-per-canonical-target invariant remains intact.
- [ ] Existing malformed user-file and unavailable-target behavior remains fail-closed without inventing or persisting repaired defaults.
