# 15 — Make Provider Activation a release certification gate

**What to build:** Token cannot ship a desktop release that regresses Provider discovery, bundled CommandCode activation, Gateway-independent authentication/catalog management, generated aliases, or the real packaged activation journey.

**Blocked by:** 14 — Complete the packaged Electron Provider activation journey.

**Status:** ready-for-agent

- [ ] Release certification compares projected Pi built-in Provider IDs against the pinned Pi `builtinProviders()` catalog rather than a hand-maintained expected list.
- [ ] Release certification proves the packaged Backend resolves and automatically registers CommandCode Private without user `providerPackages` configuration.
- [ ] Architecture certification fails if production serving recreates a second Pi Models/credential Provider composition instead of consuming the Backend-owned Provider Runtime.
- [ ] Certification proves Auth and Catalog remain available with the Data Plane stopped and after deterministic Data Plane startup failure.
- [ ] Certification proves every active Catalog model has one Catalog-derived default alias and that no static curated default alias table/defaults-generation authority remains in production.
- [ ] Certification proves model-scoped custom alias override/reset semantics and client-visible model discovery/request selection use the one effective alias.
- [ ] The packaged Electron Provider activation journey from Ticket 14 is wired into the distribution/release blocker rather than remaining an optional local E2E.
- [ ] Final gates include lint, typecheck, complete unit/behavior tests, integration tests, distribution/package tests, production build, real Electron lifecycle E2E, and Provider activation E2E.
- [ ] Remove obsolete normal-state optional Auth/credential slots, Data-Plane-owned Catalog binding, old CommandCode user-config behavior, old broad Provider-creating serving composition, and other compatibility remnants in the same implementation sequence; no deprecated fallback path remains.
