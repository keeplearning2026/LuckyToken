# Pi AI Semantic IR and Runtime Contract

**Upstream Repository:** `earendil-works/pi`
**Module:** `packages/ai`
**Package:** `@earendil-works/pi-ai`
**Inspected Version:** `0.84.1`
**Source Baseline:** `936aff00918de1187f085f123c2812d8f2d67745`
**Scope:** Chat/model semantic IR, streaming events, tools, execution options, and the `Models` / `Provider` runtime boundary.

This document is intended to be an **implementation contract for LuckyToken**.

It describes the actual semantic types and runtime behavior exposed by `packages/ai`.

It does **not** describe:

- Anthropic wire format;
- OpenAI wire format;
- CommandCode wire format;
- protocol-to-protocol conversion rules;
- Pi Coding Agent session/TUI behavior;
- image-generation APIs.

Those concerns belong in separate specifications.

------

# 1. Protocol Overview

## 1.1 Pi AI is not a wire protocol

Pi AI does not expose one universal HTTP request format.

Instead, it defines a provider-neutral semantic invocation:

```text
Pi Invocation
│
├── Model
├── Context
└── Options
        │
        ▼
Models / Provider
        │
        ▼
Provider API Adapter
        │
        ▼
AssistantMessageEventStream
        │
        ▼
AssistantMessage
```

The provider adapter is responsible for turning this semantic representation into an actual upstream protocol such as:

```text
anthropic-messages
openai-responses
openai-completions
google-generative-ai
bedrock-converse-stream
...
```

The semantic types themselves remain provider-neutral.

------

## 1.2 Core semantic contract

For LuckyToken, the most important abstraction is:

```text
Model
+
Context
+
SimpleStreamOptions
        │
        ▼
AssistantMessageEventStream
        │
        ▼
AssistantMessage
```

This can be viewed as:

```text
REQUEST-SIDE IR
├── Model
├── Context
│   ├── systemPrompt
│   ├── messages[]
│   └── tools[]
└── Options

RESPONSE-SIDE IR
├── AssistantMessageEventStream
└── AssistantMessage
```

`Models`, `Provider`, authentication, credentials, model discovery, and provider dispatch surround this IR as runtime infrastructure rather than conversational state.

------

## 1.3 Main implementation boundary for LuckyToken

A clean protocol conversion architecture is:

```text
Client Wire
    │
    ▼
Client Protocol Parser
    │
    ▼
Pi Semantic IR
├── Model
├── Context
└── Options
    │
    ▼
Pi Runtime
    │
    ▼
AssistantMessage / Events
    │
    ▼
Client Protocol Renderer
    │
    ▼
Client Wire
```

Therefore protocol adapters should normally produce:

```text
Model
Context
Options
```

and consume:

```text
AssistantMessageEvent
AssistantMessage
```

They should not need to know the provider's HTTP representation.

------

# 2. Invocation Contract

## 2.1 Unified entry points

Pi exposes two levels of text-generation API.

### Provider-neutral simplified API

```ts
models.streamSimple(
  model,
  context,
  options?,
): AssistantMessageEventStream
```

and:

```ts
models.completeSimple(
  model,
  context,
  options?,
): Promise<AssistantMessage>
```

`SimpleStreamOptions` exposes Pi's normalized reasoning model and common request options.

This is usually the appropriate abstraction for a multi-provider protocol router.

------

### API-specific API

```ts
models.stream(
  model,
  context,
  options?,
): AssistantMessageEventStream
```

and:

```ts
models.complete(
  model,
  context,
  options?,
): Promise<AssistantMessage>
```

The options are selected according to:

```text
model.api
```

and can expose API-specific controls.

Pi's `ApiOptionsMap` performs this type-level mapping.

------

## 2.2 Invocation hierarchy

```text
streamSimple()
│
├── model
│   └── Model<Api>
│
├── context
│   └── Context
│
└── options?
    └── ModelsSimpleStreamOptions
        │
        ▼
AssistantMessageEventStream
```

`Models.streamSimple()` returns the stream **synchronously**.

Authentication resolution and other asynchronous setup may occur behind that stream through `lazyStream()`.

------

## 2.3 `completeSimple()`

Conceptually:

```text
completeSimple(...)
↓
streamSimple(...)
↓
stream.result()
↓
AssistantMessage
```

The important consequence is:

> `completeSimple()` returning an `AssistantMessage` does not by itself mean the generation succeeded.

An error or abort is also represented by an `AssistantMessage`.

Success must be determined from:

```text
AssistantMessage.stopReason
```

This behavior follows directly from `AssistantMessageEventStream.result()`, which extracts the final message from **both** `done` and `error` terminal events.

------

# 3. Model

## 3.1 Model hierarchy

```text
Model<Api>
│
├── Identity
│   ├── id
│   ├── name
│   ├── provider
│   └── api
│
├── Endpoint
│   └── baseUrl
│
├── Capabilities
│   ├── reasoning
│   └── input[]
│       ├── text
│       └── image
│
├── Reasoning Mapping
│   └── thinkingLevelMap?
│
├── Limits
│   ├── contextWindow
│   └── maxTokens
│
├── Pricing
│   └── cost
│
├── Sampling Defaults
│   └── samplingParams?
│
├── Request Defaults
│   └── headers?
│
└── API Compatibility
    └── compat?
```

The actual model type is defined directly in `packages/ai/src/types.ts`.

------

## 3.2 Model field contract

```ts
interface Model<TApi extends Api> {
  id: string
  name: string

  api: TApi
  provider: ProviderId

  baseUrl: string

  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap

  input: ("text" | "image")[]

  cost: ModelCost

  contextWindow: number
  maxTokens: number

  samplingParams?: Record<string, unknown>

  headers?: Record<string, string>

  compat?: ...
}
```

Field semantics:

| Field              | Type    | Meaning                                 |
| ------------------ | ------- | --------------------------------------- |
| `id`               | string  | model identifier within its provider    |
| `name`             | string  | human-readable name                     |
| `api`              | `Api`   | upstream API implementation             |
| `provider`         | string  | provider owning the model               |
| `baseUrl`          | string  | effective base endpoint                 |
| `reasoning`        | boolean | model supports reasoning                |
| `thinkingLevelMap` | map     | normalized → provider reasoning mapping |
| `input`            | array   | supported generic input modalities      |
| `cost`             | object  | normalized pricing                      |
| `contextWindow`    | number  | model context limit                     |
| `maxTokens`        | number  | model output-token capability           |
| `samplingParams`   | object  | model default sampling parameters       |
| `headers`          | object  | static model request headers            |
| `compat`           | object  | API-family compatibility overrides      |

------

## 3.3 Model identity

Pi separates three identities:

```text
Provider
└── provider

API implementation
└── api

Model inside provider
└── id
```

For example, conceptually:

```text
provider = "openrouter"
api      = "openai-completions"
id       = "anthropic/claude-..."
```

These fields should not be collapsed into one synthetic model string inside LuckyToken.

------

## 3.4 `Api`

Current built-in API identifiers are:

```text
openai-completions
mistral-conversations
openai-responses
azure-openai-responses
openai-codex-responses
anthropic-messages
bedrock-converse-stream
google-generative-ai
google-vertex
pi-messages
```

However the type is:

```ts
type Api = KnownApi | (string & {})
```

Therefore custom API identifiers are explicitly supported.

The semantic IR must not use a closed enum that rejects every future/custom API identifier.

------

## 3.5 Provider identity

Likewise:

```ts
type ProviderId = KnownProvider | string
```

Provider IDs are extensible strings.

A new custom provider therefore does not require modifying the core semantic message types.

------

## 3.6 Model input capabilities

Generic model input capability is currently:

```text
Model.input[]
├── text
└── image
```

Example:

```ts
input: ["text", "image"]
```

This is a coarse generic capability declaration.

Provider-specific content types do not automatically become generic `Model.input` variants.

------

## 3.7 Reasoning capability

```text
reasoning: boolean
```

indicates whether the model supports reasoning/thinking.

Normalized Pi reasoning levels are:

```text
ThinkingLevel
├── minimal
├── low
├── medium
├── high
├── xhigh
└── max
```

Model-level mappings additionally include:

```text
off
```

through:

```ts
type ModelThinkingLevel =
  | "off"
  | ThinkingLevel
```

------

## 3.8 `thinkingLevelMap`

Type:

```ts
type ThinkingLevelMap =
  Partial<Record<ModelThinkingLevel, string | null>>
```

Semantics:

```text
key missing
→ provider/default behavior

key = string
→ map Pi level to this provider/model value

key = null
→ model explicitly does not support this level
```

Example conceptually:

```ts
{
  low: "low",
  medium: "medium",
  high: "high",
  max: null
}
```

`thinkingLevelMap` belongs to model capability/configuration, not conversational context.

------

## 3.9 Limits

```text
Model
└── Limits
    ├── contextWindow
    └── maxTokens
```

Both are model-level characteristics.

They must be distinguished from request option:

```text
Options.maxTokens
```

which is a per-invocation control.

------

## 3.10 Pricing

Structure:

```text
Model.cost
│
├── input
├── output
├── cacheRead
├── cacheWrite
│
└── tiers?
    └── ModelCostTier[]
        ├── inputTokensAbove
        ├── input
        ├── output
        ├── cacheRead
        └── cacheWrite
```

Rates are represented as dollars per million tokens.

A pricing tier applies to the whole request when its input threshold is selected; the highest matching threshold applies.

------

# 4. Context and Message IR

## 4.1 Context hierarchy

```text
Context
│
├── systemPrompt?
│
├── messages[]
│   ├── UserMessage
│   ├── AssistantMessage
│   └── ToolResultMessage
│
└── tools[]?
    └── Tool
```

Exact type:

```ts
interface Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
}
```

------

## 4.2 Semantic meaning of Context

`Context` represents **what is presented to the model**:

```text
Context
├── system instruction
├── ordered conversation history
└── tool definitions
```

It deliberately does not contain:

```text
provider credential
HTTP headers
base URL
request timeout
retry settings
telemetry
AbortController
model selection
```

Those belong to `Model`, `Options`, or runtime infrastructure.

This is an important information boundary for LuckyToken.

------

## 4.3 System prompt

```ts
systemPrompt?: string
```

Pi has one normalized system-prompt string.

There is no ordinary core:

```text
role = "system"
```

message variant in the `Message` union.

A source protocol with structured or mid-conversation system semantics therefore requires an explicit conversion policy; it cannot simply be copied into a nonexistent Pi `SystemMessage`.

------

## 4.4 Message hierarchy

```text
Message
├── UserMessage
├── AssistantMessage
└── ToolResultMessage
```

Exact union:

```ts
type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
```

------

## 4.5 Parent/content matrix

The semantic content relationship is:

| Message             | Text | Image | Thinking | ToolCall |
| ------------------- | ---- | ----- | -------- | -------- |
| `UserMessage`       | yes  | yes   | no       | no       |
| `AssistantMessage`  | yes  | no    | yes      | yes      |
| `ToolResultMessage` | yes  | yes   | no       | no       |

This parent relationship should be preserved rather than introducing one universal content array that permits every block everywhere.

------

## 4.6 UserMessage

Tree:

```text
UserMessage
├── role = "user"
├── content
│   ├── string
│   └── (TextContent | ImageContent)[]
└── timestamp
```

Exact type:

```ts
interface UserMessage {
  role: "user"

  content:
    | string
    | (TextContent | ImageContent)[]

  timestamp: number
}
```

`timestamp` is Unix time in milliseconds.

------

## 4.7 User string shorthand

Pi allows:

```ts
{
  role: "user",
  content: "Hello",
  timestamp: Date.now()
}
```

as well as:

```ts
{
  role: "user",
  content: [
    {
      type: "text",
      text: "Hello"
    }
  ],
  timestamp: Date.now()
}
```

A conversion implementation should choose one stable internal form where useful but must understand both legal `UserMessage.content` representations.

------

## 4.8 Content hierarchy

Core semantic content types are:

```text
Semantic Content
├── TextContent
├── ImageContent
├── ThinkingContent
└── ToolCall
```

These are not all valid under every message parent.

------

## 4.9 TextContent

Tree:

```text
TextContent
├── type = "text"
├── text
└── textSignature?
```

Exact type:

```ts
interface TextContent {
  type: "text"
  text: string
  textSignature?: string
}
```

`textSignature` is provider continuity/message metadata rather than user-visible text.

Pi also defines:

```ts
interface TextSignatureV1 {
  v: 1
  id: string
  phase?: "commentary" | "final_answer"
}
```

The `TextContent` field itself remains a string because providers may carry other/legacy signature forms.

------

## 4.10 ImageContent

Tree:

```text
ImageContent
├── type = "image"
├── data
└── mimeType
```

Exact type:

```ts
interface ImageContent {
  type: "image"
  data: string
  mimeType: string
}
```

Critical representation rule:

```text
data
=
base64 encoded image bytes
```

It is **not** a complete data URL.

Correct:

```ts
{
  type: "image",
  data: "iVBORw0KGgo...",
  mimeType: "image/png"
}
```

Not Pi-native:

```text
data:image/png;base64,iVBORw0KGgo...
```

The latter must be decoded/split by a conversion layer before becoming `ImageContent`.

------

## 4.11 ThinkingContent

Tree:

```text
ThinkingContent
├── type = "thinking"
├── thinking
├── thinkingSignature?
└── redacted?
```

Exact type:

```ts
interface ThinkingContent {
  type: "thinking"
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}
```

------

## 4.12 Normal vs redacted thinking

Pi does not define two separate semantic content types.

Instead:

```text
Normal Thinking
└── ThinkingContent
    ├── thinking = text
    ├── thinkingSignature?
    └── redacted absent/false
```

and:

```text
Redacted Thinking
└── ThinkingContent
    ├── thinking
    ├── thinkingSignature
    └── redacted = true
```

The source explicitly documents that an opaque encrypted redacted payload may be stored in:

```text
thinkingSignature
```

so it can be replayed to the provider later.

Therefore an Anthropic `redacted_thinking` block maps to a **state of Pi `ThinkingContent`**, not a separate Pi content class.

That mapping itself belongs in the Anthropic → Pi conversion spec.

------

## 4.13 AssistantMessage as conversation history

`AssistantMessage` is both:

1. the final output of an invocation; and
2. a valid previous message inside the next `Context.messages`.

This is intentional.

Typical lifecycle:

```text
Context
└── UserMessage

        ↓ generate

AssistantMessage

        ↓ append

Context.messages
├── UserMessage
└── AssistantMessage
```

Pi's own examples use this exact pattern.

------

## 4.14 Aborted/error assistant history

Even an aborted `AssistantMessage` can technically be appended to context and continued.

Pi's README explicitly demonstrates continuing after an aborted partial response.

That is a Pi capability.

A higher-level application such as LuckyToken may deliberately choose a stricter atomic policy and discard failed/aborted partial responses instead.

That is an application/runtime policy, not a Pi IR restriction.

------

# 5. Tool Semantic Protocol

## 5.1 Tool hierarchy

Pi separates:

```text
Tool Protocol
│
├── Definition
│   └── Context.tools[]
│
├── Model Invocation
│   └── AssistantMessage
│       └── ToolCall
│
└── Execution Result
    └── ToolResultMessage
```

This mirrors the semantic tool lifecycle rather than provider-specific wire formats.

------

## 5.2 Tool definition

Exact generic type:

```ts
interface Tool<TParameters extends TSchema = TSchema> {
  name: string
  description: string
  parameters: TParameters

  constrainedSampling?:
    | false
    | ConstrainedSamplingConfig
}
```

Tool schemas use TypeBox `TSchema`.

Pi re-exports:

```text
Type
Static
TSchema
```

from its public core entrypoint.

------

## 5.3 Tool tree

```text
Tool
├── name
├── description
├── parameters
│   └── TypeBox schema
│
└── constrainedSampling?
```

Unlike some wire protocols, Pi's generic Tool does not have:

```text
type = "function"
```

as part of the normal semantic definition.

------

## 5.4 Constrained sampling

Pi supports:

```text
constrainedSampling
├── false
│
├── json_schema
│   ├── type = "json_schema"
│   └── strict
│       ├── prefer
│       └── require
│
└── grammar
    ├── type = "grammar"
    └── variants
        ├── openai_lark?
        └── openai_regex?
```

Exact union:

```ts
type ConstrainedSamplingConfig =
  | {
      type: "json_schema"
      strict: "prefer" | "require"
    }
  | {
      type: "grammar"
      variants: Partial<
        Record<
          "openai_lark" | "openai_regex",
          string
        >
      >
    }
```

This describes semantic intent/capability.

Individual provider adapters determine whether and how it can be represented upstream.

------

## 5.5 ToolCall

Tree:

```text
ToolCall
├── type = "toolCall"
│
├── Identity
│   ├── id
│   ├── name
│   └── namespace?
│
├── Input
│   └── arguments
│
└── Provider Continuity
    └── thoughtSignature?
```

Exact type:

```ts
interface ToolCall {
  type: "toolCall"

  id: string
  name: string

  arguments: Record<string, any>

  thoughtSignature?: string
  namespace?: string
}
```

------

## 5.6 Tool identity

```text
AssistantMessage
└── ToolCall
    └── id = X
         │
         ▼
ToolResultMessage
└── toolCallId = X
```

Therefore:

```text
ToolCall.id
=
ToolResultMessage.toolCallId
```

is the core cross-turn identity invariant.

A protocol conversion must preserve this identity.

------

## 5.7 Tool arguments

Completed semantic arguments are:

```ts
arguments: Record<string, any>
```

A completed `ToolCall` therefore does not contain raw partial JSON syntax.

However, during stream generation the partial `ToolCall` object can contain partially parsed arguments.

The stream lifecycle distinguishes this from a complete call.

------

## 5.8 `thoughtSignature`

```ts
thoughtSignature?: string
```

is opaque provider continuity metadata.

The source specifically notes Google-style thought context as one use.

LuckyToken should preserve it when round-tripping Pi messages but should not interpret its contents.

------

## 5.9 `namespace`

```ts
namespace?: string
```

supports namespaced or dynamically loaded tool semantics such as OpenAI Responses tools.

Again, this is semantic/provider continuity data, not part of ordinary tool arguments.

------

## 5.10 ToolResultMessage

Tree:

```text
ToolResultMessage
├── role = "toolResult"
│
├── Identity
│   ├── toolCallId
│   └── toolName
│
├── content[]
│   ├── TextContent
│   └── ImageContent
│
├── Result State
│   └── isError
│
├── Optional Metadata
│   ├── details?
│   ├── usage?
│   └── addedToolNames?
│
└── timestamp
```

Exact type:

```ts
interface ToolResultMessage<TDetails = any> {
  role: "toolResult"

  toolCallId: string
  toolName: string

  content: (TextContent | ImageContent)[]

  details?: TDetails

  usage?: Usage

  addedToolNames?: string[]

  isError: boolean

  timestamp: number
}
```

------

## 5.11 `isError`

```text
false
→ normal tool result

true
→ tool execution failed
```

Pi represents failure as structured state on the tool-result message rather than a separate error-message role.

------

## 5.12 Tool result usage

```ts
usage?: Usage
```

represents usage generated by the **tool execution itself** where available.

The source explicitly states this is not part of main LLM context accounting.

------

## 5.13 Deferred tool loading

```ts
addedToolNames?: string[]
```

means that named tools from:

```text
Context.tools
```

became available after this tool result.

Providers with native deferred tool loading may use this as the load point.

Other providers may ignore it and treat all `Context.tools` as normally available.

------

# 6. Invocation Options

## 6.1 Options hierarchy

For the simplified API:

```text
ModelsSimpleStreamOptions
│
├── Request Lifecycle
│   ├── signal?
│   ├── timeoutMs?
│   ├── maxRetries?
│   └── maxRetryDelayMs?
│
├── Authentication / Provider Environment
│   ├── apiKey?
│   ├── env?
│   └── headers?
│
├── HTTP / Transport
│   ├── fetch?
│   ├── transport?
│   └── websocketConnectTimeoutMs?
│
├── Generation
│   ├── temperature?
│   ├── samplingParams?
│   └── maxTokens?
│
├── Reasoning
│   ├── reasoning?
│   └── thinkingBudgets?
│
├── Cache / Session
│   ├── cacheRetention?
│   └── sessionId?
│
├── Deferred Execution
│   └── deferred?
│
├── Metadata / Telemetry
│   ├── metadata?
│   └── telemetryContext?
│
├── Hooks
│   ├── onPayload?
│   └── onResponse?
│
└── Models-Level Transformation
    └── transformHeaders?
```

The majority of these fields come from `ProviderRequestOptions`, `StreamOptions`, and `SimpleStreamOptions`; `transformHeaders` is added at the `Models` collection boundary.

------

## 6.2 ProviderRequestOptions

Core structure:

```ts
interface ProviderRequestOptions {
  signal?: AbortSignal

  telemetryContext?: TelemetryContext

  apiKey?: string
  fetch?: typeof globalThis.fetch

  env?: Record<string, string>

  onPayload?: (...)
  onResponse?: (...)

  headers?: Record<string, string | null>

  timeoutMs?: number
  maxRetries?: number
  maxRetryDelayMs?: number
}
```

------

## 6.3 `signal`

```ts
signal?: AbortSignal
```

This is the primary request cancellation mechanism.

LuckyToken should pass its request-lifetime cancellation signal directly into Pi rather than invent a second provider-specific cancellation channel.

------

## 6.4 `apiKey`

```ts
apiKey?: string
```

This is an explicit per-request auth override.

At the `Models` runtime boundary:

```text
explicit options.apiKey
→ wins over resolved provider auth apiKey
```

For ordinary application operation, provider auth can instead be resolved by `Models`.

------

## 6.5 `env`

```ts
env?: Record<string, string>
```

Provider-scoped environment overrides.

These take precedence over ambient environment values used during provider resolution.

They are execution configuration, not model-visible context.

------

## 6.6 `headers`

Type:

```ts
Record<string, string | null>
```

Semantics:

```text
string
→ set/override header

null
→ suppress provider/API default header with same name
```

Header merging is case-insensitive at the `Models` layer.

------

## 6.7 `fetch`

Optional custom HTTP implementation:

```ts
fetch?: typeof globalThis.fetch
```

Default:

```text
globalThis.fetch
```

It only applies to provider adapters capable of injecting a custom fetch implementation.

It does not control WebSocket transports.

------

## 6.8 Lifecycle controls

```text
timeoutMs
maxRetries
maxRetryDelayMs
```

are common request controls where the underlying provider/API supports them.

`maxRetryDelayMs` has a documented default of:

```text
60000 ms
```

Setting it to:

```text
0
```

disables the retry-delay cap.

------

## 6.9 StreamOptions

Additional stream options:

```ts
interface StreamOptions {
  temperature?: number
  samplingParams?: Record<string, unknown>
  maxTokens?: number

  transport?:
    | "sse"
    | "websocket"
    | "websocket-cached"
    | "auto"

  cacheRetention?:
    | "none"
    | "short"
    | "long"

  sessionId?: string

  websocketConnectTimeoutMs?: number

  metadata?: Record<string, unknown>
}
```

------

## 6.10 `maxTokens`

```ts
maxTokens?: number
```

is a request-level generation limit.

It is separate from:

```text
Model.maxTokens
```

which describes model capability/default metadata.

A protocol adapter should not confuse these two layers.

------

## 6.11 `samplingParams`

```ts
samplingParams?: Record<string, unknown>
```

is a generic escape hatch for OpenAI-compatible endpoints.

The source documents examples such as:

```text
top_p
top_k
min_p
repetition_penalty
```

Per-request keys override:

```text
Model.samplingParams
```

for adapters that support this generic mechanism.

Other API families may ignore it.

------

## 6.12 Transport

Normalized transport choices:

```text
sse
websocket
websocket-cached
auto
```

A provider that does not support transport selection can ignore this option.

------

## 6.13 Cache retention

Normalized values:

```text
none
short
long
```

Default documented preference:

```text
short
```

Providers translate these values into whatever cache mechanism their wire protocol supports.

This is exactly why cache policy belongs in `Options`, not `Context`.

------

## 6.14 `sessionId`

```ts
sessionId?: string
```

allows providers to perform:

- session-affinity routing;
- provider prompt caching;
- session-aware behavior.

Providers that do not understand it ignore it.

It is request execution metadata, not conversational content.

------

## 6.15 `metadata`

```ts
metadata?: Record<string, unknown>
```

Provider adapters extract fields they understand.

Other entries may be ignored.

Again:

```text
Options.metadata
≠
Context
```

------

## 6.16 Hooks

### `onPayload`

```ts
onPayload?: (
  payload,
  model
) => payload | undefined | Promise<...>
```

Called before sending the provider payload.

Returning:

```text
undefined
```

keeps the payload unchanged.

Returning another value replaces it.

------

### `onResponse`

Invoked after an HTTP response has arrived.

Normalized response metadata:

```ts
interface ProviderResponse {
  status: number
  headers: Record<string, string>
}
```

These hooks belong to execution/debugging infrastructure.

------

## 6.17 Simplified reasoning

`SimpleStreamOptions` adds:

```ts
reasoning?: ThinkingLevel
```

with values:

```text
minimal
low
medium
high
xhigh
max
```

This is the main provider-neutral reasoning control.

Provider adapters translate it into their own wire representation.

Pi's README explicitly recommends this unified interface for `streamSimple()` / `completeSimple()`.

------

## 6.18 Thinking budgets

```ts
thinkingBudgets?: {
  minimal?: number
  low?: number
  medium?: number
  high?: number
}
```

These apply to token-budget-based providers.

They do not redefine Pi's generic reasoning-level enum.

------

## 6.19 Deferred execution

```ts
deferred?:
  | boolean
  | {
      window?:
        | "15m"
        | "1h"
        | "24h"
    }
```

A capable provider may return a durable deferred handle rather than completing immediately.

This is optional provider functionality.

------

# 7. AssistantMessage

## 7.1 Response hierarchy

```text
AssistantMessage
│
├── Identity
│   ├── role = "assistant"
│   ├── api
│   ├── provider
│   ├── model
│   ├── responseModel?
│   └── responseId?
│
├── Content
│   └── content[]
│       ├── TextContent
│       ├── ThinkingContent
│       └── ToolCall
│
├── Accounting
│   └── usage
│
├── Termination
│   ├── stopReason
│   ├── rawStopReason?
│   └── endTurn?
│
├── Deferred State
│   └── deferred?
│
├── Failure Information
│   ├── errorMessage?
│   └── diagnostics?
│
└── timestamp
```

Exact source type is defined in `types.ts`.

------

## 7.2 Field contract

| Field           | Type              | Meaning                                         |
| --------------- | ----------------- | ----------------------------------------------- |
| `role`          | `"assistant"`     | constant semantic role                          |
| `content`       | array             | ordered generated semantic content              |
| `api`           | string            | API implementation used                         |
| `provider`      | string            | provider used                                   |
| `model`         | string            | requested Pi model ID                           |
| `responseModel` | string?           | concrete model reported upstream when different |
| `responseId`    | string?           | upstream response/message identifier            |
| `diagnostics`   | array?            | provider/runtime diagnostics                    |
| `usage`         | `Usage`           | normalized token/cost accounting                |
| `stopReason`    | `StopReason`      | normalized terminal/current state               |
| `deferred`      | `DeferredHandle`? | async provider handle                           |
| `errorMessage`  | string?           | failure description                             |
| `rawStopReason` | string?           | original upstream reason                        |
| `endTurn`       | boolean?          | preserved provider indication                   |
| `timestamp`     | number            | Unix milliseconds                               |

------

## 7.3 `model` vs `responseModel`

```text
model
→ model Pi requested

responseModel
→ concrete model reported by provider when different
```

Example use case:

```text
requested:
openrouter / auto

provider actually selected:
anthropic/...
```

The semantic distinction should be retained.

------

## 7.4 `responseId`

Opaque provider-specific response/message identifier.

It is optional because not every upstream API exposes one.

Do not make it a required universal identifier.

------

## 7.5 Content ordering

```text
AssistantMessage.content[]
```

is ordered.

Example:

```text
content[]
├── ThinkingContent
├── TextContent
├── ToolCall
└── ToolCall
```

Protocol conversion must preserve this ordering whenever source semantics depend on it.

------

# 8. Usage

## 8.1 Usage hierarchy

```text
Usage
│
├── Tokens
│   ├── input
│   ├── output
│   ├── cacheRead
│   ├── cacheWrite
│   ├── cacheWrite1h?
│   ├── reasoning?
│   └── totalTokens
│
└── Cost
    ├── input
    ├── output
    ├── cacheRead
    ├── cacheWrite
    └── total
```

Exact type:

```ts
interface Usage {
  input: number
  output: number

  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number

  reasoning?: number

  totalTokens: number

  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}
```

------

## 8.2 Reasoning token invariant

When present:

```text
reasoning
```

is a subset of:

```text
output
```

Therefore:

```text
total output
≠
output + reasoning
```

because that would double-count reasoning tokens.

The source documents this explicitly.

------

## 8.3 `cacheWrite1h`

When present:

```text
cacheWrite1h
```

is a subset of:

```text
cacheWrite
```

It currently represents the long-retention split reported by Anthropic.

It must not be added again when computing total cache-written tokens.

------

## 8.4 Cost

`Usage.cost` is normalized alongside token counts.

Applications consuming Pi should normally use:

```text
usage.cost.total
```

instead of recomputing costs from provider-specific wire responses.

------

# 9. Streaming Event Protocol

## 9.1 Event hierarchy

```text
AssistantMessageEventStream
│
├── Message
│   └── start
│
├── Text Content
│   ├── text_start
│   ├── text_delta*
│   └── text_end
│
├── Thinking Content
│   ├── thinking_start
│   ├── thinking_delta*
│   └── thinking_end
│
├── Tool Content
│   ├── toolcall_start
│   ├── toolcall_delta*
│   └── toolcall_end
│
└── Terminal
    ├── done
    └── error
```

This is the actual `AssistantMessageEvent` union.

------

## 9.2 Event field contract

| Event            | Key fields                            |
| ---------------- | ------------------------------------- |
| `start`          | `partial`                             |
| `text_start`     | `contentIndex`, `partial`             |
| `text_delta`     | `contentIndex`, `delta`, `partial`    |
| `text_end`       | `contentIndex`, `content`, `partial`  |
| `thinking_start` | `contentIndex`, `partial`             |
| `thinking_delta` | `contentIndex`, `delta`, `partial`    |
| `thinking_end`   | `contentIndex`, `content`, `partial`  |
| `toolcall_start` | `contentIndex`, `partial`             |
| `toolcall_delta` | `contentIndex`, `delta`, `partial`    |
| `toolcall_end`   | `contentIndex`, `toolCall`, `partial` |
| `done`           | `reason`, `message`                   |
| `error`          | `reason`, `error`                     |

------

## 9.3 Message lifecycle

A conforming stream should emit:

```text
start
↓
content lifecycle*
↓
done | error
```

The source contract explicitly says:

> `start` precedes partial updates, and every conforming stream terminates with either `done` or `error`.

------

## 9.4 `partial`

Most non-terminal events contain:

```ts
partial: AssistantMessage
```

This is the current accumulated semantic message state.

It allows a consumer to inspect:

```text
partial.content
partial.usage
partial.stopReason
...
```

while generation continues.

A converter should not treat this partial message as terminal state.

------

## 9.5 `contentIndex`

Every content lifecycle event identifies:

```text
contentIndex
```

corresponding to:

```text
partial.content[contentIndex]
```

This gives the stream a hierarchical relationship:

```text
AssistantMessage
└── content[index]
    ├── text lifecycle
    ├── thinking lifecycle
    └── tool lifecycle
```

This should be preferred over maintaining one unstructured global delta buffer.

------

## 9.6 Text lifecycle

```text
TextContent[index]
├── text_start
├── text_delta*
└── text_end
```

### Start

```ts
{
  type: "text_start",
  contentIndex,
  partial
}
```

### Delta

```ts
{
  type: "text_delta",
  contentIndex,
  delta,
  partial
}
```

`delta` is newly received text.

### End

```ts
{
  type: "text_end",
  contentIndex,
  content,
  partial
}
```

`content` contains the completed text for that block.

------

## 9.7 Thinking lifecycle

```text
ThinkingContent[index]
├── thinking_start
├── thinking_delta*
└── thinking_end
```

`thinking_delta.delta` is incremental reasoning text.

`thinking_end.content` is the completed thinking text for that content block.

------

## 9.8 Tool-call lifecycle

```text
ToolCall[index]
├── toolcall_start
├── toolcall_delta*
└── toolcall_end
```

This distinction is particularly important for a protocol router.

------

## 9.9 `toolcall_start`

At start:

```text
tool identity exists
arguments may still be incomplete
```

The partial message already contains a `ToolCall` at:

```text
partial.content[contentIndex]
```

Pi's stream tests verify that the tool name and ID are available at start.

------

## 9.10 `toolcall_delta`

Event:

```ts
{
  type: "toolcall_delta",
  contentIndex,
  delta,
  partial
}
```

Two representations coexist intentionally:

```text
event.delta
→ raw incremental serialized argument fragment

event.partial.content[contentIndex].arguments
→ current partially parsed object
```

Pi's tests explicitly verify that during tool deltas:

```text
ToolCall.arguments
```

already exists as an object and can be partially populated.

This leads to a critical lifecycle rule:

> A partially populated `ToolCall` inside `partial` is not yet a completed semantic tool call.

------

## 9.11 `toolcall_end`

Event:

```ts
{
  type: "toolcall_end",
  contentIndex,
  toolCall,
  partial
}
```

Here:

```text
toolCall
```

is the completed semantic `ToolCall`.

Only at this stage should a stream converter treat streamed tool arguments as complete.

------

## 9.12 Parallel/interleaved content

Because every lifecycle event carries a:

```text
contentIndex
```

consumers should maintain state keyed by index.

Do not assume only one active content block exists globally.

This is especially important when adapting protocols capable of parallel tool calls or interleaved structured content.

------

# 10. Terminal, Error, Abort, and Deferred Semantics

## 10.1 StopReason

Exact normalized union:

```text
StopReason
├── pending
├── stop
├── length
├── toolUse
├── error
├── aborted
└── deferred
```

------

## 10.2 Meaning

| Reason     | State                                         |
| ---------- | --------------------------------------------- |
| `pending`  | partial/in-progress message                   |
| `stop`     | successful normal completion                  |
| `length`   | successful terminal due to output limit       |
| `toolUse`  | successful terminal requesting tool execution |
| `deferred` | successful terminal yielding deferred work    |
| `error`    | failed generation                             |
| `aborted`  | request cancellation                          |

------

## 10.3 Successful stream terminal

`done` can only carry:

```text
stop
length
toolUse
deferred
```

Type:

```ts
{
  type: "done"

  reason:
    | "stop"
    | "length"
    | "toolUse"
    | "deferred"

  message: AssistantMessage
}
```

------

## 10.4 Failure terminal

`error` can only carry:

```text
error
aborted
```

Type:

```ts
{
  type: "error"

  reason:
    | "error"
    | "aborted"

  error: AssistantMessage
}
```

The `AssistantMessage` may contain partial content and partial usage accumulated before failure.

Pi documents this explicitly.

------

## 10.5 `.result()` is not a success predicate

`AssistantMessageEventStream` is implemented as:

```text
done
→ result = event.message

error
→ result = event.error
```

Therefore:

```ts
const message = await stream.result()
```

may produce:

```text
stopReason = stop
```

or:

```text
stopReason = error
```

or:

```text
stopReason = aborted
```

without the promise rejecting merely because generation failed.

Correct success test:

```ts
switch (message.stopReason) {
  case "stop":
  case "length":
  case "toolUse":
  case "deferred":
    // semantic terminal

  case "error":
  case "aborted":
    // failure
}
```

------

## 10.6 Error delivery contract

`StreamFunction` explicitly specifies:

```text
once invoked
↓
request/model/runtime failure
↓
must be encoded into returned stream
↓
error terminal event
```

rather than being thrown outside the stream.

This gives callers one terminal state model.

------

## 10.7 Setup failures

Even failures occurring before provider streaming begins, such as:

```text
auth resolution
lazy module loading
unknown provider
```

are converted by `lazyStream()` into:

```text
AssistantMessage
├── content = []
├── usage = zero
├── stopReason = "error"
├── errorMessage
└── timestamp
```

and then emitted as:

```text
error
```

terminal event.

------

## 10.8 Abort

The request cancellation input is:

```ts
AbortSignal
```

When a provider request is cancelled, the normalized terminal state is:

```text
stopReason = "aborted"
```

with:

```text
event.type = "error"
event.reason = "aborted"
```

Pi can preserve any partial content already received.

LuckyToken may choose an atomic policy that discards that partial state before producing downstream output.

------

## 10.9 Stream queue behavior

`EventStream` keeps an internal queue when no iterator consumer is waiting.

Conceptually:

```text
producer pushes event
│
├── consumer waiting
│   └── deliver immediately
│
└── no consumer waiting
    └── queue event
```

Once a terminal event is pushed:

```text
done = true
```

and later pushes are ignored.

For long atomic operations, actively consuming the stream is preferable to simply waiting for `.result()` while allowing every intermediate event to accumulate in the queue.

------

## 10.10 DeferredHandle

Structure:

```text
DeferredHandle
├── provider
├── modelId
├── api
├── id
├── expiresAt?
├── pollAfterMs?
└── data?
```

Exact type:

```ts
interface DeferredHandle {
  provider: string
  modelId: string
  api: string

  id: string

  expiresAt?: number
  pollAfterMs?: number

  data?: JsonValue
}
```

The `id` is provider-specific durable state such as a response ID or batch identity.

------

# 11. Models / Provider Runtime Companion Contract

This chapter describes runtime infrastructure surrounding the semantic IR.

It is intentionally separate from Chapters 3–10.

------

## 11.1 Runtime hierarchy

```text
Models
│
├── Provider A
│   ├── Auth
│   ├── Models[]
│   └── Stream implementation
│
├── Provider B
│   ├── Auth
│   ├── Models[]
│   └── Stream implementation
│
└── Provider C
    └── ...
```

A model identifies its owning provider through:

```text
Model.provider
```

`Models` uses this field for dispatch.

------

## 11.2 Provider contract

Core hierarchy:

```text
Provider
├── Identity
│   ├── id
│   └── name
│
├── Defaults
│   ├── baseUrl?
│   └── headers?
│
├── Authentication
│   └── auth
│
├── Models
│   ├── getModels()
│   ├── refreshModels?()
│   └── filterModels?()
│
└── Execution
    ├── stream()
    ├── streamSimple()
    ├── fetchDeferred?()
    └── cancelDeferred?()
```

------

## 11.3 Provider ownership

The provider is the concrete runtime unit.

It owns:

```text
provider identity
model catalog
auth semantics
stream behavior
optional dynamic model refresh
```

The public README describes this exact ownership model.

Therefore LuckyToken should not add another generic provider registry between its code and `Models` unless it has a demonstrated application-specific need.

------

## 11.4 Models collection

Core read API:

```text
getProviders()
getProvider(id)

getModels(provider?)
getModel(provider, id)

getAvailable(provider?)
```

Execution:

```text
stream()
complete()

streamSimple()
completeSimple()

fetchDeferred()
cancelDeferred()
```

Auth/control:

```text
checkAuth()
getAuth()

login()
logout()

refresh()
```

The runtime model list is provider-owned and retrieved through `Provider.getModels()`.

------

## 11.5 Dispatch path

`Models.streamSimple()` follows:

```text
Model
↓
model.provider
↓
require Provider
↓
resolve/apply auth
↓
request-local Model + Options
↓
Provider.streamSimple()
↓
AssistantMessageEventStream
```

This is an important architecture boundary.

Protocol adapters do not need their own provider dispatcher.

------

## 11.6 Authentication boundary

Pi distinguishes:

```text
stored credential
↓
provider auth resolution
↓
ModelAuth
```

`ModelAuth` contains only request-facing auth information:

```ts
interface ModelAuth {
  apiKey?: string
  headers?: Record<string, string | null>
  baseUrl?: string
}
```

If a value cannot be expressed as:

```text
apiKey
headers
baseUrl
```

the source explicitly treats it as provider configuration rather than request auth.

------

## 11.7 Credential hierarchy

```text
Credential
├── ApiKeyCredential
│   ├── type = "api_key"
│   ├── key?
│   └── env?
│
└── OAuthCredential
    ├── type = "oauth"
    ├── refresh
    ├── access
    ├── expires
    └── provider fields...
```

Credentials are keyed by provider ID.

------

## 11.8 CredentialStore

Interface:

```text
CredentialStore
├── read()
├── list()
├── modify()
└── delete()
```

A major invariant is:

```text
modify()
=
serialized read-modify-write
```

The source uses this as the only credential write path so concurrent OAuth refreshes cannot independently rotate the same token.

LuckyToken can implement its own persistent `CredentialStore` without changing the Pi semantic IR.

------

## 11.9 Auth resolution precedence

Current auth resolution behaves approximately as:

```text
explicit request apiKey?
│
├── yes
│   └── provider API-key resolution using explicit key
│
└── no
    │
    ├── stored credential?
    │   ├── OAuth → refresh if required → toAuth()
    │   └── API key → resolve()
    │
    └── no stored credential
        └── ambient provider auth
            ├── env
            ├── profile
            ├── ADC
            └── provider-specific source
```

A stored credential owns the provider; Pi does not silently fall back to ambient credentials after a stored credential fails or has an incompatible type.

------

## 11.10 Request auth application

After auth is resolved:

```text
resolved auth
+
model static headers
+
explicit request options
        ↓
request-local Model / Options
        ↓
optional transformHeaders()
        ↓
provider dispatch
```

Current precedence includes:

```text
explicit request apiKey
> resolved apiKey
```

Request headers override matching resolved/model headers case-insensitively.

Then:

```text
transformHeaders()
```

runs last.

------

## 11.11 Request-local base URL

If authentication returns:

```text
auth.baseUrl
```

`Models` creates a request-local model copy:

```ts
{
  ...model,
  baseUrl: auth.baseUrl
}
```

The original catalog `Model` is not globally mutated.

This is a useful information-lifecycle pattern for LuckyToken:

```text
stable catalog Model
↓
request-local effective Model
↓
request ends
↓
effective copy dies
```

------

## 11.12 Custom providers

Pi already provides:

```ts
createProvider(...)
```

for composing:

```text
identity
auth
models
API stream implementation
optional dynamic model source
```

A provider can use:

```text
one API implementation
```

for all models or:

```text
Map<model.api, API implementation>
```

for mixed-API providers.

This is the natural integration point for a future CommandCode provider.

------

# 12. Implementation Invariants for LuckyToken

## 12.1 Semantic boundary

Keep this boundary:

```text
Model
→ who/what is being called

Context
→ what the model sees

Options
→ how this invocation executes
```

Do not merge them into one universal request object.

------

## 12.2 Context isolation

Never put infrastructure data into `Context` merely because it is convenient.

Examples that should normally stay outside:

```text
API keys
provider headers
request IDs
logging metadata
timing data
retry state
HTTP status
debug information
AbortController
```

------

## 12.3 Message ordering

```text
Context.messages[]
```

is ordered semantic conversation history.

Do not reorder messages during protocol conversion unless the source-to-Pi conversion specification explicitly requires a transformation.

------

## 12.4 Content ordering

```text
AssistantMessage.content[]
```

is ordered.

Preserve:

```text
thinking
text
tool calls
```

in their semantic order.

------

## 12.5 Parent/content rules

Do not create invalid generic combinations such as:

```text
UserMessage + ThinkingContent
UserMessage + ToolCall
AssistantMessage + ImageContent
ToolResultMessage + ThinkingContent
```

without first changing the Pi semantic model.

The current source types deliberately prevent those combinations.

------

## 12.6 Image representation

Pi image:

```text
base64 bytes + mimeType
```

not:

```text
data URL
```

Every wire adapter must normalize its own representation at the conversion boundary.

------

## 12.7 Tool identity

Never arbitrarily regenerate:

```text
ToolCall.id
```

because:

```text
ToolResultMessage.toolCallId
```

depends on it.

------

## 12.8 Partial tool calls

During:

```text
toolcall_delta
```

the current:

```text
partial.content[contentIndex].arguments
```

may already look like a valid object.

That does **not** make the tool call complete.

Only:

```text
toolcall_end
```

provides the completed semantic `ToolCall`.

------

## 12.9 Content index

Use:

```text
contentIndex
```

as the authoritative mapping between stream event and `AssistantMessage.content`.

Do not invent a separate global stream slot.

------

## 12.10 Terminal events

A conforming Pi stream has exactly one semantic terminal:

```text
done
or
error
```

After terminal, `EventStream.push()` ignores further events.

------

## 12.11 Result success

Never write:

```ts
await stream.result()
// therefore success
```

Instead:

```text
result()
↓
AssistantMessage.stopReason
```

must determine success/failure.

------

## 12.12 Abort

For a request-scoped router:

```text
client disconnect / Ctrl+C
↓
AbortSignal
↓
Pi options.signal
↓
Provider
↓
upstream cancellation
```

LuckyToken should avoid an independent second cancellation state machine unless required by another subsystem.

------

## 12.13 Atomic downstream policy

Pi permits error/aborted messages containing partial content.

LuckyToken can still enforce:

```text
consume Pi stream internally
↓
done?
├── yes → commit response
└── no  → discard semantic partial response
```

This keeps the Pi contract intact while allowing LuckyToken to implement stronger atomic semantics.

------

## 12.14 Usage

Never calculate:

```text
output + reasoning
```

because reasoning is already part of output.

Likewise do not add:

```text
cacheWrite1h
```

again to `cacheWrite`.

------

## 12.15 Provider identity

Do not create a second independent provider/model identity layer unless LuckyToken has functionality Pi cannot express.

The canonical runtime identity is already:

```text
Model.provider
Model.id
Model.api
```

------

## 12.16 Stable semantic prefix

Keep dynamic execution metadata outside `Context` where possible.

This naturally protects stable model-visible prefixes from:

```text
request IDs
timestamps generated by infrastructure
provider routing details
transport headers
debug metadata
```

`Message.timestamp` is part of the Pi semantic object for application/history bookkeeping, but a provider adapter decides whether that value is ever sent to an upstream model.

------

# Appendix A. Core Type Summary

```text
Pi Core
│
├── Model
│
├── Context
│   ├── systemPrompt?
│   ├── messages[]
│   │   ├── UserMessage
│   │   ├── AssistantMessage
│   │   └── ToolResultMessage
│   └── tools[]?
│
├── Options
│   ├── StreamOptions
│   └── SimpleStreamOptions
│
├── Content
│   ├── TextContent
│   ├── ImageContent
│   ├── ThinkingContent
│   └── ToolCall
│
├── Response
│   ├── AssistantMessage
│   ├── Usage
│   └── StopReason
│
└── Stream
    └── AssistantMessageEvent
```

------

# Appendix B. Complete Invocation Tree

```text
Pi Invocation
│
├── Model
│   ├── id
│   ├── name
│   ├── provider
│   ├── api
│   ├── baseUrl
│   ├── reasoning
│   ├── thinkingLevelMap?
│   ├── input[]
│   ├── contextWindow
│   ├── maxTokens
│   ├── cost
│   ├── samplingParams?
│   ├── headers?
│   └── compat?
│
├── Context
│   │
│   ├── systemPrompt?
│   │
│   ├── messages[]
│   │   │
│   │   ├── UserMessage
│   │   │   ├── role = user
│   │   │   ├── content
│   │   │   │   ├── string
│   │   │   │   └── [TextContent | ImageContent]
│   │   │   └── timestamp
│   │   │
│   │   ├── AssistantMessage
│   │   │   ├── content[]
│   │   │   │   ├── TextContent
│   │   │   │   ├── ThinkingContent
│   │   │   │   └── ToolCall
│   │   │   ├── provider/model/api
│   │   │   ├── usage
│   │   │   ├── stopReason
│   │   │   └── timestamp
│   │   │
│   │   └── ToolResultMessage
│   │       ├── toolCallId
│   │       ├── toolName
│   │       ├── content[]
│   │       ├── isError
│   │       └── timestamp
│   │
│   └── tools[]?
│       └── Tool
│           ├── name
│           ├── description
│           ├── parameters
│           └── constrainedSampling?
│
└── Options
    ├── signal?
    ├── apiKey?
    ├── env?
    ├── headers?
    ├── timeoutMs?
    ├── maxRetries?
    ├── temperature?
    ├── samplingParams?
    ├── maxTokens?
    ├── transport?
    ├── cacheRetention?
    ├── sessionId?
    ├── metadata?
    ├── reasoning?
    ├── thinkingBudgets?
    └── deferred?
```

------

# Appendix C. Complete Response Tree

```text
AssistantMessage
│
├── role = "assistant"
│
├── content[]
│   │
│   ├── TextContent
│   │   ├── type = "text"
│   │   ├── text
│   │   └── textSignature?
│   │
│   ├── ThinkingContent
│   │   ├── type = "thinking"
│   │   ├── thinking
│   │   ├── thinkingSignature?
│   │   └── redacted?
│   │
│   └── ToolCall
│       ├── type = "toolCall"
│       ├── id
│       ├── name
│       ├── arguments
│       ├── thoughtSignature?
│       └── namespace?
│
├── Runtime Identity
│   ├── api
│   ├── provider
│   ├── model
│   ├── responseModel?
│   └── responseId?
│
├── Usage
│   ├── input
│   ├── output
│   ├── cacheRead
│   ├── cacheWrite
│   ├── cacheWrite1h?
│   ├── reasoning?
│   ├── totalTokens
│   └── cost
│
├── Termination
│   ├── stopReason
│   ├── rawStopReason?
│   └── endTurn?
│
├── Deferred
│   └── deferred?
│
├── Diagnostics
│   ├── errorMessage?
│   └── diagnostics?
│
└── timestamp
```

------

# Appendix D. Complete Stream Tree

```text
AssistantMessageEventStream
│
├── start
│   └── partial
│
├── Content[index]*
│   │
│   ├── Text
│   │   ├── text_start
│   │   ├── text_delta*
│   │   └── text_end
│   │
│   ├── Thinking
│   │   ├── thinking_start
│   │   ├── thinking_delta*
│   │   └── thinking_end
│   │
│   └── ToolCall
│       ├── toolcall_start
│       ├── toolcall_delta*
│       └── toolcall_end
│
└── Terminal
    │
    ├── done
    │   ├── stop
    │   ├── length
    │   ├── toolUse
    │   └── deferred
    │
    └── error
        ├── error
        └── aborted
```

------

# Appendix E. Recommended LuckyToken Boundary

The most useful way for LuckyToken to depend on Pi is:

```text
Protocol Adapter
│
├── parse client wire
│
├── resolve Model
│
├── create Context
│
├── create Options
│
└── call Models.streamSimple()
        │
        ▼
AssistantMessageEventStream
        │
        ▼
AssistantMessage
        │
        ▼
Protocol Renderer
```

The conversion boundary should therefore be expressed in terms similar to:

```ts
interface ProtocolRequestConversion {
  model: Model<Api>
  context: Context
  options: ModelsSimpleStreamOptions
}
```

rather than introducing another universal LuckyToken request IR containing the same information.

For response conversion, the authoritative semantic structures should be:

```text
AssistantMessageEvent
AssistantMessage
```

not another parallel response IR.

This preserves the intended Pi information lifecycle:

```text
client wire
↓
Pi semantic representation
↓
provider runtime
↓
Pi semantic response
↓
client wire
```

and allows each protocol-specific representation to die at its natural conversion boundary.