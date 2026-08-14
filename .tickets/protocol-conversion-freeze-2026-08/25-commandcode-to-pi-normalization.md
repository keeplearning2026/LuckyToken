# 25 — Convert CommandCode success into normalized Pi responses

**What to build:** A committed CommandCode result becomes one valid Pi AssistantMessage whose content, response identity, usage, raw reason, and normalized stopReason are internally consistent.

**Blocked by:** 24 — CommandCode JSONL lifecycle.

**Status:** completed

## Module seam

The semantic converter accepts only immutable committed CommandCode results and model/request lifetime facts, returning an immutable Pi AssistantMessage. It does not know HTTP, retries, Client renderers, or mutable assembler state.

## Information lifecycle

CommandCode wire structures cease at this seam. Only Pi content/usage/identity/raw reason/neutral diagnostics survive. Provider-only headers/timestamps/metadata are dropped unless a public Pi field explicitly consumes them.

## Acceptance criteria

- [x] Text maps to Pi TextContent and reasoning maps to Pi ThinkingContent even when model.reasoning=false.
- [x] ToolCall preserves ID/name and lossless object arguments.
- [x] Last finish-step response identity maps to responseId/responseModel; absent identity remains omitted.
- [x] Pi timestamp uses the documented request/response lifetime authority, not ambiguous server metadata.
- [x] Final finish usage maps input/output/cacheRead/cacheWrite/reasoning/total and known aliases with integer/nonnegative/consistency validation. Pi `cacheWrite1h` is set only when the CommandCode wire defines an authoritative one-hour split; the currently evidenced wire has no such field, so it remains omitted rather than guessed from `cacheWriteTokens`.
- [x] Source total/aliases are consumed and cross-checked rather than ignored/recomputed blindly.
- [x] length remains length; otherwise actual ToolCall content determines toolUse/stop.
- [x] Raw finish reason is preserved; content/finish mismatch creates non-model-visible diagnostic.
- [x] pause=stop committed results pass through the same converter and validations.
- [x] Invalid content/usage produces a neutral conversion failure with no partial Pi success events.
- [x] Tests cover all content/usage/identity/terminal combinations and immutable output.
- [x] No Anthropic/Responses types, selectors, or render rules enter the module.

## Out of scope

Event replay and failure transport (26).
