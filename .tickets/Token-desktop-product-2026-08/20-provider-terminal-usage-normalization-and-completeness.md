# 20 — Provider terminal-usage normalization and completeness

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/Token/issues/1)

**What to build:** Normalize terminal Provider usage into one trustworthy Token vocabulary without erasing uncertainty. A request records known input, cacheRead, cacheWrite, output, normalizedTotal, cacheHitRate, and optional reasoning-as-output-subset, but contributes to token analytics only when the Provider explicitly reported terminal usage and its adapter can validate all four canonical component semantics.

**Blocked by:** 11 — Model catalog cache, refresh, and Provider error isolation; 18 — Request Lifecycle Ledger tracer.

**Status:** integrated

## Implementation method

Use the `$tdd` skill. Confirm controlled Pi Provider terminal outcomes and Request Ledger usage projection as seams. Use independent worked examples for expected totals and rates; never reproduce the production formula inside the assertion.

## Acceptance criteria

- [ ] Canonical fields are input, cacheRead, cacheWrite, output, normalizedTotal, cacheHitRate, and optional reasoning as a subset of output.
- [ ] normalizedTotal is derived only when input, cacheRead, cacheWrite, and output have validated mutually exclusive semantics; reasoning is never added again.
- [ ] cacheHitRate is cacheRead divided by input plus cacheRead plus cacheWrite; an absent, zero, or unvalidated denominator yields unavailable.
- [ ] Complete requires explicit terminal Provider usage plus adapter validation of all four component meanings; nonzero values alone never imply completeness.
- [ ] Missing, partial, failed, aborted, ambiguous, and Provider-unsupported usage remains visible with known components and a Partial/Unavailable reason.
- [x] Invalid Provider usage never discards an otherwise valid model response: target Client Protocol conversion preserves valid known components where possible, omits only invalid optional detail, and otherwise emits the adapter-defined all-zero usage fallback plus a structured request-linked warning.
- [x] Fail-open Client Wire usage remains separate from analytics truth: fallback/invalid usage is Partial or Unavailable, is excluded from token aggregation, and tests prove Anthropic JSON/SSE and OpenAI Responses still return the successful model content without inventing a precise count.
- [ ] Provider adapters declare/conform to their usage semantics at the Provider integration side without placing Provider-specific usage fields in Client Protocol code.
- [ ] Request detail stores the terminal usage snapshot and completeness evidence independently from Client Wire usage representations.
- [ ] Conformance tests cover complete, partial, absent, zero, cache-read, cache-write, reasoning, failure, abort, and a Provider whose semantics cannot be proven.
