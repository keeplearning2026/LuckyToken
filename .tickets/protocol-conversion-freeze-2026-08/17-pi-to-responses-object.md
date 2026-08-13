# 17 — Build complete Pi-to-Responses objects and effective echoes

**What to build:** A successful Pi AssistantMessage becomes a complete Responses object whose identity, content, status, usage, and echoed controls describe what the adapter actually did.

**Blocked by:** 01 — configuration; 02 — notices/journal; 13 — request render facts; 16 — complete family matrix.

**Status:** ready-for-agent

## Module seam

Deepen the Responses response converter: one interface accepts Pi AssistantMessage plus immutable Responses render state and returns one complete Response object or typed conversion failure. SSE and JSON consume this object without repeating semantic mapping.

## Information lifecycle

Reverse tool-family/namespace metadata exists only in render state. Client selector is used for model echo then discarded. Pi responseModel/diagnostics remain internal. Resource metadata is echoed only if safely retained request-local.

## Acceptance criteria

- [ ] Use valid Pi responseId or generate high-entropy Responses ID; model always echoes Client selector.
- [ ] Emit every required target field/default/null: error, incomplete_details, instructions, metadata, output, parallel_tool_calls, temperature, tool_choice, tools, top_p, and usage.
- [ ] Do not emit SDK-only convenience output_text as wire state.
- [ ] Echo effective normalized tools/controls, never raw unsupported caller intent.
- [ ] Pi text, reasoning, verified encrypted continuity, and function/custom/namespace ToolCalls reverse correctly using request-local metadata.
- [ ] Unknown Pi content uses Responses response-local error|ignore default error; arbitrary opaque signatures never masquerade as encrypted Responses data.
- [ ] stop/toolUse→completed; length→incomplete with max_output_tokens details; error→failed when forming a Response; pending/aborted/deferred do not become success.
- [ ] output_tokens_details exists even at zero; cached/reasoning/total usage is complete and consistent.
- [ ] Empty output is represented legally without invented text.
- [ ] Tests cover full object equality, effective-vs-raw echo, every terminal, usage zero/nonzero, tool-family reversal, unknown content, and mutation resistance.
- [ ] No Anthropic renderer or Provider vocabulary is imported.

## Out of scope

SSE event framing and non-streaming error envelopes (18).

