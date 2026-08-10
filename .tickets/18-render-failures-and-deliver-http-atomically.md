# 18 — Render failures and deliver HTTP atomically

**What to build:** Render failures according to the boundary that detected them and deliver either a fully serialized Anthropic success or a protocol-appropriate error without partial writes, response resurrection, or fake successful assistant messages.

**Blocked by:** 03 — Complete the HTTP, client-auth, and session lifecycle; 05 — Implement Anthropic source-profile and closed-world validation; 13 — Run CommandCode attempts, retries, timeouts, and cancellation; 16 — Implement Core atomic execution and abort-aware commit; 17 — Render schema-complete Anthropic JSON success.

**Status:** complete

- [x] Transport, authorization, invalid-request, unsupported-feature, model-resolution, runtime, aborted, Provider, and outbound-fidelity failures retain only the classification needed by Anthropic/HTTP rendering.
- [x] A failure before render state exists can still be rendered by the selected protocol or HTTP boundary without requiring fake state.
- [x] Pi error/aborted outcomes and malformed execution never become successful Anthropic Messages.
- [x] Success conversion, schema validation, JSON/SSE event construction, and UTF-8 serialization all complete before any successful response byte is written.
- [x] A rendering failure after model commit but before HTTP write produces a server error when the connection remains writable.
- [x] Disconnect before semantic commit aborts execution; disconnect after commit leaves semantic success intact but stops delivery.
- [x] The HTTP boundary mechanically writes already-decided status, headers, and body and never interprets conversational or Provider semantics.
- [x] Tests force failure at every stage, including late block serialization, and assert zero successful bytes before complete serialization.
