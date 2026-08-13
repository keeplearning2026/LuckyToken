# OpenAI Responses Client Protocol

Version: **1.0 frozen design**

Reference date: **2026-08-13**
Owner: LuckyToken OpenAI Responses Client Protocol adapter

This document defines the Client wire, local state, rendering, passthrough profile, and ownership boundary for `POST /v1/responses`. Field-by-field Pi conversion is defined in `OpenAI Responses-Pi AI IR Conversion Method.md`; protocol-neutral Runtime boundaries and failure logging are defined in `Protocol Conversion Architecture and Policy.md`. No Anthropic conversion policy, state, helper, or test belongs to this adapter.

## 1. Profiles

### 1.1 Conversion

```text
Responses request
→ Responses Client adapter
→ Pi Context / options
→ selected Pi Provider
→ Pi AssistantMessage
→ Responses JSON or atomic SSE
```

The Client adapter owns Responses parsing, local history, resource resolver capabilities, Pi conversion, response rendering, and Responses-specific errors. It never inspects a concrete Provider protocol.

### 1.2 Native passthrough

If the selected upstream declares compatible OpenAI Responses wire support, LuckyToken may use native passthrough. It does not enter Pi and is certified independently. It is the preferred path for native handles, hosted tools, background jobs, and new Responses fields that cannot yet pass through Pi.

Profile selection is a declared protocol compatibility decision, not a scattered concrete Provider-name condition.

## 2. Endpoint and authentication

```text
POST /v1/responses
Content-Type: application/json
Authorization: Client Protocol-specific LuckyToken credential
```

The Responses handler has its own immutable Auth authority. Raw credentials terminate after authorization. Only the generic authorized facts allowed by the architecture may continue into Pi.

Request size and request lifetime are bounded by configured Client handler limits. Cancellation aborts state expansion/resolution/execution and does not write a closed response.

## 3. Request wire

The active target is the selected OpenAI Responses create profile. It includes, among other fields:

- model, input, instructions;
- max_output_tokens, temperature, top_p;
- reasoning, text;
- tools, tool_choice, parallel_tool_calls;
- previous_response_id, conversation, prompt;
- prompt_cache_key, prompt_cache_retention;
- metadata, safety_identifier, user;
- background, store, stream, stream_options;
- include, context_management, truncation, service_tier.

LuckyToken validates known required types and nullability before conversion. `null` means absence/default where the source contract defines it; it must not become an internal 500.

The complete exact/degrade/drop/error matrix is normative in the conversion document. Important wire decisions:

- LuckyToken conversion requires a resolvable model selector.
- `max_output_tokens`, when present, is positive.
- `conversation` and `previous_response_id` cannot coexist.
- `background:true` is unsupported in Core conversion v1; native passthrough may support it.
- a known malformed item is not treated as a future unknown item.
- unknown discriminators use adapter-local `error|ignore`, default error.

## 4. Input item families

The adapter recognizes the selected SDK/profile's complete item union, including:

- easy/input/output messages;
- reasoning;
- function/custom calls and outputs;
- compaction and item references;
- computer, shell, local shell, apply patch;
- file search, web search, image generation, code interpreter;
- MCP list/approval/call families;
- tool search;
- current documented LuckyToken/Codex extension families.

Recognition does not imply exact Pi mapping. Each known family is classified by semantic content and execution ownership:

- ordinary text/image/reasoning maps to Pi where representable;
- Client/BYOT tool lifecycle maps structurally;
- Provider/server-hosted results degrade to ordered content/transcript rather than fake client tools;
- foreign opaque handles require authority or fail conversion;
- Core v1 tool-search/deferred lifecycle fails explicitly;
- pure lifecycle metadata with no Pi target is dropped;
- partial structured tools fail conversion.

The adapter preserves source order and ToolCall/ToolResult correlation.

## 5. Privileged input mode

Top-level `instructions` always becomes the leading Pi system prompt segment.

Configured `privilegedMessages`:

| Mode | Input system/developer behavior |
|---|---|
| `full` | All enter Pi systemPrompt in source order. |
| `first` (default) | Only system/developer items before the first user message enter systemPrompt; later ones become user messages in place. |
| `user` | All input system/developer items become user messages. |

Promoted prompt segments are separated with `\n`. This explicit mode exists because repeatedly changing a Pi system prefix invalidates prefix caches; the default retains the stable initial privileged prefix without discarding later content.

## 6. Tools

The executable Pi catalog contains the complete current Client/BYOT tool catalog after any supported `tool_choice` filter. Provider/server-hosted execution with no Pi owner is not advertised as a Pi tool.

Core invariants:

- preserve tool ID, name, arguments, result identity, error state, and order;
- function arguments missing/blank→`{}`; invalid JSON/non-object→error;
- custom freeform input uses the documented `{input:string}` compatibility representation;
- grammar maps to Pi constrainedSampling grammar;
- duplicate result is error;
- orphan output is configurable `error|ignore`, default error;
- unresolved call is configurable `error|xrepair`, default xrepair;
- structured tool status in_progress/incomplete/unknown is error;
- `tool_search`/deferred tool discovery is unsupported in Core conversion v1.

## 7. Opaque resources

Core conversion refuses any handle whose model-visible meaning cannot be recovered in a trusted Client-owned authority:

| Handle/state | Core conversion |
|---|---|
| conversation | error |
| reusable prompt | error |
| external item_reference | error |
| foreign encrypted-only compaction | error |
| LuckyToken-owned provable item | resolve→convert |
| LuckyToken-owned verified opaque envelope | decode→convert |
| input_image file_id/remote URL | trusted image resolver→Pi bytes, otherwise error |
| generic non-image input_file | drop/record; no Pi FileContent |

Resolvers belong to this Client adapter and never borrow a Provider credential. Native passthrough may preserve same-authority handles without conversion.

## 8. Local response state

### 8.1 Stored representation

The Client adapter stores Responses wire items, not Pi Context, so expansion is deterministic under the current conversion profile.

```text
response_id → { createdAt, items, storageClass, version }
```

Entries have TTL/capacity and state-file bounds. State write limits and next-start load limits must be mutually compatible.

### 8.2 previous_response_id

```text
absent                         → no expansion
known current local ID          → prepend stored items
unknown/expired/evicted ID      → conversion error
```

There is no fail-open assumption. The 27 sanitized repository fixtures contain no `previous_response_id`, so replay tests do not validate this path.

### 8.3 Authority

Entries are not bound to a Client principal or project. A response ID is therefore a bearer capability. IDs are high entropy, non-enumerable, bounded by TTL/capacity, and treated as sensitive correlation values in logs.

### 8.4 Commit timing

Returning the first response does not wait for memory/session commit. An immediate continuation may race and receive unknown previous_response_id. This is an explicit availability/storage tradeoff, not a guarantee of read-after-write consistency.

### 8.5 store:false

Configured response policy:

| Value | Meaning |
|---|---|
| `honor` (default) | no reusable memory entry and no disk persistence |
| `memory` | process-memory entry only |
| `persist` | store despite false; emit conversion notice |

For true/null/absence, the normal configured storage profile applies. The Response reports only behavior that actually took effect.

### 8.6 Persistence

- state file path is relative to the active config directory unless absolute;
- writes use same-directory temporary file plus atomic rename;
- in-process write serialization prevents overlapping snapshots;
- corrupt state is quarantined;
- disk, entry, and object limits are validated;
- write failure is observable and does not silently claim durability;
- graceful shutdown may flush pending persistence.

## 9. Successful Response wire

The complete object follows the selected Responses target profile. It includes required fields/defaults such as:

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 0,
  "status": "completed",
  "error": null,
  "incomplete_details": null,
  "instructions": null,
  "metadata": {},
  "model": "<client selector>",
  "output": [],
  "parallel_tool_calls": true,
  "temperature": null,
  "tool_choice": "auto",
  "tools": [],
  "top_p": null,
  "usage": {
    "input_tokens": 0,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens": 0,
    "output_tokens_details": { "reasoning_tokens": 0 },
    "total_tokens": 0
  }
}
```

Values above illustrate shape; renderer uses the actual effective/default values. It does not echo a caller setting that was dropped or unsupported as though it took effect. SDK-computed convenience `output_text` is not automatically a wire field.

Status:

- completed: success, error/incomplete_details null;
- incomplete: legal incomplete_details non-null, error null;
- failed: error non-null and distinct from incomplete.

Pi responseId is reused when present; otherwise generate a high-entropy ID. `model` always echoes the Client selector and does not expose a concrete Provider response model.

## 10. Atomic SSE

Current conversion mode buffers Pi execution before committing SSE.

```text
response.created
response.output_item.done ...
response.completed | response.incomplete | response.failed
[DONE]
```

- Every schema event contains a monotonically increasing `sequence_number`.
- Terminal type matches status.
- Failures before the first SSE byte return non-2xx Responses error JSON.
- `response.failed` is used when a failed Response exists or a future live profile has already committed.
- `[DONE]` is a compatibility terminator, not a substitute for the semantic terminal event.

## 11. Errors

Non-streaming error:

```json
{
  "error": {
    "message": "...",
    "type": "...",
    "code": null,
    "param": null
  }
}
```

The adapter keeps type and code distinct, uses validated protocol-neutral failure facts, preserves safe upstream status/request/retry facts, bounds/redacts body-derived messages, and forwards only a fixed safe header allowlist. It never reparses a concrete Provider error string or reads shared mutable observer state.

Every final failed request submits Responses-local structured facts to the protocol-neutral per-request failure journal. The generic sink does not know Responses conversion policy, and the Responses adapter does not read another protocol's log facts.

## 12. Native passthrough conformance

Native Responses passthrough must independently test:

- exact target endpoint/base path behavior;
- model/selector rewrite policy;
- authorization isolation;
- handle, hosted tool, store/background and future-field fidelity;
- status/body/headers;
- completed/incomplete/failed SSE lifecycle;
- retry/cancellation/body failure;
- transport header safety;
- failure logging.

It must never be used to claim coverage for Responses↔Pi conversion.

## 13. Configuration and composition

The protocol is optional and independently registered. Its config schema is adapter-owned, validates unknown keys at startup, and is snapshotted immutably. Composition binds Auth, state store, resolvers, notices, execution, and rendering without copying Responses business rules into Runtime.

## 14. Evidence note

The repository's 27 captured fixtures are sanitized acceptance samples, not a complete wire corpus. They cover a narrow successful Codex CLI shape and do not cover images, files, previous_response_id, conversation, prompt, error status, partial items, or incomplete/failed SSE. Future protocol claims require field-level assertions or new authenticated captures.
