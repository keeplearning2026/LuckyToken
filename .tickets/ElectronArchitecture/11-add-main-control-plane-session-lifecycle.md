# 11 — Add Main ControlPlaneSession lifecycle

**What to build:** Make Electron Main manage one typed Application Control Plane client session for connection, reconnection, operations, and subscriptions without reimplementing the contract.

**Blocked by:** 07 — Certify capability-authenticated Control Plane on pure TS IPC; 10 — Add BackendSupervisor attach-or-spawn lifecycle.

**Status:** ready-for-agent

- [ ] Main connects through the existing TypeScript Control Plane client after Backend attachment and exposes typed operations without a second wire decoder.
- [ ] Connection loss produces a deterministic unavailable/reconnecting state and a successful reconnect resumes from a fresh authoritative snapshot.
- [ ] Status and feature subscriptions have explicit ownership and are released on session replacement or desktop shutdown.
- [ ] Descriptor address and capability remain private to trusted Main/Control Plane code and never become renderer state.
- [ ] Tray health is derived from a minimal safe projection rather than by handing the tray the full Backend snapshot.
