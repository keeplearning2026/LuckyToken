# 06 — Derive product Provider readiness from real model availability

**What to build:** Home, Connect, Tray, and other coarse product status surfaces reflect whether Token actually has at least one usable model, rather than whether Provider-related configuration merely exists.

**Blocked by:** 04 — Keep the authoritative Catalog alive for the Backend lifetime.

**Status:** ready-for-agent

- [ ] Add RED tests showing Provider readiness is `unconfigured` when Provider configuration exists but no Catalog model is currently available.
- [ ] Add RED tests showing readiness becomes `configured` when at least one model in the authoritative Catalog has `availability === available`.
- [ ] Compute readiness as a pure derivation from the current Catalog snapshot; do not introduce another mutable Provider-ready state authority.
- [ ] Recompute and republish the coarse readiness whenever the authoritative Catalog snapshot changes.
- [ ] Gateway lifecycle remains a separate fact: a stopped/failed Gateway does not erase an otherwise connected Provider/model capability.
- [ ] Home and Connect consume the corrected readiness meaning without inspecting Provider IDs, credentials, package configuration, models.json presence, or Catalog internals themselves.
- [ ] Existing detailed Auth/Credential/Catalog projections remain authoritative for explanation and remediation; the coarse readiness flag is not expanded into a duplicate status model.
- [ ] Tests cover login success, Catalog refresh failure, model availability changes, and Data Plane stop/restart without stale readiness.
