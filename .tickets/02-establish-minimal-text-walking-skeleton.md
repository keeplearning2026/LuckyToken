# 02 — Establish the minimal text walking skeleton

**What to build:** Make one authorized, non-streaming Anthropic text request traverse the complete LuckyToken path—HTTP boundary, model resolution, Pi Models, a registered CommandCode Private Provider using fixture transport, atomic execution, and Anthropic JSON rendering—with a repeatable test command.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A minimal valid `POST /v1/messages` request produces one schema-valid Anthropic assistant text response.
- [ ] Startup creates Pi Models, registers the CommandCode Private Provider through the Pi public contract, and exposes only the runtime dependencies needed by request handling.
- [ ] The request path uses Pi `Model`, `Context`, `ModelsSimpleStreamOptions`, `AssistantMessageEventStream`, and `AssistantMessage` directly; no parallel LuckyToken request/message/response IR is introduced.
- [ ] The fixture upstream crosses the real Provider contract and emits a valid CommandCode text lifecycle rather than bypassing Provider conversion.
- [ ] The HTTP response is not written until Pi success has been atomically committed and the complete Anthropic body has serialized.
- [ ] Type-check and test commands are documented and run successfully from a clean checkout.

