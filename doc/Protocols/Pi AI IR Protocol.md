# Pi AI IR Protocol

**Version:** 0.10.0
**Status:** Frozen

**Reference Repository:** `earendil-works/pi`
**Reference Commit:** `914cf1472e715297caa30db4b9535d534a9eb718` (`v0.84.2`)
**Vendored LuckyToken Snapshot:** `fd7601d78aaed3fb0aca0ee9479faf5bcf2c5575`
**Reference Package:** `@earendil-works/pi-ai` `0.84.2`
**Reference Date:** `2026-08-14`

**Reference Module:** `pi-agent/packages/ai`

---

## 1. Protocol Foundations

### 1.1 Purpose

This specification describes Pi's **chat/model contract family**. Its detailed scope boundary is defined in §1.2.

Pi AI defines provider-neutral chat/model data contracts together with the invocation, shared normalization, streaming, and runtime contracts needed to interpret them correctly.

The high-level runtime relationship is:

```text
Model
+
Context
+
Invocation Controls
        │
        ▼
API / Provider Adapter
        │
        ├── may apply shared helpers
        │   ├── historical replay normalization
        │   ├── simplified-option helpers
        │   └── tool constraint adaptation
        │
        ├── provider-specific conversion
        │
        ├── constructs callback-visible payload
        │
        ├── may invoke onPayload
        │
        └── performs remaining provider/SDK processing
        │
        ▼
Provider Request
        │
        ▼
AssistantMessageEventStream
        │
        ▼
AssistantMessage
```

Shared helpers are not mandatory generic middleware stages.

Specific API implementations decide which helpers they use while translating Pi data into provider requests.

Pi normalizes common chat concepts including:

```text
model identity and capabilities

system instruction
conversation messages
tools

text
images
thinking / reasoning
tool calls
tool results

usage and cost
termination
deferred state

streaming lifecycle
success / failure
```

Pi chat IR is not itself:

```text
HTTP
SSE
WebSocket

provider-native request schema
provider-native response schema

agent/session/TUI protocol
```

---

### 1.2 Scope

This specification covers the Pi **chat/model contract family**.

It is organized into five primary logical domains:

```text
Pi AI Chat Contract
│
├── Core Data Contracts
├── Invocation Contract
├── Shared Historical Replay Normalization
├── Response Streaming Protocol
└── Runtime Boundaries
```

**Core Data Contracts** describe Pi's shared model/chat structures.

**Invocation Contract** describes controls supplied together with `Model` and `Context`, including initial streaming requests and deferred continuation/cancellation operations.

**Shared Historical Replay Normalization** describes shared replay helpers such as `transformMessages()`.

It is not a mandatory `Provider` / `Models` invocation stage.

**Response Streaming Protocol** describes incremental production of `AssistantMessage`.

**Runtime Boundaries** describe implementation layers that materially affect observable behavior without becoming conversation state.

The following are explicitly outside this specification:

```text
Pi image-generation contract family

ImagesApi
ImagesProviderId
ImagesModel
ImagesContext
ImagesOptions
AssistantImages
ProviderImages
ImagesFunction

protocol-to-protocol conversion specifications

LuckyToken architecture
```

Therefore:

```text
Pi Chat Protocol
≠
Pi Image-Generation Contract

Pi Chat Protocol
≠
Anthropic ↔ Pi Conversion Specification

Pi Chat Protocol
≠
LuckyToken Architecture
```

---

### 1.3 Protocol Map

```text
Pi AI Chat Contract
│
├── Core Data Contracts
│   ├── Shared Identity Types
│   ├── Model Descriptor
│   ├── Shared Value Types
│   └── Context
│       ├── System Prompt
│       ├── Messages
│       └── Tools
│
├── Invocation Contract
│   ├── Request Options
│   ├── API-Specific Invocation
│   ├── Simplified Invocation
│   ├── Shared Simplified Helpers
│   ├── Shared Tool Constraint Adaptation
│   └── Deferred Continuation / Cancellation
│
├── Shared Historical Replay Normalization
│   ├── Input Normalization
│   ├── Content Replay
│   ├── Failed-Turn Filtering
│   └── Tool Sequence Repair
│
├── Response Streaming Protocol
│   ├── Event Model
│   ├── Content Lifecycles
│   ├── Interleaving
│   ├── Terminal Events
│   └── EventStream Boundary
│
└── Runtime Boundaries
    ├── Direct API Module
    ├── ProviderStreams
    ├── Provider
    ├── Models
    ├── AbortSignal Classification
    └── Deferred Runtime Failure Surfaces
```

This hierarchy is documentation structure.

It does not introduce additional Pi IR or runtime types.

---

### 1.4 Contract Levels

Different statements in this specification have different authority levels.

#### 1.4.1 Static Type Contract

Defined by exported TypeScript types and callable signatures.

This category includes:

```text
data structures
option types
event unions
function signatures
generic type relationships
```

Examples:

```text
Model
Context
Message

StreamOptions
ApiStreamOptions
DeferredFetchOptions

AssistantMessageEvent

StreamFunction
```

A static type contract defines intended structure or callable shape.

It does not prove every runtime producer conforms to or validates that structure.

---

#### 1.4.2 Semantic Relationship

Some contracts relate fields belonging to independent structures.

Examples:

```text
ToolCall.id
↔
ToolResultMessage.toolCallId
```

and:

```text
event.contentIndex
↔
AssistantMessage.content[index]
```

These relationships cannot be guaranteed by primitive TypeScript field types alone.

---

#### 1.4.3 Source-Declared Producer Contract

Some source declarations and comments describe intended producer behavior.

Examples:

```text
start precedes partial/content updates

stream terminates using done | error

StreamFunction should return a stream
rather than throwing request/runtime failures

onPayload can inspect or replace the
callback-visible request payload

DeferredFetchOptions.wait defaults to 0
and 0 means one status check
```

Executable implementations can contain gaps relative to these declarations.

---

#### 1.4.4 Observed Runtime Behavior

Some facts are established by current executable behavior rather than static types or declared producer contracts.

Examples:

```text
error may occur before start

error may interrupt active content blocks

contentIndex lifecycles may interleave

event.partial may reference reused mutable state

some adapters merge samplingParams
after named payload fields

onPayload can be followed by
additional adapter/wire conversion

lazyStream catch covers setup and
forwarding-chain rejection

Models.fetchDeferred and
Models.cancelDeferred expose
different failure surfaces
```

Observed behavior in this document is pinned to the reference commit.

---

#### 1.4.5 Runtime Enforcement

Runtime enforcement means behavior actively performed or checked by generic infrastructure.

For example:

```text
push(done | error)
→ EventStream marks itself done
→ result resolves
→ later push() calls are ignored
```

The generic stream container does not validate the full assistant lifecycle.

---

#### 1.4.6 Shared Helper / Normalization Behavior

Pi exposes shared helpers used by concrete adapters and runtime paths.

Examples include:

```text
buildBaseOptions()

adjustMaxTokensForThinking()

transformMessages()

constrained-sampling helpers

parseStreamingJson()
```

A helper's existence and behavior do not imply that every API implementation invokes it.

Therefore:

```text
shared helper behavior
≠
universal mandatory runtime stage
```

---

### 1.5 Interpretation Rule

The central distinction is:

```text
static type contract
        ≠
semantic relationship
        ≠
source-declared producer contract
        ≠
observed runtime behavior
        ≠
runtime enforcement
        ≠
shared helper / normalization behavior
```

A statement at one level must not automatically be promoted to another.

---

### 1.6 Runtime Boundary

The following are not conversation semantic state:

```text
credentials
authentication resolution
OAuth

provider registry
model discovery / refresh

HTTP headers
base-URL resolution
fetch implementation

request payload callbacks
request serialization

retry settings
timeouts

lazy module loading
Provider construction
Models request transformation
```

They are included only where they materially affect observable Pi chat behavior.

---

### 1.7 Deferred Boundary

Pi chat data contracts include deferred state:

```text
AssistantMessage.stopReason = "deferred"

AssistantMessage.deferred
→ DeferredHandle
```

Deferred work can subsequently be fetched or cancelled through runtime APIs.

The deferred handle is semantic/runtime continuation state.

The fetch/cancel operations themselves belong to the invocation/runtime contract rather than conversation message content.

---

## 2. Core Data Contracts

The core data hierarchy is:

```text
Core Data Contracts
│
├── Shared Identity Types
├── Model Descriptor
├── Shared Value Types
└── Context
    ├── systemPrompt?
    ├── messages[]
    └── tools[]?
```

`Context` contains semantic conversation state.

`Model` additionally contains provider/runtime metadata required to describe invocation.

---

### 2.1 Shared Identity Types

#### 2.1.1 API Identity

Known chat API identifiers at the reference snapshot are:

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

The type remains open:

```ts
type Api =
  | KnownApi
  | (string & {})
```

Custom API identifiers are therefore legal.

`Api` must not be interpreted as a permanently closed enum.

---

#### 2.1.2 Provider Identity

```ts
type ProviderId =
  | KnownProvider
  | string
```

Provider identity is also open.

---

#### 2.1.3 Provider, API, and Model Identity

Pi preserves three distinct identities:

```text
provider
api
model.id
```

Their meanings are:

```text
provider
→ provider/runtime identity

api
→ API implementation/protocol family

model.id
→ model identity within that provider
```

Example:

```text
provider = "openrouter"
api      = "openai-completions"
model.id = "anthropic/..."
```

These values must not be treated as aliases.

---

### 2.2 Model Descriptor

#### 2.2.1 Static Structure

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

Natural organization:

```text
Model
│
├── Identity
├── Capabilities
├── Limits / Defaults
├── Pricing
└── Runtime-Oriented Metadata
```

---

#### 2.2.2 Identity

```text
Model
├── id
├── name
├── provider
└── api
```

These identify both the model and the runtime/API family through which Pi expects it to be used.

---

#### 2.2.3 Capabilities

**Input capability**

```ts
input: ("text" | "image")[]
```

The generic Pi chat capability vocabulary currently distinguishes:

```text
text
image
```

This is a coarse provider-neutral declaration.

It does not imply every provider-native multimodal type has a corresponding Pi chat content type.

**Reasoning capability**

```ts
reasoning: boolean
```

declares whether Pi treats the model as reasoning-capable.

**ThinkingLevel**

```ts
type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
```

Capability helpers additionally recognize:

```ts
type ModelThinkingLevel =
  | "off"
  | ThinkingLevel
```

Therefore:

```text
ThinkingLevel
≠
ModelThinkingLevel
```

`SimpleStreamOptions.reasoning` accepts `ThinkingLevel` and does not accept `"off"`.

**ThinkingLevelMap**

```ts
type ThinkingLevelMap =
  Partial<
    Record<
      ModelThinkingLevel,
      string | null
    >
  >
```

General mapping interpretation:

```text
missing key
→ provider/model default mapping behavior

string
→ explicit provider/model-specific value

null
→ explicitly unsupported
```

**Supported-level resolution**

For:

```text
model.reasoning = false
```

the supported-level helper returns:

```text
["off"]
```

For reasoning models:

```text
off
minimal
low
medium
high
```

are supported unless explicitly mapped to `null`.

The extended levels:

```text
xhigh
max
```

are opt-in.

For those levels:

```text
missing
→ not exposed as supported

string
→ supported

null
→ unsupported
```

**Thinking-level clamping**

Pi orders levels as:

```text
off
minimal
low
medium
high
xhigh
max
```

`clampThinkingLevel()` behaves as:

```text
requested level supported
→ requested

otherwise
→ search upward

if none
→ search downward

if none
→ availableLevels[0] ?? "off"
```

If the supported list is empty:

```text
clampThinkingLevel(...)
→ "off"
```

even if `"off"` itself was explicitly mapped to `null`.

This is helper behavior rather than a static `Model` invariant.

---

#### 2.2.4 Limits and Defaults

**Context window**

```ts
contextWindow: number
```

describes context-capacity metadata.

**Model output limit**

```ts
maxTokens: number
```

provides model-level output-limit metadata/default.

It is distinct from request-level:

```text
StreamOptions.maxTokens
```

**Model sampling defaults**

```ts
samplingParams?: Record<string, unknown>
```

contains model-level sampling defaults.

Request-side merging and adapter payload precedence are described in §3.4.2.

---

#### 2.2.5 Pricing

**ModelCostRates**

```ts
interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
```

Rates are USD per million tokens.

**ModelCostTier**

```ts
interface ModelCostTier
  extends ModelCostRates {
  inputTokensAbove: number
}
```

**ModelCost**

```ts
interface ModelCost
  extends ModelCostRates {
  tiers?: ModelCostTier[]
}
```

Tier-selection input is:

```text
inputTokens =
  usage.input
  + usage.cacheRead
  + usage.cacheWrite
```

A tier matches only when:

```text
inputTokens > tier.inputTokensAbove
```

The comparison is strictly `>`.

If multiple tiers match:

```text
select the matching tier
with the greatest inputTokensAbove
```

The selected rate set applies to the **entire request**.

---

#### 2.2.6 Runtime-Oriented Model Metadata

The `Model` descriptor also contains fields primarily used for provider/runtime adaptation:

```text
baseUrl
headers
compat
```

`compat` is API-dependent and can contain compatibility metadata for API families including:

```text
openai-completions
openai-responses
azure-openai-responses
openai-codex-responses
anthropic-messages
bedrock-converse-stream
```

These fields belong to the Pi model descriptor but are not ordinary model-visible conversation content.

---

### 2.3 Shared Value Types

#### 2.3.1 Usage

`Usage` is referenced by:

```text
AssistantMessage.usage
```

and optionally:

```text
ToolResultMessage.usage
```

It therefore has one shared authoritative definition.

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

**Reasoning tokens**

When reported:

```text
reasoning ⊆ output
```

`output` already includes reasoning tokens.

Therefore adding `reasoning` to `output` double-counts them.

**One-hour cache writes**

When reported:

```text
cacheWrite1h ⊆ cacheWrite
```

Adding `cacheWrite1h` to `cacheWrite` also double-counts tokens.

**Cache-write cost**

Define:

```text
longWrite =
usage.cacheWrite1h ?? 0

shortWrite =
usage.cacheWrite - longWrite
```

Current calculation is:

```text
usage.cost.cacheWrite =
(
  rates.cacheWrite * shortWrite
  +
  rates.input * 2 * longWrite
)
/ 1_000_000
```

Thus:

```text
ordinary cache write
→ rates.cacheWrite

1h cache write
→ rates.input × 2
```

**Total cost**

```text
cost.total =
  cost.input
  + cost.output
  + cost.cacheRead
  + cost.cacheWrite
```

after request-wide rate selection.

---

#### 2.3.2 StopReason

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

| Value | Meaning |
|---|---|
| `pending` | assistant state remains in progress |
| `stop` | normal successful completion |
| `length` | successful output-limit termination |
| `toolUse` | successful terminal requesting tool execution |
| `error` | ordinary failure |
| `aborted` | normalized aborted terminal representation |
| `deferred` | successful deferred terminal |

The precise relationship between `AbortSignal` cancellation and `"aborted"` is runtime-path dependent and is described in §6.6.

---

#### 2.3.3 JsonValue

```ts
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue
    }
```

This represents JSON-compatible provider/runtime state.

---

#### 2.3.4 DeferredHandle

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

Natural structure:

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

`id` is the provider-side durable identifier/token.

`data` can retain JSON-compatible provider conversion state needed to reconstruct a later final assistant response.

The type is referenced by both assistant state and deferred runtime APIs.

---

### 2.4 Context

#### 2.4.1 Structure

```ts
interface Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
}
```

Natural hierarchy:

```text
Context
│
├── systemPrompt?
├── messages[]
└── tools[]?
```

`Context` owns semantic conversation state.

Credentials, transport controls, HTTP configuration, payload callbacks, and cancellation controls do not belong in it.

---

#### 2.4.2 System Prompt

Pi represents normalized system instruction as:

```ts
systemPrompt?: string
```

There is no core `SystemMessage` member of the `Message` union.

Thus:

```text
Context
├── systemPrompt?
└── messages[]
```

is the actual hierarchy.

---

#### 2.4.3 Messages

##### 2.4.3.1 Message Union

```ts
type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
```

Content legality depends on the parent message:

| Parent | Text | Image | Thinking | ToolCall |
|---|---:|---:|---:|---:|
| `UserMessage` | yes | yes | no | no |
| `AssistantMessage` | yes | no | yes | yes |
| `ToolResultMessage` | yes | yes | no | no |

Pi therefore does not expose one flattened content union legal under every message role.

---

##### 2.4.3.2 Content Model

Shared content structures are:

```text
Content Structures
├── TextContent
├── ImageContent
├── ThinkingContent
└── ToolCall
```

Their legal use is determined by the parent message.

**TextContent**

```ts
interface TextContent {
  type: "text"
  text: string
  textSignature?: string
}
```

`textSignature` is opaque at the core type level.

Pi additionally defines:

```ts
interface TextSignatureV1 {
  v: 1
  id: string
  phase?:
    | "commentary"
    | "final_answer"
}
```

Some adapters can encode this structure into `textSignature`.

However:

```text
textSignature
≠ guaranteed TextSignatureV1 JSON
```

Legacy/provider-specific strings remain legal.

**ImageContent**

```ts
interface ImageContent {
  type: "image"
  data: string
  mimeType: string
}
```

`data` contains base64-encoded image bytes rather than a complete data URL.

**ThinkingContent**

```ts
interface ThinkingContent {
  type: "thinking"
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}
```

`thinkingSignature` contains opaque provider continuity information.

Redacted reasoning remains:

```text
ThinkingContent
└── redacted = true
```

with provider replay data potentially retained in `thinkingSignature`.

**ToolCall**

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

Static Pi data requires:

```text
arguments
→ object-shaped
```

through `Record<string, any>`.

Current streaming parsing does not fully runtime-enforce that shape; see §5.4.3.

---

##### 2.4.3.3 UserMessage

```ts
interface UserMessage {
  role: "user"

  content:
    | string
    | (TextContent | ImageContent)[]

  timestamp: number
}
```

Natural hierarchy:

```text
UserMessage
├── content
│   ├── string
│   └── TextContent | ImageContent
└── timestamp
```

Both string shorthand and structured content arrays are legal.

`timestamp` is Unix time in milliseconds.

---

##### 2.4.3.4 AssistantMessage

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

Natural hierarchy:

```text
AssistantMessage
│
├── Identity
├── Content
├── Usage
├── Termination State
├── Diagnostics
└── timestamp
```

**Identity**

```text
api
provider
model
responseModel?
responseId?
```

`model` is the requested Pi model ID.

`responseModel` can preserve a concrete upstream-reported model.

`responseId` is an opaque provider response/message identifier where available.

**Content**

Legal assistant content:

```text
TextContent
ThinkingContent
ToolCall
```

`ImageContent` is not directly legal in `AssistantMessage.content`.

**Usage**

```text
usage: Usage
```

references the shared `Usage` contract from §2.3.1.

**Termination state**

```text
stopReason: StopReason
deferred?: DeferredHandle
```

references shared contracts from §2.3.

Additional provider termination metadata includes:

```text
rawStopReason?
endTurn?
```

`rawStopReason` preserves provider-specific stop information.

`endTurn` preserves provider indication of whether the model explicitly ended its turn.

It does not currently control generic agent flow.

**Diagnostics**

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

Diagnostics are provider/runtime metadata rather than assistant content blocks.

---

##### 2.4.3.5 ToolResultMessage

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

Natural structure:

```text
ToolResultMessage
│
├── Tool Identity
├── Content
├── Result State
├── Auxiliary Data
└── timestamp
```

**Tool identity**

```text
toolCallId
toolName
```

`toolCallId` links the result to the originating ToolCall.

**Content**

Legal content:

```text
TextContent
ImageContent
```

**Result state**

```text
isError = false
→ successful tool execution

isError = true
→ failed tool execution
```

A failed tool still uses the `toolResult` role.

**Tool usage**

```text
usage?: Usage
```

uses the shared `Usage` shape.

The source treats this as tool-execution usage rather than main LLM context accounting.

**Additional data**

```text
details?
addedToolNames?
```

`details` is application/tool-specific data.

`addedToolNames` identifies tools from `Context.tools` made available after the result for providers supporting native deferred tool loading.

---

#### 2.4.4 Tools

##### 2.4.4.1 Tool

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

`parameters` is a TypeBox schema describing expected tool-call arguments.

---

##### 2.4.4.2 ConstrainedSamplingConfig

Static configuration:

```ts
type GrammarFormat =
  | "openai_lark"
  | "openai_regex"

type GrammarVariants =
  Partial<
    Record<
      GrammarFormat,
      string
    >
  >
```

and:

```ts
type ConstrainedSamplingConfig =
  | {
      type: "json_schema"
      strict:
        | "prefer"
        | "require"
    }

  | {
      type: "grammar"
      variants: GrammarVariants
    }
```

This subsection defines stored/configured data only.

Runtime interpretation belongs to §3.5.

---

#### 2.4.5 Tool Relationships

Tool interaction spans three existing structures:

```text
Tool Interaction
│
├── Declaration
│   └── Context.tools[]
│       └── Tool
│
├── Call
│   └── AssistantMessage.content[]
│       └── ToolCall
│
└── Result
    └── Context.messages[]
        └── ToolResultMessage
```

This is descriptive hierarchy, not a new Pi type.

The semantic identity link is:

```text
ToolCall.id
        ↕
ToolResultMessage.toolCallId
```

Their equality is a semantic relationship rather than a TypeScript-enforced invariant.

---

## 3. Invocation Contract

Invocation controls accompany:

```text
Model
+
Context
```

without becoming conversation state.

The full generic option hierarchy is:

```text
ProviderRequestOptions
│
├── StreamOptions
│   ├── ApiStreamOptions<TApi>
│   └── SimpleStreamOptions
│
├── DeferredFetchOptions
│   └── wait?
│
└── DeferredCancelOptions
```

The branches serve different operations:

```text
StreamOptions
→ new assistant-response invocation

DeferredFetchOptions
→ continue / poll previously deferred work

DeferredCancelOptions
→ request cancellation of previously deferred work
```

---

### 3.1 Request Option Hierarchy

#### 3.1.1 ProviderRequestOptions

Conceptually:

```ts
interface ProviderRequestOptions<
  TModel = Model<Api>
> {
  signal?: AbortSignal

  telemetryContext?: TelemetryContext

  apiKey?: string
  fetch?: FetchFunction

  env?: ProviderEnv

  onPayload?: (
    payload: unknown,
    model: TModel
  ) =>
    unknown |
    undefined |
    Promise<unknown | undefined>

  onResponse?: (...)

  headers?: ProviderHeaders

  timeoutMs?: number
  maxRetries?: number
  maxRetryDelayMs?: number
}
```

These fields control authentication, transport/runtime execution, callbacks, retries, and cancellation.

They are not model-visible conversation semantics.

**ProviderHeaders**

```ts
type ProviderHeaders =
  Record<string, string | null>
```

General semantics:

```text
string
→ set / override header

null
→ suppress matching provider/API default
```

Provider-specific restrictions may still apply.

**Callback-visible payload replacement boundary**

`onPayload` receives an adapter-selected request-payload representation after that representation has been constructed for callback exposure and before the provider request is sent.

Conceptually:

```text
adapter constructs
callback-visible payload representation
        │
        ▼
onPayload(payload, model)
        │
        ├── returns undefined
        │   └── preserve current representation
        │
        └── returns non-undefined value
            └── replace current representation
        │
        ▼
subsequent adapter / SDK processing
        │
        ▼
provider request
```

The callback contract therefore establishes:

```text
onPayload
→ caller inspection boundary
→ optional replacement boundary
  for the callback-visible payload representation
```

It does not establish:

```text
onPayload output
=
final provider-wire payload
```

After `onPayload`, a concrete adapter or SDK may still perform:

```text
field remapping
provider-specific conversion
serialization
SDK request construction
transport preparation
```

before transmission.

The exact callback-visible representation is adapter-specific.

Therefore:

```text
callback-visible payload
≠ necessarily provider-wire payload
```

`onPayload` is the last caller replacement boundary for the representation exposed to the callback, not a universal final transformation before the wire.

---

#### 3.1.2 StreamOptions

```ts
interface StreamOptions
  extends ProviderRequestOptions<Model<Api>> {
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

These are generic stream controls.

A provider can ignore controls that do not apply to its protocol.

`samplingParams` is intended for OpenAI-compatible adapters supporting arbitrary sampling payload fields.

Other API families may ignore it.

---

### 3.2 API-Specific Invocation

#### 3.2.1 ApiOptionsMap

Known API identifiers map to concrete API-specific option types:

```text
anthropic-messages
→ AnthropicOptions

openai-completions
→ OpenAICompletionsOptions

openai-responses
→ OpenAIResponsesOptions

openai-codex-responses
→ OpenAICodexResponsesOptions

azure-openai-responses
→ AzureOpenAIResponsesOptions

google-generative-ai
→ GoogleOptions

google-vertex
→ GoogleVertexOptions

mistral-conversations
→ MistralOptions

bedrock-converse-stream
→ BedrockOptions

pi-messages
→ PiMessagesOptions
```

Provider-specific option fields belong to their corresponding API modules.

---

#### 3.2.2 ApiStreamOptions

```ts
type ApiStreamOptions<
  TApi extends Api
> =
  TApi extends keyof ApiOptionsMap
    ? ApiOptionsMap[TApi]
    : StreamOptions &
      Record<string, unknown>
```

Thus:

```text
known API
→ concrete API-specific options

custom API
→ StreamOptions + arbitrary extension keys
```

---

#### 3.2.3 Provider.stream()

```ts
stream<T extends TApi>(
  model: Model<T>,
  context: Context,
  options?: ApiStreamOptions<T>
): AssistantMessageEventStream
```

This is the public API-specific Provider invocation form.

---

### 3.3 Simplified Invocation

#### 3.3.1 SimpleStreamOptions

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

This provides a provider-neutral simplified request surface.

---

#### 3.3.2 Provider.streamSimple()

```text
Provider.streamSimple()
│
├── Model
├── Context
└── SimpleStreamOptions
        │
        ▼
AssistantMessageEventStream
```

It exposes generic reasoning/deferred controls rather than every API-specific feature.

---

### 3.4 Shared Simplified Helpers

The helpers in `simple-options.ts` are available to simplified API implementations.

Their existence does not imply every `streamSimple()` implementation applies every helper.

---

#### 3.4.1 buildBaseOptions()

`buildBaseOptions()` converts common simplified request controls into `StreamOptions`.

Conceptually:

```text
Model defaults
+
Context
+
SimpleStreamOptions
        │
        ▼
buildBaseOptions()
        │
        ▼
StreamOptions
```

This helper performs model/request sampling merge and context-aware `maxTokens` normalization while forwarding common execution controls.

API-specific `Provider.stream()` implementations are not required to use it.

---

#### 3.4.2 Sampling Merge and Context-Aware maxTokens

**Pi-level sampling merge**

When either source exists:

```text
effective samplingParams =
{
  ...model.samplingParams,
  ...options.samplingParams
}
```

Request-level `options.samplingParams` overrides `Model.samplingParams` per key.

This derives the effective Pi `samplingParams` object.

**Provider-payload precedence**

For supporting OpenAI-compatible adapters, the effective Pi `samplingParams` object is applied after named request fields during that adapter's payload-construction phase.

```text
named provider request fields
        │
        ▼
effective samplingParams
applied afterward
        │
        ▼
adapter-built
callback-visible payload
```

Within that construction phase:

```text
same key in samplingParams
→ overrides named field
```

This rule is not universal across all API families.

Other API families may ignore `samplingParams`.

**Caller callback boundary**

Where an adapter subsequently invokes `onPayload`:

```text
adapter-built
callback-visible payload
        │
        ▼
onPayload
        │
        ├── undefined
        │   └── preserve representation
        │
        └── non-undefined
            └── replace representation
        │
        ▼
post-callback adapter / SDK processing
        │
        ▼
provider request
```

The complete sampling/payload lifecycle is therefore:

```text
Stage 1 — Pi sampling merge

Model.samplingParams
        ↓ overridden by
options.samplingParams
        ↓
effective Pi samplingParams
```

```text
Stage 2 — supporting adapter construction

named request fields
        ↓ overridden by
effective samplingParams
        ↓
callback-visible payload representation
```

```text
Stage 3 — caller callback boundary

callback-visible payload representation
        ↓ optionally replaced by
onPayload
        ↓
post-callback adapter / SDK processing
        ↓
provider request
```

Consequently:

```text
samplingParams
→ can win over named fields
  during supporting adapter construction
```

but:

```text
samplingParams result
≠ guaranteed final request representation
```

because `onPayload` may subsequently replace the callback-visible payload.

Likewise:

```text
onPayload output
≠ guaranteed final wire representation
```

because adapter/SDK processing may still occur afterward.

**Context-aware maxTokens**

The shared helper derives:

```text
requestedMaxTokens =
options.maxTokens ?? model.maxTokens
```

For:

```text
model.contextWindow > 0
```

it computes:

```text
available =
model.contextWindow
- estimateContextTokens(context).tokens
- 4096
```

then:

```text
contextAllowance =
max(
  1,
  available
)
```

and:

```text
effectiveMaxTokens =
min(
  requestedMaxTokens,
  contextAllowance
)
```

Only the context-derived allowance is floored at `1`.

The requested maximum is not independently raised.

Therefore:

```text
requestedMaxTokens = 0
→ effectiveMaxTokens can be 0
```

and negative requested values can remain negative.

For:

```text
model.contextWindow <= 0
```

the helper returns:

```text
max(
  1,
  requestedMaxTokens
)
```

This context clamp belongs specifically to the shared simplified-option path.

It is not a universal rule for every API-specific `Provider.stream()` implementation.

---

#### 3.4.3 Shared `adjustMaxTokensForThinking()` Helper

This subsection describes:

```text
adjustMaxTokensForThinking()
```

It is **not** a universal reasoning-budget stage for every `streamSimple()` implementation.

Generic default budgets are:

```text
minimal → 1024
low     → 2048
medium  → 8192
high    → 16384
```

Within this helper:

```text
xhigh
max
→ high
```

through `clampReasoning()` before budget lookup.

The initial output ceiling is:

```text
if baseMaxTokens is undefined:

  maxTokens =
  modelMaxTokens

otherwise:

  maxTokens =
  min(
    baseMaxTokens + thinkingBudget,
    modelMaxTokens
  )
```

The helper defines:

```text
MIN_ANSWER_TOKENS = 1024
```

but only adjusts the thinking budget when:

```text
maxTokens <= thinkingBudget
```

Then:

```text
thinkingBudget =
max(
  0,
  maxTokens - 1024
)
```

Therefore:

```text
maxTokens - thinkingBudget >= 1024
```

is not a universal Pi invariant.

Concrete API implementations may map reasoning effort or budgets differently.

---

### 3.5 Shared Tool Constraint Adaptation

`Tool.constrainedSampling` is static data.

Shared helpers interpret it according to concrete adapter capabilities.

This behavior is not a generic middleware automatically applied to every provider.

---

#### 3.5.1 JSON-Schema Constrained Sampling

For:

```text
type = "json_schema"
```

shared resolution behaves as:

```text
provider supports strict mode
→ return true

provider lacks strict support
+ strict = "prefer"
→ return undefined

provider lacks strict support
+ strict = "require"
→ throw
```

Thus:

```text
prefer
→ preference with fallback

require
→ hard capability requirement
```

---

#### 3.5.2 Grammar Constrained Sampling

Supported generic variants are:

```text
openai_lark
openai_regex
```

If the adapter does not support generic OpenAI grammar tools:

```text
→ return undefined
```

If supported, at least one non-empty supported variant must exist.

When both exist:

```text
Lark
```

is selected before regex.

**Parameter-schema requirement**

Native grammar handling requires:

```text
Tool.parameters
└── object
    └── exactly one required property
        ├── property exists
        └── property type = string
```

Otherwise resolution throws.

**Runtime grammar input**

The resulting grammar tool call expects:

```text
arguments[inputProperty]
```

to be a string.

Otherwise input extraction throws.

---

### 3.6 Deferred Continuation and Cancellation

Pi supports deferred response state across three lifecycle stages:

```text
initial request
        │
        ▼
deferred terminal state
        │
        ▼
DeferredHandle
        │
        ├── fetch continuation
        └── cancel continuation
```

These are related contracts but use different invocation and failure surfaces.

---

#### 3.6.1 Initial Deferred Request

`SimpleStreamOptions` includes:

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

This requests asynchronous/deferred processing from a capable provider.

Pi can represent a successful deferred terminal using:

```text
AssistantMessage.stopReason = "deferred"
```

with continuation state represented by:

```text
AssistantMessage.deferred?: DeferredHandle
```

Provider support and concrete deferred behavior remain API-specific.

The static types do not imply every provider supports deferred execution.

---

#### 3.6.2 DeferredFetchOptions

```ts
interface DeferredFetchOptions
  extends ProviderRequestOptions<Model<Api>> {
  wait?: number
}
```

`wait` is declared as the maximum provider long-poll duration in milliseconds.

The source declaration specifies:

```text
wait omitted
→ declared default: 0

wait = 0
→ declared behavior: one status check
```

These are **Source-Declared Producer Contract** facts.

The static TypeScript contract itself guarantees only:

```text
wait?: number
```

This specification does not promote the declared default to generic runtime enforcement unless a concrete implementation is separately observed to enforce it.

---

#### 3.6.3 DeferredCancelOptions

```ts
type DeferredCancelOptions =
  ProviderRequestOptions<Model<Api>>
```

Deferred cancellation therefore uses the common provider request controls but introduces no additional generic cancellation-specific field.

It represents a best-effort cancellation request.

---

#### 3.6.4 Deferred API Surfaces

The static runtime surfaces are:

| Layer | Fetch | Cancel |
|---|---|---|
| `ProviderStreams` | `fetchDeferred?() → AssistantMessageEventStream` | `cancelDeferred?() → Promise<void>` |
| `Provider` | `fetchDeferred?() → AssistantMessageEventStream` | `cancelDeferred?() → Promise<void>` |
| `Models` | `fetchDeferred() → Promise<AssistantMessage>` | `cancelDeferred() → Promise<void>` |

Thus fetch and cancel are intentionally asymmetric:

```text
fetchDeferred
→ assistant-response continuation
→ stream/result semantics
```

while:

```text
cancelDeferred
→ imperative runtime operation
→ Promise<void>
```

At the `Models` layer, request options additionally include `ModelsRequestTransforms`:

```ts
type ModelsDeferredFetchOptions =
  DeferredFetchOptions
  & ModelsRequestTransforms

type ModelsDeferredCancelOptions =
  DeferredCancelOptions
  & ModelsRequestTransforms
```

---

## 4. Shared Historical Replay Normalization

`transformMessages()` is a shared replay-normalization helper.

It is **not** automatically invoked by `Provider`, `ProviderStreams`, or `Models` as a universal middleware phase.

Concrete API adapters may call it while translating historical Pi messages into provider-visible request history.

Conceptually:

```text
Historical Message[]
        │
        ▼
transformMessages()
        │
        ├── input normalization
        ├── cross-model content normalization
        ├── failed-turn filtering
        └── tool sequence repair
        │
        ▼
normalized Message[]
```

An adapter can then perform additional provider-specific conversion.

Therefore:

```text
shared replay normalization
≠ complete provider conversion
≠ mandatory invocation stage
```

---

### 4.1 Helper Boundary

Inputs:

```text
Message[]
target Model
optional tool-call ID normalizer
```

Output:

```text
Message[]
```

The returned messages may differ from persisted Pi history.

---

### 4.2 Same-Model Identity

Historical assistant content is treated as same-model only when:

```text
assistant.provider === target.provider
AND
assistant.api === target.api
AND
assistant.model === target.id
```

Model ID alone is insufficient.

---

### 4.3 Input Normalization

#### 4.3.1 Null Content

For runtime/legacy/untyped values where:

```text
content == null
```

the helper normalizes:

```text
content = []
```

before subsequent processing.

This repairs input that does not satisfy the current static message contract.

---

#### 4.3.2 Unsupported Images

If:

```text
targetModel.input
```

does not contain `"image"`, user images become:

```text
(image omitted: model does not support images)
```

and tool-result images become:

```text
(tool image omitted: model does not support images)
```

Placeholder insertion is based on the immediately preceding emitted text.

An image placeholder is not emitted when the immediately preceding emitted `TextContent.text` already equals the corresponding placeholder string.

Consequently:

```text
image
image
```

produces one placeholder.

The same suppression also occurs if historical user/tool text already exactly equals that placeholder string.

The helper does not record whether preceding placeholder text was synthesized.

---

### 4.4 Assistant Content Replay

#### 4.4.1 ThinkingContent

**Same-model**

| State | Replay |
|---|---|
| `redacted = true` | preserve |
| truthy/non-empty `thinkingSignature` | preserve |
| ordinary non-whitespace thinking | preserve |
| non-redacted + falsy signature + empty/whitespace thinking | drop |

The implementation uses JavaScript truthiness.

Thus:

```text
thinkingSignature = "opaque"
→ signature-preserving branch
```

while:

```text
thinkingSignature = ""
→ does not trigger that branch
```

Same-model identity therefore does not imply unconditional preservation of every `ThinkingContent`.

**Cross-model**

```text
redacted thinking
→ drop

empty/whitespace thinking
→ drop

non-empty non-redacted thinking
→ TextContent
```

Provider-specific reasoning continuity state is not replayed as foreign reasoning state.

---

#### 4.4.2 Text Signatures

Same-model replay preserves the original `TextContent`.

Cross-model replay reconstructs:

```ts
{
  type: "text",
  text: block.text
}
```

which removes `textSignature`.

---

#### 4.4.3 Tool Thought Signatures

Cross-model removal uses JavaScript truthiness:

```text
truthy thoughtSignature
→ remove
```

An explicit:

```text
thoughtSignature = ""
```

does not trigger deletion.

---

#### 4.4.4 Tool-Call ID Normalization

If the optional cross-model normalizer changes:

```text
ToolCall.id
X
→
Y
```

the mapping is stored.

A subsequent:

```text
ToolResultMessage.toolCallId = X
```

is rewritten to:

```text
Y
```

preserving call/result identity.

**Tool namespace**

`transformMessages()` does not generically strip:

```text
ToolCall.namespace
```

during cross-model replay.

When the helper clones a `ToolCall` to remove a truthy `thoughtSignature` or replace its ID, other fields are preserved through object spread.

Therefore:

```text
shared transformMessages()
→ namespace can remain present
```

A later concrete provider conversion may impose additional namespace replay rules.

---

### 4.5 Sequence Processing

The helper performs a second pass over the transformed message sequence.

#### 4.5.1 Failed Assistant Turns

Before processing a new assistant turn, unresolved pending tool calls from the previous retained assistant turn are repaired as needed.

Then, if the current assistant message has:

```text
stopReason = "error"
```

or:

```text
stopReason = "aborted"
```

the assistant message is skipped.

Its ToolCalls are not added to the next pending set.

Therefore:

```text
error/aborted AssistantMessage
→ legal historical Pi data
→ omitted from transformMessages() output
```

ToolCalls appearing only inside that skipped assistant message are not synthetic-repair candidates.

**Existing ToolResult asymmetry**

Skipping a failed assistant message does **not** automatically remove subsequent existing `ToolResultMessage` values.

Tool results are independently passed through the second sequence pass.

Therefore malformed history can produce:

```text
stored:

failed AssistantMessage
└── ToolCall X

ToolResultMessage X

        │
        ▼ transformMessages()

output:

ToolResultMessage X
```

without a retained matching assistant ToolCall.

Thus:

```text
transformMessages()
≠
complete conversation validity repairer
```

It synthesizes missing results for tracked retained calls, but does not remove every pre-existing orphan result.

---

#### 4.5.2 Tool Sequence Repair

For retained assistant turns, ToolCalls are tracked until matching ToolResult messages appear.

If unresolved calls remain before:

```text
another assistant turn
a user turn
end of sequence
```

synthetic error results are inserted.

```ts
{
  role: "toolResult",

  toolCallId: toolCall.id,
  toolName: toolCall.name,

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

This is shared replay repair behavior rather than a static stored-history requirement.

---

## 5. Response Streaming Protocol

Pi represents incremental assistant production through:

```text
AssistantMessageEventStream
```

whose events describe construction of `AssistantMessage`.

Declared lifecycle and observed runtime lifecycle must be distinguished.

---

### 5.1 Event Model

#### 5.1.1 Event Families

```text
AssistantMessageEvent
│
├── Message Start
│   └── start
│
├── Text
│   ├── text_start
│   ├── text_delta
│   └── text_end
│
├── Thinking
│   ├── thinking_start
│   ├── thinking_delta
│   └── thinking_end
│
├── ToolCall
│   ├── toolcall_start
│   ├── toolcall_delta
│   └── toolcall_end
│
└── Terminal
    ├── done
    └── error
```

---

#### 5.1.2 Static Event Union

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

---

### 5.2 Common Event State

#### 5.2.1 `partial`

Most non-terminal events expose:

```ts
partial: AssistantMessage
```

Current built-in adapters commonly mutate and reuse one accumulated `AssistantMessage`.

Therefore:

```text
event.partial
→ may reference reused mutable accumulated state
```

and:

```text
event.partial
→ is not guaranteed to be an immutable
  event-time snapshot
```

`EventStream` does not clone nested event objects.

A consumer requiring historical snapshots must copy required state at observation time.

Distinction:

```text
event.delta
→ event-local incremental information

event.partial
→ accumulated assistant state reference
```

---

#### 5.2.2 `contentIndex`

Content lifecycle events carry:

```ts
contentIndex: number
```

The intended semantic relationship is:

```text
event.contentIndex
↔
partial.content[contentIndex]
```

The primitive number type cannot guarantee that correspondence.

`contentIndex` identifies the local content lifecycle to which the event belongs.

---

### 5.3 Stream Lifecycle

#### 5.3.1 Source-Declared Baseline

The source declaration describes:

```text
start
→ partial/content updates
→ done | error
```

The declared ordering rule is:

```text
start
precedes
partial/content updates
```

Semantic termination uses:

```text
done | error
```

---

#### 5.3.2 Observed Pre-Start Failure

Current executable paths can emit:

```text
error
```

without first emitting:

```text
start
```

when request/setup work fails before response streaming begins.

Thus effective runtime includes:

```text
Assistant Stream
│
├── Pre-start Failure
│   └── error
│
└── Started Response
    ├── start
    ├── content events*
    └── done | error
```

Pre-start error is observed runtime behavior rather than a static union invariant.

---

#### 5.3.3 Started Response

Once `start` occurs:

```text
start
→ zero or more content events
→ done | error
```

Content events can belong to several independently active local lifecycles.

---

### 5.4 Content Lifecycles

#### 5.4.1 Text

Normal local completion:

```text
text_start
→ text_delta*
→ text_end
```

Observed failure interruption:

```text
text_start
→ text_delta*
→ error
```

Therefore:

```text
TextContent present in partial
≠ completed text lifecycle
```

---

#### 5.4.2 Thinking

Normal local completion:

```text
thinking_start
→ thinking_delta*
→ thinking_end
```

Observed failure interruption:

```text
thinking_start
→ thinking_delta*
→ error
```

A partial `ThinkingContent` therefore does not prove completion.

---

#### 5.4.3 ToolCall

Normal local completion:

```text
toolcall_start
→ toolcall_delta*
→ toolcall_end
```

Observed failure interruption:

```text
toolcall_start
→ toolcall_delta*
→ error
```

Therefore:

```text
ToolCall present in partial
≠ completed streamed ToolCall
```

**Serialized incremental input**

During streaming, two representations can coexist:

```text
toolcall_delta.delta
→ serialized incremental tool-input delta
  exposed by the Pi producer

partial.content[index].arguments
→ current best-effort parsed representation
```

`toolcall_delta.delta` is a Pi stream value, not a guarantee of raw provider-wire input.

It may:

```text
directly reflect provider incremental input
```

or:

```text
be synthesized / normalized by the Pi adapter
```

For grammar/custom tool streaming, Pi can synthesize JSON fragments around provider input before emitting `toolcall_delta.delta`.

Therefore:

```text
provider wire input
        │
        ▼
Pi adapter
        │
        ▼
toolcall_delta.delta
```

and:

```text
toolcall_delta.delta
≠ necessarily raw provider delta
```

**Best-effort JSON parsing**

Current shared parsing uses:

```text
parseStreamingJson<T>()
```

which attempts:

```text
strict JSON parse
repair + strict parse
partial JSON parse
partial parse after repair
fallback {}
```

Empty input also returns `{}`.

**Static / runtime shape gap**

Static `ToolCall` requires:

```ts
arguments: Record<string, any>
```

but `parseStreamingJson<T>()` does not runtime-check object shape.

Valid complete JSON values such as:

```text
123
"hello"
[]
null
```

can therefore be returned despite the static generic expectation.

Thus:

```text
Static ToolCall contract
arguments must be object
        │
        ▼
parseStreamingJson()
does not enforce object shape
        │
        ▼
runtime state can violate
the static contract
```

This is a current implementation gap.

**`toolcall_end`**

`toolcall_end` means:

```text
the local ToolCall stream lifecycle ended
```

It does not imply:

```text
runtime object-shape validation

strict original JSON validity

Tool.parameters validation

executability
```

Therefore:

```text
toolcall_end
≠ tool validation
```

**Tool validation boundary**

Shared validation helpers include:

```text
validateToolCall()
validateToolArguments()
```

They:

```text
locate Tool
→ clone arguments
→ convert/coerce
→ validate against TypeBox schema
→ return validated arguments or throw
```

Therefore stream block completion and tool-schema validation are separate operations.

---

### 5.5 Cross-Content Interleaving

Lifecycle ordering is local to `contentIndex`.

Different content lifecycles may interleave.

Example:

```text
start

text_start(0)
text_delta(0)

toolcall_start(1)
toolcall_delta(1)

text_delta(0)

toolcall_start(2)
toolcall_delta(2)

toolcall_delta(1)

text_end(0)
toolcall_end(1)
toolcall_end(2)

done
```

Consumers must track open lifecycle state independently for each content index.

They must not assume:

```text
one block must end
before another starts
```

A global `error` can interrupt multiple active blocks at once.

---

### 5.6 Terminal Events

#### 5.6.1 Done

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

`done` is the successful semantic terminal class.

Current built-in normal-completion paths close generated active blocks before emitting `done`.

The generic stream container does not independently validate this property.

---

#### 5.6.2 Error

```ts
{
  type: "error"

  reason:
    | "error"
    | "aborted"

  error: AssistantMessage
}
```

`error` is the failure/aborted-terminal event class.

Observed runtime supports:

```text
error before start
```

and:

```text
start
→ content events
→ error
```

with one or more content blocks potentially left without corresponding `*_end`.

The failed assistant state can retain partial content and accounting state depending on where failure occurred.

---

### 5.7 Result Semantics

For semantic terminal events:

```text
done
→ event.message

error
→ event.error
```

Thus:

```ts
await stream.result()
```

is not itself a success predicate.

An event consumer can classify with:

```text
event.type
```

A result-only consumer must inspect:

```text
AssistantMessage.stopReason
```

Expected successful final reasons are:

```text
stop
length
toolUse
deferred
```

Failure/aborted final reasons are:

```text
error
aborted
```

The generic container does not check:

```text
done.reason === message.stopReason
```

or:

```text
error.reason === error.stopReason
```

That correspondence belongs to a conforming producer.

---

### 5.8 EventStream Container Boundary

`AssistantMessageEventStream` extends a generic:

```text
EventStream<
  AssistantMessageEvent,
  AssistantMessage
>
```

The generic container has broader capabilities than the assistant semantic protocol.

#### 5.8.1 `push()`

For `AssistantMessageEventStream`, terminal detection is:

```text
event.type === "done"
||
event.type === "error"
```

On terminal push:

```text
done = true

final result resolves

terminal event remains delivered/queued

later push() calls are ignored
```

The actual generic enforcement begins with:

```text
if (this.done) return
```

Therefore a push attempted after a semantic terminal is silently ignored.

The container does not validate how the stream reached that terminal.

---

#### 5.8.2 `result()`

```ts
result(): Promise<AssistantMessage>
```

returns the final resolved result.

It can be resolved by semantic terminal handling or by generic `end(result)` behavior.

---

#### 5.8.3 `end(result?)`

`EventStream.end()` is a generic container operation and emits no `AssistantMessageEvent`.

**`end(result)`**

```text
mark done
close waiting iterators
resolve result if not already settled
emit no event
```

**`end()`**

```text
mark done
close waiting iterators
emit no event
do not resolve an unresolved result promise
```

Therefore:

```text
end()
before result resolution
→ async iteration ends
→ result() can remain pending
```

This distinction matters when generic stream forwarding awaits both iterator completion and `source.result()`.

---

#### 5.8.4 Non-Enforced Properties

Generic `EventStream` does not validate:

```text
start exists
start exists exactly once

start precedes content updates
start precedes error

delta has matching start
end has matching start

every started block ends

contentIndex points to expected content

content lifecycles are serialized

terminal reason matches stopReason

final result equals previous partial state
```

Therefore:

```text
Assistant semantic protocol
≠
generic EventStream validator
```

---

## 6. Runtime Boundaries

Request invocation and response/result flow pass through several implementation layers.

**Request / invocation direction**

```text
Models
  │
  ▼
Provider
  │
  ▼
ProviderStreams
  │
  ▼
API Implementation
```

**Response event / result direction**

```text
API Implementation
  │
  ▼
ProviderStreams
  │
  ▼
Provider
  │
  ▼
Models / caller
```

When describing inner-to-outer wrapping or abstraction ownership, the stack can also be summarized as:

```text
API Implementation
→ ProviderStreams
→ Provider
→ Models
```

Arrow direction must therefore be interpreted according to the information flow being described.

---

### 6.1 Runtime Stack

```text
API Implementation
│
│ concrete provider conversion
│
▼
ProviderStreams
│
│ uniform implementation shape
│ optional lazy wrapper
│
▼
Provider
│
│ provider identity
│ auth metadata
│ model catalog
│ stream dispatch
│
▼
Models
│
│ provider lookup
│ auth resolution
│ request transformation
│ outer stream convenience
```

No layer should be skipped when reasoning about failure normalization.

---

### 6.2 Direct API Implementation Module

Concrete API modules export functions such as:

```text
stream()
streamSimple()
```

and capable modules may additionally expose deferred operations.

#### 6.2.1 StreamFunction Contract

```ts
type StreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions
> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions
) => AssistantMessageEventStream
```

Its source-declared contract states:

```text
must return AssistantMessageEventStream

once invoked,
request/model/runtime failures
should be encoded in the returned stream

error termination must contain
stopReason = "error" | "aborted"
and errorMessage
```

---

#### 6.2.2 Direct-Module Preflight Gap

Some direct API-module `streamSimple()` implementations perform synchronous preflight before returning a stream.

Examples include API-key/auth assertions in current OpenAI- and Anthropic-family direct modules.

Thus:

```text
direct API-module streamSimple()
        │
        ├── synchronous preflight
        │       └── may throw
        │
        └── return stream
```

This is a current implementation mismatch relative to the declared `StreamFunction` contract.

The mismatch belongs to the direct API implementation layer.

---

### 6.3 ProviderStreams

#### 6.3.1 Uniform Dispatch Role

```ts
interface ProviderStreams {
  stream(
    model: Model<Api>,
    context: Context,
    options?: StreamOptions
  ): AssistantMessageEventStream

  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream

  fetchDeferred?(
    model: Model<Api>,
    handle: DeferredHandle,
    options?: DeferredFetchOptions
  ): AssistantMessageEventStream

  cancelDeferred?(
    model: Model<Api>,
    handle: DeferredHandle,
    options?: DeferredCancelOptions
  ): Promise<void>
}
```

`ProviderStreams` is the uniform API implementation-module dispatch shape.

It is intentionally less API-specific than:

```text
Provider.stream()
→ ApiStreamOptions<TApi>
```

---

#### 6.3.2 Direct / Custom Implementations

A `ProviderStreams` implementation can be supplied directly.

If it synchronously throws, the Provider layer does not universally guarantee conversion of that throw into a stream error.

---

#### 6.3.3 `lazyApi()` / `lazyStream()`

Built-in provider wiring commonly uses:

```text
*.lazy.ts
→ lazyApi()
→ lazyStream()
→ direct API module
```

for ordinary stream methods.

Deferred methods are capability-gated separately; see §6.7.

`lazyApi()` returns `ProviderStreams` whose ordinary stream methods immediately return an outer stream while module loading and direct invocation occur asynchronously.

**Promise-chain structure**

```text
create outer AssistantMessageEventStream
        │
        ▼
setup()
        │
        ├── rejection ──────────────┐
        │                           │
        ▼                           │
forwardStream(outer, inner)         │
        │                           │
        └── rejection ──────────────┤
                                    ▼
                              generic catch
```

The actual form is:

```text
setup()
.then(inner => forwardStream(...))
.catch(...)
```

Therefore the generic catch covers both:

```text
setup rejection
```

and:

```text
forwarding-chain rejection
```

**Forwarding**

`forwardStream()`:

```text
for await (event of inner)
→ outer.push(event)
```

then:

```text
outer.end(
  inner has result()
    ? await inner.result()
    : undefined
)
```

For a conforming source whose semantic terminal event was forwarded, that terminal event has already resolved the outer result.

The later `end(result)` mainly closes the outer container.

**Pre-terminal lazy rejection**

If setup or forwarding rejects before the outer stream has received a semantic terminal event:

```text
setup / forwarding rejection
        │
        ▼
lazy catch
        │
        ▼
create error AssistantMessage
        │
        ▼
outer.push(error)
        │
        ▼
visible ordinary error terminal
```

The generic lazy error uses:

```text
stopReason = "error"

error.reason = "error"
```

and emits no `start`.

**Post-terminal forwarding rejection**

If the outer stream already received `done` or `error`:

```text
outer.done = true
```

and forwarding later rejects:

```text
forwardStream rejects
        │
        ▼
lazy catch executes
        │
        ▼
outer.push(error)
        │
        ▼
ignored by EventStream.push()
because outer is already done
```

Therefore:

```text
forwarding-chain rejection
→ catch executes
```

does not imply:

```text
→ second visible error event
```

after a semantic terminal.

**Malformed inner completion / bare end**

`forwardStream()` does not infer semantic success from iterator completion.

For a source exposing `result()`:

```text
for-await completes
        │
        ▼
await source.result()
        │
        ▼
target.end(result)
```

If an inner `AssistantMessageEventStream` calls:

```text
end()
```

without first producing a semantic terminal event or an explicit result:

```text
async iteration
→ ends

result()
→ remains unresolved
```

and consequently:

```text
forwardStream()
→ may remain pending
```

while awaiting the source result.

Thus:

```text
iterator EOF / bare end
≠ success
≠ error
```

`lazyStream()` does not repair a malformed lifecycle by guessing a terminal state.

---

### 6.4 Provider / `createProvider()`

`Provider` is the concrete runtime unit owning:

```text
provider identity
base metadata
auth methods
model listing
stream behavior
```

Its public chat methods include:

```text
Provider.stream()
Provider.streamSimple()

Provider.fetchDeferred?()
Provider.cancelDeferred?()
```

#### 6.4.1 Dispatch

A provider can be configured with:

```text
one ProviderStreams
```

or:

```text
Api → ProviderStreams map
```

`createProvider()` selects the implementation matching the model API.

For ordinary stream dispatch, if no implementation exists, it constructs a lazy error stream.

If an implementation exists:

```text
return run(streams)
```

is used directly.

There is no generic catch around that invocation.

Consequently:

```text
custom/unwrapped ProviderStreams
sync throw
→ may escape Provider.stream*()
```

Deferred dispatch has additional behavior described in §6.7.

---

#### 6.4.2 Built-In Lazy Paths

Many built-in provider factories supply ordinary stream implementations through `lazyApi()`.

For those ordinary stream paths:

```text
direct module synchronous throw
→ lazy Promise rejection
→ error stream
```

before the direct-module failure escapes the lazy `ProviderStreams`.

Direct-module synchronous behavior therefore must not be generalized to every built-in public `Provider.streamSimple()` invocation.

This does not imply that current built-in lazy wrappers enable deferred capabilities.

---

### 6.5 Models

`Models` is a higher-level runtime collection responsible for:

```text
provider lookup
auth resolution
credentials
model lookup
request transformation
stream convenience
deferred continuation/cancellation convenience
```

Providers own stream behavior while Models resolves auth and delegates to the Provider owning the model.

#### 6.5.1 Models Request Transforms

```ts
interface ModelsRequestTransforms {
  transformHeaders?: (
    headers: ProviderHeaders
  ) =>
    ProviderHeaders |
    Promise<ProviderHeaders>
}
```

with:

```ts
type ModelsApiStreamOptions<TApi extends Api> =
  ApiStreamOptions<TApi>
  & ModelsRequestTransforms

type ModelsSimpleStreamOptions =
  SimpleStreamOptions
  & ModelsRequestTransforms

type ModelsDeferredFetchOptions =
  DeferredFetchOptions
  & ModelsRequestTransforms

type ModelsDeferredCancelOptions =
  DeferredCancelOptions
  & ModelsRequestTransforms
```

These belong to the Models runtime wrapper rather than the core data contracts.

---

#### 6.5.2 Auth / Header Preparation

Models request preparation can:

```text
resolve provider auth

apply explicit request apiKey override

merge auth/request headers

run transformHeaders last

merge environment overrides

derive request-specific baseUrl

remove Models-only transform
before Provider invocation
```

These are runtime operations.

---

#### 6.5.3 Outer `lazyStream()`

Both:

```text
Models.stream()
Models.streamSimple()
```

return an outer `lazyStream()`.

Within its async chain they perform:

```text
provider lookup
→ applyAuth()
→ Provider invocation
```

Therefore synchronous Provider invocation failure inside this chain becomes a rejected lazy chain and is normalized to an error stream.

`Models.fetchDeferred()` also uses an outer `lazyStream(...).result()` boundary; see §6.7.1.

`Models.cancelDeferred()` does not; see §6.7.2.

---

### 6.6 AbortSignal Cancellation Classification

This section describes preservation and loss of **request/operation cancellation provenance carried by `AbortSignal`**.

It does not define a universal mapping from provider-native terminal states named `"cancelled"` to Pi `"aborted"`.

#### 6.6.1 Declared Aborted Representation

Pi's static terminal vocabulary provides:

```text
AssistantMessage.stopReason = "aborted"
```

and:

```text
AssistantMessageEvent {
  type: "error"
  reason: "aborted"
}
```

The static type contract proves that `"aborted"` is a legal normalized terminal representation.

It does **not** by itself prove which runtime condition must produce it.

Producer paths that preserve caller/request operation cancellation provenance commonly use `"aborted"` for that condition.

Conceptually:

```text
request / operation AbortSignal cancellation
        │
        ▼
producer preserves cancellation provenance
        │
        ▼
stopReason = "aborted"
error.reason = "aborted"
```

However:

```text
"aborted"
≠ universal mapping
  for every provider-native state
  whose provider terminology is "cancelled"
```

Provider-native states are interpreted by individual API adapters.

---

#### 6.6.2 AbortSignal Propagation

Models/auth runtime propagates `AbortSignal`.

Shared mechanisms include behavior represented by:

```text
operationSignal()
raceWithAbortSignal()
signal.throwIfAborted()
```

These allow caller/request cancellation to reject in-progress auth or setup operations.

This preserves cancellation provenance only until some later layer may normalize the rejection differently.

---

#### 6.6.3 Adapter-Level AbortSignal Preservation

Some direct API adapters inspect:

```text
options.signal?.aborted
```

when handling request or stream failures.

Those observed paths can preserve caller/request cancellation provenance as:

```text
stopReason = "aborted"

error.reason = "aborted"
```

This is path-specific executable behavior.

It must not be generalized into a rule that every provider-native cancellation status maps to `"aborted"`.

---

#### 6.6.4 Provider-Native Cancellation Is API-Specific

Provider-native terminal states are separate from caller-side `AbortSignal` state.

For example, the pinned OpenAI Responses shared implementation maps provider-native:

```text
failed
cancelled
```

to:

```text
stopReason = "error"
```

Therefore:

```text
provider-native "cancelled"
        ≠
Pi "aborted" by definition
```

Provider terminology alone does not determine canonical Pi classification.

Consumers must use the normalized Pi result rather than infer semantics from a provider-native string.

---

#### 6.6.5 AbortSignal Provenance Loss at the Lazy Boundary

The generic `lazyStream()` catch does not inspect:

```text
signal.aborted
AbortError
signal.reason
```

Caught Promise-chain rejection is normalized as:

```text
stopReason = "error"

error.reason = "error"
```

Therefore an operation rejected because of caller/request `AbortSignal` cancellation can lose its cancellation provenance when the rejection crosses the generic lazy boundary.

Conceptually:

```text
AbortSignal cancellation
        │
        ▼
auth / setup / forwarding operation rejects
        │
        ▼
generic lazyStream catch
        │
        ├── cancellation provenance not inspected
        │
        ▼
stopReason = "error"
error.reason = "error"
```

The current implementation gap is:

> **AbortSignal cancellation provenance can be lost at the generic lazy boundary.**

This is distinct from API-specific mapping of provider-native `"cancelled"` states.

---

#### 6.6.6 Models Pre-Start AbortSignal Cancellation

A concrete Models path is:

```text
Models.stream*
        │
        ▼
outer lazy chain
        │
        ▼
auth/setup observes AbortSignal cancellation
        │
        ▼
Promise rejects
        │
        ▼
lazyStream generic catch
        │
        ▼
AbortSignal provenance is lost
        │
        ▼
stopReason = "error"
error.reason = "error"
```

Therefore Models does not guarantee preservation of:

```text
"aborted"
```

for every pre-start rejection caused by caller/request `AbortSignal` cancellation.

This is specifically an AbortSignal provenance-loss gap.

It is not a universal rule governing provider-native `"cancelled"` terminal states.

---

### 6.7 Deferred Runtime Failure Surfaces

Deferred continuation and deferred cancellation use different runtime failure models.

#### 6.7.1 Deferred Fetch

At the implementation boundary:

```text
ProviderStreams.fetchDeferred?()
→ AssistantMessageEventStream
```

and:

```text
Provider.fetchDeferred?()
→ AssistantMessageEventStream
```

**`lazyApi()` capability-gated behavior**

`lazyApi()` exposes deferred fetch only when created with:

```text
capabilities.fetchDeferred = true
```

When enabled:

```text
lazyApi(..., {
  fetchDeferred: true
})
        │
        ▼
ProviderStreams.fetchDeferred()
        │
        ▼
lazyStream(...)
        │
        ▼
loaded implementation.fetchDeferred()
```

Therefore:

```text
capability-enabled lazyApi fetch
→ stream-style lazy setup normalization
```

This is a conditional runtime mechanism.

It does **not** imply that the pinned built-in lazy wrappers currently enable deferred fetch.

**`createProvider()` behavior**

When the configured `ProviderStreams` set exposes at least one `fetchDeferred` implementation, `createProvider()` exposes:

```text
Provider.fetchDeferred()
```

using a `lazyStream()` around API dispatch.

Conceptually:

```text
Provider.fetchDeferred()
        │
        ▼
lazyStream()
        │
        ▼
select ProviderStreams by model.api
        │
        ▼
implementation.fetchDeferred()
```

Thus a `createProvider()`-generated deferred fetch has a stream-style dispatch/setup boundary.

This statement concerns `createProvider()` behavior.

It is not a universal guarantee for arbitrary hand-written `Provider` implementations beyond their declared return type.

**Models deferred fetch**

`Models.fetchDeferred()` is defined as:

```text
Models.fetchDeferred(...)
→ Promise<AssistantMessage>
```

Its implementation uses:

```text
lazyStream(
  model,
  async () => {
    provider lookup
    provider capability check
    applyAuth()
    provider.fetchDeferred(...)
  }
).result()
```

Therefore:

```text
Models.fetchDeferred
        │
        ▼
outer lazyStream
        │
        ├── provider lookup
        ├── capability check
        ├── auth preparation
        └── Provider.fetchDeferred
        │
        ▼
AssistantMessageEventStream
        │
        ▼
result()
        │
        ▼
Promise<AssistantMessage>
```

An ordinary failure normalized by the outer lazy stream can produce:

```text
fulfilled Promise<AssistantMessage>
        │
        └── stopReason = "error"
```

rather than rejecting the `Models.fetchDeferred()` Promise.

A caller must inspect the returned `AssistantMessage.stopReason`.

This path inherits the malformed-stream caveat from §6.3.3:

```text
inner stream without semantic terminal/result
→ result() may remain pending
```

---

#### 6.7.2 Deferred Cancellation

Deferred cancellation does not use an assistant event stream.

The runtime surfaces are:

```text
ProviderStreams.cancelDeferred?()
→ Promise<void>

Provider.cancelDeferred?()
→ Promise<void>

Models.cancelDeferred()
→ Promise<void>
```

**`lazyApi()` capability-gated behavior**

`lazyApi()` exposes cancellation only when created with:

```text
capabilities.cancelDeferred = true
```

When enabled:

```text
lazyApi(..., {
  cancelDeferred: true
})
        │
        ▼
load implementation
        │
        ▼
await implementation.cancelDeferred(...)
```

This path does not use `lazyStream()`.

It therefore exposes ordinary Promise failure semantics.

This conditional mechanism does not imply that the pinned built-in lazy wrappers currently enable deferred cancellation.

**`createProvider()` behavior**

When configured `ProviderStreams` expose cancellation capability:

```text
Provider.cancelDeferred()
        │
        ▼
select ProviderStreams
        │
        ▼
await implementation.cancelDeferred(...)
```

There is no assistant-stream normalization boundary.

**Models deferred cancellation**

`Models.cancelDeferred()` performs:

```text
provider lookup
        │
        ▼
provider capability check
        │
        ▼
applyAuth()
        │
        ▼
await Provider.cancelDeferred()
```

without an outer `lazyStream()`.

Consequently ordinary failures such as:

```text
provider lookup failure
provider capability failure
auth failure
implementation loading failure
provider cancellation failure
AbortSignal-related Promise rejection
```

can surface as:

```text
Promise rejection
```

rather than:

```text
AssistantMessage {
  stopReason: "error" | "aborted"
}
```

Thus:

```text
Models.fetchDeferred failure surface
≠
Models.cancelDeferred failure surface
```

and assistant terminal classification does not govern every failure of `cancelDeferred()`.

---

## 7. Contract Index

This section is navigation only.

Authoritative semantics remain in §§2–6.

The `Authority` column uses only the contract-level vocabulary defined in §1.4.

| Contract / Behavior | Authority | Authoritative Section |
|---|---|---|
| `Api` / `ProviderId` openness | Static Type Contract | §2.1 |
| `Model` structure | Static Type Contract | §2.2 |
| thinking-level helper semantics | Shared Helper / Normalization Behavior | §2.2.3 |
| cost-tier selection | Shared Helper / Normalization Behavior | §2.2.5 |
| `Usage` subset semantics | Static Type Contract + Semantic Relationship | §2.3.1 |
| `StopReason` vocabulary | Static Type Contract | §2.3.2 |
| `JsonValue` | Static Type Contract | §2.3.3 |
| `DeferredHandle` | Static Type Contract | §2.3.4 |
| `Context` hierarchy | Static Type Contract | §2.4 |
| Message/content legality | Static Type Contract | §2.4.3 |
| ToolCall ↔ ToolResult identity | Semantic Relationship | §2.4.5 |
| `onPayload` callback shape | Static Type Contract | §3.1.1 |
| `onPayload` `undefined` / replacement semantics | Source-Declared Producer Contract + Observed Runtime Behavior | §3.1.1 |
| concrete `onPayload` ordering / post-callback processing | Observed Runtime Behavior | §3.1.1 / §3.4.2 |
| `samplingParams` field shape | Static Type Contract | §3.1.2 |
| API-specific invocation types | Static Type Contract | §3.2 |
| simplified invocation types | Static Type Contract | §3.3 |
| Model/request `samplingParams` merge | Shared Helper / Normalization Behavior | §3.4.2 |
| `samplingParams` applied after named fields by supporting OpenAI-compatible adapters | Source-Declared Producer Contract + Observed Runtime Behavior | §3.1.2 / §3.4.2 |
| context-aware `maxTokens` helper | Shared Helper / Normalization Behavior | §3.4.2 |
| thinking-budget helper | Shared Helper / Normalization Behavior | §3.4.3 |
| constrained-sampling resolution | Shared Helper / Normalization Behavior | §3.5 |
| `DeferredFetchOptions` shape | Static Type Contract | §3.6.2 |
| `wait` default `0` / one-check semantics | Source-Declared Producer Contract | §3.6.2 |
| `DeferredCancelOptions` shape | Static Type Contract | §3.6.3 |
| deferred fetch/cancel API return surfaces | Static Type Contract | §3.6.4 |
| historical replay normalization | Shared Helper / Normalization Behavior | §4 |
| unsupported-image replacement | Shared Helper / Normalization Behavior | §4.3.2 |
| failed-turn filtering | Shared Helper / Normalization Behavior | §4.5.1 |
| existing orphan ToolResult behavior | Shared Helper / Normalization Behavior | §4.5.1 |
| synthetic ToolResult repair | Shared Helper / Normalization Behavior | §4.5.2 |
| cross-model `ToolCall.namespace` preservation by `transformMessages()` | Shared Helper / Normalization Behavior | §4.4.4 |
| `AssistantMessageEvent` union | Static Type Contract | §5.1 |
| mutable/reused `partial` possibility | Observed Runtime Behavior | §5.2.1 |
| `contentIndex` relationship | Semantic Relationship | §5.2.2 |
| source-declared stream ordering | Source-Declared Producer Contract | §5.3.1 |
| pre-start error | Observed Runtime Behavior | §5.3.2 |
| failure-interrupted content lifecycle | Observed Runtime Behavior | §5.4 |
| `toolcall_delta.delta` producer behavior | Observed Runtime Behavior | §5.4.3 |
| ToolCall parser object-shape mismatch | Static Type Contract + Observed Runtime Behavior | §5.4.3 |
| tool validation behavior | Shared Helper / Normalization Behavior | §5.4.3 |
| cross-content interleaving | Observed Runtime Behavior | §5.5 |
| terminal event partition | Static Type Contract | §5.6 |
| `EventStream` result/end behavior | Runtime Enforcement | §5.7–§5.8 |
| post-terminal push suppression | Runtime Enforcement | §5.8.1 |
| bare `end()` unresolved-result behavior | Runtime Enforcement | §5.8.3 |
| `StreamFunction` declared failure behavior | Source-Declared Producer Contract | §6.2.1 |
| direct-module synchronous-throw mismatch | Source-Declared Producer Contract + Observed Runtime Behavior | §6.2.2 |
| lazy pre-terminal rejection normalization | Observed Runtime Behavior + Runtime Enforcement | §6.3.3 |
| post-terminal lazy error suppression interaction | Runtime Enforcement + Observed Runtime Behavior | §5.8.1 / §6.3.3 |
| bare-end forwarding pending interaction | Runtime Enforcement + Observed Runtime Behavior | §5.8.3 / §6.3.3 |
| `createProvider()` dispatch behavior | Observed Runtime Behavior | §6.4 |
| Models auth/wrapper behavior | Observed Runtime Behavior | §6.5 |
| `"aborted"` terminal vocabulary | Static Type Contract | §6.6.1 |
| AbortSignal-preserving adapter classification | Observed Runtime Behavior | §6.6.3 |
| provider-native `"cancelled"` mapping | Observed Runtime Behavior | §6.6.4 |
| lazy AbortSignal provenance-loss gap | Observed Runtime Behavior | §6.6.5–§6.6.6 |
| capability-enabled `lazyApi.fetchDeferred` wrapping | Observed Runtime Behavior | §6.7.1 |
| capability-enabled `lazyApi.cancelDeferred` behavior | Observed Runtime Behavior | §6.7.2 |
| `createProvider()` deferred-fetch dispatch | Observed Runtime Behavior | §6.7.1 |
| `createProvider()` deferred-cancel dispatch | Observed Runtime Behavior | §6.7.2 |
| Models deferred-fetch normalization | Observed Runtime Behavior | §6.7.1 |
| Models deferred-cancel Promise failure surface | Observed Runtime Behavior | §6.7.2 |

No additional authority vocabulary is introduced by this index.

---

## 8. Source Basis and Freeze Provenance

This protocol version is pinned to:

```text
Upstream Repository:
earendil-works/pi

Upstream Commit / Tag:
914cf1472e715297caa30db4b9535d534a9eb718 / v0.84.2

Vendored LuckyToken Snapshot:
fd7601d78aaed3fb0aca0ee9479faf5bcf2c5575

Package:
@earendil-works/pi-ai 0.84.2

Reference Date:
2026-08-14
```

**Package identity source:**

```text
pi-agent/packages/ai/package.json
```

The pinned `package.json` identifies:

```text
name:
@earendil-works/pi-ai

version:
0.84.2
```

The pinned upstream commit/tag defines the Pi source meaning of this protocol version; the vendored LuckyToken snapshot identifies the local evidence copy used by this repository.

Future source changes do not retroactively modify this extraction.

---

### 8.1 Core Static Contracts

```text
pi-agent/packages/ai/src/types.ts
```

provides:

```text
chat identity types
Model
Context
Message
content types
Tool

Usage
StopReason
JsonValue
DeferredHandle

ProviderRequestOptions
onPayload callback shape

StreamOptions
ApiStreamOptions
SimpleStreamOptions

DeferredFetchOptions
DeferredCancelOptions

ProviderStreams
ProviderStreams.fetchDeferred
ProviderStreams.cancelDeferred

StreamFunction

AssistantMessageEvent
```

It also establishes the existence of the separate image-generation contract family that is explicitly out of scope for this document.

---

### 8.2 Diagnostics

```text
pi-agent/packages/ai/src/utils/diagnostics.ts
```

provides:

```text
DiagnosticErrorInfo
AssistantMessageDiagnostic
diagnostic extraction/building helpers
```

---

### 8.3 Model and Runtime Ownership

```text
pi-agent/packages/ai/src/models.ts
```

provides:

```text
Provider
Models

createProvider()

Models request transforms

ModelsDeferredFetchOptions
ModelsDeferredCancelOptions

Provider deferred surfaces

Models.fetchDeferred()
Models.cancelDeferred()

createProvider deferred dispatch

cost calculation
thinking-level helpers

auth application flow
outer lazyStream use

deferred fetch/cancel
failure-surface asymmetry
```

---

### 8.4 Shared Simplified Helpers

```text
pi-agent/packages/ai/src/api/simple-options.ts
```

provides:

```text
clampMaxTokensToContext()
buildBaseOptions()

sampling merge
context-aware maxTokens normalization

clampReasoning()
adjustMaxTokensForThinking()
```

The presence of these helpers does not imply every simplified API implementation invokes every helper.

---

### 8.5 Shared Historical Replay Normalization

```text
pi-agent/packages/ai/src/api/transform-messages.ts
```

provides:

```text
legacy null-content normalization
unsupported-image downgrade

same-model detection
thinking replay
signature replay

tool thought-signature handling
tool-call ID normalization
ToolCall field preservation behavior

failed-turn filtering

synthetic tool-result insertion
existing ToolResult pass-through behavior
```

`transformMessages()` is a shared helper, not a generic mandatory Provider/Models middleware stage.

---

### 8.6 EventStream Runtime

```text
pi-agent/packages/ai/src/utils/event-stream.ts
```

provides:

```text
EventStream

push()
post-terminal push suppression

result()

end(result?)
bare end() without result

AssistantMessageEventStream

terminal predicate
terminal result extraction
```

This file is the authoritative owner of:

```text
if (done) return
```

and therefore the primitive rule that post-terminal pushes are ignored.

It is also the authoritative owner of:

```text
end()
without result
→ does not resolve an unresolved result()
```

These mechanics combine with `lazy.ts` behavior to produce the higher-level interactions described in §6.3.3.

---

### 8.7 Streaming Tool Parsing and Validation

```text
pi-agent/packages/ai/src/utils/json-parse.ts
pi-agent/packages/ai/src/utils/validation.ts
```

provide:

```text
best-effort streaming JSON parsing

static ToolCall/runtime parser shape gap

tool argument conversion
tool schema validation
```

---

### 8.8 Shared Tool Constraint Adaptation

```text
pi-agent/packages/ai/src/api/constrained-sampling.ts
```

provides:

```text
JSON-schema strict resolution

grammar capability resolution
grammar variant selection
grammar schema validation

grammar input extraction

Pi-generated serialized
grammar tool-input deltas
```

In particular, `appendGrammarToolInputJsonDelta()` establishes that `toolcall_delta.delta` may be synthesized by Pi rather than being raw provider wire input.

---

### 8.9 Lazy Runtime

```text
pi-agent/packages/ai/src/api/lazy.ts
```

provides:

```text
lazyStream()
lazyApi()

setup Promise chain
forwardStream()

catch mechanics

capability-gated
deferred fetch wrapping

capability-gated
deferred cancellation
loading/dispatch
```

`lazy.ts` owns:

```text
catch attempts outer.push(error)
```

but does not itself implement post-terminal suppression.

That suppression belongs to `EventStream.push()` in §8.6.

Likewise:

```text
lazy.ts
→ forwardStream awaits source.result()

event-stream.ts
→ bare end() may leave result unresolved
```

Together these establish the malformed bare-end forwarding behavior described in §6.3.3.

---

### 8.10 Cancellation and Authentication

```text
pi-agent/packages/ai/src/utils/abort.ts
pi-agent/packages/ai/src/auth/resolve.ts
```

provide evidence for:

```text
AbortSignal propagation

raceWithAbortSignal()

auth-resolution cancellation

Models/lazy AbortSignal
provenance-loss behavior
```

---

### 8.11 Concrete Producer Behavior

Important concrete and shared stream implementations include:

```text
pi-agent/packages/ai/src/api/openai-completions.ts
pi-agent/packages/ai/src/api/openai-responses.ts
pi-agent/packages/ai/src/api/openai-responses-shared.ts
pi-agent/packages/ai/src/api/anthropic-messages.ts
pi-agent/packages/ai/src/api/mistral-conversations.ts
```

Other provider implementations such as Google, Vertex, Bedrock, Codex, Azure and Pi Messages provide additional provider-specific evidence.

These sources establish observed behavior including:

```text
start after asynchronous request setup

pre-start failures

content lifecycle interleaving

partial state mutation/reuse

normal block completion

failure-interrupted blocks

adapter-level AbortSignal classification

direct streamSimple preflight behavior

samplingParams provider-payload precedence

onPayload replacement behavior

adapter-specific post-onPayload processing

TextSignatureV1 encoding/parsing

OpenAI Responses content processing

incremental ToolCall handling

grammar/custom-tool delta synthesis integration

provider-native terminal-status mapping
```

For OpenAI-compatible request construction:

```text
named request fields
→ samplingParams merged afterward
→ callback-visible payload
```

can occur.

For Mistral, the observed lifecycle includes:

```text
buildChatPayload()
        │
        ▼
onPayload()
        │
        ▼
toMistralWirePayload()
        │
        ▼
JSON.stringify()
        │
        ▼
HTTP request
```

This demonstrates that:

```text
onPayload output
≠ universally final wire representation
```

The pinned OpenAI Responses shared implementation also maps provider-native:

```text
failed
cancelled
```

to:

```text
stopReason = "error"
```

demonstrating that provider-native `"cancelled"` is not synonymous with Pi `"aborted"`.

---

### 8.12 Built-In Provider Wiring

Relevant ordinary stream runtime wiring includes:

```text
pi-agent/packages/ai/src/api/*.lazy.ts
pi-agent/packages/ai/src/providers/*
```

Examples include:

```text
anthropicProvider()
→ anthropicMessagesApi()
→ lazyApi()

openrouterProvider()
→ openAICompletionsApi()
→ lazyApi()
```

These sources establish the distinction between:

```text
direct API implementation behavior
```

and:

```text
built-in public Provider behavior
```

The generic `lazyApi()` implementation contains capability-gated deferred branches.

Their existence does not by itself prove that the pinned built-in lazy wrappers enable those deferred capabilities.

---

### 8.13 Versioning Rule

A future Pi source change that materially changes a documented:

```text
static type contract
semantic relationship
invocation contract
shared helper behavior
replay normalization
stream lifecycle
runtime boundary
payload callback boundary
failure classification
deferred continuation behavior
implementation mismatch
```

requires a new protocol version.

The phrase `"current source"` must not be used to reinterpret this frozen version after the reference commit changes.

---

## 9. Frozen Contract Lifecycle

The complete chat information lifecycle described by this protocol is:

```text
Core Data
        │
        ▼
Invocation Controls
        │
        ▼
Shared Helpers / Adapter Conversion
        │
        ▼
Callback-Visible Payload Representation
        │
        ▼
onPayload
        │
        ▼
Optional Adapter / SDK
Post-Callback Processing
        │
        ▼
Provider Request
        │
        ▼
Assistant Stream
        │
        ▼
Terminal
        │
        ├── ordinary terminal
        │
        └── deferred
                │
                ▼
          DeferredHandle
                │
                ├── fetch
                │   ├── Provider surface: stream
                │   └── Models surface: result Promise
                │
                └── cancel
                    └── Promise<void>
```

The Frozen protocol preserves the following boundaries:

```text
Core data
≠ invocation controls

chat semantics
≠ runtime infrastructure

shared helper behavior
≠ mandatory adapter behavior

callback-visible payload
≠ provider-wire payload

onPayload
≠ universal final transformation

samplingParams precedence
within adapter construction
≠ final wire precedence

stored historical Pi data
≠ provider-visible replay data

ToolCall partial state
≠ completed / validated ToolCall

iterator EOF
≠ semantic success

generic EventStream
≠ semantic lifecycle validator

provider-native terminology
≠ canonical Pi terminal classification

AbortSignal cancellation provenance
≠ provider-native "cancelled" status

deferred fetch
≠ deferred cancel failure surface

capability-gated lazy deferred behavior
≠ proof that pinned built-in wrappers enable it
```