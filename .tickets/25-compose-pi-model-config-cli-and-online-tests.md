# 25 — Compose Pi model configuration, CLI, and online tests

**What to build:** Add the Pi-owned Provider/model configuration input and use it from a thin CLI composition root to start the certified local service and run explicitly authorized real-provider verification.

**Blocked by:** 24 — Expose the certified local HTTP server.

**Status:** pending

- [ ] Provider/model configuration is loaded through the Pi configuration layer; Runtime, Client Protocols, HTTP, Auth, and concrete Providers do not parse `models.json`.
- [ ] Server/client/limit configuration remains separate from Pi Provider/model configuration and dies after startup composition.
- [ ] The CLI receives constructed Pi `Models`, creates Client Protocol handlers and inbound Auth, then starts the Provider-blind Runtime/server.
- [ ] `npm start -- --config <path>` logs no secrets, supports `--help`, and shuts down gracefully on `SIGINT`/`SIGTERM`.
- [ ] Secret configuration is ignored by Git; only placeholder examples and connection instructions are committed.
- [ ] `npm run test:online` uses the authorized secret only in memory and exercises CommandCode through Pi and an official Client Protocol SDK.
- [ ] Full tests, typecheck, lint, build, diff check, and the authorized online suite pass.
