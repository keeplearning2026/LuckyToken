# 04 — Keep the authoritative Catalog alive for the Backend lifetime

**What to build:** Provider/model Catalog query and refresh remain available independently of the HTTP Gateway. Login can refresh Provider models while the Gateway is stopped, and a Catalog refresh failure never rewrites authentication truth.

**Blocked by:** 03 — Make Provider discovery and login independent of Gateway lifecycle.

**Status:** ready-for-agent

- [ ] Add RED tests proving Catalog query and manual/background refresh are available while the Data Plane is stopped and after deterministic Data Plane startup failure.
- [ ] Bind the existing Catalog refresh controller to the Backend-owned Provider Runtime before Data Plane startup and keep that binding for the Backend lifetime.
- [ ] Data Plane stop/restart does not abort or dispose the Backend Catalog runtime; application shutdown remains the owner of Catalog disposal.
- [ ] A successful Provider login schedules the existing Provider-specific Catalog refresh and eventually publishes a new authoritative Catalog generation when facts change.
- [ ] Credential success and Catalog refresh success remain distinct: refresh failure can report model/catalog failure while the Provider stays authenticated.
- [ ] Existing catalog cache restore, refresh serialization, value-safe errors, and model availability checks are reused rather than duplicated in Provider Runtime.
- [ ] In-flight requests retain the Model/catalog facts captured at acceptance while later requests see a newly published Catalog generation.
- [ ] Catalog publication still drives the existing Backend hooks such as status publication and Alias recomputation without moving those authorities into Provider Runtime.
