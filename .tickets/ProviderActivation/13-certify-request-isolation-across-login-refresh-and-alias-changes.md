# 13 — Certify request isolation across login, catalog refresh, and alias changes

**What to build:** Provider activation remains safe under concurrency: in-flight requests keep the Provider/model/alias facts they captured, while later requests see newly published credentials, Catalog generations, and alias mappings. Data Plane restarts reuse the same Backend Provider Runtime.

**Blocked by:** 03 — Make Provider discovery and login independent of Gateway lifecycle; 04 — Keep the authoritative Catalog alive for the Backend lifetime; 08 — Add model-scoped alias override and reset operations.

**Status:** ready-for-agent

- [ ] Add deterministic integration tests with explicit barriers proving Request A captures generation N before login/catalog refresh and completes with generation N facts.
- [ ] A later Request B accepted after the new Catalog generation is published uses the refreshed Provider/model facts and newly effective credential state.
- [ ] Alias mutation during an in-flight request does not remap that request; later requests use the newly captured effective alias mapping.
- [ ] Credential replacement remains serialized by the existing Pi-compatible credential store/authority; no second mutex or credential cache is introduced in Renderer, Main, or Provider Runtime.
- [ ] Catalog refresh continues to use the existing controller queue/snapshot mechanism; Provider Runtime does not introduce another refresh scheduler or lock.
- [ ] A models.json recompose updates Provider composition/source metadata coherently before the next capture, without mutating Model objects already handed to active requests.
- [ ] Data Plane stop/start/restart creates a new serving composition but directly proves the Provider Runtime/Models identity is unchanged across the restart.
- [ ] The tests do not depend on scheduler luck or call ordering; all concurrent phases are explicitly controlled so failures are reproducible.
