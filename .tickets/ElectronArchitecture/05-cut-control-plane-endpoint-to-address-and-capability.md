# 05 — Cut Control Plane endpoint to address and capability

**What to build:** Replace the Windows-specific Control Plane endpoint contract with a transport-neutral local address plus cryptographic capability, and move production Control Plane traffic onto the pure TypeScript local IPC transport.

**Blocked by:** 04 — Introduce pure TypeScript local IPC adapter.

**Status:** ready-for-agent

- [ ] The authoritative endpoint contract contains only a transport-neutral address and capability; the old pipe-specific field is no longer accepted or emitted.
- [ ] Discovery, client connection, host startup, and descriptor publication all use the new endpoint contract end to end.
- [ ] Windows local IPC continues to function through a Node named-pipe address without leaking that representation into semantic Control Plane code.
- [ ] No compatibility reader, dual endpoint shape, migration fallback, or deprecated alias remains for the old endpoint contract.
- [ ] Existing Control Plane command/query/event behavior stays unchanged apart from the endpoint representation.
