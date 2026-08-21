# Anthropic Messages ↔ Pi AI IR Conversion Method

# Part I — Anthropic Request → Pi AI IR Conversion Method

Governing revision marker retained for serving certification. This frozen document now contains both request and response directions; the marker identifies the historical Part I/II/III authority without restoring superseded text.

Status: **Frozen normative design**

Applies to: Anthropic Messages conversion profile only.
Does not apply to: native Anthropic passthrough, which is a separate non-conversion profile defined in `Protocol Conversion Architecture and Policy.md`.

## 1. Boundary and ownership

```text
Anthropic Messages wire
  ↕ this adapter
Pi Context / SimpleStreamOptions / AssistantMessage
```

This adapter MUST NOT inspect or name CommandCode, a concrete Provider, or Provider configuration. Model selection returns an opaque Pi model and selector. Provider-side capability decisions happen after Pi.

The implementation returns three request-local products:

```ts
interface AnthropicRequestConversion {
  selector: string;
  context: Context;
  options: Partial<SimpleStreamOptions>;
  renderState: {
    selector: string;
    stream: boolean;
  };
  notices: readonly ConversionNotice[];
}
```

Notices are non-model-visible and never enter `Context.messages`.

## 2. Configuration

Suggested immutable configuration:

```json
{
  "clientProtocols": {
    "anthropic-messages": {
      "conversion": {
        "request": {
          "unknownContent": "error",
          "unresolvedToolCall": "xrepair",
          "localCacheControl": "ignore"
        },
        "response": {
          "unknownPiContent": "error"
        }
      }
    }
  }
}
```

Allowed values:

- `unknownContent`: `error | ignore`, default `error`.
- `unresolvedToolCall`: `error | xrepair`, default `xrepair`.
- `localCacheControl`: `ignore | promote`, default `ignore`.
- `unknownPiContent`: `error | ignore`, default `error`.

Protocol invariants such as duplicate ToolResult rejection, required IDs, redacted mapping, SSE order, and malformed JSON handling are not configurable.

## 3. Request envelope

| Anthropic source | Pi target | Frozen action |
|---|---|---|
| `model` | model selector | Required non-empty selector; resolve through the full Models catalog. Preserve the selector opaquely for response echo. |
| `messages` | `Context.messages` | Convert in source order using §5. |
| `system` string | `Context.systemPrompt` | Exact string. |
| `system` TextBlock[] | `Context.systemPrompt` | Concatenate block text in order with `\n` between blocks. Citations and local cache breakpoint metadata do not enter the string. |
| `max_tokens` | `options.maxTokens` | Positive integer. Reject zero/negative at Client conversion as invalid request, not later as 500. |
| `temperature` | `options.temperature` | Finite numeric value accepted by the target contract. |
| `top_p` | `options.samplingParams.top_p` | Convert; Pi explicitly supports it. |
| `top_k` | `options.samplingParams.top_k` | Convert; Pi explicitly supports it. |
| `metadata.user_id` | `options.metadata.user_id` | String maps exactly. `null`/absence means omission. |
| `thinking` | `options.reasoning` + `thinkingBudgets` | Use §4. |
| `output_config.effort` | `options.reasoning` | Use §4. |
| `output_config.format` | none | Drop and document. Do not borrow Tool.constrainedSampling. |
| `cache_control` | `options.cacheRetention` | Use §8. |
| `stop_sequences` | none | Drop; no generic Pi option. |
| `tool_choice` | none | Drop. It MUST NOT cause tools or messages to be fabricated. |
| `container`, `inference_geo`, `service_tier` | none | Drop. `null` is treated as absence. |
| `stream` | render state | `true` selects atomic Anthropic SSE; otherwise JSON. |
| unknown property on known request | none | Ignore unless it violates a security/authority closed-world boundary. |

Source absence never creates a synthetic option. Pi/Provider defaults apply.

## 4. Thinking and effort

### 4.1 Source precedence

1. If `output_config.effort` is present and non-null, it determines `options.reasoning`.
2. Otherwise `thinking.type="enabled"` selects a level from `budget_tokens` using the adapter's documented deterministic budget ladder.
3. `thinking.type="adaptive"` without effort requests no independent Pi field; drop the adaptive marker.
4. `thinking.type="disabled"` cannot be distinguished from omission by the current Pi request type. Convert to reasoning omission and record this as a documented degradation, not as a proven explicit off.
5. `display` has no generic Pi control and is dropped.

### 4.2 Effort mapping

| Source effort | Pi reasoning |
|---|---|
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |
| `null` / absent | omitted |

Unknown future effort follows an Anthropic-adapter-local future-enum policy if one is later added. No other Client Protocol's enum policy is imported or consulted.

### 4.3 Exact budget preservation

`thinking.enabled.budget_tokens` is validated against the source contract and preserved in `options.thinkingBudgets`.

Pi budget keys are only `minimal`, `low`, `medium`, and `high`. The exact source budget is placed in the key used by budget-based Pi adapters after normalization:

- reasoning minimal/low/medium/high → same key;
- reasoning xhigh/max → `thinkingBudgets.high`, because Pi budget-based adapters clamp those levels to high;
- if effort chose the level, the source budget applies to that normalized level;
- if no effort exists, the deterministic budget ladder chooses the level, and the exact budget is written to that key.

This preserves the numeric budget without claiming that adaptive Providers will consume it; a Provider may use its native effort field instead.

## 5. Messages and content order

### 5.1 General algorithm

Process source messages and content blocks strictly in order. A single Anthropic message may produce multiple Pi messages because ToolResult is a standalone Pi message.

For example:

```text
Anthropic user [text A, tool_result X, text B]
→ Pi UserMessage(text A)
→ Pi ToolResultMessage(X)
→ Pi UserMessage(text B)
```

Empty ordinary fragments are not emitted. Adjacent Pi messages of the same role MAY be merged only when merging cannot cross a ToolCall/ToolResult boundary or change source order.

### 5.2 Non-standard message `role="system"`

Although the installed Anthropic SDK places system content at the top level, LuckyToken supports a compatibility extension in `messages[]`:

1. Find message-level `role="system"` entries in source order.
2. Append only the first one's text to `Context.systemPrompt`, separated from the existing top-level system string by `\n`.
3. Convert every later message-level system entry as a Pi user message.
4. Non-text content in a message-level system entry follows its normal content mapping but is not granted system privilege.

This is a deliberate availability-oriented semantic degradation.

### 5.3 User content

| Anthropic block | Pi content/message | Action |
|---|---|---|
| string / `text` | TextContent | Preserve text exactly. Drop citations/cache marker metadata with no target slot. |
| base64 `image` | ImageContent | Decode bytes and preserve MIME. Invalid base64 is invalid request; unsupported MIME/capability is a conversion failure only when Pi/selected route cannot accept the image. |
| `tool_result` | ToolResultMessage | Use §6. |
| `document` with directly readable text | TextContent | Preserve text in source order; drop source/citation presentation metadata. Resolver-dependent PDF/URL/file sources follow the adapter's trusted resolver boundary. |
| `search_result` | deterministic text/content | Preserve representable result text and ordering; do not invent a client ToolCall. |
| server-tool result families | content/transcript | Apply execution ownership in §7. |
| `redacted_thinking` in user role | invalid/known unsupported | It is not ordinary user content; apply the known-family rule, not unknown ignore. |
| future discriminator | policy | `unknownContent`, default error. Ignore emits notice. |

### 5.4 Assistant content

| Anthropic block | Pi content | Action |
|---|---|---|
| `text` | TextContent | Preserve text. |
| `thinking` | ThinkingContent | Preserve thinking text and signature. |
| `redacted_thinking` | ThinkingContent | `redacted=true`; preserve opaque data in `thinkingSignature`. |
| client `tool_use` | ToolCall | Preserve ID, name, and lossless JSON object input. Non-object input cannot construct Pi ToolCall and is a conversion error. |
| server tool call | content/transcript | Do not present it as a client-executable Pi tool. |
| future discriminator | policy | `unknownContent`, default error. |

Historical assistant messages use `stopReason="toolUse"` when they contain a Pi ToolCall, otherwise `stopReason="stop"`. The source block lifecycle, not a guessed provider finish reason, is authoritative.

### 5.5 Final assistant prefill

A final Anthropic assistant message has continuation/prefill semantics that Pi cannot guarantee. LuckyToken accepts it as an ordinary historical Pi AssistantMessage to keep the request usable and emits a request-local `assistant_prefill_degraded_to_history` notice. It does not inject instructions promising exact continuation.

## 6. ToolResult lifecycle

### 6.1 Correlation

Maintain a request-local map from preceding ToolCall ID to tool name. A ToolResult maps:

```text
tool_use_id → toolCallId
correlated tool name → toolName
is_error absent → isError false
is_error true/false → isError same value
```

Content mapping:

- absent content → empty content array;
- string → one TextContent;
- nested text → TextContent;
- nested base64 image → ImageContent;
- nested `tool_reference.tool_name` → `addedToolNames`;
- nested document/search result → representable ordered text/image degradation;
- cache markers affect §8 only.

### 6.2 Invalid states

- orphan ToolResult: fixed conversion error;
- duplicate ToolResult for one call: fixed conversion error;
- malformed/empty ID: fixed conversion error;
- result before its call: fixed conversion error;
- result content of a known type that fails required conversion: conversion error;
- future unknown nested discriminator: `unknownContent` policy.

### 6.3 Missing result repair

At a point where the source history moves beyond unresolved calls, apply `unresolvedToolCall`:

- `error`: reject conversion;
- `xrepair` (default): insert one synthetic ToolResult per unresolved call in call order.

Synthetic result:

```text
toolCallId = original call ID
toolName = original call name
isError = true
content = "No result — the tool call did not complete (interrupted or lost)."
```

Emit a notice for each inserted result. Never modify a real result.

## 7. Tools and execution ownership

### 7.1 Client/BYOT tools

Ordinary custom tools owned by the caller map to Pi Tool:

| Anthropic field | Pi field |
|---|---|
| name | name |
| description absent | `""` target completion |
| input_schema | parameters |
| strict true | constrainedSampling `{type:"json_schema", strict:"require"}` |

Other source fields with no Pi tool slot, including cache marker position, allowed callers, eager input streaming, and input examples, are dropped.

`Context.tools` contains the complete current request catalog of Client/BYOT-executable tools.

### 7.2 Provider/server-hosted tools

Bash/code execution/web search/web fetch/editor/tool search/container/server tools are classified by execution ownership, not by a concrete Provider name.

- If execution belongs to the server/provider and Pi has no execution owner, do not advertise it as a Pi client tool.
- Preserve returned representable content in order or create a deterministic labeled transcript.
- Drop pure lifecycle metadata.
- If source tool_choice requires a tool that was not included in the executable Pi catalog, drop the unsupported control under the auxiliary-control rule; do not fabricate capability.

### 7.3 defer_loading and tool_reference

All current Client/BYOT tool definitions remain in `Context.tools`, including `defer_loading` definitions. `tool_reference` maps to `ToolResult.addedToolNames` to preserve the dynamic loading event. It does not remove unreferenced tools from the catalog.

An unknown referenced tool name or malformed reference is a conversion error.

## 8. Cache controls

Pi exposes only request-wide `cacheRetention`; Anthropic block-local cache breakpoints cannot be represented exactly.

Default `localCacheControl="ignore"`:

- ignore block/system/message/tool-local breakpoint placement;
- do not expand its scope to the whole request;
- document the fixed drop without per-request notice.

Optional `promote`:

- any `ttl="1h"` → `cacheRetention="long"`;
- otherwise any 5m/default marker → `cacheRetention="short"`;
- emit a notice because local scope became request-wide.

An explicitly request-wide retention control, when the Anthropic profile provides one, maps directly to short/long.

## 9. Pi AssistantMessage → Anthropic response

### 9.1 Envelope

| Anthropic target | Source/construction |
|---|---|
| `id` | Pi `responseId` if present; otherwise generate a valid high-entropy Anthropic-style ID. |
| `type` | fixed `message` |
| `role` | fixed `assistant` |
| `model` | original client selector, never concrete `responseModel` |
| `container` | target default/null where required |
| `content` | §9.2 in Pi order |
| `stop_reason` | §9.3 |
| `stop_sequence` | null/default; Pi has no source fact |
| `usage` | §9.4 |

`responseModel`, diagnostics, rawStopReason, cost, internal timestamps, notices, and credentials are not exposed unless the target protocol has an explicit safe field.

### 9.2 Content projection

| Pi content | Anthropic target | Action |
|---|---|---|
| TextContent | text block | Preserve text; citations default null/empty. |
| ordinary ThinkingContent | thinking block | Preserve text. Use thinkingSignature; if absent, synthesize empty string and emit notice. |
| redacted ThinkingContent | redacted_thinking | Preserve opaque thinkingSignature as `data`. Missing usable opaque data is a conversion failure. |
| ToolCall | tool_use | Preserve ID/name; arguments must be a lossless JSON object. |
| known Pi auxiliary content with no target | none | Drop and document. |
| future Pi content | policy | `unknownPiContent`, default error. Ignore emits notice. |

The empty-string thinking signature is a deterministic compatibility degradation, not an Anthropic default and not a continuity guarantee. If the actual upstream/client rejects it, return the normal protocol failure; never fabricate a cryptographic signature.

Projected `content: []` is allowed. Do not invent an empty text block.

### 9.3 Stop reason normalization

1. Pi `length` → Anthropic `max_tokens` even if content contains a ToolCall; truncation is authoritative.
2. Otherwise, if projected content contains any tool_use → `tool_use`.
3. Otherwise → `end_turn`.
4. If this differs from Pi stopReason, preserve the mismatch only in a non-model-visible diagnostic.
5. `pending`, `error`, `aborted`, and `deferred` are not committed success responses. They are handled by execution/error boundaries.
6. A future unknown stop reason is an error; `unknownPiContent=ignore` cannot fabricate a successful terminal.

### 9.4 Usage

Direct mappings:

- Pi input → `input_tokens`;
- Pi output → `output_tokens`;
- Pi cacheRead → `cache_read_input_tokens`;
- Pi cacheWrite → cache creation tokens;
- Pi cacheWrite1h may split the target cache creation breakdown where the active Anthropic profile supports it;
- Pi reasoning → `output_tokens_details.thinking_tokens` in the active Anthropic target profile;
- Pi cost has no Anthropic response field and is dropped.

The conversion spec follows the selected wire profile. If installed SDK typings lag a field supported by the target profile, document the version mismatch; do not silently treat a real target field as a private invention.

## 10. JSON and atomic SSE

Both renderers use the same fully converted Anthropic message.

### 10.1 JSON

Return the complete message envelope. Conversion failures before response commit use a legal Anthropic error object and appropriate HTTP status.

### 10.2 Atomic SSE lifecycle

```text
message_start
content_block_start / content_block_delta / content_block_stop ...
message_delta
message_stop
```

Rules:

- `message_start.message.usage.output_tokens = 0`;
- start usage contains only the target-defined initial input/cache snapshot;
- content blocks appear in message order;
- text and thinking deltas preserve content;
- redacted thinking uses its target event/block representation and is not silently omitted;
- `message_delta` contains final stop reason and final cumulative usage;
- `message_stop` is emitted exactly once;
- JSON and SSE represent the same semantic message;
- an execution failure before the first SSE byte returns a non-streaming Anthropic error response;
- a failure after commit uses Anthropic's SSE error lifecycle.

## 11. Errors

Client input validation failures use the Anthropic invalid-request family.
Provider/runtime failures may arrive only as validated protocol-neutral Pi
diagnostics preserved in `ExecutionFailure.failure`, never through a shared or
invocation-local observer slot, a conversion-handler custom `fetch`, or a
reparsed Provider string.

The renderer:

- maps only validated neutral status/facts;
- outputs a legal Anthropic error type;
- includes `request_id`/request-id when safely available or target-required null/default;
- forwards only fixed safe retry/request/rate-limit headers;
- bounds and redacts any body-derived message;
- never emits Provider-specific type/code as an unchecked Anthropic error type;
- writes one failure journal for the final failed request.

If `ExecutionFailure.failure` is absent, the renderer has no authority to reuse
Pi `errorMessage` or exception text. It returns the fixed generic Anthropic
upstream error: HTTP 502, `api_error`, and `Upstream provider failed`, without
Provider-derived headers or identifiers.

## 12. Provider Native Anthropic preservation

The current Anthropic native path is **Provider Native Preservation**, not Local Native and not this conversion method. Eligibility comes from the resolved Pi Model's declared `api === "anthropic-messages"`; Provider credential/auth resolution supplies the Provider-facing auth facts, and the handler binds a narrow `passthroughFetch` used only by this Provider Native lane.

The raw Anthropic body remains authoritative except for boundary-required model selector projection; Provider/composed headers own upstream auth while only an approved client header set is forwarded. Conversion never receives the native fetch through Pi options, and Provider Native transport outcomes never supply Semantic Conversion failure facts.

It MUST have separate certification for:

- protocol compatibility declaration;
- path/base URL construction;
- inbound Anthropic version/beta header policy;
- selector/model rewrite policy, if any;
- status/body fidelity;
- safe end-to-end header allowlist;
- content-length/encoding recomputation after buffering;
- SSE/body-read failure and cancellation;
- failure logging without copying credentials or unbounded body data.

## 13. Certification status

The earlier implementation-gap list was closed by the frozen Tickets 05–10 and
is no longer a statement of current behavior. Ticket 28 binds this document by
content hash and certifies the Anthropic Semantic Conversion profile separately from
Provider Native preservation. Owning tests cover mixed content/result order, system
compatibility, prefill degradation, thinking budgets and cache controls,
redacted/missing-signature behavior, empty content, JSON/SSE usage, and
request-local failure isolation.

Real-upstream execution remains separate evidence from deterministic conversion
tests. The 2026-08-14 distribution record is `online-passed`: the Anthropic
route completed 60/60 real CommandCode cases and Claude Code completed 51/51
(17 scenarios × 3) through the installed Provider Package. Anthropic Provider
Native preservation is a separate profile and is not claimed by that CommandCode matrix.
