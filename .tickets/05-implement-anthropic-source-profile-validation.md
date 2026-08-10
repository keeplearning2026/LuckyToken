# 05 — Implement Anthropic source-profile and closed-world validation

**What to build:** Recognize exactly the supported Anthropic source grammar and classify malformed, source-invalid, and source-valid-but-unsupported requests without silently dropping body fields or protocol-defined semantic headers.

**Blocked by:** 01 — Synchronize the Anthropic protocol certification dependency; 02 — Establish the minimal text walking skeleton.

**Status:** complete

- [x] The only implemented v1 grammar is `anthropic-version=2023-06-01` with no active beta.
- [x] Profile-envelope invalidity is `InvalidRequest`; a valid or unclassified but unimplemented grammar is `UnsupportedFeature`.
- [x] Profile-independent malformed JSON is detected before profile-support rejection.
- [x] Header classification is case-insensitive, recognizes known Anthropic profile/semantic headers, retains unknown `anthropic-*` extension markers, and ignores unrelated unknown HTTP headers as protocol semantics.
- [x] `anthropic-user-profile-id` without its required beta is source-invalid, while the beta-activated grammar remains unsupported in v1.
- [x] Unknown body semantics, ordinary `message.content: []`, and `tool_result.content: []` follow their frozen closed-world/grammar-coverage policies.
- [x] Within the supported grammar, model-independent source validity completes before feature-level v1 support rejection.
- [x] Client authorization failure remains independent from Anthropic source validity and uses its own failure path.
