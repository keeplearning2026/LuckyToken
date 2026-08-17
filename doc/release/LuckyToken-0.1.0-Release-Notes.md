# LuckyToken 0.1.0 — Release Notes (Windows-first)

Status: **release candidate certification** (Ticket 26). No partial release is
published; every item below is the recorded release evidence.

## Product shape

- Windows-first Tauri 2 desktop shell (React 19 / Vite / TypeScript) + the
  independent Node LuckyToken core that owns Pi AI IR, protocol conversion,
  providers, aliases, Client tokens, observability, and backup.
- One active current-user Control Plane (versioned wire, Named Pipe with a
  strict current-user ACL). The desktop attaches to a headless owner and can
  launch its own desktop-owned backend from the installed layout.
- Transparent `%USERPROFILE%\.luckytoken\` user root: `models.json`,
  `auth.json`, `model-aliases.json`, Client tokens, and app data.

## Bundled tickets (all complete)

01–26 of `.tickets/luckytoken-desktop-product-2026-08/` are implemented and
verified: versioned Control Plane, desktop shell and Dashboard, runtime
supervisor, tray lifecycle, headless ownership and graceful exit, settings,
permanent diagnostics with credential redaction, models.json management,
pinned Pi provider composition, catalog cache/refresh/isolation, credential
management, Provider-owned authentication projection, alias registry,
alias-only data plane, Client Token Authority and directory scopes, Request
Ledger, Requests page, terminal usage normalization, Analytics, Deep
Diagnostics, history export/delete/degradation, safe backup and
incompatible-config refusal, actionable notifications/tray aggregate state,
and complete Windows release certification.

## Certified evidence (Ticket 26)

- **Version single-source**: root `package.json` drives every shipped
  surface (workspaces, Cargo, tauri.conf); `scripts/sync-release-version.mjs`
  and `test/certification/release-version-sync.test.mjs` enforce it; the
  Control Plane `hello` reports the installed version.
- **Desktop-owned backend**: `packages/desktop-shell/src-tauri/backend_launcher.rs`
  resolves `launcher.json`, and the connector spawns the backend exactly once
  when no Control Plane exists; Rust tests cover parsing, argv contract, and
  spawn gating. Owner-aware tray Quit drains the backend through an
  acknowledged `application_command quit`; a headless owner is never quit by
  an attached UI.
- **Installed layout**: `scripts/assemble-release-backend.mjs` assembles the
  portable Node runtime, core `dist`, production `node_modules`, and
  `launcher.json` into `packages/desktop-shell/backend`;
  `test/certification/release-backend-serve.test.mjs` boots the assembled
  layout as a desktop-owned instance (first-run config, Data Plane on the
  fixed port, acknowledged quit drain).
- **NSIS per-user installer**: `tauri.release.conf.json` enables NSIS
  currentUser packaging with the backend as bundled resources.
- **Machine-scoped evidence** (`scripts/windows-release-certification.ps1`):
  clean-install first run, installed layout, fixed-port behavior, sign-in
  auto-start, second-user pipe blocking, LAN isolation, and uninstall data
  preservation are executed on a clean Windows VM and recorded as sanitized
  JSON evidence.

## Known limitations

- The NSIS installer is unsigned; Windows SmartScreen may warn. Signing is
  required before external distribution and is tracked as a known
  limitation, never silently bypassed.
- Real account/subscription and API-key certification runs require explicit
  user authorization of credentials and network access; the offline
  deterministic suite is the default and the online evidence is recorded
  with Provider/version provenance when authorized.
