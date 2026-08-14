# 22 — Convert CommandCode tools and degrade constrained sampling

**What to build:** Pi tools reach CommandCode with lossless schema/name/description while every unsupported constrained-sampling control degrades to an ordinary tool instead of rejecting the conversation.

**Blocked by:** 02 — notices/journal; 20 — scalar options/synchronous execution.

**Status:** completed

## Module seam

Tool conversion is private to the CommandCode Provider request module. It accepts Pi Tool values and returns target tools; callers do not perform capability checks or prompt repairs.

## Information lifecycle

Pi schema is losslessly cloned into the target and source objects are discarded. Constraint metadata is consumed/dropped. Only `strict=require` produces a Provider-local non-model-visible degradation notice.

## Acceptance criteria

- [x] Tool name, description, order, and lossless JSON schema map exactly; target-required defaults are deterministic.
- [x] absent/false/prefer/require JSON-schema constraints and grammar constraints all produce an ordinary CommandCode tool because the target has no field.
- [x] `constrainedSampling` with `strict="require"` no longer throws; it converts to the ordinary target tool and emits a CommandCode-local degradation notice.
- [x] Grammar/prefer drops are documented and do not create model-visible text; per-request notice is emitted only if the frozen Provider policy requires it.
- [x] No constraint instruction is injected into systemPrompt, messages, description, or schema.
- [x] Invalid/non-lossless schema still errors as malformed Pi/target construction, not as unsupported strict mode.
- [x] Empty/duplicate/invalid target names follow the CommandCode target contract.
- [x] Tests cover every constrainedSampling variant, immutable schema copy, ordering, invalid JSON, notice safety, and successful downstream request construction.
- [x] No Client Protocol tool_choice, format, or policy is consulted.

## Out of scope

Client-side constrainedSampling construction and final payload authority (23).
