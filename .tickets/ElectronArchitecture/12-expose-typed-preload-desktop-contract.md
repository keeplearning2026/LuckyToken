# 12 — Expose the typed preload desktop contract

**What to build:** Give the renderer a fixed, typed Token Desktop API that exposes only named product operations and safe platform capabilities through preload.

**Blocked by:** 11 — Add Main ControlPlaneSession lifecycle.

**Status:** completed

- [x] Renderer-facing control operations reuse Application Control Plane semantic types instead of introducing Electron-specific domain DTOs.
- [x] Platform operations such as auto-start, dialogs, and external URL opening are separate from Backend management operations.
- [x] The renderer cannot access raw `ipcRenderer`, generic channel invocation, Node built-ins, descriptor address, capability, filesystem handles, or Electron objects.
- [x] Main validates IPC sender/context before executing privileged operations.
- [x] The complete renderer contract can be replaced by a deterministic fake for feature tests without starting Electron or Backend.
