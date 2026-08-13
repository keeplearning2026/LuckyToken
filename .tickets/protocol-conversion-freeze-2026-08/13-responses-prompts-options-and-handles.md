# 13 — Convert Responses privileged prompts, options, and handles

**What to build:** A Responses create request produces the correct Pi system prompt and option snapshot under full/first/user modes, while external opaque handles fail unless a trusted Responses-owned capability can materialize them.

**Blocked by:** 01 — configuration; 02 — notices/journal; 04 — Pi options composer; 12 — local state.

**Status:** ready-for-agent

## Module seam

Deepen the Responses request converter: one interface accepts an expanded/resolved Responses request and returns selector, Pi Context/options, render state, and Responses-local notices. Resolver ports exist only for genuinely variable production/test resource adapters and remain private dependencies of this Client adapter.

## Information lifecycle

Top-level instructions and input roles are consumed into one final Pi systemPrompt or ordered user messages. Opaque handles remain Client-side until materialized; raw IDs/credentials never cross Pi. Dropped controls survive only as request-local effective render facts where needed.

## Acceptance criteria

- [ ] Top-level instructions always leads Pi systemPrompt.
- [ ] full promotes all system/developer; first (default) promotes only those before the first user; user promotes none. Segments join with the frozen newline rule.
- [ ] Later privileged messages degraded to user remain in source order and are never silently lost.
- [ ] max_output_tokens, temperature, top_p, prompt cache retention, safety_identifier/user fallback, metadata echo, stream, and reasoning effort map correctly.
- [ ] effort absence/null/none, minimal–xhigh, ultra/max, and future max|omit|error default max follow the frozen matrix and notices.
- [ ] tool_choice none/auto/allowed filtering changes only the Responses-owned executable catalog; unsupported forced controls drop unless they require an unavailable tool.
- [ ] background=true is Core conversion error; false/null/absence stays synchronous.
- [ ] conversation, prompt, external item_reference, and foreign encrypted-only compaction are errors.
- [ ] Lucky-owned provable references/envelopes resolve/decode through narrow Responses-owned capabilities with abort/limit/authority tests.
- [ ] Unknown top-level auxiliary fields drop; unknown item discriminator uses Responses-local error|ignore default error.
- [ ] No Anthropic policy/helper/state or concrete Provider vocabulary is imported.

## Out of scope

Content families and tool lifecycle (14–16).

