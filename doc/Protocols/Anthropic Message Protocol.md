# Anthropic Messages API Protocol Specification v0.4

**Protocol:** Anthropic Messages API  
**Version:** v0.4
**Primary Endpoint:** `POST /v1/messages`  
**Transport:** HTTP + JSON / Server-Sent Events (SSE)  
**Reference Date:** 2026-08-10

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

哪些 request semantics 位于 JSON body？
哪些 request semantics 位于 protocol-defined HTTP headers？

Message / Content Block 如何组织？

Tool Use 如何建立跨 turn identity？

ToolResult 的不同 wire representation
哪些 equivalence 已被 source protocol 明确建立？
哪些仍不能从 union shape 推断？

Streaming event 如何组成完整 Message？

什么事件意味着成功？
什么情况意味着失败？

哪些结构是 stable core？
哪些是 model-dependent / beta / extension？
```

本文不描述 Pi、Token conversion、Gate C、Provider adaptation 或其他协议。

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
│   │   │
│   │   ├── Authentication
│   │   │   ├── x-api-key
│   │   │   └── Authorization
│   │   │
│   │   ├── Protocol Profile
│   │   │   ├── anthropic-version
│   │   │   └── anthropic-beta?
│   │   │
│   │   └── Request Semantics
│   │       ├── anthropic-user-profile-id?
│   │       └── future protocol-defined semantic headers
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

关键点：

> **Anthropic request semantics 不一定全部位于 JSON body。Protocol-defined HTTP header 也可以承载 request semantics。**

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

其中：

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

Anthropic 的版本策略允许未来增加：

- optional input fields；
- output fields；
- enum-like values；
- streaming event variants；
- beta capabilities；
- protocol-defined request semantics。

因此 protocol enum / semantic surface 不能被假定永远封闭。

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

## 2.2 Authentication and Baseline Required Headers

Direct Claude API 当前支持 authentication mechanism，例如：

```text
API Key
or
Workload Identity Federation Bearer Token
```

Baseline header contract：

| Header | Presence | Format | Meaning |
|---|---|---|---|
| `x-api-key` | authentication choice | API key string | static Claude API credential |
| `Authorization` | authentication choice | `Bearer <token>` | short-lived federated access token |
| `anthropic-version` | required | date-version string | API contract version |
| `content-type` | required | `application/json` | JSON request body |

必须提供满足当前 authentication contract 的 credential form。

典型 API-key request：

```http
POST /v1/messages
content-type: application/json
x-api-key: <api-key>
anthropic-version: 2023-06-01
```

> **本表描述 authentication 与 baseline required headers，不代表 Messages request 的完整 semantic-header surface。**

Request-semantic headers 见 §2.5。

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

它描述：

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

多个 beta 可以通过 header 中的 beta list 激活。

Beta name 通常包含 feature identity 与 date/version，例如：

```text
feature-name-YYYY-MM-DD
```

Beta feature 不属于稳定协议保证，可以发生 breaking change、deprecation 或 removal。

Beta activation 可以改变：

```text
request-valid field/header surface
content variants
server-tool families
runtime behavior
other experimental semantics
```

因此 source validity 不能脱离当前 active beta profile 单独判断。

------

## 2.5 Request-Semantic Headers

HTTP header 不只承载 transport、authentication 与 version negotiation。

某些 Anthropic-defined headers 本身具有 request semantics。

当前 `POST /v1/messages` API 包含：

```text
anthropic-user-profile-id?: string
```

### 2.5.1 `anthropic-user-profile-id`

Meaning：

```text
the user profile ID
to attribute this request to
```

Use case：

```text
act on behalf of a party
other than your organization
```

该 semantic 与具体 credential mechanism 无关；它不应被定义成只针对 API-key authentication。

Availability：

```text
requires the user-profiles beta
```

当前 user-profile beta family 的官方 beta identifier 包括：

```text
user-profiles-2026-03-24
```

其 exact identifier 属于 beta/versioned protocol surface，不应被假定永久稳定。

### 2.5.2 Distinction from `metadata.user_id`

`anthropic-user-profile-id` 与 body：

```text
metadata.user_id
```

不是同一个 protocol fact。

```text
anthropic-user-profile-id
→ references / attributes request to an Anthropic User Profile
→ beta-gated request-semantic header
```

而：

```text
metadata.user_id
→ application-supplied opaque user identity metadata
→ body field
```

Protocol consumers MUST NOT silently collapse these two concepts.

### 2.5.3 Semantic Header Extensibility

由于 Anthropic protocol 会演化：

```text
current semantic headers
+
future protocol-defined semantic headers
```

应被视为 request semantic surface 的一部分。

一个 header 是否属于 protocol semantics，取决于 Anthropic protocol definition，而不是它“位于 HTTP header”这一 transport location。

------

## 2.6 API Versioning Rule

对于一个固定 Messages API version，Anthropic 当前明确承诺保留：

```text
existing input parameters
existing output parameters
```

同时可能：

```text
add additional optional inputs
add additional values to output
change conditions for specific error types
add new variants to enum-like output values
```

其中官方把 streaming event types 作为 enum-like output variant 的例子。

因此，固定 API-version compatibility guarantee 不应被扩写成未经明确承诺的 transport-location guarantee。

Separately：

```text
beta capabilities
newly documented protocol inputs
protocol-defined request-semantic headers
```

也可以使 Anthropic 的整体 request semantic surface 演化。

但这种更广泛的 protocol evolution 与：

```text
fixed-version compatibility guarantee
```

是不同的事实，不应混成同一个承诺。

特别是 `2023-06-01` streaming format：

```text
named SSE events
+
incremental deltas
```

并且移除了旧的：

```text
data: [DONE]
```

sentinel。

因此：

> **当前 Messages streaming protocol 没有 `[DONE]` 作为正常终止标记。**

------

# 3. Request Protocol

## 3.1 MessageRequest Hierarchy

`MessageRequest` 描述 JSON body。

完整 Anthropic HTTP request 还包括 §2 中的 protocol-defined headers。

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

当前官方 OpenAPI-derived request type 将：

```text
model
max_tokens
messages
```

定义为核心 required body fields；其余为 optional controls。

------

## 3.2 Top-Level Field Contract

| Field | Type | Presence | Value Source | Meaning |
|---|---|---|---|---|
| `model` | string | required | client | target model |
| `max_tokens` | integer | required | client | maximum generated output |
| `messages` | array | required | client | conversation history |
| `system` | string / text blocks | optional | client | top-level system instructions |
| `tools` | array | optional | client | tools available to Claude |
| `tool_choice` | tagged object | optional | client | tool-use policy |
| `thinking` | tagged object | optional | client | thinking configuration |
| `output_config` | object | optional | client | output/effort configuration |
| `stop_sequences` | string[] | optional | client | custom stop strings |
| `temperature` | number | optional | client | sampling control |
| `top_p` | number | optional | client | nucleus sampling |
| `top_k` | integer | optional | client | top-k sampling |
| `stream` | boolean | optional | client | JSON vs SSE response |
| `cache_control` | object | optional | client | prompt caching |
| `container` | string | optional | client | reusable container identity |
| `inference_geo` | string | optional | client | inference geography |
| `service_tier` | enum | optional | client | requested service tier |
| `metadata` | object | optional | client | request metadata |

Not every model supports every optional generation capability; structural existence and concrete model availability are different concepts.

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

Current API also gives：

```json
{
  "max_tokens": 0
}
```

a defined use for prompt-cache population without ordinary output generation.

Model-specific maxima differ.

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

Messages API normally operates on alternating user/assistant conversational turns.

Consecutive `user` or consecutive `assistant` turns can be combined by Anthropic.

A model-dependent extension for mid-conversation system messages is described in Appendix A.

------

## 3.5.2 `system`

Top-level `system` supplies instructions at system/operator authority.

Forms：

```text
system
├── string
└── TextBlock[]
```

Example：

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

Current generated OpenAPI request type expresses this field as：

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

The project protocol evidence also tracks a model-dependent mid-conversation-system extension separately.

The correct conceptual distinction remains：

```text
Universal conversation baseline
├── user
└── assistant

Model-dependent extension
└── system
```

------

## 3.5.4 Normal Message String Content Shorthand

For ordinary input messages：

```json
{
  "role": "user",
  "content": "Hello"
}
```

Anthropic explicitly defines the string form as shorthand for：

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

Therefore these two ordinary-message representations are protocol-defined equivalents.

This equivalence is explicit protocol authority; it is not inferred merely from a union type.

------

## 3.5.5 Final Assistant Prefill

If the final input message has：

```text
role = "assistant"
```

the generated response continues directly from that assistant content.

Example：

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

The new response continues from the provided assistant prefix.

Final-assistant prefill source validity is model-dependent. The authoritative
classification for a selected source profile and model is a narrow,
evidence-bound policy with exactly these outcomes：

```text
allowed | forbidden | unknown
```

Their protocol meaning is：

```text
forbidden → source-invalid
            the request is rejected as invalid_request_error

allowed → source-valid
          generation continues from the assistant prefix

unknown → validity is not guessed
          neither model-name matching nor family inference may classify it
```

This source-validity decision is distinct from an implementation's feature
support. A source-valid prefill may still be unsupported by a converter or
runtime. An `unknown` outcome likewise remains unresolved rather than being
guessed valid or invalid.

The policy revision and its evidence must be immutable for certification.
Protocol consumers MUST NOT derive this decision from model-name substrings,
marketing families, catalog order, or provider fallback behavior.

------

# 3.6 Request Content Blocks

## 3.6.1 Content Hierarchy

Current request-side OpenAPI union includes：

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
    ├── mid-conversation system-related content
    └── future variants
```

The union is extensible and must not be reduced conceptually to only text/image.

------

## 3.6.2 TextBlock

```text
TextBlock
├── type = "text"
├── text
├── citations?
└── cache_control?
```

| Field | Type | Presence | Kind |
|---|---|---|---|
| `type` | `"text"` | required | literal |
| `text` | string | required | content |
| `citations` | array | optional | citation information |
| `cache_control` | object | optional | cache marker |

Example：

```json
{
  "type": "text",
  "text": "Hello"
}
```

------

## 3.6.3 ImageBlock

```text
ImageBlock
├── type = "image"
├── source
│   ├── Base64ImageSource
│   └── URLImageSource
└── cache_control?
```

Base64：

```text
Base64ImageSource
├── type = "base64"
├── media_type
└── data
```

Current base64 image media types include：

```text
image/jpeg
image/png
image/gif
image/webp
```

URL source uses：

```text
type = "url"
url = ...
```

The source discriminator determines how image payload is interpreted.

------

## 3.6.4 DocumentBlock

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

Documents remain their own structured content family.

------

## 3.6.5 SearchResultBlock

```text
SearchResultBlock
├── type = "search_result"
├── source
├── title
├── content[]
├── citations?
└── cache_control?
```

Search-result structure preserves source/citation information rather than flattening it into ordinary text.

------

# 3.7 Thinking

## 3.7.1 Configuration Hierarchy

Current protocol structurally tracks：

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

Actual availability is model-dependent.

------

## 3.7.2 Disabled

```json
{
  "thinking": {
    "type": "disabled"
  }
}
```

This explicitly disables thinking where permitted by the selected model.

------

## 3.7.3 Adaptive Thinking

```json
{
  "thinking": {
    "type": "adaptive"
  }
}
```

Where supported, `display` can further control thinking visibility.

------

## 3.7.4 Manual Thinking

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 8192
  }
}
```

The current manual-thinking contract uses a token budget and has model-dependent validity.

------

## 3.7.5 Thinking Display

Conceptual values：

```text
summarized
omitted
```

`omitted` visible thinking is distinct from a `redacted_thinking` block.

------

# 3.8 Output Configuration

```text
output_config
├── effort?
└── format?
```

## 3.8.1 `effort`

Current semantic values tracked by this spec：

```text
low
medium
high
xhigh
max
```

Model support differs.

## 3.8.2 Structured Output Format

`output_config.format` can describe structured output using JSON Schema.

This controls output representation, not conversation role.

------

# 3.9 Sampling and Stop Controls

## 3.9.1 `stop_sequences`

```text
string[]
```

A matched stop sequence produces：

```text
stop_reason = "stop_sequence"
stop_sequence = matched value
```

## 3.9.2 `temperature`

Type：

```text
number
```

The general request schema exposes this control, while concrete model support may differ.

## 3.9.3 `top_p`

Nucleus sampling control.

## 3.9.4 `top_k`

Top-K sampling control.

Field existence in request schema does not imply every model accepts every non-default value.

------

# 3.10 Runtime and Metadata Fields

## 3.10.1 `stream`

```text
false / omitted
→ JSON Message response

true
→ SSE response
```

## 3.10.2 `cache_control`

Conceptual shape：

```text
CacheControl
├── type = "ephemeral"
└── ttl?
    ├── "5m"
    └── "1h"
```

The documented default TTL is `5m` when the cache-control object is present and TTL is omitted.

## 3.10.3 `container`

Reusable execution container identity where supported.

## 3.10.4 `inference_geo`

Requested inference geography where supported.

## 3.10.5 `service_tier`

Request-side capacity policy; distinct from response-side actual usage service tier.

## 3.10.6 `metadata`

```text
metadata
└── user_id?
```

`user_id` is application-supplied opaque metadata and is distinct from `anthropic-user-profile-id`.

------

# 4. Non-Streaming Response Protocol

## 4.1 Message Hierarchy

A successful non-streaming call returns one assistant `Message`.

Current output `Message` distinguishes **required field presence** from nullable value:

```text
Message
│
├── Identity
│   ├── id
│   ├── type = "message"
│   ├── role = "assistant"
│   └── model
│
├── Runtime
│   └── container
│       └── Container | null
│
├── Content
│   └── content[]
│
├── Termination
│   ├── stop_reason
│   ├── stop_sequence
│   └── stop_details
│       └── RefusalStopDetails | null
│
└── Usage
    └── usage
```

`container` and `stop_details` are not optional fields in the current output contract.

They are:

```text
required
+
nullable
```

Therefore:

```text
field absent
≠
field present with null
```

------

## 4.2 Message Field Contract

| Field | Type | Presence | Source / Kind |
|---|---|---|---|
| `id` | string | required | server-generated opaque identifier |
| `container` | `Container \| null` | required | server-generated runtime information |
| `content` | `ContentBlock[]` | required | server-generated |
| `model` | string/model identifier | required | server-reported model |
| `role` | `"assistant"` | required | literal |
| `stop_details` | `RefusalStopDetails \| null` | required | server-generated structured refusal state |
| `stop_reason` | stop-reason enum / null | required | server-generated termination state |
| `stop_sequence` | string / null | required | server-generated |
| `type` | `"message"` | required | literal |
| `usage` | `Usage` | required | server-generated |

For a successful non-streaming response:

```text
stop_reason
→ non-null
```

For the partial `Message` carried by `message_start`:

```text
stop_reason
→ null
```

Message IDs are opaque; their format and length are not stable protocol semantics.

------

## 4.3 Example

A baseline response with no container, no refusal, no citations, no server-tool usage and no populated usage breakdown still carries the current required nullable fields:

```json
{
  "id": "msg_01...",
  "container": null,
  "content": [
    {
      "citations": null,
      "text": "Hello.",
      "type": "text"
    }
  ],
  "model": "claude-opus-5",
  "role": "assistant",
  "stop_details": null,
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "type": "message",
  "usage": {
    "cache_creation": null,
    "cache_creation_input_tokens": null,
    "cache_read_input_tokens": null,
    "inference_geo": null,
    "input_tokens": 10,
    "output_tokens": 5,
    "output_tokens_details": null,
    "server_tool_use": null,
    "service_tier": null
  }
}
```

This example illustrates field shape and nullability, not a claim that every real response uses these particular null values.

------

# 4.4 Response Content Blocks

Current output-side content union includes:

```text
Message.content[]
├── text
├── thinking
├── redacted_thinking
├── tool_use
├── server_tool_use
├── specialized server-tool results
├── container/tool extensions
└── future variants
```

Input image/document variants are not simply symmetric output variants.

------

## 4.4.1 TextBlock

Current output shape:

```text
TextBlock
├── citations
│   └── TextCitation[] | null
├── text
└── type = "text"
```

Example:

```json
{
  "citations": null,
  "text": "Hello",
  "type": "text"
}
```

`citations` is required in the current output `TextBlock` contract even when its value is `null`.

Citation-bearing text uses the corresponding `TextCitation[]` value rather than `null`.

------

## 4.4.2 ToolUseBlock

Current output shape:

```text
ToolUseBlock
├── id
├── caller
│   ├── DirectCaller
│   └── server-tool caller variants
├── input
├── name
└── type = "tool_use"
```

`caller` is required in the current output contract.

Direct model-to-client tool invocation uses:

```text
DirectCaller
└── type = "direct"
```

Example direct client tool call:

```json
{
  "id": "toolu_01ABC",
  "caller": {
    "type": "direct"
  },
  "input": {
    "location": "San Francisco"
  },
  "name": "get_weather",
  "type": "tool_use"
}
```

Server-tool caller variants carry their own tool identity and remain distinct from a direct caller.

------

## 4.4.3 ThinkingBlock

```text
ThinkingBlock
├── type = "thinking"
├── thinking
└── signature
```

`signature` is opaque continuity data.

------

## 4.4.4 Omitted Thinking

A normal thinking block can have:

```text
thinking = ""
signature = <opaque>
```

when visible thinking is omitted.

------

## 4.4.5 RedactedThinkingBlock

```text
RedactedThinkingBlock
├── type = "redacted_thinking"
└── data
```

It is semantically distinct from a normal thinking block whose visible text is empty.

------

# 4.5 Usage

## 4.5.1 Usage Hierarchy

Current output `Usage` shape is:

```text
Usage
│
├── Cache
│   ├── cache_creation
│   │   └── CacheCreation | null
│   ├── cache_creation_input_tokens
│   │   └── number | null
│   └── cache_read_input_tokens
│       └── number | null
│
├── Input
│   └── input_tokens
│       └── number
│
├── Output
│   ├── output_tokens
│   │   └── number
│   └── output_tokens_details
│       └── OutputTokensDetails | null
│           └── thinking_tokens
│
├── Server Tools
│   └── server_tool_use
│       └── ServerToolUsage | null
│
└── Execution Metadata
    ├── inference_geo
    │   └── string | null
    └── service_tier
        └── "standard" | "priority" | "batch" | null
```

All fields shown above belong to the current output `Usage` object.

The following distinction is important:

```text
cache_creation_input_tokens: number | null
```

means:

```text
required field
with nullable value
```

not:

```text
optional field
```

The same rule applies to the other nullable `Usage` fields.

------

## 4.5.2 CacheCreation

When present:

```text
CacheCreation
├── ephemeral_1h_input_tokens
└── ephemeral_5m_input_tokens
```

Both are numeric token counts.

`cache_creation_input_tokens` remains the aggregate cache-creation token count.

------

## 4.5.3 OutputTokensDetails

When present:

```text
OutputTokensDetails
└── thinking_tokens
```

`thinking_tokens` is a decomposition of authoritative `output_tokens`.

Therefore:

```text
thinking_tokens
⊆
output_tokens
```

and must not be added on top of `output_tokens`.

------

## 4.5.4 ServerToolUsage

When present:

```text
ServerToolUsage
├── web_fetch_requests
└── web_search_requests
```

This records server-tool request counts.

------

## 4.5.5 Streaming Usage

`message_delta.usage` uses a separate streaming shape described in §6.11.

Its counts are cumulative.

It is not identical in field set to the final non-streaming `Usage` object.

------

# 5. Tool Protocol

## 5.1 Tool Families

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

Client and server tool loops are different protocol lifecycles and should not be collapsed.

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

## 5.2.2 Additional Tool Controls

Feature-dependent fields can include：

```text
type
cache_control
strict
allowed_callers
defer_loading
eager_input_streaming
input_examples
```

These do not change the basic client-tool identity contract.

## 5.2.3 Strict Tool Source Validity

`strict:true` client tools participate in Anthropic's structured-schema
grammar-compilation path. The documented deterministic request-wide limits
are：

```text
strict:true tools per request <= 20
optional parameters total     <= 24
union-type parameters total   <= 16
```

These are request-wide source-validity constraints, not per-tool limits. The
optional-parameter and union-parameter counters are accumulated across all
participating strict schemas in the request.

Exceeding any documented limit makes the source request invalid. This
classification occurs before any downstream converter-specific schema subset
or runtime capability check.

Anthropic may also enforce internal compiled-grammar complexity or compilation
timeout limits whose complete predicates are not publicly specified. Those
unknown predicates are not permission for a protocol consumer to invent local
source-invalidity rules.

------

# 5.3 `tool_choice`

```text
tool_choice
├── auto
├── any
├── tool
└── none
```

With optional controls such as `disable_parallel_tool_use` where defined.

------

# 5.4 Client ToolUseBlock

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

Current OpenAPI-derived shape：

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

## 5.5.2 `content` Representation Family

Current official Tool Use documentation accepts：

```text
content omitted
```

or：

```text
content = string
```

or：

```text
content = nested content-block list
```

Examples shown by the official docs include：

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01",
  "content": "15 degrees"
}
```

and：

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01",
  "content": [
    {
      "type": "text",
      "text": "15 degrees"
    }
  ]
}
```

The nested content list is itself structured：

```text
ToolResultBlock.content[]
│
├── Ordinary Result Content
│   ├── text
│   ├── image
│   ├── document
│   └── search_result
│
└── Feature-Dependent Result Content
    └── tool_reference
        └── tool-search semantics
```

`tool_reference` is not merely an OpenAPI-union artifact.

Anthropic's Tool Search protocol explicitly uses a standard client：

```text
tool_result
```

whose `content` array contains：

```text
tool_reference
```

blocks for custom client-side tool-search implementations.

Conceptual example：

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_your_tool_id",
  "content": [
    {
      "type": "tool_reference",
      "tool_name": "discovered_tool_name"
    }
  ]
}
```

This must remain distinct from Anthropic's server-side：

```text
tool_search_tool_result
```

block family.

The two structures participate in different tool lifecycles.

------

## 5.5.3 String vs Single Text Block — Evidence Boundary

For normal `MessageParam.content`, Anthropic explicitly documents：

```text
string S
=
shorthand for
[TextBlock(S)]
```

and calls the two representations equivalent.

For `ToolResultBlock.content`, the reviewed official material clearly permits both：

```text
string
```

and：

```text
nested content blocks
```

but the reviewed source does **not** contain the same explicit normative statement that：

```text
tool_result.content = string S
```

is necessarily semantically equivalent to：

```text
tool_result.content = [
  {
    type: "text",
    text: S
  }
]
```

Therefore this protocol specification records the following boundary：

> **The union shape alone does not establish string ↔ single-TextBlock semantic equivalence for `ToolResultBlock.content`.**

Until stronger source evidence or conformance establishes that equivalence for a selected source profile, it MUST NOT be inferred merely from structural similarity.

------

## 5.5.4 Omission, Empty String, and Explicit Empty Array

The following are distinct wire representations：

```text
content omitted
```

```json
{
  "content": ""
}
```

```json
{
  "content": []
}
```

Current reviewed source establishes：

```text
content is optional
content can be string
content can be an array
```

but the evidence reviewed for v0.3 does not establish a general protocol equivalence：

```text
omitted
≡
""
≡
[]
```

Therefore：

> **No equivalence among omission, explicit empty string, and explicit empty array is asserted by this specification unless the selected source profile or stronger protocol evidence explicitly establishes it.**

The existence of an array branch in the schema is not, by itself, proof that an empty array is source-valid or omission-equivalent.

------

## 5.5.5 `is_error`

```text
is_error?: boolean
```

marks a tool execution result as an error when `true`.

Its omission/default behavior is a source-protocol semantic and should be distinguished from the presence of an explicit `true`.

------

# 5.6 Client Tool Identity

```text
Assistant
└── tool_use
    └── id = X

        ↓

User
└── tool_result
    └── tool_use_id = X
```

Therefore：

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
user request
↓
assistant tool_use
↓
caller executes tool
↓
next request
user tool_result
↓
assistant continuation
```

Tool results must immediately follow their corresponding tool-use turn.

Within the user message：

```text
tool_result*
before
ordinary text*
```

------

# 5.8 Parallel Client Tool Calls

One assistant response can contain multiple `tool_use` blocks.

Correlation remains ID-based：

```text
tool_use(id=A)
tool_use(id=B)

↓

tool_result(tool_use_id=A)
tool_result(tool_use_id=B)
```

------

# 5.9 Server Tools

Server tools use a distinct lifecycle：

```text
Claude
↓
server_tool_use
↓
Anthropic infrastructure executes
↓
specialized server-tool result block
↓
Claude continues
```

Examples include：

```text
web_search_tool_result
web_fetch_tool_result
code_execution_tool_result
tool_search_tool_result
...
```

Their schemas are tool-specific and versioned.

------

# 6. Streaming Response Protocol

## 6.1 Transport

When：

```json
{
  "stream": true
}
```

Messages response uses Server-Sent Events.

Frames：

```text
event: <event-name>
data: <JSON>
```

The JSON object also contains its own `type` discriminator.

------

## 6.2 Complete Stream Hierarchy

```text
Anthropic Message Stream
│
├── message_start
│
├── ContentBlock[index]*
│   ├── content_block_start
│   ├── content_block_delta*
│   │   ├── text_delta
│   │   ├── input_json_delta
│   │   ├── thinking_delta
│   │   ├── signature_delta
│   │   ├── citations_delta
│   │   └── future delta variants
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

# 6.3 `message_start`

Begins an incomplete partial `Message`.

The `message` field uses the same current `Message` output contract, with initial streaming values such as empty content and null termination state:

```text
message_start
└── message
    ├── id
    ├── container
    │   └── Container | null
    ├── content = []
    ├── model
    ├── role = "assistant"
    ├── stop_details = null
    ├── stop_reason = null
    ├── stop_sequence = null
    ├── type = "message"
    └── usage
        └── current Usage shape
```

Because the embedded object is a `Message`, required nullable fields remain part of the object even when their initial value is `null`.

------

# 6.4 Content Block Lifecycle

Each block is keyed by integer `index`：

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

`index` corresponds to final `Message.content[index]`.

------

# 6.5 `content_block_start`

Contains:

```text
index
content_block
```

`content_block` is an output content block variant, so its required output fields apply at block start.

Examples include:

```text
text start
└── TextBlock
    ├── citations
    │   └── TextCitation[] | null
    ├── text
    └── type = "text"
```

and:

```text
tool_use start
└── ToolUseBlock
    ├── id
    ├── caller
    ├── input
    ├── name
    └── type = "tool_use"
```

The block discriminator determines which delta variants are semantically valid.

------

# 6.6 `content_block_delta`

General：

```text
content_block_delta
├── index
└── delta
    ├── type
    └── type-specific fields
```

## 6.6.1 Text Delta

`text_delta.text` is incremental, not cumulative.

## 6.6.2 Tool Input JSON Delta

```text
input_json_delta.partial_json
```

is partial serialized JSON syntax.

It is not the completed semantic tool input.

Final `tool_use.input` is an object.

## 6.6.3 Thinking Delta

Incremental thinking text.

## 6.6.4 Signature Delta

Carries opaque thinking signature data.

## 6.6.5 Citation Delta

Updates citation state separately from ordinary text content.

------

# 6.7 Text Streaming Lifecycle

```text
content_block_start(text)
↓
text_delta*
↓
content_block_stop
```

Completed text is the ordered concatenation of text deltas for that block.

------

# 6.8 Tool-Use Streaming Lifecycle

```text
content_block_start(tool_use)
↓
input_json_delta*
↓
content_block_stop
↓
completed tool_use.input
```

Partial JSON fragments are temporary transport/parser state, not completed tool calls.

------

# 6.9 Thinking Streaming Lifecycle

Normal：

```text
content_block_start(thinking)
↓
thinking_delta*
↓
signature_delta
↓
content_block_stop
```

For omitted display, thinking text deltas may be absent while signature continuity remains.

------

# 6.10 `content_block_stop`

Closes the block at the given `index`.

------

# 6.11 `message_delta`

`message_delta` updates message-level state and cumulative streaming usage.

Current hierarchy:

```text
message_delta
│
├── delta
│   ├── container
│   │   └── Container | null
│   ├── stop_details
│   │   └── RefusalStopDetails | null
│   ├── stop_reason
│   │   └── StopReason | null
│   └── stop_sequence
│       └── string | null
│
└── usage
    └── MessageDeltaUsage
```

The four `delta` fields are part of the current delta object even when their value is `null`.

### 6.11.1 MessageDeltaUsage

Current streaming usage shape:

```text
MessageDeltaUsage
├── cache_creation_input_tokens
│   └── number | null
├── cache_read_input_tokens
│   └── number | null
├── input_tokens
│   └── number | null
├── output_tokens
│   └── number
├── output_tokens_details
│   └── OutputTokensDetails | null
└── server_tool_use
    └── ServerToolUsage | null
```

These values are cumulative.

`MessageDeltaUsage` is not the same object shape as final `Usage`; for example, it does not carry final `inference_geo` or `service_tier` fields.

------

# 6.12 `ping`

Auxiliary event.

Does not mutate Message content.

------

# 6.13 `message_stop`

Normal successful semantic terminal：

```text
message_stop
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

There is no trailing `[DONE]` requirement.

------

# 6.14 Stream Error

A streaming HTTP response can fail after HTTP `200`.

Therefore：

```text
HTTP 200
≠
guaranteed successful Message completion
```

An SSE `error` event is a stream failure, not successful terminal completion.

------

# 7. Termination and Error Protocol

## 7.1 Successful Message Termination

Current documented stop-reason family tracked by this spec：

```text
end_turn
max_tokens
stop_sequence
tool_use
pause_turn
refusal
model_context_window_exceeded
```

These are Message termination semantics, not all HTTP error classes.

------

## 7.2 `end_turn`

Natural completion.

## 7.3 `max_tokens`

Requested/model output limit reached.

## 7.4 `stop_sequence`

Configured custom stop sequence matched.

## 7.5 `tool_use`

Claude emitted one or more client tool calls and expects tool results.

## 7.6 `pause_turn`

Server-tool workflow paused and requires continuation in another Messages turn.

## 7.7 `refusal`

A refusal is a successful HTTP response, not an HTTP processing error.

Canonical termination:

```text
stop_reason = "refusal"
```

Current refusal responses also carry structured refusal information through:

```text
stop_details
└── RefusalStopDetails
    ├── type = "refusal"
    ├── category
    └── explanation
```

Current documented categories include:

```text
cyber
bio
frontier_llm
reasoning_extraction
general_harms
```

with `category` itself nullable.

`explanation` is also nullable and is not guaranteed to be stable text.

For current refusal semantics:

```text
stop_reason = "refusal"
→ stop_details is present as RefusalStopDetails
```

For stop reasons other than `refusal`:

```text
stop_details = null
```

Streaming refusals deliver `stop_details` on `message_delta` alongside `stop_reason`.

## 7.8 `model_context_window_exceeded`

Generation reached the model context capacity before ordinary completion.

## 7.9 `stop_sequence`

`string | null`; contains the matched sequence when appropriate.

------

# 7.10 HTTP Error Response

Conceptual：

```text
ErrorResponse
├── type = "error"
├── error
│   ├── type
│   └── message
└── request_id
```

Current error families include：

| HTTP | `error.type` |
|---|---|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 402 | `billing_error` |
| 403 | `permission_error` |
| 404 | `not_found_error` |
| 409 | `conflict_error` |
| 413 | `request_too_large` |
| 429 | `rate_limit_error` |
| 500 | `api_error` |
| 504 | `timeout_error` |
| 529 | `overloaded_error` |

Anthropic may add new error types under its versioning policy.

------

## 7.11 Request Size

Current Messages request-size limit tracked by this spec：

```text
32 MB
```

Oversized requests produce `413 request_too_large`.

------

## 7.12 Request ID

Responses carry opaque request identity for diagnostics.

It must not be interpreted as conversational semantic state.

------

# 8. Protocol Invariants

## 8.1 Message Ordering

`messages[]` is ordered conversation history.

Turn order is semantic.

------

## 8.2 Content Ordering

`Message.content[]` is ordered.

For streaming：

```text
content_block index
=
final content[] index
```

------

## 8.3 Tool Identity

```text
tool_use.id
=
tool_result.tool_use_id
```

This cross-turn identity must be preserved.

------

## 8.4 Tool Result Placement

```text
assistant tool_use
↓
immediately following user message
↓
matching tool_result
```

Inside the user message：

```text
tool_result*
before
ordinary text*
```

------

## 8.5 Partial Tool Input Is Not Complete Input

```text
input_json_delta.partial_json
≠
completed tool_use.input
```

------

## 8.6 Thinking Signature Is Opaque

Do not parse or regenerate opaque continuity signatures.

------

## 8.7 Omitted and Redacted Thinking Are Different

A normal thinking block with empty visible thinking plus signature is not a `redacted_thinking` block.

------

## 8.8 Usage Is Not Event-Delta Accounting

`message_delta.usage` is cumulative.

Thinking-token breakdown does not add on top of authoritative output-token total.

------

## 8.9 Streaming Success Terminal

Normal semantic completion requires：

```text
message_stop
```

Physical EOF before `message_stop` does not establish documented success.

------

## 8.10 HTTP 200 Is Not Stream Success

HTTP success only establishes transition into streaming transport.

Final semantic success depends on the SSE lifecycle.

------

## 8.11 Unknown vs Malformed

Distinguish：

```text
unknown future variant
```

from：

```text
known variant
with malformed required structure
```

Protocol extensibility does not make malformed known variants valid.

------

## 8.12 Request-Semantic Headers Are Protocol Inputs

A Messages request may carry Anthropic semantics outside the JSON body.

Therefore：

> **Protocol-defined semantic headers are part of the source request semantic surface and must not be treated as arbitrary HTTP transport metadata.**

Current example：

```text
anthropic-user-profile-id
```

which affects request attribution and is beta-gated.

This invariant does not imply every HTTP header is semantic.

------

## 8.13 Alternate Representations Require Protocol Authority

A union type alone does not prove semantic equivalence between its branches.

Example：

```text
string | ContentBlock[]
```

does not by itself imply：

```text
string S
≡
[TextBlock(S)]
```

For ordinary message content, Anthropic explicitly provides that equivalence.

For `ToolResultBlock.content`, v0.4 records both accepted representation families but does not infer the same equivalence without stronger source authority.

------

## 8.14 Omission and Explicit Presence Are Distinct Unless Defined Otherwise

Protocol consumers should distinguish：

```text
field omitted
```

from explicit values such as：

```text
""
[]
false
0
```

unless the protocol explicitly defines an equivalence/default relationship.

This is especially relevant to `ToolResultBlock.content`.

------


## 8.15 Required-Nullable Is Not Optional

Current Anthropic output schemas distinguish:

```text
field?: T
```

from:

```text
field: T | null
```

The second form requires field presence even when the semantic value is `null`.

This distinction applies to current response structures including:

```text
Message.container
Message.stop_details

TextBlock.citations

Usage nullable fields

RawMessageDeltaEvent.delta nullable fields

MessageDeltaUsage nullable fields
```

Protocol consumers and protocol-compatible renderers must not silently replace:

```text
required + null
```

with:

```text
field omitted
```

unless a later protocol profile explicitly changes the contract.

------

# Appendix A. Model-Dependent Protocol Features

This appendix records structures whose availability/default behavior depends on selected model.

## A.1 Mid-Conversation System Messages

The stable baseline is：

```text
top-level system
+
messages[user|assistant]
```

The project source evidence also tracks model-dependent mid-conversation system-message support.

Its placement and availability are model-dependent and should not be assumed universal.

## A.2 Thinking Modes

Structural modes and actual selected-model capability are separate facts.

## A.3 Thinking Display Defaults

Display defaults can differ by model.

## A.4 Effort Levels

Not every effort-capable model supports every level.

## A.5 Sampling Controls

Field existence does not imply universal model support.

------

# Appendix B. Extension Content Families

The current request/response protocol is broader than：

```text
text
image
thinking
tool_use
tool_result
```

Families include：

```text
document
search_result
server_tool_use
web-search results
web-fetch results
code-execution results
tool-search results
container/tool extensions
thinking/redacted-thinking
future variants
```

These remain distinct tagged variants.

------

# Appendix C. Complete Request Tree

```text
Anthropic HTTP Request
│
├── Headers
│   │
│   ├── Authentication
│   │   ├── x-api-key
│   │   └── Authorization
│   │
│   ├── Protocol Profile
│   │   ├── anthropic-version
│   │   └── anthropic-beta?
│   │
│   └── Request Semantics
│       ├── anthropic-user-profile-id?
│       └── future protocol-defined semantic headers
│
└── MessageRequest
    │
    ├── model
    ├── max_tokens
    │
    ├── Conversation
    │   ├── system?
    │   └── messages[]
    │       ├── role
    │       │   ├── user
    │       │   ├── assistant
    │       │   └── system*      # model-dependent extension
    │       └── content
    │           ├── string
    │           └── ContentBlockParam[]
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
    │
    ├── Output
    │   └── output_config?
    │
    ├── Sampling / Stop
    │   ├── stop_sequences?
    │   ├── temperature?
    │   ├── top_p?
    │   └── top_k?
    │
    └── Runtime / Metadata
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
├── Runtime
│   └── container
│       └── Container | null
│
├── content[]
│   ├── TextBlock
│   │   ├── citations
│   │   ├── text
│   │   └── type = "text"
│   ├── ThinkingBlock
│   ├── RedactedThinkingBlock
│   ├── ToolUseBlock
│   │   ├── id
│   │   ├── caller
│   │   ├── input
│   │   ├── name
│   │   └── type = "tool_use"
│   ├── ServerToolUseBlock
│   └── ExtensionBlock
│
├── Termination
│   ├── stop_reason
│   ├── stop_sequence
│   └── stop_details
│       └── RefusalStopDetails | null
│
└── Usage
    ├── cache_creation
    ├── cache_creation_input_tokens
    ├── cache_read_input_tokens
    ├── inference_geo
    ├── input_tokens
    ├── output_tokens
    ├── output_tokens_details
    ├── server_tool_use
    └── service_tier
```

Required nullable fields remain present when their value is `null`.

------

# Appendix E. Complete Streaming Tree

```text
Anthropic SSE Message Stream
│
├── message_start
│   └── Message
│       ├── container
│       ├── content = []
│       ├── stop_details = null
│       ├── stop_reason = null
│       ├── stop_sequence = null
│       └── usage
│
├── ContentBlock[index]*
│   ├── content_block_start
│   │   └── complete output-block start shape
│   ├── content_block_delta*
│   │   ├── text_delta
│   │   ├── input_json_delta
│   │   ├── thinking_delta
│   │   ├── signature_delta
│   │   ├── citations_delta
│   │   └── future delta variants
│   └── content_block_stop
│
├── message_delta+
│   ├── delta
│   │   ├── container
│   │   ├── stop_details
│   │   ├── stop_reason
│   │   └── stop_sequence
│   └── MessageDeltaUsage
│       ├── cache_creation_input_tokens
│       ├── cache_read_input_tokens
│       ├── input_tokens
│       ├── output_tokens
│       ├── output_tokens_details
│       └── server_tool_use
│
└── message_stop

Auxiliary
└── ping*

Failure
└── error
```

Normal semantic terminal:

```text
message_stop
```

not:

```text
[DONE]
```

------

# Appendix F. v0.4 Evidence Boundaries

This appendix records places where the source structure is established but semantic equivalence is intentionally not inferred.

## F.1 `ToolResultBlock.content`

Established by current reviewed official documentation：

```text
content is optional

content may be string

content may be a nested content-block list
```

Not established by the reviewed material as an explicit normative equivalence：

```text
string S
≡
[TextBlock(S)]
```

for `ToolResultBlock.content`.

Therefore v0.4 does not assert it.

## F.2 Explicit Empty ToolResult Array

Current source evidence is stronger than the bare union shape.

Anthropic's official `claude-quickstarts` computer-use demo constructs a beta `tool_result` with：

```text
content: []
```

when a tool execution produces neither textual output nor an image.

Therefore the reviewed evidence establishes at least：

```text
explicit [] is used by an official Anthropic client example
in at least one beta tool-result path
```

However, that example does **not** by itself establish：

```text
1. universal source-validity of []
   across every Messages source profile

or

2. semantic equivalence:
   content: []
   ≡
   content omitted
```

Therefore v0.4 records explicit `[]` as an evidenced representation in at least one beta path, while leaving its universal validity and omission-equivalence profile-dependent until stronger protocol authority establishes them.


## F.3 Protocol Evolution

If later authoritative source evidence establishes either equivalence, this Protocol Spec should be updated at the protocol layer before downstream conversion specs rely on it as source truth.
