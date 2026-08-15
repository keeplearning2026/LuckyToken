# 16 — Live protocol-global Client Token Authority

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Let UI and CLI securely manage one live global Client token per enabled Client Protocol. Enabling a protocol creates its initial token, list results are masked, Reveal/Copy are explicit local operations, and Rotate/Delete take effect immediately in the active Data Plane without restart.

**Blocked by:** 02 — Windows Desktop Shell and empty Dashboard; 03 — Dashboard-managed Runtime Supervisor; 06 — Settings-driven protocol, port, and LAN controls; 07 — Permanent Runtime Diagnostics and universal credential redaction.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm Client Token Authority commands/queries and real protocol HTTP authorization as seams. Test one mutation and its immediate HTTP consequence per red → green cycle; never test by inspecting an in-memory token map.

## Acceptance criteria

- [ ] First enabling Anthropic Messages or OpenAI Responses creates one protocol-global token when that scope has none.
- [ ] Each protocol has an independent authority; a token for one protocol cannot authorize another protocol.
- [ ] Masked token listings never reveal the secret, while explicit local Reveal/Copy returns only the requested active token.
- [ ] Rotate atomically persists a new token and immediately rejects the prior token for subsequent requests.
- [ ] Delete immediately rejects the removed token but does not disable its Client Protocol.
- [ ] An enabled protocol with no remaining token returns 401 for all model requests and emits a warning visible in Dashboard/Diagnostics.
- [ ] UI and CLI mutations share a locked, revision-aware authority and concurrent operations cannot resurrect an old token or lose an update.
- [ ] Token secrets never appear in typed events, Diagnostics, request records, exports, error bodies, or logs.
