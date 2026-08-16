# 18 — Request Lifecycle Ledger tracer

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Make every accepted model request observable from ingress to terminal response. A handler-local lifecycle observer assigns the request ID, records accepted/running/terminal transitions in a permanent Request Ledger, publishes narrow typed updates, and correlates every Data Plane response without becoming a second semantic request model.

**Blocked by:** 07 — Permanent Runtime Diagnostics and universal credential redaction; 15 — Alias-only Model Data Plane; 17 — Canonical directory Client token scopes.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm Request Ledger queries/events and the real Data Plane HTTP response as seams. Start with one failing end-to-end request lifecycle test; do not test observer methods or persistence tables directly.

## Acceptance criteria

- [x] The handler assigns a safe unique request ID at acceptedAt and records an accepted request before model execution begins.
- [x] Every success and error response carries `x-luckytoken-request-id`; protocol error bodies include it where the target protocol permits.
- [x] The Ledger exposes live phase transitions for accepted, execution, rendering, and terminal preparation without claiming socket-consumption completion.
- [x] acceptedAt is handler acceptance, executionStartedAt is Pi invocation start, terminalAt is the Pi terminal outcome, and completedAt is terminal response preparation.
- [x] Each record snapshots externalAlias, Provider ID, real model ID, Client Protocol, projectDir, clientSessionId, and effectiveSessionId from the request's captured authorities.
- [x] Lifecycle updates collect narrow facts from Auth, alias/model resolution, Pi execution, rendering, HTTP finalization, conversion notices, attempts, and safe failures without carrying protocol-native payloads by default.
- [x] Successful, failed, aborted, rejected-auth, unknown-alias, and unavailable-alias requests reach one explicit terminal record.
- [x] Restart tests prove terminal structured records are permanent and running records recover into a truthful interrupted/unknown terminal state rather than disappearing.
