# 12 — API-key credential management and effective authentication status

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Let users authenticate Providers with API-key credentials while accurately distinguishing stored credentials from other effective sources. Each Provider has one Pi-compatible auth.json slot; a new login replaces it, logout removes only that stored value, and Pi-compatible auth.json import merges Provider by Provider with overwrite confirmation.

**Blocked by:** 07 — Permanent Runtime Diagnostics and universal credential redaction; 10 — Pinned Pi modelOverrides, headers, and authentication compatibility.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm Credential Management commands/queries and controlled Provider authentication as seams. Start with failing contract tests using fake secrets; never assert by reading the credential file directly when the public status interface can prove behavior.

## Acceptance criteria

- [ ] API-key login supports a literal secret, environment-variable reference, and `!command` source with pinned Pi resolution behavior.
- [ ] Each Provider has at most one active stored credential; a confirmed new login replaces the previous Provider entry atomically.
- [ ] Logout reports “Stored credential removed” and removes only the stored auth.json value.
- [ ] Authentication status separately reports stored, environment, models.json, command-derived, expired, unavailable, and effective source facts without returning secret values.
- [ ] A Pi-compatible auth.json import is validated and merged Provider by Provider, asking before each overwrite and preserving unselected existing credentials.
- [ ] UI and CLI credential mutations are serialized under the same authority and cannot lose concurrent updates.
- [ ] auth.json retains pinned Pi-compatible format, local restrictive permissions, and explicit malformed-file errors.
- [ ] Credential values never enter events, error messages, Diagnostics, public model catalogs, or masked status projections.
