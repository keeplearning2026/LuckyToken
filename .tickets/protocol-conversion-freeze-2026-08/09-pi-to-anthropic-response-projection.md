# 09 — Project Pi responses faithfully into Anthropic messages

**What to build:** A successful Pi AssistantMessage becomes one complete, internally consistent Anthropic message with correct content, identity, usage, and terminal semantics.

**Blocked by:** 01 — adapter-owned configuration; 02 — request-local notices.

**Status:** ready-for-agent

## Module seam

Deepen the Anthropic response converter: one interface accepts a Pi AssistantMessage plus Anthropic render state and returns an immutable Anthropic message or a typed conversion failure. JSON/SSE renderers consume this result without repeating semantic decisions.

## Information lifecycle

Pi responseModel/diagnostics/raw reason remain internal unless the target has a safe field. Request selector enters render state and is destroyed after response. Generated identity is request-local.

## Acceptance criteria

- [ ] Pi responseId is used when valid; otherwise generate a valid high-entropy Anthropic ID.
- [ ] model always echoes the Client selector and never leaks Pi responseModel.
- [ ] Text maps exactly; ordinary thinking preserves text/signature.
- [ ] Missing ordinary thinking signature becomes empty string and emits an Anthropic-local notice; no cryptographic value is fabricated.
- [ ] Redacted Pi thinking maps to redacted_thinking with opaque data; redacted-only content succeeds.
- [ ] ToolCall preserves ID/name/lossless object arguments.
- [ ] Empty projected content remains an empty array; no empty text block is invented.
- [ ] Pi length maps to max_tokens; otherwise actual ToolCall content determines tool_use/end_turn and mismatches create non-model-visible diagnostics.
- [ ] input/output/cache/reasoning usage maps to the active Anthropic profile, including thinking token details.
- [ ] Unknown Pi content follows Anthropic response-local error|ignore, default error; unknown stop never fabricates success.
- [ ] Tests exercise only the response converter interface and cover every content/terminal/usage combination.

## Out of scope

Wire serialization and SSE ordering (10).

