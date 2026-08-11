# 09 — Align CommandCode message sequence and synthetic tool results

**What to build:** `Context.messages[]` is converted into CommandCode
`params.messages[]` preserving source order and enforcing the cross-message
tool-call/tool-result sequence constraint: every `tool-call` is covered by an
immediately-following real or synthetic `ToolMessage`, correlation is by
`toolCallId` only, and orphan/duplicate/late results fail — per
`PI AI IR-Commandcode Private Conversion.md` Part I §9.

**Blocked by:** 08 — CommandCode message and tool conversion.

**Status:** ready-for-agent

- [ ] Linear source-order processing with only one request-local temporary
  state: `unresolvedToolCallIds: string[]`; initial `[]`.
- [ ] `flushMissingResults()` appends, in original tool-call order, exactly
  the documented synthetic `ToolMessage`:
  `{role:"tool", content:[{type:"tool-result", toolCallId, toolName:"",
  output:{type:"text", value:"No result — the tool call did not complete
  (interrupted or lost)."}}]}` — then clears the list.
- [ ] `UserMessage`/`AssistantMessage` trigger `flushMissingResults()` before
  their own conversion; an assistant message's tool-call IDs become the new
  `unresolvedToolCallIds`; no reading of `AssistantMessage.stopReason` for
  sequence decisions.
- [ ] `ToolResultMessage` consumes only its `toolCallId`: not in
  `unresolvedToolCallIds` → error (orphan/duplicate/late/foreign result);
  present → Chapter 8 conversion (real result) → remove the id; a real
  result that fails conversion is an error, never replaced by a synthetic
  one.
- [ ] End of messages runs `flushMissingResults()`.
- [ ] Invariants: source order preserved; synthetic messages inserted only
  to complete missing results; every ToolMessage consumes a pending id; all
  unresolved calls completed before next user/assistant or end; correlation
  is `toolCallId` only; no repaired Pi message representation is constructed.
- [ ] Unit tests cover complete turns, missing results, orphan/duplicate/
  late results, and mixed content ordering.

**Out of scope:** single-message conversion (08), assembly/serialization
(10).
