# OpenAI Responses Client Protocol

**Version:** 0.1.0  
**Status:** Draft

**Owner:** `keeplearning2026/LuckyToken`  
**Reference Date:** `2026-08-12`

**Reference Implementations:**

- `D:\project\opencodex` — opencodex `src/responses/state.ts` (session state),
  `src/responses/parser.ts` (request parsing), `src/server/responses-json-events.ts`
  (SSE synthesis), `src/server/responses/core.ts` (save conditions)
- `pi-agent/packages/ai/src/api/openai-responses*.ts` — Pi AI IR ↔ OpenAI Responses
  conversion (reverse direction reference)

---

## 1. Protocol Foundations

### 1.1 Purpose

This specification describes the **OpenAI Responses Client Protocol** adapter
for LuckyToken: the server-side handling of `POST /v1/responses` requests from
Codex-family clients, including the **incremental request + `previous_response_id`
history expansion** mechanism and its **durable local session state**.

Codex clients do not send full conversation history. Each request carries only
the new input items plus a `previous_response_id` reference to a prior response.
The upstream Provider (e.g. CommandCode) is stateless with respect to Responses
semantics and does not recognize `previous_response_id`. LuckyToken therefore
owns the history: it saves each response's `input + output` wire items and
expands `previous_response_id` into the full input before Pi IR conversion.

### 1.2 Scope

This specification covers:

```text
OpenAI Responses Wire (incremental + previous_response_id)
        ↕
OpenAI Responses Client Protocol adapter (LuckyToken-owned)
  ├── session state (memory + durable snapshot)
  ├── previous_response_id expansion
  └── Responses wire ↔ Pi IR conversion
        ↕
Pi AI IR (Context / AssistantMessage)
        ↕
Provider adapter (stateless w.r.t. Responses)
```

The following are **outside** this specification:

```text
provider-specific conversion (Pi ↔ CommandCode etc.)
multi-instance / distributed shared state
per-delta streaming (first version emits atomic SSE sequences)
OpenAI server-side response storage semantics (store:true dashboard)
```

### 1.3 Relationship to Other Documents

```text
Pi AI IR Protocol.md                  — the Pi IR boundary this adapter targets
Anthropic Message Protocol.md         — sibling Client Protocol (independent)
OpenAIResponsesAdapter-Research.md    — opencodex research and decision record
LuckyTokenCoreSpec.md                 — architecture and information ownership
```

The two Client Protocols (Anthropic Messages and OpenAI Responses) are
independent: they share only the Pi IR contracts and the composition root.

---

## 2. Wire Contract

### 2.1 Endpoint

```text
POST /v1/responses
Content-Type: application/json
```

### 2.2 Request

The request body is a JSON object with the following fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | yes | model selector (`provider/model_id`, resolved via `selectorTool` / `resolveModel`) |
| `input` | string \| item[] | yes | conversation increment; string → single user message |
| `previous_response_id` | string | no | reference to a prior response for history expansion |
| `instructions` | string | no | system prompt |
| `store` | boolean | no | **ignored for saving** (local cache semantics, see §3.3) |
| `stream` | boolean | no | SSE vs JSON response |
| `max_output_tokens` | non-negative integer | no | → Pi `maxTokens` |
| `temperature` | finite number | no | → Pi `temperature` |
| `top_p` | finite number | no | validated, not converted |
| `reasoning` | object | no | `reasoning.effort` (`ultra` → `max`) → Pi `reasoning` |
| `tools` | array | no | → Pi `Tool[]` |
| `tool_choice` | object/string | no | validated, not converted |

#### 2.2.1 Input Items

`input` may be a string (→ one user message) or an array of items. Item `type`
dispatch:

| Item type | Mapping |
|---|---|
| `message` (role `system`/`developer`) | appended to `systemPrompt` |
| `message` (role `user`) | Pi `UserMessage` |
| `message` (role `assistant`) | Pi `AssistantMessage` (synthetic history identity, empty usage, `stopReason` stop/toolUse) |
| `reasoning` | pending thinking block, attached to the **next** assistant message |
| `function_call` / `custom_tool_call` | Pi `toolCall` (`id: call_id`, `arguments` JSON-parsed, non-JSON → `{}`) |
| `function_call_output` / `custom_tool_call_output` | Pi `toolResult` (correlated to preceding toolCall; orphan → `InvalidRequest`) |
| `compaction` / `compaction_summary` / `context_compaction` | user text degradation (`encrypted_content` non-string → dropped marker) |
| `agent_message` | Pi `UserMessage` |
| `web_search_call` / `tool_search_call` | dropped (not model-visible) |
| `additional_tools` | merged into tool definitions |
| `compaction_trigger` | dropped |
| unknown type | `InvalidRequest` |

Content parts: `input_text` / `text` / `output_text` → Pi `TextContent`;
`input_image` → Pi `ImageContent` (base64 `image_url`).

#### 2.2.2 Tools

`tools[]` items `{type:"function", name, description, parameters, strict?}` map
to Pi `Tool[]`. `strict: true` → `constrainedSampling
{type:"json_schema", strict:"require"}`.

### 2.3 Response

Successful response object:

```json
{
  "id": "resp_<uuid>",
  "object": "response",
  "created_at": 1723456789,
  "status": "completed",
  "model": "<client model selector>",
  "output": [ /* output items */ ],
  "previous_response_id": "<echoed when present>",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens_details": { "reasoning_tokens": 0 }
  }
}
```

`status` mapping from Pi `stopReason`:

```text
stop    → "completed"
length  → "incomplete" + incomplete_details.reason = "max_output_tokens"
toolUse → "completed"
other   → fidelity failure
```

`previous_response_id` is echoed when the client sent it (`store` is **not**
echoed).

Output items from Pi content blocks:

```text
text / thinking → message item (output_text parts, role assistant)
thinking       → additional reasoning item
toolCall       → function_call item
                  {call_id, name, arguments: JSON.stringify(arguments), status:"completed"}
```

### 2.4 SSE

When `stream: true`, the response is a synthetic atomic SSE sequence:

```text
response.created          (status "in_progress", output [])
response.output_item.done (one per output item, {output_index, item})
response.completed        (full response object)
data: [DONE]
```

This is the canonical sequence Codex commits. First version emits the full
sequence atomically (Pi `execute` returns a complete `AssistantMessage`); no
per-delta streaming.

### 2.5 Errors

Error response shape:

```json
{ "error": { "type": "<error_type>", "message": "<message>" } }
```

Error type mapping:

| Condition | Status | Error type |
|---|---|---|
| invalid body / semantic | 400 | `invalid_request_error` |
| auth failure | 401 | `authentication_error` |
| model resolution failure | 404 | `not_found_error` |
| provider execution failure | 502 | `api_error` |
| request too large | 413 | `request_too_large` |
| unknown | 500 | `api_error` |

---

## 3. Session State

### 3.1 In-Memory Store

The adapter owns a module-local `Map<string, {createdAt, items}>`:

```text
response_id → { createdAt: number, items: unknown[] }
```

`items` are the **raw wire items** (`[...inputItems(request.input), ...response.output]`).
Pi Context conversion is deferred until expansion time; the store holds no Pi
representation (single source of truth).

### 3.2 Expansion

`expandPreviousResponseInput(body)`:

```text
no previous_response_id          → body unchanged
unknown previous_response_id    → body unchanged (fail-open)
known previous_response_id      → {...body, input: [...stored.items, ...inputItems(body.input)]}
```

Fail-open means an unknown id degrades to the naked increment; Codex will
re-send the full history itself.

### 3.3 Saving

`rememberResponseState(request, response)` saves when **all** hold:

```text
request is an object
response.id is a non-empty string
response.output is an array
response.status is "completed" or "incomplete"
  ("incomplete" saved only when incomplete_details.reason === "max_output_tokens")
```

**`store: false` is ignored**: every legal response is saved (Q8a). This is a
local proxy cache, unrelated to OpenAI server-side storage.

**Expansion-failure protection (Q8/D8)**: a request whose own
`previous_response_id` failed to expand is **not saved**. Its input is a naked
increment; saving it would replay a truncated conversation.

### 3.4 Durability

#### 3.4.1 Snapshot File

Default path: `<config-dir>/.luckytoken/state/openai-responses.json`, overridable
via `clientProtocols["openai-responses"].stateFile` (resolved relative to the
config directory).

Format:

```json
{
  "version": 2,
  "states": [
    ["resp_abc", { "createdAt": 1723456789, "items": [ /* wire items */ ] }]
  ]
}
```

#### 3.4.2 Write Strategy

```text
debounced 2s after mutation (setTimeout unref'd)
single-flight gate (no same-process concurrent writes)
atomic: tmp file (<name>.<pid>.<seq>.tmp) + rename
tmp mode 0600
write failures swallowed (cache, not source of truth)
flush() on graceful shutdown / test hook
```

#### 3.4.3 Load Strategy

```text
lazy load on first store access
missing file             → empty state
file > 32MB              → refuse parse, empty state
corrupt / unparseable    → backup as <file>.corrupt, empty state
orphan tmp cleanup       → matching pattern, pid not alive, mtime > 15min
```

Loading never crashes the server (isolation failure philosophy, cf. cc-switch
session-manager §8.2).

#### 3.4.4 Bounds

```text
MAX_ENTRIES = 1000 (FIFO eviction of oldest by createdAt)
snapshot file 32MB parse ceiling
no TTL (local cache; entry cap bounds disk)
```

---

## 4. Pi IR Boundary

The session state, expansion, and wire conversion are **entirely the Client
Protocol adapter's responsibility**. The Provider sees only the expanded full
history converted to Pi IR:

```text
Responses Wire (increment)
        ↕
adapter (state + expansion + conversion)
        ↕
Pi Context (full history)   ← Provider's only view
```

The adapter must never import, inspect, name, or make decisions from any
concrete Provider or upstream protocol. No second IR is introduced.

---

## 5. Composition and Authentication

### 5.1 Registration

`openai-responses` is an **optional** Client Protocol: it is registered when
present in `clientProtocols`, skipped otherwise. `anthropic-messages` remains
required. The composition root binds a handler with its own `Auth` instance and
its own token file (`clientProtocols["openai-responses"].authFile`).

### 5.2 Auth Isolation

Each Client Protocol handler receives its own generic `Auth` instance and
immutable startup token authority (AGENTS.md). Anthropic and OpenAI Responses
never share auth state or token files.

---

## 6. Decision Record

Decisions confirmed during the grilling session (2026-08-12):

| # | Decision |
|---|---|
| D1 | Durable disk snapshot; history survives process restart |
| D2 | Store raw wire items, not Pi Context (single source of truth) |
| D3 | opencodex snapshot mode: 2s debounce + atomic tmp/rename + close flush |
| D4 | 1000 entries FIFO + 32MB file ceiling; **no TTL** |
| D5 | Default `.luckytoken/state/openai-responses.json`, overridable `stateFile` |
| D6 | Single-instance assumption; no cross-process locking |
| D7 | Unconditional save: ignore `store:false` |
| D8 | Expansion-failure turn is not saved (anti-poisoning) |
| D9 | Fail-open expansion on unknown `previous_response_id` |
| D10 | Corrupt snapshot → backup + empty start, never crash |
| D11 | Echo `previous_response_id` in response; do not echo `store` |
| D12 | Optional protocol registration; independent auth + stateFile |

---

## 7. Out of Scope (v1)

```text
per-delta SSE streaming (atomic sequences only)
WS (WebSocket) channel
multi-instance shared state
compaction / reasoning-replay caches (opencodex advanced features)
encrypted payload handling
metrics / system routes
```
