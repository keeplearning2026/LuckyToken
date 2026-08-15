# 23 — History export/deletion and persistence-failure degradation

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Let users export or deliberately delete permanent Requests and Diagnostics while preserving safe model serving when persistence is unavailable. Ordinary exports exclude raw capture, sensitive capture requires an additional confirmation, and deletion by range or all requires an irreversible confirmation. Storage failure produces Critical fallback state but does not change the model response.

**Blocked by:** 19 — Complete Requests page and request-detail contract; 22 — Globally controlled Deep Diagnostics capture.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm export/delete Control Plane commands, history queries, real model HTTP results, and Critical fallback projection as seams. Fault-inject storage only behind its adapter and assert public outcomes, not database/file calls.

## Acceptance criteria

- [ ] Users can export permanent structured request history and runtime diagnostics through one versioned export workflow.
- [ ] The default export excludes raw bodies/event capture and clearly reports that exclusion.
- [ ] Including raw capture requires a second explicit sensitive-data confirmation and marks the export as containing sensitive capture.
- [ ] Universal redaction still removes authentication capability values from all export modes.
- [ ] Users can select a time range or all eligible history for deletion and must confirm that deletion is irreversible.
- [ ] Deletion does not silently change Provider credentials, Client tokens, models.json, alias configuration, or unrelated application settings.
- [ ] A Request Ledger, Diagnostics, or capture persistence failure never changes an otherwise valid model response outcome.
- [ ] Persistence failure writes a sanitized Critical to stderr and bounded memory, is visible persistently in UI/tray until acknowledged/recovered, and explicitly states that an audit guarantee is unavailable.
