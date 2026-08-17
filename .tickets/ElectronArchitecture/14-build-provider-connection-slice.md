# 14 — Build Provider connection slice

**What to build:** Give users one Providers experience that shows usable Provider state, supports authentication/re-authentication, refreshes availability, and turns typed failures into clear recovery actions.

**Blocked by:** 13 — Build minimal Home readiness slice.

**Status:** ready-for-agent

- [ ] Providers presents Backend-owned authentication and catalog state without exposing credential values or internal file schemas.
- [ ] A user can start a supported Provider login flow, complete its interaction events, and see the resulting connected state without leaving the product workflow.
- [ ] Expired/invalid authentication is shown as an actionable reconnect state based on typed Backend facts rather than renderer inference from raw errors.
- [ ] A user can refresh Provider/model availability and see bounded per-Provider success/failure results.
- [ ] Provider connection behavior is fully testable with a fake Desktop API, including login events, cancellation, failure, retry, and success.
