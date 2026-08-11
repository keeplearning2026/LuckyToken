# 14 — Rebind certification and docs to the revised conversion documents

**What to build:** The certification tests and serving manifest agree with
the actual conversion documents, and the full verification suite
(typecheck, unit, integration, certification, lint, build) is green, so the
repository's declared "CERTIFIED" state is truthful again.

**Blocked by:** 13 — Runtime, attempts, and cancellation uncoupled (the
certification suite exercises the whole serving route; may be worked in
parallel once the code-side tickets are complete).

**Status:** ready-for-agent

- [ ] `test/certification/serving-composition-sync.test.mjs` binds to the
  actual conversion document filename(s) under `doc/Protocols/` (currently
  `Anthropic-Pi AI IR Conversion Method.md` and
  `PI AI IR-Commandcode Private Conversion.md`), with the version markers
  the documents actually carry (e.g. "Version:" headers if present), instead
  of the stale `LuckyToken CommandCode Private Provider Conversion Method.md`
  filename and old markers.
- [ ] `test/certification/anthropic-protocol-sync.test.mjs` is re-aligned to
  the current protocol-dependency markers and reviewed-document hash if the
  Anthropic protocol artifact was revised; the bound SHA-256 is updated to
  the actual current protocol document.
- [ ] The serving manifest/`commandcode-serving-certification.ts` revision
  constant and any pinned Pi runtime integrity values are refreshed to match
  the verified state, and `serving-conformance-v1.json` still lists exactly
  the commands that pass.
- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and
  `git diff --check` all pass after the rebind.
- [ ] No ticket closes or modifies any parent issue; certification updates
  only record the true current state.

**Out of scope:** semantic code changes (01–13).
