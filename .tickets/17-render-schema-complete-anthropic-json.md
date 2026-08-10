# 17 — Render schema-complete Anthropic JSON success

**What to build:** Convert one committed Pi assistant message into one schema-complete Anthropic Message and serialize it as non-streaming JSON with exact supported content, identity, usage, and termination semantics.

**Blocked by:** 15 — Convert committed CommandCode results into a Pi lifecycle; 16 — Implement Core atomic execution and abort-aware commit.

**Status:** ready-for-agent

- [ ] Every current Pi `AssistantMessage` field has an explicit exact, required-shape, internal, or certification-dependent disposition.
- [ ] Client-visible model echoes the original Anthropic selector; one client-protocol-owned opaque message ID is created after commit.
- [ ] Text, tool IDs, tool names, tool object input, and content ordering are preserved exactly; unsupported ThinkingContent fails instead of being dropped or textified.
- [ ] Tool input is validated as a JSON object tree before serialization; JSON encoding is not used as a repair mechanism.
- [ ] Message `container`, `stop_details`, and `stop_sequence`, TextBlock `citations`, and every required-nullable Usage field are explicitly present.
- [ ] Usage maps input, output, cache read/write, optional reasoning, and optional one-hour cache breakdown without recomputation or double counting.
- [ ] Supported stop, length, and toolUse outcomes map to end_turn, max_tokens, and tool_use only when certification proves other target states unreachable.
- [ ] Target message construction happens once; JSON serialization uses that exact object and does not expose internal Pi/provider identities.
- [ ] Exact empty and whitespace text fixtures, tool fixtures, malformed usage, and unsupported content all fail or render according to contract before HTTP write.

