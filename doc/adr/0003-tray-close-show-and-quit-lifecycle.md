# ADR 0003: Tray Close, Show, and Quit lifecycle

- Status: Accepted
- Date: 2026-08-15
- Ticket: Desktop 04

## Context

LuckyToken must remain available as a tray application. Closing the main window
must hide it without terminating the application or the gateway, the tray menu
must restore the same window, and an explicit Quit command must exist that
later ownership and drain behavior (Ticket 05) can honor. Window Close must
never alias to Quit.

The `reference/cc-switch` tray implementation rebuilds menus and carries
application logic in Rust; LuckyToken needs a thinner, single-ownership seam
because the Node backend remains authoritative.

## Decision

The Tauri host owns exactly one tray icon and one tray menu, created once in
`setup` with stable public ids (`luckytoken-main`, `tray-show`, `tray-quit`).
Repeated Close/Show cycles never rebuild the tray, so no tray icon or menu
subscription is ever duplicated. The managed `TrayStateEmitter` keeps the tray
icon and menu alive for the whole application lifetime.

Window Close is a hide, never a quit: the `CloseRequested` handler calls
`prevent_close` and `hide` on the single `main` window. The application and the
Data Plane stay alive, and the tray keeps the window reachable. Tray Show
restores and focuses the same existing window; it never creates a second one.
Tray Quit is the distinct explicit application quit intent: it shuts down the
bridge (aborting and joining the active Control Plane operation) and exits the
application. Ticket 05 will honor the quit intent with drain and ownership
semantics; this ticket only owns the intent seam.

One bridge operation serves both public surfaces: a `CompositeEmitter` fans
each revisioned `ShellStateDto` emission to the renderer window and to the
tray. Exactly one bridge operation is ever active (the bridge aborts the
previous one on retry), so both surfaces always observe the same state stream,
and the automatic Start remains the native connector's one-shot gate.

The tray menu exposes only sanitized high-level gateway state: a disabled
status line ("LuckyToken — Gateway running/stopped/…") and a tooltip built from
the lifecycle and provider configuration labels. The configured origin, port,
capability, descriptor, and any failure message never enter tray text. The
status line updates from the same bridge event stream as the renderer.

## Consequences

- Closing the window hides it; the application and gateway remain alive and
  reachable through the tray and the Control Plane.
- Exactly one tray icon exists for the application lifetime; Close/Show cycles
  are idempotent with no duplicated subscriptions.
- Tray Show restores the same window handle; Tray Quit is the only exit path
  besides an OS-forced termination.
- The Windows executable smoke proves Close-to-tray, Show-restores-same-window,
  distinct Quit intent, idempotency, sanitized tray state, and Data Plane
  reachability while hidden through the public native seam (tray window class,
  popup menu items, WM_CLOSE).
- Ticket 05 builds on the distinct Quit intent for drain and ownership without
  changing the Close-to-hide contract.
