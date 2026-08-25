# 09 — Turn Providers into a real Provider browser

**What to build:** The Providers page becomes the primary product activation surface: it always shows the authoritative Provider set and model facts, organized for normal users, even when the Gateway is stopped or failed.

**Blocked by:** 03 — Make Provider discovery and login independent of Gateway lifecycle; 04 — Keep the authoritative Catalog alive for the Backend lifetime; 05 — Project Provider origin through the existing Auth contract.

**Status:** ready-for-agent

- [ ] Add fake-Desktop-API RED tests proving the page renders the complete projected Provider collection instead of an empty shell when the Gateway is stopped or failed.
- [ ] Providers are organized into simple Connected and Available groups with Renderer-owned search over safe projected fields.
- [ ] Each generic Provider card combines existing Auth/Credential/Catalog facts to show Provider name, source label, credential state, known/available model count, auth actions, and catalog failure/retry state.
- [ ] Source labels are presentation-only mappings of the projected source (`Built in`, `Token`, `Custom`); package names and internal composition details are not exposed.
- [ ] Pi built-ins, CommandCode Private, models.json custom Providers, and external user Provider Packages render through the same generic card components.
- [ ] Auth query failure or Catalog query failure renders an explicit management/error state rather than falsely implying that no Providers exist.
- [ ] Provider identity/auth behavior is not hardcoded by Provider ID in the Renderer.
- [ ] The page reacts to authoritative status/catalog generation changes by re-querying as needed; it does not introduce a separate polling authority or persisted Provider cache.
