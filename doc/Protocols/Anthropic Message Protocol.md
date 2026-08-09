# Anthropic Messages API Wire Protocol

**Protocol:** Anthropic Messages API
**Primary endpoint:** `POST /v1/messages`
**Transport:** HTTP + JSON / Server-Sent Events (SSE)
**Reference baseline:** 2026-08-09

This document describes the **Anthropic Messages wire protocol** itself.

It defines:

- HTTP request structure;
- Messages request structure;
- content blocks;
- client tool protocol;
- non-streaming responses;
- streaming responses;
- usage;
- termination;
- errors;
- protocol invariants.

It does **not** define how Anthropic messages map to Pi, CommandCode, OpenAI, or any other semantic model. Those mappings belong in separate conversion specifications.

Model-dependent capabilities and rapidly changing features are isolated from the stable protocol core where possible.

------

# 1. Protocol Overview

## 1.1 Protocol hierarchy

```text
Anthropic Messages API
│
├── HTTP Request
│   ├── Headers
│   └── MessageRequest
│       ├── Model / Output Limit
│       ├── Conversation
│       ├── Tools
│       ├── Thinking
│       ├── Output / Generation Controls
│       └── Runtime / Cache / Metadata
│
└── HTTP Response
    │
    ├── Non-Streaming
    │   └── Message
    │
    └── Streaming
        └── Message SSE Lifecycle
            ├── message_start
            ├── ContentBlock[index]*
            ├── message_delta+
            └── message_stop
```

The Messages API is stateless at the request level: the request supplies the conversation history needed for the next assistant turn, and Anthropic returns the next assistant `Message`.

------

## 1.2 Stable protocol concepts

The protocol revolves around four main structures:

```text
MessageRequest
↓
Message[]
↓
ContentBlock[]
↓
Message response
```

For streaming, the same final `Message` is incrementally constructed through SSE events. Official SDKs can accumulate the stream into the same final message representation returned by a non-streaming request.

------

## 1.3 Tagged-union rule

Many Anthropic structures use a `type` discriminator:

```text
ContentBlock
├── type = "text"
├── type = "image"
├── type = "thinking"
├── type = "tool_use"
├── type = "tool_result"
└── ...
```

The same pattern appears in:

- thinking configuration;
- tool choice;
- media sources;
- SSE delta objects;
- errors;
- extension blocks.

Implementations should treat these unions as extensible rather than assuming today's list is permanently closed. Anthropic explicitly allows compatible additions such as new content blocks, event types, fields, and enum values.

------

# 2. HTTP Layer

## 2.1 Endpoint

```http
POST /v1/messages
```

Request:

```text
HTTP Request
├── Headers
└── JSON body
    └── MessageRequest
```

Response depends on `stream`:

```text
stream = false / omitted
→ JSON Message

stream = true
→ text/event-stream
```

------

## 2.2 Required headers

For the direct Claude API:

| Header              | Presence                          | Value                        |
| ------------------- | --------------------------------- | ---------------------------- |
| `x-api-key`         | one authentication method         | API key                      |
| `Authorization`     | alternative authentication method | `Bearer <short-lived token>` |
| `anthropic-version` | required                          | API version                  |
| `content-type`      | required                          | `application/json`           |

Exactly one supported authentication mechanism is normally used. API keys use `x-api-key`; Workload Identity Federation can use a short-lived bearer token through `Authorization`.

Example:

```http
POST /v1/messages
content-type: application/json
x-api-key: <api-key>
anthropic-version: 2023-06-01
```

Cloud-provider versions of Claude may use provider-specific authentication instead of the direct Claude API headers.

------

## 2.3 `anthropic-version`

Type:

```text
string
```

Example:

```text
2023-06-01
```

This selects the Anthropic API version contract.

It is independent from the selected model version.

------

# 3. Request Protocol

## 3.1 MessageRequest hierarchy

```text
MessageRequest
│
├── Core
│   ├── model
│   ├── max_tokens
│   └── messages[]
│
├── Conversation
│   └── system?
│
├── Tools
│   ├── tools[]?
│   └── tool_choice?
│
├── Thinking
│   └── thinking?
│
├── Output Configuration
│   └── output_config?
│       ├── effort?
│       └── format?
│
├── Generation Controls
│   ├── stop_sequences?
│   ├── temperature?
│   ├── top_p?
│   └── top_k?
│
├── Transport
│   └── stream?
│
├── Cache / Runtime
│   ├── cache_control?
│   ├── container?
│   ├── inference_geo?
│   └── service_tier?
│
└── Metadata
    └── metadata?
        └── user_id?
```

`model`, `max_tokens`, and `messages` form the normal required core. Other fields modify tools, thinking, output, sampling, transport, caching, or execution behavior.

------

## 3.2 Top-level field contract

| Field            | Type                 | Presence | Source / Kind   | Meaning                       |
| ---------------- | -------------------- | -------- | --------------- | ----------------------------- |
| `model`          | string               | required | client-supplied | model identifier              |
| `max_tokens`     | integer              | required | client-supplied | absolute output ceiling       |
| `messages`       | array                | required | client-supplied | ordered conversation history  |
| `system`         | string / text blocks | optional | client-supplied | top-level system instructions |
| `tools`          | array                | optional | client-supplied | available tool definitions    |
| `tool_choice`    | object               | optional | client-supplied | tool-selection policy         |
| `thinking`       | tagged object        | optional | client-supplied | thinking mode                 |
| `output_config`  | object               | optional | client-supplied | output format / effort        |
| `stop_sequences` | string[]             | optional | client-supplied | custom stops                  |
| `temperature`    | number               | optional | model-dependent | sampling control              |
| `top_p`          | number               | optional | model-dependent | sampling control              |
| `top_k`          | number               | optional | model-dependent | sampling control              |
| `stream`         | boolean              | optional | client-supplied | selects JSON or SSE           |
| `cache_control`  | object               | optional | client-supplied | automatic prompt caching      |
| `container`      | string               | optional | client-supplied | reusable container identity   |
| `inference_geo`  | string               | optional | client-supplied | inference geography           |
| `service_tier`   | enum                 | optional | client-supplied | capacity selection            |
| `metadata`       | object               | optional | client-supplied | request metadata              |

Some fields are model-dependent even though they are structurally valid Messages parameters.

------

## 3.3 `model`

Type:

```text
string
```

Example:

```json
{
  "model": "claude-opus-5"
}
```

The value identifies the model that should generate the next assistant message.

The accepted identifiers and capabilities are model-catalog concerns rather than structural properties of the Messages protocol.

------

## 3.4 `max_tokens`

Type:

```text
integer >= 0
```

Meaning:

```text
maximum output tokens for this response
```

The model may stop earlier.

Current API semantics also allow:

```json
{
  "max_tokens": 0
}
```

for prompt-cache population without ordinary response generation. Maximum supported values differ by model.

------

## 3.5 Conversation hierarchy

```text
Conversation
│
├── Top-Level System
│   └── system?
│
└── messages[]
    ├── UserMessage
    └── AssistantMessage
```

The stable core conversation alternates between `user` and `assistant` turns. Consecutive turns of the same role may be combined by Anthropic.

Model-dependent mid-conversation `system` messages now also exist and are described separately in Appendix A rather than changing the stable core model here.

------

## 3.6 Top-level `system`

Core forms:

```text
system
├── string
└── TextBlock[]
```

Simple:

```json
{
  "system": "You are a careful coding assistant."
}
```

Structured:

```json
{
  "system": [
    {
      "type": "text",
      "text": "You are a careful coding assistant."
    }
  ]
}
```

The top-level field represents instructions applying to the request/conversation rather than an ordinary end-user turn.

------

## 3.7 Message structure

```ts
interface MessageParam {
  role: "user" | "assistant"
  content: string | ContentBlock[]
}
```

Core hierarchy:

```text
Message
├── role
│   ├── user
│   └── assistant
│
└── content
    ├── string
    └── ContentBlock[]
```

A string is shorthand for one text block.

Therefore:

```json
{
  "role": "user",
  "content": "Hello"
}
```

is semantically equivalent to:

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Hello"
    }
  ]
}
```

------

## 3.8 Message ordering

`messages[]` is ordered conversation history.

Typical structure:

```text
user
↓
assistant
↓
user
↓
assistant
```

If the last input message is an `assistant` turn, Anthropic continues directly from that partial assistant response.

------

## 3.9 Content block hierarchy

The core content model is:

```text
ContentBlock
│
├── Text
│   └── text
│
├── Media / Source Content
│   ├── image
│   ├── document
│   └── search_result
│
├── Thinking
│   ├── thinking
│   └── redacted_thinking
│
├── Client Tool Protocol
│   ├── tool_use
│   └── tool_result
│
└── Extensions
    ├── server-tool blocks
    ├── tool references
    ├── fallback blocks
    └── future content types
```

The API reference exposes a larger union than this core subset, especially for Anthropic-hosted tools. Consumers should therefore preserve the distinction between **known core blocks**, **known extensions**, and **unknown future blocks**.

------

## 3.10 Parent/content relationship

At the client-tool core:

```text
UserMessage
└── content[]
    ├── TextBlock
    ├── ImageBlock
    ├── DocumentBlock
    ├── SearchResultBlock
    └── ToolResultBlock

AssistantMessage
└── content[]
    ├── TextBlock
    ├── ThinkingBlock
    ├── RedactedThinkingBlock
    └── ToolUseBlock
```

Anthropic integrates tool operations into ordinary user/assistant messages rather than introducing a separate `tool` role.

------

## 3.11 TextBlock

### Tree

```text
TextBlock
├── type = "text"
├── text
├── citations?
└── cache_control?
```

### Field contract

| Field           | Type     | Presence | Kind                  |
| --------------- | -------- | -------- | --------------------- |
| `type`          | `"text"` | required | literal discriminator |
| `text`          | string   | required | content               |
| `citations`     | array    | optional | citation metadata     |
| `cache_control` | object   | optional | cache marker          |

Example:

```json
{
  "type": "text",
  "text": "Hello"
}
```

------

## 3.12 ImageBlock

### Tree

```text
ImageBlock
├── type = "image"
├── source
│   ├── Base64ImageSource
│   │   ├── type = "base64"
│   │   ├── media_type
│   │   └── data
│   │
│   └── URLImageSource
│       ├── type = "url"
│       └── url
│
└── cache_control?
```

### Base64 source

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "<base64>"
  }
}
```

Supported MIME discriminators currently include:

```text
image/jpeg
image/png
image/gif
image/webp
```

### URL source

```json
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://example.com/image.png"
  }
}
```

------

## 3.13 DocumentBlock

### Tree

```text
DocumentBlock
├── type = "document"
├── source
├── title?
├── context?
├── citations?
└── cache_control?
```

Current source variants include:

```text
DocumentSource
├── Base64 PDF
│   ├── type = "base64"
│   ├── media_type = "application/pdf"
│   └── data
│
├── Plain Text
│   ├── type = "text"
│   ├── media_type = "text/plain"
│   └── data
│
├── Content Blocks
│   ├── type = "content"
│   └── content
│
└── URL PDF
    ├── type = "url"
    └── url
```

A conversion layer should preserve the source discriminator rather than reducing every document to a single string representation.

------

## 3.14 SearchResultBlock

Conceptually:

```text
SearchResultBlock
├── type = "search_result"
├── source
├── title
├── content[]
├── citations?
└── cache_control?
```

Search results participate in Anthropic's broader citation/content system and may occur in message or tool-result content.

------

## 3.15 Tool definitions

### Hierarchy

```text
tools[]
└── ToolDefinition
    ├── name
    ├── description?
    ├── input_schema
    └── optional controls
```

Core client tool:

```ts
interface ToolDefinition {
  name: string
  description?: string
  input_schema: {
    type: "object"
    properties?: Record<string, unknown>
    required?: string[]
  }

  type?: "custom"
}
```

The currently documented tool union also contains additional optional controls and Anthropic-provided tool types.

Example:

```json
{
  "name": "get_weather",
  "description": "Get the weather for a location.",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {
        "type": "string"
      }
    },
    "required": [
      "location"
    ]
  }
}
```

------

## 3.16 `tool_choice`

Hierarchy:

```text
tool_choice
├── auto
│   ├── type = "auto"
│   └── disable_parallel_tool_use?
│
├── any
│   ├── type = "any"
│   └── disable_parallel_tool_use?
│
├── tool
│   ├── type = "tool"
│   ├── name
│   └── disable_parallel_tool_use?
│
└── none
    └── type = "none"
```

Semantics:

| Type   | Meaning                             |
| ------ | ----------------------------------- |
| `auto` | model decides whether to call tools |
| `any`  | model must choose an available tool |
| `tool` | model must use the named tool       |
| `none` | tool use disabled                   |

For `auto`, disabling parallel tool use allows at most one tool use. For `any` and `tool`, disabling parallel use means exactly one selected tool call.

------

## 3.17 Thinking configuration

### Stable structural union

```text
thinking
├── disabled
│   └── type = "disabled"
│
├── adaptive
│   ├── type = "adaptive"
│   └── display?
│
└── manual
    ├── type = "enabled"
    ├── budget_tokens
    └── display?
```

`display`, where supported, uses:

```text
summarized
omitted
```

Actual availability, defaults, and restrictions depend heavily on the selected model and therefore belong in Appendix A.

------

## 3.18 `output_config`

Hierarchy:

```text
output_config
├── effort?
└── format?
```

### Effort

Wire values currently defined by the API:

```text
low
medium
high
xhigh
max
```

`high` is the general API default where effort is supported, but individual models support different subsets. Effort is a behavioral control rather than a strict token budget.

### Structured format

Current JSON-schema form:

```json
{
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object"
      }
    }
  }
}
```

------

## 3.19 Sampling controls

Structurally known controls include:

```text
temperature
top_p
top_k
```

These must be treated as **model-dependent**, not universal Messages semantics.

Current newer models increasingly reject non-default sampling settings; for example, Claude 4.7+ models and Mythos Preview do not support these controls in the same way older models do.

A protocol parser may understand these fields without assuming the selected model accepts them.

------

## 3.20 `stop_sequences`

Type:

```text
string[]
```

If a custom stop sequence is generated:

```text
stop_reason = "stop_sequence"
stop_sequence = matched sequence
```

------

## 3.21 `stream`

Type:

```text
boolean
false / omitted
→ non-streaming Message response

true
→ SSE stream
```

------

## 3.22 Cache control

Current cache-control form:

```text
CacheControl
├── type = "ephemeral"
└── ttl?
    ├── "5m"
    └── "1h"
```

The default TTL is currently five minutes when omitted. Cache markers may appear on cacheable blocks, and top-level `cache_control` can enable automatic prompt caching behavior.

Cache placement is infrastructure behavior, not conversation semantics. Conversion layers should therefore avoid accidentally moving dynamic information ahead of stable cached prefixes.

------

## 3.23 Runtime and metadata fields

### `container`

```text
string?
```

Identifies a reusable container where supported by relevant tool/runtime features.

### `inference_geo`

```text
string?
```

Selects inference geography where supported.

### `service_tier`

```text
auto
standard_only
```

This controls requested capacity behavior; the actual service tier used can be reported separately in response usage.

### `metadata.user_id`

```text
string?
```

An application-supplied opaque external user identifier. Anthropic currently recommends avoiding directly identifying information such as a name or email address.

------

# 4. Non-Streaming Response Protocol

## 4.1 Message hierarchy

A successful non-streaming request produces one assistant `Message`:

```text
Message
│
├── Identity
│   ├── id
│   ├── type = "message"
│   ├── role = "assistant"
│   └── model
│
├── Content
│   └── content[]
│
├── Termination
│   ├── stop_reason
│   ├── stop_sequence
│   └── stop_details?
│
├── Usage
│   └── usage
│
└── Runtime State
    └── container?
```

------

## 4.2 Core Message field contract

| Field           | Type          | Presence                             | Source / Kind              |
| --------------- | ------------- | ------------------------------------ | -------------------------- |
| `id`            | string        | required                             | server-generated opaque ID |
| `type`          | `"message"`   | required                             | literal                    |
| `role`          | `"assistant"` | required                             | literal                    |
| `model`         | string        | required                             | server-reported model      |
| `content`       | array         | required                             | server-generated blocks    |
| `stop_reason`   | enum/string   | required after non-stream completion | server-generated           |
| `stop_sequence` | string/null   | required                             | server-generated           |
| `stop_details`  | object/null   | optional/versioned                   | server-generated           |
| `usage`         | object        | required                             | server-generated           |
| `container`     | object/null   | feature-dependent                    | server-generated           |

The message ID is opaque: consumers should not infer semantics from its exact length or internal representation.

------

## 4.3 Example response

```json
{
  "id": "msg_01...",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-5",
  "content": [
    {
      "type": "text",
      "text": "Hello."
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 10,
    "output_tokens": 5
  }
}
```

The exact presence of additional usage/runtime fields is feature-dependent.

------

## 4.4 Response content hierarchy

Core assistant output blocks include:

```text
Message.content[]
├── TextBlock
├── ThinkingBlock
├── RedactedThinkingBlock
├── ToolUseBlock
└── ExtensionBlock
```

The current API also exposes Anthropic server-tool block variants. These are protocol extensions rather than client-tool `tool_use` blocks and should not be collapsed into one representation at the wire layer.

------

## 4.5 ThinkingBlock

### Tree

```text
ThinkingBlock
├── type = "thinking"
├── thinking
└── signature
```

### Field contract

| Field       | Type         | Presence | Kind                                       |
| ----------- | ------------ | -------- | ------------------------------------------ |
| `type`      | `"thinking"` | required | literal                                    |
| `thinking`  | string       | required | returned/summarized thinking; may be empty |
| `signature` | string       | required | opaque continuity/integrity data           |

Example:

```json
{
  "type": "thinking",
  "thinking": "...",
  "signature": "..."
}
```

When `display: "omitted"` is used, the protocol still returns a normal `thinking` block with an empty `thinking` string and a signature; it does **not** become `redacted_thinking`.

------

## 4.6 RedactedThinkingBlock

```text
RedactedThinkingBlock
├── type = "redacted_thinking"
└── data
```

Example:

```json
{
  "type": "redacted_thinking",
  "data": "..."
}
```

`redacted_thinking` is a distinct protocol state from a normal `thinking` block whose display has been omitted.

------

## 4.7 Usage

Core hierarchy:

```text
Usage
│
├── Input
│   ├── input_tokens
│   ├── cache_creation_input_tokens
│   └── cache_read_input_tokens
│
├── Cache Breakdown?
│   └── cache_creation
│       ├── ephemeral_5m_input_tokens
│       └── ephemeral_1h_input_tokens
│
├── Output
│   ├── output_tokens
│   └── output_tokens_details?
│       └── thinking_tokens
│
├── Server Tool Usage?
│
└── Execution Metadata?
    ├── service_tier
    └── inference_geo
```

Total input usage is conceptually:

```text
input_tokens
+ cache_creation_input_tokens
+ cache_read_input_tokens
```

when the cache fields are present.

### Thinking-token invariant

```text
usage.output_tokens_details.thinking_tokens
```

is a **breakdown of `output_tokens`**, not an extra amount to add on top.

`output_tokens` remains the inclusive authoritative output count.

------

# 5. Client Tool Lifecycle

## 5.1 Tool protocol hierarchy

Client tool use is a cross-turn protocol:

```text
Tool Lifecycle
│
├── Definition
│   └── request.tools[]
│
├── Invocation
│   └── AssistantMessage
│       └── ToolUseBlock
│
├── External Execution
│   └── application executes tool
│
└── Result
    └── UserMessage
        └── ToolResultBlock
```

For client tools, Anthropic returns a structured request but does not execute the application-defined operation. The application executes it and returns the result.

------

## 5.2 ToolUseBlock

### Tree

```text
ToolUseBlock
├── type = "tool_use"
├── id
├── name
├── input
└── caller? / extension metadata?
```

### Field contract

| Field    | Type          | Presence          | Source / Kind                       |
| -------- | ------------- | ----------------- | ----------------------------------- |
| `type`   | `"tool_use"`  | required          | literal                             |
| `id`     | string        | required          | server-generated opaque identity    |
| `name`   | string        | required          | selected from available tools       |
| `input`  | object        | required          | completed model-generated arguments |
| `caller` | tagged object | feature-dependent | invocation provenance               |

Example:

```json
{
  "type": "tool_use",
  "id": "toolu_01ABC",
  "name": "get_weather",
  "input": {
    "location": "San Francisco"
  }
}
```

------

## 5.3 ToolResultBlock

### Tree

```text
ToolResultBlock
├── type = "tool_result"
├── tool_use_id
├── content?
├── is_error?
└── cache_control?
```

### Field contract

| Field           | Type                        | Presence | Source / Kind             |
| --------------- | --------------------------- | -------- | ------------------------- |
| `type`          | `"tool_result"`             | required | literal                   |
| `tool_use_id`   | string                      | required | copied from `tool_use.id` |
| `content`       | string / supported blocks[] | optional | application-supplied      |
| `is_error`      | boolean                     | optional | application-supplied      |
| `cache_control` | object                      | optional | application-supplied      |

Supported structured result content includes text, image, document, and search-result blocks.

Example:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01ABC",
  "content": "72°F and sunny",
  "is_error": false
}
```

------

## 5.4 Tool identity invariant

```text
AssistantMessage
└── tool_use
    └── id = X
         │
         ▼
UserMessage
└── tool_result
    └── tool_use_id = X
```

Therefore:

```text
tool_use.id
=
tool_result.tool_use_id
```

The ID is the authoritative cross-turn identity for a client tool invocation.

------

## 5.5 Tool-result ordering

For client tools:

```text
assistant tool_use message
↓
immediately following user message
↓
tool_result blocks
```

No unrelated message may be inserted between the assistant tool-use turn and the corresponding user tool-result turn.

Within the result user message:

```text
content[]
├── tool_result
├── tool_result
└── ordinary text?
```

All `tool_result` blocks must precede ordinary text.

Invalid:

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Here are the results."
    },
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01"
    }
  ]
}
```

Valid:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01",
      "content": "result"
    },
    {
      "type": "text",
      "text": "Continue."
    }
  ]
}
```

------

## 5.6 Parallel tool calls

One assistant message can contain multiple `tool_use` blocks.

Conceptually:

```text
AssistantMessage
├── tool_use(id=A)
├── tool_use(id=B)
└── tool_use(id=C)

        ↓ application executes

UserMessage
├── tool_result(tool_use_id=A)
├── tool_result(tool_use_id=B)
└── tool_result(tool_use_id=C)
```

The identity relationship is ID-based, not positional.

------

## 5.7 Thinking with tool use

Thinking blocks returned in tool-use workflows should be preserved when included in subsequent conversation history rather than reconstructed manually. Anthropic uses opaque thinking signatures to preserve continuity.

A safe round-trip model is:

```text
Assistant response
├── thinking
├── tool_use
└── ...

        ↓ preserve

Next request history
├── same assistant thinking/tool blocks
└── user tool_result
```

------

# 6. Streaming Response Protocol

## 6.1 Stream hierarchy

When:

```json
{
  "stream": true
}
```

the response is an SSE stream.

Canonical hierarchy:

```text
Anthropic SSE Stream
│
├── Message Lifecycle
│   │
│   ├── message_start
│   │
│   ├── ContentBlock[index]*
│   │   ├── content_block_start
│   │   ├── content_block_delta*
│   │   └── content_block_stop
│   │
│   ├── message_delta+
│   │
│   └── message_stop
│
├── Auxiliary
│   └── ping*
│
└── Failure
    └── error
```

This is the core official streaming sequence.

------

## 6.2 SSE frame

Events use named SSE framing:

```text
event: <event-name>
data: <JSON>
```

The JSON object also carries its own `type` discriminator.

Example:

```text
event: message_stop
data: {"type":"message_stop"}
```

------

## 6.3 Stream state machine

```text
NOT_STARTED
    │
    │ message_start
    ▼
RUNNING
    │
    ├── content blocks
    ├── message_delta
    ├── ping
    │
    ├── message_stop
    │      ▼
    │   COMPLETE
    │
    └── error
           ▼
         FAILED
```

`message_stop` is the normal successful stream terminal.

------

## 6.4 `message_start`

Tree:

```text
message_start
└── message
    ├── id
    ├── type = "message"
    ├── role = "assistant"
    ├── model
    ├── content = []
    ├── stop_reason = null
    ├── stop_sequence = null
    └── initial usage
```

Example:

```text
event: message_start
data: {
  "type": "message_start",
  "message": {
    "id": "msg_01...",
    "type": "message",
    "role": "assistant",
    "content": [],
    "model": "claude-opus-5",
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 25,
      "output_tokens": 1
    }
  }
}
```

The `Message` starts with an empty content array and is incrementally completed by later events.

------

## 6.5 Content block lifecycle

Every streamed content block is identified by an integer `index`:

```text
ContentBlock[index]
├── content_block_start
├── content_block_delta*
└── content_block_stop
```

The index corresponds to the position of that block in the final:

```text
Message.content[index]
```

A normal block state machine is:

```text
NONE
 │
 │ content_block_start(index)
 ▼
OPEN
 │
 ├── content_block_delta(index)*
 │
 │ content_block_stop(index)
 ▼
COMPLETE
```

Server-side fallback blocks are a documented exception and can start and stop without deltas.

------

## 6.6 `content_block_start`

Structure:

```text
content_block_start
├── index
└── content_block
```

Example text start:

```text
event: content_block_start
data: {
  "type": "content_block_start",
  "index": 0,
  "content_block": {
    "type": "text",
    "text": ""
  }
}
```

The `content_block` discriminator determines which delta lifecycle is valid for that index.

------

## 6.7 Delta hierarchy

```text
content_block_delta
├── index
└── delta
    ├── TextDelta
    │   ├── type = "text_delta"
    │   └── text
    │
    ├── InputJSONDelta
    │   ├── type = "input_json_delta"
    │   └── partial_json
    │
    ├── ThinkingDelta
    │   ├── type = "thinking_delta"
    │   └── thinking
    │
    ├── SignatureDelta
    │   ├── type = "signature_delta"
    │   └── signature
    │
    ├── CitationsDelta
    └── FutureDelta
```

Anthropic reserves the ability to add new delta variants, so a parser should distinguish an unknown delta type from malformed data for a known delta type.

------

## 6.8 Text streaming

Lifecycle:

```text
content_block_start(text)
↓
text_delta*
↓
content_block_stop
```

Example:

```text
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "text_delta",
    "text": "Hello"
  }
}
```

The complete `TextBlock.text` is obtained by concatenating text deltas in order for that block index.

------

## 6.9 Tool-input streaming

### Hierarchy

```text
ToolUseBlock[index]
│
├── content_block_start
│   └── tool_use
│       ├── id
│       ├── name
│       └── input = {}
│
├── content_block_delta*
│   └── input_json_delta
│       └── partial_json
│
└── content_block_stop
    ↓
complete tool_use.input object
```

Anthropic streams tool input as **partial JSON strings**, while the completed tool-use input is an object.

Example delta:

```text
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 1,
  "delta": {
    "type": "input_json_delta",
    "partial_json": "{\"location\":\"San Fra"
  }
}
```

### Critical invariant

```text
input_json_delta.partial_json
≠
tool_use.input
```

`partial_json` is incomplete syntax.

It must not be exposed as a completed semantic tool call.

A robust consumer accumulates fragments per content-block index and only treats the result as completed structured input once the block lifecycle has completed and the JSON is valid.

------

## 6.10 Thinking streaming

Normal lifecycle:

```text
content_block_start(thinking)
↓
thinking_delta*
↓
signature_delta
↓
content_block_stop
```

Thinking delta:

```text
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "thinking_delta",
    "thinking": "..."
  }
}
```

Signature delta:

```text
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "signature_delta",
    "signature": "..."
  }
}
```

Anthropic currently sends the signature shortly before the thinking block closes.

------

## 6.11 Omitted-thinking streaming

When:

```text
thinking.display = "omitted"
```

the streaming lifecycle is:

```text
content_block_start
└── thinking {
      thinking: "",
      signature: ""
    }

↓
signature_delta
↓
content_block_stop
```

No `thinking_delta` events are emitted.

This again demonstrates:

```text
omitted thinking
≠
redacted_thinking
```

------

## 6.12 `content_block_stop`

Structure:

```text
content_block_stop
└── index
```

Example:

```text
event: content_block_stop
data: {
  "type": "content_block_stop",
  "index": 0
}
```

This closes the corresponding `Message.content[index]`.

No later delta should be applied to the closed block in a normal lifecycle.

------

## 6.13 `message_delta`

Hierarchy:

```text
message_delta
├── delta
│   ├── stop_reason?
│   ├── stop_sequence?
│   ├── stop_details?
│   ├── container?
│   └── versioned message-level updates
│
└── usage
```

Example:

```text
event: message_delta
data: {
  "type": "message_delta",
  "delta": {
    "stop_reason": "end_turn",
    "stop_sequence": null
  },
  "usage": {
    "output_tokens": 15
  }
}
```

Usage values in `message_delta` are **cumulative**, not per-event increments.

------

## 6.14 `ping`

```text
event: ping
data: {"type":"ping"}
```

Any number of ping events may occur during the stream.

They are auxiliary transport events and do not modify message content.

------

## 6.15 `message_stop`

Successful terminal:

```text
event: message_stop
data: {
  "type": "message_stop"
}
```

Canonical successful lifecycle:

```text
message_start
↓
ContentBlock[index]*
↓
message_delta+
↓
message_stop
```

There is no need for a separate `[DONE]` sentinel to establish Anthropic semantic success; `message_stop` is the protocol terminal that should drive completion.

------

## 6.16 Streaming error

An HTTP connection may already have successfully entered SSE mode and still fail later.

Example:

```text
event: error
data: {
  "type": "error",
  "error": {
    "type": "overloaded_error",
    "message": "Overloaded"
  }
}
```

An overload that might have produced HTTP 529 before streaming starts can therefore appear as an `error` event after HTTP streaming has begun.

Consequently:

```text
HTTP 200
≠
guaranteed successful Message completion
```

------

# 7. Termination and Error Semantics

## 7.1 Outcome hierarchy

```text
Request Outcome
│
├── Valid Message
│   └── stop_reason
│
└── Failed Request / Stream
    └── Error
```

A stop reason explains why a successfully formed Message stopped.

An API/stream error means processing failed.

These must not be conflated.

------

## 7.2 `stop_reason`

Current documented values:

```text
stop_reason
├── end_turn
├── max_tokens
├── stop_sequence
├── tool_use
├── pause_turn
├── refusal
└── model_context_window_exceeded
```

Semantics:

| Value                           | Meaning                                            |
| ------------------------------- | -------------------------------------------------- |
| `end_turn`                      | natural assistant completion                       |
| `max_tokens`                    | output limit reached                               |
| `stop_sequence`                 | configured sequence matched                        |
| `tool_use`                      | tool invocation requires handling/continuation     |
| `pause_turn`                    | server-side tool loop paused                       |
| `refusal`                       | model returned a policy refusal as a valid Message |
| `model_context_window_exceeded` | context-window limit stopped generation            |

Because Anthropic can extend enums over time, consumers should preserve unknown future stop reasons rather than converting every unknown value into an arbitrary known reason.

------

## 7.3 `stop_sequence`

Type:

```text
string | null
```

When:

```text
stop_reason = "stop_sequence"
```

this contains the matched custom stop sequence.

Otherwise it is normally null.

------

## 7.4 Refusal

A refusal is normally a **valid Message response**, not an HTTP protocol error:

```text
HTTP success
↓
Message
├── stop_reason = "refusal"
└── stop_details?
```

A converter must therefore not automatically map every refusal to a transport failure.

------

## 7.5 HTTP error response

Standard shape:

```text
ErrorResponse
├── type = "error"
├── error
│   ├── type
│   └── message
└── request_id
```

Example:

```json
{
  "type": "error",
  "error": {
    "type": "not_found_error",
    "message": "The requested resource could not be found."
  },
  "request_id": "req_..."
}
```

Anthropic returns a `request-id` response header as well, and errors expose the corresponding ID in the JSON response body. Error types can expand over time.

------

## 7.6 Common HTTP error categories

Current documented categories include:

```text
400 → invalid_request_error
401 → authentication_error
402 → billing_error
403 → permission_error
404 → not_found_error
429 → rate_limit_error
5xx → server / timeout / overload families
```

The exact set is extensible. Match structured error type/status rather than message prose.

------

## 7.7 Streaming terminal rule

For direct protocol handling:

```text
SUCCESS
└── message_stop

FAILURE
├── error event
├── malformed known event
├── transport/read failure
└── premature EOF before message_stop
```

The last case is an implementation consequence of the documented lifecycle: because successful streams terminate with `message_stop`, physical EOF before that event must not silently fabricate semantic success.

------

# 8. Protocol Invariants

## 8.1 Conversation-order invariant

```text
messages[]
```

is ordered conversation state.

Conversion must preserve semantically meaningful turn ordering.

Do not sort, regroup, or move messages merely for implementation convenience.

------

## 8.2 Content-order invariant

```text
Message.content[]
```

is an ordered sequence of content blocks.

For streaming:

```text
content block index
=
final Message.content[] index
```

A converter therefore must not casually reorder text, thinking, and tool blocks.

------

## 8.3 Tool-identity invariant

```text
tool_use.id
=
tool_result.tool_use_id
```

The ID must remain stable across conversion and round-trip.

------

## 8.4 Tool-result placement invariant

For client tools:

```text
assistant(tool_use)
↓ immediately
user(tool_result)
```

and inside that user message:

```text
tool_result*
↓
ordinary text*
```

------

## 8.5 Partial-tool-input invariant

```text
input_json_delta.partial_json
```

is incomplete syntax.

```text
tool_use.input
```

is the completed structured input object.

They are different lifecycle states and must not share one “completed tool call” representation.

------

## 8.6 Thinking-preservation invariant

Thinking signatures and redacted-thinking data are opaque.

When returned as conversation history, preserve them rather than generating replacement values.

For omitted thinking:

```text
ThinkingBlock {
  thinking: "",
  signature: opaque
}
```

must remain distinct from:

```text
RedactedThinkingBlock {
  data: opaque
}
```

------

## 8.7 Block lifecycle invariant

Normal streamed content:

```text
content_block_start
↓
content_block_delta*
↓
content_block_stop
```

A delta belongs to exactly the block identified by its `index`.

------

## 8.8 Message lifecycle invariant

Normal successful stream:

```text
message_start
↓
ContentBlock Lifecycle*
↓
message_delta+
↓
message_stop
```

`ping` is auxiliary.

`error` is failure.

------

## 8.9 Usage invariant

`message_delta.usage` is cumulative.

Do not sum repeated `message_delta` usage values as though each were an incremental delta.

Likewise:

```text
thinking_tokens ⊆ output_tokens
```

when `output_tokens_details.thinking_tokens` is present.

------

## 8.10 Unknown-vs-malformed invariant

Consumers should distinguish:

```text
unknown future type
```

from:

```text
known type with invalid/missing required fields
```

A sensible forward-compatible policy is:

```text
unknown event/block variant
→ preserve or safely ignore according to boundary

malformed known event/block
→ protocol error
```

Anthropic explicitly documents that new event types may be introduced.

------

## 8.11 Protocol vs model-support invariant

A field can be part of the Messages wire schema without every model supporting it.

Examples include:

```text
thinking
output_config.effort
temperature
top_p
top_k
mid-conversation system messages
```

A protocol parser and a model-capability validator are therefore different responsibilities.

------

# Appendix A. Model-Dependent Features

This appendix intentionally contains information that may change as Anthropic models evolve.

It should not redefine the stable wire structures above.

------

## A.1 Thinking modes

Structurally, the protocol currently has:

```text
thinking
├── adaptive
├── enabled + budget_tokens
└── disabled
```

But availability differs by model. Current Anthropic guidance favors adaptive thinking on newer models, while older thinking-capable models may still require manual `enabled + budget_tokens`. Some newer models reject manual thinking entirely.

Therefore LuckyToken should represent:

```text
ThinkingConfig
```

separately from:

```text
ModelThinkingCapability
```

rather than baking a current model matrix into the protocol type itself.

------

## A.2 Thinking display

Where supported:

```text
display
├── summarized
└── omitted
```

The default differs by model.

The protocol-level invariant is only:

```text
summarized
→ thinking block may contain readable summary

omitted
→ thinking block remains present when thinking occurs
→ thinking = ""
→ signature retained
```

------

## A.3 Mid-conversation system messages

Anthropic now supports a model-dependent extension in which `messages[]` may contain:

```json
{
  "role": "system",
  "content": "..."
}
```

This allows system-level instructions to be introduced later in a conversation without modifying the stable top-level system prefix. It is currently available only on a subset of models, so it should be treated as an **extension capability**, not as a universally valid core role.

Conceptually:

```text
Core Message Role
├── user
└── assistant

Model-Dependent Extension
└── system
```

Placement is constrained. Current rules require the mid-conversation system message to occur at specific turn boundaries and forbid inserting it between a client `tool_use` and its corresponding `tool_result`.

This distinction is particularly important for protocol conversion: a converter must not automatically downgrade a mid-conversation system message to ordinary user text without explicitly defining that lossy behavior.

------

## A.4 Effort

Current structural values:

```text
low
medium
high
xhigh
max
```

Different models support different subsets.

The general API default for effort-capable models is currently `high`. `xhigh` is newer and is not available on every model that supports `max`.

Again:

```text
wire enum
≠
model capability
```

------

## A.5 Sampling controls

Fields:

```text
temperature
top_p
top_k
```

still exist in the broader Messages request schema, but newer model families may reject non-default values.

Do not encode:

```text
"temperature always supported"
```

as a protocol invariant.

------

# Appendix B. Protocol Extensions

## B.1 Server tools

Anthropic distinguishes:

```text
Client Tools
→ application executes
→ tool_use / tool_result loop

Server Tools
→ Anthropic executes
→ server-tool-specific blocks
```

Server tools include independently versioned tool protocols such as web search, web fetch, and code execution.

These extensions should not be flattened into the core client-tool contract.

------

## B.2 Extension block policy

A protocol implementation should conceptually model:

```text
ContentBlock
├── Known Core Block
├── Known Extension Block
└── Unknown Future Block
```

Likewise for SSE:

```text
StreamEvent
├── Known Core Event
├── Known Extension Event
└── Unknown Future Event
```

This avoids a common mistake where adding a new Anthropic tool or content block forces a redesign of the core protocol representation.

------

# Appendix C. Canonical Protocol Trees

## C.1 Request

```text
MessageRequest
│
├── model
├── max_tokens
│
├── Conversation
│   ├── system?
│   └── messages[]
│       ├── UserMessage
│       │   └── content[]
│       │       ├── text
│       │       ├── image
│       │       ├── document
│       │       ├── search_result
│       │       └── tool_result
│       │
│       └── AssistantMessage
│           └── content[]
│               ├── text
│               ├── thinking
│               ├── redacted_thinking
│               └── tool_use
│
├── Tools
│   ├── tools[]
│   └── tool_choice?
│
├── Thinking
│   └── thinking?
│
├── Output / Generation
│   ├── output_config?
│   ├── stop_sequences?
│   ├── temperature?
│   ├── top_p?
│   └── top_k?
│
└── Runtime
    ├── stream?
    ├── cache_control?
    ├── container?
    ├── inference_geo?
    ├── service_tier?
    └── metadata?
```

------

## C.2 Non-streaming response

```text
Message
│
├── Identity
│   ├── id
│   ├── type = "message"
│   ├── role = "assistant"
│   └── model
│
├── content[]
│   ├── text
│   ├── thinking
│   ├── redacted_thinking
│   ├── tool_use
│   └── extensions
│
├── Termination
│   ├── stop_reason
│   ├── stop_sequence
│   └── stop_details?
│
├── usage
│
└── runtime fields?
```

------

## C.3 Streaming response

```text
Anthropic SSE Stream
│
├── message_start
│
├── ContentBlock[index]*
│   │
│   ├── content_block_start
│   │
│   ├── content_block_delta*
│   │   ├── text_delta
│   │   ├── input_json_delta
│   │   ├── thinking_delta
│   │   ├── signature_delta
│   │   ├── citations_delta
│   │   └── future delta
│   │
│   └── content_block_stop
│
├── message_delta+
│
└── message_stop

Auxiliary
└── ping*

Failure
└── error
```

------

# Appendix D. Boundary for LuckyToken

This document answers:

```text
What can an Anthropic Messages request contain?

What does an Anthropic Message response contain?

How are content blocks structured?

How does tool identity work?

How does the SSE state machine work?

What constitutes successful termination?

Which data is complete vs incremental?

Which protocol elements are extensible?
```

It deliberately does **not** answer:

```text
Anthropic → Pi
Pi → Anthropic

Anthropic → CommandCode
CommandCode → Anthropic
```

Those are conversion contracts.

The intended separation is:

```text
Anthropic Protocol Spec
└── describes Anthropic wire semantics

Conversion Spec
└── defines semantic mappings and loss

Architecture Spec
└── defines which LuckyToken module owns the conversion
```

This separation allows the Anthropic protocol document to remain stable even when LuckyToken changes its internal architecture or conversion strategy.