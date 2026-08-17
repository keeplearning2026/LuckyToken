# 01 — Freeze migration seams and architecture guards

**What to build:** Lock the intended Core, Backend Application, Application Control Plane, and Desktop seams before migration work begins, so later Electron work can change implementation without silently changing model-serving semantics or dependency direction.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Existing model-serving behavior remains characterized through the public Core request seam and continues to pass without Electron or local-management transport involvement.
- [ ] Backend lifecycle, Control Plane semantic behavior, and the target desktop close/reopen behavior each have explicit public-seam tests that can go red independently.
- [ ] Architecture certification rejects Core dependencies on Electron or Control Plane implementation details, renderer dependencies on Node/Electron capabilities, and generic desktop IPC escape hatches.
- [ ] The migration baseline documents that old Tauri/Rust compatibility is not part of the target contract.
