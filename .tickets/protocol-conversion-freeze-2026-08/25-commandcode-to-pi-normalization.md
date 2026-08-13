# 25 — Convert CommandCode success into normalized Pi responses

**What to build:** A committed CommandCode result becomes one valid Pi AssistantMessage whose content, response identity, usage, raw reason, and normalized stopReason are internally consistent.

**Blocked by:** 24 — CommandCode JSONL lifecycle.

**Status:** ready-for-agent

## Module seam

The semantic converter accepts only immutable committed CommandCode results and model/request lifetime facts, returning an immutable Pi AssistantMessage. It does not know HTTP, retries, Client renderers, or mutable assembler state.

## Information lifecycle

CommandCode wire structures cease at this seam. Only Pi content/usage/identity/raw reason/neutral diagnostics survive. Provider-only headers/timestamps/metadata are dropped unless a public Pi field explicitly consumes them.

## Acceptance criteria

- [ ] Text maps to Pi TextContent and reasoning maps to Pi ThinkingContent even when model.reasoning=false.
- [ ] ToolCall preserves ID/name and lossless object arguments.
- [ ] Last finish-step response identity maps to responseId/responseModel; absent identity remains omitted.
- [ ] Pi timestamp uses the documented request/response lifetime authority, not ambiguous server metadata.
- [ ] Final finish usage maps input/output/cacheRead/cacheWrite/cacheWrite1h/reasoning/total and known aliases with integer/nonnegative/consistency validation.
- [ ] Source total/aliases are consumed and cross-checked rather than ignored/recomputed blindly.
- [ ] length remains length; otherwise actual ToolCall content determines toolUse/stop.
- [ ] Raw finish reason is preserved; content/finish mismatch creates non-model-visible diagnostic.
- [ ] pause=stop committed results pass through the same converter and validations.
- [ ] Invalid content/usage produces a neutral conversion failure with no partial Pi success events.
- [ ] Tests cover all content/usage/identity/terminal combinations and immutable output.
- [ ] No Anthropic/Responses types, selectors, or render rules enter the module.

## Out of scope

Event replay and failure transport (26).

