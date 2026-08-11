# 11 — Align CommandCode response reconstruction with the conversion method

**What to build:** A CommandCode HTTP response is consumed as a bare
LF-delimited JSONL stream (never conventional SSE), reconstructed into an
ordered committed `content[]` plus a replaceable `finish` candidate, and
committed only when every protocol condition is satisfied — per
`PI AI IR-Commandcode Private Conversion.md` Part II §1–§2.

**Blocked by:** 10 — CommandCode final request assembly and serialization.

**Status:** ready-for-agent

- [ ] HTTP framing: 2xx + readable body → consume; 2xx + missing body →
  transport failure; non-2xx → HTTP failure (body not used); `Content-Type`
  is not a gate.
- [ ] Physical stream decoding: TextDecoder chunk decode, line buffering,
  LF-split, framing-whitespace trim, skip empty lines, JSON.parse whole
  line, and flush/parse of a final unterminated line at physical EOF; no
  `data:`/`event:`/`[DONE]` handling.
- [ ] Accepted event types are exactly the documented whitelist
  (`start`, `start-step`, `reasoning-start/delta/end`,
  `text-start/delta/end`, `tool-input-start/delta/end`, `tool-call`,
  `finish-step`, `finish`, `provider-metadata`, `error`); each parsed value
  must be an object with non-empty string `type`; `start`/`start-step`/
  `finish-step`/`provider-metadata` are accepted no-ops; `error` → immediate
  failure; any other type → protocol error.
- [ ] Content reconstruction: new positions only from
  `text-start`/`reasoning-start`/`tool-input-start`; order = start-arrival
  order; independent ID namespaces (`textById`/`reasoningById`/`toolById`);
  duplicate start in one kind → protocol error; delta/end/final tool-call
  without matching open lifecycle → protocol error; closed lifecycles
  accept no further events.
- [ ] Text/reasoning: delta appends exactly; end requires
  `trim(text).length > 0` (validity only — stored text is never trimmed);
  EOF cannot auto-close open blocks.
- [ ] Tool lifecycle: `tool-input-start` requires `id`/`toolName`;
  `tool-input-delta` requires open + not-ended + string, and is **discarded**
  (never accumulated, never used to repair final input);
  `tool-input-end` idempotence-gated; final `tool-call` requires open +
  matching `toolCallId` + ended input; final authority is
  `tool-call.toolCallId/toolName` and `input ?? args ?? {}`; `tool-call`
  `toolName` is the only committed name (no start-vs-final comparison).
- [ ] Finish/error/EOF/commit: `finish` replaces the entire finish candidate
  (no field carry-forward); `finish` ≠ EOF ≠ commit (continue reading);
  EOF without finish → incomplete/truncated; EOF with open content →
  protocol error; `pause_turn` via `rawFinishReason ?? finishReason` at
  commit evaluation → response failure (never reaches stopReason
  conversion); commit requires all documented conditions.
- [ ] Committed response retains only `content[]` and
  `finish{finishReason?, totalUsage?}` (plus nothing else downstream needs);
  `Text.id`/`Reasoning.id`/input deltas/start toolName/rawFinishReason are
  out of the committed state; no RawUsage/NormalizedUsage intermediate
  representations.
- [ ] Attempt isolation: each attempt has fresh decoder/buffer/lifecycle/
  finish state; failed attempts discard state; retries start fresh.
- [ ] Unit tests cover framing, lifecycle validation, finish replacement,
  EOF/pause/abort/error classification, and committed-shape assertions.

**Out of scope:** Pi semantic conversion (12), HTTP attempts/retries (13).
