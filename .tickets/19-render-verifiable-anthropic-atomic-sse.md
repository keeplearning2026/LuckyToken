# 19 — Render verifiable Anthropic Atomic SSE

**What to build:** Serialize the same committed Anthropic Message used by JSON into a legal, fully buffered SSE lifecycle whose every frame is schema-valid and whose protocol accumulation reconstructs the same semantic Message.

**Blocked by:** 17 — Render schema-complete Anthropic JSON success; 18 — Render failures and deliver HTTP atomically.

**Status:** ready-for-agent

- [ ] `stream=true` changes only response representation and never enables live Pi-to-client delta forwarding.
- [ ] The lifecycle is `message_start → ordered content blocks → message_delta → message_stop` with no `[DONE]` sentinel.
- [ ] Message-start, content-start, message-delta, final usage, and every required-nullable field satisfy the current Anthropic streaming schemas independently.
- [ ] Each text block emits one full text delta, including an explicit empty delta for empty text, then stops at the correct index.
- [ ] Each tool block starts with empty input plus direct caller, emits one complete JSON input delta, and reconstructs the exact validated final object.
- [ ] A protocol-owned reference accumulator rebuilds the target Message; the rebuilt message equals the JSON target for all represented semantic fields and uses the same message ID.
- [ ] The cumulative usage trajectory is established by conformance evidence rather than an invented initial-count convention.
- [ ] Supported official Anthropic SDK consumers accept the complete emitted stream.
- [ ] All frames are generated, validated, framed, and UTF-8 encoded before the HTTP 200 response begins.

