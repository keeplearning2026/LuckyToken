# Pi AI IR Protocol

**Module:** `pi-agent/packages/ai`
**Package:** `@earendil-works/pi-ai`
**Scope:** Chat/model semantic intermediate representation, invocation controls directly associated with that IR, assistant response state, tool semantics, usage, streaming events, terminal state, and IR replay behavior required to understand the current implementation.

------

# 1. Scope

## 1.1 Pi AI IR is a semantic protocol

Pi AI does not define one universal provider HTTP wire format.

Instead, it defines a provider-neutral semantic representation:

```text
Invocation
│
├── Model
├── Context
└── Options
        │
        ▼
Provider/API implementation
        │
        ▼
AssistantMessageEventStream
        │
        ▼
AssistantMessage
```

The provider/API implementation is responsible for converting this semantic representation to and from an upstream API such as:

```text
anthropic-messages
openai-responses
openai-completions
mistral-conversations
google-generative-ai
google-vertex
bedrock-converse-stream
...
```

Pi IR therefore describes:

```text
what model is invoked
+
what semantic context is presented
+
how the invocation is controlled
+
what semantic assistant state is produced
+
how that state evolves while streaming
```

It is **not** an HTTP wire protocol.

------

## 1.2 Source-contract levels

This specification distinguishes three levels.

### Type contract

Directly represented by exported TypeScript types such as:

```text
Model
Context
Message
Tool
AssistantMessage
AssistantMessageEvent
```

### Stream contract

Defines observable lifecycle semantics such as:

```text
start
→ content lifecycle
→ done | error
```

### Current built-in runtime behavior

Some behavior is implemented by shared helpers rather than encoded directly in the static type system, for example:

```text
partial JSON parsing
cross-model replay normalization
unsupported-image downgrade
failed assistant turn removal
orphaned tool-result synthesis
simple-option normalization
```

These behaviors are identified explicitly where relevant.

------

## 1.3 Out of scope

This specification does not define:

```text
Anthropic HTTP/SSE protocol
OpenAI HTTP/SSE/WebSocket protocol
Google wire protocol
Amazon Bedrock wire protocol
authentication persistence
OAuth login flows
credential storage
provider registry architecture
image-generation APIs
agent/session/TUI protocols
protocol-to-protocol conversion rules
```

Image **input inside chat IR** is in scope.

Standalone image generation is a separate API surface.

------

# 2. Core Invocation Model

The core semantic invocation consists of:

```text
Invocation
│
├── Model
│   └── target model and capabilities
│
├── Context
│   ├── systemPrompt?
│   ├── messages[]
│   └── tools[]?
│
└── Options
    ├── generation controls
    ├── reasoning controls
    └── execution controls
```

Its streamed result is:

```text
AssistantMessageEventStream
        │
        ├── partial AssistantMessage state
        │
        └── terminal AssistantMessage
```

At the generic API implementation level, the shape is conceptually:

```ts
type StreamFunction = (
  model: Model,
  context: Context,
  options?: StreamOptions,
) => AssistantMessageEventStream
```

The simplified provider-neutral reasoning interface uses:

```ts
SimpleStreamOptions
```

instead of API-family-specific reasoning controls.

------

# 3. API and Provider Identity

## 3.1 `Api`

Pi currently defines these built-in API identifiers:

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

The type is open:

```ts
type Api =
  | KnownApi
  | (string & {})
```

Therefore custom API identifiers are legal Pi values.

Pi IR must not be interpreted as having a permanently closed API enum.

------

## 3.2 `ProviderId`

Provider identity is also open:

```ts
type ProviderId =
  | KnownProvider
  | string
```

A provider is therefore identified semantically by a string.

------

## 3.3 Three distinct identities

Pi distinguishes:

```text
provider
api
model id
```

They represent different facts.

```text
provider
→ runtime/provider identity

api
→ API implementation/protocol family

model.id
→ model identity within the provider
```

Example:

```text
provider = "openrouter"
api      = "openai-completions"
id       = "anthropic/..."
```

These values are not aliases for each other.

------

# 4. Model

## 4.1 Structure

Core type:

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

Hierarchy:

```text
Model
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
├── Request Defaults
│   ├── samplingParams?
│   └── headers?
│
└── API Compatibility
    └── compat?
```

------

## 4.2 Model input capabilities

Generic chat input capability is currently limited to:

```text
text
image
```

Example:

```ts
input: ["text", "image"]
```

This is a coarse generic capability declaration.

It does not imply that every MIME type, provider content block, document type, audio type, or provider extension is representable as generic Pi content.

------

# 5. Reasoning Capability

## 5.1 Thinking levels

Provider-neutral reasoning levels are:

```ts
type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
```

Model capability mapping additionally recognizes:

```text
off
```

through:

```ts
type ModelThinkingLevel =
  | "off"
  | ThinkingLevel
```

Important distinction:

```text
SimpleStreamOptions.reasoning
→ does NOT contain "off"

ModelThinkingLevel
→ DOES contain "off"
```

Absence of a `reasoning` request is therefore distinct from passing an `"off"` value, because `"off"` is not a legal `ThinkingLevel`.

------

## 5.2 `reasoning`

```ts
reasoning: boolean
```

declares whether the model is treated as reasoning-capable.

It is model capability metadata.

------

## 5.3 `thinkingLevelMap`

Type:

```ts
type ThinkingLevelMap =
  Partial<
    Record<
      ModelThinkingLevel,
      string | null
    >
  >
```

Base field semantics:

```text
missing key
→ use provider/model default mapping behavior

string
→ explicit provider/model-specific mapping

null
→ explicitly unsupported
```

Example:

```ts
{
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null
}
```

------

## 5.4 Supported-level helper semantics

Current `getSupportedThinkingLevels()` adds an important capability rule.

For a model with:

```text
reasoning = false
```

the supported-level helper reports only:

```text
off
```

For a reasoning model:

```text
off
minimal
low
medium
high
```

are considered supported unless their map entry is explicitly:

```text
null
```

However:

```text
xhigh
max
```

are **opt-in levels**.

For these two levels:

```text
missing mapping
→ not exposed as supported

string mapping
→ supported

null
→ unsupported
```

Therefore a missing `xhigh` or `max` entry is not equivalent to a missing ordinary level.

------

## 5.5 Thinking-level clamping

Current helper behavior orders levels as:

```text
off
minimal
low
medium
high
xhigh
max
```

If the requested level is unsupported, `clampThinkingLevel()`:

1. searches upward from the requested level for the nearest supported level;
2. if none exists, searches downward;
3. finally falls back to the first available level, normally `off`.

This is current helper behavior, not part of the static `Model` shape itself.

------

# 6. Model Limits and Sampling

## 6.1 `contextWindow`

```ts
contextWindow: number
```

describes model context capacity.

It is model metadata.

------

## 6.2 `maxTokens`

```ts
Model.maxTokens
```

describes the model's output-token capability/default metadata.

It is distinct from:

```ts
StreamOptions.maxTokens
```

which is an invocation-level requested limit.

Therefore:

```text
Model.maxTokens
≠
Options.maxTokens
```

------

## 6.3 Effective `maxTokens`

A value supplied through the simplified API is not necessarily forwarded unchanged to an upstream provider.

The shared simple-options implementation can derive an effective limit using:

```text
requested maxTokens
or Model.maxTokens
        │
        ▼
context-window allowance
        │
        ▼
effective maxTokens
```

Current shared context clamping reserves:

```text
4096 tokens
```

as a safety margin and never returns less than:

```text
1
```

token.

Reasoning-capable adapters may perform additional adjustment to fit both thinking and answer tokens into model limits.

Thus:

```text
Options.maxTokens
→ requested normalized control

effective provider limit
→ adapter-derived value
```

They are not guaranteed to be numerically identical.

------

## 6.4 Sampling defaults

A model may contain:

```ts
samplingParams?: Record<string, unknown>
```

A request may independently contain:

```ts
StreamOptions.samplingParams
```

For adapters supporting this mechanism, request entries override model entries per key.

The generic `samplingParams` mechanism is primarily used by OpenAI-compatible APIs; other API families may ignore it.

------

# 7. Model Cost

## 7.1 Cost structure

```ts
interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
```

Rates are expressed as:

```text
USD per million tokens
```

A model can define pricing tiers:

```ts
interface ModelCostTier
  extends ModelCostRates {
  inputTokensAbove: number
}
interface ModelCost
  extends ModelCostRates {
  tiers?: ModelCostTier[]
}
```

A tier applies to the whole request.

Current cost calculation selects the highest matching threshold using effective input usage based on:

```text
usage.input
+ usage.cacheRead
+ usage.cacheWrite
```

with the threshold comparison:

```text
inputTokens > inputTokensAbove
```

rather than `>=`.

------

# 8. Context

## 8.1 Structure

```ts
interface Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
}
```

Hierarchy:

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

------

## 8.2 Semantic role

`Context` contains semantic information that can participate in model interaction:

```text
system instruction
conversation history
available tools
```

Execution infrastructure such as authentication, transport, retries, abort signals and HTTP headers is not represented as `Context.messages`.

------

## 8.3 System prompt

Pi has one normalized system field:

```ts
systemPrompt?: string
```

There is no core:

```text
SystemMessage
```

and no legal:

```ts
{ role: "system", ... }
```

member in the `Message` union.

Therefore Pi's core conversation hierarchy is:

```text
Context
├── systemPrompt?
└── messages[]
```

not:

```text
messages[]
├── system
├── user
├── assistant
└── ...
```

------

# 9. Message Protocol

## 9.1 Message union

```ts
type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
```

Hierarchy:

```text
Message
├── UserMessage
├── AssistantMessage
└── ToolResultMessage
```

------

## 9.2 Parent/content matrix

Legal content relationships are:

| Parent              | Text | Image | Thinking | ToolCall |
| ------------------- | ---- | ----- | -------- | -------- |
| `UserMessage`       | yes  | yes   | no       | no       |
| `AssistantMessage`  | yes  | no    | yes      | yes      |
| `ToolResultMessage` | yes  | yes   | no       | no       |

There is no universal content-block array permitting every content type under every message role.

------

# 10. UserMessage

Exact structure:

```ts
interface UserMessage {
  role: "user"

  content:
    | string
    | (TextContent | ImageContent)[]

  timestamp: number
}
```

Hierarchy:

```text
UserMessage
│
├── role = "user"
├── content
│   ├── string
│   └── content[]
│       ├── TextContent
│       └── ImageContent
└── timestamp
```

------

## 10.1 String shorthand

Both are legal:

```ts
{
  role: "user",
  content: "Hello",
  timestamp: 123
}
```

and:

```ts
{
  role: "user",
  content: [
    {
      type: "text",
      text: "Hello"
    }
  ],
  timestamp: 123
}
```

The type system does not declare one of these two forms canonical.

------

## 10.2 Timestamp

```ts
timestamp: number
```

uses Unix time in milliseconds.

Timestamp is part of the Pi semantic/application message object.

It does not imply that every provider serializes that timestamp into model-visible upstream content.

------

# 11. Content Types

Core chat semantic content types are:

```text
Content
├── TextContent
├── ImageContent
├── ThinkingContent
└── ToolCall
```

Their legality depends on their parent message.

------

# 12. TextContent

Exact type:

```ts
interface TextContent {
  type: "text"
  text: string
  textSignature?: string
}
```

Hierarchy:

```text
TextContent
├── type = "text"
├── text
└── textSignature?
```

------

## 12.1 `textSignature`

`textSignature` is opaque provider continuity/message metadata.

Pi also defines:

```ts
interface TextSignatureV1 {
  v: 1
  id: string
  phase?:
    | "commentary"
    | "final_answer"
}
```

A `TextSignatureV1` can be serialized into the string field by implementations such as OpenAI Responses.

However:

```text
textSignature
```

must not be assumed to always contain `TextSignatureV1` JSON.

Legacy or provider-specific opaque string representations are also supported.

------

# 13. ImageContent

Exact type:

```ts
interface ImageContent {
  type: "image"
  data: string
  mimeType: string
}
```

Hierarchy:

```text
ImageContent
├── type = "image"
├── data
└── mimeType
```

`data` contains:

```text
base64-encoded image bytes
```

It does **not** contain a complete data URL.

Pi-native:

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

`mimeType` is typed as generic `string`; individual provider adapters may impose narrower MIME constraints.

------

# 14. ThinkingContent

Exact type:

```ts
interface ThinkingContent {
  type: "thinking"
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}
```

Hierarchy:

```text
ThinkingContent
├── type = "thinking"
├── thinking
├── thinkingSignature?
└── redacted?
```

------

## 14.1 Normal thinking

Typical state:

```text
ThinkingContent
├── thinking = visible/summary reasoning text
├── thinkingSignature?
└── redacted absent or false
```

------

## 14.2 Redacted thinking

Redacted reasoning remains the same Pi content type:

```text
ThinkingContent
```

rather than becoming another union member.

The state is represented using:

```text
redacted = true
```

and provider replay data can be stored in:

```text
thinkingSignature
```

The signature is opaque.

Its contents must not be interpreted as ordinary thinking text.

------

## 14.3 Reasoning signatures

`thinkingSignature` may represent provider-specific continuity information such as:

```text
encrypted reasoning state
reasoning item identifier
thought signature
```

Its interpretation belongs to the provider adapter.

Pi core represents it only as an optional string.

------

# 15. Tool Definition

## 15.1 Tool structure

```ts
interface Tool<
  TParameters extends TSchema = TSchema
> {
  name: string
  description: string
  parameters: TParameters

  constrainedSampling?:
    | false
    | ConstrainedSamplingConfig
}
```

Hierarchy:

```text
Tool
├── name
├── description
├── parameters
│   └── TypeBox schema
└── constrainedSampling?
```

`parameters` uses TypeBox `TSchema`.

Pi's core entrypoint re-exports TypeBox helpers including:

```text
Type
Static
TSchema
```

------

# 16. Constrained Sampling

The union is:

```ts
type ConstrainedSamplingConfig =
  | {
      type: "json_schema"
      strict: "prefer" | "require"
    }
  | {
      type: "grammar"
      variants: {
        openai_lark?: string
        openai_regex?: string
      }
    }
```

------

## 16.1 JSON-schema mode

Semantics:

```text
strict = "prefer"
→ use provider-side strict sampling when supported
→ otherwise allow fallback

strict = "require"
→ provider/model must support strict sampling
→ otherwise request processing fails
```

------

## 16.2 Grammar mode

Grammar variants currently include:

```text
openai_lark
openai_regex
```

Where native grammar-tool handling is supported, the current shared grammar implementation requires the tool schema to describe:

```text
object
└── exactly one required property
    └── type = string
```

If multiple supported grammar variants are supplied, current implementation prefers Lark over regex.

If native grammar support is unavailable, the generic tool may fall back to ordinary tool representation rather than grammar-constrained execution.

------

# 17. ToolCall

Exact structure:

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

Hierarchy:

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
├── Arguments
│   └── arguments
│
└── Provider Continuity
    └── thoughtSignature?
```

------

## 17.1 Tool-call identity

The core cross-message relationship is:

```text
AssistantMessage
└── ToolCall
    └── id = X

ToolResultMessage
└── toolCallId = X
```

Therefore:

```text
ToolCall.id
=
ToolResultMessage.toolCallId
```

is the primary tool-call/result identity relationship.

------

## 17.2 `thoughtSignature`

```ts
thoughtSignature?: string
```

stores opaque provider-specific continuity state associated with the tool call.

It is not part of `arguments`.

------

## 17.3 `namespace`

```ts
namespace?: string
```

supports namespaced or dynamically loaded tool semantics.

It is separate from:

```text
name
arguments
```

------

# 18. ToolResultMessage

Exact type:

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

Hierarchy:

```text
ToolResultMessage
│
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
├── State
│   └── isError
│
├── Additional Data
│   ├── details?
│   ├── usage?
│   └── addedToolNames?
│
└── timestamp
```

------

## 18.1 `isError`

```text
false
→ successful tool execution result

true
→ failed tool execution result
```

Tool failure therefore remains a:

```text
ToolResultMessage
```

rather than introducing a separate message role.

------

## 18.2 `details`

```ts
details?: TDetails
```

is application/tool-specific auxiliary data.

It is not part of the generic text/image result content model.

------

## 18.3 Tool execution usage

```ts
usage?: Usage
```

describes usage produced by tool execution where available.

It is explicitly separate from the main LLM context accounting.

------

## 18.4 Deferred tool availability

```ts
addedToolNames?: string[]
```

indicates that named tools from:

```text
Context.tools
```

became available after this result.

Providers supporting native deferred tool loading may use this information to determine a tool load point.

------

# 19. Tool Argument Completion and Validation

This distinction is essential.

Pi has three separate concepts:

```text
stream completion
JSON/object parsing
tool-schema validation
```

They are not equivalent.

------

## 19.1 Partial arguments

During streaming, a `ToolCall` can already exist in:

```text
partial.content[contentIndex]
```

while its arguments are still incomplete.

Its:

```ts
arguments
```

field is still an object because the partial JSON parser returns a best-effort object.

Therefore:

```text
arguments is an object
```

does **not** imply:

```text
tool call is complete
```

------

## 19.2 Partial JSON parsing

Current shared parsing behavior attempts:

```text
strict JSON parse
↓
JSON repair
↓
partial JSON parse
↓
partial parse after repair
↓
{}
```

Therefore malformed or incomplete serialized tool input can still yield a partial object.

Examples of incomplete states include:

```text
missing properties
truncated strings
partial arrays
partial nested objects
empty object
```

------

## 19.3 `toolcall_end`

`toolcall_end` means:

```text
the stream lifecycle for this ToolCall block has ended
```

It does **not** by itself guarantee:

```text
strict original JSON validity
schema validity
semantic validity
safe executability
```

Schema validation is a separate operation.

------

## 19.4 Tool validation

Pi provides:

```text
validateToolCall()
validateToolArguments()
```

Validation:

1. locates the declared tool;
2. clones the arguments;
3. performs TypeBox/value conversion;
4. performs additional JSON-schema coercion where applicable;
5. validates the resulting arguments against the tool schema;
6. throws if validation fails.

Consequently:

```text
toolcall_end
≠
validateToolCall succeeded
```

------

# 20. AssistantMessage

Exact structure:

```ts
interface AssistantMessage {
  role: "assistant"

  content:
    (TextContent |
     ThinkingContent |
     ToolCall)[]

  api: Api
  provider: ProviderId
  model: string

  responseModel?: string
  responseId?: string

  diagnostics?: AssistantMessageDiagnostic[]

  usage: Usage

  stopReason: StopReason

  deferred?: DeferredHandle

  errorMessage?: string
  rawStopReason?: string
  endTurn?: boolean

  timestamp: number
}
```

Hierarchy:

```text
AssistantMessage
│
├── role = "assistant"
│
├── Runtime Identity
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
├── usage
│
├── Termination
│   ├── stopReason
│   ├── rawStopReason?
│   └── endTurn?
│
├── Deferred
│   └── deferred?
│
├── Failure / Diagnostics
│   ├── errorMessage?
│   └── diagnostics?
│
└── timestamp
```

------

# 21. Assistant Identity Fields

## 21.1 `model`

```ts
model: string
```

contains the requested Pi model ID.

------

## 21.2 `responseModel`

```ts
responseModel?: string
```

contains a concrete upstream-reported model when it differs from the requested model.

Conceptually:

```text
model
→ requested model identity

responseModel
→ provider-reported effective model identity
```

This field is optional.

------

## 21.3 `responseId`

```ts
responseId?: string
```

contains an opaque upstream response/message identifier when the provider exposes one.

It is not a universal required identifier.

------

# 22. Diagnostics

An assistant message may contain:

```ts
diagnostics?: AssistantMessageDiagnostic[]
```

Diagnostic structure:

```ts
interface AssistantMessageDiagnostic {
  type: string
  timestamp: number
  error?: {
    name?: string
    message: string
    stack?: string
    code?: string | number
  }
  details?: Record<string, unknown>
}
```

Diagnostics represent provider/runtime diagnostic information.

They are separate from normal generated `content`.

------

# 23. Usage

Exact structure:

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

Hierarchy:

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

## 23.1 Reasoning-token invariant

When present:

```text
usage.reasoning
```

is a subset of:

```text
usage.output
```

Therefore this is incorrect:

```text
total output
=
output + reasoning
```

because it double-counts reasoning tokens.

------

## 23.2 `cacheWrite1h`

When present:

```text
cacheWrite1h
```

is a subset of:

```text
cacheWrite
```

It must therefore not be added again when calculating total cache-write token volume.

------

## 23.3 `totalTokens`

`totalTokens` is the normalized total recorded by the adapter.

Consumers should use the field directly rather than assuming every upstream provider exposes exactly the same raw token accounting structure.

------

# 24. StopReason

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

Meaning:

| Value      | Meaning                                       |
| ---------- | --------------------------------------------- |
| `pending`  | assistant state is still in progress          |
| `stop`     | normal successful completion                  |
| `length`   | successful terminal caused by output limit    |
| `toolUse`  | successful terminal requesting tool execution |
| `error`    | generation/runtime failure                    |
| `aborted`  | request cancellation                          |
| `deferred` | successful terminal yielding deferred work    |

`pending` is an in-progress state, not a valid successful terminal reason.

------

# 25. Deferred State

## 25.1 DeferredHandle

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

Hierarchy:

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

`id` is a provider-specific durable identifier.

`data` contains provider conversion data required to reconstruct or continue the deferred operation.

------

## 25.2 Deferred completion

A successful stream terminal can use:

```text
stopReason = "deferred"
```

and the assistant message may contain:

```text
deferred: DeferredHandle
```

------

# 26. Invocation Options

Options are invocation controls.

They are **not** conversation messages.

The normalized hierarchy is:

```text
ProviderRequestOptions
        │
        ▼
StreamOptions
        │
        ▼
SimpleStreamOptions
```

API-specific stream options may extend the generic shape.

------

# 27. ProviderRequestOptions

Core fields:

```ts
interface ProviderRequestOptions {
  signal?: AbortSignal
  telemetryContext?: TelemetryContext

  apiKey?: string
  fetch?: typeof globalThis.fetch

  env?: Record<string, string>

  onPayload?: ...
  onResponse?: ...

  headers?: Record<string, string | null>

  timeoutMs?: number
  maxRetries?: number
  maxRetryDelayMs?: number
}
```

These fields control execution and infrastructure.

They are not part of model-visible `Context`.

------

## 27.1 Headers

Header values use:

```ts
Record<string, string | null>
```

Semantics:

```text
string
→ set or override

null
→ suppress a default header with that name
```

------

## 27.2 Abort

```ts
signal?: AbortSignal
```

is the generic request cancellation input.

Normalized cancellation is represented in response state as:

```text
stopReason = "aborted"
```

and in the terminal stream event as:

```text
type = "error"
reason = "aborted"
```

------

# 28. StreamOptions

Additional fields:

```ts
interface StreamOptions
  extends ProviderRequestOptions {
  temperature?: number

  samplingParams?:
    Record<string, unknown>

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

  metadata?:
    Record<string, unknown>
}
```

Provider adapters may ignore generic controls they do not support.

------

# 29. SimpleStreamOptions

The provider-neutral simplified reasoning interface adds:

```ts
interface SimpleStreamOptions
  extends StreamOptions {
  reasoning?: ThinkingLevel

  deferred?:
    | boolean
    | {
        window?:
          | "15m"
          | "1h"
          | "24h"
      }

  thinkingBudgets?: {
    minimal?: number
    low?: number
    medium?: number
    high?: number
  }
}
```

`reasoning` is provider-neutral intent.

Individual API adapters translate it into their provider-specific form.

------

# 30. API-Specific Options

Pi also defines:

```ts
ApiStreamOptions<TApi>
```

Known API IDs resolve to their concrete option type.

Examples:

```text
anthropic-messages
→ AnthropicOptions

openai-responses
→ OpenAIResponsesOptions

google-generative-ai
→ GoogleOptions
```

Custom API strings fall back to:

```text
StreamOptions
&
Record<string, unknown>
```

Therefore there are two invocation layers:

```text
provider-neutral
→ SimpleStreamOptions

API-specific
→ ApiStreamOptions<Api>
```

------

# 31. AssistantMessageEvent Protocol

Exact event hierarchy:

```text
AssistantMessageEvent
│
├── Message Lifecycle
│   └── start
│
├── Text Lifecycle
│   ├── text_start
│   ├── text_delta
│   └── text_end
│
├── Thinking Lifecycle
│   ├── thinking_start
│   ├── thinking_delta
│   └── thinking_end
│
├── ToolCall Lifecycle
│   ├── toolcall_start
│   ├── toolcall_delta
│   └── toolcall_end
│
└── Terminal
    ├── done
    └── error
```

------

# 32. Event Union

```ts
type AssistantMessageEvent =
  | {
      type: "start"
      partial: AssistantMessage
    }

  | {
      type: "text_start"
      contentIndex: number
      partial: AssistantMessage
    }

  | {
      type: "text_delta"
      contentIndex: number
      delta: string
      partial: AssistantMessage
    }

  | {
      type: "text_end"
      contentIndex: number
      content: string
      partial: AssistantMessage
    }

  | {
      type: "thinking_start"
      contentIndex: number
      partial: AssistantMessage
    }

  | {
      type: "thinking_delta"
      contentIndex: number
      delta: string
      partial: AssistantMessage
    }

  | {
      type: "thinking_end"
      contentIndex: number
      content: string
      partial: AssistantMessage
    }

  | {
      type: "toolcall_start"
      contentIndex: number
      partial: AssistantMessage
    }

  | {
      type: "toolcall_delta"
      contentIndex: number
      delta: string
      partial: AssistantMessage
    }

  | {
      type: "toolcall_end"
      contentIndex: number
      toolCall: ToolCall
      partial: AssistantMessage
    }

  | {
      type: "done"
      reason:
        | "stop"
        | "length"
        | "toolUse"
        | "deferred"
      message: AssistantMessage
    }

  | {
      type: "error"
      reason:
        | "error"
        | "aborted"
      error: AssistantMessage
    }
```

------

# 33. Stream Lifecycle

The declared stream contract is:

```text
start
↓
zero or more content lifecycles
↓
done | error
```

A conforming assistant stream terminates semantically with exactly one of:

```text
done
error
```

------

# 34. `start`

```text
start
└── partial
```

The `partial` assistant message normally begins with:

```text
content = []
stopReason = "pending"
```

plus model/provider identity and zero or initial usage.

`start` represents Pi-level assistant generation beginning.

It is distinct from provider HTTP connection establishment.

------

# 35. `partial`

Most non-terminal events contain:

```ts
partial: AssistantMessage
```

This object represents the current accumulated assistant state.

Conceptually:

```text
partial
├── content accumulated so far
├── usage accumulated so far
├── response identity discovered so far
└── stopReason normally pending
```

`partial` is mutable accumulated stream state in the current implementations.

It must not be interpreted as a final immutable message merely because some fields appear complete.

------

# 36. `contentIndex`

Every content lifecycle event carries:

```ts
contentIndex: number
```

It refers to the corresponding semantic block in:

```text
partial.content[contentIndex]
```

Thus the stream hierarchy is:

```text
AssistantMessage
└── content[index]
    ├── TextContent lifecycle
    ├── ThinkingContent lifecycle
    └── ToolCall lifecycle
```

The protocol does not define one global untyped content-delta channel.

------

# 37. Text Streaming

Lifecycle:

```text
text_start
↓
text_delta*
↓
text_end
```

`text_delta.delta` contains newly received text.

`text_end.content` contains the completed text value for that semantic block.

At end:

```text
partial.content[contentIndex]
```

is the corresponding `TextContent`.

------

# 38. Thinking Streaming

Lifecycle:

```text
thinking_start
↓
thinking_delta*
↓
thinking_end
```

`thinking_delta.delta` contains newly received reasoning/thinking text.

`thinking_end.content` contains the completed visible `thinking` string for the block.

Opaque signatures may be accumulated separately by the provider adapter and do not necessarily appear as delta text.

------

# 39. ToolCall Streaming

Lifecycle:

```text
toolcall_start
↓
toolcall_delta*
↓
toolcall_end
```

This lifecycle is semantically distinct from text and thinking.

------

## 39.1 Tool-call start

At:

```text
toolcall_start
```

a `ToolCall` already exists in:

```text
partial.content[contentIndex]
```

Typically its:

```text
id
name
arguments
```

fields already exist.

`arguments` may initially be:

```ts
{}
```

------

## 39.2 Tool-call delta

Event:

```ts
{
  type: "toolcall_delta",
  contentIndex,
  delta,
  partial
}
```

Two representations coexist:

```text
event.delta
→ raw incremental serialized argument fragment

partial.content[index].arguments
→ current best-effort parsed object
```

These are deliberately different forms of the same in-progress input.

------

## 39.3 Tool-call end

Event:

```ts
{
  type: "toolcall_end",
  contentIndex,
  toolCall,
  partial
}
```

At this point the **stream block** is complete.

The provided:

```text
toolCall
```

is the finalized Pi `ToolCall` object for that stream lifecycle.

As established earlier, this does not imply independent tool-schema validation has succeeded.

------

# 40. Terminal Success

Successful terminal event:

```ts
{
  type: "done",
  reason:
    | "stop"
    | "length"
    | "toolUse"
    | "deferred",
  message: AssistantMessage
}
```

A `done` event cannot carry:

```text
pending
error
aborted
```

according to the event union.

------

# 41. Terminal Failure

Failure terminal:

```ts
{
  type: "error",
  reason:
    | "error"
    | "aborted",
  error: AssistantMessage
}
```

The assistant message can retain state accumulated before failure:

```text
partial content
partial usage
response identifiers
diagnostics
```

depending on where failure occurred.

------

# 42. EventStream Result Semantics

`AssistantMessageEventStream` derives its final result from either terminal type:

```text
done
→ event.message

error
→ event.error
```

Therefore:

```ts
const message =
  await stream.result()
```

does **not** mean the generation succeeded.

The promise resolves for both successful and failed semantic terminals.

Success or failure is determined from:

```text
message.stopReason
```

------

## 42.1 Success states

```text
stop
length
toolUse
deferred
```

------

## 42.2 Failure states

```text
error
aborted
```

------

# 43. Stream Terminal State

`EventStream.push()` ignores later events after the stream has entered its internal completed state.

Therefore a terminal event closes the semantic event sequence.

The generic `EventStream.end()` method can also terminate iteration, but the `AssistantMessageEvent` protocol itself defines:

```text
done | error
```

as semantic terminals.

------

# 44. Failure Encoding

The exported `StreamFunction` contract documents that request/model/runtime failures should be represented through the returned assistant stream as:

```text
error event
+
AssistantMessage
+
stopReason = error | aborted
+
errorMessage
```

The `lazyStream()` helper additionally converts asynchronous setup failures into:

```text
AssistantMessage
├── content = []
├── usage = zero
├── stopReason = "error"
├── errorMessage
└── timestamp
```

followed by an:

```text
error
```

terminal event.

This is an observable runtime normalization performed by the standard lazy wrapper.

The abstract stream contract should not be interpreted as a TypeScript proof that an arbitrary directly invoked custom implementation can never throw before returning a stream.

------

# 45. Abort Semantics

Cancellation input:

```ts
AbortSignal
```

Normalized cancellation state:

```text
AssistantMessage.stopReason
=
"aborted"
```

Terminal event:

```text
type = "error"
reason = "aborted"
```

An aborted assistant message may contain partial data accumulated before cancellation.

Abort is therefore distinct from:

```text
normal stop
length stop
generic error
```

------

# 46. AssistantMessage as Historical IR

`AssistantMessage` is both:

1. a generated result;
2. a legal member of a future `Context.messages`.

The static type therefore supports:

```text
Context.messages
├── UserMessage
├── AssistantMessage
├── ToolResultMessage
└── ...
```

However **type-level representability must be distinguished from replay behavior**.

The fact that an `AssistantMessage` can be stored in `Context.messages` does not imply every field or every failed state is replayed unchanged to every target model.

------

# 47. Shared Replay Normalization

Several built-in provider adapters preprocess historical `Message[]` using the shared:

```text
transformMessages()
```

This behavior is not encoded directly in the `Message` union, but materially affects how stored Pi IR is replayed.

It must therefore be distinguished from the static IR type contract.

------

## 47.1 Untyped null content normalization

For untyped callers or old persisted data, a message whose:

```text
content == null
```

can be normalized to:

```text
content = []
```

before provider conversion.

Valid typed Pi objects should already satisfy their declared content types.

------

## 47.2 Unsupported images

When the target model does not declare:

```text
input includes "image"
```

shared transformation replaces image content with text placeholders.

Current placeholders distinguish:

```text
user image
tool-result image
```

Thus a historical `ImageContent` is not guaranteed to reach a non-vision target provider as an image.

------

## 47.3 Cross-model reasoning continuity

For historical assistant messages, shared transformation compares the source assistant identity to the target model.

For cross-model replay:

```text
redacted thinking
→ dropped

ordinary thinking
→ converted to TextContent when usable text exists

thinkingSignature
→ not preserved as foreign reasoning state
```

This reflects the fact that provider reasoning continuity data is generally model/provider specific.

------

## 47.4 Text signatures

For cross-model replay, `TextContent` is reconstructed as ordinary text and provider-specific:

```text
textSignature
```

is not preserved.

------

## 47.5 Tool thought signatures

For cross-model replay:

```text
ToolCall.thoughtSignature
```

is removed.

------

## 47.6 Tool-call ID normalization

A target adapter may supply an ID-normalization callback.

If a historical tool-call ID is rewritten:

```text
original ToolCall.id
→ normalized ToolCall.id
```

the shared transform records the mapping and rewrites corresponding:

```text
ToolResultMessage.toolCallId
```

to preserve call/result identity.

------

## 47.7 Failed assistant turns

Current shared replay transformation removes assistant messages whose:

```text
stopReason = "error"
```

or:

```text
stopReason = "aborted"
```

before provider serialization.

Therefore:

```text
AssistantMessage with stopReason aborted/error
```

is a legal Pi object and a legal `Message` union member, but in adapters using this shared transformation it is **not replayed as an ordinary assistant turn**.

This is an important distinction between:

```text
IR representability
```

and:

```text
provider replay behavior
```

------

## 47.8 Orphaned tool calls

Shared replay transformation also repairs historical tool-call sequences.

If an assistant tool call lacks a corresponding tool result before the conversation advances, the current implementation can synthesize:

```ts
{
  role: "toolResult",
  toolCallId: <tool call id>,
  toolName: <tool name>,
  content: [
    {
      type: "text",
      text: "No result provided"
    }
  ],
  isError: true,
  timestamp: Date.now()
}
```

This is runtime repair behavior.

It is **not** a requirement of the static `ToolResultMessage` type that such synthetic messages already exist in stored IR.

------

# 48. Core Static Invariants

The following invariants follow directly from the current exported semantic types.

## 48.1 Context hierarchy

```text
Context
├── systemPrompt?
├── messages[]
└── tools[]?
```

------

## 48.2 Message hierarchy

```text
Message
├── UserMessage
├── AssistantMessage
└── ToolResultMessage
```

------

## 48.3 Parent/content rules

Illegal according to current static types:

```text
UserMessage + ThinkingContent
UserMessage + ToolCall

AssistantMessage + ImageContent

ToolResultMessage + ThinkingContent
ToolResultMessage + ToolCall
```

------

## 48.4 Image representation

```text
ImageContent.data
=
base64 bytes
```

not a complete data URL.

------

## 48.5 Tool relationship

```text
ToolCall.id
↔
ToolResultMessage.toolCallId
```

is the cross-message identity link.

------

## 48.6 Streaming block identity

```text
contentIndex
↔
AssistantMessage.content[index]
```

is the stream-to-content relationship.

------

## 48.7 Partial tool state

A populated:

```text
ToolCall.arguments
```

during `toolcall_delta` is still partial state.

------

## 48.8 Tool block completion

```text
toolcall_end
```

means stream-level completion of the block.

It does not mean schema validation succeeded.

------

## 48.9 Terminal success/failure

```text
done
→ stop | length | toolUse | deferred

error
→ error | aborted
```

------

## 48.10 Result semantics

```text
stream.result()
```

returns the final `AssistantMessage` for both success and failure.

------

## 48.11 Usage subsets

```text
reasoning ⊆ output

cacheWrite1h ⊆ cacheWrite
```

------

## 48.12 Extensible identities

```text
Api
ProviderId
```

are open string identities rather than permanently closed enums.

------

# 49. Complete IR Tree

```text
Pi AI Chat IR
│
├── Model
│   ├── id
│   ├── name
│   ├── api
│   ├── provider
│   ├── baseUrl
│   ├── reasoning
│   ├── thinkingLevelMap?
│   ├── input[]
│   ├── cost
│   ├── contextWindow
│   ├── maxTokens
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
│   │   │   ├── role = "user"
│   │   │   ├── content
│   │   │   │   ├── string
│   │   │   │   └── content[]
│   │   │   │       ├── TextContent
│   │   │   │       └── ImageContent
│   │   │   └── timestamp
│   │   │
│   │   ├── AssistantMessage
│   │   │   ├── role = "assistant"
│   │   │   ├── content[]
│   │   │   │   ├── TextContent
│   │   │   │   ├── ThinkingContent
│   │   │   │   └── ToolCall
│   │   │   ├── api
│   │   │   ├── provider
│   │   │   ├── model
│   │   │   ├── responseModel?
│   │   │   ├── responseId?
│   │   │   ├── usage
│   │   │   ├── stopReason
│   │   │   ├── deferred?
│   │   │   ├── errorMessage?
│   │   │   ├── diagnostics?
│   │   │   ├── rawStopReason?
│   │   │   ├── endTurn?
│   │   │   └── timestamp
│   │   │
│   │   └── ToolResultMessage
│   │       ├── role = "toolResult"
│   │       ├── toolCallId
│   │       ├── toolName
│   │       ├── content[]
│   │       │   ├── TextContent
│   │       │   └── ImageContent
│   │       ├── details?
│   │       ├── usage?
│   │       ├── addedToolNames?
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
├── Content
│   │
│   ├── TextContent
│   │   ├── type = "text"
│   │   ├── text
│   │   └── textSignature?
│   │
│   ├── ImageContent
│   │   ├── type = "image"
│   │   ├── data
│   │   └── mimeType
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
├── Options
│   ├── ProviderRequestOptions
│   ├── StreamOptions
│   ├── SimpleStreamOptions
│   └── ApiStreamOptions<Api>
│
└── Response Stream
    │
    └── AssistantMessageEventStream
        │
        ├── start
        │
        ├── Content[index]*
        │   ├── text_start
        │   ├── text_delta*
        │   ├── text_end
        │   ├── thinking_start
        │   ├── thinking_delta*
        │   ├── thinking_end
        │   ├── toolcall_start
        │   ├── toolcall_delta*
        │   └── toolcall_end
        │
        └── Terminal
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

# 50. Source Basis

This specification is derived primarily from the current implementation under:

```text
pi-agent/packages/ai/src/types.ts
pi-agent/packages/ai/src/models.ts
pi-agent/packages/ai/src/utils/event-stream.ts
pi-agent/packages/ai/src/utils/json-parse.ts
pi-agent/packages/ai/src/utils/validation.ts
pi-agent/packages/ai/src/api/simple-options.ts
pi-agent/packages/ai/src/api/transform-messages.ts
pi-agent/packages/ai/src/api/lazy.ts
```

Provider adapters are used only where necessary to establish the observable meaning of generic IR fields and streaming lifecycle behavior.

Provider-specific HTTP schemas and provider-specific conversion rules are intentionally not part of this protocol.