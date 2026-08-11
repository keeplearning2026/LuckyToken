# 02 — Align Anthropic request → Pi invocation construction with the conversion method

**What to build:** The Anthropic request conversion produces exactly one
authoritative Pi / LuckyToken invocation state — `selector + Context +
SimpleStreamOptions + AnthropicRenderState` — with each Pi message and field
constructed per `Anthropic-Pi AI IR Conversion Method.md` Part II, without a
second normalized/shadow representation of the Anthropic request.

**Blocked by:** 01 — Anthropic request source validation align.

**Status:** ready-for-agent

- [ ] Construction is Source-driven and follows the Anthropic hierarchy:
  `request.model → selector`, `request.system → Context.systemPrompt`,
  `request.messages → Context.messages`, `request.tools → Context.tools`.
- [ ] A single Anthropic message may produce multiple Pi messages (ordinary
  user content → `UserMessage`, each `tool_result` → its own
  `ToolResultMessage`, per §4.2); source order is preserved; adjacent
  ordinary text/image blocks stay in one `UserMessage.content[]`.
- [ ] Historical assistant messages construct `AssistantMessage` with
  synthetic client-history `api`/`provider`, `model = request selector`,
  zero `usage`, `stopReason` derived from content (contains ToolCall →
  `toolUse`, otherwise `stop`), `timestamp = receivedAt` — and these
  synthetic facts never claim Anthropic/provider provenance.
- [ ] Tool identity correlation is request-local, minimal, and disappears
  after conversion; it never leaks into `Context`, `SimpleStreamOptions`, or
  `AnthropicRenderState`.
- [ ] `SimpleStreamOptions` carries exactly `maxTokens`, optional
  `temperature`, optional `reasoning`, optional `metadata.user_id`; no
  unrelated Pi options are introduced.
- [ ] `AnthropicRenderState` carries exactly `clientModel` and `stream` and
  is the only place those request-local render facts live.
- [ ] The conversion never expands the Pi Target to mirror Anthropic-specific
  protocol features.
- [ ] Unit tests assert the full constructed invocation (selector, context,
  options, renderState) for representative requests and the one-source-many-
  target message splitting cases.

**Out of scope:** validation rules (ticket 01), model-aware validity
(ticket 03), response conversion (ticket 04), rendering (ticket 05).
