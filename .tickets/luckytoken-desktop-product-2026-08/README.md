# LuckyToken Desktop Product Tickets

Parent specification: [GitHub Issue #1 — Build the Windows-first LuckyToken desktop control plane and observability product](https://github.com/keeplearning2026/LuckyToken/issues/1)

This bundle turns the approved product specification into tracer-bullet tickets. Ticket numbers are dependency ordered; work any ticket whose blockers are complete.

## Agreed test seams

- The primary seam is the versioned local Application Control Plane command/query/typed-event interface.
- Data Plane behavior is tested through real Request/Response and local HTTP integration.
- The Windows Desktop Shell is kept thin and tested with focused lifecycle smoke tests.

Every implementation ticket requires the `$tdd` skill. Confirm the named seam before testing, then work red → green one externally observable behavior at a time. Tests must exercise public interfaces rather than storage layouts, private helpers, or renderer internals.

## Dependency frontier

- Initial frontier: 01.
- Control-plane/UI/runtime chain: 01 → 02 → 03 → 04 → 05.
- Settings: 03 → 06.
- Diagnostics foundation: 01 + 02 → 07.
- Provider/model chain: 07 + 02 → 08 → 09 → 10 → 11 → 12 → 13.
- Alias chain: 11 → 14; 03 + 13 + 14 → 15.
- Client-token chain: 03 + 06 + 07 → 16 → 17.
- Observability chain: 07 + 15 + 17 → 18 → 19; 11 + 18 → 20; 19 + 20 → 21.
- Deep diagnostics/history: 07 + 18 → 22; 19 + 22 → 23.
- Product completion: 23 plus configuration authorities → 24; operational features → 25; all terminal capabilities → 26.

## Tickets

1. Versioned local Control Plane status tracer
2. Windows Desktop Shell and empty Dashboard
3. Dashboard-managed Runtime Supervisor
4. Tray Close, Show, and Quit entry points
5. Headless ownership and graceful application exit
6. Settings-driven protocol, port, and LAN controls
7. Permanent Runtime Diagnostics and universal credential redaction
8. Structured and raw models.json management
9. Pinned Pi Provider overlay and model-upsert compatibility
10. Pinned Pi modelOverrides, headers, and authentication compatibility
11. Model catalog cache, refresh, and Provider error isolation
12. API-key credential management and effective authentication status
13. Provider-owned account/subscription authentication projection
14. Global Model Alias Registry
15. Alias-only Model Data Plane
16. Live protocol-global Client Token Authority
17. Canonical directory Client token scopes
18. Request Lifecycle Ledger tracer
19. Complete Requests page and request-detail contract
20. Provider terminal-usage normalization and completeness
21. Filterable Provider and total Analytics
22. Globally controlled Deep Diagnostics capture
23. History export/deletion and persistence-failure degradation
24. Safe backup and incompatible-configuration refusal
25. Actionable desktop notifications and tray aggregate state
26. Complete Windows product release certification
