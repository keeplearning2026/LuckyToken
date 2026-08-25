# 09 — Pinned Pi Provider overlay and model-upsert compatibility

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/Token/issues/1)

**What to build:** Make the effective Provider/model catalog behave like the repository-pinned Pi baseline for built-in base composition, Provider overlay, custom Provider creation, and model upsert. Users can edit these fields and immediately see the same effective catalog Pi would construct from the same valid input.

**Blocked by:** 08 — Structured and raw models.json management.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm the effective catalog query and models.json apply command as seams. Derive expected fixtures independently from the pinned Pi implementation, start red for each compatibility case, and do not snapshot internal merge objects.

## Acceptance criteria

- [x] The exact pinned Pi source/schema version used as the compatibility baseline is recorded and test fixtures identify it.
- [x] Built-in Providers and models form the lower catalog layer before user configuration is applied.
- [x] A custom Provider is added with the same required/defaulted fields and validation behavior as pinned Pi.
- [x] A Provider entry overlays the matching built-in Provider according to pinned Pi precedence rather than replacing unrelated Provider facts.
- [x] A model entry upserts the canonical Provider/model target with pinned Pi identity and field semantics.
- [x] Multiple Providers and model upserts compose deterministically regardless of UI versus CLI edit origin.
- [x] The Providers and Models & Aliases pages show the effective result and distinguish source layer without inventing a second catalog authority.
- [x] Compatibility tests compare effective public catalog projections and relevant errors for a representative matrix of valid and malformed inputs.
