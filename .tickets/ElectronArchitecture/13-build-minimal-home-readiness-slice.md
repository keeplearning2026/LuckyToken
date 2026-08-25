# 13 — Build minimal Home readiness slice

**What to build:** Give users one Home surface that opens from the tray, reads fresh Backend state, and tells them whether Token is ready and what action to take next.

**Blocked by:** 09 — Run Token as a tray-only Electron product; 12 — Expose the typed preload desktop contract.

**Status:** completed

- [x] Opening the management UI queries current Backend state rather than relying on retained renderer state from a previous window.
- [x] Home clearly distinguishes ready, starting, stopped, unavailable, and actionable-attention states using typed Backend facts.
- [x] The primary action invokes the appropriate typed desktop operation and reflects pending/result state without making the renderer an authority for gateway status.
- [x] Home behavior is fully testable with a fake Desktop API through real user interactions such as clicks and visible assertions.
- [x] The app shell establishes the new product navigation without recreating the old engineering-oriented page list.
