# 02 — Windows Desktop Shell and empty Dashboard

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Provide the first native Windows management experience. Opening LuckyToken starts a thin desktop shell, connects it to the active local Control Plane, and shows an intentionally empty Dashboard with stable navigation to Dashboard, Requests, Analytics, Providers, Models & Aliases, Client Tokens, Diagnostics, and Settings/Developer Lab.

**Blocked by:** 01 — Versioned local Control Plane status tracer.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm the thin Windows shell lifecycle smoke seam and the Control Plane snapshot seam before testing. Drive shell behavior through its public host interface; do not couple tests to renderer component trees or CSS structure.

## Acceptance criteria

- [ ] Launching the Windows desktop executable opens one main window connected to the local Control Plane.
- [ ] First launch shows an empty Dashboard without an onboarding wizard, forced Provider selection, or modal setup flow.
- [ ] All eight approved product pages have stable navigation entries and can be opened even when their capability is not configured.
- [ ] The shell renders connection/version errors from the Control Plane as actionable application state rather than crashing.
- [ ] No credential, Client token, raw capture, or internal mutable application object is placed in renderer startup arguments.
- [ ] The chosen desktop host, packaging approach, and control transport are recorded as an architecture decision before their implementation becomes a dependency for later tickets.
- [ ] A Windows lifecycle smoke test proves launch, connection, navigation, and clean window disposal through public shell behavior.
