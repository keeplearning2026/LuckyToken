# 21 — Filterable Provider and total Analytics

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Give users trustworthy request and token analytics for all Providers and each real Provider. Users can choose a time range and filter or group by real model, Client Protocol, project directory, and outcome. Token totals include only complete usage, while all requests still contribute to count and success/failure coverage.

**Blocked by:** 19 — Complete Requests page and request-detail contract; 20 — Provider terminal-usage normalization and completeness.

**Status:** integrated

## Implementation method

Use the `$tdd` skill. Confirm Analytics queries as the public seam and use fixed Request Ledger fixtures with an independent expected table. Work one grouping/filter invariant per red → green cycle; do not query persistence tables from tests.

## Acceptance criteria

- [x] Analytics supports explicit time ranges with total and per-real-Provider views. (Half-open `[from, to)` epoch-ms ranges on `acceptedAt`; `groupBy: "provider"` is the per-real-Provider view; verified by `test/integration/request-ledger-analytics.test.ts` and the `AnalyticsPage` Total / Per real Provider toggle in `test/analytics-page.test.tsx`.)
- [x] Results can additionally filter or group by real model, Client Protocol, canonical project directory, and outcome. (Bound `AnalyticsFilter` arrays and single-dimension `groupBy` over ledger snapshot columns, with the null group for unresolved facts; verified in `request-ledger-analytics.test.ts` and the page filter/group controls.)
- [x] Request count, success rate, failure rate, and abort outcomes include every matching request regardless of usage completeness. (Counts partition `total = success + failed + aborted + other + pending`; Partial/Unavailable rows count; `test/integration/request-ledger-analytics.test.ts` "incomplete usage never contributes tokens".)
- [x] Token/cache aggregates include only requests whose normalized terminal usage is Complete. (Sums over `terminalUsage.completeness === "complete"` only; `excluded = total − participating`; independent worked totals Σinput 13 / ΣcacheRead 7 / ΣcacheWrite 4 / Σoutput 8 / Σnormalized 32.)
- [x] Every result exposes participating token-stat request count, total request count, and excluded request count. (`participating` / `totalRequests` / `excluded` on every summary incl. group rows and buckets; re-verified by the wire decoder identity checks.)
- [x] input, cacheRead, cacheWrite, output, normalizedTotal, and aggregate cacheHitRate use the approved canonical semantics; reasoning is displayed only as an output subset. (Aggregate `cacheHitRate = ΣcacheRead / Σ(input+cacheRead+cacheWrite)` = 7/24 on the fixture, never the per-request average; reasoning summed only where reported, ≤ output, never added to any total; UI footnote.)
- [x] A request and its eventual terminal usage are attributed to the acceptedAt bucket even when completion crosses a time boundary. (Fixture r1 accepted 10:00 with usage landing at 18:30 still fills its 10:00 bucket; `test/integration/request-ledger-analytics.test.ts` AC-7 test.)
- [x] No monetary cost, subscription value, pricing estimate, or billing field is displayed or exported as Analytics. (The contract has no monetary key; TS wire decoder, Rust decoder, and client boundary reject any `cost/price/billing/amount` key; page test asserts no such text renders.)
