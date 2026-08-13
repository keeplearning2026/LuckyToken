# 28 — Rebind full-route conformance and architecture certification

**What to build:** The repository proves that all frozen conversion and passthrough profiles work through their real interfaces, that Client Protocols remain independent, and that every known implementation gap has a passing test or an explicit online-evidence record.

**Blocked by:** 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27 — all implementation slices.

**Status:** ready-for-agent

## Module seam

Certification consumes immutable public route/config/spec facts and existing test entry points. It does not become a new runtime manager. Protocol-specific conformance suites remain under their owning adapters; architecture tests inspect dependency rules without sharing conversion fixtures as semantic evidence.

## Information lifecycle

Test fixtures are explicit sanitized evidence. Online captures are stored only under approved artifact/redaction rules. Certification hashes bind governing specs/manifests; no runtime mutable state enters certification.

## Acceptance criteria

- [ ] Certification binds the frozen shared architecture policy and all three conversion documents without weakening existing immutable markers.
- [ ] Anthropic conversion, Anthropic passthrough, Responses conversion, Responses passthrough, and CommandCode Provider profiles are named and certified separately.
- [ ] Architecture tests prohibit Anthropic↔Responses imports of config, converters, repair helpers, correlation state, render state, session authority, passthrough classifiers, and protocol error mappers.
- [ ] Architecture tests permit only Pi public contracts and narrow protocol-neutral Runtime interfaces at shared seams.
- [ ] The 27 Responses fixtures assert developer/system prompt delivery, actual tools/options, grammar, store behaviour, and message/tool ordering—not merely HTTP 200/shape.
- [ ] Fixtures/test corpus covers previous-response hit/miss/store modes, images/files/reasoning-only, argument errors, every known item/tool family, and completed/incomplete/failed SSE.
- [ ] Anthropic tests cover mixed content/result order, system compatibility, prefill degradation, thinking budgets/cache, redacted/missing-signature, empty content, JSON/SSE usage, and passthrough transport.
- [ ] CommandCode tests cover historical stopReason ignoring, real/synthetic ToolResults, constraints, payload authority, every JSONL event, pause policies, identity/usage normalization, abort/cancel, HTTP/stream errors, retries, and caps.
- [ ] Cross-request tests prove notices, failures, journals, session state, and transport facts cannot leak between requests or protocols.
- [ ] Every final failed request writes one safe journal; success writes none; journal failure preserves protocol outcome.
- [ ] Full `npm test`, typecheck, lint, build, and `git diff --check` pass.
- [ ] Online CommandCode/Responses/passthrough tests are run when credentials are available; otherwise certification records the exact evidence gap without claiming pass.
- [ ] Historical comparison documents and any remaining obsolete ticket references are marked non-authoritative.

## Out of scope

Adding new protocol features beyond the frozen specifications.
