# 14 — Atomically assemble CommandCode JSONL responses

**What to build:** Decode a physical CommandCode response as bare JSON Lines and commit one ordered semantic result only after a valid final finish plus physical EOF, with strict, interleaving-safe text, reasoning, and tool state machines.

**Blocked by:** 02 — Establish the minimal text walking skeleton.

**Status:** complete

- [x] UTF-8 code points and JSON lines can span network chunks; multiple lines per chunk, CRLF, empty lines, and a final unterminated line are handled correctly.
- [x] Conventional SSE fields and `[DONE]` are not interpreted as CommandCode framing.
- [x] Only content-start events reserve ordered slots; per-kind ID maps allow cross-content interleaving without completion-order or timestamp reordering.
- [x] Text and reasoning require matching open start/delta/end lifecycles and non-whitespace completed content.
- [x] Tool input start/delta/end remains temporary preview state; only a matching final tool-call after input end supplies authoritative name and input.
- [x] Known ignored events are distinguished from unknown or malformed known events; unknown/malformed input fails non-retryably.
- [x] Every finish replaces the previous complete finish/usage candidate, but commit waits for physical EOF and all slots closed.
- [x] EOF without finish is retryable truncation; finish with open blocks is protocol failure; pause, wire abort, and stream error never return a committed result.
- [x] No Pi semantic event or downstream byte is emitted before assembler commit, and all request-local state is discarded on failure.
