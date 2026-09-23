# Provider Native Responses item-chain ordering: Codex consumer audit

Status: **historical consumer audit** — the production contract is frozen by
[TokenProviderNativeResponsesLifecycleNormalizationPlan.md](../Spec/TokenProviderNativeResponsesLifecycleNormalizationPlan.md).
The follow-up review and certification findings are tracked in
[ProviderNativeResponsesLifecycleNormalizationReview.md](./ProviderNativeResponsesLifecycleNormalizationReview.md).

Date: 2026-09-23. Source: local Codex checkout `D:\project\codex`, commit `30fc6864cc1318121eca1843c217fe00ce1212f1`. Sections 1–5 are source deductions. Sections 6–8 add parser/state findings and an isolated synthetic replay with installed `codex-cli 0.149.0`. No production source or user-owned Codex state was changed.

## Finding

Serializing complete item chains resolves the single-active-item overlap only when each resulting chain has a valid lifecycle. **Unconditionally sorting chains by `output_index` does not preserve current Codex behavior when it changes the order of `response.output_item.done`.** Those events commit history, launch tools, select the last assistant message, and can interrupt the sampling loop. Preserving the final `response.completed.output` alone does not establish preservation of these effects.

## 1. Tools launch at item completion, before response completion

`handle_output_item_done` calls `ToolRouter::build_tool_call`; for a tool it accepts current-turn mailbox delivery, records the completed call, and calls `ToolCallRuntime::handle_tool_call` immediately. Sources: [tool branch](D:/project/codex/codex-rs/core/src/stream_events_utils.rs:309), [record then dispatch](D:/project/codex/codex-rs/core/src/stream_events_utils.rs:333).

The important Rust detail is that `handle_tool_call` and `handle_tool_call_with_source` are ordinary functions returning futures, not `async fn`. The first calls the second before returning its wrapper future; the second executes `tokio::spawn` before returning its wrapper future. Thus putting the returned future into `FuturesOrdered` does **not** defer tool launch until the response stream ends. Sources: [outer function](D:/project/codex/codex-rs/core/src/tools/parallel.rs:75), [inner call](D:/project/codex/codex-rs/core/src/tools/parallel.rs:87), [inner function](D:/project/codex/codex-rs/core/src/tools/parallel.rs:124), [eager spawn](D:/project/codex/codex-rs/core/src/tools/parallel.rs:183).

The spawned task waits for optional tool readiness, then acquires a shared read lock for tools supporting parallel execution or an exclusive write lock otherwise. Stream chain serialization does not itself serialize tool execution: parallel tools can still overlap. Reordering completions changes launch order and may change lock admission and externally visible side effects; launch order alone does not guarantee execution order because readiness and task scheduling also intervene. Sources: [readiness and gate](D:/project/codex/codex-rs/core/src/tools/parallel.rs:183), [dispatch](D:/project/codex/codex-rs/core/src/tools/parallel.rs:202).

The sampling loop appends returned futures in completion-event order, and drains them after leaving the stream loop. `FuturesOrdered` makes result collection follow insertion order, including when later tool execution finishes first. Sources: [queue insertion](D:/project/codex/codex-rs/core/src/session/turn.rs:2701), [ordered drain and result recording](D:/project/codex/codex-rs/core/src/session/turn.rs:2417), [drain after stream](D:/project/codex/codex-rs/core/src/session/turn.rs:3063).

Concrete consequence: if tool item 1 completes before tool item 0 upstream, sorting whole chains by index swaps tool launches, the recorded call order, and collected tool-result order. It can also change noncommutative tool side effects. This is a behavior change even if both calls and arguments are byte-identical.

## 2. History order follows completion-event order

Both tool and non-tool branches record each completed item immediately. `record_completed_response_item_with_finalized_facts` passes a one-item slice to `record_conversation_items`. Session history recording ultimately appends the processed item to its vector, without recovering or sorting by wire `output_index`. Sources: [single-item record](D:/project/codex/codex-rs/core/src/stream_events_utils.rs:101), [non-tool record](D:/project/codex/codex-rs/core/src/stream_events_utils.rs:377), [session history delegation](D:/project/codex/codex-rs/core/src/session/mod.rs:3640), [history append](D:/project/codex/codex-rs/core/src/context_manager/history.rs:453).

Reordering done events therefore changes next-request history even if the final response snapshot is unchanged. In the `Completed` branch, Codex records completion/usage and returns the current sampling result; it does not rebuild history from a final output array. Source: [completion handling](D:/project/codex/codex-rs/core/src/session/turn.rs:2849).

## 3. The final assistant-message value can change

For a completed agent message, Codex concatenates its text and returns it as `last_agent_message` when nonempty. The sampling loop overwrites its current `last_agent_message` each time it receives such a result. Sources: [message extraction](D:/project/codex/codex-rs/core/src/stream_events_utils.rs:265), [last-message overwrite](D:/project/codex/codex-rs/core/src/session/turn.rs:2704), [sampling result](D:/project/codex/codex-rs/core/src/session/turn.rs:2894).

Counterexample:

```text
message 0.added
message 1.added
message 1.done (text = "B")
message 0.done (text = "A")
response.completed (output = [A, B])
```

Upstream completion order selects `A`. Index-sorted chain order selects `B`. Per-item payloads, per-item event order, and final output array can all remain unchanged, so the proposed preservation checklist would miss this difference unless it explicitly inspects Codex's selected final message and history.

## 4. Mailbox interruption can change whether a tool is launched at all

After a reasoning item or assistant commentary message is completed and handled, Codex checks pending mailbox mail and can immediately exit the sampling loop. A tool completion is not itself such an interruption boundary. Sources: [boundary selection](D:/project/codex/codex-rs/core/src/session/turn.rs:2670), [early break](D:/project/codex/codex-rs/core/src/session/turn.rs:2709).

Counterexample, with pending mailbox mail:

```text
reasoning 0.added
tool 1.added
tool 1.done
reasoning 0.done
response.completed
```

Upstream order launches the tool before breaking at reasoning completion. Index sorting places the entire reasoning chain first; Codex can break before reading tool 1, so the tool is never launched in that sampling request. The normalizer cannot decide this from the SSE body because pending mailbox state belongs to the client.

There is also order-dependent mailbox policy: tool completion accepts current-turn delivery; a nonempty non-commentary assistant message completion may defer queue-only mailbox delivery to the next turn. Sources: [tool accept](D:/project/codex/codex-rs/core/src/stream_events_utils.rs:317), [message deferral fact](D:/project/codex/codex-rs/core/src/stream_events_utils.rs:278), [apply deferral](D:/project/codex/codex-rs/core/src/stream_events_utils.rs:107), [deferral conditions](D:/project/codex/codex-rs/core/src/session/input_queue.rs:213), [accept current turn](D:/project/codex/codex-rs/core/src/state/turn.rs:210).

## 5. Safer generic normalization contract

A generic chain algorithm need not become a reasoning/message case table. A stronger eligibility condition is:

1. Establish each complete chain's identity and original internal event order without guessing.
2. Preserve the original relative order of **all** `output_item.done` events.
3. If product output must also be ordered by `output_index`, require original completion order to agree with index order. If they disagree, classify the stream as unsupported for this transformation instead of choosing a new completion order.
4. Keep response-level events at certified boundaries; do not move unknown global events across chain events without understanding their semantics.
5. Require valid complete lifecycles for the chains being serialized. Treat upstream failed/incomplete/aborted responses separately, without inventing completion events.

These rules preserve deterministic done-triggered history ordering, selected last message, launch ordering, and mailbox accept/defer ordering for the same sequence of consumed completions. They do **not** prove full observational equivalence. Moving adds/deltas changes UI progression, time until a given completion, and what has been displayed before an interruption. Cancellation is checked during each stream read, so a concurrently arriving cancellation or mailbox message may cut the stream at a different logical point. Source: [cancellable event read](D:/project/codex/codex-rs/core/src/session/turn.rs:2569).

A complete buffer at Token does not remove those effects: Codex still consumes and reacts to events sequentially and tools run concurrently during replay. The product contract should explicitly permit changed cross-item presentation/interleaving, while preserving the completion order wherever feasible. Upstream Codex work that retains item identities and tracks per-item state would avoid the need to impose this serialization constraint at the proxy.

## 6. What complete chain serialization actually guarantees

The wire parser drops `output_index` and `sequence_number` entirely from `ResponsesStreamEvent`, and strips item identity from text/reasoning delta events. It processes SSE in physical arrival order. Sources: [wire structure](/D:/project/codex/codex-rs/codex-api/src/sse/responses.rs:169), [delta conversion](/D:/project/codex/codex-rs/codex-api/src/sse/responses.rs:365), [event read loop](/D:/project/codex/codex-rs/codex-api/src/sse/responses.rs:585).

For well-formed items that Codex can deserialize and recognize, complete non-overlapping chains are sufficient to avoid the known single-active-item overwrite/foreign-done problem: an item's add establishes its state, its deltas occur while that state is active, and its done clears that state before another chain begins. Item identity, type/role, required event fields and within-chain lifecycle must still be valid; simply grouping malformed data does not supply these guarantees. Sources: [add](/D:/project/codex/codex-rs/core/src/session/turn.rs:2717), [clear](/D:/project/codex/codex-rs/core/src/session/turn.rs:2627), [delta consumers](/D:/project/codex/codex-rs/core/src/session/turn.rs:2899), [role-dependent recognition](/D:/project/codex/codex-rs/core/src/event_mapping.rs:181).

There is a second single-slot state: `active_tool_argument_diff_consumer`. Custom-tool adds replace it; function-tool adds clear it; every output-item done finishes/takes it. The custom-tool delta branch ignores its `item_id` and only checks `call_id` when present. Complete chains also avoid this overlap, strengthening the case for a generic chain algorithm rather than a reasoning/message case patch. Sources: [tool consumer finish](/D:/project/codex/codex-rs/core/src/session/turn.rs:2621), [tool consumer setup](/D:/project/codex/codex-rs/core/src/session/turn.rs:2719), [tool input routing](/D:/project/codex/codex-rs/core/src/session/turn.rs:2931).

Opening events may carry visible content and must remain inside their chains. Codex seeds message text on add. `response.reasoning_text.delta` is consumed; provider-specific `response.reasoning.delta` is not mapped to the raw-reasoning consumer. Sources: [text seed](/D:/project/codex/codex-rs/core/src/session/turn.rs:2746), [raw reasoning parser](/D:/project/codex/codex-rs/codex-api/src/sse/responses.rs:400), [unknown delta fallback](/D:/project/codex/codex-rs/codex-api/src/sse/responses.rs:544).

Global events are not all inert. Before item dispatch, the SSE parser extracts model, verification, moderation and safety-buffering observations from frames; moving such frames also moves these observations. Failures/incomplete responses produce a stored parser error, delivered when the stream ends; a completed event instead ends successful parsing immediately. These events require explicit handling, not arbitrary prefix/suffix relocation. Sources: [global observations](/D:/project/codex/codex-rs/codex-api/src/sse/responses.rs:643), [incomplete/completed](/D:/project/codex/codex-rs/codex-api/src/sse/responses.rs:479), [stored error and completion stop](/D:/project/codex/codex-rs/codex-api/src/sse/responses.rs:692).

`ResponseCompleted` contains id, usage and end-turn fields, but no `output`. Retaining the terminal output array does not cause Codex to reconcile the items it already consumed. Source: [completion structure](/D:/project/codex/codex-rs/codex-api/src/sse/responses.rs:118).

## 7. Real CLI synthetic replay

Command, run from the Token repository:

```powershell
node doc/Research/provider-native-item-chain-replay.mjs
```

[Replay harness](/D:/project/LuckyToken/doc/Research/provider-native-item-chain-replay.mjs) starts a loopback SSE server and feeds synthetic messages to the installed CLI. Each invocation gets a newly created temporary `CODEX_HOME` and temporary working directory. No user config, authentication, catalog or sessions are copied. The local provider uses a dummy key. All temporary directories are removed in `finally` after checking the cleanup path lies under the OS temporary directory. The provider emits no tool calls.

Two messages always have the same identities, indexes and final text: item 0 is `ANSWER_A`, item 1 is `ANSWER_B`. Every variant has the same final `response.completed.output = [A, B]`, and each chain's event payloads/order are unchanged except regenerated sequence numbers.

| Variant | Done order | Completed message order | CLI final output | Missing-active text warnings |
|---|---|---|---|---|
| Overlap with index-ordered done | A, B | A, B | ANSWER_B | 1 |
| Overlap with reverse done | B, A | B, A | ANSWER_A | 1 |
| Complete chains sorted by index | A, B | A, B | ANSWER_B | 0 |
| Complete chains preserving reverse done order | B, A | B, A | ANSWER_A | 0 |

All variants exited 0 with `turn.completed`. This confirms both the positive result (chain serialization removes the warning) and the boundary (changing done order changes the CLI-selected answer). It is a synthetic consumer test, not proof that the captured Goat stream has reverse done order, not a general validation of every fixture against the OpenAI service, and not online provider certification. Tool execution and mailbox effects above remain source-derived rather than exercised by this replay.

If Token deliberately chooses index order over upstream done order, `ANSWER_B` may be the intended canonical result. The experiment does not prove that choice is intrinsically wrong; it disproves claiming that choice always preserves existing Codex behavior. The product must decide the conflict explicitly.

## 8. Recommendation

Use a focused generic item-chain normalizer, without a Codex User-Agent branch or model-name special cases. For the initial preservation-oriented contract:

- Leave already serial streams byte-identical.
- Resolve item identity/index consistently; allow an event's missing index to be resolved through a known item id, but do not invent an index from first appearance when the entire chain lacks one.
- Normalize only complete, unambiguous overlapping chains within boundaries whose global-event ordering is certified.
- Preserve all item-done relative order. If ascending output_index is also required, only normalize when those orders agree. A conflict is unsupported for this preservation contract, not automatically an invalid upstream Responses stream.
- Keep per-item event order and payload bytes, with an explicitly documented exception for sequence-number changes. Do not promise cross-item presentation or interruption-timing equivalence.
- Handle upstream failures/incomplete responses and resumable/background cursor streams separately; never synthesize closing events or silently reinterpret a resume cursor.
- Test history in the next request and tool dispatch/result ordering in addition to final messages, raw content, identity, per-item order and zero warnings.

Preserving done order is a stronger *local* guarantee, not a full proof against all global metadata, async cancellation, extensions or mailbox schedules. If the required contract is instead unconditional ascending-index canonicalization, document it as a deliberate output-order transformation and certify the changed history/tool behavior. Fixing Codex upstream with identity-bearing events and per-item message/tool state is the option that can preserve the original cross-item wire order; merely making `active_item.take()` conditional is insufficient because add already overwrites the prior state.
