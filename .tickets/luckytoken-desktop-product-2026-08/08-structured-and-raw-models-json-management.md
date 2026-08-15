# 08 — Structured and raw models.json management

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Let users manage the LuckyToken-owned, Pi-compatible models.json as a transparent authority. Providers and Models & Aliases pages offer a structured editor covering the pinned schema and a raw JSON editor over the same file. Valid changes are atomically applied; invalid proposed writes are rejected with exact errors and never damage the last valid file.

**Blocked by:** 01 — Versioned local Control Plane status tracer; 02 — Windows Desktop Shell and empty Dashboard; 07 — Permanent Runtime Diagnostics and universal credential redaction.

**Status:** ready-for-agent

## Implementation method

Use the `$tdd` skill. Confirm Control Plane catalog/configuration commands and queries as the seam. Write a failing behavior test before each schema/edit/apply case and avoid assertions against parser or editor internals.

## Acceptance criteria

- [ ] LuckyToken uses its own user data directory and does not read or overwrite the Pi Agent default data directory implicitly.
- [ ] Structured and raw editors read and write the same authoritative models.json revision.
- [ ] The structured editor can represent every field in the repository-pinned Pi models.json schema, including Provider and model extension fields.
- [ ] A successful edit validates, obtains the required lock, atomically replaces the file, and publishes the resulting configuration revision.
- [ ] Concurrent UI and CLI edits cannot lose updates; stale-revision writes receive an explicit conflict.
- [ ] Invalid JSON or schema content is rejected before replacement and reports the source location and validation error.
- [ ] Opening the Control Plane with an invalid existing file still permits inspection of the exact file location and error without automatically overwriting it.
- [ ] Tests prove raw/structured coherence, atomic replacement, validation, stale-write conflict, and preserved last-valid content through public commands and queries.
