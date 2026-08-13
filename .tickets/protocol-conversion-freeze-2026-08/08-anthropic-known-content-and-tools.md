# 08 — Cover Anthropic known content, tools, and execution ownership

**What to build:** Every known Anthropic content/tool family has an explicit exact, degrade, drop, resolver-dependent, or error outcome, while Pi Context.tools remains the full current Client/BYOT catalog and provider-hosted work is never forged as a client tool.

**Blocked by:** 05 — message order; 06 — tool lifecycle; 07 — options/thinking/cache.

**Status:** completed

## Module seam

Known-family classification belongs inside the Anthropic adapter. Use a private classification table if it improves locality, but expose only the existing request conversion interface. Execution ownership is derived from Anthropic semantics/configuration, never concrete Provider identity.

## Information lifecycle

Resolver handles remain in Anthropic-owned capabilities and resolve to Pi bytes/text before crossing the seam. Server-tool metadata is consumed and dropped after representable content/transcript construction. The executable catalog is frozen per request.

## Acceptance criteria

- [x] Text, base64 image, ordinary/redacted thinking, and client tool_use map exactly where Pi supports them.
- [x] Document and search-result readable content degrades deterministically in source order; citations/source presentation without Pi slots drop.
- [x] Resolver-dependent URL/PDF/file content uses an Anthropic-owned trusted capability with abort/size/MIME limits; missing authority follows the known-family rule.
- [x] Server-hosted calls/results preserve representable result content/transcript and do not become Pi client-executable ToolCalls.
- [x] Ordinary Client/BYOT tools map name/description/schema/strict into Pi Tool.
- [x] Context.tools contains the complete current Client/BYOT catalog, including defer_loading definitions.
- [x] tool_reference maps valid names to addedToolNames without hiding unreferenced tools; unknown references fail.
- [x] Unknown content discriminator uses Anthropic-local error|ignore, default error; ignore emits notice and never supplies a terminal.
- [x] Known malformed content cannot be made valid by unknown=ignore.
- [x] Tests cover every installed Anthropic known family and future unknown separately.
- [x] No concrete Provider or Responses module participates in classification.

## Out of scope

Native passthrough, which may preserve unsupported native families without Pi (11).
