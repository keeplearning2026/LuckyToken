# Token Responses Remote Compaction Handling

Status: **CURRENT — Codex remote compaction v2 over the Responses client protocol**

## 1. Scope

Codex clients that treat their active provider as OpenAI send **remote
compaction v2** turns. Token serves those turns for every model it proxies,
including providers that never implemented the backend compaction semantic.

This document describes:

- the client wire contract Token must satisfy;
- how the two serving lanes handle a compaction turn;
- the shared wire-level compaction helper;
- replay, failure, and certification rules;
- the tests that certify the behavior.

It does not describe local (client-side) compaction, which Codex performs by
itself when its provider is not OpenAI-shaped, nor the legacy
`POST /v1/responses/compact` surface, which is unchanged.

## 2. Client contract (codex-rs)

The current reference client uses one endpoint for everything:

```text
POST {base_url}/responses
```

A compaction turn is the same request with the trigger appended last:

```text
input: [ ...complete history..., {"type": "compaction_trigger"} ]
```

Reference evidence (paths relative to `reference/codex/codex-rs`):

- the trigger is pushed last onto the prompt input
  (`codex-rs/core/src/compact_remote_v2_attempt.rs`);
- the request still carries the full history, the full tool surface,
  `parallel_tool_calls: true`, and the client base instructions
  (`compact_remote_v2_attempt.rs`, `core/src/client.rs`);
- the HTTP request has no `previous_response_id`; the client always sends the
  complete input (`codex-api/src/common.rs`);
- the response must deliver **exactly one** `response.output_item.done` item
  of type `compaction` plus a `response.completed` event; zero or multiple
  items are a fatal client error (`core/src/compact_remote_v2.rs`,
  `collect_compaction_output`);
- the item schema is
  `{"type":"compaction","id":"cmp_…","encrypted_content":"<string>"}`;
  `id` is optional, `encrypted_content` is a required string, and
  `compaction_summary` is an accepted alias
  (`protocol/src/models.rs`);
- after a successful compaction the client keeps its recent user messages and
  appends the returned compaction item as the new history
  (`core/src/compact_remote_v2.rs`, `build_v2_compacted_history`); later turns
  replay that item verbatim in `input`.

The client decides *when* to compact (manual `/compact`, context limit,
overflow, model downshift, compaction-hash change) and *what to retain*. It
never inspects `encrypted_content`.

## 3. Lane selection

Lane selection is per request and per operation, never per session:

```text
POST /v1/responses
  ├─ Direct Mode claims the selector            → preserved direct transport
  ├─ Provider Native claims the model           → provider-native transport
  └─ otherwise                                  → Semantic Conversion
```

`Provider Native` claims are certified per `(provider, api, operation)`. The
operation namespace has a claim-only value for compaction:

```text
operations: ["responses", "responses-compaction", "compact"]
```

- `responses-compaction` means: this exact upstream answers a
  `compaction_trigger` turn with its own single compaction item.
- The claim is consulted **inside** the Provider Native lane, not to switch
  lanes. A model stays on its lane for every turn.
- Currently certified to compact: `openai`, `openai-codex`,
  `azure-openai-responses`. Every other certified Responses upstream
  (for example `commandcode-goat`) is not.

## 4. Handling matrix

| Serving lane | Upstream certified `responses-compaction`? | Compaction turn |
| --- | --- | --- |
| Direct Mode | n/a | Request and response bodies are passed through unchanged; this certifies Token's preservation boundary, not the upstream's compaction support. |
| Provider Native | yes | Forwarded unchanged; the upstream mints its own opaque compaction item. |
| Provider Native | no | Stays on the native lane: request is rewritten with the shared helper, sent over the same native transport/auth/retry, the summary is read from the upstream Responses stream, and Token synthesizes the single client-facing compaction item. |
| Semantic Conversion | n/a | Request is rewritten with the same shared helper, executed through Pi, and the Pi `AssistantMessage` text is projected into the same single compaction item. |

## 5. Shared helper

One module owns every wire-level compaction behavior so both lanes share a
single implementation:

`src/responses-compaction.ts`

The shared helper depends on no lane execution or response-conversion owner.
Atomic SSE framing is the wire-only leaf `src/responses-sse.ts`; each lane
supplies already-rendered facts. Certification checks these dependency
closures and forbids Direct Mode from reaching either shared helper.

| Export | Responsibility |
| --- | --- |
| `isCodexRoutedCompactionRequest` | Detect the trigger as the last input item. |
| `buildCodexRoutedCompactionRequest` | Rewrite the compaction turn into a summarizer turn. |
| `expandTokenCompactionEnvelopes` | Decode replayed `Token1:` items into model-visible summary text. |
| `extractResponsesOutputText` | Read assistant text from a completed Responses JSON or SSE result (native path). |
| `renderRoutedCompactionClientResponse` | Build the complete client response (SSE or JSON) with exactly one compaction item. |
| `projectRoutedCompactionResponse` | Replace an ordinary rendered response with the single compaction item (semantic path). |
| `ROUTED_COMPACTION_SYSTEM_PROMPT`, `ROUTED_COMPACTION_PROMPT` | Summarizer prompt contract, ported from the pi-agent harness. |

### 5.1 Envelope

Routed models cannot mint OpenAI's opaque blob, so Token wraps the summary
text:

```text
encrypted_content = "Token1:" + base64(utf8(summary))
```

Codex stores and replays the string verbatim; only the minting proxy can read
it. On replay Token renders it as a user message:

```text
The conversation history before this point was compacted into the following summary:

<summary>
…summary…
</summary>
```

Foreign encrypted blobs (real OpenAI ciphertext) are never decoded,
reinterpreted, or fabricated; conversion fails instead.

### 5.2 Prompt contract

The summarizer prompt is ported from the pi-agent harness
(`reference/pi-agent`, `packages/agent/src/harness/compaction/compaction.ts`):

- a system role that forbids continuing the conversation;
- an exact structured format: Goal / Constraints & Preferences / Progress /
  Key Decisions / Next Steps / Critical Context, preserving file paths,
  function names, and error messages.

Token keeps the Responses history structured (the model sees the real message,
tool-call, and result items); it does not re-serialize the conversation the
way pi-agent does. Only the prompt contract is shared.

## 6. Request rewrite

`buildCodexRoutedCompactionRequest`:

1. removes the `compaction_trigger` and any `additional_tools` input items;
2. canonicalizes declared namespaced history calls, then removes `tools`,
   `tool_choice`, `parallel_tool_calls`, and `text`;
3. replaces `instructions` with the summarizer system prompt;
4. appends one user message carrying the structured handoff prompt;
5. keeps everything else (model, reasoning, service tier, cache key, stream).

Reasons:

- a summarizer must not be offered a tool surface (it must answer in prose);
- Codex sends its own base instructions, which are wrong for summarization;
- removing the tool surface also mirrors the opencodex routed-compaction
  rewrite, so third-party models see one familiar shape.

Exception — namespaced history identity:

A Responses namespace declaration certifies a namespaced history call's
canonical `<namespace>__<child>` replay identity. Without a matching
declaration, the Responses converter leaves the call namespaced and fails
closed with `Namespaced tool-call history requires a matching namespace tool
declaration`. For the summarizer turn only, the rewrite changes each declared
`function_call` / `custom_tool_call` into the same canonical flattened name
used by Responses conversion and removes its `namespace` property. It reads
declarations from both the top-level `tools` array and `additional_tools`.
Distinct namespace-child pairs that would flatten to the same name are
rejected, because the summary context could not distinguish them. A plain call
whose name already equals a flattened namespace name follows ordinary Responses
conversion semantics and is not treated as a namespace-pair collision. The call
ID, arguments, result items, and transcript order stay unchanged.

This is safe for this one turn because the summary model only reads historical
calls; it cannot execute them, and the compaction response discards the
summarizer's ordinary output. The flattened name is the Pi history identity
that normal Responses conversion already produces. The rewrite then removes
all callable tool declarations. This exception does not apply to ordinary
Responses requests or either preservation lane's general request handling.
An unmatched namespaced call remains unchanged: Semantic Conversion rejects it
with the same missing-declaration error it would produce without compaction
rewriting.

The rewrite happens at the Responses client-protocol layer in both lanes; it
is never expressed as a provider payload edit.

## 7. Response synthesis

Both lanes produce the same client-visible response:

```text
response.created
response.output_item.done   {"type":"compaction","id":"cmp_<uuid>","encrypted_content":"Token1:…"}
response.completed          output contains exactly that item
[DONE]
```

Rules:

- exactly one compaction item, always with a non-empty envelope;
- the assistant text is never additionally emitted as a message item;
- an empty or cleanly-truncated summary fails with 502 before anything is
  installed (no `(no summary available)` placeholder);
- usage from the summarizer turn is preserved when available.

## 8. Replay

Every later request that carries a `Token1:` item is decoded before conversion
or forwarding:

- Semantic Conversion decodes inside its execution coordinator;
- Provider Native decodes before handing the body to its transport
  (`planProviderNativeOutboundBody`).

This is required because the client replays `encrypted_content` verbatim; a
third-party model would otherwise receive unreadable base64 instead of the
summary text. The same rule applies to the compaction turn itself, so a new
summary can incorporate the previous one.

## 9. Failure handling

| Failure | Behavior |
| --- | --- |
| Summarizer produced no text | 502 `api_error`; no item is installed. |
| Summarizer stopped truncated | 502 `api_error`; no item is installed. |
| Native summarizer SSE contains malformed event data | 502 `api_error`; partial text is not installed. |
| Native upstream HTTP error / transport failure | Existing Provider Native recovery and error rendering apply. |
| Foreign encrypted compaction in `input` | Conversion fails; Token never fabricates bytes. |
| Envelope malformed or empty | Treated as foreign; conversion fails. |

## 10. Certification matrix and tests

“Complete coverage” here means the remote-compaction-v2 request on
`POST /v1/responses`. Direct Mode coverage proves request/response body
pass-through; it does not certify that its upstream supports this operation.
Tests cover each observable Token boundary below, not just the happy path:

| Dimension | Cases | Required observable |
| --- | --- | --- |
| Lane and capability | Direct Mode; Provider Native with and without `responses-compaction`; Semantic Conversion | Direct Mode passes request/response bodies through; certified native request is forwarded unchanged; unsupported native stays native; semantic stays semantic; only unsupported backends use the shared summarizer rewrite. |
| Request rewrite | top-level and `additional_tools`; simple and namespaced calls; function and custom calls; unrelated tools; input-order variations | Trigger removed; namespaced calls use the canonical flat identity; call IDs, arguments, outputs, and order survive; no callable tool surface reaches the summarizer. |
| Invalid relationships | missing namespace declaration; missing child; distinct referenced namespace-child pairs flatten to the same name; tool-call/output ID mismatch | Token must not invent a relationship or lose a failure already produced by ordinary conversion. |
| Upstream result | completed SSE with deltas; completed SSE item fallback; completed JSON; empty text; missing terminal; incomplete/failed terminal; malformed SSE; non-2xx and transport failure | Only a non-empty completed summary becomes a client response; failed or partial summaries install no history and return the lane's error. |
| Client response | streaming and non-streaming request | SSE/JSON is valid for the requested mode and contains exactly one `compaction` item, with a non-empty `Token1:` envelope and matching completed output. |
| Replay | valid envelope; empty payload; invalid base64; invalid UTF-8; foreign ciphertext | Only a valid Token envelope becomes model-visible summary text; foreign values are not fabricated or decoded. |
| Semantic execution | stop, tool-call, length, error, empty text, text plus non-text content | Only a clean stop with usable text is committed as compaction; unsuccessful or truncated execution returns an error before the client installs replacement history. |

Exercise these cases at three levels where applicable: helper unit tests
prove the rewrite and parser, lane unit tests prove transport routing and
response synthesis, and online certification proves both CommandCode provider
paths against their actual wire behavior. A test at one level does not replace
the others.

Unit coverage:

- `test/unit/provider-native-compaction.test.ts` — native in-lane summarize,
  namespaced history canonicalization, certified upstream forwarding, replay
  decode, malformed SSE rejection, and Responses JSON/SSE completion handling;
- `test/unit/openai-responses-routed-compaction.test.ts` — semantic rewrite,
  namespaced function/custom-call history, missing declarations, single-item
  response, ordinary-conversion parity for flat-name overlap, and replay decode;
- `test/integration/codex-direct-responses.test.ts` — direct compaction-trigger
  request and upstream response pass through unchanged;
- `test/unit/provider-native-responses-projection.test.ts` — alias projection
  preserves the `data: [DONE]` compatibility terminator;
- `test/unit/responses-native-provider-sender.test.ts` — certification table
  independence (`responses` vs `responses-compaction` vs `compact`).

Online certification:

- `test/online/run-responses-compaction.ts` drives a real Token composition
  against the CommandCode API with `deepseek/deepseek-v4.1-flash`:
  - `commandcode-goat` (Provider Native, not certified) must summarize in-lane;
  - `commandcode-private` (Semantic Conversion) must summarize through Pi;
  - namespaced history identities must survive while tool declarations are
    absent from both summarizer requests;
  - both must return exactly one `Token1:` item, must not forward the trigger
    or the tool surface, and must decode the envelope on the replay turn.

Run:

```powershell
node scripts/run-with-codex-test-sandbox.mjs -- tsx test/online/run-responses-compaction.ts
```

## 11. Known limits

- Only the canonical blob-minting backends (`openai`, `openai-codex`,
  `azure-openai-responses`) are certified to compact natively. Adding another
  upstream requires online evidence and a reviewed certification change.
- Codex itself decides remote vs local compaction from the provider identity
  (`is_openai()`, Azure base URLs, Amazon Bedrock). Pointing the built-in
  `openai` provider at Token forces the remote path for every routed model.
- A build/reinstall of Token is required before these paths take effect in an
  installed product.
