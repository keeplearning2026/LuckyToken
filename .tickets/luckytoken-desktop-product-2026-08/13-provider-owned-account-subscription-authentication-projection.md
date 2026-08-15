# 13 — Provider-owned account/subscription authentication projection

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Let users complete account, subscription, OAuth, device-code, and other interactive Provider login flows without putting Provider-specific authentication logic in the desktop renderer. The UI offers “Use an account or subscription” and “Use an API key,” identifies genuine subscription flows from Provider metadata, and faithfully projects Provider-owned AuthInteraction prompts/events.

**Blocked by:** 11 — Model catalog cache, refresh, and Provider error isolation; 12 — API-key credential management and effective authentication status.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm Credential Management/AuthInteraction commands and typed interaction events as the seam. Drive controlled Providers through one prompt/event behavior per red → green cycle; do not test renderer-specific dialogs or hardcode real Provider OAuth.

## Acceptance criteria

- [ ] The top-level choices are “Use an account or subscription” and “Use an API key”; only Provider metadata can label a flow as a true subscription.
- [ ] Browser auth URLs are opened automatically when possible and remain visible/copyable with manual fallback.
- [ ] Device-code flows open the verification page when possible and display/copy the user code with instructions.
- [ ] Manual code, select, text, secret, progress, info, cancellation, and failure interactions round-trip through the Provider-owned AuthInteraction contract.
- [ ] The renderer contains no Provider ID branches that implement Provider-specific OAuth or API-key protocols.
- [ ] Successful login atomically replaces the Provider credential, refreshes effective auth status, and schedules catalog refresh.
- [ ] Refresh failure or expired login produces actionable non-secret state without deleting a still-valid unrelated Provider credential.
- [ ] Contract tests cover browser callback, device code, manual code, select, text, secret, progress, cancel, replacement, refresh, logout, and ambient authentication.
