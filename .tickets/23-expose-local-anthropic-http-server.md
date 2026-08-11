# 23 — Expose the certified local Anthropic HTTP server

**What to build:** Bind the Provider-blind Web `Request`/`Response` Runtime to a real local Node HTTP listener, provide a CLI composition root, and prove the public endpoint through offline TCP/SDK tests plus an explicit real-provider online stress suite.

**Blocked by:** 22 — Hide concrete Providers behind Pi Models.

**Status:** pending

- [ ] A programmatic API listens on `127.0.0.1:3000` by default, supports port `0` for tests, reports its actual origin, and closes idempotently.
- [ ] The Node adapter owns only socket transport, converts one inbound request to the existing Web `Request` seam, mechanically emits the Web `Response`, and never passes Node request/response objects into Runtime, Auth, Pi, or Provider code.
- [ ] Client disconnect and server shutdown abort the request-local signal, prevent late writes, and do not affect another request.
- [ ] Real loopback tests cover JSON, Atomic SSE through the official Anthropic SDK, concurrent isolation, disconnect, shutdown, and recovery.
- [ ] The CLI composition root obtains Providers through the Pi configuration/registration layer and passes only constructed `Models` to Runtime; it does not define a second Provider configuration model.
- [ ] Server/client/limit configuration remains separate from Pi Provider/model configuration, and the complete startup configuration dies after composition.
- [ ] `npm start -- --config <path>` starts the listener, logs no secrets, supports `--help`, and shuts down on `SIGINT`/`SIGTERM`.
- [ ] The actual secret configuration is ignored; placeholder examples and Agent connection instructions are documented.
- [ ] Serving certification binds the WHATWG inbound boundary and its conformance record includes the real listener and CLI tests.
- [ ] `npm run test:online` reads the authorized secret only in memory and exercises a Provider through Pi Models and the official Anthropic SDK without logging secrets or response content.
- [ ] Full tests, typecheck, lint, build, diff check, and the online suite pass.
