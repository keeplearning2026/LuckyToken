# 26 — Complete Windows product release certification

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Prove and package the complete agreed Windows-first LuckyToken product. Release certification exercises the installed desktop/headless application, local Control Plane, both default Client Protocols, Provider authentication/configuration, aliases, tokens, request observability, Analytics, Diagnostics, backup, and owner-aware lifecycle. No partial product release is permitted.

**Blocked by:** 05 — Headless ownership and graceful application exit; 06 — Settings-driven protocol, port, and LAN controls; 11 — Model catalog cache, refresh, and Provider error isolation; 13 — Provider-owned account/subscription authentication projection; 15 — Alias-only Model Data Plane; 17 — Canonical directory Client token scopes; 21 — Filterable Provider and total Analytics; 24 — Safe backup and incompatible-configuration refusal; 25 — Actionable desktop notifications and tray aggregate state.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill for every missing certification behavior. Confirm the installed-product Control Plane, real local Data Plane HTTP, and thin Windows lifecycle smoke seams. Add one failing release scenario at a time and keep online verification limited to explicitly authorized Provider facts that cannot be reproduced offline.

## Acceptance criteria

- [ ] A clean Windows installation launches the tray application, opens an empty Dashboard, uses the LuckyToken-owned user root, and can enable Windows login auto-start.
- [ ] Certification covers desktop-owned and headless-owned instances, attachment, Close-to-tray, Show, Start/Stop/Restart, graceful Quit drain, timeout abort, and single-instance behavior.
- [ ] Anthropic Messages and OpenAI Responses are both exercised through alias discovery/routing, global and directory tokens, request IDs, success/error rendering, cancellation, and native-passthrough alias symmetry.
- [ ] At least one account/subscription login and one API-key login are exercised through Provider-owned interaction, replacement/logout, effective auth status, and catalog refresh.
- [ ] A custom models.json Provider, pinned composition semantics, model cache/refresh/error isolation, alias hot update, and token immediate rotation are covered.
- [ ] Requests, normalized complete/partial usage, Analytics coverage, Diagnostics, Deep Diagnostics retention/redaction, export/delete, safe/full backup, and persistence failure are covered end to end.
- [ ] LAN confirmation proves only model routes become remotely reachable; Control Plane, secret reveal, history, and Developer Lab remain local-only.
- [ ] Distribution checks verify packaging, restrictive sensitive-file handling, incompatible-config refusal, no secret canaries in artifacts/logs, and stable fixed-port behavior.
- [ ] Offline deterministic tests are the default; any authorized online evidence is sanitized and records Provider/version provenance.
- [ ] Release is blocked until every ticket in this bundle is complete and the full certification suite passes; no reduced-scope first release is published.
