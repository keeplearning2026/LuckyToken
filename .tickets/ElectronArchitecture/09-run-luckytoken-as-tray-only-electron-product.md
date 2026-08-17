# 09 — Run LuckyToken as a tray-only Electron product

**What to build:** Make Electron start into the intended lightweight tray state, creating the management UI only on demand and destroying it when the user closes the window.

**Blocked by:** 08 — Create Electron Main, preload, and packaging skeleton.

**Status:** completed

- [x] Normal desktop startup creates one tray icon and no BrowserWindow or renderer.
- [x] Opening LuckyToken from the tray creates exactly one management window; repeated open actions focus the same live window rather than creating duplicates.
- [x] Closing the management window destroys it instead of hiding it, while Electron Main and the tray remain alive.
- [x] Reopening after close creates a new BrowserWindow/renderer lifecycle rather than reviving retained renderer state.
- [x] An explicit product quit remains distinct from closing the management window.
