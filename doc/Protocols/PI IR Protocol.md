# Pi AI Semantic IR Specification

**Upstream Repository:** `earendil-works/pi`
**Module:** `packages/ai`
**Package:** `@earendil-works/pi-ai`
**Inspected Version:** `0.84.1`
**Inspected Baseline:** `936aff00918de1187f085f123c2812d8f2d67745`
**Scope:** Core text/multimodal LLM semantic IR and runtime contract

------

# 1. Purpose and Scope

Pi AI does not define an HTTP wire protocol for its internal model abstraction.

Its core text-generation API defines a **semantic runtime contract**:

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
AssistantMessageEventStream
        │
        ▼
AssistantMessage
```

The semantic IR is therefore composed of two major sides:

```text
Pi Semantic IR
│
├── Request-Side Semantic State
│   ├── Model
│   ├── Context
│   └── Options
│
└── Response-Side Semantic State
    ├── AssistantMessageEventStream
    └── AssistantMessage
```

`Models`, `Provider`, authentication, and credential resolution are runtime infrastructure around this IR rather than additional conversational IR objects.

Pi also contains a separate image-generation API. That API is outside the scope of this specification.

------

# 2. Top-Level Invocation Contract

The simplified execution entry point is:

```ts
models.streamSimple(
  model,
  context,
  options,
)
```

Its logical hierarchy is:

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

`Models.streamSimple()` returns the stream synchronously while asynchronous setup such as authentication may happen behind the stream boundary.

The final semantic value produced by the stream is an:

```text
AssistantMessage
```

Pi also provides:

```ts
completeSimple(
  model,
  context,
  options,
): Promise<AssistantMessage>
```

which is implemented through:

```text
streamSimple(...).result()
```

------

# 3. Request-Side IR

The complete request-side hierarchy is:

```text
Pi Invocation
│
├── Model
│   ├── Identity
│   ├── Endpoint
│   ├── Capabilities
│   ├── Limits
│   ├── Reasoning Mapping
│   ├── Pricing
│   ├── Sampling Defaults
│   ├── Headers
│   └── Compatibility
│
├── Context
│   ├── systemPrompt?
│   ├── messages[]
│   └── tools[]?
│
└── Options
    ├── Generation
    ├── Lifecycle
    ├── Authentication Override
    ├── Transport
    ├── Retry / Timeout
    ├── Cache / Session
    ├── Metadata / Telemetry
    ├── Hooks
    ├── Reasoning
    ├── Deferred Execution
    └── Models-Level Header Transform
```

------

# 4. Model

## 4.1 Model Tree

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
│       ├── input
│       ├── output
│       ├── cacheRead
│       ├── cacheWrite
│       └── tiers?
│
├── Sampling Defaults
│   └── samplingParams?
│
├── Transport Defaults
│   └── headers?
│
└── API Compatibility
    └── compat?
```

The current source defines the unified model object with these fields. Its `compat` type depends on the model's API family.

------

## 4.2 Identity

```ts
interface ModelIdentity {
  id: string
  name: string
  provider: ProviderId
  api: Api
}
```

Semantic meaning:

```text
provider
└── identifies the owning Provider

api
└── identifies the API implementation used by that Provider

id
└── identifies the model within the Provider

name
└── human-readable model name
```

`Api` is extensible:

```text
KnownApi
+
arbitrary string API identifiers
```

and `ProviderId` likewise permits providers outside the built-in set.

------

## 4.3 Endpoint

```text
Model
└── baseUrl
baseUrl: string
```

The model carries its effective base endpoint configuration.

The runtime may create a request-local copy with another `baseUrl` when authentication resolution supplies an endpoint override.

------

## 4.4 Capabilities

```text
Model
└── Capabilities
    ├── reasoning: boolean
    │
    └── input[]
        ├── "text"
        └── "image"
```

The generic Pi model capability system currently distinguishes:

```text
text input
image input
reasoning capability
```

It does not model arbitrary provider-specific content types in the generic `Model.input` union.

------

## 4.5 Thinking Levels

Pi defines normalized reasoning levels:

```text
ThinkingLevel
├── minimal
├── low
├── medium
├── high
├── xhigh
└── max
```

Model-level mappings also support:

```text
off
```

through:

```ts
type ModelThinkingLevel =
  | "off"
  | ThinkingLevel
```

The model can map these normalized Pi levels into provider/model-specific values:

```text
thinkingLevelMap
│
├── off?
├── minimal?
├── low?
├── medium?
├── high?
├── xhigh?
└── max?
```

A missing mapping uses provider behavior.

A mapping value of:

```text
null
```

marks that level as unsupported.

------

## 4.6 Model Limits

```text
Model
└── Limits
    ├── contextWindow
    └── maxTokens
contextWindow: number
maxTokens: number
```

These are model-level characteristics.

They are distinct from the optional request-level:

```text
Options.maxTokens
```

------

## 4.7 Model Pricing

```text
Model.cost
│
├── Base Rates
│   ├── input
│   ├── output
│   ├── cacheRead
│   └── cacheWrite
│
└── tiers?
    └── ModelCostTier[]
        ├── inputTokensAbove
        ├── input
        ├── output
        ├── cacheRead
        └── cacheWrite
```

Rates are represented as cost per million tokens.

Tiered pricing can replace the base rates above an input-token threshold.

------

## 4.8 Sampling Defaults

```text
Model
└── samplingParams?
    └── Record<string, unknown>
```

These are model-default sampling parameters.

Request-level:

```text
Options.samplingParams
```

overrides model defaults per key where the API adapter supports generic sampling parameters.

------

# 5. Context

## 5.1 Context Tree

```text
Context
│
├── systemPrompt?
│
├── messages[]
│   │
│   ├── UserMessage
│   ├── AssistantMessage
│   └── ToolResultMessage
│
└── tools[]?
    └── Tool
```

The actual core type is:

```ts
interface Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
}
```

------

## 5.2 Context Semantic Role

`Context` represents conversational information presented to the model:

```text
Context
├── system instruction
├── ordered conversation history
└── tool definitions
```

It does not contain the model being called or execution controls.

Those are represented separately by:

```text
Model
Options
```

------

# 6. Message Hierarchy

## 6.1 Message Union

```text
Message
│
├── UserMessage
├── AssistantMessage
└── ToolResultMessage
```

Formally:

```ts
type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
```

Pi does not define a normal `system` message variant.

System instructions are represented by:

```text
Context.systemPrompt
```

------

# 7. UserMessage

## 7.1 UserMessage Tree

```text
UserMessage
│
├── role = "user"
│
├── content
│   │
│   ├── string
│   │
│   └── UserContent[]
│       ├── TextContent
│       └── ImageContent
│
└── timestamp
```

Type:

```ts
interface UserMessage {
  role: "user"

  content:
    | string
    | (TextContent | ImageContent)[]

  timestamp: number
}
```

Timestamp is a Unix timestamp in milliseconds.

------

## 7.2 User Content Capability

A user message directly supports:

```text
UserMessage
└── content
    ├── TextContent
    └── ImageContent
```

It does not directly contain:

```text
ThinkingContent
ToolCall
ToolResultMessage
```

Tool results are represented as their own message type.

------

# 8. Semantic Content Types

## 8.1 Content Type Tree

Across the message hierarchy, the core semantic content objects are:

```text
Semantic Content
│
├── TextContent
│
├── ImageContent
│
├── ThinkingContent
│
└── ToolCall
```

Their allowed parents differ:

| Parent              | Text | Image | Thinking | ToolCall |
| ------------------- | ---- | ----- | -------- | -------- |
| `UserMessage`       | Yes  | Yes   | No       | No       |
| `AssistantMessage`  | Yes  | No    | Yes      | Yes      |
| `ToolResultMessage` | Yes  | Yes   | No       | No       |

------

# 9. TextContent

## 9.1 Text Tree

```text
TextContent
│
├── type = "text"
├── text
└── textSignature?
```

Type:

```ts
interface TextContent {
  type: "text"
  text: string
  textSignature?: string
}
```

`textSignature` contains optional provider-specific message metadata.

Pi also defines a versioned structured representation that can be serialized into this string:

```text
TextSignatureV1
│
├── v = 1
├── id
└── phase?
    ├── commentary
    └── final_answer
```

The signature is metadata associated with the content; it is not part of the visible text itself.

------

# 10. ImageContent

## 10.1 Image Tree

```text
ImageContent
│
├── type = "image"
├── data
└── mimeType
```

Type:

```ts
interface ImageContent {
  type: "image"
  data: string
  mimeType: string
}
```

`data` contains:

```text
base64 encoded image bytes
```

not a complete data URL.

Example conceptual shape:

```ts
{
  type: "image",
  data: "<base64>",
  mimeType: "image/png"
}
```

------

# 11. ThinkingContent

## 11.1 Thinking Tree

```text
ThinkingContent
│
├── type = "thinking"
├── thinking
├── thinkingSignature?
└── redacted?
```

Type:

```ts
interface ThinkingContent {
  type: "thinking"
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}
```

------

## 11.2 Normal Thinking

```text
ThinkingContent
├── thinking = semantic reasoning text
├── thinkingSignature? = opaque provider metadata
└── redacted = false / omitted
```

------

## 11.3 Redacted Thinking

Pi does **not** define a separate `RedactedThinkingContent` type.

Instead:

```text
ThinkingContent
├── redacted = true
├── thinking
└── thinkingSignature
```

represents redacted reasoning.

The source documents that the opaque encrypted payload may be stored in:

```text
thinkingSignature
```

so it can be replayed for provider continuity.

Therefore:

```text
normal thinking
```

and:

```text
redacted thinking
```

are two states of the same Pi `ThinkingContent` type.

------

# 12. ToolCall

## 12.1 ToolCall Tree

```text
ToolCall
│
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

Type:

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

## 12.2 Tool Identity

```text
ToolCall
├── id
└── name
```

identify one semantic tool invocation.

The tool result references this invocation through:

```text
ToolResultMessage.toolCallId
```

------

## 12.3 Tool Arguments

Completed tool arguments are represented as:

```text
arguments
└── Record<string, any>
```

Partial streaming tool JSON is **not** represented by `ToolCall.arguments`.

Partial tool input exists only in the stream event lifecycle before `toolcall_end`.

------

## 12.4 Tool Provider Metadata

```text
thoughtSignature?
```

is used by providers such as Google for opaque reasoning continuity.

```text
namespace?
```

supports namespaced/dynamically loaded tools such as those represented by OpenAI Responses.

These are part of the generic semantic tool-call object because Pi must round-trip provider-specific continuity where required.

------

# 13. ToolResultMessage

## 13.1 ToolResult Tree

```text
ToolResultMessage
│
├── role = "toolResult"
│
├── Tool Identity
│   ├── toolCallId
│   └── toolName
│
├── Content
│   └── content[]
│       ├── TextContent
│       └── ImageContent
│
├── Result State
│   └── isError
│
├── Optional Tool Metadata
│   ├── details?
│   ├── usage?
│   └── addedToolNames?
│
└── timestamp
```

Type:

```ts
interface ToolResultMessage<TDetails = any> {
  role: "toolResult"

  toolCallId: string
  toolName: string

  content:
    (TextContent | ImageContent)[]

  details?: TDetails

  usage?: Usage

  addedToolNames?: string[]

  isError: boolean

  timestamp: number
}
```

------

## 13.2 Tool Identity Relationship

```text
AssistantMessage
└── ToolCall
    └── id
         │
         ▼
ToolResultMessage
└── toolCallId
```

Semantic relationship:

```text
ToolCall.id
=
ToolResultMessage.toolCallId
```

------

## 13.3 Tool Name

Unlike some wire protocols that only reference a tool-call ID, Pi tool results also explicitly carry:

```text
toolName
```

Therefore the semantic tool result contains both:

```text
toolCallId
toolName
```

------

## 13.4 Tool Result Usage

A tool result may contain:

```text
usage?: Usage
```

The source explicitly notes that this usage belongs to the tool execution itself and is:

```text
not part of main LLM context accounting
```

------

## 13.5 Deferred Tool Availability

A tool result may also carry:

```text
addedToolNames?: string[]
```

This identifies tools from `Context.tools` that became available after this result.

It is used by providers with native deferred tool loading.

------

# 14. Tool Definitions

## 14.1 Tool Tree

```text
Tool
│
├── name
├── description
├── parameters
│   └── TypeBox / JSON-schema-compatible schema
│
└── constrainedSampling?
    │
    ├── false
    │
    ├── JSON Schema Constraint
    │   ├── type = "json_schema"
    │   └── strict
    │       ├── prefer
    │       └── require
    │
    └── Grammar Constraint
        ├── type = "grammar"
        └── variants
            ├── openai_lark?
            └── openai_regex?
```

Type:

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

------

## 14.2 Tool Parameters

The generic Pi tool input schema is represented through TypeBox's:

```text
TSchema
```

The semantic concept is:

```text
tool parameters schema
```

rather than any provider-specific tool-definition wire format.

------

# 15. Historical AssistantMessage

An `AssistantMessage` can appear in two different semantic locations:

```text
AssistantMessage
│
├── Historical Context Message
│   └── Context.messages[]
│
└── Current Invocation Result
    └── stream terminal result
```

Both use the same type.

This allows completed assistant output to be replayed directly as conversation history.

------

# 16. Options

## 16.1 Models.streamSimple Options Tree

The actual high-level option accepted by `Models.streamSimple()` is:

```text
ModelsSimpleStreamOptions
│
├── SimpleStreamOptions
│   │
│   ├── ProviderRequestOptions
│   ├── StreamOptions
│   └── Simple-Specific Options
│   │
│   └── inherited fields
│
└── ModelsRequestTransforms
    └── transformHeaders?
```

This distinction matters:

```text
Provider.streamSimple()
```

receives:

```text
SimpleStreamOptions
```

whereas:

```text
Models.streamSimple()
```

accepts:

```text
ModelsSimpleStreamOptions
```

which adds a final header transformation hook.

------

# 17. Provider Request Options

## 17.1 ProviderRequestOptions Tree

```text
ProviderRequestOptions
│
├── Lifecycle
│   └── signal?
│
├── Telemetry
│   └── telemetryContext?
│
├── Authentication Override
│   └── apiKey?
│
├── Transport Injection
│   ├── fetch?
│   └── env?
│
├── Request Hooks
│   ├── onPayload?
│   └── onResponse?
│
├── Headers
│   └── headers?
│
└── Retry / Timeout
    ├── timeoutMs?
    ├── maxRetries?
    └── maxRetryDelayMs?
```

------

## 17.2 Lifecycle

```ts
signal?: AbortSignal
```

is the generic cancellation contract for provider requests.

------

## 17.3 Telemetry

```ts
telemetryContext?: TelemetryContext
```

carries explicit parent telemetry context for the logical request.

This is execution metadata, not conversation content.

------

## 17.4 Authentication Override

```ts
apiKey?: string
```

allows explicit request-level API-key override.

This is distinct from normal credential resolution performed by `Models`.

------

## 17.5 Provider Environment

```ts
env?: ProviderEnv
```

represents provider-scoped environment/configuration overrides.

These values take precedence over process-level environment values where provider implementations use them.

------

## 17.6 Fetch Injection

```ts
fetch?: FetchFunction
```

allows injection of a custom HTTP fetch implementation for providers that support it.

It does not affect transports such as WebSockets.

------

## 17.7 Request Hooks

Before transmission:

```text
onPayload
└── inspect or replace provider payload
```

After HTTP response headers arrive:

```text
onResponse
└── inspect provider response metadata
```

These are transport lifecycle hooks.

They are not model-visible semantic information.

------

## 17.8 Request Headers

```ts
headers?: Record<string, string | null>
```

A string value overrides/adds a header.

A value of:

```text
null
```

suppresses a provider/API default header with the same name where supported.

------

# 18. StreamOptions

## 18.1 StreamOptions Tree

```text
StreamOptions
│
├── ProviderRequestOptions
│
├── Generation
│   ├── temperature?
│   ├── maxTokens?
│   └── samplingParams?
│
├── Transport Selection
│   ├── transport?
│   └── websocketConnectTimeoutMs?
│
├── Prompt Cache / Affinity
│   ├── cacheRetention?
│   └── sessionId?
│
└── Metadata
    └── metadata?
```

------

## 18.2 Temperature

```ts
temperature?: number
```

Generic sampling temperature.

Individual providers/models may reject or ignore it.

------

## 18.3 Maximum Output Tokens

```ts
maxTokens?: number
```

is the request-level output-token preference.

It is distinct from:

```text
Model.maxTokens
```

------

## 18.4 Sampling Parameters

```ts
samplingParams?: Record<string, unknown>
```

is an escape hatch for sampling fields that Pi does not model individually.

The source explicitly documents examples including:

```text
top_p
top_k
min_p
repetition_penalty
```

Only compatible API adapters apply these arbitrary fields.

------

## 18.5 Transport

Pi's normalized transport preference is:

```text
Transport
├── sse
├── websocket
├── websocket-cached
└── auto
```

Providers that do not support transport selection ignore it.

------

## 18.6 Cache Retention

```text
cacheRetention
├── none
├── short
└── long
```

Default documented behavior is:

```text
short
```

Providers map the preference to their own cache mechanisms.

------

## 18.7 Session Identifier

```ts
sessionId?: string
```

can be used by provider adapters for:

```text
prompt caching
request routing
session affinity
other session-aware behavior
```

Providers that do not use it ignore it.

------

## 18.8 Metadata

```ts
metadata?: Record<string, unknown>
```

Providers consume metadata fields they recognize and ignore others.

------

# 19. SimpleStreamOptions

## 19.1 Simple-Specific Tree

```text
SimpleStreamOptions
│
├── StreamOptions
│
├── Reasoning
│   ├── reasoning?
│   └── thinkingBudgets?
│
└── Deferred Execution
    └── deferred?
```

------

## 19.2 Reasoning

```ts
reasoning?: ThinkingLevel
```

Normalized levels:

```text
minimal
low
medium
high
xhigh
max
```

`streamSimple()` is the API that accepts Pi's normalized reasoning abstraction.

Provider-specific APIs then translate this normalized value into their own request representation.

------

## 19.3 Thinking Budgets

```text
thinkingBudgets
├── minimal?
├── low?
├── medium?
└── high?
```

These are optional token budgets for providers whose reasoning levels are implemented through token budgets.

------

## 19.4 Deferred Execution

```text
deferred
│
├── boolean
│
└── configuration
    └── window?
        ├── 15m
        ├── 1h
        └── 24h
```

Type:

```ts
deferred?:
  | boolean
  | {
      window?: "15m" | "1h" | "24h"
    }
```

This requests asynchronous/deferred execution from a provider that supports it.

------

# 20. Models-Level Header Transform

`Models.streamSimple()` additionally accepts:

```text
ModelsRequestTransforms
└── transformHeaders?
transformHeaders?:
  (
    headers: ProviderHeaders
  ) =>
    ProviderHeaders |
    Promise<ProviderHeaders>
```

The transform runs after:

```text
provider/model headers
+
resolved authentication headers
+
explicit request headers
```

have been assembled.

This hook belongs to `Models`, not to the lower-level `Provider.streamSimple()` contract.

------

# 21. Complete Request-Side Tree

```text
Pi Invocation
│
├── Model
│   │
│   ├── Identity
│   │   ├── id
│   │   ├── name
│   │   ├── provider
│   │   └── api
│   │
│   ├── Endpoint
│   │   └── baseUrl
│   │
│   ├── Capabilities
│   │   ├── reasoning
│   │   └── input[]
│   │       ├── text
│   │       └── image
│   │
│   ├── Limits
│   │   ├── contextWindow
│   │   └── maxTokens
│   │
│   ├── Reasoning Mapping
│   │   └── thinkingLevelMap
│   │
│   ├── Pricing
│   │   └── cost
│   │
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
│   │   │   └── content
│   │   │       ├── string
│   │   │       ├── TextContent
│   │   │       └── ImageContent
│   │   │
│   │   ├── AssistantMessage
│   │   │   └── content[]
│   │   │       ├── TextContent
│   │   │       ├── ThinkingContent
│   │   │       └── ToolCall
│   │   │
│   │   └── ToolResultMessage
│   │       ├── toolCallId
│   │       ├── toolName
│   │       ├── content[]
│   │       │   ├── TextContent
│   │       │   └── ImageContent
│   │       ├── isError
│   │       ├── details?
│   │       ├── usage?
│   │       └── addedToolNames?
│   │
│   └── tools[]?
│       └── Tool
│           ├── name
│           ├── description
│           ├── parameters
│           └── constrainedSampling?
│
└── ModelsSimpleStreamOptions?
    │
    ├── Lifecycle
    │   └── signal
    │
    ├── Generation
    │   ├── temperature
    │   ├── maxTokens
    │   └── samplingParams
    │
    ├── Reasoning
    │   ├── reasoning
    │   └── thinkingBudgets
    │
    ├── Authentication Override
    │   └── apiKey
    │
    ├── Transport
    │   ├── headers
    │   ├── env
    │   ├── fetch
    │   └── transport
    │
    ├── Retry / Timeout
    │   ├── timeoutMs
    │   ├── maxRetries
    │   ├── maxRetryDelayMs
    │   └── websocketConnectTimeoutMs
    │
    ├── Cache / Affinity
    │   ├── cacheRetention
    │   └── sessionId
    │
    ├── Metadata / Telemetry
    │   ├── metadata
    │   └── telemetryContext
    │
    ├── Hooks
    │   ├── onPayload
    │   ├── onResponse
    │   └── transformHeaders
    │
    └── Deferred
        └── deferred
```

------

# 22. Response-Side IR

The response side has two layers:

```text
Pi Response
│
├── Runtime Incremental Form
│   └── AssistantMessageEventStream
│
└── Terminal Semantic Form
    └── AssistantMessage
```

The stream is a construction protocol.

The `AssistantMessage` is the final semantic object.

------

# 23. AssistantMessage

## 23.1 AssistantMessage Tree

```text
AssistantMessage
│
├── Role
│   └── role = "assistant"
│
├── Semantic Content
│   └── content[]
│       ├── TextContent
│       ├── ThinkingContent
│       └── ToolCall
│
├── Request Identity
│   ├── api
│   ├── provider
│   └── model
│
├── Upstream Response Identity
│   ├── responseModel?
│   └── responseId?
│
├── Termination
│   ├── stopReason
│   ├── rawStopReason?
│   ├── endTurn?
│   ├── errorMessage?
│   └── deferred?
│
├── Usage
│   └── Usage
│
├── Diagnostics
│   └── diagnostics?
│
└── timestamp
```

------

# 24. Requested vs Actual Model Identity

The assistant response preserves both levels when necessary:

```text
AssistantMessage
│
├── model
│   └── requested Pi model ID
│
└── responseModel?
    └── concrete upstream response model
```

`responseModel` is used when the provider reports a concrete model that differs from the requested model.

Example use case:

```text
requested:
  auto

actual upstream:
  anthropic/...
```

------

## 24.1 Response Identifier

```ts
responseId?: string
```

stores the provider's response/message identifier when one is exposed.

It is separate from:

```text
ToolCall.id
```

and from any client-protocol message ID.

------

# 25. Assistant Content Tree

```text
AssistantMessage.content[]
│
├── TextContent
│   ├── text
│   └── textSignature?
│
├── ThinkingContent
│   ├── thinking
│   ├── thinkingSignature?
│   └── redacted?
│
└── ToolCall
    ├── id
    ├── name
    ├── arguments
    ├── thoughtSignature?
    └── namespace?
```

The array order is the semantic output order.

------

# 26. Termination

## 26.1 StopReason Tree

```text
StopReason
│
├── Nonterminal
│   └── pending
│
├── Successful Terminal
│   ├── stop
│   ├── length
│   ├── toolUse
│   └── deferred
│
└── Failure Terminal
    ├── error
    └── aborted
```

Exact union:

```ts
type StopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred"
```

------

## 26.2 Raw Stop Reason

```ts
rawStopReason?: string
```

can preserve the provider's original stop-reason value before normalization into the Pi `StopReason` vocabulary.

------

## 26.3 End-Turn Metadata

```ts
endTurn?: boolean
```

preserves an explicit provider indication that the model ended its turn.

The source documents that it is currently:

```text
diagnostic/debugging information
```

and does not control agent flow.

------

## 26.4 Error Message

Failure messages can carry:

```ts
errorMessage?: string
```

The stream contract requires an error-terminal assistant message to use:

```text
stopReason = "error"
```

or:

```text
stopReason = "aborted"
```

and include the error information.

------

# 27. Deferred Response

## 27.1 DeferredHandle Tree

```text
DeferredHandle
│
├── Provider Identity
│   ├── provider
│   ├── modelId
│   └── api
│
├── Provider Handle
│   └── id
│
├── Lifecycle Hints
│   ├── expiresAt?
│   └── pollAfterMs?
│
└── Reconstruction Data
    └── data?
```

A successful deferred terminal uses:

```text
stopReason = "deferred"
```

and may place the handle in:

```text
AssistantMessage.deferred
```

------

# 28. Usage

## 28.1 Usage Tree

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

------

## 28.2 Reasoning Token Invariant

The source explicitly defines:

```text
reasoning
⊆
output
```

`output` already includes reasoning tokens.

Therefore:

```text
output + reasoning
```

must **not** be used to calculate total completion tokens.

------

## 28.3 Long Cache Write Breakdown

```ts
cacheWrite1h?: number
```

is the subset of:

```text
cacheWrite
```

that was written with one-hour retention.

The source notes that currently only Anthropic reports this split.

------

# 29. Diagnostics

```text
AssistantMessage
└── diagnostics?
    └── AssistantMessageDiagnostic[]
```

Diagnostics carry redacted provider/runtime information about failures and recoveries.

They are response diagnostics rather than model-generated semantic content.

They are therefore structurally separate from:

```text
AssistantMessage.content[]
```

------

# 30. Event Stream Protocol

## 30.1 Top-Level Event Tree

```text
AssistantMessageEventStream
│
├── Message Start
│   └── start
│
├── Content Lifecycle*
│   │
│   ├── Text Lifecycle
│   │
│   ├── Thinking Lifecycle
│   │
│   └── ToolCall Lifecycle
│
└── Terminal
    ├── done
    └── error
```

The source contract states that streams should emit:

```text
start
```

before partial updates and terminate with exactly the semantic terminal categories:

```text
done
error
```

------

# 31. AssistantMessageEventStream Runtime Shape

`AssistantMessageEventStream` is:

```text
AsyncIterable<AssistantMessageEvent>
+
result(): Promise<AssistantMessage>
```

Its generic event-stream implementation contains an internal queue:

```text
Event arrives
│
├── iterator currently waiting
│   └── deliver immediately
│
└── no waiting iterator
    └── enqueue event
```

After a terminal event is pushed, later `push()` calls are ignored.

------

# 32. Start Event

```text
start
└── partial
    └── AssistantMessage
```

Type:

```ts
{
  type: "start"
  partial: AssistantMessage
}
```

This represents the initial partial assistant-message state.

------

# 33. Content Index

All incremental content events use:

```ts
contentIndex: number
```

This identifies:

```text
AssistantMessage.content[contentIndex]
```

Conceptually:

```text
AssistantMessage.content[]
│
├── [0] ThinkingContent
├── [1] TextContent
└── [2] ToolCall
```

The event protocol therefore already supplies canonical content ordering.

------

# 34. Text Event Lifecycle

## 34.1 Tree

```text
Text Lifecycle
│
├── text_start
│   ├── contentIndex
│   └── partial
│
├── text_delta*
│   ├── contentIndex
│   ├── delta
│   └── partial
│
└── text_end
    ├── contentIndex
    ├── content
    └── partial
```

State machine:

```text
NONE
 │
 │ text_start
 ▼
OPEN
 │
 ├── text_delta*
 │
 │ text_end
 ▼
COMPLETE
```

------

## 34.2 Text Start

```ts
{
  type: "text_start"
  contentIndex: number
  partial: AssistantMessage
}
```

------

## 34.3 Text Delta

```ts
{
  type: "text_delta"
  contentIndex: number
  delta: string
  partial: AssistantMessage
}
```

`delta` is the incremental text fragment.

------

## 34.4 Text End

```ts
{
  type: "text_end"
  contentIndex: number
  content: string
  partial: AssistantMessage
}
```

`content` is the completed text value for that block.

------

# 35. Thinking Event Lifecycle

## 35.1 Tree

```text
Thinking Lifecycle
│
├── thinking_start
│   ├── contentIndex
│   └── partial
│
├── thinking_delta*
│   ├── contentIndex
│   ├── delta
│   └── partial
│
└── thinking_end
    ├── contentIndex
    ├── content
    └── partial
```

State machine:

```text
NONE
 │
 │ thinking_start
 ▼
OPEN
 │
 ├── thinking_delta*
 │
 │ thinking_end
 ▼
COMPLETE
```

------

## 35.2 Signature Handling

The generic Pi event union does **not** define a separate:

```text
thinking_signature_delta
```

or:

```text
signature_delta
```

event.

Provider-specific signatures are represented through the evolving:

```text
partial: AssistantMessage
```

and ultimately through:

```text
ThinkingContent.thinkingSignature
```

in the semantic message.

This is an important distinction between Pi's generic event protocol and wire protocols such as Anthropic Messages SSE.

------

# 36. ToolCall Event Lifecycle

## 36.1 Tree

```text
ToolCall Lifecycle
│
├── toolcall_start
│   ├── contentIndex
│   └── partial
│
├── toolcall_delta*
│   ├── contentIndex
│   ├── delta
│   └── partial
│
└── toolcall_end
    ├── contentIndex
    ├── toolCall
    └── partial
```

State:

```text
NONE
 │
 │ toolcall_start
 ▼
OPEN
 │
 ├── toolcall_delta*
 │
 │ toolcall_end
 ▼
COMPLETE
```

------

## 36.2 Partial Tool Input

```ts
{
  type: "toolcall_delta"
  contentIndex: number
  delta: string
  partial: AssistantMessage
}
```

`delta` is a string fragment of the streaming tool-call representation.

It is temporary stream state.

It is not the completed semantic tool-call object.

------

## 36.3 Completed ToolCall

```ts
{
  type: "toolcall_end"

  contentIndex: number

  toolCall: ToolCall

  partial: AssistantMessage
}
```

The authoritative complete semantic call is:

```text
toolcall_end.toolCall
```

Therefore:

```text
toolcall_delta
≠
ToolCall
```

------

# 37. Partial AssistantMessage

Every nonterminal semantic event carries:

```text
partial: AssistantMessage
```

This is Pi's current accumulated semantic state.

Conceptually:

```text
Event
│
├── event-specific delta/completion data
└── partial
    └── current complete message snapshot/state
```

Consumers can inspect this evolving message while the stream is running.

The terminal events then provide the final message separately.

------

# 38. Terminal Events

## 38.1 Terminal Tree

```text
Terminal
│
├── Success
│   └── done
│       ├── reason
│       │   ├── stop
│       │   ├── length
│       │   ├── toolUse
│       │   └── deferred
│       │
│       └── message
│           └── AssistantMessage
│
└── Failure
    └── error
        ├── reason
        │   ├── error
        │   └── aborted
        │
        └── error
            └── AssistantMessage
```

------

# 39. Done Event

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

This is the successful terminal event.

The authoritative final result is:

```text
done.message
```

------

# 40. Error Event

```ts
{
  type: "error"

  reason:
    | "error"
    | "aborted"

  error: AssistantMessage
}
```

This is the failure terminal event.

The final semantic failure object is:

```text
error.error
```

Despite the property name, it is still an:

```text
AssistantMessage
```

not a JavaScript `Error`.

------

# 41. `result()` Semantics

`AssistantMessageEventStream.result()` resolves when either:

```text
done
```

or:

```text
error
```

is pushed.

Resolution:

```text
done
└── result() resolves to done.message
error
└── result() resolves to error.error
```

Therefore:

```text
await stream.result()
```

means:

```text
the stream reached a Pi terminal message
```

not necessarily:

```text
the request succeeded
```

A caller must inspect the returned message's:

```text
stopReason
```

when success/failure distinction matters.

------

# 42. Stream Error Contract

Pi's `StreamFunction` contract states:

```text
Once the stream function has been invoked
│
└── request / model / runtime failures
    └── should be encoded in the returned stream
        rather than thrown
```

Failure termination must produce:

```text
AssistantMessage
├── stopReason = "error" | "aborted"
└── errorMessage
```

and emit it through:

```text
error event
```

------

# 43. Lazy Setup Failure

Pi's lazy stream wrapper converts asynchronous setup failures such as:

```text
authentication resolution
lazy API loading
provider setup
```

into a normal stream failure:

```text
error
└── AssistantMessage
    ├── content = []
    ├── usage = zero
    ├── stopReason = "error"
    └── errorMessage
```

This means asynchronous pre-provider setup can still participate in the same stream terminal protocol.

------

# 44. Models Runtime

`Models` is the runtime collection surrounding the semantic IR.

## 44.1 Models Tree

```text
Models
│
├── Provider Registry
│   ├── getProviders()
│   ├── getProvider()
│   ├── getModels()
│   └── getModel()
│
├── Dynamic Model Discovery
│   └── refresh()
│
├── Authentication
│   ├── checkAuth()
│   ├── getAvailable()
│   ├── getAuth()
│   ├── login()
│   └── logout()
│
├── Execution
│   ├── stream()
│   ├── complete()
│   ├── streamSimple()
│   └── completeSimple()
│
└── Deferred Execution
    ├── fetchDeferred()
    └── cancelDeferred()
```

Pi describes `Models` as the runtime collection responsible for:

```text
providers
+
authentication application
+
stream convenience
```

while Providers own the actual stream behavior.

------

# 45. Provider Runtime

## 45.1 Provider Tree

```text
Provider
│
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
│   ├── refreshModels()?
│   └── filterModels()?
│
├── Execution
│   ├── stream()
│   └── streamSimple()
│
└── Deferred Execution?
    ├── fetchDeferred()
    └── cancelDeferred()
```

Provider is the concrete runtime unit that owns:

```text
authentication semantics
model catalog
provider stream implementation
```

------

# 46. Models → Provider Execution Lifecycle

For:

```ts
models.streamSimple(
  model,
  context,
  options
)
```

the source implementation follows this conceptual lifecycle:

```text
Model + Context + Options
        │
        ▼
Models
        │
        ├── require model.provider
        │
        ├── resolve Provider
        │
        ├── resolve authentication
        │
        ├── apply API-key override
        │
        ├── merge auth/request headers
        │
        ├── run transformHeaders
        │
        ├── merge provider environment
        │
        ├── apply auth baseUrl override
        │
        ▼
request-local Model + SimpleStreamOptions
        │
        ▼
Provider.streamSimple()
        │
        ▼
AssistantMessageEventStream
```

This boundary is important:

```text
Context
```

is passed through as semantic conversation state.

Authentication and transport preparation occur around:

```text
Model
Options
```

not inside `Context`.

------

# 47. Authentication Runtime

Authentication is runtime infrastructure around the IR.

## 47.1 Authentication Tree

```text
Provider Authentication
│
├── CredentialStore
│
├── Credential
│   ├── ApiKeyCredential
│   └── OAuthCredential
│
├── ProviderAuth
│   ├── apiKey?
│   └── oauth?
│
├── Resolution
│   └── AuthResult
│       ├── ModelAuth
│       ├── env?
│       └── source?
│
└── Request Auth
    └── ModelAuth
        ├── apiKey?
        ├── headers?
        └── baseUrl?
```

The final `ModelAuth` is deliberately narrow:

```text
request authentication
├── API key
├── headers
└── base URL
```

The source explicitly states that values that cannot be represented as these fields are:

```text
provider configuration
```

rather than request auth.

------

# 48. Credential Tree

```text
Credential
│
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
    └── extension fields
```

Credentials are keyed by:

```text
Provider.id
```

in `CredentialStore`.

------

# 49. CredentialStore

```text
CredentialStore
│
├── read()
├── list()
├── modify()
└── delete()
```

The important concurrency contract is:

```text
modify()
└── serialized read-modify-write
```

Pi performs OAuth refresh inside this serialized mutation mechanism so concurrent requests do not double-refresh a rotated credential.

------

# 50. Authentication Resolution

The runtime request-auth lifecycle is:

```text
Provider
+
stored Credential
+
ambient AuthContext
+
request overrides
        │
        ▼
Models.getAuth()
        │
        ▼
AuthResult
│
├── ModelAuth
│   ├── apiKey
│   ├── headers
│   └── baseUrl
│
├── env
└── source
```

Then `Models.applyAuth()` merges the result with explicit request options.

Explicit request values win per field.

------

# 51. OAuth Refresh

OAuth resolution lifecycle:

```text
Stored OAuthCredential
        │
        ├── not expired
        │       ↓
        │   use credential
        │
        └── expired
                ↓
        CredentialStore.modify()
                │
                ▼
        Provider OAuth.refresh()
                │
                ▼
        updated OAuthCredential
                │
                ▼
        Provider OAuth.toAuth()
                │
                ▼
             ModelAuth
```

Refresh is performed under the credential-store mutation lock.

------

# 52. Abort Semantics

## 52.1 Request Abort Tree

```text
AbortSignal
│
├── Provider Request
├── Auth Resolution
├── OAuth Refresh
├── Dynamic Model Refresh
├── Login / Logout
└── Deferred Operations
```

`AbortSignal` is part of the core provider request options and public auth operations.

------

## 52.2 Stream Abort Terminal

At the semantic stream level:

```text
aborted request
        │
        ▼
error event
├── reason = "aborted"
└── error
    └── AssistantMessage
        ├── stopReason = "aborted"
        └── errorMessage
```

Pi therefore distinguishes:

```text
aborted
```

from:

```text
error
```

at both the terminal event and `AssistantMessage.stopReason` levels.

------

# 53. Deferred Execution Lifecycle

Deferred execution is also represented in the generic runtime:

```text
Initial Request
│
├── options.deferred
│
└── Provider
     │
     ▼
done
├── reason = "deferred"
└── message
    ├── stopReason = "deferred"
    └── deferred = DeferredHandle
              │
              ▼
Models.fetchDeferred()
              │
              ▼
AssistantMessage
```

Optional cancellation is exposed through:

```text
Models.cancelDeferred()
```

when supported by the Provider.

------

# 54. Semantic Layer Boundaries

The Pi AI model cleanly separates these concerns:

```text
Model
└── who / what is being called

Context
└── what semantic conversation is supplied

Options
└── how this invocation should execute

Models
└── provider collection + auth application + dispatch

Provider
└── concrete upstream execution

EventStream
└── incremental construction protocol

AssistantMessage
└── terminal semantic result
```

These are separate layers even though they participate in one invocation.

------

# 55. Core Semantic Invariants

## 55.1 Model Identity

```text
Model.provider
```

identifies the Provider used by `Models`.

```text
Model.api
```

identifies the provider API implementation.

------

## 55.2 Context Purity

The structural Context contract contains only:

```text
systemPrompt
messages
tools
```

Execution options are not fields of `Context`.

------

## 55.3 Message Ordering

```text
Context.messages[]
```

is ordered semantic conversation history.

------

## 55.4 Assistant Content Ordering

```text
AssistantMessage.content[]
```

is ordered semantic assistant content.

Streaming:

```text
contentIndex
```

corresponds to this array.

------

## 55.5 Tool Identity

```text
ToolCall.id
=
ToolResultMessage.toolCallId
```

is the semantic tool invocation relationship.

------

## 55.6 Completed ToolCall

```text
toolcall_delta
```

contains temporary stream fragments.

The completed semantic call is:

```text
toolcall_end.toolCall
```

------

## 55.7 Thinking Representation

Pi uses one:

```text
ThinkingContent
```

type for both normal and redacted reasoning.

Redaction is represented by:

```text
redacted = true
```

with provider continuity data potentially stored in:

```text
thinkingSignature
```

------

## 55.8 Thinking Signatures Are Not Generic Events

The generic event protocol has:

```text
thinking_start
thinking_delta
thinking_end
```

but no independent signature event.

Signatures live in the semantic assistant-message state.

------

## 55.9 Usage

```text
reasoning
⊆
output
```

Reasoning must not be added again to output token accounting.

------

## 55.10 Terminal Outcome

A conforming semantic stream terminates as:

```text
done
```

or:

```text
error
```

with the terminal carrying the final `AssistantMessage`.

------

## 55.11 Error Result

```text
stream.result()
```

resolving does not imply success.

Both successful and failed terminal messages resolve the result promise.

------

## 55.12 Provider Failures

Once a stream API has been invoked, runtime/request/model failures should be represented by the returned stream rather than escaping as ordinary synchronous failures.

------

# 56. Complete Response Hierarchy

```text
Pi Response
│
├── AssistantMessageEventStream
│   │
│   ├── start
│   │   └── partial
│   │
│   ├── Text Lifecycle*
│   │   ├── text_start
│   │   ├── text_delta*
│   │   └── text_end
│   │
│   ├── Thinking Lifecycle*
│   │   ├── thinking_start
│   │   ├── thinking_delta*
│   │   └── thinking_end
│   │
│   ├── ToolCall Lifecycle*
│   │   ├── toolcall_start
│   │   ├── toolcall_delta*
│   │   └── toolcall_end
│   │       └── ToolCall
│   │
│   └── Terminal
│       │
│       ├── done
│       │   ├── reason
│       │   │   ├── stop
│       │   │   ├── length
│       │   │   ├── toolUse
│       │   │   └── deferred
│       │   └── message
│       │
│       └── error
│           ├── reason
│           │   ├── error
│           │   └── aborted
│           └── error
│               └── AssistantMessage
│
└── AssistantMessage
    │
    ├── Identity
    │   ├── api
    │   ├── provider
    │   ├── model
    │   ├── responseModel?
    │   └── responseId?
    │
    ├── content[]
    │   ├── TextContent
    │   ├── ThinkingContent
    │   └── ToolCall
    │
    ├── Termination
    │   ├── stopReason
    │   ├── rawStopReason?
    │   ├── endTurn?
    │   ├── errorMessage?
    │   └── deferred?
    │
    ├── Usage
    │   └── usage
    │
    ├── Diagnostics
    │   └── diagnostics?
    │
    └── timestamp
```

------

# 57. Complete Pi AI Semantic Hierarchy

```text
                           PI AI

                            │
              ┌─────────────┴─────────────┐
              │                           │
           REQUEST                     RESPONSE
              │                           │
              ▼                           ▼

         Pi Invocation          AssistantMessageEventStream
              │                           │
   ┌──────────┼──────────┐                │
   │          │          │       ┌────────┼─────────┐
 Model     Context     Options   Text   Thinking   ToolCall
   │          │          │       │         │          │
   │          │          │       └─────────┼──────────┘
   │          │          │                 │
   │          │          │            done / error
   │          │          │                 │
   │          │          │                 ▼
   │          │          │        AssistantMessage
   │          │          │
   │          │          │
   │          │          └── execution controls
   │          │
   │          └── model-visible semantics
   │
   └── model/provider identity + capability

                            │
                            ▼

                     Models Runtime
                            │
              ┌─────────────┼─────────────┐
              │             │             │
          Provider        Auth        Dispatch
              │             │             │
              └─────────────┼─────────────┘
                            │
                            ▼
                         Provider
```

------

# 58. Canonical Mental Model

The Pi AI text-generation contract can ultimately be understood as four nested layers:

```text
Layer 1 — Semantic Request

Model
+
Context
+
Options


Layer 2 — Runtime Dispatch

Models
↓
Authentication
↓
Provider


Layer 3 — Incremental Semantic Response

AssistantMessageEventStream
├── text lifecycle
├── thinking lifecycle
├── tool-call lifecycle
└── terminal


Layer 4 — Final Semantic Response

AssistantMessage
├── content
├── termination
├── usage
└── diagnostics
```

The central semantic IR remains:

```text
Model + Context + Options
        ↓
AssistantMessage
```

while:

```text
Models / Provider / Auth
```

define how the request is executed, and:

```text
AssistantMessageEventStream
```

defines how the final message is constructed incrementally.