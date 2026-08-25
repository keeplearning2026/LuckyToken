# 02 — Extract normal Backend Application bootstrap from CLI

**What to build:** Make normal Token serving start through one Backend Application lifecycle seam so the CLI becomes only a product adapter that parses arguments, starts the application, and reports results.

**Blocked by:** 01 — Freeze migration seams and architecture guards.

**Status:** completed

- [x] Normal serving can be started and closed through one narrow Backend Application interface without the caller constructing stores, supervisors, providers, or Control Plane authorities individually.
- [x] The existing HTTP model-serving behavior, Provider composition, settings, request ledger, diagnostics, and Control Plane availability remain externally unchanged.
- [x] CLI behavior is preserved through the new application seam while CLI argument parsing and presentation remain outside application ownership.
- [x] Cleanup through the application seam closes all resources created by a normal serving boot exactly once.
