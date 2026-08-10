# 01 — Synchronize the Anthropic protocol certification dependency

**What to build:** Publish an immutable Anthropic Messages protocol revision that contains every source-validity fact required by the frozen Anthropic ↔ Pi conversion contract, so implementation and runtime certification share one authoritative protocol dependency.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] The protocol defines model-dependent final-assistant prefill validity, including forbidden, allowed, and unknown outcomes without model-name guessing.
- [x] The protocol defines the documented request-wide limits of 20 strict tools, 24 optional parameters, and 16 union parameters as source-validity constraints.
- [x] Existing ToolResult string and explicit-empty-array evidence boundaries remain intact and are not upgraded into unsupported equivalence claims.
- [x] The conversion specification's dependency identity is updated to a new immutable protocol revision/hash without changing the v1 capability baseline.
- [x] Conformance fixtures prove the new facts are classified as `InvalidRequest` or `UnsupportedFeature` at the owning gates.
- [x] The previous reviewed protocol revision is no longer eligible for `CERTIFIED` status.
