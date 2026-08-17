# 07 — Certify capability-authenticated Control Plane on pure TS IPC

**What to build:** Prove that the pure TypeScript local IPC Control Plane is secure and lifecycle-correct before Electron depends on it.

**Blocked by:** 05 — Cut Control Plane endpoint to address and capability.

**Status:** ready-for-agent

- [ ] A client must authenticate with the endpoint capability before any status, command, query, or subscription result can be observed.
- [ ] Invalid or missing capability attempts fail closed and reveal no application state.
- [ ] Hello ordering, malformed-message rejection, disconnect, reconnect, and request correlation remain deterministic on the new transport.
- [ ] Status and long-lived subscription lifecycles clean up correctly when either side closes or the transport is lost.
- [ ] Contract tests remain transport-independent while a focused real-local-IPC suite certifies the production adapter.
