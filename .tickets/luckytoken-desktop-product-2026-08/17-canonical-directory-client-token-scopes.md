# 17 — Canonical directory Client token scopes

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Let users open a directory and assign a protocol-specific Client token to its canonical filesystem identity. Symlinks, case aliases, and equivalent paths share one scope. Authorized requests receive the directory-derived project context while preserving clientSessionId separately from the internal effectiveSessionId.

**Blocked by:** 16 — Live protocol-global Client Token Authority.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm Client Token Authority commands/queries and real HTTP authorization facts as seams. Use temporary Windows directory aliases and controlled requests; do not assert on canonicalization helpers directly.

## Acceptance criteria

- [ ] A local directory picker can create, reveal/copy, rotate, and delete one active token for a protocol/directory scope.
- [ ] Scope identity uses canonical real path and platform normalization so symlinks, junctions, relative aliases, separator variants, and case aliases that identify one directory share a scope.
- [ ] The same canonical directory can hold independent tokens for different Client Protocols.
- [ ] Directory-token rotation/revocation takes effect immediately and follows the same concurrency/secret rules as global tokens.
- [ ] An authorized directory token supplies the canonical projectDir; a global token supplies no projectDir.
- [ ] Auth records clientSessionId only when the client supplied it and independently creates/retains the required effectiveSessionId.
- [ ] Public request-list projection shows the client-provided session ID or `-`, never substitutes effectiveSessionId for it.
- [ ] Tests cover real-path aliases, nonexistent/unauthorized directories, cross-protocol rejection, hot rotation, project context, and both session identities.
