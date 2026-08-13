# 24 — Rebuild CommandCode JSONL event, identity, pause, and abort lifecycle

**What to build:** A CommandCode HTTP-200 JSONL stream is reconstructed atomically with complete known-event handling, final response identity, configurable pause semantics, and a correct distinction between upstream abort and caller cancellation.

**Blocked by:** 01 — configuration; 02 — notices/journal; 03 — neutral failure contract.

**Status:** ready-for-agent

## Module seam

Deepen the assembler behind one consume/finalize interface. It owns JSONL event validation, staged slots, terminal state, identity, raw usage, and rollback. Callers see only immutable committed success or a neutral typed failure.

## Information lifecycle

Text/reasoning/tool slots and previews are attempt-local. Tool preview never becomes final arguments. Finish-step identity is staged until final commit. Rollback clears every staged semantic/usage/identity fact. Unknown-event notices remain non-model-visible.

## Acceptance criteria

- [ ] Complete known event matrix is implemented/tested: text/reasoning start-delta-end, tool-input lifecycle, authoritative tool-call, finish-step, finish, error, abort, start/start-step/provider-metadata/tool-result.
- [ ] Partial/overlapping/duplicate block lifecycle and malformed known events fail; partial tool arguments never commit.
- [ ] Last valid finish-step response id/modelId is staged for Pi identity; final finish usage remains authoritative.
- [ ] Physical EOF succeeds only after valid finish and all modeled slots close.
- [ ] Unknown event uses CommandCode-local error|ignore default error; ignore records notice/diagnostic but cannot replace finish.
- [ ] pause_turn occurs only after closed slots/final finish and applies Provider-local stop|error default stop.
- [ ] pause=stop retains content/identity/usage/raw reason and runs normal semantic validation; pause=error rolls back and yields neutral nonretryable failure.
- [ ] Wire abort produces neutral upstream-provider abort failure, never Pi caller-aborted solely by name.
- [ ] Caller signal cancellation discards incomplete state and remains structurally distinct.
- [ ] Tests cover every event, multi-step identity, pause both policies with text/tool calls, abort/cancel distinction, EOF, rollback completeness, and concurrency.
- [ ] No Client Protocol concept appears in assembler interfaces/tests.

## Out of scope

Pi content/usage/terminal projection after commit (25).

