# 08 — Create Electron Main, preload, and packaging skeleton

**What to build:** Establish a TypeScript-only Electron desktop that can start securely and be packaged, without yet recreating the full LuckyToken product UI.

**Blocked by:** 01 — Freeze migration seams and architecture guards.

**Status:** completed

- [x] Electron Main, preload, and renderer build as separate trusted/untrusted contexts using the repository's TypeScript toolchain.
- [x] The management window uses context isolation, sandboxing, no renderer Node integration, restrictive navigation/window policy, and a packaged local UI.
- [x] Desktop single-instance behavior is deterministic and a second desktop launch focuses or opens the existing product instance rather than creating parallel desktop ownership.
- [x] Preload exists as a typed security seam but does not expose generic IPC or Backend domain operations before those contracts are implemented.
- [x] Development and release packaging no longer require Tauri for the new Electron path.
