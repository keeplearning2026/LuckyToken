# 13 — Build minimal Home readiness slice

**What to build:** Give users one Home surface that opens from the tray, reads fresh Backend state, and tells them whether LuckyToken is ready and what action to take next.

**Blocked by:** 09 — Run LuckyToken as a tray-only Electron product; 12 — Expose the typed preload desktop contract.

**Status:** ready-for-agent

- [ ] Opening the management UI queries current Backend state rather than relying on retained renderer state from a previous window.
- [ ] Home clearly distinguishes ready, starting, stopped, unavailable, and actionable-attention states using typed Backend facts.
- [ ] The primary action invokes the appropriate typed desktop operation and reflects pending/result state without making the renderer an authority for gateway status.
- [ ] Home behavior is fully testable with a fake Desktop API through real user interactions such as clicks and visible assertions.
- [ ] The app shell establishes the new product navigation without recreating the old engineering-oriented page list.
