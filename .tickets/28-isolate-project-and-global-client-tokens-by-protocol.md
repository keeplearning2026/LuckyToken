# 28 — Isolate project and global client tokens by Client Protocol

**What to build:** Replace the single configured inbound client key with one
Auth-owned token file per Client Protocol, including global and project-bound
scopes, a protocol-neutral CLI lifecycle, and real-provider conformance evidence.

**Blocked by:** 27 — Compose Pi model configuration, CLI, and online tests.

**Status:** complete

- [x] Each configured Client Protocol has an independent strict token file and immutable startup Auth snapshot.
- [x] Generic Auth, Runtime, Pi, and Providers do not receive protocol IDs, token-file state, or token classifications.
- [x] Global tokens yield no project fact; project tokens yield exactly one normalized absolute `projectDir`.
- [x] The legacy `client.apiKey/client.projectDir` configuration is removed without migration or fallback.
- [x] CLI create/rotate/remove/list supports generated and explicit tokens without cross-protocol lookup.
- [x] Missing, malformed, empty, and aliased protocol token files fail closed.
- [x] Real TCP and official Anthropic SDK tests prove global/project scope, rotation/revocation, restart snapshots, and isolation.
- [x] Real CommandCode online conformance captures global and project scope evidence through Pi.
- [x] Architecture, examples, README, serving certification, and immutable conformance binding are updated.
- [x] Full tests, typecheck, lint, build, diff check, and authorized online verification pass.
