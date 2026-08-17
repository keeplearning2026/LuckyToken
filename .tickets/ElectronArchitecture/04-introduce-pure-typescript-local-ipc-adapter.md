# 04 — Introduce pure TypeScript local IPC adapter

**What to build:** Provide a deterministic pure-TypeScript local IPC transport that can carry the existing framed Control Plane protocol without requiring Rust or platform-specific semantic code.

**Blocked by:** 01 — Freeze migration seams and architecture guards.

**Status:** completed

- [x] The Control Plane transport interface has a Node-based local IPC adapter for server and client connections with bounded reads, writes, close, and disconnect behavior.
- [x] Framing and transport failure behavior are verifiable with deterministic tests that do not require Electron.
- [x] Platform-specific address creation is isolated from Control Plane commands, results, projections, and event semantics.
- [x] Existing semantic Control Plane tests can run against an injected non-native transport without learning Windows-specific pipe details.
