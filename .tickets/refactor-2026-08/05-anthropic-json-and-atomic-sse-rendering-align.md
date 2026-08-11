# 05 — Align Anthropic JSON and Atomic SSE rendering with the conversion method

**What to build:** The single constructed Anthropic `Message` is rendered as
either JSON or Atomic SSE depending on `renderState.stream`, such that
accumulating the SSE lifecycle reconstructs the same final Message
(`Anthropic-Pi AI IR Conversion Method.md` Part III §8–§14).

**Blocked by:** 04 — Anthropic response conversion align.

**Status:** ready-for-agent

- [ ] `stream=false → JSON(M)`; `stream=true → Atomic SSE(M)`; both render
  from the same already-constructed Message; neither re-runs Pi→Anthropic
  conversion nor re-accesses the Pi `AssistantMessage`.
- [ ] Atomic SSE lifecycle is exactly `message_start → content block
  lifecycle* → message_delta → message_stop`; no `[DONE]` terminal.
- [ ] `message_start` carries partial Message (`content:[]`,
  `stop_reason:null`, initial usage with `output_tokens:0`,
  `output_tokens_details:null`); same id/model/role/type as final.
- [ ] Content block lifecycles match §11: TextBlock → `text_delta` full
  text; ThinkingBlock → `thinking_delta` + `signature_delta` (empty signature
  when absent); ToolUseBlock → `input_json_delta` = `JSON.stringify(final
  input)`; no redacted-thinking lifecycle; dense target indices.
- [ ] `message_delta` carries final termination (`container/stop_details/
  stop_sequence:null`, mapped `stop_reason`) and cumulative streaming usage
  (`MessageDeltaUsage` shape: no `cache_creation`, no `inference_geo`, no
  `service_tier`).
- [ ] JSON and SSE share the same message ID, model, surviving content,
  order, text, thinking, signatures, tool-call IDs/names/inputs, termination,
  and final usage; transport fragmentation is not part of semantic equality.
- [ ] Unit tests verify semantic equality between JSON and the
  accumulated SSE events for representative Messages, plus malformed-target
  failure branches.

**Out of scope:** conversion of Pi state (ticket 04), request side
(01–03).
