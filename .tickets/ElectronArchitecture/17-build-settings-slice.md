# 17 — Build Settings slice

**What to build:** Consolidate product configuration, routing, data-management, and advanced diagnostics into one Settings experience while keeping Backend authorities responsible for the facts being edited.

**Blocked by:** 13 — Build minimal Home readiness slice.

**Status:** ready-for-agent

- [ ] Settings presents General, Network, Routing, Data, and Advanced concerns as product sections rather than separate top-level engineering pages.
- [ ] Registered Backend settings use typed query/update operations with correct hot-apply versus restart-required presentation.
- [ ] Routing/model/alias edits preserve their owning revision/conflict semantics and keep unsaved drafts renderer-local until explicitly saved.
- [ ] History, backup, diagnostics, and deep-diagnostics actions remain bounded by their existing Backend contracts and confirmation gates.
- [ ] Desktop-only platform settings such as UI auto-start use the platform namespace rather than being added to Backend/Control Plane domain state.
- [ ] Each Settings section is testable with a fake Desktop API without accessing files, Node, Electron, or real persistence.
