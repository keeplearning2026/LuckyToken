# 02 — Move Provider creation behind one Backend-owned Provider Runtime

**What to build:** One Backend lifetime owns exactly one Pi Models/Provider/Credential composition that management flows and every later Data Plane serving instance can share. This is the prefactor that makes Provider activation independent from HTTP listener lifetime without creating a new product architecture layer.

**Blocked by:** 01 — Ship CommandCode Private as a bundled product Provider.

**Status:** ready-for-agent

- [ ] Start with RED tests proving one Provider composition exposes the complete pinned Pi built-in set, bundled CommandCode, configured user Providers, and one credential authority.
- [ ] The Backend-owned Provider Runtime has a small explicit seam: authoritative Pi Models, the existing Credential Authority, the existing catalog runtime handle, and bounded Provider-source lookup only.
- [ ] Provider identity/name/auth/model facts continue to come from Pi Models; do not introduce a second Provider Registry, Provider database, event bus, general state manager, or new workspace package.
- [ ] Provider Runtime accepts only Provider-domain dependencies rather than the whole application/server configuration.
- [ ] There is one Pi-compatible credential store and one Models object graph for both login and later request execution.
- [ ] Existing models.json overlays, custom Providers, external Provider Packages, and configured auth semantics keep their current behavior except for the intentional bundled-CommandCode ownership change from Ticket 01.
- [ ] Data Plane-specific authorities such as HTTP, aliases, settings, ledger, diagnostics, history, backup, and Electron/Control Plane hosting do not move into Provider Runtime.
- [ ] Tests expose enough identity information to prove later Data Plane restarts reuse this same Provider Runtime rather than reconstructing it.
