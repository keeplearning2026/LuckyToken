# 05 — Preserve Anthropic message order and system-prompt semantics

**What to build:** Any valid Anthropic request reaches Pi with model-visible blocks in original order, including mixed ordinary content and ToolResults, while the documented message-level system compatibility rule and final-assistant prefill degradation remain explicit.

**Blocked by:** 01 — adapter-owned configuration seams; 02 — request-local notices and failure journal.

**Status:** ready-for-agent

## Module seam

Deepen the Anthropic request converter so one interface accepts a validated Anthropic request and returns selector, Pi Context/options, render state, and Anthropic-local notices. Block segmentation, message merging, system-prompt construction, and prefill classification remain internal.

No Responses converter/config/helper may be imported. The shared Pi types are the only semantic dependency.

## Information lifecycle

Source content blocks are consumed once in order. Temporary ordinary-message segments and tool correlation are request-local. Promoted system text exists only as the final Pi systemPrompt. Source role markers and prefill facts are discarded after conversion except for non-model-visible notices.

## Acceptance criteria

- [ ] `text A → tool_result X → text B` produces `User(A) → ToolResult(X) → User(B)` without rejection or reordering.
- [ ] Empty ordinary segments produce no synthetic messages; safe adjacent-role merging never crosses a ToolResult boundary.
- [ ] Top-level `system` string/blocks form the initial Pi systemPrompt with the frozen newline rule.
- [ ] Only the first message-level `role=system` is appended to Pi systemPrompt; later message-level system entries become user messages in original order.
- [ ] Non-text blocks in a message-level system entry do not gain system privilege and follow their normal mapping.
- [ ] A final assistant prefill is accepted as ordinary historical AssistantMessage and emits an Anthropic-local degradation notice.
- [ ] Source message/content objects are not mutated and temporary state cannot leak across concurrent requests.
- [ ] Tests assert complete Pi message order and systemPrompt text through the converter interface.
- [ ] Existing fixture tests are updated to assert semantics, not only acceptance.
- [ ] No Provider or Responses vocabulary/import appears in the Anthropic request module.

## Out of scope

Complete ToolResult validation/repair (06) and known server-tool/document families (08).

