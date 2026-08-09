# Anthropic Messages API Protocol Specification

**Protocol:** Anthropic Messages API
**Endpoint:** `POST /v1/messages`
**Transport:** HTTP + JSON / Server-Sent Events (SSE)
**API Version Header:** `anthropic-version`
**Scope:** Core Messages protocol, including text, images, documents, client tools, thinking, non-streaming responses, streaming responses, usage, termination, and errors.

This specification describes the Anthropic protocol itself. Provider-specific cloud adaptations and individual server-tool protocols are outside the core schema and are treated as protocol extensions.

Anthropic's versioning policy permits new optional request fields, response fields, enum variants, content block types, and streaming event types to be added over time. Implementations should therefore treat appropriate tagged unions as extensible.

------

# 1. Protocol Overview

The Messages API has one request model and two response representations:

```text
Anthropic Messages API
│
├── Request
│   ├── HTTP Headers
│   └── MessageRequest
│
└── Response
    │
    ├── Non-Streaming
    │   └── Message
    │
    └── Streaming
        └── Message SSE Lifecycle
```

The API is stateless at the Messages level: a request supplies the conversation state required for the next assistant turn. Input conversation history is carried in `messages[]`, while the generated output is an assistant `Message`.

------

# 2. HTTP Layer

## 2.1 Request Structure

```text
HTTP Request
│
├── Method
│   └── POST
│
├── Path
│   └── /v1/messages
│
├── Headers
│   ├── Authentication
│   │   ├── x-api-key
│   │   └── OR Authorization: Bearer <token>
│   │
│   ├── anthropic-version
│   └── content-type: application/json
│
└── Body
    └── MessageRequest
```

For the direct Claude API, one of `x-api-key` or `Authorization` is required, along with `anthropic-version` and `content-type: application/json`.

Example:

```http
POST /v1/messages
content-type: application/json
x-api-key: <api-key>
anthropic-version: 2023-06-01
```

------

## 2.2 Versioning

```text
Protocol Version
└── anthropic-version
    └── e.g. 2023-06-01
```

The current SSE format uses named events and does not use the old `data: [DONE]` terminator. Successful streaming completion is represented by `message_stop`.

------

# 3. Request Protocol

## 3.1 MessageRequest Tree

```text
MessageRequest
│
├── Required Core
│   ├── model
│   ├── max_tokens
│   └── messages[]
│
├── Conversation Configuration
│   └── system?
│
├── Tool Configuration
│   ├── tools[]?
│   └── tool_choice?
│
├── Thinking Configuration
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
├── Cache Configuration
│   └── cache_control?
│
├── Runtime / Infrastructure
│   ├── container?
│   ├── inference_geo?
│   └── service_tier?
│
└── Metadata
    └── metadata?
        └── user_id?
```

`model`, `max_tokens`, and `messages` are required. The remaining fields modify conversation behavior, tools, reasoning, output, transport, caching, or request execution.

------

## 3.2 Core Request Fields

### 3.2.1 Model

```text
model
└── string / supported model identifier
```

Example:

```json
{
  "model": "claude-opus-5"
}
```

------

### 3.2.2 Maximum Output Tokens

```text
max_tokens
└── integer >= 0
```

`max_tokens` is the absolute maximum number of tokens the model may generate. The model may stop earlier. The current API also allows `0` for prompt-cache population without normal output generation.

------

## 3.3 Conversation Tree

```text
Conversation
│
├── system?
│
└── messages[]
    │
    ├── UserMessage
    │
    └── AssistantMessage
```

The normal Messages conversation uses `user` and `assistant` turns. The system prompt is supplied separately through the top-level `system` parameter rather than as an ordinary system-role message.

------

## 3.4 System Prompt

```text
system
│
├── string
│
└── TextBlock[]
```

Simple form:

```json
{
  "system": "You are a helpful assistant."
}
```

Structured form:

```json
{
  "system": [
    {
      "type": "text",
      "text": "You are a helpful assistant."
    }
  ]
}
```

------

## 3.5 Message Tree

```text
Message
│
├── role
│   ├── user
│   └── assistant
│
└── content
    │
    ├── string
    │
    └── ContentBlock[]
```

A string content value is shorthand for a single text block.

These are semantically equivalent:

```json
{
  "role": "user",
  "content": "Hello"
}
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

Consecutive turns with the same role may be combined by the API.

------

# 4. Content Block Hierarchy

## 4.1 Core Content Tree

```text
ContentBlock
│
├── Text
│   └── TextBlock
│
├── Media / Source Content
│   ├── ImageBlock
│   ├── DocumentBlock
│   └── SearchResultBlock
│
├── Thinking
│   ├── ThinkingBlock
│   └── RedactedThinkingBlock
│
├── Client Tool Protocol
│   ├── ToolUseBlock
│   └── ToolResultBlock
│
└── Protocol Extensions
    ├── Server-tool blocks
    ├── Code-execution blocks
    ├── Search/tool-reference blocks
    ├── Container-related blocks
    └── Future versioned content blocks
```

Anthropic exposes content as a tagged union. The exact set is extensible and contains additional server-tool-specific block types beyond the client-tool core described below.

------

## 4.2 Parent / Content Relationship

At the core client-protocol level:

```text
UserMessage
└── content[]
    ├── TextBlock
    ├── ImageBlock
    ├── DocumentBlock
    ├── SearchResultBlock
    ├── ToolResultBlock
    └── supported extension blocks
AssistantMessage
└── content[]
    ├── TextBlock
    ├── ThinkingBlock
    ├── RedactedThinkingBlock
    ├── ToolUseBlock
    └── supported extension blocks
```

Tool results are represented inside a **user message**. Client tool calls are represented inside an **assistant message**.

------

# 5. Text Content

## 5.1 TextBlock Tree

```text
TextBlock
│
├── type = "text"
├── text
├── citations?
└── cache_control?
```

Basic form:

```json
{
  "type": "text",
  "text": "Hello"
}
```

------

# 6. Image Content

## 6.1 ImageBlock Tree

```text
ImageBlock
│
├── type = "image"
│
├── source
│   │
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

The stable API reference currently lists base64 and URL image sources.

------

## 6.2 Base64 Image

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

Current MIME variants include:

```text
image/jpeg
image/png
image/gif
image/webp
```

------

## 6.3 URL Image

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

# 7. Document and Search Content

## 7.1 DocumentBlock Tree

```text
DocumentBlock
│
├── type = "document"
├── source
├── title?
├── context?
├── citations?
└── cache_control?
```

The document source is itself a tagged union supporting document representations defined by the API.

------

## 7.2 SearchResultBlock Tree

```text
SearchResultBlock
│
├── type = "search_result"
├── source
├── title
├── content[]
├── citations?
└── cache_control?
```

Search-result content participates in the broader content-block and citation system.

------

# 8. Client Tool Protocol

## 8.1 Tool Protocol Hierarchy

Tool use is not a single object. It is a cross-turn protocol:

```text
Tool Protocol
│
├── Definition
│   └── Request.tools[]
│
├── Invocation
│   └── AssistantMessage
│       └── ToolUseBlock
│
├── External Execution
│
└── Result
    └── UserMessage
        └── ToolResultBlock
```

The application defines the tools; Claude emits tool calls; the application executes them and returns results.

------

## 8.2 Client Tool Definition Tree

```text
tools[]
└── ClientTool
    │
    ├── Identity
    │   ├── name
    │   └── type? = "custom"
    │
    ├── Description
    │   └── description?
    │
    ├── Input Contract
    │   └── input_schema
    │       └── JSON Schema
    │
    └── Optional Controls
        ├── strict?
        ├── input_examples?
        ├── eager_input_streaming?
        ├── defer_loading?
        ├── cache_control?
        └── allowed_callers?
```

`name`, `description`, and `input_schema` form the core user-defined tool contract. Anthropic also supports optional controls such as strict schema enforcement, deferred loading, input examples, caching, caller restrictions, and eager input streaming.

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
    "required": ["location"]
  }
}
```

------

## 8.3 Tool Choice Tree

```text
tool_choice
│
├── auto
│   └── disable_parallel_tool_use?
│
├── any
│   └── disable_parallel_tool_use?
│
├── tool
│   ├── name
│   └── disable_parallel_tool_use?
│
└── none
```

The tool-choice mechanism controls whether Claude may choose tools automatically, must use a tool, must use a specific tool, or must not use tools.

------

## 8.4 ToolUseBlock Tree

```text
ToolUseBlock
│
├── type = "tool_use"
├── id
├── name
├── input
│   └── object
└── caller? / extension metadata?
```

Example:

```json
{
  "type": "tool_use",
  "id": "toolu_01...",
  "name": "get_weather",
  "input": {
    "location": "San Francisco"
  }
}
```

For client tools, Claude returns one or more `tool_use` blocks and normally ends the turn with `stop_reason: "tool_use"`.

------

## 8.5 ToolResultBlock Tree

```text
ToolResultBlock
│
├── type = "tool_result"
├── tool_use_id
├── content?
│   │
│   ├── string
│   │
│   └── ResultContentBlock[]
│       ├── TextBlock
│       ├── ImageBlock
│       ├── SearchResultBlock
│       └── other supported result blocks
│
├── is_error?
└── cache_control?
```

Example:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01...",
  "content": "72°F and sunny",
  "is_error": false
}
```

The stable API permits a string or supported structured blocks as tool-result content.

------

## 8.6 Tool Identity Invariant

```text
AssistantMessage
└── ToolUseBlock
    └── id = "toolu_01"
             │
             ▼
UserMessage
└── ToolResultBlock
    └── tool_use_id = "toolu_01"
```

Therefore:

```text
tool_use.id
=
tool_result.tool_use_id
```

identifies one tool invocation across turns.

------

## 8.7 Tool Turn Lifecycle

```text
USER
│
└── request
     │
     ▼
ASSISTANT
│
├── optional content
└── tool_use[]
     │
     ▼
APPLICATION EXECUTES TOOLS
     │
     ▼
USER
│
└── tool_result[]
     │
     ▼
ASSISTANT
└── continuation
```

A `tool_result` for a client tool must follow the assistant turn containing the corresponding `tool_use`. Tool-result blocks must precede ordinary text in the user message that returns those results.

------

# 9. Thinking Protocol

## 9.1 Thinking Configuration Tree

Thinking support is model-dependent.

The current protocol families are:

```text
thinking
│
├── disabled
│   └── type = "disabled"
│
├── adaptive
│   ├── type = "adaptive"
│   └── display?
│       ├── summarized
│       └── omitted
│
└── manual extended thinking
    ├── type = "enabled"
    ├── budget_tokens
    └── display?
        ├── summarized
        └── omitted
```

Adaptive thinking is the preferred/current mode on supported newer models. Manual `type: "enabled"` with `budget_tokens` remains required for older thinking-capable models, is deprecated on Claude 4.6, and is rejected by later models that only support adaptive thinking.

------

## 9.2 Thinking Response Tree

```text
Thinking Output
│
├── ThinkingBlock
│   ├── type = "thinking"
│   ├── thinking
│   └── signature
│
└── RedactedThinkingBlock
    ├── type = "redacted_thinking"
    └── data
```

These are distinct content-block types.

------

## 9.3 ThinkingBlock

```text
ThinkingBlock
│
├── type = "thinking"
│
├── Visible / Returned Thinking
│   └── thinking
│
└── Opaque Continuity Data
    └── signature
```

Example shape:

```json
{
  "type": "thinking",
  "thinking": "...",
  "signature": "..."
}
```

The signature is opaque and must not be interpreted.

------

## 9.4 Omitted Thinking

When:

```text
thinking.display = "omitted"
```

the response still uses a normal `thinking` block:

```text
ThinkingBlock
│
├── type = "thinking"
├── thinking = ""
└── signature = <opaque signature>
```

It does **not** become a `redacted_thinking` block.

------

## 9.5 RedactedThinkingBlock

```text
RedactedThinkingBlock
│
├── type = "redacted_thinking"
└── data
    └── opaque encrypted value
```

Example:

```json
{
  "type": "redacted_thinking",
  "data": "..."
}
```

This is a distinct protocol object from normal thinking with `display: "omitted"`.

------

## 9.6 Thinking Round-Trip

```text
Assistant Response
│
├── ThinkingBlock
└── RedactedThinkingBlock
         │
         ▼
Conversation History
         │
         ▼
Next Request
```

When thinking blocks are returned in a subsequent request, Anthropic recommends preserving them exactly as received. In tool-use workflows, preserving relevant thinking blocks is particularly important for continuity.

------

# 10. Generation and Output Configuration

## 10.1 Generation Controls Tree

```text
Generation Configuration
│
├── Output Limit
│   └── max_tokens
│
├── Thinking
│   └── thinking?
│
├── Output Configuration
│   └── output_config?
│       ├── effort?
│       └── format?
│
├── Sampling
│   ├── temperature?
│   ├── top_p?
│   └── top_k?
│
└── Termination
    └── stop_sequences?
```

------

## 10.2 Effort

Current effort levels are:

```text
output_config
└── effort
    ├── low
    ├── medium
    ├── high
    ├── xhigh
    └── max
```

Support varies by model. `high` is the API default for models supporting effort; `xhigh` is not supported by every effort-capable model.

------

## 10.3 Sampling Controls

Legacy/model-dependent controls include:

```text
temperature
top_p
top_k
```

Their support is model-dependent. In particular, `temperature` is deprecated and newer models restrict non-default values.

------

## 10.4 Stop Sequences

```text
stop_sequences
└── string[]
```

If Claude emits one of these sequences:

```text
stop_reason = "stop_sequence"
stop_sequence = <matched value>
```

------

# 11. Runtime Request Controls

## 11.1 Runtime Tree

```text
Runtime Controls
│
├── stream?
│
├── service_tier?
│
├── inference_geo?
├── container?
├── cache_control?
└── metadata?
```

------

## 11.2 Streaming Selection

```text
stream
│
├── false / omitted
│   └── Message JSON
│
└── true
    └── SSE Event Stream
```

------

## 11.3 Service Tier

Request:

```text
service_tier
├── auto
└── standard_only
```

`auto` may use Priority Tier capacity when available; `standard_only` restricts execution to standard capacity.

The actual tier used is reported separately in response usage and may be:

```text
standard
priority
batch
```

------

# 12. Non-Streaming Response Protocol

## 12.1 Message Tree

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
│       ├── TextBlock
│       ├── ThinkingBlock
│       ├── RedactedThinkingBlock
│       ├── ToolUseBlock
│       └── extension blocks
│
├── Termination
│   ├── stop_reason
│   ├── stop_sequence
│   └── stop_details?
│
├── Usage
│   └── Usage
│
└── Optional Runtime State
    ├── container?
    └── other versioned response fields
```

A successful non-streaming request returns one complete assistant `Message`.

------

## 12.2 Example

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
    "output_tokens": 5,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

------

# 13. Response Termination

## 13.1 StopReason Tree

Current documented successful-message stop reasons are:

```text
stop_reason
│
├── end_turn
│   └── natural completion
│
├── max_tokens
│   └── output token limit reached
│
├── stop_sequence
│   └── custom stop sequence matched
│
├── tool_use
│   └── client/server tool invocation
│
├── pause_turn
│   └── server-side tool loop paused
│
├── refusal
│   └── request declined through normal Message response
│
└── model_context_window_exceeded
    └── model context-window limit reached
```

These values describe **why a valid Message stopped**. They are not equivalent to transport/API errors.

------

## 13.2 Stop Sequence

```text
Termination
├── stop_reason = "stop_sequence"
└── stop_sequence = <matched string>
```

For other stop reasons, `stop_sequence` is normally null.

------

## 13.3 Refusal

A refusal is a successful Messages API response, normally HTTP 200, with:

```text
Message
├── stop_reason = "refusal"
└── stop_details
    └── structured refusal information
```

It is not an HTTP protocol error.

------

# 14. Usage Protocol

## 14.1 Usage Tree

```text
Usage
│
├── Input Tokens
│   ├── input_tokens
│   ├── cache_creation_input_tokens
│   └── cache_read_input_tokens
│
├── Cache Creation Breakdown?
│   └── cache_creation
│       ├── ephemeral_5m_input_tokens
│       └── ephemeral_1h_input_tokens
│
├── Output Tokens
│   ├── output_tokens
│   └── output_tokens_details?
│       └── thinking_tokens
│
├── Server Tool Usage?
│   └── server_tool_use
│       ├── web_search_requests
│       └── web_fetch_requests
│
├── Execution Metadata?
│   ├── service_tier
│   └── inference_geo
│
└── Future Versioned Usage Fields
```

Anthropic defines total request input usage as the sum of normal input, cache-creation input, and cache-read input tokens.

------

## 14.2 Thinking Tokens

```text
output_tokens_details
└── thinking_tokens
```

`thinking_tokens` is a breakdown of `output_tokens`; it is not an additional amount to add to `output_tokens`.

------

# 15. Streaming Response Protocol

## 15.1 Top-Level Stream Tree

```text
Anthropic SSE Stream
│
├── Message Lifecycle
│   │
│   ├── message_start
│   │
│   ├── ContentBlock Lifecycle*
│   │
│   ├── message_delta+
│   │
│   └── message_stop
│
├── Auxiliary Events
│   └── ping*
│
└── Failure
    └── error
```

This is the official high-level Messages streaming sequence.

------

## 15.2 Message State Machine

```text
NOT_STARTED
     │
     │ message_start
     ▼
RUNNING
     │
     ├── ContentBlock Lifecycle*
     ├── message_delta+
     ├── ping*
     │
     ├── message_stop
     │        ▼
     │     COMPLETE
     │
     └── error
              ▼
            FAILED
```

------

## 15.3 SSE Frame

Every event uses a named SSE event plus matching JSON data:

```text
event: <event-name>
data: <json>
```

The JSON object contains its own `type` discriminator.

------

# 16. Message Start

## 16.1 Event Tree

```text
message_start
└── message
    │
    ├── Identity
    │   ├── id
    │   ├── type = "message"
    │   ├── role = "assistant"
    │   └── model
    │
    ├── content = []
    │
    ├── Termination
    │   ├── stop_reason = null
    │   └── stop_sequence = null
    │
    └── Initial Usage
```

Example:

```text
event: message_start
data: {
  "type": "message_start",
  "message": {
    "id": "msg_...",
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

------

# 17. Content Block Streaming

## 17.1 Generic Content Block Lifecycle

```text
ContentBlock[index]
│
├── Start
│   └── content_block_start
│
├── Updates
│   └── content_block_delta*
│
└── End
    └── content_block_stop
```

State machine:

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

The `index` corresponds to the block's position in the final `Message.content[]`.

Most content blocks follow this lifecycle. A documented exception is a server-side fallback block, which may have `content_block_start` followed directly by `content_block_stop` with no delta.

------

## 17.2 Content Block Start Tree

```text
content_block_start
│
├── index
│
└── content_block
    ├── TextBlock
    ├── ThinkingBlock
    ├── ToolUseBlock
    └── other supported response blocks
```

Text example:

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

------

# 18. Content Delta Protocol

## 18.1 Delta Tree

```text
content_block_delta
│
├── index
│
└── delta
    │
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
    │
    └── Future Extension Delta
```

The current official streaming protocol explicitly defines text, tool-input JSON, thinking, and signature deltas and may add new delta/event variants over time.

------

# 19. Text Streaming

## 19.1 Text Lifecycle

```text
TextBlock[index]
│
├── content_block_start
│   └── TextBlock
│       ├── type = "text"
│       └── text = ""
│
├── content_block_delta*
│   └── TextDelta
│       ├── type = "text_delta"
│       └── text
│
└── content_block_stop
```

State:

```text
NONE
↓ content_block_start(text)
TEXT_OPEN
↓ text_delta*
TEXT_OPEN
↓ content_block_stop
TEXT_COMPLETE
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

------

# 20. Tool Input Streaming

## 20.1 ToolUse Streaming Tree

```text
ToolUseBlock[index]
│
├── content_block_start
│   └── ToolUseBlock
│       ├── id
│       ├── name
│       └── input = {}
│
├── content_block_delta*
│   └── InputJSONDelta
│       ├── type = "input_json_delta"
│       └── partial_json
│
└── content_block_stop
        │
        ▼
   Completed ToolUseBlock
        │
        └── input = object
```

Anthropic streams tool arguments as **partial JSON strings**, while the completed `tool_use.input` is an object.

------

## 20.2 Tool Input Lifecycle

```text
content_block_start(tool_use)
        │
        ▼
tool identity known
input initially {}
        │
        ▼
input_json_delta
partial_json = fragment
        │
        ▼
input_json_delta*
        │
        ▼
content_block_stop
        │
        ▼
complete JSON input object
```

Core semantic distinction:

```text
input_json_delta.partial_json
≠
tool_use.input
```

The former is incremental syntax; the latter is completed structured input.

------

# 21. Thinking Streaming

## 21.1 Thinking Lifecycle

```text
ThinkingBlock[index]
│
├── content_block_start
│   └── ThinkingBlock
│
├── Thinking Updates
│   └── thinking_delta*
│
├── Signature
│   └── signature_delta
│
└── content_block_stop
```

Normal state:

```text
NONE
↓ content_block_start(thinking)
THINKING_OPEN
↓ thinking_delta*
THINKING_OPEN
↓ signature_delta
THINKING_OPEN
↓ content_block_stop
THINKING_COMPLETE
```

Anthropic sends a `signature_delta` shortly before the thinking block closes.

------

## 21.2 Thinking Delta

```text
content_block_delta
└── delta
    ├── type = "thinking_delta"
    └── thinking
```

Example:

```text
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "thinking_delta",
    "thinking": "I need to reason about..."
  }
}
```

------

## 21.3 Signature Delta

```text
content_block_delta
└── delta
    ├── type = "signature_delta"
    └── signature
```

The signature is opaque protocol data used for thinking integrity and continuation.

------

## 21.4 Omitted Thinking Streaming

With:

```text
thinking.display = "omitted"
```

the lifecycle becomes:

```text
ThinkingBlock[index]
│
├── content_block_start
│   └── {
│         type: "thinking",
│         thinking: "",
│         signature: ""
│       }
│
├── signature_delta
│
└── content_block_stop
```

No `thinking_delta` events are emitted.

------

# 22. Content Block Stop

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

It terminates construction of the corresponding `Message.content[index]`.

------

# 23. Message-Level Delta

## 23.1 MessageDelta Tree

```text
message_delta
│
├── delta
│   ├── stop_reason
│   ├── stop_sequence
│   ├── stop_details?
│   ├── container?
│   └── other top-level changes
│
└── usage
    └── cumulative usage update
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

Usage values in `message_delta` are cumulative rather than per-event deltas.

------

# 24. Successful Stream Terminal

## 24.1 Message Stop

```text
message_stop
└── type = "message_stop"
```

Wire form:

```text
event: message_stop
data: {
  "type": "message_stop"
}
```

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

------

# 25. Auxiliary Streaming Events

## 25.1 Ping

```text
Auxiliary Event
└── ping
    └── type = "ping"
```

Wire:

```text
event: ping
data: {"type":"ping"}
```

Any number of ping events may occur. They do not represent content or change the semantic message state.

------

# 26. Error Protocol

## 26.1 Error Hierarchy

There are two distinct failure paths:

```text
Failure
│
├── HTTP Error
│   └── ErrorResponse
│
└── Streaming Error
    └── SSE error event
```

------

## 26.2 HTTP Error

```text
HTTP Error
│
├── HTTP status
│
└── ErrorResponse
    ├── type = "error"
    ├── error
    │   ├── type
    │   └── message
    └── request_id
```

Typical API error categories include invalid request, authentication, permission, billing, rate limit, server, timeout, and overloaded failures.

------

## 26.3 SSE Error

After an SSE response has already started, an error can arrive as:

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

For example, a condition corresponding to HTTP 529 in a non-streaming request may appear as an `overloaded_error` within an already-established stream.

------

# 27. Stop Reason vs Error

These are different protocol branches:

```text
Request Outcome
│
├── Valid Message
│   └── stop_reason
│       ├── end_turn
│       ├── max_tokens
│       ├── stop_sequence
│       ├── tool_use
│       ├── pause_turn
│       ├── refusal
│       └── model_context_window_exceeded
│
└── Failed Request / Stream
    └── Error
```

A `tool_use`, `refusal`, or truncated Message is still a valid Message response.

An HTTP/SSE error indicates that request or stream processing failed.

------

# 28. Non-Streaming and Streaming Equivalence

Conceptually, both response modes construct the same `Message`:

```text
                         Message
                       /         \
                      /           \
                     ▼             ▼
              Non-Streaming       Streaming
                  JSON               SSE
                                     │
                                     ▼
                            Reconstructed Message
```

Official SDKs can accumulate the SSE sequence and produce the same complete `Message` object returned by a non-streaming `.create()` call.

The reconstruction hierarchy is:

```text
message_start
│
└── Message shell
     │
     ▼
content_block_start
content_block_delta*
content_block_stop
     │
     ▼
Message.content[]
     │
     ▼
message_delta
     │
     ├── termination
     └── usage
     │
     ▼
message_stop
     │
     ▼
Complete Message
```

------

# 29. Core Protocol Invariants

## 29.1 Conversation Invariants

```text
MessageRequest
├── system
└── messages[]
```

The system prompt is structurally separate from normal conversation turns.

`messages[]` contains ordered conversation history.

------

## 29.2 Content Invariant

```text
Message
└── content[]
```

is an ordered array of typed content blocks.

The block `type` determines the block schema.

------

## 29.3 Tool Identity Invariant

```text
assistant.tool_use.id
=
user.tool_result.tool_use_id
```

The two fields identify the same client tool invocation.

------

## 29.4 Tool Input Lifecycle Invariant

```text
input_json_delta.partial_json
```

is incomplete streaming syntax.

```text
tool_use.input
```

is the completed structured object.

They must not be treated as the same lifecycle state.

------

## 29.5 Thinking Integrity Invariant

```text
ThinkingBlock
├── thinking
└── signature
```

and:

```text
RedactedThinkingBlock
└── data
```

carry opaque continuity/integrity information.

When such blocks are round-tripped, they should be preserved as received rather than reconstructed.

------

## 29.6 Omitted vs Redacted Thinking

```text
display = "omitted"
```

produces:

```text
ThinkingBlock
├── thinking = ""
└── signature
```

It does **not** imply:

```text
RedactedThinkingBlock
```

These are different protocol states.

------

## 29.7 Content Block Streaming Invariant

The standard block lifecycle is:

```text
content_block_start
↓
content_block_delta*
↓
content_block_stop
```

with one explicit `index` referring to the final `Message.content[]` position.

------

## 29.8 Message Streaming Invariant

The standard successful Message lifecycle is:

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

`error` is a failure event.

There is no `[DONE]` event in the current versioned Messages SSE protocol.

------

## 29.9 Forward Compatibility

Consumers should tolerate protocol extension in:

```text
Request
├── new optional parameters

Response
├── new optional fields
├── new content block types
└── new enum variants

SSE
├── new event types
└── new delta types
```

Anthropic explicitly reserves these compatible additions under its API versioning policy.

------

# 30. Complete Request Hierarchy

```text
MessageRequest
│
├── Required Core
│   ├── model
│   ├── max_tokens
│   └── messages[]
│
├── Conversation
│   │
│   ├── system?
│   │
│   └── messages[]
│       │
│       ├── UserMessage
│       │   └── content[]
│       │       ├── TextBlock
│       │       ├── ImageBlock
│       │       ├── DocumentBlock
│       │       ├── SearchResultBlock
│       │       ├── ToolResultBlock
│       │       └── ExtensionBlock
│       │
│       └── AssistantMessage
│           └── content[]
│               ├── TextBlock
│               ├── ThinkingBlock
│               ├── RedactedThinkingBlock
│               ├── ToolUseBlock
│               └── ExtensionBlock
│
├── Tool Configuration
│   ├── tools[]
│   │   └── ToolDefinition
│   │       ├── name
│   │       ├── description
│   │       ├── input_schema
│   │       └── optional controls
│   │
│   └── tool_choice
│
├── Generation Configuration
│   ├── thinking
│   │   ├── disabled
│   │   ├── adaptive
│   │   └── enabled + budget_tokens
│   │
│   ├── output_config
│   │   ├── effort
│   │   └── format
│   │
│   ├── stop_sequences
│   └── model-dependent sampling
│       ├── temperature
│       ├── top_p
│       └── top_k
│
├── Transport
│   └── stream
│
├── Cache
│   └── cache_control
│
├── Runtime
│   ├── container
│   ├── inference_geo
│   └── service_tier
│
└── Metadata
    └── user_id
```

------

# 31. Complete Non-Streaming Response Hierarchy

```text
Message
│
├── Identity
│   ├── id
│   ├── type = "message"
│   ├── role = "assistant"
│   └── model
│
├── Content[]
│   │
│   ├── TextBlock
│   │   ├── text
│   │   └── citations?
│   │
│   ├── ThinkingBlock
│   │   ├── thinking
│   │   └── signature
│   │
│   ├── RedactedThinkingBlock
│   │   └── data
│   │
│   ├── ToolUseBlock
│   │   ├── id
│   │   ├── name
│   │   └── input
│   │
│   └── ExtensionBlock
│
├── Termination
│   ├── stop_reason
│   │   ├── end_turn
│   │   ├── max_tokens
│   │   ├── stop_sequence
│   │   ├── tool_use
│   │   ├── pause_turn
│   │   ├── refusal
│   │   └── model_context_window_exceeded
│   │
│   ├── stop_sequence
│   └── stop_details?
│
├── Usage
│   ├── input_tokens
│   ├── cache_creation_input_tokens
│   ├── cache_read_input_tokens
│   ├── output_tokens
│   ├── cache_creation?
│   ├── output_tokens_details?
│   ├── server_tool_use?
│   ├── service_tier?
│   └── inference_geo?
│
└── Optional Runtime State
    └── container?
```

------

# 32. Complete Streaming Response Hierarchy

```text
Anthropic SSE Stream
│
├── Message Lifecycle
│   │
│   ├── message_start
│   │   └── initial Message
│   │
│   ├── ContentBlock[index]*
│   │   │
│   │   ├── content_block_start
│   │   │   └── initial block
│   │   │
│   │   ├── content_block_delta*
│   │   │   │
│   │   │   ├── TextDelta
│   │   │   │   └── text
│   │   │   │
│   │   │   ├── InputJSONDelta
│   │   │   │   └── partial_json
│   │   │   │
│   │   │   ├── ThinkingDelta
│   │   │   │   └── thinking
│   │   │   │
│   │   │   ├── SignatureDelta
│   │   │   │   └── signature
│   │   │   │
│   │   │   ├── CitationsDelta
│   │   │   └── FutureDelta
│   │   │
│   │   └── content_block_stop
│   │
│   ├── message_delta+
│   │   ├── termination updates
│   │   └── cumulative usage
│   │
│   └── message_stop
│
├── Auxiliary
│   └── ping*
│
└── Failure
    └── error
```

------

# 33. Canonical Mental Model

The Anthropic Messages protocol can be reduced to three hierarchical trees:

```text
                         REQUEST

                    MessageRequest
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
   Conversation       Generation          Tools
        │             Configuration         │
   ┌────┴────┐             │          ┌─────┴─────┐
 system   messages        thinking    definitions
             │            output      tool_choice
        ┌────┴────┐       controls
        │         │
      user     assistant
        │         │
        ▼         ▼
     Content[] Content[]


                    NON-STREAM RESPONSE

                         Message
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
     Identity           Content[]        Termination
                                              │
                                            Usage


                     STREAM RESPONSE

                  Message SSE Lifecycle
                           │
                     message_start
                           │
                  ContentBlock[index]*
                           │
             ┌─────────────┼─────────────┐
             │             │             │
            text        thinking         tool
             │             │             │
             └─────────────┼─────────────┘
                           │
                     message_delta
                           │
                     message_stop

                 Auxiliary: ping
                 Failure:   error
```

These trees together define the core structure and lifecycle of the Anthropic Messages API.