# 19 — Cut over completely from Tauri/Rust to Electron

**What to build:** Make Electron the only production desktop implementation and remove the old Tauri/Rust desktop path instead of carrying two shells or compatibility layers.

**Blocked by:** 06 — Delete native Windows control-pipe implementation; 10 — Add BackendSupervisor attach-or-spawn lifecycle; 12 — Expose the typed preload desktop contract; 14 — Build Provider connection slice; 15 — Build Client Connect slice; 16 — Build Activity slice; 17 — Build Settings slice; 18 — Certify destroy-and-reopen fresh-state lifecycle.

**Status:** completed

- [x] The production desktop build, development workflow, packaging, and tests use Electron only.
- [x] Tauri host code, Rust desktop code, Tauri dependencies/configuration/scripts, old shell bridge/runtime, and duplicate renderer contract decoders are deleted rather than left disabled.
- [x] The repository production build contains no Rust/Cargo/Tauri dependency path.
- [x] Existing product capabilities required by the accepted Electron architecture are reachable through the new desktop seams before the old shell is removed.
- [x] Architecture certification fails if Tauri/Rust production artifacts, generic IPC, or duplicate desktop semantic contracts are reintroduced.
