# 03 — Move recovery and ownership shutdown behind Backend Application

**What to build:** Make recovery-only startup, attach behavior, ownership-aware quit, and graceful shutdown part of the same Backend Application lifecycle authority used by normal serving.

**Blocked by:** 02 — Extract normal Backend Application bootstrap from CLI.

**Status:** completed

- [x] Incompatible owned configuration can start a recovery-only Backend Application that keeps the management plane reachable without starting unsafe model-serving state.
- [x] A second invocation attaches to the active application instead of starting a second Data Plane.
- [x] Explicit quit follows the existing ownership policy and graceful drain semantics before resources are released.
- [x] CLI and future desktop launchers no longer need separate recovery or shutdown composition logic.
- [x] Normal and recovery application cleanup use one lifecycle ownership model and remain deterministic under failure.
