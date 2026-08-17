# ADR 0001: Windows desktop shell and local Control Plane bridge

- Status: Superseded by ADR 0004 (`0004-electron-typescript-desktop.md`)
- Date: 2026-08-15
- Ticket: Desktop 02

## Context

LuckyToken needs a native Windows management surface without moving the Node data plane or protocol conversion into a second runtime. The desktop must discover the one active current-user Control Plane and must not expose its descriptor capability, credentials, Client tokens, captures, or mutable backend state to the webview.

The repository's `reference/cc-switch` demonstrates a working Tauri composition, but it also places proxy, configuration, tray, and other application behavior in Rust. LuckyToken needs a thinner seam because Pi AI IR and the Node backend remain authoritative.

## Decision

Use a Windows-first Tauri 2.11.5 host with React 19.2.7, Vite 8.1.5, and TypeScript for the renderer. Tauri declares exactly one visible `main` window, and native setup fails closed unless that is the only webview window. The single-instance plugin is registered first; a second process only focuses the existing main window and does not log or emit its arguments.

Rust owns Control Plane discovery, the descriptor capability, Named Pipe I/O, and connection lifecycle. Discovery defaults to `%USERPROFILE%/.luckytoken/control-plane.json` through Tauri's current-user home-directory resolver. A native `--descriptor <path>` override exists for development and tests. Node CLI serving uses the same standard path by default and may use the same explicit override. This is discovery only; owner/process-liveness recovery remains Ticket 05.

The Rust bridge mirrors Control Plane v1 framing: a maximum 1 MiB, four-byte big-endian length followed by JSON, then `hello`, `get_status`, and `subscribe`. Renderer code may invoke only the no-argument `shell_snapshot` and `shell_retry` commands and listen for the directed `luckytoken://shell-state` event. Returned DTOs are revisioned, constructed from an allowlist, and contain only application version, contract version, and the public Ticket01 status snapshot or a closed error code. Renderer startup arguments and `VITE_*` variables contain no descriptor, pipe name, capability, path, token, credential, raw error, or mutable native object.

The renderer listens before requesting a snapshot and ignores revisions older than the newest event. Connection, version, and disconnect failures become actionable application state; they do not block the empty Dashboard or any of the eight stable pages. There is no onboarding wizard or forced Provider selection.

The renderer uses a strict CSP and the minimum event listen/unlisten capability. No tray, notification, autostart, supervisor, backend spawn, or runtime ownership behavior is included in this ticket. The Rust reader task is explicitly aborted and joined on retry and Tauri exit.

This ticket builds and tests the Windows executable shell. Installer production is deferred: Ticket 26 will decide and authenticate the installed packaging/runtime shape. A per-user NSIS installer is the current proposal, not a commitment made here. The fixed Node runtime and any `externalBin`/sidecar definition are also Ticket 26 concerns.

## Consequences

- The Node backend remains an independent process and the only owner of protocol and provider semantics.
- Descriptor capability and transport details never cross the native-to-renderer information boundary.
- Rust and TypeScript contain a small mirror of the versioned Control Plane wire/DTO. Contract evolution must update both sides and their compatibility tests; the mirror is an explicit drift risk, not a second semantic model.
- Ticket 26 must verify descriptor ACLs and the installed virtual-machine/runtime boundary before distribution is enabled.
- A real executable smoke test is required on Windows in addition to public TypeScript lifecycle and projection tests; renderer component trees and CSS are not test seams.
- The executable smoke certifies the real Named Pipe handshake, single product window, second-instance behavior, and clean process/pipe disposal. Installed WebDriver DOM navigation certification remains Ticket 26; this ticket's eight-page navigation contract is verified through the public TypeScript lifecycle seam.
