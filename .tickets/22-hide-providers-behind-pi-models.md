# 22 — Hide concrete Providers behind Pi Models

**What to build:** Make Pi `Models` the only Provider-facing dependency of LuckyToken Core so every current and future Provider remains cohesive behind the same Pi contract.

**Blocked by:** 21 — Certify and freeze the serving composition.

**Status:** complete

- [x] `LuckyTokenRuntime` receives constructed Pi `Models` and inbound `Auth`; it does not construct or identify a concrete Provider.
- [x] Runtime, HTTP, Execution, model resolution, options, and Anthropic modules do not import `src/providers/**` or contain concrete Provider identities.
- [x] Startup-only code registers Providers through Pi `MutableModels.setProvider(...)`; the published Runtime exposes only `handle(Request)`.
- [x] Two unrelated Pi Providers can be registered together and are selected and dispatched without Runtime changes or request-state leakage.
- [x] Concrete Provider credentials, endpoint policy, capabilities, and dependency snapshots remain owned by the Provider factory.
- [x] Concrete serving certification is a sibling of Runtime and is not imported by HTTP/Core execution.
- [x] Generic Pi invocation freezing is owned by Core execution rather than a concrete serving certification module.
- [x] Architecture, integration, certification, typecheck, lint, build, and diff validation pass.
