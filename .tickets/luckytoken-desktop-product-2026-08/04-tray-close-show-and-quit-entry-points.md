# 04 — Tray Close, Show, and Quit entry points

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Keep LuckyToken available as a tray application. Closing the main window hides it without terminating the application or gateway; the tray menu can show the window again and exposes the explicit Quit command that later ownership and drain behavior can honor.

**Blocked by:** 02 — Windows Desktop Shell and empty Dashboard; 03 — Dashboard-managed Runtime Supervisor.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm the Windows shell lifecycle smoke seam before writing tests. Exercise visible window/tray behavior through the desktop host interface rather than renderer internals or operating-system implementation details.

## Acceptance criteria

- [x] Closing the main window hides it and leaves both the application and a running Data Plane alive.
- [x] The tray icon remains available while the main window is hidden.
- [x] Tray Show restores and focuses the existing main window rather than creating a second window.
- [x] Tray Quit emits an explicit application quit intent; window Close never aliases to that command.
- [x] Repeated Close and Show actions are idempotent and do not duplicate tray icons or event subscriptions.
- [x] The tray menu exposes current high-level gateway state without revealing credentials or model secrets.
- [x] Windows smoke tests prove Close-to-tray, Show, and distinct Quit intent through the public shell seam.
