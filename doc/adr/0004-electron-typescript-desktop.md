# ADR 0004: TypeScript-only Electron desktop and replaceable product shell

- Status: Accepted
- Date: 2026-08-18
- Supersedes: ADR 0001 desktop-shell decision and ADR 0003 Tauri tray/window implementation
- Refines: ADR 0002 desktop-adapter portion only; the Backend Runtime Supervisor and Control Plane lifecycle authority remain accepted
- Specification: `doc/Spec/LuckyTokenElectronArchitectureSpec.md`

## Context

LuckyToken's model-serving runtime, Client Protocol adapters, Pi integration, Provider system, management Control Plane, CLI, and most product state are TypeScript.

The current Tauri desktop inserts a Rust semantic client between the TypeScript Application Control Plane and TypeScript renderer. `control_plane_v1.rs`, `shell_bridge.rs`, and renderer-side projection code mirror parts of a contract that already exists in `@luckytoken/application-control-plane`. This creates contract drift risk and makes desktop work cross TypeScript/Rust/TypeScript boundaries even though Rust does not own model-serving semantics.

The product is also moving from an engineering-oriented management surface toward a user-facing desktop product. The required desktop behavior is:

- a Backend that remains usable without an open UI;
- a system tray that remains available while the product is active;
- a management window created only when needed;
- renderer destruction when the UI is closed, so React/renderer resources do not remain hidden in the background;
- deterministic UI automation with a fake management seam and a small real-product E2E layer;
- future Windows/macOS/Linux support without moving Core semantics into platform-specific runtimes.

LuckyToken does not require a second implementation language for these capabilities. Electron Main can use the existing TypeScript Control Plane client directly, while React remains the renderer technology.

## Decision

Replace the Tauri desktop with Electron and make TypeScript/JavaScript the only production implementation language in LuckyToken.

The target dependency direction is:

```text
React Renderer
      ↓
Typed preload interface
      ↓
Electron Main
      ↓
Application Control Plane client
      ↓
Application Control Plane host
      ↓
Backend Application
      ↓
LuckyToken Core
      ↓
Pi AI / Providers
```

### Core

The existing Core model-serving contract remains authoritative. Electron does not change Client Protocol ↔ Pi ↔ Provider semantics.

Core has no Electron, desktop, local-management-transport, or OS dependency.

### Backend Application

Application composition/lifecycle is extracted from CLI orchestration behind one Backend Application seam. It owns the Core runtime, Data Plane supervisor, persistent authorities, Control Plane host, discovery, ownership, and graceful shutdown.

The CLI becomes an adapter rather than the application composition root.

### Application Control Plane

The versioned Application Control Plane remains the only management seam into a running Backend for both CLI management and Electron Desktop.

Electron Main uses the TypeScript `ControlPlaneClient` directly. There is no Rust/native mirror and no Electron-specific duplicate semantic DTO model.

The local endpoint becomes transport-neutral `{ address, capability }`. The old `pipeName` contract is not retained for compatibility.

Production local IPC uses Node `node:net`: Windows uses a named-pipe path; macOS/Linux use Unix-domain-socket paths. Capability authentication is mandatory before management operations. Descriptor/capability facts remain in trusted Backend/Main/CLI contexts and never enter the renderer.

### Electron Main

Electron Main owns only desktop lifecycle and OS integration:

- single desktop instance;
- tray;
- Backend process supervision/attachment;
- Control Plane connection lifecycle;
- BrowserWindow create/show/focus/destroy;
- notification, auto-start, dialogs, and safe external URL opening;
- typed IPC handlers.

It does not mutate Backend/Core authorities directly.

### Preload

Preload exposes one fixed typed `LuckyTokenDesktopApi` through `contextBridge`.

No generic `ipcRenderer`, `invoke(channel, payload)`, or arbitrary channel access is exposed to renderer code. Control Plane semantic types are reused rather than copied into Electron DTOs.

### Renderer

React renderer owns product interaction state only. Backend facts remain Backend-authoritative.

The target top-level product information architecture is:

```text
Home
Providers
Connect
Activity
Settings
```

Renderer tests use a fake `LuckyTokenDesktopApi` and do not require Electron, local IPC, or a real Backend.

### Tray and window lifecycle

Electron Main and the Backend remain active in normal background operation. No BrowserWindow exists until the user opens the UI.

Closing the management window destroys it rather than hiding it:

```text
close UI
→ unsubscribe renderer bridges
→ destroy BrowserWindow
→ renderer exits
→ Backend + Electron Main + tray remain
```

Reopening creates a new renderer which queries fresh authoritative state through the Control Plane.

Explicit LuckyToken shutdown remains ownership-aware and goes through the Application Control Plane graceful-shutdown contract; Electron does not directly kill a Backend merely because it spawned it.

### No compatibility layer

The migration is replacement-only. After Electron behavior is certified, delete:

- `packages/desktop-shell/src-tauri/`;
- `packages/control-pipe-win-native/`;
- Tauri dependencies/config/build scripts;
- Rust Control Plane DTO/codec/bridge code;
- old shell-revision/projection compatibility code;
- old desktop configuration compatibility paths.

Do not maintain Tauri and Electron in parallel as supported product paths.

## Consequences

### Positive

- one production business language;
- Application Control Plane has one semantic/wire implementation;
- Electron is replaceable without changing Core;
- Core remains testable independently through `Request → Response`;
- Backend lifecycle becomes testable independently from CLI/Desktop;
- renderer feature tests can click through product behavior with a deterministic fake preload interface;
- Electron E2E can exercise real BrowserWindow/preload behavior without requiring online Providers;
- renderer resources can be released completely while tray and Backend remain active;
- cross-platform local IPC can remain behind one Node transport seam.

### Costs

- Electron Main has a non-zero resident resource cost while tray-only;
- the existing Tauri desktop and native pipe implementation must be replaced rather than incrementally reused;
- removing the Win32 DACL implementation changes the local-management security model so the cryptographic capability becomes the explicit application-level authorization authority;
- installer/signing/updater work must be re-established for Electron releases.

These costs are accepted because maintainability, contract locality, product iteration speed, deterministic GUI automation, and a single TypeScript architecture are higher priorities for LuckyToken than preserving the existing Tauri implementation.

## Verification

The migration is not complete until tests prove:

1. Core has no Electron/Control Plane dependency.
2. renderer has no Electron/Node/local-transport dependency.
3. Electron Main has no deep Core-domain dependency.
4. Control Plane semantic types are not reimplemented in Rust or Electron DTOs.
5. startup can reach tray-only state with no BrowserWindow.
6. opening the tray creates the UI; closing it destroys the renderer while Backend requests still work.
7. reopening reconstructs fresh state.
8. first successful request is covered by product E2E.
9. Tauri/Rust production code and build dependencies are removed.
