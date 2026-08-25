# 10 — Add BackendSupervisor attach-or-spawn lifecycle

**What to build:** Give Electron Main one process-level supervisor that attaches to an already-running Token Backend or starts the bundled Backend when none exists, without taking ownership of Backend domain state.

**Blocked by:** 03 — Move recovery and ownership shutdown behind Backend Application; 08 — Create Electron Main, preload, and packaging skeleton.

**Status:** completed

- [x] Desktop startup discovers and attaches to an active Backend without starting a second Data Plane.
- [x] When no Backend exists, the supervisor starts the bundled Backend and waits for management readiness before reporting attachment success.
- [x] The supervisor tracks only process/attachment facts required by the desktop and never exposes Core instances or Backend authorities.
- [x] A Backend owned by another headless invocation is never terminated directly through a child-process handle.
- [x] Supervisor disposal releases desktop-owned process resources without changing Backend ownership semantics.
