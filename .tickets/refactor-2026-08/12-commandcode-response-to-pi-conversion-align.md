# 12 — Align CommandCode → Pi response conversion with the conversion method

**What to build:** A committed CommandCode response is converted into a
single Pi `AssistantMessage` — top-level fields, content, usage, stopReason
— following `PI AI IR-Commandcode Private Conversion.md` Part II §3–§6, then
replayed through Pi's `createAssistantMessageEventStream()` so the Pi
runtime sees a valid lifecycle.

**Blocked by:** 11 — CommandCode response reconstruction.

**Status:** ready-for-agent

- [ ] Top-level fields (§3): `role:"assistant"`; `api/provider/model` from
  the invoked Pi `Model` (`model.api`, `model.provider`, `model.id`),
  resolved once per logical response lifetime, never re-derived from
  response metadata; `responseModel/responseId/deferred/endTurn` omitted;
  `timestamp` from the bound local clock resolved once.
- [ ] Content (§4): preserve committed content order; `Text.text →
  TextContent.text`; `Reasoning.text → ThinkingContent.thinking` without
  consulting `model.reasoning`; `ToolUse.id/toolName/input →
  ToolCall.id/name/arguments` where `input` must be a top-level object
  (else conversion error); optional Pi fields
  (`textSignature/thinkingSignature/redacted/thoughtSignature/namespace`)
  omitted; no tool-registry/schema/deep-clone validation.
- [ ] Usage (§5): build `cacheRead/cacheWrite` from
  `inputTokenDetails.cacheReadTokens/cacheWriteTokens` (absent → 0);
  `input` from `noCacheTokens` when present, else
  `inputTokens ?? 0 − cacheRead − cacheWrite` (non-negative or error); no
  `cachedInputTokens` alias; `output` from `outputTokens` (absent → 0), never
  reconstructed from text+reasoning; `reasoning` from
  `outputTokenDetails.reasoningTokens` when present (no alias, no precedence
  checks); `cacheWrite1h` omitted; `totalTokens =
  input+cacheRead+cacheWrite+output`; `cost` via Pi `calculateCost(model,
  usage)` (no reimplementation); no RawUsage/NormalizedUsage.
- [ ] stopReason (§6): `finishReason "tool-calls"→"toolUse"`,
  `"length"→"length"`, any other/missing → `"stop"`; no whitelist, no error
  for unknown/missing; `rawStopReason` omitted (not read to construct other
  fields); refusal/context-window/pause handled before this stage.
- [ ] Event emission (§7): after the complete AssistantMessage is built,
  replay `start → content events (text_start/delta/end,
  thinking_start/delta/end, toolcall_start/end) → done{reason, message}` via
  Pi's `createAssistantMessageEventStream()`; no synthetic toolcall_delta;
  original CommandCode deltas do not participate in replay.
- [ ] Failure construction keeps `stopReason:"error"|"aborted"` with
  `errorMessage`, and never fabricates a successful terminal.
- [ ] Unit tests cover each field construction, usage fallback/error
  branches, stopReason branches, and replay event sequences.

**Out of scope:** reconstruction (11), HTTP attempts (13).
