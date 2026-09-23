# Provider Native Responses → Codex SSE Compatibility Investigation and Implementation Report

Status: **historical research complete; implementation follows `../Spec/TokenProviderNativeResponsesLifecycleNormalizationPlan.md`**

Scope: LuckyToken `/v1/responses` **Provider Native Preservation** path, with Codex CLI as the downstream client.

This report is intended to be handed directly to a local Codex implementation agent. It records the observed production problem, reproduction evidence, OpenAI Responses semantics review, Codex CLI source audit, root-cause analysis, architectural constraints, proposed repair algorithm, TDD plan, and acceptance criteria.

---

## 1. Executive conclusion

LuckyToken currently forwards CommandCode Goat's native OpenAI Responses SSE to Codex after buffering and response alias projection.

The upstream stream can contain overlapping output-item lifecycles such as:

```text
reasoning output item still active
    ↓
message output_item.added
message content_part.added
    ↓
reasoning.done
reasoning output_item.done
    ↓
message output_text.delta
```

This stream can still produce a correct final response, but **Codex CLI 0.149.0 is not safe against this ordering**.

A deterministic A/B replay using the *same real upstream SSE* proved:

```text
A: original overlapping lifecycle
   OutputTextDelta without active item = 36
   turn.completed = yes
   final text = correct

B: only move message opening events until after reasoning output_item.done
   OutputTextDelta without active item = 0
   turn.completed = yes
   final text = exactly identical
```

The local Codex source explains the behavior exactly:

- Codex core holds only one `active_item: Option<TurnItem>`.
- a streamable `response.output_item.added` assigns that one global active item;
- **every** `response.output_item.done` calls `active_item.take()` without first checking that the done item is the currently active item;
- `response.output_text.delta` is reduced by the SSE parser to `ResponseEvent::OutputTextDelta(String)`, so its original `item_id` is discarded before core processing;
- therefore core cannot recover by item identity and depends on a Codex-safe serial lifecycle.

The recommended product solution is a narrow:

```text
CodexResponsesLifecycleNormalizer
```

inside the Provider Native Responses response-preservation path.

It must **not** become a general Responses semantic converter.

The first implementation should only repair event-order cases that can be proven semantics-preserving:

> Delay the opening events of a later output item when those opening events occur before the previous active item is done, **provided the later item has emitted no real content-bearing delta yet**.

If real content from multiple items is genuinely interleaved, or the stream is malformed/ambiguous, fail closed instead of guessing.

---

## 2. Original symptom

A separate Provider Native problem first appeared as HTTP 502 after upstream success.

The upstream CommandCode response was already HTTP 200 and contained complete usage. Token failed later while preserving/projecting the response.

That 502 root cause was fixed independently: recursive response alias projection had mistaken JSON Schema fields named `model` for response model identity.

After that fix, real Codex CLI requests completed successfully, but Codex stderr exposed another issue:

```text
OutputTextDelta without active item
```

This second issue is not the 502 root cause.

It is a separate downstream SSE lifecycle compatibility problem.

---

## 3. Product impact observed so far

Current evidence does **not** show final-answer corruption or request failure.

In the real Goat Codex online matrix:

```text
22 / 22 scenarios passed
turn.completed succeeded
tool scenarios succeeded
multi-turn succeeded
restart recovery succeeded
```

Nevertheless, many client-side lifecycle errors were emitted.

Observed warning counts from one complete Goat matrix:

```text
chain_long             36
image_input             4
long_text             334
multi_turn_chain t1     8
multi_turn_chain t2     8
multi_turn_chain t3     6
reasoning               4
random_2                5
random_3                5
random_5                5
random_6                5
--------------------------------
total                  420
```

The same Private/Semantic test matrix produced:

```text
0 × OutputTextDelta without active item
```

Therefore this is strongly localized to:

```text
Codex CLI
→ OpenAI Responses
→ commandcode-goat
→ Provider Native
→ native upstream SSE
```

and not to the general Codex client or the Private semantic lane.

---

## 4. Reproduction evidence

### 4.1 Real upstream event ordering

One real Goat `chain_long` response contained:

```text
435 response.reasoning.delta

436 response.output_item.added
    output_index = 1
    item.type = message
    item.id = msg_...

437 response.content_part.added
    output_index = 1
    item_id = msg_...

438 response.reasoning.done
    output_index = 0
    item_id = rs_...

439 response.output_item.done
    output_index = 0
    item.type = reasoning
    item.id = rs_...

440 response.output_text.delta
    output_index = 1
    item_id = msg_...
```

Thus the message lifecycle was opened before the reasoning lifecycle had closed.

### 4.2 Deterministic A/B replay

The real SSE was copied into two local replay variants.

#### A — original crossing order

```text
reasoning.delta
message.output_item.added
message.content_part.added
reasoning.done
reasoning.output_item.done
message.output_text.delta
...
```

Real Codex CLI 0.149.0 result:

```text
exit code                         0
turn.completed                    1
OutputTextDelta without active item 36
final text                        correct
```

### B — serialized opening order

Only the two message opening events were moved:

```text
reasoning.delta
reasoning.done
reasoning.output_item.done
message.output_item.added
message.content_part.added
message.output_text.delta
...
```

Result:

```text
exit code                         0
turn.completed                    1
OutputTextDelta without active item 0
final text                        byte-for-byte same visible text
```

No content delta was reordered.

This establishes direct causality between the lifecycle crossing and the Codex warning.

---

## 5. OpenAI Responses research

Official OpenAI documentation reviewed:

- **Streaming API responses**
  - https://developers.openai.com/api/docs/guides/streaming-responses
- **Reasoning models**
  - https://developers.openai.com/api/docs/guides/reasoning

Important conclusion:

Do **not** assume that every form of item interleaving is necessarily invalid OpenAI Responses semantics.

The Responses API represents output through typed streaming events and reasoning-capable responses may contain richer interleaving than a simple one-item-at-a-time client state machine expects.

Therefore LuckyToken should not claim:

> “CommandCode is invalid because two item lifecycles overlap.”

The correct claim is narrower:

> “The upstream stream is not safe for the current Codex CLI Responses consumer.”

This is why the repair should be explicitly client-compatibility normalization, not general OpenAI Responses canonicalization.

---

## 6. Codex CLI source audit

Local source audited:

```text
D:\project\codex
branch: main
commit: 30fc6864cc
```

Runtime used for live reproduction:

```text
codex-cli 0.149.0
```

No Codex source code was modified.

### 6.1 SSE parser retains item_id initially

File:

```text
codex-rs/codex-api/src/sse/responses.rs
```

`ResponsesStreamEvent` includes fields such as:

```text
kind
item
item_id
call_id
delta
text
summary_index
content_index
```

Therefore wire identity information is available at parse time.

### 6.2 OutputTextDelta discards item identity

For:

```text
response.output_text.delta
```

the parser produces:

```rust
ResponseEvent::OutputTextDelta(delta)
```

The `item_id` and `output_index` are not preserved.

The enum definition is correspondingly:

```rust
OutputTextDelta(String)
```

not an identity-bearing structure.

Therefore once the event reaches Codex core, the core cannot route the delta by wire `item_id`.

### 6.3 Codex core uses one global active item

File:

```text
codex-rs/core/src/session/turn.rs
```

Core state contains:

```rust
let mut active_item: Option<TurnItem> = None;
```

There is no map keyed by item ID or output index.

### 6.4 OutputItemAdded overwrites active_item

For streamable non-tool items, an `OutputItemAdded` eventually performs:

```rust
active_item = Some(turn_item);
```

The relevant item classes produced by `handle_non_tool_response_item()` are:

```text
Message
Reasoning
WebSearchCall
```

Therefore:

```text
reasoning added → active_item = reasoning
message added   → active_item = message
```

### 6.5 OutputItemDone unconditionally clears active_item

The crucial code path is:

```rust
let previously_active_item = active_item.take();
```

This occurs for every `ResponseEvent::OutputItemDone`.

There is no prior check equivalent to:

```text
done.item.id == active_item.id
```

Therefore this ordering:

```text
reasoning active
message added
reasoning done
```

does:

```text
message added     → active_item = message
reasoning done    → active_item.take() → None
```

even though the done item is reasoning, not message.

### 6.6 OutputTextDelta requires active_item

When Codex receives `ResponseEvent::OutputTextDelta(delta)`:

```text
if active_item exists:
    stream delta
else:
    error_or_panic("OutputTextDelta without active item")
```

This exactly explains the live reproduction.

### 6.7 The same architecture affects reasoning warnings

The source contains analogous error paths:

```text
OutputTextDelta without active item
ReasoningSummaryDelta without active item
ReasoningSummaryPartAdded without active item
ReasoningRawContentDelta without active item
```

A Codex compatibility gate should treat all four as forbidden.

### 6.8 content_part events are not the core state authority

The current SSE parser treats these as unhandled/traced events:

```text
response.content_part.added
response.content_part.done
response.output_text.done
response.function_call_arguments.delta
response.function_call_arguments.done
...
```

Thus the primary Codex active-item lifecycle is governed much more strongly by:

```text
response.output_item.added
response.output_item.done
delta events consumed by core
```

### 6.9 Tool input streaming is more identity-aware

`response.custom_tool_call_input.delta` becomes a structured:

```text
ToolCallInputDelta {
    item_id,
    call_id,
    delta
}
```

and uses a dedicated tool argument diff consumer.

Therefore the fragile single-active-item behavior is specifically concentrated in assistant/reasoning-style streaming, not every possible Responses stream event.

### 6.10 No dedicated overlapping-output-item regression was found

A repository search did not find a focused test covering:

```text
reasoning still open
→ message added
→ reasoning done
→ message delta
```

This helps explain why the current Codex state-machine edge case exists.

---

## 7. Exact root cause

The observed real stream:

```text
reasoning is active

message.output_item.added
→ Codex active_item = message

message.content_part.added

reasoning.done

reasoning.output_item.done
→ Codex active_item.take()
→ active_item = None

message.output_text.delta
→ Codex has no active_item
→ OutputTextDelta without active item
```

This is now supported by three independent forms of evidence:

1. real Goat SSE capture;
2. deterministic real-Codex A/B replay;
3. local Codex source code.

The root cause is therefore considered established.

---

## 8. Architectural recommendation

Add a narrow Provider Native response compatibility layer, tentatively:

```text
src/protocols/openai-responses/native-sse-codex-compatibility.ts
```

Suggested conceptual owner:

```text
CodexResponsesLifecycleNormalizer
```

Do **not** implement this as:

```text
GenericOpenAIResponsesRepair
```

because it is not intended to redefine valid OpenAI Responses semantics.

Its contract is:

> Transform a buffered Provider Native OpenAI Responses SSE into a stream that preserves upstream response semantics while satisfying the active-item lifecycle assumptions of the supported Codex client.

---

## 9. Proposed pipeline

Current conceptual path:

```text
CommandCode upstream
    ↓
buffer_provider_native_response
    ↓
observe usage
    ↓
preserve / alias projection
    ↓
Codex
```

Recommended path:

```text
CommandCode upstream
    ↓
buffer raw provider response
    ↓
save raw upstream artifact
    ↓
parse SSE frames
    ↓
Codex lifecycle analyzer
    ↓
safe compatibility normalization
    ↓
Codex lifecycle validator
    ↓
alias projection
    ↓
optional final lifecycle validation
    ↓
save client-facing/repaired artifact
    ↓
Codex
```

The normalizer applies only when all of these are true:

```text
lane = provider_native
protocol = openai-responses
response content type = text/event-stream
downstream compatibility target requires Codex-safe normalization
```

Do not apply this logic to:

- Local Native;
- Semantic Conversion;
- Anthropic Messages;
- non-streaming Responses JSON;
- compact Responses unless separately researched and certified;
- unrelated Providers/endpoints without evidence.

---

## 10. Conservative repair rule — version 1

### 10.1 The only initially certified repair

Suppose output item A is still open.

Then output item B emits only **opening/lifecycle declaration events**, e.g.:

```text
B response.output_item.added
B response.content_part.added
```

before A finishes.

If:

- B has emitted **no real content-bearing delta** before A closes;
- A subsequently closes;
- B then begins its real content deltas;

then delay B's opening events until immediately after A's closing event.

Example:

#### Upstream

```text
A.delta
B.output_item.added
B.content_part.added
A.done
A.output_item.done
B.output_text.delta
```

#### Client-facing

```text
A.delta
A.done
A.output_item.done
B.output_item.added
B.content_part.added
B.output_text.delta
```

This exact class of repair has already been validated with real Codex CLI.

### 10.2 Do not reorder content deltas

Never reorder real model-content events merely to make the stream look serial.

Examples include:

```text
response.output_text.delta
response.reasoning.delta
response.reasoning_summary_text.delta
response.reasoning_summary_part.added if it represents actual reasoning section progression
response.custom_tool_call_input.delta
other future content-bearing deltas
```

If the stream contains true content interleaving such as:

```text
A.delta
B.added
B.delta
A.delta
```

version 1 must treat it as unsupported.

Do not guess a semantic order.

### 10.3 Do not synthesize missing lifecycle events

Never invent:

```text
output_item.added
output_item.done
content_part.added
content_part.done
```

If required events are missing or identities are inconsistent:

```text
fail closed
```

This keeps the normalizer from becoming a semantic converter.

---

## 11. Codex-safe validator

The validator should model the actual current Codex active-item behavior closely enough to guarantee that the repaired stream cannot enter the known warning paths.

Maintain at least:

```text
activeCodexItem:
    id
    output_index
    type

knownItems:
    lifecycle state
    whether real content has started
```

### 11.1 Streamable active-item types

Current Codex source makes these relevant to `active_item`:

```text
message
reasoning
web_search_call
```

### 11.2 Required invariants

At minimum:

1. A Codex-streamable `output_item.added` must not replace another still-active Codex item after normalization.
2. Any delta consumed through the Codex `active_item` path requires an active item.
3. If a delta contains an `item_id` on the wire, it must correspond to the currently expected item.
4. `output_item.done` must not clear a different active item that will subsequently receive active-item deltas.
5. Item IDs and output indexes must remain consistent.
6. `response.completed` must appear only after the response lifecycle is complete enough for Codex consumption.
7. A repaired stream must not require Codex to infer item identity from an ambiguous overlap.

### 11.3 Explicit warning-equivalent checks

The validator should be capable of proving that the outgoing stream cannot trigger the current Codex error branches:

```text
OutputTextDelta without active item
ReasoningSummaryDelta without active item
ReasoningSummaryPartAdded without active item
ReasoningRawContentDelta without active item
```

If it cannot prove this, do not emit the repaired stream.

---

## 12. Handling non-active tool items

Be careful not to overgeneralize.

Function/custom-tool calls often use dedicated state and may not set `active_item` on add.

However **every** `OutputItemDone` in current Codex core calls `active_item.take()`.

Therefore a foreign tool item done while a message/reasoning item is active can theoretically destroy the active item too.

Version 1 recommendation:

- detect this as Codex-unsafe;
- do not automatically invent a repair unless a semantics-preserving reorder is separately proven with fixture + A/B test;
- fail closed for unsupported cases.

Do not silently generalize the reasoning→message repair into arbitrary item sorting.

---

## 13. sequence_number policy

Reordering events can produce an awkward output if original `sequence_number` values are left attached to their old frames.

Example after physical move:

```text
438 A.done
439 A.item.done
436 B.added
437 B.content.added
440 B.delta
```

Real Codex accepted such a replay because current Codex parsing does not rely on this number for the active-item path, but product output should remain internally coherent.

Recommended policy:

- preserve original sequence numbers if no repair occurs;
- if a contiguous repair window is reordered, reassign the sequence numbers in that repaired window monotonically using the same original numeric range;
- do not renumber unrelated frames;
- record the mapping in diagnostics if useful.

Example:

```text
436 A.done
437 A.item.done
438 B.added
439 B.content.added
440 B.delta
```

Before implementing this rule, verify that LuckyToken does not expose a provider-native resume mechanism that relies on upstream sequence numbers.

If such a resume mechanism is introduced later, an explicit upstream-sequence ↔ client-sequence mapping will be required.

---

## 14. Byte-preservation contract

Provider Native must remain preservation-first.

Recommended contract:

### No repair required

```text
SSE bytes unchanged except existing documented alias projection
```

### Certified repair required

Only the minimum necessary frames are moved/sequence-adjusted.

Content payloads and content-bearing deltas must remain unchanged.

### Unsupported ambiguity

```text
fail closed
```

Do not normalize the whole response merely because one local ordering issue exists.

---

## 15. Diagnostics and artifacts

Keep the raw upstream response authoritative for debugging.

Recommended artifacts:

```text
provider_native_upstream_response_wire
provider_native_compatibility_normalized_wire   # only when repaired
provider_native_preserved_response_wire         # final downstream wire
```

Recommended diagnostic classifications:

```text
provider_native_sse_compatibility_repair

provider_native_sse_unsupported_interleaving

provider_native_sse_lifecycle_invalid

provider_native_sse_codex_validation_failed
```

A successful repair should be a warning/informational diagnostic, not a request failure.

Useful structured fields:

```text
providerId
modelId
repairKind = premature_next_item_open
activeItemId
pendingItemId
activeItemType
pendingItemType
movedFrameCount
sequenceRange
```

Never include sensitive content text in diagnostics just to describe the reorder.

---

## 16. Interaction with alias projection

The existing response alias projection bug was separate.

The new compatibility normalizer must remain independent from model identity projection.

Recommended order:

```text
raw buffered SSE
→ compatibility normalization
→ lifecycle validation
→ model alias projection
→ final response
```

Alias projection changes model identity fields, not item lifecycle, so it should not be responsible for event ordering.

Avoid coupling lifecycle repair to public-model alias logic.

---

## 17. TDD implementation plan

### Phase 1 — freeze the bug as a minimal fixture

Create a compact fixture equivalent to the real event window:

```text
reasoning output_item.added
reasoning delta
message output_item.added
message content_part.added
reasoning done
reasoning output_item.done
message output_text.delta
message output_text.done
message output_item.done
response.completed
```

The first red test must demonstrate:

```text
Codex compatibility validator rejects original crossing
```

### Phase 2 — normalizer unit test

Expected repair:

```text
reasoning added
reasoning delta
reasoning done
reasoning item.done
message added
message content_part.added
message text delta
...
```

Assert the entire normalized event sequence, not individual fields only.

### Phase 3 — no-op preservation

For already Codex-safe SSE:

```text
normalized bytes == input bytes
```

This is a key preservation invariant.

### Phase 4 — true content interleaving rejection

Fixture:

```text
A.delta
B.added
B.delta
A.delta
```

Expected:

```text
unsupported_interleaving
```

No attempted repair.

### Phase 5 — malformed identity rejection

Cover:

```text
missing item id where required
mismatched item_id
mismatched output_index
duplicate incompatible add
done for incompatible current active item
missing terminal event needed for certified repair
```

### Phase 6 — HTTP Provider Native contract

Mock a real upstream SSE with overlap.

Assert:

```text
upstream HTTP 200
→ Token HTTP 200
→ repaired SSE
→ alias projection still correct
→ no content mutation
```

### Phase 7 — diagnostics

Assert a successful repair records exactly one compatibility diagnostic.

Assert unsupported interleaving fails with a specific classification, not generic 502 cause.

### Phase 8 — real saved SSE replay

Use the real captured Goat `chain_long` response as a higher-level golden/replay fixture if repository size policy permits.

At minimum maintain the compact fixture plus an external/manual real-artifact replay script/test procedure.

Expected:

```text
before normalization:
36 × OutputTextDelta without active item

after normalization:
0
```

### Phase 9 — Codex online certification

Add a forbidden-client-diagnostics assertion to Goat online tests.

At minimum forbid:

```text
OutputTextDelta without active item
ReasoningSummaryDelta without active item
ReasoningSummaryPartAdded without active item
ReasoningRawContentDelta without active item
```

A scenario is not considered fully certified merely because `turn.completed` occurred.

Required success:

```text
turn.completed
expected final text
expected tools
zero forbidden lifecycle diagnostics
```

Run both Provider matrices:

```text
npm run test:online-codex:private
npm run test:online-codex:goat
```

Private should remain unchanged and zero-warning.

Goat should become zero-warning.

---

## 18. Required regression matrix

At minimum:

| Case | Expected |
|---|---|
| safe message-only stream | byte-preserved |
| safe reasoning→message serial stream | byte-preserved |
| observed reasoning/message premature-open overlap | repaired |
| repaired real chain_long stream | Codex zero warnings |
| true content interleaving | fail closed |
| foreign done that would clear active item | fail closed until separately certified |
| alias + repaired SSE | correct public alias |
| tool-schema property named `model` | unchanged |
| Private Semantic Codex suite | unaffected |
| Goat Provider Native Codex suite | pass with zero lifecycle warnings |

---

## 19. Non-goals

Do not:

- modify CommandCode upstream;
- patch/fork Codex;
- modify Pi;
- turn Provider Native into Pi IR;
- reconstruct the full final Response object;
- merge text deltas;
- reorder real content deltas;
- synthesize missing lifecycle events;
- sort every event by output index;
- create a generic OpenAI Responses semantic converter;
- change Local Native behavior;
- change Anthropic semantic conversion.

---

## 20. Implementation placement recommendation

Keep cohesion with the existing buffered Provider Native response code.

Suggested files:

```text
src/protocols/openai-responses/
    native-response.ts
    native-sse-codex-compatibility.ts   # new focused module
```

Possible API shape:

```ts
type CodexCompatibilityResult =
  | {
      readonly kind: "unchanged";
      readonly body: Uint8Array;
    }
  | {
      readonly kind: "repaired";
      readonly body: Uint8Array;
      readonly repairs: readonly CodexSseRepair[];
    }
  | {
      readonly kind: "unsupported";
      readonly reason: CodexSseCompatibilityFailure;
    };

normalizeNativeResponsesSseForCodex(
  body: Uint8Array,
): CodexCompatibilityResult;
```

Keep parsing/state-machine logic internal to the module.

Do not expose a broad reusable abstraction unless a second real consumer requires it.

---

## 21. Acceptance criteria

Implementation is complete only when all are true.

### Functional

- the captured premature-open pattern is detected;
- only safe opening events are moved;
- no content-bearing delta is changed/reordered;
- already-safe SSE remains byte-preserved;
- unsupported genuine content interleaving fails closed;
- alias projection remains correct.

### Codex compatibility

Real Codex CLI Goat tests must contain **zero** occurrences of:

```text
OutputTextDelta without active item
ReasoningSummaryDelta without active item
ReasoningSummaryPartAdded without active item
ReasoningRawContentDelta without active item
```

### Online

```text
Private Codex matrix: PASS, zero forbidden lifecycle warnings
Goat Codex matrix:    PASS, zero forbidden lifecycle warnings
```

### Repository gates

```text
typecheck PASS
lint PASS
git diff --check PASS
targeted Provider Native tests PASS
full npm test PASS
```

### Review

Run code review after implementation.

Reject any implementation that:

- broadens into semantic conversion;
- reorders content without a proof/fixture;
- silently repairs malformed streams;
- couples the normalizer to CommandCode-specific model IDs instead of the certified Provider Native/Codex response boundary.

---

## 22. Recommended implementation sequence for the local Codex agent

1. Read this report.
2. Read:
   - `src/protocols/openai-responses/native-response.ts`
   - Provider Native branch in `src/protocols/openai-responses/handler.ts`
   - current Provider Native projection/contract tests.
3. Reproduce the existing minimal overlap with a red test.
4. Implement a new focused compatibility module.
5. Make the minimal crossing test green.
6. Add no-op byte preservation.
7. Add unsafe true-interleaving rejection.
8. Integrate into Provider Native buffered SSE path.
9. Add diagnostics/artifact handling.
10. Update Codex online runner to reject the four known lifecycle diagnostics.
11. Run targeted tests.
12. Run real Private Codex online suite.
13. Run real Goat Codex online suite.
14. Verify Goat warnings go from non-zero to zero.
15. Run typecheck/lint/diff.
16. Run full `npm test`.
17. Perform code review.
18. Do not commit/push unless explicitly instructed.

---

## 23. Final architecture statement

The design principle should be frozen as:

> Provider Native remains preservation-first. For a buffered OpenAI Responses SSE sent to Codex, LuckyToken may perform a narrow, deterministic, diagnosable lifecycle normalization only when it can prove that the transformation preserves content semantics and removes a known Codex active-item incompatibility. Real content deltas are never guessed or reordered. Ambiguous interleaving fails closed.

This protects product compatibility without turning Provider Native into another semantic-conversion lane.
