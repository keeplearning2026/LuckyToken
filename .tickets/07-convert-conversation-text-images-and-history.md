# 07 — Convert conversation text, images, and history

**What to build:** Preserve supported Anthropic conversation semantics through Pi and into the CommandCode request, including exact text, supported images, ordered historical turns, and deterministic Pi-required historical shape.

**Blocked by:** 06 — Resolve models and enforce model-aware validity.

**Status:** complete

- [x] Ordinary message string shorthand canonicalizes only at its protocol-authorized death point.
- [x] Supported system forms map to `Context.systemPrompt` with exact text and omission preserved; unsupported multi-block/extension forms fail at the owning gate.
- [x] User text preserves empty strings, whitespace, tabs, and newlines without trimming, filtering, joining, or invented separators.
- [x] Supported base64 images preserve MIME type and payload; URL/document/search/server-tool content is rejected according to the support matrix without external I/O.
- [x] Same-role coalescing applies only to user/user and assistant/assistant turns and preserves block order.
- [x] Historical assistant messages receive the frozen synthetic client-owned provenance, zero usage, structural stop reason, and `receivedAt` timestamp without pretending target-model provenance.
- [x] Opaque historical continuation is rejected or omitted only under the frozen same-target/foreign-target rules; no provider normalization is relied upon to repair accepted history.
- [x] An end-to-end fixture proves accepted conversation semantics reach the CommandCode wire unchanged.
