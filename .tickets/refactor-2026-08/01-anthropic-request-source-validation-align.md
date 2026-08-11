# 01 — Align Anthropic request source validation with the conversion method

**What to build:** A client that posts an Anthropic Messages request to the
local LuckyToken server gets either a faithful Pi AI IR invocation, an
`InvalidRequest` (400) for malformed-but-convertible input, or an
`UnsupportedFeature` (400) for valid input that has no faithful Pi
representation — exactly as `Anthropic-Pi AI IR Conversion Method.md` Part II
defines. No source semantic is silently dropped, guessed, or coerced.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `request.system` handling matches §3: string preserved exactly;
  `TextBlock[]` joined with `"\n"` in source order; empty array produces
  `""`; absent produces absent; no synthetic system prompt.
- [ ] Message role handling matches §4: `user`, `assistant`, and
  mid-conversation `system` (converted to Pi `UserMessage`) are supported;
  roles outside `user|assistant|system` are `InvalidRequest`.
- [ ] `tool_result` matches §4.2/§4.5: `content` may be absent/string/block
  array; absent → `[]`; string → one `TextContent`; block array supports
  `text` and base64 `image`; `is_error ?? false`; tool name correlation via
  request-local `tool_use_id → toolName` map; orphan/conflicting correlation
  is `InvalidRequest`.
- [ ] `tool_use` matches §4.3: `input` must be a JSON object, otherwise
  `InvalidRequest`.
- [ ] Final assistant message is treated as **prefill** and yields
  `UnsupportedFeature` (model-aware classification stays in ticket 03).
- [ ] Tool definitions match §5: `description ?? ""`, `input_schema` passed
  through as `parameters`, `strict:true` → `constrainedSampling
  {type:"json_schema", strict:"require"}`, `strict:false/absent` → absent.
- [ ] Invocation options match §6: `max_tokens → maxTokens` (including 0),
  `temperature → temperature` (pass-through), `output_config.effort →
  reasoning` for the five shared values, `metadata.user_id → metadata.user_id`
  (no empty `metadata:{}`).
- [ ] Top-level fields not converted by the method are ignored without
  registry inventory, and fields that would change request meaning when
  dropped are rejected.
- [ ] Unit tests cover each Source→Target→Construction rule above, including
  absence, malformed input, and unsupported-feature branches.

**Out of scope:** model-aware validity (ticket 03), response conversion
(ticket 04), SSE/JSON rendering (ticket 05).
