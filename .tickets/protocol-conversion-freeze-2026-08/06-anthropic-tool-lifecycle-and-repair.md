# 06 — Enforce Anthropic tool lifecycle and local missing-result repair

**What to build:** Anthropic tool calls/results preserve identity, content, error state, and order; invalid orphan/duplicate states fail precisely; missing results are repaired only by the Anthropic adapter under its own frozen policy.

**Blocked by:** 05 — Preserve Anthropic message order and system-prompt semantics.

**Status:** ready-for-agent

## Module seam

Tool correlation is private implementation inside the Anthropic request converter. Do not export a generic lifecycle manager or reuse Responses/CommandCode repair code. Tests cross the Anthropic converter interface with complete requests.

## Information lifecycle

The request-local call map stores only call ID, tool name, resolution state, and source order. It is destroyed after conversion. Synthetic results and notice facts are emitted at the exact history boundary where unresolved calls must be closed.

## Acceptance criteria

- [ ] `tool_use` preserves non-empty ID, name, and lossless JSON-object input in Pi ToolCall.
- [ ] ToolResult preserves toolCallId, correlated toolName, isError default/explicit value, ordered text, base64 images, and addedToolNames from valid tool references.
- [ ] Orphan ToolResult and result-before-call are fixed conversion errors.
- [ ] Duplicate ToolResult for the same call is a fixed conversion error.
- [ ] Malformed/empty IDs, non-object call input, and unknown referenced tool names fail precisely.
- [ ] Unresolved calls apply Anthropic-local `error|xrepair`, default xrepair, at message/history boundaries and end of history.
- [ ] Xrepair preserves original call ID/name, sets Pi isError=true, uses exactly `No result — the tool call did not complete (interrupted or lost).`, and emits an Anthropic-local notice.
- [ ] A real ToolResult is never changed, replaced, or assigned the synthetic text.
- [ ] Multiple unresolved calls are repaired in source call order.
- [ ] Tests cover mixed blocks, multiple calls, orphan, duplicate, malformed, both policies, notice redaction, and concurrent-request isolation.
- [ ] No Responses or CommandCode repair helper/config/state is imported.

## Out of scope

Provider-local CommandCode adjacency repair (21).
