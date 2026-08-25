# 05 — Project Provider origin through the existing Auth contract

**What to build:** The product can distinguish Pi built-in, token-bundled, and user Providers through the existing Auth discovery response without creating a second Provider DTO tree or asking the Renderer to infer origin.

**Blocked by:** 02 — Move Provider creation behind one Backend-owned Provider Runtime.

**Status:** ready-for-agent

- [ ] Add RED contract tests for the Provider source values `pi_builtin`, `token_bundled`, and `user` through the strict Control Plane wire.
- [ ] Auth query projects Provider source alongside existing Pi-derived name/auth metadata and sanitized credential status.
- [ ] The `pi_builtin` Provider IDs returned by Auth query exactly match the pinned Pi `builtinProviders()` identities rather than a hand-maintained Token list.
- [ ] CommandCode Private is classified as `token_bundled` without hardcoding its authentication behavior in the UI or Control Plane adapter.
- [ ] A custom models.json Provider and an external Provider Package are classified as `user`; a models.json overlay of a Pi built-in remains `pi_builtin`.
- [ ] Missing or unknown source values fail closed at the wire boundary.
- [ ] No new Provider Registry, `DesktopProvider`, Electron DTO, duplicate model list, or Renderer inference is introduced.
- [ ] Provider-source metadata remains bounded and secret-free; package specifiers and credential values are not projected to the normal product UI.
