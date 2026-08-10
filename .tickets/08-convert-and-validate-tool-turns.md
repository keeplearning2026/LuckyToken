# 08 — Convert and validate tool-use and tool-result turns

**What to build:** Preserve the complete client-tool lifecycle from Anthropic history through Pi and CommandCode, using invocation IDs for correlation, turn-scoped temporary state, and explicit policies for every supported or unsupported ToolResult representation.

**Blocked by:** 07 — Convert conversation text, images, and history.

**Status:** complete

- [x] Anthropic `tool_use.id` and `tool_result.tool_use_id` are correlated by exact ID, never by position or tool name.
- [x] Pending tool state is scoped to the immediately preceding assistant tool turn and dies when all matching results are consumed or the request fails.
- [x] Duplicate calls, orphan results, duplicate results, unresolved calls, invalid placement, and ordinary content before required results are rejected as source-invalid.
- [x] One Anthropic user turn can expand into ordered Pi ToolResult messages followed by an optional UserMessage without creating an empty user message.
- [x] ToolResult omission, string, explicit empty string, whitespace, block-list, and explicit empty-array forms follow the frozen profile-specific policies without guessed equivalence.
- [x] `is_error` omission/false/true maps deterministically to Pi and CommandCode result state.
- [x] Pi tool calls reach CommandCode with exact IDs, names, object-shaped lossless JSON input, and collision checks; namespaces or required opaque continuity fail explicitly when unsupported.
- [x] The CommandCode-specific missing-result placeholder is used only for a known unresolved Pi tool call and preserves original call order.
- [x] Tests cover split and grouped parallel tool results and a complete next-turn round trip.
