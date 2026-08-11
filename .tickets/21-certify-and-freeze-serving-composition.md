# 21 — Certify and freeze the serving composition

**What to build:** Produce an immutable certification for the concrete LuckyToken serving route, proving the synchronized protocols, Pi runtime, Provider composition, model configuration, auth/transport policy, request fidelity, execution lifecycle, response fidelity, and round-trip behavior work as one stable system.

**Blocked by:** 01 — Synchronize the Anthropic protocol certification dependency; 04 — Propagate project identity end to end; 05 — Implement Anthropic source-profile and closed-world validation; 06 — Resolve models and enforce model-aware validity; 11 — Complete Pi-to-CommandCode request conversion; 13 — Run CommandCode attempts, retries, timeouts, and cancellation; 15 — Convert committed CommandCode results into a Pi lifecycle; 16 — Implement Core atomic execution and abort-aware commit; 18 — Render failures and deliver HTTP atomically; 19 — Render verifiable Anthropic Atomic SSE; 20 — Close Pi runtime fidelity gaps for the certified route.

**Status:** complete

- [x] The manifest binds immutable Core/conversion versions, synchronized Anthropic protocol revision, Pi evidence and runtime revisions, CommandCode protocol/profile, Provider construction, model configuration, and conformance revision.
- [x] It binds the model-validity, auth/endpoint, tool-ID, header-transform, fetch, callback, auxiliary-option, and ambient-semantic policies used in serving.
- [x] Startup owns mutable Provider registration; the normal serving contract cannot set, delete, or clear Providers.
- [x] Serving-time refresh/login/logout or future Models operations preserve certified facts or invalidate readiness before an affected future request executes.
- [x] In-flight requests remain isolated from certification-bound serving mutations after admission or fail before dispatch rather than drifting semantically.
- [x] Certification covers inbound grammar/semantic fidelity, Pi invocation integrity, Provider request/response conversion, cancellation, terminal consistency, outbound JSON/SSE fidelity, and next-turn round trip.
- [x] Reserved synthetic-history identity is disjoint from every certified target identity.
- [x] Any unresolved reachable semantic loss causes `FAILED`, never a partial or optimistic `CERTIFIED` status.
- [x] A clean verification run records the commands, immutable identities, and final `CERTIFIED` result needed to reproduce serving readiness.
