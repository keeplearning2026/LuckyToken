# Token 0.1.0 — Release Notes (Windows-first)

Status: **Electron product release-candidate certification**.

## Product shape

- TypeScript/Node Token Backend owns Pi AI IR, protocol conversion, Provider execution, aliases, Client Tokens, observability, persistence, and backup/history authorities.
- TypeScript Electron desktop owns only tray/window lifecycle, Backend supervision, OS integration, and a typed preload security seam.
- React renderer is created only when the management UI is open. Closing the management window destroys the BrowserWindow/renderer; the Backend and Electron tray remain running.
- The Application Control Plane is the only management seam into a running Backend. Its local endpoint is `{ address, capability }` and production transport is pure Node `node:net` IPC.
- The production tree contains no Tauri, Rust, Cargo, or native Control Pipe implementation.

## Product experience

The management UI is organized around user tasks rather than internal subsystems:

- **Home** — current readiness and the next actionable step.
- **Providers** — Provider authentication and model availability.
- **Connect** — supported coding-client integration, starting with Codex.
- **Activity** — recent Request Ledger records and Backend-computed analytics.
- **Settings** — General, Network, Routing, Data, and Advanced configuration.

## Provider credential Profiles

- A Provider can keep multiple independently named credential Profiles across
  its Pi-declared non-OAuth and OAuth authentication methods. Exactly one
  managed Profile is active for subsequent requests; switching never changes
  the client protocol or data-plane lane.
- Local Codex auto-login and manual login produce equal ordinary Profiles with
  the same actions, selector, counts and HTTP 429 candidate rules. Credential
  acquisition stays private to the Backend.
- Profiles support notes, priority, enable/disable, explicit activation,
  reconnect, local removal, and separately configurable default-off HTTP 429
  switching for the Provider's two Pi auth branches. A request makes at most
  three outer Profile attempts.
- Activity records only bounded request-time Profile identity, auth-method
  label, lane, attempt, and outcome facts. Secrets and Profile notes are not
  recorded.
- Provider credentials are stored as independent
  `pi/credential-profiles/<providerId>.json` records whose token material
  lives in one incarnation document per committed logical credential
  (`pi/credentials/<providerId>/<credentialId>/<credentialGeneration>.auth.json`).
  The record reference switch is the commit point; recovery reads only the
  referenced incarnation and never adopts an unreferenced file. The obsolete
  Provider single-slot `pi/auth.json` is ignored, never migrated, never
  overwritten, and never deleted automatically. After verifying that no older
  Token installation is needed, users may manually remove that obsolete file.

## Codex-native `openai-codex` source and model catalog

- By default, Backend startup rebuilds one ordinary Profile from the current
  local Codex ChatGPT login. Settings → `.codex agent` → “启动时自动登录本地 Codex”
  controls the next startup. Turning it off preserves existing Profiles.
- Startup and Reconnect share atomic removal/read/create publication. Each run
  creates fresh IDs and default metadata, retains other Profiles, and preserves
  their selection. Missing or invalid local login creates a Profile needing
  reconnect, without retaining old tokens or silently choosing another account.
- Imported OAuth lives in Token-owned incarnation files and refreshes through
  ordinary Pi OAuth. The original Codex auth.json remains unchanged; Recheck
  checks the existing imported credential instead of re-reading that source.
- The Provider's model list is extended with the local Codex native catalog
  (`codex debug models --bundled`, read-only `models_cache.json` fallback),
  append-only and never written to the user's `models.json`. Appended models
  carry an explicit reasoning-level map (unlisted levels are `null`) and an
  explicit compatibility set copied from a same-generation Pi sibling or, when
  none exists, a closed conservative default with a bounded warning.
- Usage, Public Model availability and Operational Attention consume the selected
  ordinary Profile. Imported Profiles support the full PROFILE ACTIONS menu
  and have no source-specific label or read-only card.
- The Codex Responses backend answers with a buffered SSE body and no
  `content-type`; Provider Native Responses now decides the response wire shape
  from an explicit content type first and from the bounded head of the body
  otherwise, so the model-alias projection no longer rejects a valid Codex
  stream.
- This does not affect Codex Direct Mode: Codex's own
  `CODEX_HOME/auth.json` remains owned by Codex and is not a Provider Profile
  record.

## Certified evidence

- **Backend Application seam**: normal serving, recovery-only startup, second-instance attach, ownership-aware quit, and cleanup are covered through one application lifecycle authority rather than CLI-owned composition.
- **Pure TypeScript Control Plane**: capability authentication, malformed-message rejection, request correlation, disconnect/reconnect, and subscription cleanup are certified over real local IPC. The old `pipeName` contract and native Windows pipe implementation are removed.
- **Electron security boundary**: renderer Node integration is disabled, context isolation and sandboxing are enabled, navigation/new-window creation are restricted, and preload exposes only the typed `TokenDesktopApi`; no generic `ipcRenderer` escape hatch exists.
- **Tray-only lifecycle**: packaged Electron starts with zero BrowserWindows. Opening creates one renderer; closing destroys it. `window-all-closed` is explicitly retained by the tray application, and repeated reopen cycles construct fresh renderer state from Backend authority.
- **Packaged Backend**: Electron packages `resources/backend/node/node.exe`, compiled Backend `dist`, production dependencies, and `launcher.json`. Electron attaches to an existing headless Backend rather than creating a second owner.
- **First-successful-request golden journey**: deterministic release certification uses a local Anthropic-compatible upstream with no external credentials. A real packaged Electron UI adds and activates an Anthropic credential Profile through the Provider-owned login flow, configures Codex, then a real OpenAI Responses client request travels through Token Client Protocol conversion, Pi IR, the Anthropic Provider, the local upstream, and back to the client. The successful request and its sanitized Profile attribution are visible in Activity and Analytics.
- **Background operation**: after the UI is closed and the renderer exits, a second real model request succeeds through the same Backend. Reopening the UI reconstructs Activity from the authoritative Request Ledger.
- **Resource evidence**: product certification records process count, working/private memory, idle CPU, and UI cold-open time for Backend-only, tray-only, and UI-open states. The evidence is emitted to the ignored `.electron-out/product-certification-resource.json` artifact so retained renderers are detectable without coupling release correctness to one fixed memory threshold.
- **Architecture guards**: certification fails if Core imports Electron/Control Plane, renderer imports Node/Electron/Control Plane internals, generic desktop IPC appears, or Tauri/Rust/legacy shell paths are reintroduced.

## Online Provider verification

The default release certification is deterministic and offline with respect to third-party AI services. Real CommandCode/Anthropic/OpenAI account or API-key verification remains a separate, explicitly authorized online run with Provider/version provenance. The offline golden journey must not be interpreted as evidence that a third-party production account is currently reachable.

## Windows distribution

Windows is distributed through one per-user Squirrel.Windows `Token-Setup.exe`; the old portable ZIP is not a second Windows release authority. Release certification binds all packaged product tests to the exact EXE produced by the same Make invocation, then installs that exact Setup.exe and verifies a blank first run starts the Backend and exposes the built-in Provider catalog before uninstalling it. The release manifest records the source commit, Backend build identity, SHA-256 values, signing state, and certification outcomes. An unsigned or dirty candidate is explicitly non-promotable; official release fails closed without valid Authenticode signatures.
