# 24 — Expose the certified local HTTP server

**What to build:** Bind the Client-Protocol- and Provider-blind Web `Request`/`Response` Runtime to a real local Node HTTP listener and prove it through offline TCP and official SDK tests.

**Blocked by:** 23 — Isolate Client Protocols behind Pi IR.

**Status:** pending

- [ ] A programmatic API listens on `127.0.0.1:3000` by default, supports port `0` for tests, reports its actual origin, and closes idempotently.
- [ ] The Node adapter owns only socket transport and mechanically converts Node HTTP to WHATWG `Request`/`Response`.
- [ ] Client disconnect and server shutdown abort request-local signals, prevent late writes, and do not affect another request.
- [ ] Real loopback tests cover raw bytes, JSON, official SDK parsing, Atomic SSE, concurrency, disconnect, shutdown, and recovery.
- [ ] The package root exports the programmatic server and Runtime APIs while concrete Providers remain explicit subpath exports.
- [ ] Serving conformance binds the WHATWG boundary and real listener evidence.
- [ ] Full offline tests, typecheck, lint, build, and diff validation pass.
