# 16 — Build Activity slice

**What to build:** Combine recent requests and analytics into one user-facing Activity experience that explains what LuckyToken has been doing without exposing storage or transport internals.

**Blocked by:** 13 — Build minimal Home readiness slice.

**Status:** ready-for-agent

- [ ] Activity shows recent request records with stable status, model/provider/client context, timing, and usage facts from the Request Ledger projection.
- [ ] Live committed-request updates appear without duplicating records or requiring the renderer to own the ledger.
- [ ] Basic user-facing filters and pagination/loading behavior work from bounded Backend queries.
- [ ] Analytics summary/options are reachable from the same Activity feature and remain Backend-computed rather than reaggregated in the renderer.
- [ ] Request and analytics interactions are fully testable with a fake Desktop API, including reconnect/resync behavior for live updates.
