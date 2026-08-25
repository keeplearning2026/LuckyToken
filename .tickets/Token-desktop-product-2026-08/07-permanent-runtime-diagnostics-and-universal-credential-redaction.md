# 07 — Permanent Runtime Diagnostics and universal credential redaction

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/Token/issues/1)

**What to build:** Give users a permanent, structured Diagnostics stream for application info, warning, error, and critical events while enforcing one universal credential-redaction contract across every persistent destination. Events may correlate to a request ID but remain separate from request records.

**Blocked by:** 01 — Versioned local Control Plane status tracer; 02 — Windows Desktop Shell and empty Dashboard.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm Runtime Diagnostics commands/queries/events and exported persisted records as public seams. Begin each behavior with a failing test containing independent known credential literals; do not test redaction helpers directly.

## Acceptance criteria

- [x] Diagnostics permanently stores ordered structured info, warning, error, and critical events and exposes them through Control Plane queries/events.
- [x] An event may carry a request ID correlation without becoming part of the Request Ledger lifecycle.
- [x] Authorization, Proxy-Authorization, x-api-key, Cookie, Set-Cookie, Token Client tokens, and known query credentials lose all authentication capability before persistence.
- [x] Redacted records may preserve header names, authentication scheme/type, and a non-reversible fingerprint but cannot reconstruct the original value.
- [x] The same redaction contract applies recursively to nested facts, exceptions, import errors, raw captures, exports, backups, and fallback diagnostics.
- [x] Diagnostics records are not automatically aged out and remain queryable after application restart.
- [x] Diagnostics events delivered to UI/CLI never contain credentials even if their originating producer supplied unsafe facts.
- [x] Contract tests cover each credential class, mixed case, nested values, failure paths, and independently verify that known secret literals do not appear in any persisted/exported output.
