# 03 — Make Provider discovery and login independent of Gateway lifecycle

**What to build:** Users can discover and authenticate Providers whenever the Backend is healthy, even when the model HTTP Gateway is stopped or failed. A Provider login performed while stopped is immediately usable after the Gateway starts, with no Backend restart.

**Blocked by:** 02 — Move Provider creation behind one Backend-owned Provider Runtime.

**Status:** ready-for-agent

- [ ] Add RED integration tests for Auth query while the Data Plane is stopped and while startup has failed deterministically, such as a port conflict.
- [ ] Auth query returns the Backend-owned Pi Provider collection in every normal Data Plane state: stopped, starting, running, stopping, and failed.
- [ ] Provider login while the Data Plane is stopped runs through Pi `Models.login()` and the existing typed interaction channel; CommandCode API-key login persists through the one existing credential store.
- [ ] Auth/Credential Control Plane handlers are wired to non-optional Backend-lifetime Provider authorities instead of optional slots populated by Data Plane startup.
- [ ] Data Plane stop/failure no longer produces a normal-state `unavailable` Auth result merely because no HTTP serving composition exists.
- [ ] The sequence stop Gateway → login Provider → start Gateway → send request succeeds without restarting the Backend, and the request uses the newly stored credential.
- [ ] Stopping or restarting the Data Plane does not recreate the Backend Provider Runtime or credential authority.
- [ ] Existing cancellation, conflict, unsupported, unknown-provider, storage-failure, and secret-redaction behavior remains intact.
