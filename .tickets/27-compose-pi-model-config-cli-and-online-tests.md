# 27 — Compose Pi model configuration, CLI, and online tests

**What to build:** Add the Pi-owned Provider/model configuration input and use it from a thin CLI composition root to start the certified local service and run explicitly authorized real-provider verification.

**Blocked by:** 26 — Certify Anthropic and Pi thinking round-trip.

**Status:** complete

- [x] Provider/model configuration is loaded through the Pi configuration layer; Runtime, Client Protocols, HTTP, Auth, and concrete Providers do not parse `models.json`.
- [x] One explicit Pi directory owns conventional `models.json` and `auth.json` paths while keeping their static-config and mutable-credential lifecycles separate.
- [x] Server/client/limit configuration remains separate from Pi Provider/model configuration and dies after startup composition.
- [x] The CLI receives constructed Pi `Models`, creates Client Protocol handlers and inbound Auth, then starts the Provider-blind Runtime/server.
- [x] The CLI exposes Pi login/logout as a thin interaction shell; auth method choices come only from each registered `Provider.auth` declaration.
- [x] `npm start -- --config <path>` logs no secrets, supports `--help`, and shuts down gracefully on `SIGINT`/`SIGTERM`.
- [x] Secret configuration is ignored by Git; only placeholder examples and connection instructions are committed.
- [x] `npm run test:online` uses the authorized secret only in memory and exercises CommandCode through Pi and an official Client Protocol SDK.
- [x] Online verification covers request controls, history, thinking, tools, usage/terminal semantics, JSON, Atomic SSE, concurrency, observed upstream cancellation, and recovery.
- [x] Online verification writes ignored real-wire samples containing controlled SDK requests/results/events and complete Provider request/raw JSONL evidence without credentials.
- [x] Failures that a healthy real Provider cannot produce deterministically remain explicit offline-only fault-injection cases.
- [x] Full tests, typecheck, lint, build, diff check, and the authorized online suite pass.
