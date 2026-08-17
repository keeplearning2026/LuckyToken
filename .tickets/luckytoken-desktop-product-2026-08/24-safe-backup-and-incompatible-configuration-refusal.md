# 24 — Safe backup and incompatible-configuration refusal

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Give users a predictable backup of LuckyToken-owned data and a safe response to incompatible configurations. Ordinary backup includes non-sensitive configuration by default; a separately confirmed full-sensitive backup may include credentials, Client tokens, permanent history, and deep captures. Incompatible LuckyToken-owned files are rejected without migration or overwrite while the Control Plane remains available for recovery.

**Blocked by:** 06 — Settings-driven protocol, port, and LAN controls; 11 — Model catalog cache, refresh, and Provider error isolation; 13 — Provider-owned account/subscription authentication projection; 14 — Global Model Alias Registry; 17 — Canonical directory Client token scopes; 23 — History export/deletion and persistence-failure degradation.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm backup/configuration commands and recovery snapshot queries as seams. Use temporary LuckyToken user roots and independent secret canaries; do not assert on archive-building helpers or storage layout internals.

## Acceptance criteria

- [x] Ordinary backup includes transparent non-sensitive configuration and identifies every included contract/schema version.
- [x] Ordinary backup excludes auth.json, Client token secrets, permanent request/diagnostic history, and Deep Diagnostics capture by default.
- [x] Full-sensitive backup requires explicit confirmation, clearly labels the artifact as sensitive, and may include each approved sensitive category.
- [x] Backup never silently reads or modifies Pi Agent, Claude Code, Codex, CC Switch, or OpenCodex private stores.
- [x] Unsupported LuckyToken-owned schema versions are rejected explicitly; the application never auto-migrates, repairs, resets, or overwrites them.
- [x] On incompatible configuration, the local Control Plane and UI still open and report the exact affected file, found/expected version, and validation error.
- [x] Data Plane capabilities that cannot be safely composed remain stopped/unavailable while unrelated inspect/export/recovery operations continue.
- [x] Tests prove safe/full inclusion matrices, redaction, interrupted backup handling, incompatible startup, preserved source bytes, and local recovery access.
