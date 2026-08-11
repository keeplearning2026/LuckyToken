# 25 — Integrate Pi login and persistent credentials

**What to build:** Expose Pi's existing Provider authentication lifecycle to LuckyToken without modifying the vendored Pi AI package, and provide the persistent credential capability required for login to survive process restarts.

**Blocked by:** 24 — Expose the certified local HTTP server.

**Status:** complete

- [x] `pi-agent/packages/ai` remains upstream-clean; LuckyToken consumes only its public `Provider.auth`, `Models.login/logout`, and `CredentialStore` contracts.
- [x] A LuckyToken-owned file credential store validates `auth.json`, preserves one credential per Provider, serializes mutations across processes, honors cancellation, and does not expose secret values through listing or errors.
- [x] CommandCode Private declares API-key login through its Pi `Provider.auth` contract and resolves a stored Pi credential before an optional configured fallback key.
- [x] CommandCode Private does not advertise OAuth or subscription login because its certified upstream wire profile has no such credential contract.
- [x] Public-boundary tests prove `Models.login/logout` persistence across new store/Models instances and prove that a stored credential reaches CommandCode only through Pi's request-auth preparation.
- [x] Tests, typecheck, lint, build, and diff check pass.
