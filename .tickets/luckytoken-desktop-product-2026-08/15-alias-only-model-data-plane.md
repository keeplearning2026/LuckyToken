# 15 — Alias-only Model Data Plane

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Make public model identity consistently alias-based. Model requests accept only configured aliases; discovery returns only currently callable mapped aliases; converted and native-passthrough responses echo the requested alias. Canonical Provider/model identity remains internal except for the real Provider in discovery `owned_by` and local management views.

**Blocked by:** 03 — Dashboard-managed Runtime Supervisor; 11 — Model catalog cache, refresh, and Provider error isolation; 13 — Provider-owned account/subscription authentication projection; 14 — Global Model Alias Registry.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm the real Model Data Plane HTTP seam for Anthropic Messages and OpenAI Responses. Write failing Request/Response integration tests for one externally visible behavior at a time; do not invoke model-resolution internals directly.

## Acceptance criteria

- [x] A configured, available alias resolves to the captured canonical Provider/model and reaches the standard Pi Provider invocation path.
- [x] Bare model IDs and canonical Provider/model selectors are rejected even when they identify a real callable model.
- [x] A nonexistent alias returns a target-protocol `unknown_model` result without leaking canonical identities.
- [x] A configured alias whose target is not currently callable is hidden from discovery and returns a distinct target-protocol `model_unavailable` result.
- [x] `/v1/models` remains unauthenticated and returns only available mapped aliases; `owned_by` identifies the real Provider without exposing real model ID.
- [x] Anthropic and OpenAI Responses success payloads expose the external alias rather than the canonical model ID.
- [x] Native passthrough rewrites response model identity to the alias or fails safely when symmetry cannot be guaranteed; it never exposes the real model ID.
- [x] Hot catalog/alias replacement affects only new requests; in-flight requests keep their captured alias and canonical target.
