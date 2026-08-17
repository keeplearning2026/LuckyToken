# 18 — Certify destroy-and-reopen fresh-state lifecycle

**What to build:** Prove that closing the management UI really releases renderer-owned runtime state while LuckyToken continues serving in tray mode, and that reopening reconstructs the UI from fresh Backend authority.

**Blocked by:** 11 — Add Main ControlPlaneSession lifecycle; 13 — Build minimal Home readiness slice.

**Status:** ready-for-agent

- [ ] Closing the management window destroys the BrowserWindow and renderer rather than hiding or retaining them.
- [ ] Renderer-owned subscriptions and event bridges are released when the window is destroyed, with no duplicate delivery after repeated open/close cycles.
- [ ] Backend and tray remain operational while no renderer exists, and model-serving behavior is unaffected by UI closure.
- [ ] Reopening creates a new renderer that queries current state and reflects Backend changes that occurred while the UI was closed.
- [ ] Real Electron automation proves repeated open/close/reopen cycles without leaked windows, stale state, or duplicated subscriptions.
