# 23 — Isolate Client Protocols behind Pi IR

**What to build:** Make Pi the only semantic boundary between every Client Protocol and every Provider so either side can be added or replaced without changing the other.

**Blocked by:** 22 — Hide concrete Providers behind Pi Models.

**Status:** complete

- [x] Runtime and HTTP routing own only HTTP route/lifecycle concerns and contain no Anthropic, OpenAI, CommandCode, or other concrete integration semantics.
- [x] A minimal `ClientProtocolHandler` route contract uses WHATWG `Request`/`Response` without introducing a message/request IR.
- [x] The Anthropic Messages handler owns Anthropic parsing, validity, Client ↔ Pi conversion, model-aware policy, and response rendering.
- [x] Anthropic-specific option validation lives inside the Anthropic adapter rather than generic Core.
- [x] CommandCode Provider code contains no Anthropic or other Client Protocol semantics; it converts only CommandCode ↔ Pi.
- [x] Multiple unrelated Client Protocol handlers can be registered without Runtime changes or route ambiguity.
- [x] Architecture tests reject imports and terminology crossing either side of the Pi boundary.
- [x] `AGENTS.md` records the Pi IR boundary as the repository's first architecture principle.
- [x] Full tests, typecheck, lint, build, and diff validation pass.
