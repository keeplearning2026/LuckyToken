# LuckyToken Electron Product Architecture Specification v1.0

**Status:** ACCEPTED TARGET ARCHITECTURE — implementation pending  
**Date:** 2026-08-18  
**Scope:** LuckyToken product/runtime boundaries, Electron desktop, local management transport, testing seams, and migration from the current Tauri desktop  
**Related specifications:**

- [LuckyToken Core Architecture Specification](./LuckyTokenCoreSpec.md)
- [LuckyToken Provider Activation Specification](./LuckyTokenProviderActivationSpec.md)
- [LuckyToken implementation architecture map](../LuckyTokenArchitecture.md)
- [ADR 0004 — TypeScript-only Electron desktop](../adr/0004-electron-typescript-desktop.md)
- [Repository architecture rules](../../AGENTS.md)

This specification defines the target product architecture after replacing the current Tauri desktop with Electron.

It does **not** redefine LuckyToken protocol semantics. The existing Core rule remains authoritative:

```text
Client Wire ↔ Client Protocol adapter ↔ Pi AI IR ↔ Provider adapter ↔ Upstream Wire
```

The Electron migration exists to simplify the product boundary, remove duplicated Rust/TypeScript Control Plane semantics, enable deterministic GUI automation, and keep one authoritative owner for every fact.

---

# 1. Architectural decisions

The following decisions are fixed for this migration.

## 1.1 TypeScript is the product implementation language

LuckyToken production code is TypeScript/JavaScript plus web UI assets.

The target repository contains no Rust production path:

```text
Tauri                         removed
src-tauri                     removed
Rust Control Plane client     removed
Rust shell bridge             removed
Rust native control pipe      removed
Cargo build chain             removed
```

No compatibility layer is kept for the removed Tauri/Rust implementation.

## 1.2 Existing Core semantics are protected, not rewritten

`LuckyTokenRuntime` already exposes the correct deep request seam:

```ts
export interface LuckyTokenRuntime {
  handle(request: Request): Promise<Response>;
  readonly routes: ReadonlyArray<Readonly<{
    method: string;
    pathname: string;
  }>>;
}
```

The Electron migration must not alter Anthropic/OpenAI Responses/Pi/Provider semantics merely to satisfy the desktop.

If desktop work requires Core internals to understand Electron, IPC, tray state, window state, or renderer terminology, the seam is wrong.

## 1.3 Four modules own four different concerns

The target architecture has four principal modules:

```text
1. LuckyToken Core
2. Backend Application
3. Application Control Plane
4. Electron Desktop
```

Each module has one stable external seam and may contain private internal seams.

## 1.4 The Application Control Plane is the only management seam into a running Backend

Electron Main and CLI management commands must not import and mutate Backend/Core internals directly.

All management of a running LuckyToken instance flows through the versioned Application Control Plane.

```text
Electron Desktop ─┐
                  ├── Application Control Plane ── Backend Application
CLI management ───┘
```

## 1.5 Electron is a product shell, not a second application authority

Electron Main owns desktop lifecycle and OS integration only.

It does not own:

- Provider state;
- credentials;
- model catalog;
- aliases;
- settings authority;
- request ledger;
- diagnostics;
- protocol conversion;
- model execution.

Those facts remain Backend-owned.

## 1.6 Renderer owns interaction state, never authoritative Backend state

The React renderer may own ephemeral interaction facts such as:

- selected page/tab;
- open dialog;
- unsaved form draft;
- local filter text;
- pending button state;
- onboarding step.

It must not become the authority for Backend facts.

Closing the UI destroys the renderer. Reopening the UI queries fresh Backend state.

## 1.7 No duplicate semantic contract

A semantic type is defined once at its owning seam.

Specifically:

- Electron does not reimplement Control Plane wire decoding;
- preload does not define alternate Models/Credentials/Catalog DTOs;
- renderer does not duplicate Backend domain schemas;
- no schema/code generator is introduced merely to maintain two semantic implementations.

## 1.8 No backward compatibility for the old desktop contract

This migration intentionally breaks the old desktop implementation.

Do not preserve:

- Tauri commands;
- Tauri event names;
- Rust DTOs;
- shell revision compatibility;
- `pipeName` solely for the old Windows transport model;
- old desktop configuration fields;
- old renderer projection shapes.

Once the replacement behavior is certified, the old implementation is deleted rather than adapted.

---

# 2. Architecture overview

## 2.1 Dependency direction

Static dependency direction is one-way:

```text
React Renderer
      │
      ▼
Desktop preload contract
      │
      ▼
Electron Main
      │
      ▼
Application Control Plane client
      │
      ▼
Application Control Plane host
      │
      ▼
Backend Application
      │
      ▼
LuckyToken Core
      │
      ▼
Pi AI / Provider contracts
```

The diagram describes allowed knowledge, not every runtime callback.

Forbidden reverse dependencies include:

```text
Core → Electron                         forbidden
Core → renderer                         forbidden
Core → Application Control Plane        forbidden
Provider → Desktop                      forbidden
Renderer → Node built-ins               forbidden
Renderer → Electron                     forbidden
Renderer → Core internals               forbidden
Electron Main → Core internals          forbidden
Electron Main → credential/model files  forbidden
```

## 2.2 Runtime process model

The normal installed product has three runtime contexts:

```text
Process A — LuckyToken Backend
  Node.js / TypeScript
  always running while LuckyToken is active

Process B — Electron Main
  tray + desktop lifecycle
  normally always running while LuckyToken is active

Process C — Electron Renderer
  exists only while the management window is open
```

Preload executes with the renderer lifecycle but forms a privileged security seam.

Normal lightweight tray state:

```text
LuckyToken Backend      running
Electron Main           running
Tray                    running
BrowserWindow           absent
Renderer                absent
React                   absent
```

UI-open state:

```text
LuckyToken Backend      running
Electron Main           running
Tray                    running
BrowserWindow           present
Renderer                present
React                   present
```

Closing the management window destroys the `BrowserWindow`; it does not merely hide it.

---

# 3. Module 1 — LuckyToken Core

## 3.1 Responsibility

Core owns model-serving semantics:

```text
Client Protocol request
    ↓
validation / representability
    ↓
Pi Context + invocation controls
    ↓
model / alias resolution
    ↓
Pi Models / Provider execution
    ↓
Pi AssistantMessage / execution failure
    ↓
Client Protocol response
```

Core also owns protocol-neutral request execution rules required to make this path correct.

## 3.2 External seam

The primary runtime seam remains:

```ts
export interface LuckyTokenRuntime {
  handle(request: Request): Promise<Response>;
  readonly routes: ReadonlyArray<Readonly<{
    method: string;
    pathname: string;
  }>>;
}
```

Creation may accept injected capabilities and authorities, but callers must not need to understand internal protocol conversion state.

The Core public package must expose the smallest set of constructors/types required to compose a serving runtime. Internal helpers are not package exports.

## 3.3 Core owns

- Client Protocol conversion semantics;
- Pi runtime invocation semantics;
- model selection semantics;
- alias request resolution semantics;
- Provider invocation integration;
- request cancellation/timeout semantics belonging to request execution;
- protocol-visible response/error rendering semantics.

## 3.4 Core does not own

- Electron;
- tray/window lifecycle;
- OS startup integration;
- process ownership;
- local management transport;
- Control Plane framing;
- CLI argument parsing;
- installer/updater;
- UI workflows.

## 3.5 Core tests

Core tests operate at public semantic seams whenever practical:

```text
Request → Response
Pi contract → Provider behavior
Client Wire ↔ Pi behavior
```

They do not need Electron, local IPC, or a real desktop process.

---

# 4. Module 2 — Backend Application

## 4.1 Responsibility

Backend Application is the product composition/lifecycle authority.

It composes and owns long-lived application capabilities:

- Core runtime;
- HTTP Data Plane server;
- Runtime Supervisor;
- application configuration;
- credential authority;
- model/catalog authorities;
- alias authority;
- request ledger;
- diagnostics and deep capture stores;
- persistence degradation/recovery;
- backup/history authorities;
- Backend `InstanceAuthority` / `InstanceLease` for current-user singleton ownership;
- Application Control Plane host;
- `DiscoveryPublication` for the current Control Plane endpoint;
- application ownership and graceful shutdown.

It is a composition root, not a second protocol layer.

## 4.2 Backend instance authority

Backend singleton correctness is Backend-owned and is independent from Control Plane discovery.

The production authority is a dedicated LuckyToken-owned local SQLite lock carrier:

```text
~/.luckytoken/instance.sqlite
```

The file's existence has no ownership or liveness meaning. `InstanceAuthority.acquire()` holds a `BEGIN IMMEDIATE` transaction through one private `DatabaseSync` connection for the complete Backend lifetime. The `InstanceLease` is the final Backend-lifetime resource released during teardown.

```ts
export interface InstanceAuthority {
  acquire(): Promise<InstanceLease>;
}

export interface InstanceLease {
  close(): Promise<void>;
}
```

The authority has no stale timeout, heartbeat, PID probing, steal operation, owner metadata, or file deletion. Its lock carrier must remain on LuckyToken-owned local filesystem storage and must not be reused as a business database, backup source, diagnostics source, or generic file-scanning target. Production Backend discovery belongs to that same current-user application domain (`~/.luckytoken/control-plane.json`) and is not a configurable `serve` argument; only management clients may accept an explicit descriptor path for navigation.

The same SQLite primitive certification must run on every supported release platform. Windows is certified by the repository's real-process certification and packaged-product tests. macOS and Linux remain structurally supported but are not certified until the same process contention, event-loop suspension, crash-release, normal-release, concurrent-contender, and same-process multi-connection cases run on real hosts for those platforms.

A Backend that cannot acquire the authority is not allowed to become an application authority. It waits for the active owner's discovery publication and attaches through the Control Plane instead. Arbitration remains live across owner turnover: if the owning process disappears before publishing a usable Control Plane, the contender retries `InstanceAuthority.acquire()` and may become the new Backend authority only after the previous process-lifetime lock is gone.

Backend startup ordering is:

```text
acquire InstanceLease
    ↓
load/validate configuration
    ↓
construct management authorities
    ↓
start Control Plane listener
    ↓
publish DiscoveryPublication
============================ Management Ready
    ↓
start Data Plane / background work
============================ Running or Degraded
```

Teardown keeps the `InstanceLease` until all other Backend-lifetime resources have stopped or closed.

## 4.3 Target external seam

The target application interface is intentionally small:

```ts
export interface RunningLuckyTokenApplication {
  readonly ownership: ApplicationOwnership;
  readonly exited: Promise<ApplicationExit>;

  requestShutdown(reason: ApplicationShutdownReason): Promise<ApplicationExit>;
  close(): Promise<void>;
}

export interface StartLuckyTokenApplicationOptions {
  readonly configPath: string;
  readonly ownerKind: "cli" | "desktop";
  readonly shutdownSignal?: AbortSignal;
}

export function startLuckyTokenApplication(
  options: StartLuckyTokenApplicationOptions,
): Promise<RunningLuckyTokenApplication>;
```

Names may change during TDD, but the interface must retain these properties:

1. callers start one application, not dozens of stores manually;
2. lifecycle ownership is explicit;
3. cleanup is one operation;
4. internal authorities are not broadly exposed;
5. Electron does not call this interface in-process — the desktop starts the Backend process and then uses Control Plane.

## 4.4 Current source consolidation

Current `src/cli.ts::runServe()` contains substantial application composition and should not remain the product composition root.

The migration extracts application startup/lifecycle from CLI parsing into the Backend Application module.

CLI becomes an adapter:

```text
parse args
   ↓
startLuckyTokenApplication(...)
   or
connect Control Plane client
   ↓
render CLI result
```

## 4.5 Backend tests

Backend Application integration tests verify:

- boot and cleanup;
- one authoritative instance through `InstanceAuthority` rather than descriptor ownership;
- recovery-only boot;
- Data Plane supervisor lifecycle;
- Control Plane remains alive while Data Plane is stopped/failed;
- persistence authority ownership;
- graceful shutdown/drain;
- deterministic injected transport/store adapters where applicable.

They do not assert Electron UI structure.

---

# 5. Module 3 — Application Control Plane

## 5.1 Responsibility

The Application Control Plane defines the versioned management contract for a running Backend.

It owns:

- management commands;
- management queries;
- ordered management events;
- strict wire validation;
- request correlation;
- subscription lifecycle;
- bounded/sanitized management projections;
- transport-independent client/host behavior.

It does **not** own the underlying application facts. It projects and invokes owning Backend authorities.

## 5.2 Existing seam is retained

The existing `ControlPlaneClient` is the correct architectural seam and remains the foundation.

Examples include:

```ts
getStatus()
executeRuntimeCommand(...)
executeSettingsCommand(...)
executeCredentialCommand(...)
executeAuthCommand(...)
executeModelsCommand(...)
executeCatalogCommand(...)
executeAliasCommand(...)
getRequestLedger(...)
getAnalytics(...)
subscribe(...)
close()
```

Electron Main uses this TypeScript client directly.

There is no native mirror of these types or decoders.

## 5.3 Semantic contracts versus wire implementation

The package has two conceptual layers:

```text
semantic contract
  commands / results / projections / events

wire implementation
  frame / encode / decode / request correlation / transport
```

The Desktop shared/preload contract may type-import and reuse exported **semantic types** from the Control Plane package. Renderer feature code imports the Desktop API contract, not the Control Plane client or wire implementation directly.

Renderer code must not import Control Plane framing, transport, request correlation, descriptor discovery, wire decoders, or the concrete `ControlPlaneClient` implementation.

## 5.4 Local endpoint contract

The current Windows-specific endpoint:

```ts
{ pipeName, capability }
```

is replaced by a transport-neutral endpoint:

```ts
export interface ControlPlaneEndpoint {
  readonly address: string;
  readonly capability: string;
}
```

`address` is opaque outside the local transport/discovery implementation.

The migration does not support both `pipeName` and `address`.

## 5.5 Pure TypeScript local transport

The production transport is implemented with Node `node:net` IPC:

```text
Windows       → named-pipe path
macOS/Linux   → Unix-domain-socket path
```

Control Plane semantics do not branch on platform.

Platform-specific endpoint creation lives in the local transport/discovery adapter only.

## 5.6 Security authority

With the native Windows DACL module removed, authorization must not depend on a private Rust/Win32 transport implementation.

The local management security contract becomes explicit:

1. discovery descriptor is stored in the current user's private LuckyToken data directory;
2. endpoint address is unguessable where practical;
3. capability is cryptographically random and at least 256 bits;
4. capability authentication is mandatory before any management command/query/subscription;
5. failed authentication reveals no application state;
6. descriptor/capability never crosses the Electron Main → renderer seam;
7. credential/token values are never projected back through status/query surfaces;
8. transport is local IPC only, never a Model Data Plane listener.

The capability is the application-level authorization authority. OS-specific filesystem/endpoint permissions are defense in depth, not the semantic authentication mechanism.

## 5.7 Control Plane tests

Tests divide into:

```text
Contract tests
  fake/in-memory transport
  command/query/event semantics

Transport tests
  Node IPC framing/connect/disconnect
  platform-specific endpoint behavior

Product E2E
  only a small number use real local IPC
```

Most management tests must not require a real named pipe or Unix socket.

---

# 6. Module 4 — Electron Desktop

Electron Desktop has three internal modules with separate ownership:

```text
Main
Preload
Renderer
```

They are not one shared bag of code.

---

# 7. Electron Main

## 7.1 Responsibility

Electron Main owns only desktop/OS lifecycle:

- single desktop instance;
- tray lifetime and menu;
- create/show/focus/destroy management window;
- Backend process launch for a missing Backend;
- Backend discovery/Control Plane connection recovery;
- OS notifications;
- OS auto-start registration for the desktop product;
- file/directory/save dialogs;
- safe external URL opening;
- typed Electron IPC handlers;
- app shutdown coordination.

## 7.2 Main must remain thin

Electron Main must not implement:

- Provider auth semantics;
- models/catalog logic;
- alias logic;
- protocol conversion;
- request ledger semantics;
- Analytics aggregation;
- config file mutation;
- credential persistence.

If a feature needs one of those behaviors, Main invokes the Control Plane.

## 7.3 Desktop Backend connection seam

Electron Main owns one deep `DesktopBackendConnection` module for the complete Backend connection lifecycle:

```ts
export interface DesktopBackendConnection {
  start(): Promise<void>;
  dispose(): Promise<void>;
}
```

Its implementation composes four narrow collaborators:

```text
ControlPlaneDiscovery
BackendLauncher
ControlPlaneSession
DesktopOwnerLease
```

The module owns discovery, build/owner policy, attach, launch-on-absence, startup early-exit observation, session-loss rediscovery, and single-flight recovery. A lost session invalidates the previous endpoint assumption; recovery reads discovery again and may reconnect to the same or a new endpoint.

`BackendLauncher` is deliberately narrower than the old supervisor concept:

```ts
export interface BackendLauncher {
  launch(): Promise<SpawnedBackend>;
}

export interface SpawnedBackend {
  readonly pid: number;
  readonly exited: Promise<ProcessExit>;
  release(): void;
}
```

The launcher knows only process construction/launch facts. It does not read discovery, decide readiness, inspect ownership, implement build replacement, or own Backend liveness. The child PID and `exited` promise are startup diagnostic facts only; after a Control Plane session is established the child observation is released.

Concurrent benign launch attempts are allowed. Backend singleton correctness is enforced by Backend `InstanceAuthority`, never by Desktop race avoidance.

The connection module must never kill a foreign/headless owner directly. On an explicit initial desktop start, a stale desktop-owned Backend build is replaced only through an acknowledged graceful Control Plane quit; a CLI-owned Backend is preserved and attached even when its build identity differs. After a shell has already established a session, recovery must never roll the product backward: if fresh discovery finds a different desktop build, the recovering shell attaches only as a viewer, relinquishes its desktop-owner lease activity, and neither quits nor claims ownership of the newly authoritative Backend. That viewer state is terminal for automatic recovery in the current shell: if the authoritative foreign-build Backend later disconnects or quits, the viewer must not launch or resurrect another Backend.

## 7.4 Control Plane session seam

Main contains one `ControlPlaneSession` module that wraps the existing TypeScript `ControlPlaneClient` lifecycle:

```text
connect to one endpoint
reconnect to one endpoint
current connection status
compatible ApplicationIdentity from hello
execute typed operations
subscribe typed events
disconnect
```

It does not decode the Control Plane contract a second time.

## 7.5 Tray projection

Tray receives only a minimal aggregate projection, for example:

```ts
export type TrayHealth =
  | "ready"
  | "starting"
  | "attention"
  | "stopped";
```

Tray must not receive the full application snapshot, credentials, model configuration, descriptor, capability, or raw failure objects merely for convenience.

This keeps tray lifecycle independent from application-domain evolution.

---

# 8. Preload — desktop security seam

## 8.1 Responsibility

Preload is the only privileged seam exposed to the renderer.

It converts a fixed TypeScript interface into validated Electron IPC calls/events.

It owns no business state.

## 8.2 No generic IPC escape hatch

Forbidden renderer APIs include:

```ts
window.electron.ipcRenderer
window.luckytoken.invoke(channel, payload)
window.luckytoken.send(channel, payload)
```

The renderer receives only named operations with typed inputs/outputs.

## 8.3 Target desktop interface

The desktop interface has two namespaces because they have different authorities:

```ts
export interface LuckyTokenDesktopApi {
  readonly control: DesktopControlPlaneApi;
  readonly platform: DesktopPlatformApi;
}
```

### Control namespace

`DesktopControlPlaneApi` is a safe subset/projection of `ControlPlaneClient` operations needed by product UI.

Its arguments/results reuse `@luckytoken/application-control-plane` semantic types.

It does not define alternate models such as `ElectronModelsResult` or `ShellCredentialDto`.

Conceptually:

```ts
export interface DesktopControlPlaneApi {
  getStatus(): Promise<StatusSnapshot>;
  onStatus(listener: (event: StatusEvent) => void): () => void;

  executeRuntime(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  executeSettings(command: SettingsCommand): Promise<SettingsCommandResult>;
  executeCredentials(command: CredentialCommand): Promise<CredentialCommandResult>;
  executeAuth(
    command: AuthCommand,
    listener?: (event: AuthInteractionEvent) => void,
  ): Promise<AuthCommandResult>;
  respondAuth(response: AuthInteractionResponse): Promise<void>;

  executeModels(command: ModelsCommand): Promise<ModelsCommandResult>;
  executeCatalog(command: CatalogCommand): Promise<CatalogCommandResult>;
  executeAliases(command: AliasCommand): Promise<AliasCommandResult>;
  executeCodexIntegration(
    command: CodexIntegrationCommand,
  ): Promise<CodexIntegrationCommandResult>;

  getRequestLedger(query?: RequestLedgerQuery): Promise<RequestLedgerQueryResult>;
  onRequestLedger(listener: (event: RequestLedgerEvent) => void): () => void;
  getAnalytics(query: AnalyticsQuery): Promise<AnalyticsResult | AnalyticsOptionsResult>;

  // History, backup and diagnostics are exposed only where product UI uses them.
}
```

The exact names should be finalized by tests, but the architectural constraints are fixed:

- named methods;
- semantic types reused from Control Plane;
- no raw channel strings;
- no descriptor/capability;
- no filesystem handles;
- no Node/Electron objects.

### Platform namespace

OS/Desktop actions that are not Backend domain operations live separately:

```ts
export interface DesktopPlatformApi {
  getAutoStart(): Promise<boolean>;
  setAutoStart(enabled: boolean): Promise<boolean>;

  pickDirectory(): Promise<string | undefined>;
  pickSaveFile(options: SaveFileOptions): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;

  getDesktopVersion(): Promise<string>;
}
```

This prevents OS integration from leaking into the Application Control Plane.

## 8.4 Security defaults

Renderer windows use:

```text
nodeIntegration = false
contextIsolation = true
sandbox = true
restrictive CSP
local packaged UI only
navigation blocked/allowlisted
new-window creation blocked/allowlisted
IPC sender validated in Main
```

Preload exposes only `LuckyTokenDesktopApi` through `contextBridge`.

---

# 9. React Renderer

## 9.1 Responsibility

Renderer owns product interaction and presentation.

Target top-level product features are:

```text
Home
Providers
Connect
Activity
Settings
```

These names describe user tasks rather than internal implementation modules.

## 9.2 Feature ownership

Target renderer structure:

```text
renderer/
  app/
    App.tsx
    navigation.ts

  home/
    HomePage.tsx
    home-model.ts

  providers/
    ProvidersPage.tsx
    provider-actions.ts
    provider-view-model.ts

  connect/
    ConnectPage.tsx
    onboarding.ts
    codex.ts
    claude.ts
    verification.ts

  activity/
    ActivityPage.tsx
    requests.tsx
    analytics.tsx

  settings/
    SettingsPage.tsx
    general.tsx
    network.tsx
    routing.tsx
    data.tsx
    advanced.tsx
```

A feature may have private components/hooks/state. Shared code is created only when two real features require the same stable concept.

## 9.3 Renderer state rule

Renderer state is either:

```text
A. authoritative Backend projection received from Desktop API
B. ephemeral UI state owned by the current feature
```

There is no third category of duplicated application authority.

Examples:

| Fact | Owner |
| --- | --- |
| Provider is authenticated | Backend credential authority |
| Available models | Backend catalog authority |
| Gateway running | Backend Runtime Supervisor |
| Request history | Backend Request Ledger |
| Selected Activity filter | Renderer Activity feature |
| Unsaved model edit draft | Renderer Models/Settings feature |
| Window open/closed | Electron Main |

## 9.4 Product workflows stay in Renderer

Onboarding and first-successful-request workflows are product orchestration, not Core behavior.

Example:

```text
Connect Provider
    ↓
Refresh catalog
    ↓
Configure Codex
    ↓
Verify local client configuration
    ↓
Show ready state
```

Renderer coordinates these steps by invoking existing typed capabilities.

Do not add `setupEverythingForNewUser()` to Core or Backend solely to make the UI easier to write.

---

# 10. Information ownership

One fact has one authoritative owner at each lifecycle stage.

| Information | Authoritative owner | Other modules receive |
| --- | --- | --- |
| Client protocol semantics | Core Client Protocol module | Pi semantics / rendered Response |
| Pi model execution | Pi / Core execution | terminal outcome |
| Provider implementation | Provider package | Pi Provider contract |
| Provider credential values | Backend credential authority / Pi credential store | masked status only; one-shot input during login |
| Active catalog | Backend catalog authority | sanitized catalog projection |
| Alias registry | Backend alias authority | revisioned projection / operations |
| Data Plane lifecycle | Backend Runtime Supervisor | status + typed commands |
| Settings | Backend settings authority | registered safe projections / commands |
| Request Ledger | Backend ledger store | bounded query/events |
| Diagnostics | Backend diagnostics store | sanitized query/events |
| Backend singleton ownership | Backend `InstanceAuthority` / `InstanceLease` | acquired/already-owned result only |
| Application ownership | Backend Application | ownership projection |
| Control Plane publication | Backend `DiscoveryPublication` | endpoint discovery hint only |
| Control Plane capability | Backend discovery + trusted Control Plane client | never renderer |
| Local IPC address | discovery/transport adapter | trusted Main/CLI only |
| Backend child-process handle | Electron Main `BackendLauncher` during startup only | never renderer |
| Tray icon/menu/window handles | Electron Main | never Backend/Core |
| Auto-start registration | Electron platform adapter | boolean state/operation |
| UI navigation/drafts | Renderer feature | no Backend projection |

Broad mutable state objects must not be passed across these ownership lines for convenience.

---

# 11. Desktop lifecycle

## 11.1 Application start

Normal desktop start:

```text
Electron Main starts
    ↓
acquire desktop single-instance ownership
    ↓
create tray
    ↓
DesktopBackendConnection.start()
    ↓
read current Control Plane discovery
    ├─ usable Backend found → connect/hello/attach
    └─ none usable → launch bundled Backend candidate
                         ↓
                  Backend InstanceAuthority arbitrates
    ↓
connect Application Control Plane session
    ↓
project minimal tray health
```

The management window does not need to exist for the product to serve model requests.

## 11.2 Open UI

```text
tray click / Open LuckyToken
    ↓
BrowserWindow exists?
    ├─ yes → show/focus
    └─ no  → create BrowserWindow + preload + renderer
                  ↓
             renderer queries fresh status
                  ↓
             renderer subscribes to updates
```

## 11.3 Tray-first lightweight runtime

LuckyToken Desktop is tray-first by default. Electron Main, the Tray, and the
Backend are the long-lived desktop product; the BrowserWindow is only an on-demand
management surface.

Normal startup therefore permits zero renderer windows:

```text
LuckyToken.exe
    ↓
Electron Main + Tray + Backend
    ↓
0 BrowserWindow
```

Opening the management UI creates a BrowserWindow. Closing it destroys that
BrowserWindow and returns to the tray-only steady state without restarting the
Backend. There is no separate "lightweight mode" setting: this is the default
Desktop lifecycle.

## 11.4 Close UI

Window close means:

```text
unsubscribe renderer event bridges
    ↓
destroy BrowserWindow
    ↓
renderer terminates
    ↓
mainWindow = undefined
    ↓
Backend + Electron Main + Tray remain
```

`hide()` is not the steady-state close behavior.

No authoritative application state may require the renderer to survive this operation.

## 11.5 Reopen UI

A new renderer does not restore stale application snapshots from the old renderer.

It queries current Control Plane state and reconstructs presentation state.

Only explicitly product-owned UI preferences may be persisted by the renderer/desktop settings capability.

## 11.6 Desktop instance domains

Installed/release LuckyToken and repository-generated `.electron-out` builds are
not the same desktop instance domain.

The installed product uses the stable default Electron `userData` / single-instance
domain. A repository `.electron-out` build must derive an isolated Electron
`userData`/`sessionData` directory from its exact shell build identity before the
Electron `ready` event. This isolation is shell-only: authoritative LuckyToken
configuration, credentials, ledger, Control Plane descriptor, and other Backend
state remain under the product-owned `~/.luckytoken` paths.

Therefore an arbitrary old installed/test shell that does not understand the
current handoff protocol can never prevent a newly built `.electron-out` shell
from starting. Both shells may exist during that one-time legacy transition, but
there is still only one authoritative Backend at a time. If the running
desktop-owned Backend belongs to a different packaged build, the repository shell
replaces that Backend through the ownership-aware Control Plane flow described
below rather than continuing to run stale Backend code or spawning a competing
authority.

## 11.7 Single-instance shell handoff

Desktop single-instance ownership belongs to the Electron shell, not to the Backend.
A second launch carries an opaque build identity derived by Electron Main from the
current shell build. The identity must change when the packaged shell changes even
if the package version string or install location is reused.

Two cases are distinct:

```text
same shell build starts again
    ↓
existing Electron Main keeps the lock
    ↓
show/focus existing management window
    ↓
secondary Electron process exits locally
```

```text
different shell build starts
    ↓
existing Electron Main releases only the desktop single-instance lock
    ↓
existing Electron Main exits locally (no Control Plane quit)
    ↓
new shell acquires the lock on its handoff retry
    ↓
new shell attaches to the already-running Backend
```

A secondary Electron process that cannot acquire the lock must never route its
exit through product Quit. It has not established Backend authority and must call
the local Electron exit path directly. Conversely, the tray `Quit LuckyToken`
action must remain the ownership-aware product quit path below.

Shell handoff must not terminate, restart, or mutate the Backend merely because a
new desktop build was launched. This keeps Backend ownership stable while ensuring
a stale tray shell cannot continue presenting an older renderer after a newer
LuckyToken desktop build is explicitly started.

## 11.8 Electron Main owns login-item migration

Windows login-item registration is desktop/OS integration and remains entirely in
Electron Main. It is not a Backend or Application Control Plane responsibility.

Repository `.electron-out` builds are disposable and must never own Windows
Auto-start. On startup they remove stale per-user LuckyToken login items whose
executable path is inside `.electron-out`, while leaving any installed-product or
machine-scoped login item untouched. The Settings Auto-start operation in a
repository build reports disabled and must not register the disposable executable.

Installed/release builds use a stable LuckyToken login-item identity. On startup,
Main examines the existing per-user LuckyToken launch items. If an older executable
path is registered, Main removes the stale entry and migrates the registration to
`process.execPath`, preserving Windows Startup Approval (`enabled`/disabled) state.
The same cleanup occurs when the user explicitly changes Auto-start, preventing
multiple stale LuckyToken startup entries from accumulating.

This policy prevents an old test/install executable from being resurrected at the
next Windows sign-in and keeps OS path/version facts out of Backend state.

## 11.9 Desktop bundle identity and stale Backend replacement

Every assembled desktop Backend carries an opaque build identity derived from the
exact packaged Backend artifacts. Electron Main reads the expected identity from
its own `resources/backend` and the desktop-owned Backend publishes the same
identity only through the Control Plane hello/application identity. The identity
is management metadata; it is not Renderer status and contains no filesystem path
or credential material.

On desktop startup:

```text
Control Plane endpoint exists
    ↓
hello application buildId == current resources/backend buildId?
    ├─ yes → attach normally
    └─ no  → inspect ownership
             ├─ owner = desktop → acknowledged graceful quit of stale Backend
             │                   → wait for descriptor/Control Plane release
             │                   → start current bundled Backend
             └─ owner = cli     → preserve headless authority and attach
```

A desktop shell must not silently keep using a stale desktop-owned Backend merely
because its Control Plane contract version is still wire-compatible. Conversely,
a desktop shell must not steal authority from an explicitly CLI-owned Backend.

`npm run dev` / desktop start paths must assemble the current Backend before
Electron starts. A stale `packages/desktop-shell/backend` directory is never an
acceptable development runtime source.

## 11.10 Desktop owner lease and orphan prevention

A desktop-owned Backend must never rely on OS parent/child process semantics for
liveness. The bundled Backend is deliberately detached so a shell-build handoff can
replace Electron without restarting the authoritative Backend.

Instead, Electron Main owns a random logical `leaseId` and claims it through the
Application Control Plane after connecting to a desktop-owned Backend. Main renews
that same lease periodically. Backend lease policy is Backend-lifetime and uses a
bounded TTL.

```text
Desktop-owned Backend starts
    ↓
initial claim grace period
    ↓
Electron Main claims leaseId A
    ↓
periodic renew(A)
```

A newer shell may atomically claim leaseId B. After that point `renew(A)` conflicts
and the stale shell can never reclaim ownership merely by sending another renew.
This is what lets normal single-instance/build handoff preserve the Backend PID.

If no initial claim arrives before the grace deadline, or the active lease stops
renewing (Electron crash, forced process termination, failed shell handoff), the
Backend invokes the same graceful Data Plane quit/drain path as explicit product
Quit and then closes the application lifecycle. It must not use an OS-level process
kill as the normal retirement mechanism.

CLI-owned Backends do not create or accept a desktop owner lease. Their lifecycle
remains independent of Electron.

## 11.11 Quit

Explicit tray product quit is ownership-aware.

Electron must not terminate a Backend process directly merely because it has a child-process handle.

For a desktop-owned Backend whose active logical DesktopOwnerLease is held by this shell:

```text
Quit LuckyToken
    ↓
Application Control Plane quit request
    ↓
graceful Data Plane drain
    ↓
Backend closes authorities/descriptor
    ↓
Electron Main exits
```

`ownership.owner.kind = "desktop"` is only a Backend ownership projection; it is not sufficient authority for a shell to perform Product Quit. A shell that recovered onto another desktop build as a viewer, or whose logical lease was superseded, must never use the other shell's desktop-owned Backend as its own quit target. Tray Quit in that state exits only the local Electron shell.

For a CLI-owned Backend:

```text
Quit LuckyToken tray action
    ↓
Electron shell exits locally
    ↓
CLI-owned Backend remains under its legitimate headless owner
```

If Backend ownership is unavailable/unknown, Electron fails safe and stays alive
instead of disappearing while a possibly desktop-owned Backend remains unmanaged.

Release certification must exercise the packaged abnormal-exit path: forcibly
terminate Electron Main while a desktop-owned Backend is running and prove that the
lease expires, the Control Plane closes, and the desktop-owned Backend PID exits.

---

# 12. Package and source layout

The target logical layout is:

```text
packages/
  core/
    src/
      runtime.ts
      http.ts
      execution.ts
      protocols/
      providers/
      aliases/
      model-resolution.ts
      ...

  application/
    src/
      application.ts
      composition.ts
      runtime-supervisor.ts
      settings/
      credentials/
      request-ledger/
      diagnostics/
      history/
      backup/
      discovery/
      local-ipc/
      ...

  application-control-plane/
    src/
      contracts.ts
      client.ts
      host.ts
      wire.ts
      framing.ts
      transport.ts
      ...

  provider-contract/
  provider-commandcode-private/

  desktop/
    src/
      main/
      preload/
      renderer/
      shared/
```

This is a **target**, not a requirement to move every file before behavior work starts.

Physical extraction into `packages/core` / `packages/application` occurs only after their public seams are established by tests. Directory movement must not be used as a substitute for interface design.

The existing root CLI may remain a thin product adapter or move under an `apps/` directory later. It must not remain the Backend composition root.

---

# 13. Current-to-target mapping

## 13.1 Preserve with minimal semantic change

| Current code | Target |
| --- | --- |
| `src/runtime.ts` | Core runtime seam |
| `src/http.ts` | Core request boundary |
| `src/protocols/*` | Core Client Protocol modules |
| `src/execution.ts` | Core execution |
| `src/model-resolution.ts` | Core |
| Provider request composition | Core / Pi integration |
| `packages/provider-contract` | unchanged package boundary |
| `packages/provider-commandcode-private` | unchanged Provider package boundary |
| `packages/application-control-plane` semantic contracts/client/host | retained and simplified to one TS implementation |

## 13.2 Refactor ownership

| Current code | Target change |
| --- | --- |
| `src/composition.ts` | separate serving composition from Backend Application lifecycle; stop exposing broad internals to product adapters |
| `src/cli.ts::runServe()` | extract into `startLuckyTokenApplication()`; CLI keeps argument/result presentation only |
| `src/runtime-supervisor.ts` | Backend Application-owned deep module |
| settings/credentials/ledger/diagnostics/history/backup | Backend Application-owned capabilities |
| `src/control-plane-discovery.ts` | Backend Application discovery adapter using transport-neutral `address` |
| `src/control-pipe-composition.ts` | pure TypeScript local IPC composition |
| `src/windows-control-pipe.ts` | delete after pure TS transport lands |
| Control Plane `ApplicationCommand.auto_start` / `AutoStartRegistration` | remove from Backend management contract; desktop auto-start is Electron platform ownership. If a separate headless auto-start feature is retained later, it is a CLI/product-adapter concern rather than shared Backend state. |

## 13.3 Replace Desktop implementation

| Current code | Target |
| --- | --- |
| `packages/desktop-shell/src-tauri/**` | delete |
| `packages/control-pipe-win-native/**` | delete |
| `packages/desktop-shell/src/tauri-shell-runtime.ts` | replace with Electron Main ControlPlaneSession + preload |
| `packages/desktop-shell/src/control-plane-projection.ts` | remove duplicate contract decoding; retain only true product projections if needed |
| `packages/desktop-shell/src/shell-lifecycle.ts` | split into Main window/tray lifecycle and renderer product state; remove shell revision authority |
| `packages/desktop-shell/src/App.tsx` | rebuild as small app shell + product feature modules |
| `packages/desktop-shell/src/models-editors.tsx` | split by Provider/Models/Alias ownership rather than file size |
| existing page behavior | selectively reuse product logic/tests where it matches the new information architecture |

---

# 14. Ordering and consistency rules

The Electron migration must not introduce a Desktop-owned authority revision
that competes with Backend facts. Do not create semantic revision layers such
as:

```text
ShellRevision
ElectronRevision
RendererRevision
```

Application facts use their owning revision/sequence:

```text
status sequence
models revision
alias revision
credential revision
other capability-specific revision
```

Electron Main may add one monotonically increasing `DesktopBackendState.revision`
as a delivery-ordering token for the typed preload state stream. This token exists
because Backend `StatusSnapshot.sequence` restarts when Main attaches to a new
Backend process. It has no authority over Backend facts and is not a capability
revision, Control Plane generation, or Renderer-owned state version.

The ordering token has exactly one Renderer use: reject a state whose revision is
older than the latest accepted Desktop state. It must not be used as Backend session
identity or as a lifecycle dependency for subscriptions and authoritative queries.
Those lifecycles follow availability transitions:

```text
non-ready → ready    bind / query
ready → non-ready    unbind / clear
ready → ready        keep the existing lifecycle
```

Control Plane client generation remains private to Electron Main and rejects stale
callbacks from replaced clients. The Control Plane client remains responsible for
its own ordered event/request contract.

Renderer features apply capability-specific concurrency rules only when editing that capability.

---

# 15. Testing architecture

The target test pyramid follows module seams.

## 15.1 Core tests

```text
Request → Response
Client Protocol ↔ Pi
Pi ↔ Provider
execution lifecycle
```

No Electron/local IPC dependency.

## 15.2 Backend Application tests

```text
start application
compose authorities
start/stop Data Plane
recovery mode
persistence ownership
shutdown/drain
```

Use deterministic adapters where possible.

## 15.3 Control Plane contract tests

```text
command
query
event ordering
subscription
reconnect
malformed message rejection
capability authentication
```

Default to fake/in-memory transport.

## 15.4 Renderer feature tests

Renderer tests receive a fake `LuckyTokenDesktopApi`.

Example:

```text
fake status = stopped
    ↓
render Home
    ↓
click Start
    ↓
assert typed desktop operation invoked
    ↓
resolve running projection
    ↓
assert visible Ready state
```

No Electron, Backend, Provider, or local IPC is needed.

## 15.5 Electron E2E

Run real Electron Main + preload + renderer against a deterministic fake Control Plane/Backend adapter.

Verify real user behavior:

- open from tray;
- click navigation/buttons;
- input fields;
- dialog orchestration through controlled platform adapters;
- window close destroys renderer;
- reopening reconstructs current state;
- screenshots/visual assertions where useful.

## 15.6 Product E2E

Keep this layer small.

Real chain:

```text
Electron
  ↓
preload / Main
  ↓
real local IPC
  ↓
real Backend Application
  ↓
real Core
```

Release-blocking golden journey:

```text
fresh product state
→ launch
→ connect/login Provider
→ configure supported client
→ send first request
→ observe successful Activity record
→ close UI
→ prove gateway remains usable in tray-only state
→ reopen UI
→ prove fresh state is reconstructed
```

Online Provider verification remains separate and explicitly authorized.

---

# 16. Architecture certification tests

The migration must add inexpensive tests that prevent dependency drift.

At minimum certify:

1. Core package has no `electron` import.
2. Core package has no Application Control Plane import.
3. renderer has no `electron`, `node:*`, filesystem, child-process, or local transport import.
4. Electron Main has no deep import into Core implementation files.
5. Desktop does not define duplicate Control Plane semantic result interfaces.
6. production tree contains no `src-tauri`, Cargo manifest, or Rust native control-pipe package after cutover.
7. preload exposes no generic channel invocation API.
8. descriptor `address`/`capability` never appear in renderer-facing types.

Prefer package exports, TypeScript projects and simple certification tests over a large architectural framework dependency.

---

# 17. Migration method — TDD, replace rather than layer

Every non-trivial phase follows red → green → refactor.

No phase keeps a compatibility adapter solely to preserve the old desktop implementation.

## Phase 0 — freeze seams

Add/adjust tests that characterize the intended stable seams before moving code:

- `LuckyTokenRuntime` request interface;
- Backend ownership/lifecycle behavior;
- `ControlPlaneClient` semantic behavior;
- desktop close/reopen product behavior as target tests.

## Phase 1 — extract Backend Application from CLI

Goal:

```text
CLI argument parser ≠ application composition root
```

Create the narrow application startup/lifecycle seam and move `runServe()` ownership behind it.

Do not change model-serving semantics.

## Phase 2 — make Control Plane transport pure TypeScript and transport-neutral

- replace `pipeName` with `address`;
- implement local IPC with Node `node:net`;
- make capability authentication the explicit application security authority;
- add deterministic transport tests;
- remove `control-pipe-win-native` and `windows-control-pipe.ts` after replacement tests pass.

No dual `pipeName`/`address` compatibility.

## Phase 3 — create Electron Main + preload skeleton

Implement only:

- single instance;
- tray;
- DesktopBackendConnection;
- BackendLauncher;
- ControlPlaneSession;
- BrowserWindow lifecycle;
- typed preload bridge;
- secure BrowserWindow defaults.

Renderer may initially be a minimal status surface.

## Phase 4 — certify lightweight tray lifecycle

Red tests first:

```text
startup → tray exists without BrowserWindow
open → BrowserWindow created
close → BrowserWindow destroyed
backend stays alive
reopen → new renderer gets fresh status
```

This phase proves the resource/lifecycle model before product UI expansion.

## Phase 5 — rebuild Renderer by product feature

Implement in user-value order:

```text
Home
Providers
Connect
Activity
Settings
```

Reuse existing feature logic only when it fits the new ownership boundary.

Do not recreate the current nine engineering-oriented top-level pages one-for-one.

## Phase 6 — real Backend integration

Connect Electron Main to the real Control Plane client and certify ownership/reconnect/shutdown behavior.

## Phase 7 — delete Tauri/Rust desktop

After Electron product tests are green, delete:

```text
packages/desktop-shell/src-tauri/
packages/control-pipe-win-native/
Tauri dependencies/scripts/config
Rust bridge/projection compatibility tests
old Tauri shell runtime
```

Do not leave disabled code or migration flags.

## Phase 8 — release product certification

Add the first-successful-request golden journey and tray-only/background usability to release blockers.

---

# 18. Failure ownership

Failures are classified by the module that owns the fact.

Examples:

```text
Provider auth invalid
→ Backend credential/provider authority
→ typed Control Plane projection
→ Renderer shows Reconnect action

Port conflict
→ Backend Runtime Supervisor
→ typed status
→ Renderer shows actionable failure

Renderer crash
→ Electron desktop concern
→ Backend continues serving

Local IPC/session disconnect
→ current Control Plane session becomes unavailable
→ DesktopBackendConnection discards the old endpoint assumption and re-runs discovery
→ renderer shows reconnecting/unavailable state while recovery is in progress

Backend process exits before Management Ready
→ BackendLauncher `exited` startup diagnostic
→ DesktopBackendConnection performs one fresh discovery check
→ fail startup only when no usable authoritative Backend publication exists
```

Renderer must not infer domain failures from raw strings or combinations of unrelated fields.

Electron Main must not reinterpret domain errors to invent new Backend semantics.

---

# 19. Product performance/resource contract

The architecture deliberately permits the heavy UI runtime to disappear while the product remains active.

Tray-only acceptance state:

```text
Backend Node process       required
Electron Main              required
Tray                       required
BrowserWindow              forbidden
Renderer process           forbidden
React application          forbidden
```

Resource measurement is part of product certification, not an architectural guess.

Measure at least:

```text
A. Backend only
B. Backend + Electron tray, no window
C. Backend + Electron + open UI
```

Record:

- process count;
- working/private memory;
- idle CPU;
- UI cold-open time;
- UI close-to-renderer-exit behavior.

The purpose of the measurement is to detect accidental retained renderers/subscriptions, not to couple architecture to one fixed MB value.

---

# 20. Rejected designs

## 20.1 Tauri with a generated Rust/TS Control Plane schema

Rejected because it keeps two semantic runtime implementations and adds code generation/build complexity instead of deleting the unnecessary language boundary.

## 20.2 Electron Main imports Core and becomes the application

Rejected because desktop lifecycle would become coupled to model-serving/domain internals, headless ownership would weaken, and CLI/Desktop would no longer share one management seam.

## 20.3 Renderer connects directly to local IPC

Rejected because transport credentials/capability would enter the web renderer and the product would lose the preload/Main security boundary.

## 20.4 Hidden BrowserWindow as tray mode

Rejected because the renderer/React runtime remains alive and authoritative UI state can become stale.

Tray mode destroys the window.

## 20.5 Generic Electron IPC bridge

Rejected because `invoke(channel, payload)` creates an unbounded interface, weakens security, and makes UI tests depend on string channels rather than product operations.

## 20.6 Duplicate Electron DTO model

Rejected because Control Plane semantic contracts already exist. Electron transport does not justify another domain representation.

## 20.7 Cross-platform abstractions without a real variation

Rejected. Introduce a platform seam only where Windows/macOS/Linux behavior actually differs, such as auto-start or notification details.

Local IPC remains one Node transport interface whose path implementation varies underneath.

---

# 21. Architecture review checklist

A change is acceptable only if the answer to all applicable questions is clear:

1. Which module owns the new fact?
2. What is the smallest interface another module needs?
3. Is an existing seam sufficient?
4. Is the change introducing a second representation of an existing semantic contract?
5. Does Electron learn Core/domain internals it does not need?
6. Does Core learn product/OS concerns it does not need?
7. Can the owning module be tested through its public seam without booting unrelated layers?
8. Can Renderer behavior be tested with a fake Desktop API?
9. Does UI close destroy all renderer-owned runtime state?
10. Does a running Backend remain usable without the UI?
11. Is old Tauri/Rust compatibility being added unnecessarily?

If the design requires broad configuration/state to cross multiple modules, redesign the information flow before implementation.

---

# 22. Definition of done for the architecture migration

The Electron architecture migration is complete when all of the following are true:

- [ ] model-serving Core behavior remains covered by existing semantic tests;
- [ ] Backend startup/lifecycle exists behind one application seam rather than `cli.ts` composition;
- [ ] Application Control Plane has one TypeScript semantic/wire implementation;
- [ ] local management endpoint uses transport-neutral `address` + capability;
- [ ] production local IPC is pure TypeScript/Node;
- [ ] Electron Main owns tray/window/OS integration only;
- [ ] renderer sees only the typed preload interface;
- [ ] renderer has no Node/Electron/Control Plane wire dependencies;
- [ ] closing UI destroys BrowserWindow/renderer while Backend + tray continue;
- [ ] reopening UI reconstructs fresh state;
- [ ] UI feature tests run against a fake Desktop API;
- [ ] Electron E2E performs real clicks against a real BrowserWindow;
- [ ] small product E2E covers the complete Backend chain;
- [ ] Tauri and Rust production code/build dependencies are deleted;
- [ ] old desktop compatibility paths/configuration are deleted;
- [ ] release certification includes first successful request and tray-only background operation.

At that point LuckyToken has one business language, one model-serving semantic core, one running-application management contract, and one replaceable desktop product adapter.

---

# 23. Primary external references

These references justify only platform/runtime mechanics; LuckyToken module boundaries are project decisions defined by this specification.

- Electron — Process Model: https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron — Security: https://www.electronjs.org/docs/latest/tutorial/security
- Electron — Context Isolation: https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Electron — IPC: https://www.electronjs.org/docs/latest/tutorial/ipc
- Node.js — `node:net` IPC support: https://nodejs.org/api/net.html
