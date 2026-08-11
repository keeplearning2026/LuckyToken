# 04 — Align Anthropic response conversion with the conversion method

**What to build:** A committed Pi `AssistantMessage` plus
`AnthropicRenderState` is converted into exactly one authoritative Anthropic
`Message` — content, usage, termination — following `Anthropic-Pi AI IR
Conversion Method.md` Part III. Any committed Pi state that cannot form a
truthful Anthropic response raises `OutboundResponseFidelityFailure` instead
of guessing.

**Blocked by:** 03 — Complete model-aware Anthropic validity and invocation
composition.

**Status:** ready-for-agent

- [ ] Message identity/envelope: generated `id` (never Pi `responseId`),
  `type:"message"`, `role:"assistant"`, `model = renderState.clientModel`
  (never `AssistantMessage.model/responseModel/provider/api`),
  `container:null`.
- [ ] Content projection per §4: `TextContent → TextBlock {citations:null}`;
  ordinary `ThinkingContent → ThinkingBlock {signature: ?? ""}`; redacted
  `ThinkingContent` is **discarded** (never converted to text/thinking/
  placeholder); `ToolCall → ToolUseBlock {caller:{type:"direct"}}`; relative
  order preserved with dense re-indexing.
- [ ] ToolCall arguments contract per §4.5: root must be a non-null JSON
  object, nested JSON values only; non-object root/undefined/function/symbol/
  BigInt/NaN/Infinity/cyclic → `OutboundResponseFidelityFailure`; no repair,
  no `{}` replacement, no stringify-and-hope.
- [ ] Empty projected content check per §4.6: `content.length === 0` →
  `OutboundResponseFidelityFailure`; no placeholder text.
- [ ] Usage projection per §5: `input/output/cacheRead/cacheWrite` direct;
  `reasoning` presence-based (`undefined → output_tokens_details:null`, `0 →
  {thinking_tokens:0}`); `cacheWrite1h` presence-based breakdown;
  `0 <= reasoning <= output` and `0 <= cacheWrite1h <= cacheWrite` invariants;
  `server_tool_use/inference_geo/service_tier → null`; `totalTokens/cost`
  ignored (no protocol-visible accounting).
- [ ] Termination per §6: `stop→end_turn`, `length→max_tokens`,
  `toolUse→tool_use`; `pending/error/aborted/deferred` never mapped to a
  successful stop_reason; no recovery from `rawStopReason`.
- [ ] ToolCall/termination consistency per §6.3: `toolUse ⇔ surviving
  ToolCall`, otherwise `OutboundResponseFidelityFailure`.
- [ ] Tolerant source projection (unknown extra Pi fields do not fail) while
  strict target construction (no guessing/omission/coercion).
- [ ] Unit tests cover text/thinking/redacted/tool-call/usage/termination
  projections and every fidelity-failure branch.

**Out of scope:** rendering modes (ticket 05), request-side conversion
(01–03).
