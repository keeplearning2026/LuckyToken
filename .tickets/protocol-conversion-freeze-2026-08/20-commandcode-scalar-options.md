# 20 — Align CommandCode scalar options and synchronous execution

**What to build:** A Pi invocation produces the correct CommandCode scalar parameters and execution controls without rejecting auxiliary Pi fields that CommandCode cannot represent.

**Blocked by:** 01 — adapter-owned configuration; 02 — notices/journal; 04 — Pi options composer.

**Status:** ready-for-agent

## Module seam

Deepen CommandCode request conversion behind one Provider-owned interface that accepts Pi model/context/options plus immutable Provider policy and returns a certified logical request candidate. Scalar mapping remains internal and contains no Client Protocol vocabulary.

## Information lifecycle

Pi options are consumed once into CommandCode fields or documented drops. Session/project/telemetry facts remain infrastructure facts and never become model-visible messages. The logical request snapshot remains stable across retries.

## Acceptance criteria

- [ ] max_tokens uses options.maxTokens then model.maxTokens, otherwise target omission; no fixed 64000.
- [ ] Temperature maps only when present/valid.
- [ ] Reasoning uses model thinkingLevelMap or Pi supported-level clamp; unsupported xhigh/max does not reach an impossible mapper branch.
- [ ] Reasoning absence/off omits the target field without inventing a default.
- [ ] options.deferred true/object/false/absence all produce synchronous CommandCode wire omission; true/object no longer rejects.
- [ ] samplingParams, cacheRetention, thinkingBudgets, generic metadata, unsupported transport/env hints, and other targetless options drop without blocking the request.
- [ ] session/project values follow Provider authority and are not read from Client-specific config.
- [ ] Timeout/retry/callback/signal/telemetry controls use Provider-owned immutable settings and Pi public fields.
- [ ] Dropped targetless auxiliary options do not become prompt text or generic metadata.
- [ ] Tests cover every scalar/default/clamp/deferred/drop branch through the Provider request interface.
- [ ] No Anthropic/Responses imports or terms enter the Provider module.

## Out of scope

Message/tool conversion (21–22) and final authority certification (23).

