# 21 — Filterable Provider and total Analytics

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Give users trustworthy request and token analytics for all Providers and each real Provider. Users can choose a time range and filter or group by real model, Client Protocol, project directory, and outcome. Token totals include only complete usage, while all requests still contribute to count and success/failure coverage.

**Blocked by:** 19 — Complete Requests page and request-detail contract; 20 — Provider terminal-usage normalization and completeness.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm Analytics queries as the public seam and use fixed Request Ledger fixtures with an independent expected table. Work one grouping/filter invariant per red → green cycle; do not query persistence tables from tests.

## Acceptance criteria

- [ ] Analytics supports explicit time ranges with total and per-real-Provider views.
- [ ] Results can additionally filter or group by real model, Client Protocol, canonical project directory, and outcome.
- [ ] Request count, success rate, failure rate, and abort outcomes include every matching request regardless of usage completeness.
- [ ] Token/cache aggregates include only requests whose normalized terminal usage is Complete.
- [ ] Every result exposes participating token-stat request count, total request count, and excluded request count.
- [ ] input, cacheRead, cacheWrite, output, normalizedTotal, and aggregate cacheHitRate use the approved canonical semantics; reasoning is displayed only as an output subset.
- [ ] A request and its eventual terminal usage are attributed to the acceptedAt bucket even when completion crosses a time boundary.
- [ ] No monetary cost, subscription value, pricing estimate, or billing field is displayed or exported as Analytics.
