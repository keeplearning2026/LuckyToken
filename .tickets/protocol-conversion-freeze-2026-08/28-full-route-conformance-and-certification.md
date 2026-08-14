# 28 — Rebind full-route conformance and architecture certification

**What to build:** The repository proves that all frozen conversion and passthrough profiles work through their real interfaces, that Client Protocols remain independent, and that every known implementation gap has a passing test or an explicit online-evidence record.

**Blocked by:** 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27 — all implementation slices.

**Status:** completed

## Module seam

Certification consumes immutable public route/config/spec facts and existing test entry points. It does not become a new runtime manager. Protocol-specific conformance suites remain under their owning adapters; architecture tests inspect dependency rules without sharing conversion fixtures as semantic evidence.

## Information lifecycle

Test fixtures are explicit sanitized evidence. Online captures are stored only under approved artifact/redaction rules. Certification hashes bind governing specs/manifests; no runtime mutable state enters certification.

## Acceptance criteria

- [x] Certification binds the frozen shared architecture policy and all three conversion documents without weakening existing immutable markers.
- [x] Anthropic conversion, Anthropic passthrough, Responses conversion, Responses passthrough, and CommandCode Provider profiles are named and certified separately.
- [x] Architecture tests prohibit Anthropic↔Responses imports of config, converters, repair helpers, correlation state, render state, session authority, passthrough classifiers, and protocol error mappers.
- [x] Architecture tests permit only Pi public contracts and narrow protocol-neutral Runtime interfaces at shared seams.
- [x] The 27 Responses fixtures assert developer/system prompt delivery, actual tools/options, grammar, store behaviour, and message/tool ordering—not merely HTTP 200/shape.
- [x] Fixtures/test corpus covers previous-response hit/miss/store modes, images/files/reasoning-only, argument errors, every known item/tool family, and completed/incomplete/failed SSE.
- [x] Anthropic tests cover mixed content/result order, system compatibility, prefill degradation, thinking budgets/cache, redacted/missing-signature, empty content, JSON/SSE usage, and passthrough transport.
- [x] CommandCode tests cover historical stopReason ignoring, real/synthetic ToolResults, constraints, payload authority, every JSONL event, pause policies, identity/usage normalization, abort/cancel, HTTP/stream errors, retries, and caps.
- [x] Cross-request tests prove notices, failures, journals, session state, and transport facts cannot leak between requests or protocols.
- [x] Every final failed request writes one safe journal; success writes none; journal failure preserves protocol outcome.
- [x] Full `npm test`, typecheck, lint, build, and `git diff --check` pass.
- [x] Online CommandCode/Responses/passthrough tests are run when credentials are available; otherwise certification records the exact evidence gap without claiming pass.
- [x] Historical comparison documents and any remaining obsolete ticket references are marked non-authoritative.

## Completion evidence

- Replaced the Anthropic-only v1 record with `serving-conformance-v2.json`.
  It binds canonical-LF SHA-256 hashes for the shared architecture policy and
  all three conversion methods, and names five route/Provider profiles with
  explicit offline evidence paths.
- Added TypeScript-AST architecture certification that recursively rejects
  sibling Client Protocol imports, concrete Client imports from CommandCode,
  and any unclassified shared seam outside the narrow neutral allowlist.
- Strengthened all 27 sanitized Codex CLI fixture replays to prove exact
  developer/system delivery, executable tool order, provider options, Pi Lark
  grammar mapping, documented CommandCode grammar degradation, source-to-wire
  text/reasoning/tool ordering and correlation, and `store:false=honor` misses.
- Added a real dual-handler concurrency test proving Anthropic and Responses
  failure facts, safe IDs, attempts, and final journal files remain isolated;
  the subsequent successful request writes no journal. Existing diagnostics
  tests retain exactly-once, bounded-redaction, retention, and writer-failure
  evidence.
- Updated current architecture/analysis authorities and marked historical
  handoff/comparison/audit material non-authoritative where it retains obsolete
  pre-contraction observations. Per task instruction, `INDEX.md` was not
  modified; its pre-task status rows are non-authoritative for this scoped
  completion and must be reconciled by the merge owner.
- Offline gates passed: certification 10/10; Vitest 91 files / 1189 tests;
  typecheck, lint, build, and `git diff --check`.
- No online entrypoint was run by explicit user decision. The v2 record marks
  CommandCode, Responses, Codex, and both native passthrough profiles
  `EVIDENCE_INSUFFICIENT`, including the fact that no dedicated passthrough
  live runner exists; it claims no online pass.

## Out of scope

Adding new protocol features beyond the frozen specifications.
