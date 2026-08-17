# 20 — Release-certify first successful request and tray-only operation

**What to build:** Make the Electron product release-blocking journey prove that a fresh user can connect a Provider, configure a supported client, complete a first successful request, and keep using LuckyToken after the UI is closed into tray-only mode.

**Blocked by:** 19 — Cut over completely from Tauri/Rust to Electron.

**Status:** ready-for-agent

- [ ] A clean product state can launch into tray mode, open the UI, connect/login a Provider, and reach a usable model state through visible product workflows.
- [ ] The user can configure the supported Codex integration, run a real local request path, and observe the successful request in Activity.
- [ ] Closing the UI removes the BrowserWindow/renderer while the Backend remains able to serve model requests; reopening reconstructs current state correctly.
- [ ] Release certification records process count, working/private memory, idle CPU, and UI cold-open behavior for Backend-only, tray-only, and UI-open states so retained renderers or accidental background UI are detectable.
- [ ] The golden journey is a release blocker; failure of first-successful-request or tray-only background operation prevents release.
- [ ] Online Provider verification, when required, remains explicitly authorized and separate from the deterministic default product certification path.
