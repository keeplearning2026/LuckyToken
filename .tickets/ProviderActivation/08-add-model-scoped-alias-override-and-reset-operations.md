# 08 — Add model-scoped alias override and reset operations

**What to build:** A user can rename one known model through an Alias Authority operation scoped to that model, and can restore its generated default without editing or replacing the whole alias file.

**Blocked by:** 07 — Give every Catalog model an automatic Provider-scoped default Model name.

**Status:** ready-for-agent

- [ ] Add RED tests for setting a custom alias on one canonical Catalog target and resetting that target back to its generated default.
- [ ] A valid custom alias replaces that target's generated default in the effective registry; the default and custom alias are never simultaneously effective.
- [ ] Reset removes only that target's persisted user override and immediately restores the Catalog-derived `${providerId}/${defaultModelName}` identity.
- [ ] Model-scoped mutations use the existing Alias Authority revision/CAS, locking, validation, and atomic persistence semantics.
- [ ] The mutation validates that the model target is a current canonical Catalog target, rejects Model names containing `/`, and fails closed for stale/conflicting revisions or invalid aliases.
- [ ] A user Model name may reserve a name that another target would otherwise receive as a generated default; that default is renumbered. Reusing a Model name already owned by another user override in the same Provider is rejected without replacing the previous file/revision/resolver.
- [ ] The normal product command accepts only the already-known model identity plus alias/reset intent; it does not expose a Provider/model target picker or raw file structure.
- [ ] Existing advanced whole-registry management may remain only if still required, but no compatibility wrapper is added for the removed static-default design.
