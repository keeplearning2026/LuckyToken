# Anthropic Messages API Protocol Specification

**Protocol:** Anthropic Messages API
**Primary Endpoint:** `POST /v1/messages`
**Transport:** HTTP + JSON / Server-Sent Events (SSE)
**Reference Date:** 2026-08-09

本文描述 Anthropic Messages API 的实际 wire protocol、数据结构、字段语义、stream lifecycle 与 protocol invariants。

主要依据：

- Anthropic 官方 Messages API Reference；
- Anthropic 官方 Streaming Messages 文档；
- Anthropic 官方 Tool Use 文档；
- Anthropic 官方 Thinking / Effort 文档；
- Anthropic 官方 API Versioning / Error 文档；
- Anthropic 官方 SDK 中由 OpenAPI schema 自动生成的类型定义。

本文只回答：

```text
Anthropic request 长什么样？

每个字段是什么意思？

哪些字段是 literal？
哪些字段由 client 提供？
哪些字段由 server 生成？
哪些字段 optional / nullable / model-dependent？

Message / Content Block 如何组织？

Tool Use 如何建立跨 turn identity？

Streaming event 如何组成完整 Message？

什么事件意味着成功？
什么情况意味着失败？

哪些结构是 stable core？
哪些是 model-dependent / extension？
```

本文不描述任何其他协议。

------

# 1. Protocol Overview

## 1.1 Endpoint

Anthropic Messages API 的主要 inference endpoint：

```http
POST /v1/messages
```

Direct Claude API 默认 host：

```text
https://api.anthropic.com
```

因此完整 endpoint：

```text
https://api.anthropic.com/v1/messages
```

Messages API 是 stateless request protocol：每次请求通过 `messages` 提供需要的 conversation history，由 server 生成下一条 assistant `Message`。

------

## 1.2 Top-Level Protocol Hierarchy

```text
Anthropic Messages API
│
├── HTTP Request
│   │
│   ├── Headers
│   │
│   └── MessageRequest
│       │
│       ├── Model / Output Limit
│       │   ├── model
│       │   └── max_tokens
│       │
│       ├── Conversation
│       │   ├── system?
│       │   └── messages[]
│       │       └── content[]
│       │
│       ├── Tools
│       │   ├── tools[]?
│       │   └── tool_choice?
│       │
│       ├── Thinking
│       │   └── thinking?
│       │
│       ├── Output / Sampling
│       │   ├── output_config?
│       │   ├── stop_sequences?
│       │   ├── temperature?
│       │   ├── top_p?
│       │   └── top_k?
│       │
│       └── Runtime / Metadata
│           ├── stream?
│           ├── cache_control?
│           ├── container?
│           ├── inference_geo?
│           ├── service_tier?
│           └── metadata?
│
└── HTTP Response
    │
    ├── Non-Streaming
    │   └── Message
    │
    └── Streaming
        └── SSE Message Lifecycle
            ├── message_start
            ├── ContentBlock[index]*
            ├── message_delta+
            └── message_stop
```

------

## 1.3 Representation Style

Anthropic 大量使用 tagged union。

典型结构：

```json
{
  "type": "text",
  "text": "Hello"
}
```

这里：

```text
type
```

是 discriminator。

因此协议中的：

```text
ContentBlock
ThinkingConfig
ToolChoice
ImageSource
StreamDelta
Error
```

通常都应该先根据 `type` 判断具体 variant，再验证该 variant 的字段。

Anthropic 的版本策略明确允许未来增加：

- optional input fields；
- output fields；
- enum-like values；
- streaming event variants。

因此 protocol enum 不能被假定永远封闭。

------

# 2. HTTP Layer

## 2.1 Request Method and Path

```http
POST /v1/messages
```

Request body：

```text
JSON
```

Content type：

```http
content-type: application/json
```

------

## 2.2 Authentication and Required Headers

Direct Claude API 当前支持两种 authentication mechanism：

```text
API Key
or
Workload Identity Federation Bearer Token
```

Header contract：

| Header              | Presence              | Format              | Meaning                            |
| ------------------- | --------------------- | ------------------- | ---------------------------------- |
| `x-api-key`         | authentication choice | API key string      | static Claude API credential       |
| `Authorization`     | authentication choice | `Bearer <token>`    | short-lived federated access token |
| `anthropic-version` | required              | date-version string | API contract version               |
| `content-type`      | required              | `application/json`  | JSON request body                  |

必须提供 `x-api-key` 或 `Authorization` 其中一种。

典型 API-key request：

```http
POST /v1/messages
content-type: application/json
x-api-key: <api-key>
anthropic-version: 2023-06-01
```

------

## 2.3 `anthropic-version`

Type：

```text
string
```

典型值：

```text
2023-06-01
```

它描述的是：

```text
API contract version
```

不是：

```text
model version
```

当前 Messages API 请求必须带该 header；官方 SDK 通常自动设置。

------

## 2.4 `anthropic-beta`

实验性 capability 可以通过：

```http
anthropic-beta: <feature-name>
```

启用。

多个 beta：

```http
anthropic-beta: feature-a,feature-b
```

Beta 名称通常采用：

```text
feature-name-YYYY-MM-DD
```

格式。

Beta feature 不属于稳定协议保证，可以发生 breaking change、deprecated 或 removal。

------

## 2.5 API Versioning Rule

对于一个固定 API version，Anthropic 承诺保留已有 input/output parameters，但可能增加新的 optional fields、output values 和 enum/event variants。

特别是 `2023-06-01` streaming format：

```text
named SSE events
+
incremental deltas
```

并且已经移除旧的：

```text
data: [DONE]
```

sentinel。

因此当前 Messages streaming protocol：

> **没有 `[DONE]` 作为正常终止标记。**

------

# 3. Request Protocol

## 3.1 MessageRequest Hierarchy

```text
MessageRequest
│
├── Core
│   ├── model
│   ├── max_tokens
│   └── messages[]
│
├── System
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
├── Sampling / Termination
│   ├── stop_sequences?
│   ├── temperature?
│   ├── top_p?
│   └── top_k?
│
├── Transport
│   └── stream?
│
└── Runtime / Metadata
    ├── cache_control?
    ├── container?
    ├── inference_geo?
    ├── service_tier?
    └── metadata?
```

当前官方 OpenAPI-derived request type 将 `model`、`max_tokens`、`messages` 定义为核心 required fields；其余为 optional controls。

------

## 3.2 Top-Level Field Contract

| Field            | Type                 | Presence | Value Source | Meaning                       |
| ---------------- | -------------------- | -------- | ------------ | ----------------------------- |
| `model`          | string               | required | client       | target model                  |
| `max_tokens`     | integer              | required | client       | maximum generated output      |
| `messages`       | array                | required | client       | conversation history          |
| `system`         | string / text blocks | optional | client       | top-level system instructions |
| `tools`          | array                | optional | client       | tools available to Claude     |
| `tool_choice`    | tagged object        | optional | client       | tool-use policy               |
| `thinking`       | tagged object        | optional | client       | thinking configuration        |
| `output_config`  | object               | optional | client       | output/effort configuration   |
| `stop_sequences` | string[]             | optional | client       | custom stop strings           |
| `temperature`    | number               | optional | client       | sampling control              |
| `top_p`          | number               | optional | client       | nucleus sampling              |
| `top_k`          | integer              | optional | client       | top-k sampling                |
| `stream`         | boolean              | optional | client       | JSON vs SSE response          |
| `cache_control`  | object               | optional | client       | prompt caching                |
| `container`      | string               | optional | client       | reusable container identity   |
| `inference_geo`  | string               | optional | client       | inference geography           |
| `service_tier`   | enum                 | optional | client       | requested service tier        |
| `metadata`       | object               | optional | client       | request metadata              |

Not every model supports every optional generation capability; structural existence and model availability are different concepts.

------

## 3.3 `model`

Type：

```text
string
```

Example：

```json
{
  "model": "claude-opus-5"
}
```

`model` identifies the model that should generate the next assistant turn.

Which identifiers exist and which capabilities they support are model-catalog concerns rather than structural properties of `MessageRequest`.

------

## 3.4 `max_tokens`

Type：

```text
integer
```

Minimum：

```text
0
```

Meaning：

```text
absolute upper bound
on generated output tokens
```

Claude may stop before reaching it.

Current API also gives `0` a defined use:

```json
{
  "max_tokens": 0
}
```

can populate prompt cache without ordinary output generation. Model-specific maximums differ.

------

# 3.5 Conversation

## 3.5.1 Conversation Hierarchy

Stable baseline：

```text
Conversation
│
├── Top-Level System
│   └── system?
│
└── messages[]
    ├── user
    └── assistant
```

Messages API normally operates on alternating user/assistant conversational turns. Consecutive `user` or consecutive `assistant` turns can be combined by Anthropic.

A newer, model-dependent extension additionally permits mid-conversation:

```text
role = "system"
```

messages. This extension is described separately in Appendix A because it is not universally supported.

------

## 3.5.2 `system`

Top-level `system` supplies instructions that apply at system/operator authority.

Forms：

```text
system
├── string
└── TextBlock[]
```

Simple example：

```json
{
  "system": "You are a concise technical assistant."
}
```

Structured form：

```json
{
  "system": [
    {
      "type": "text",
      "text": "You are a concise technical assistant."
    }
  ]
}
```

Current generated OpenAPI request type expresses this field as:

```text
string | TextBlock[]
```

------

## 3.5.3 Message

Baseline conceptual form：

```ts
interface MessageParam {
  role: "user" | "assistant"
  content: string | ContentBlockParam[]
}
```

However, current Anthropic OpenAPI-derived SDK types also contain:

```text
role = "system"
```

to support the model-dependent mid-conversation-system feature.

Therefore the correct interpretation is:

```text
Universal conversation baseline
├── user
└── assistant

Model-dependent extension
└── system
```

rather than treating `system` either as universally forbidden or universally supported.

------

## 3.5.4 String Content Shorthand

For normal message input:

```json
{
  "role": "user",
  "content": "Hello"
}
```

is shorthand for:

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

## 3.5.5 Final Assistant Prefill

If the final input message has:

```text
role = "assistant"
```

the generated response continues directly from that assistant content.

Example:

```json
[
  {
    "role": "user",
    "content": "Choose A or B."
  },
  {
    "role": "assistant",
    "content": "The answer is "
  }
]
```

The new response continues from `"The answer is "`.

------

# 3.6 Request Content Blocks

## 3.6.1 Content Hierarchy

Current request-side OpenAPI union includes a broad family of blocks. The main semantic families are:

```text
ContentBlockParam
│
├── Ordinary Content
│   ├── text
│   ├── image
│   ├── document
│   └── search_result
│
├── Thinking Continuity
│   ├── thinking
│   └── redacted_thinking
│
├── Client Tool Protocol
│   ├── tool_use
│   └── tool_result
│
├── Server Tool Protocol
│   ├── server_tool_use
│   └── specialized tool-result blocks
│
└── Extensions
    ├── container_upload
    ├── tool_search result
    ├── mid-conversation system blocks
    └── future variants
```

The current official generated SDK shows this as an extensible union rather than only text/image.

------

## 3.6.2 TextBlock

Tree：

```text
TextBlock
├── type = "text"
├── text
├── citations?
└── cache_control?
```

Field contract：

| Field           | Type     | Presence | Kind                 |
| --------------- | -------- | -------- | -------------------- |
| `type`          | `"text"` | required | literal              |
| `text`          | string   | required | content              |
| `citations`     | array    | optional | citation information |
| `cache_control` | object   | optional | cache marker         |

Example：

```json
{
  "type": "text",
  "text": "Hello"
}
```

------

## 3.6.3 ImageBlock

Tree：

```text
ImageBlock
├── type = "image"
├── source
│   ├── Base64ImageSource
│   └── URLImageSource
└── cache_control?
```

### Base64 Source

```text
Base64ImageSource
├── type = "base64"
├── media_type
└── data
```

Example：

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "<base64-image-data>"
  }
}
```

Current base64 image media types include:

```text
image/jpeg
image/png
image/gif
image/webp
```

### URL Source

Conceptual form：

```json
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://example.com/image.png"
  }
}
```

The source discriminator determines how the image payload is interpreted.

------

## 3.6.4 DocumentBlock

Hierarchy：

```text
DocumentBlock
├── type = "document"
├── source
│   ├── base64 PDF
│   ├── URL PDF
│   ├── plain text
│   └── content blocks
├── title?
├── context?
├── citations?
└── cache_control?
```

Typical PDF form：

```json
{
  "type": "document",
  "source": {
    "type": "base64",
    "media_type": "application/pdf",
    "data": "<base64>"
  }
}
```

Current official API types expose documents as their own structured content family rather than treating them as text or image blocks.

------

## 3.6.5 SearchResultBlock

Conceptual hierarchy：

```text
SearchResultBlock
├── type = "search_result"
├── source
├── title
├── content[]
├── citations?
└── cache_control?
```

Search-result content is represented structurally so citation metadata and source identity can survive as part of the request.

------

# 3.7 Thinking

## 3.7.1 Configuration Hierarchy

Current protocol structurally supports:

```text
thinking
│
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

Actual support differs substantially by model.

------

## 3.7.2 Disabled

```json
{
  "thinking": {
    "type": "disabled"
  }
}
```

This explicitly disables thinking where the selected model supports disabling it.

Some models do not permit disabled mode, so validity is model-dependent.

------

## 3.7.3 Adaptive Thinking

```json
{
  "thinking": {
    "type": "adaptive"
  }
}
```

Optional display：

```json
{
  "thinking": {
    "type": "adaptive",
    "display": "summarized"
  }
}
```

`adaptive` lets Claude decide whether and how much to think according to request complexity.

------

## 3.7.4 Manual Thinking

Shape：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 8192
  }
}
```

`budget_tokens` is a token budget for manual extended thinking.

Current manual-thinking contract requires a minimum budget of:

```text
1024
```

and this budget participates in the request's output-token constraint. Newer models increasingly prefer or require adaptive mode.

------

## 3.7.5 Thinking Display

Where supported:

```text
display
├── summarized
└── omitted
```

`"summarized"`:

```text
returns readable summarized thinking
```

`"omitted"`:

```text
returns a thinking block
with empty thinking text
while preserving its signature
```

`omitted` therefore does **not** mean:

```text
redacted_thinking
```

They are distinct protocol concepts.

------

# 3.8 Output Configuration

## 3.8.1 Hierarchy

```text
output_config
├── effort?
└── format?
```

------

## 3.8.2 `effort`

Current effort semantic values:

```text
low
medium
high
xhigh
max
```

Example：

```json
{
  "output_config": {
    "effort": "medium"
  }
}
```

`high` is the current default behavior when effort is supported.

Effort is a behavioral control affecting overall response work, including text, tool calls, and thinking. It is not a strict token budget. Model support differs by level.

------

## 3.8.3 Structured Output Format

Current structured-output form uses:

```text
output_config.format
```

with a JSON Schema configuration.

Conceptually：

```json
{
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": {
          "answer": {
            "type": "string"
          }
        },
        "required": [
          "answer"
        ]
      }
    }
  }
}
```

`format` controls output representation rather than conversation role or message structure.

------

# 3.9 Sampling and Stop Controls

## 3.9.1 `stop_sequences`

Type：

```text
string[]
```

Example：

```json
{
  "stop_sequences": [
    "</answer>"
  ]
}
```

If Claude emits one of these sequences:

```text
stop_reason = "stop_sequence"
stop_sequence = matched value
```

------

## 3.9.2 `temperature`

Type：

```text
number
```

Historical/general API range:

```text
0.0 – 1.0
```

The general request schema documents default:

```text
1.0
```

but model support must be checked independently; newer model families do not necessarily permit custom sampling controls.

------

## 3.9.3 `top_p`

Type：

```text
number
```

Represents nucleus sampling.

------

## 3.9.4 `top_k`

Type：

```text
integer
```

Limits sampling to the top-K candidate tokens.

`temperature`, `top_p`, and `top_k` belong to the Messages request schema, but support is model-dependent rather than a universal model capability.

------

# 3.10 Runtime and Metadata Fields

## 3.10.1 `stream`

Type：

```text
boolean
```

Behavior：

```text
false / omitted
→ JSON Message response

true
→ SSE response
```

------

## 3.10.2 `cache_control`

Cache-control shape：

```text
CacheControl
├── type = "ephemeral"
└── ttl?
    ├── "5m"
    └── "1h"
```

Default TTL when omitted:

```text
5m
```

A top-level `cache_control` applies automatic caching to the last eligible cacheable block. Individual content blocks can also carry cache-control markers.

------

## 3.10.3 `container`

Type：

```text
string?
```

Identifies a reusable execution container where a supported server-side feature uses one.

------

## 3.10.4 `inference_geo`

Type：

```text
string?
```

Requests a geographic region for inference where supported.

If omitted, the workspace's configured default can apply.

------

## 3.10.5 `service_tier`

Request values:

```text
auto
standard_only
```

This is the requested capacity policy.

It should not be confused with the response's actual `usage.service_tier`, whose current values are:

```text
standard
priority
batch
```

------

## 3.10.6 `metadata`

Conceptually：

```text
metadata
└── user_id?
```

`user_id` is application-supplied opaque user identity metadata.

Anthropic recommends using a non-identifying opaque value rather than direct PII.

------

# 4. Non-Streaming Response Protocol

## 4.1 Message Hierarchy

A successful non-streaming call returns one assistant `Message`:

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
└── Runtime
    └── container?
```

The current generated OpenAPI `Message` type defines this structure directly.

------

## 4.2 Message Field Contract

| Field           | Type          | Presence                     | Source / Kind                      |
| --------------- | ------------- | ---------------------------- | ---------------------------------- |
| `id`            | string        | required                     | server-generated opaque identifier |
| `type`          | `"message"`   | required                     | literal                            |
| `role`          | `"assistant"` | required                     | literal                            |
| `model`         | string        | required                     | server-reported model              |
| `content`       | array         | required                     | server-generated                   |
| `stop_reason`   | enum/string   | required non-stream terminal | server-generated                   |
| `stop_sequence` | string/null   | required                     | server-generated                   |
| `stop_details`  | object/null   | feature-dependent            | server-generated                   |
| `usage`         | object        | required                     | server-generated                   |
| `container`     | object/null   | feature-dependent            | server-generated                   |

Message IDs are opaque. Anthropic explicitly states that their format and length can change.

------

## 4.3 Example

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

------

# 4.4 Response Content Blocks

## 4.4.1 Main Response Hierarchy

The current output-side content union includes:

```text
Message.content[]
│
├── text
├── thinking
├── redacted_thinking
├── tool_use
├── server_tool_use
├── specialized server-tool results
├── container/tool extension blocks
└── future variants
```

Ordinary input `image` and `document` blocks are not simply symmetric assistant-output variants; server-tool output can instead expose its own specialized result structures.

------

## 4.4.2 TextBlock

```json
{
  "type": "text",
  "text": "Hello"
}
```

Possible accompanying fields include citation information.

------

## 4.4.3 ThinkingBlock

Tree：

```text
ThinkingBlock
├── type = "thinking"
├── thinking
└── signature
```

Field contract：

| Field       | Type         | Presence | Kind                                        |
| ----------- | ------------ | -------- | ------------------------------------------- |
| `type`      | `"thinking"` | required | literal                                     |
| `thinking`  | string       | required | summarized/visible thinking, possibly empty |
| `signature` | string       | required | opaque server-generated continuity data     |

Example：

```json
{
  "type": "thinking",
  "thinking": "...",
  "signature": "..."
}
```

The signature is opaque and should not be interpreted or parsed.

------

## 4.4.4 Omitted Thinking

With:

```json
{
  "thinking": {
    "type": "adaptive",
    "display": "omitted"
  }
}
```

a thinking block still exists:

```json
{
  "type": "thinking",
  "thinking": "",
  "signature": "<opaque>"
}
```

Therefore:

```text
empty thinking
+
valid signature
```

can be a normal `thinking` block.

------

## 4.4.5 RedactedThinkingBlock

Separate structure：

```text
RedactedThinkingBlock
├── type = "redacted_thinking"
└── data
```

Example：

```json
{
  "type": "redacted_thinking",
  "data": "<opaque>"
}
```

It is semantically distinct from:

```text
ThinkingBlock {
  thinking: "",
  signature: ...
}
```

------

# 4.5 Usage

## 4.5.1 Usage Hierarchy

Current response usage structure includes:

```text
Usage
│
├── Input
│   ├── input_tokens
│   ├── cache_creation_input_tokens?
│   ├── cache_read_input_tokens?
│   └── cache_creation?
│
├── Output
│   ├── output_tokens
│   └── output_tokens_details?
│       └── thinking_tokens
│
├── Server Tools
│   └── server_tool_use?
│
└── Execution Metadata
    ├── inference_geo?
    └── service_tier?
```

------

## 4.5.2 Field Contract

| Field                         | Type     | Meaning                          |
| ----------------------------- | -------- | -------------------------------- |
| `input_tokens`                | integer  | uncached/ordinary input tokens   |
| `output_tokens`               | integer  | inclusive output-token total     |
| `cache_creation_input_tokens` | integer? | tokens written into prompt cache |
| `cache_read_input_tokens`     | integer? | tokens read from cache           |
| `cache_creation`              | object?  | TTL-specific write breakdown     |
| `output_tokens_details`       | object?  | output category breakdown        |
| `server_tool_use`             | object?  | server-tool usage counts         |
| `inference_geo`               | string?  | actual inference region          |
| `service_tier`                | enum?    | actual service tier              |

------

## 4.5.3 Input Token Accounting

When cache fields are present, total processed input is conceptually split among:

```text
input_tokens
+
cache_creation_input_tokens
+
cache_read_input_tokens
```

They represent different input accounting categories.

------

## 4.5.4 Thinking Tokens

Where returned:

```text
output_tokens_details.thinking_tokens
```

is a decomposition of:

```text
output_tokens
```

not an additional token amount.

Therefore:

```text
WRONG:
output_tokens + thinking_tokens
```

would double-count reasoning.

The OpenAPI definition explicitly states `output_tokens` remains the inclusive authoritative total.

------

# 5. Tool Protocol

## 5.1 Tool Families

Anthropic distinguishes primarily by **where the operation executes**:

```text
Tools
│
├── Client-Executed Tools
│   ├── user-defined tools
│   └── Anthropic-schema client tools
│
└── Server-Executed Tools
    ├── web_search
    ├── web_fetch
    ├── code_execution
    ├── tool_search
    └── other Anthropic server tools
```

Client tools are executed by the caller.

Server tools are executed by Anthropic infrastructure.

These are different lifecycle contracts and must not be collapsed into one generic `tool_result` loop.

------

# 5.2 Client Tool Definition

## 5.2.1 Core Structure

```text
Tool
├── name
├── description?
├── input_schema
└── optional tool controls
```

Example：

```json
{
  "name": "get_weather",
  "description": "Get weather for a location.",
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

`input_schema` uses JSON Schema and describes the object Claude should place in the eventual `tool_use.input`.

------

## 5.2.2 Additional Tool Controls

Current tool definitions may also include feature-dependent fields such as:

```text
type
cache_control
strict
allowed_callers
defer_loading
eager_input_streaming
input_examples
```

These extend the tool definition but do not change the fundamental client-tool identity contract.

Anthropic-provided tools additionally use versioned `type` values such as specific web-search or code-execution tool versions.

------

# 5.3 `tool_choice`

## 5.3.1 Hierarchy

```text
tool_choice
│
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

Semantics：

| Type   | Meaning                               |
| ------ | ------------------------------------- |
| `auto` | Claude decides whether to call a tool |
| `any`  | Claude must choose an available tool  |
| `tool` | Claude must use the named tool        |
| `none` | Claude must not use a tool            |

`disable_parallel_tool_use` restricts multiple tool calls where applicable.

------

# 5.4 Client ToolUseBlock

## 5.4.1 Structure

```text
ToolUseBlock
├── type = "tool_use"
├── id
├── name
├── input
└── optional caller/provenance fields
```

Example：

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

Field contract：

| Field   | Type         | Presence | Source                           |
| ------- | ------------ | -------- | -------------------------------- |
| `type`  | `"tool_use"` | required | literal                          |
| `id`    | string       | required | server-generated opaque ID       |
| `name`  | string       | required | model selects a defined tool     |
| `input` | object       | required | server/model-generated arguments |

The final non-streaming `input` is a JSON object.

------

# 5.5 ToolResultBlock

## 5.5.1 Structure

```text
ToolResultBlock
├── type = "tool_result"
├── tool_use_id
├── content?
├── is_error?
└── cache_control?
```

Exact core fields in the current OpenAPI-derived type:

```text
tool_use_id: string
type: "tool_result"

content?:
  string
  or
  [
    text
    image
    search_result
    document
    tool_reference
  ]

is_error?: boolean
cache_control?: ...
```

Example：

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01ABC",
  "content": "15°C and cloudy",
  "is_error": false
}
```

------

# 5.6 Client Tool Identity

The central identity invariant is:

```text
Assistant
└── tool_use
    └── id = X

        │
        ▼

User
└── tool_result
    └── tool_use_id = X
```

Therefore:

```text
tool_use.id
=
tool_result.tool_use_id
```

The ID, not array position or tool name, identifies the invocation.

------

# 5.7 Tool Result Turn Ordering

Canonical client-tool lifecycle：

```text
Request 1
user request
↓
assistant tool_use
↓
caller executes tool
↓
Request 2
user tool_result
↓
assistant continuation
```

For the next request, tool results must immediately follow the assistant tool-use turn. Anthropic reports request errors when tool-use IDs do not have corresponding `tool_result` blocks immediately afterward.

Inside that user message:

```text
tool_result blocks
must precede
ordinary text
```

For example:

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

is the valid ordering pattern.

------

# 5.8 Parallel Client Tool Calls

One assistant response can contain multiple:

```text
tool_use
```

blocks.

Example lifecycle：

```text
AssistantMessage
├── tool_use(id=A)
├── tool_use(id=B)
└── tool_use(id=C)

        ↓

UserMessage
├── tool_result(tool_use_id=A)
├── tool_result(tool_use_id=B)
└── tool_result(tool_use_id=C)
```

Correlation remains ID-based.

------

# 5.9 Server Tools

Server tools follow a different contract:

```text
Claude
↓
server_tool_use
↓
Anthropic infrastructure executes tool
↓
specialized server-tool result block
↓
Claude continues
```

Normally the caller does **not** manufacture ordinary `tool_result` blocks for server tools.

Examples of server-tool block families include:

```text
server_tool_use
web_search_tool_result
web_fetch_tool_result
code_execution_tool_result
tool_search_tool_result
...
```

Their exact result schemas are tool-specific and versioned.

------

# 6. Streaming Response Protocol

## 6.1 Transport

When:

```json
{
  "stream": true
}
```

the Messages response is transmitted using Server-Sent Events.

Frames use:

```text
event: <event-name>
data: <JSON>
```

The JSON object also includes its own `type` discriminator.

Example：

```text
event: message_stop
data: {"type":"message_stop"}
```

------

## 6.2 Complete Stream Hierarchy

```text
Anthropic Message Stream
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
│   │   └── future delta variants
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

This is the core documented SSE lifecycle.

------

# 6.3 `message_start`

## 6.3.1 Structure

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
    └── usage
```

Example shape：

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

The message begins incomplete; content is added through later content-block events.

------

# 6.4 Content Block Lifecycle

## 6.4.1 Lifecycle

Each streamed block uses an integer:

```text
index
```

and follows:

```text
ContentBlock[index]
│
├── content_block_start
├── content_block_delta*
└── content_block_stop
```

`index` corresponds to:

```text
final Message.content[index]
```

------

## 6.4.2 State Machine

```text
NOT_STARTED
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

A normal parser should track lifecycle state by `index`.

------

# 6.5 `content_block_start`

Structure：

```text
content_block_start
├── index
└── content_block
```

Text example：

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

The block's `type` determines which subsequent delta variants make semantic sense.

------

# 6.6 `content_block_delta`

General shape：

```text
content_block_delta
├── index
└── delta
    ├── type
    └── type-specific fields
```

------

## 6.6.1 Text Delta

```json
{
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "text_delta",
    "text": "Hello"
  }
}
```

Meaning：

```text
append delta.text
to the text block at index
```

Text is incremental, not cumulative.

------

## 6.6.2 Tool Input JSON Delta

Structure：

```text
input_json_delta
├── type = "input_json_delta"
└── partial_json
```

Example：

```json
{
  "type": "content_block_delta",
  "index": 1,
  "delta": {
    "type": "input_json_delta",
    "partial_json": "{\"location\":\"San Fra"
  }
}
```

Critical semantic distinction：

```text
partial_json
=
serialized JSON fragment

tool_use.input
=
completed JSON object
```

Therefore:

```text
partial_json
≠
completed tool input
```

Fragments should be accumulated for the corresponding block and parsed as the object becomes complete; the final `tool_use.input` is always object-shaped.

------

## 6.6.3 Thinking Delta

```json
{
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "thinking_delta",
    "thinking": "..."
  }
}
```

`thinking` is incremental thinking text.

------

## 6.6.4 Signature Delta

Thinking blocks also have:

```text
signature_delta
```

Example：

```json
{
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "signature_delta",
    "signature": "<opaque>"
  }
}
```

The signature normally arrives shortly before the thinking content block closes.

------

## 6.6.5 Citation Delta

Text output can also receive citation updates through:

```text
citations_delta
```

These modify citation state rather than text itself.

The official SDK stream accumulator treats citation, text, thinking, signature, and input JSON as distinct delta variants.

------

# 6.7 Text Streaming Lifecycle

```text
content_block_start
└── TextBlock(index)

        ↓

text_delta(index)*

        ↓

content_block_stop(index)
```

Completed text is the ordered concatenation of `text_delta.text` values for that block.

------

# 6.8 Tool-Use Streaming Lifecycle

## 6.8.1 Hierarchy

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
completed tool_use.input
```

------

## 6.8.2 Partial Input Rule

During streaming:

```text
partial JSON syntax
```

is temporary state.

It should not be confused with:

```text
completed semantic tool invocation
```

The final semantic structure remains:

```json
{
  "type": "tool_use",
  "id": "...",
  "name": "...",
  "input": {
    "...": "..."
  }
}
```

------

# 6.9 Thinking Streaming Lifecycle

Normal thinking:

```text
content_block_start(thinking)
↓
thinking_delta*
↓
signature_delta
↓
content_block_stop
```

For `display: "omitted"`:

```text
content_block_start(thinking)
↓
signature_delta
↓
content_block_stop
```

No `thinking_delta` is emitted, but the block remains a normal `thinking` block.

------

# 6.10 `content_block_stop`

Structure：

```json
{
  "type": "content_block_stop",
  "index": 0
}
```

It closes the content block identified by the index.

The final block representation is now complete for normal lifecycle purposes.

------

# 6.11 `message_delta`

## 6.11.1 Hierarchy

```text
message_delta
├── delta
│   ├── stop_reason?
│   ├── stop_sequence?
│   └── other message-level updates
│
└── usage
```

Example：

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

------

## 6.11.2 Usage Is Cumulative

Usage contained in `message_delta` is cumulative.

Therefore:

```text
message_delta #1 output_tokens = 10
message_delta #2 output_tokens = 20
```

means final current count is:

```text
20
```

not:

```text
10 + 20 = 30
```

------

# 6.12 `ping`

Shape：

```text
event: ping
data: {"type":"ping"}
```

Zero or more `ping` events can appear during the stream.

They do not mutate Message content.

------

# 6.13 `message_stop`

Successful terminal event：

```text
event: message_stop
data: {"type":"message_stop"}
```

Canonical successful lifecycle：

```text
message_start
↓
ContentBlock[index]*
↓
message_delta+
↓
message_stop
```

Therefore:

> **`message_stop` is the normal semantic completion boundary of the current Anthropic Messages SSE protocol.**

There is no trailing `[DONE]` requirement.

------

# 6.14 Stream Error

A streaming HTTP response can fail after the server has already returned HTTP `200`.

Example shape：

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

A corresponding non-streaming overload might have been HTTP `529`, but once SSE has begun, the failure is represented inside the stream.

Therefore:

```text
HTTP 200
≠
guaranteed successful Message completion
```

------

# 7. Termination and Error Protocol

## 7.1 Successful Message Termination

A successfully produced `Message` carries:

```text
stop_reason
```

which describes why generation stopped.

Current documented reasons:

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

------

## 7.2 `end_turn`

Meaning：

```text
Claude reached a natural completion point
```

This is the normal ordinary-answer termination.

------

## 7.3 `max_tokens`

Meaning：

```text
requested max_tokens
or model output maximum
was reached
```

The response itself is still a valid successful API Message, but its content is truncated by the output limit.

------

## 7.4 `stop_sequence`

Meaning：

```text
one configured stop_sequences value matched
```

Then:

```text
stop_sequence
```

contains the matched sequence.

------

## 7.5 `tool_use`

Meaning：

```text
Claude produced one or more client tool invocations
and expects tool results
```

This is a valid Message outcome, not an API failure.

The caller normally executes the tools and continues the conversation with corresponding `tool_result` blocks.

------

## 7.6 `pause_turn`

Used by server-tool workflows when the server-side execution loop pauses before completing the whole logical turn.

Correct continuation is to send the assistant response back as conversation history so the server-side process can continue.

It differs from client `tool_use`:

```text
tool_use
→ caller must execute client tool

pause_turn
→ server-side tool process needs another Messages turn
```

------

## 7.7 `refusal`

A refusal is normally a **valid successful HTTP Message response**:

```text
HTTP success
+
stop_reason = "refusal"
```

rather than an HTTP protocol error.

`stop_details`, when available, can carry structured refusal information.

------

## 7.8 `model_context_window_exceeded`

Meaning：

```text
generation reached the model's context-window limit
before ordinary completion
```

The returned Message is valid but truncated by context capacity.

------

## 7.9 `stop_sequence`

Type：

```text
string | null
```

If:

```text
stop_reason = "stop_sequence"
```

it contains the matched custom sequence.

Otherwise normally:

```text
null
```

------

# 7.10 HTTP Error Response

Canonical structure：

```text
ErrorResponse
├── type = "error"
├── error
│   ├── type
│   └── message
└── request_id
```

Example：

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

------

## 7.11 Current HTTP Error Families

| HTTP | `error.type`            |
| ---- | ----------------------- |
| 400  | `invalid_request_error` |
| 401  | `authentication_error`  |
| 402  | `billing_error`         |
| 403  | `permission_error`      |
| 404  | `not_found_error`       |
| 409  | `conflict_error`        |
| 413  | `request_too_large`     |
| 429  | `rate_limit_error`      |
| 500  | `api_error`             |
| 504  | `timeout_error`         |
| 529  | `overloaded_error`      |

Anthropic may add new error types in accordance with its API versioning policy.

------

## 7.12 Request Size

Current Messages API maximum request size:

```text
32 MB
```

Exceeding it produces:

```text
413 request_too_large
```

------

## 7.13 Request ID

Every API response contains:

```http
request-id: ...
```

For error responses, the same logical identifier is also returned as:

```json
{
  "request_id": "req_..."
}
```

The ID should be treated as opaque diagnostic identity.

------

# 8. Protocol Invariants

## 8.1 Message Ordering

```text
messages[]
```

is ordered conversation history.

Turn order is semantically meaningful.

Consecutive ordinary user/assistant turns may be combined by Anthropic, but callers should not arbitrarily reorder conversation history.

------

## 8.2 Content Ordering

```text
Message.content[]
```

is ordered.

Text, thinking, tool calls and extension blocks preserve their relative semantic sequence.

For streaming:

```text
content_block index
=
final content[] index
```

------

## 8.3 Tool Identity

For client tools:

```text
tool_use.id
=
tool_result.tool_use_id
```

This cross-turn relationship must be preserved.

------

## 8.4 Tool Result Placement

Client-tool result lifecycle requires:

```text
assistant tool_use
↓
immediately following user message
↓
matching tool_result
```

Within the user message:

```text
tool_result*
before
ordinary text*
```

------

## 8.5 Partial Tool Input Is Not Complete Input

Streaming:

```text
input_json_delta.partial_json
```

is serialized partial syntax.

Final:

```text
tool_use.input
```

is a JSON object.

Therefore:

```text
partial_json
≠
completed tool call input
```

------

## 8.6 Thinking Signature Is Opaque

`ThinkingBlock.signature` exists to preserve thinking continuity/integrity.

It must be treated as opaque data.

It should not be parsed or regenerated by a client implementation.

------

## 8.7 Omitted and Redacted Thinking Are Different

```text
ThinkingBlock
├── type = "thinking"
├── thinking = ""
└── signature = ...
```

can represent intentionally omitted visible thinking.

It is not equivalent to:

```text
RedactedThinkingBlock
├── type = "redacted_thinking"
└── data = ...
```

------

## 8.8 Usage Is Not Event-Delta Accounting

`message_delta.usage` is cumulative.

Do not sum consecutive streaming usage objects as independent increments.

Similarly:

```text
output_tokens_details.thinking_tokens
```

is included within:

```text
output_tokens
```

and must not be added again.

------

## 8.9 Streaming Success Terminal

The current successful stream ends with:

```text
message_stop
```

There is no `[DONE]`.

Consequently, for a protocol consumer:

```text
physical EOF before message_stop
```

does not provide the documented semantic success terminal.

It should therefore be regarded as an incomplete stream rather than silently promoted to a completed Message. This is a direct consumer-side consequence of the documented SSE lifecycle.

------

## 8.10 HTTP 200 Is Not Stream Success

For `stream=true`:

```text
HTTP 200
↓
SSE begins
↓
error event can still occur
```

Therefore HTTP status only establishes successful transition into streaming transport; final Message success still depends on the stream lifecycle.

------

## 8.11 Unknown vs Malformed

Anthropic's versioning policy explicitly allows future event/enum variants.

Therefore implementations should distinguish:

```text
unknown future variant
```

from:

```text
known variant
with invalid required structure
```

A robust parser can tolerate or preserve a future unknown variant while still treating malformed known structures as protocol errors.

------

# Appendix A. Model-Dependent Protocol Features

This appendix contains wire structures whose **availability or default behavior depends on the selected model**.

The structures themselves are protocol concepts; their support is not universal.

------

## A.1 Mid-Conversation System Messages

The traditional Messages API model is:

```text
top-level system
+
messages[user|assistant]
```

and the main Create Message reference still describes this baseline.

Anthropic has subsequently introduced generally available **mid-conversation system messages** on specific models:

```json
{
  "role": "system",
  "content": "New operator instruction."
}
```

Current OpenAPI-derived `MessageParam` accordingly includes:

```text
"user" | "assistant" | "system"
```

as its role union.

This is model-dependent rather than universally supported.

### Placement Rules

A mid-conversation `system` message:

- cannot be the first `messages[]` entry;
- must follow an appropriate preceding turn;
- must either be final or be followed by an assistant turn;
- cannot be inserted between a client `tool_use` and its corresponding `tool_result`;
- can appear consecutively with other system messages under the documented placement rules.

Therefore the current protocol is best understood as:

```text
Stable baseline roles
├── user
└── assistant

Model-dependent role extension
└── system
```

------

## A.2 Thinking Modes

Current structural modes:

```text
disabled
adaptive
enabled + budget_tokens
```

but model support differs considerably.

Some newer models require or default to adaptive thinking, some reject manual thinking, while older thinking-capable models can require the manual `enabled` form.

Therefore:

```text
ThinkingConfig shape
```

and:

```text
Selected model's thinking capability
```

must be treated as separate facts.

------

## A.3 Thinking Display Defaults

`display` values:

```text
summarized
omitted
```

are stable concepts, but the **default** differs by model.

Some newer models default to:

```text
omitted
```

while earlier Claude 4 variants commonly default to:

```text
summarized
```

------

## A.4 Effort Levels

The protocol currently defines:

```text
low
medium
high
xhigh
max
```

but not every effort-capable model supports every level.

For example, `xhigh` is supported by a narrower model set than `max`.

Therefore:

```text
valid effort enum
≠
supported effort levels of every model
```

------

## A.5 Sampling Controls

The request schema contains:

```text
temperature
top_p
top_k
```

but support is model-dependent.

An implementation must not infer:

```text
field exists in MessageRequest schema
→ every Claude model accepts non-default value
```

Model capability information remains authoritative for concrete availability.

------

# Appendix B. Extension Content Families

The Messages protocol is larger than the minimal:

```text
text
image
thinking
tool_use
tool_result
```

model.

The current official OpenAPI-derived types include additional families such as:

```text
Documents
├── document

Search
├── search_result

Server Tools
├── server_tool_use
├── web_search_tool_result
├── web_fetch_tool_result
├── code_execution_tool_result
├── bash_code_execution_tool_result
├── text_editor_code_execution_tool_result
└── tool_search_tool_result

Runtime / Container
└── container_upload

Thinking
├── thinking
└── redacted_thinking

Mid-Conversation Extensions
└── mid-conversation system-related blocks
```

These blocks should remain distinct tagged variants because their fields and lifecycles differ.

A parser should not flatten all of them into ordinary text.

------

# Appendix C. Complete Request Tree

```text
MessageRequest
│
├── model
├── max_tokens
│
├── Conversation
│   │
│   ├── system?
│   │
│   └── messages[]
│       │
│       ├── role
│       │   ├── user
│       │   ├── assistant
│       │   └── system*      # model-dependent extension
│       │
│       └── content
│           ├── string
│           └── ContentBlockParam[]
│               │
│               ├── text
│               ├── image
│               ├── document
│               ├── search_result
│               ├── thinking
│               ├── redacted_thinking
│               ├── tool_use
│               ├── tool_result
│               ├── server_tool_use
│               └── extension blocks
│
├── Tools
│   ├── tools[]?
│   └── tool_choice?
│
├── Thinking
│   └── thinking?
│       ├── disabled
│       ├── adaptive
│       └── enabled
│           └── budget_tokens
│
├── Output
│   └── output_config?
│       ├── effort?
│       └── format?
│
├── Sampling / Stop
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

# Appendix D. Complete Response Tree

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
│   │
│   ├── TextBlock
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
│   ├── ServerToolUseBlock
│   └── ExtensionBlock
│
├── Termination
│   ├── stop_reason
│   ├── stop_sequence
│   └── stop_details?
│
├── Usage
│   ├── input_tokens
│   ├── cache_creation_input_tokens?
│   ├── cache_read_input_tokens?
│   ├── output_tokens
│   ├── output_tokens_details?
│   ├── server_tool_use?
│   ├── inference_geo?
│   └── service_tier?
│
└── Runtime
    └── container?
```

------

# Appendix E. Complete Streaming Tree

```text
Anthropic SSE Message Stream
│
├── message_start
│   └── partial Message
│
├── ContentBlock[index]*
│   │
│   ├── content_block_start
│   │
│   ├── content_block_delta*
│   │   │
│   │   ├── text_delta
│   │   │   └── text
│   │   │
│   │   ├── input_json_delta
│   │   │   └── partial_json
│   │   │
│   │   ├── thinking_delta
│   │   │   └── thinking
│   │   │
│   │   ├── signature_delta
│   │   │   └── signature
│   │   │
│   │   ├── citations_delta
│   │   └── future delta variants
│   │
│   └── content_block_stop
│
├── message_delta+
│   ├── stop_reason
│   ├── stop_sequence
│   └── cumulative usage
│
└── message_stop

Auxiliary
└── ping*

Failure
└── error
```

The normal semantic terminal is:

```text
message_stop
```

not:

```text
[DONE]
```