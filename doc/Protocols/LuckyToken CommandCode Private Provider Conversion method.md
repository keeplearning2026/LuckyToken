# LuckyToken CommandCode Private Provider Conversion Method

**File:** `LuckyToken CommandCode Private Provider Conversion Method.md`  
**Version:** 0.20  
**Status:** FROZEN — Implementation Specification  
**Revision Type:** Structure Closure — Semantic Equivalence Restored  
**Boundary:** Pi AI IR ↔ CommandCode Private Protocol

---

# Part I — Foundations

## 1. Source Basis

```text
LuckyToken Repository
└── main
    └── 388f478723d297168d2d824c34a4791b85885166

LuckyToken Core
└── LuckyTokenCoreSpec v5.5

CommandCode Private Protocol
├── Version 1.3
├── compatibility target command-code@1.9.0
└── doc/Protocols/commandcode private protocol.md

Pi AI IR Protocol
├── Version 0.9.2
├── Runtime Reference Commit
│   └── eb3c46d6ce28cb87147bb0d05645ebae28524713
└── Reference Module
    └── pi-agent/packages/ai
```

Relevant pinned Pi runtime evidence includes:

```text
types.ts
models.ts
simple-options.ts
constrained-sampling.ts
provider-retry.ts
event-stream.ts
abort.ts
```

The user-authored:

```text
CommandCode SSE → Pi AI IR：Atomic Conversion 实现教程
```

is a design reference for atomic response conversion.

Where it conflicts with the pinned protocol/runtime sources, the pinned sources are authoritative.

---

## 2. Scope

This specification defines one concrete Provider conversion boundary:

```text
Pi Runtime Contracts
        ↕
CommandCode Private Provider
        ↕
CommandCode Private Protocol
```

It defines exactly two semantic directions:

```text
Request
Pi AI IR
→ CommandCode
```

and:

```text
Response
CommandCode
→ Pi AI IR
```

It does not define:

```text
Generic Provider IR
Universal Request IR
Universal Response IR
Universal Message IR
Universal Content IR
ProtocolBCodec
```

Temporary representations such as:

```text
authority snapshots
GenerateRequest callback object
serialized validation view
PreparedCommandCodeRequest
attempt-local transport state
response assembler slots
CommandCodeResult
Pi replay state
```

are lifecycle-local state.

They do not constitute an additional semantic protocol.

---

## 3. Complete Information Flow

```text
Pi Provider Invocation
├── Model
├── Context
└── Options
        │
        ▼
Part II — Request Conversion
Pi AI IR → CommandCode
        │
        ▼
Prepared CommandCode Wire Request
        │
        ├──────── Provider Execution Controls
        │
        ▼
HTTP Attempt*
        │
        ▼
CommandCode HTTP Response
        │
        ▼
Part III — Response Conversion
        │
        ├── Stage A
        │   CommandCode Reconstruction
        │
        ├── Stage B
        │   CommandCodeResult → AssistantMessage
        │
        └── Stage C
            AssistantMessage → Pi Event Replay
        │
        ▼
AssistantMessageEventStream
```

---

## 4. Global Architectural Invariants

### 4.1 Concrete conversion only

```text
Pi
→ concrete CommandCode request

atomic CommandCode result
→ Pi
```

There is no generic Provider semantic layer between them.

### 4.2 Semantic state and execution infrastructure remain separate

Semantic/request information does not absorb:

```text
credentials
HTTP lifecycle
AbortControllers
retry counters
timers
Request / Response objects
reader state
trace spans
debug state
```

unless that information is itself part of the CommandCode wire contract.

### 4.3 Stable semantic request across retries

One logical Provider invocation resolves its effective CommandCode request once.

Retries reuse that request.

They do not rerun semantic conversion.

### 4.4 Fresh physical state per attempt

Each retry creates fresh:

```text
span
traceparent
timeout scope
Request
Response
reader
decoder
line buffer
response assembler
```

### 4.5 Atomic response conversion

No Pi semantic content is emitted until one physical CommandCode response has successfully reached the CommandCode commit point.

### 4.6 Physical EOF is part of success

A `finish` event alone does not commit the CommandCode response.

### 4.7 Cancellation is first-class

Caller cancellation remains authoritative throughout Provider execution.

### 4.8 Information lifetime follows ownership

Facts should die when their last real consumer has finished.

Do not retain duplicate representations merely for convenience.

### 4.9 Runtime Information Source Closure

All LuckyToken-owned Provider semantic/request facts MUST come only from:

```text
1. Pi Provider invocation inputs

2. explicit Provider-bound dependencies

3. request-local state derived from 1 and 2
```

There is no undeclared fourth source.

Equivalently:

```text
declared invocation inputs
+
declared bound dependencies
+
owned/derived request-local state
=
complete Provider request-information closure
```

The Provider MUST NOT obtain request semantics from unrelated or undeclared state such as:

```text
raw downstream client protocol request
global RequestContext bag
CredentialStore internals
agent session state
client rendering state
process.cwd() as implicit project identity
ambient tracing context outside the bound Trace Context capability
```

Individual sections may impose stricter ownership rules for specific facts such as:

```text
Authorization
session identity
project identity
permission mode
reasoning capability
trace context
```

but those rules refine this closure; they do not introduce additional information sources.

---

## 5. Provider Authority Hierarchy

The Provider invocation has two distinct authority lifetimes:

```text
Provider Invocation Authority
│
├── Response-Lifetime Authority
│   ├── Response Identity
│   │   ├── invokedApi
│   │   ├── invokedProvider
│   │   └── invokedModelId
│   ├── responseTimestamp
│   └── Pricing Authority
│       └── capturedPricingBasis
│
└── Request-Validation Authority
    ├── resolvedSessionUuid
    ├── resolvedPermissionMode
    ├── authoritativeConfig
    └── supportedCommandCodeEfforts
```

Lifecycle:

```text
Request-Validation Authority
→ request construction
→ onPayload validation
→ serialized wire validation
→ dies
```

```text
Response-Lifetime Authority
→ request
→ attempts
→ CommandCodeResult
→ Pi semantic conversion
→ terminal
→ dies
```

The two lifetimes MUST NOT be collapsed into one common death point.

---

## 6. Minimal Module Structure

```text
commandcode-private/
├── request.ts
├── response.ts
├── provider.ts
└── project.ts
```

### 6.1 `request.ts`

Owns:

```text
endpoint
session identity
project input boundary
project slug
base headers
reasoning conversion
supported-effort derivation
message conversion
ToolResult conversion
missing ToolResult repair
Tool definition conversion
constrainedSampling policy
request-validation authority capture
onPayload
serialization
wire validation
```

### 6.2 `project.ts`

Owns:

```text
projectDir
→ Project Snapshot capability
→ ServerConfig
```

The exact Project Snapshot algorithm follows CommandCode Private Protocol v1.3 §4.

### 6.3 `provider.ts`

Owns:

```text
Pi stream lifecycle
response-lifetime authority capture
pricing snapshot
fetch resolution
execution controls
retry loop
retry delay
attempt timeout
trace lifecycle
onResponse lifecycle
caller cancellation
terminal normalization
```

### 6.4 `response.ts`

Owns:

```text
HTTP response classification
bare JSONL decoding
event validation
ID-indexed assembler
finish / EOF commit
CommandCodeResult
usage conversion
content conversion
Pi replay
```

Keep these modules cohesive until implementation/tests demonstrate a real reason to split them.

---

## 7. Explicitly Avoid

Do not introduce solely for organization:

```text
RequestManager
ResponseManager
ConversionManager
RetryManager
StreamManager
TraceManager
CancellationManager
HookManager
ToolPreviewManager
ContinuationManager
PricingManager

GenericRequestIR
GenericResponseIR
ProviderIR
UniversalMessage
UniversalContent

DependencyBag
ProviderContext
ModeResolver
ReasoningCapabilityRegistry
```

---

# Part II — Request: Pi AI IR → CommandCode

## 1. Request Conversion Boundary

### 1.1 Input

```text
Pi Provider Invocation
│
├── Model<Api>
│
├── Context
│   ├── systemPrompt?
│   ├── messages[]
│   └── tools[]?
│
└── SimpleStreamOptions
```

### 1.2 Bound dependencies

```text
Bound Dependencies
├── CommandCode compatibility configuration
├── permission policy
├── Project Snapshot capability
├── Trace Context capability
└── default HTTP/fetch implementation
```

### 1.3 Output

Semantic preparation produces:

```text
PreparedCommandCodeRequest
├── url
├── bodyText
├── baseHeaders
├── fetchImpl
└── logicalTraceId?
```

This is retry-surviving CommandCode wire state.

It is not complete Provider execution state.

---

## 2. Pi Invocation Structure

```text
Pi Provider Invocation
│
├── Model<Api>
│   ├── Identity
│   │   ├── id
│   │   ├── api
│   │   └── provider
│   ├── Endpoint
│   │   └── baseUrl
│   ├── Capabilities
│   │   ├── input[]
│   │   ├── reasoning
│   │   └── thinkingLevelMap?
│   ├── Limits
│   │   ├── contextWindow
│   │   └── maxTokens
│   └── Pricing
│       └── cost
│
├── Context
│   ├── systemPrompt?
│   ├── messages[]
│   │   ├── UserMessage
│   │   ├── AssistantMessage
│   │   └── ToolResultMessage
│   └── tools[]?
│
└── SimpleStreamOptions
    ├── Generation
    │   ├── temperature?
    │   ├── maxTokens?
    │   └── reasoning?
    │
    ├── Identity / Metadata
    │   ├── sessionId?
    │   └── metadata?
    │
    ├── HTTP / Auth
    │   ├── apiKey?
    │   ├── headers?
    │   ├── fetch?
    │   └── env?
    │
    ├── Lifecycle
    │   ├── signal?
    │   ├── timeoutMs?
    │   ├── maxRetries?
    │   └── maxRetryDelayMs?
    │
    ├── Telemetry
    │   └── telemetryContext?
    │
    └── Hooks
        ├── onPayload?
        └── onResponse?
```

---

## 3. Pi Helper Boundary

Shared Pi helpers are selective implementation capabilities.

They are not mandatory generic middleware.

Do not assume:

```text
Context.messages
→ transformMessages()
→ Provider
```

or:

```text
SimpleStreamOptions
→ generic normalized request IR
→ Provider
```

Focused reuse may include:

```text
getSupportedThinkingLevels()
clampThinkingLevel()
clampMaxTokensToContext()
resolveJsonSchemaStrictSampling()
calculateCost()
raceWithAbortSignal()
```

CommandCode-specific conversion MAY intentionally differ from `transformMessages()` where:

```text
CommandCode representability
CommandCode continuity
CommandCode-defined repair
```

requires a stricter/direct mapping.

---

## 4. Invocation Start and Response-Lifetime Authority

### 4.1 Pre-abort gate

The concrete Provider synchronously returns:

```text
AssistantMessageEventStream
```

and performs work inside its async producer.

The first producer check is:

```text
caller signal already aborted?
├── yes
│   → Pi aborted
│   → no Project Snapshot
│   → no onPayload
│   → no HTTP
└── no
    → continue
```

### 4.2 Response identity

Before any untrusted callback, capture:

```text
invokedApi      = model.api
invokedProvider = model.provider
invokedModelId  = model.id
responseTimestamp
```

Create the base response identity:

```text
AssistantMessage
├── role = assistant
├── content = []
├── api = invokedApi
├── provider = invokedProvider
├── model = invokedModelId
├── usage = zero
├── stopReason = pending
└── timestamp = responseTimestamp
```

Later Provider behavior MUST NOT reread mutable callback-visible:

```text
model.api
model.provider
model.id
```

to establish current-invocation response identity.

### 4.3 Pricing authority

Before `onPayload`, capture callback-isolated pricing information.

Conceptually:

```text
capturedPricingBasis
=
deep clone of model.cost
including cost.tiers
```

If Pi `calculateCost()` is reused directly, implementation MAY create:

```text
pricingModelSnapshot
└── cost = captured pre-hook cost
```

and later call:

```text
calculateCost(pricingModelSnapshot, usage)
```

Callback-mutated `model.cost` MUST NOT become current-invocation accounting authority.

---

## 5. CommandCode Request Structure

```text
CommandCode HTTP Request
│
├── Method
│   └── POST
│
├── Endpoint
│
├── Headers
│   ├── HTTP compatibility
│   ├── Session identity
│   ├── Project identity
│   ├── Authentication
│   ├── OSS provider
│   └── Trace
│
└── GenerateRequest
    ├── config
    ├── memory
    ├── taste
    ├── skills
    ├── permissionMode
    ├── threadId
    ├── mode?
    └── params
        ├── model
        ├── system?
        ├── max_tokens
        ├── stream
        ├── temperature?
        ├── reasoning_effort?
        ├── messages[]
        └── tools[]
```

---

## 6. Endpoint

Source:

```text
model.baseUrl
```

Resolved endpoint:

```ts
new URL("/alpha/generate", model.baseUrl)
```

The path is root-resolved.

Existing `baseUrl` pathname is not treated as a prefix.

Invalid URL:

```text
→ Pi error
```

The resolved URL remains stable across retries.

---

## 7. Headers

### 7.1 Header ownership pipeline

```text
Pi effective ProviderHeaders
        ↓
case-insensitive normalization
        ↓
apply null suppression
        ↓
remove CommandCode-reserved names
        ↓
ordinary caller headers
        ↓
overlay Provider-authoritative CommandCode headers
        ↓
baseHeaders
```

`traceparent` is attempt-local and is not stored in stable `baseHeaders`.

### 7.2 Pi header semantics

Pi:

```ts
Record<string, string | null>
```

Header names are case-insensitive.

For ordinary headers:

```text
string
→ include / replace

null
→ suppress / remove
```

Never serialize null as `"null"`.

### 7.3 Reserved headers

The Provider owns at least:

```text
content-type
accept
user-agent
x-command-code-version
x-cli-environment
x-project-slug
x-taste-learning
x-co-flag
x-session-id
x-cmd-zdr
traceparent
authorization
x-oss-primary-provider
x-oauth-token
x-oauth-provider
```

Reserved matching is performed after lowercasing names.

### 7.4 Fixed headers

```text
Content-Type = application/json
Accept = */*
User-Agent = cli
x-command-code-version = 1.9.0
x-taste-learning = false
x-co-flag = false
x-cmd-zdr = "1"
```

### 7.5 CLI environment

Source:

```text
bound compatibility configuration
```

Normalization:

```text
"prod"  → "production"
missing → "production"
other   → preserve
```

Result:

```text
x-cli-environment
```

### 7.6 Authorization

Authorization has one authority:

```text
Pi resolved apiKey
→ CommandCode Authorization
```

Usable non-empty key:

```text
Authorization: Bearer <exact apiKey>
```

Otherwise omit.

Caller generic:

```text
options.headers.authorization
```

is removed as a reserved header and cannot establish competing credential authority.

### 7.7 Forbidden OAuth headers

Current profile MUST NOT send:

```text
x-oauth-token
x-oauth-provider
```

### 7.8 OSS primary provider

Source:

```text
bound compatibility config.ossPrimaryProvider
```

Non-empty:

```text
→ x-oss-primary-provider
```

Absent:

```text
→ omit
```

Do not infer it from `model.provider`.

---

## 8. Session Identity

### 8.1 Logical identity

CommandCode represents one logical UUID twice:

```text
CommandCode Session Identity
├── Header
│   └── x-session-id
└── Body
    └── threadId
```

### 8.2 Resolution

```text
options.sessionId
├── valid UUID
│   → preserve
└── missing / invalid
    → randomUUID()
        │
        ▼
resolvedSessionUuid
```

Then:

```text
x-session-id = resolvedSessionUuid
threadId     = resolvedSessionUuid
```

Resolve exactly once per Provider invocation.

Retry MUST NOT regenerate it.

---

## 9. Project Context

### 9.1 Project identity source

LuckyToken Provider convention:

```text
options.metadata?.projectDir
```

Classification:

```text
projectDir
├── non-empty string
│   → project-bound
└── missing / empty / non-string
    → project-less
```

Filesystem validity does not determine project identity.

### 9.2 Project Snapshot algorithm authority

The conversion specification does not duplicate the detailed `ServerConfig` algorithm.

Exact construction is delegated to:

```text
CommandCode Private Protocol v1.3
§4 — config 的完整计算方法
```

That protocol owns:

```text
workingDir/date/environment
structure filtering
exclusion set
sort behavior
workspace scopes
scope formatting
readdir fallback

Git command ordering
successful-empty vs failure distinction
currentBranch
mainBranch
gitStatus
recentCommits
non-Git fallback
```

### 9.3 Project-bound

```text
non-empty projectDir
→ Project Snapshot capability
→ ServerConfig according to CC v1.3 §4
```

A nonexistent/unreadable path remains project-bound.

Expected filesystem/Git failures use CommandCode field-local fallback.

They do not convert the invocation to project-less.

### 9.4 Project-less

Missing/empty/non-string `projectDir`:

```text
→ CommandCode v1.3 §4 typed empty ServerConfig
```

Do not use:

```text
process.cwd()
filesystem discovery
Git discovery
```

to invent project identity.

### 9.5 Project Snapshot lifecycle

Snapshot is resolved once per Provider invocation.

Before:

```text
check caller signal
```

After:

```text
re-check caller signal
```

If snapshot capability accepts AbortSignal:

```text
pass caller signal
```

Cancellation observed after snapshot:

```text
→ discard snapshot state
→ Pi aborted
→ no onPayload
→ no HTTP
```

### 9.6 Project slug

Project-bound:

```text
x-project-slug =
slugify(projectDir) || "root"
```

Compatibility package:

```text
@sindresorhus/slugify 2.2.1
```

Project-less:

```text
x-project-slug = "root"
```

Slug calculation depends on caller cwd, not successful filesystem inspection.

---

## 10. Trace Context

### 10.1 Input

```text
options.telemetryContext?
→ bound Trace Context capability
→ logical trace state?
```

Do not obtain trace authority from hidden ambient state.

### 10.2 Logical trace

```text
Provider Invocation
└── traceId
    ├── Attempt 1 spanId
    ├── Attempt 2 spanId
    └── Attempt N spanId
```

W3C format:

```text
00-<32 lowercase nonzero hex traceId>-<16 lowercase nonzero hex spanId>-01
```

No valid context:

```text
→ omit traceparent
```

### 10.3 Attempt-local trace

Stable request headers exclude `traceparent`.

Each attempt:

```text
baseHeaders
→ clone
→ fresh spanId
→ traceparent
→ attemptHeaders
```

Thus:

```text
traceId
→ may remain stable

spanId
→ fresh per physical attempt
```

---

## 11. GenerateRequest Top Level

```text
GenerateRequest
├── config
├── memory = null
├── taste = null
├── skills = null
├── permissionMode
├── threadId
├── mode?
└── params
```

### 11.1 Compatibility context

Current profile:

```text
memory = null
taste = null
skills = null
```

No other mapping is established.

### 11.2 Permission

Resolve before callback:

```text
bound permission policy
→ resolvedPermissionMode
```

Mapping:

```text
plan
→ plan

bypass
→ auto-accept

auto-accept
→ auto-accept

other / absent
→ standard
```

Then:

```text
GenerateRequest.permissionMode =
resolvedPermissionMode
```

Permission mode is Provider-owned policy.

### 11.3 `mode`

Normal Pi conversion:

```text
mode
→ omit
```

`onPayload` may introduce a native CommandCode mode.

Post-serialization rule:

```text
mode absent
→ valid

mode present
→ non-empty string
```

No closed enum or ModeRegistry is introduced.

---

## 12. `params`

```text
params
├── model
├── system?
├── max_tokens
├── stream
├── temperature?
├── reasoning_effort?
├── messages[]
└── tools[]
```

---

## 13. Model and System

### 13.1 Model

```text
params.model = invokedModelId
```

Model identity is Provider-owned.

`onPayload` cannot change it.

### 13.2 System

```text
context.systemPrompt present
→ params.system

absent
→ omit
```

No synthetic empty string solely for field presence.

---

## 14. Generation Controls

### 14.1 Max tokens

Candidate:

```text
options.maxTokens
??
model.maxTokens
```

Validate before helper use:

```text
finite
positive
integer
```

Then:

```text
candidate
→ clampMaxTokensToContext(...)
→ params.max_tokens
```

### 14.2 Stream

Always:

```text
params.stream = true
```

Serialized callback body with another value is invalid.

### 14.3 Temperature

```text
absent
→ omit

finite number
→ send

0
→ valid

NaN / Infinity / -Infinity
→ Pi error
```

---

## 15. Reasoning

Reasoning forms one semantic chain:

```text
Pi Model Capability
        ↓
Pi Requested ThinkingLevel
        ↓
Effective Pi ThinkingLevel
        ↓
Pi → CommandCode Semantic Mapping
        ↓
CommandCode reasoning_effort
```

### 15.1 Requested reasoning

If `options.reasoning` is absent:

```text
→ omit reasoning_effort
```

Otherwise:

```text
requested
→ clampThinkingLevel(model, requested)
→ effective
```

### 15.2 `off`

First branch:

```text
effective === "off"
→ omit reasoning_effort
```

No mapping occurs afterward.

Example:

```text
model.reasoning = false
requested = high
→ clamp = off
→ omission
```

### 15.3 Default mapping

Without explicit mapping:

```text
minimal → low
low     → low
medium  → medium
high    → high
```

`xhigh/max` require explicit support.

### 15.4 Supported effort authority

Before `onPayload`:

```text
getSupportedThinkingLevels(model)
        ↓
remove "off"
        ↓
map supported Pi levels
        ↓
supportedCommandCodeEfforts
```

Per supported Pi level:

```text
thinkingLevelMap[level] = valid string
→ mapped effort
```

Allowed CommandCode values:

```text
low
medium
high
xhigh
max
```

If:

```text
thinkingLevelMap[level] === null
```

for a level already returned by `getSupportedThinkingLevels()`:

```text
→ defensive configuration error
```

because null should already have excluded it.

If no explicit mapping:

```text
minimal → low
low     → low
medium  → medium
high    → high
```

If supported-level derivation somehow yields:

```text
xhigh
or
max
```

without a corresponding explicit mapping:

```text
→ defensive configuration error
```

This defensive branch does NOT mean that a caller requesting an unsupported `xhigh` or `max` fails.

Requested reasoning is clamped first.

### 15.5 Requested unsupported high levels

For ordinary invocation semantics:

```text
requested xhigh/max
        ↓
clampThinkingLevel(model, requested)
        ↓
nearest supported Pi level
        ↓
map effective level
```

Example:

```text
model supports through high
no explicit xhigh/max mapping
requested = xhigh
        ↓
clampThinkingLevel(...)
        ↓
high
        ↓
reasoning_effort = high
```

No configuration error occurs merely because the originally requested level was unsupported.

### 15.6 Examples

```text
model.reasoning = false
→ [off]
→ supportedCommandCodeEfforts = {}
```

Therefore:

```text
onPayload sets low
→ reject
```

Explicit:

```text
thinkingLevelMap.high = "max"
```

means:

```text
high
→ max
→ captured set contains max
```

### 15.7 Authority rule

`supportedCommandCodeEfforts` is captured before callback.

Post-callback validation MUST NOT recalculate capability from mutable callback-visible:

```text
model.reasoning
model.thinkingLevelMap
```

---

## 16. Other Generation/Invocation Controls

Current profile:

```text
deferred true / object
→ Pi error
```

```text
samplingParams
→ not serialized
```

```text
cacheRetention
transport
websocketConnectTimeoutMs
thinkingBudgets
→ not mapped
```

```text
env
→ not serialized
→ may only be consumed by explicit Provider infrastructure
```

---

## 17. Messages

```text
Context.messages
│
├── UserMessage
│   └── User Content
│       ├── Text
│       └── Image
│
├── AssistantMessage
│   └── Assistant Content
│       ├── Text
│       ├── Thinking
│       └── ToolCall
│
└── ToolResultMessage
```

Historical assistant/tool relationships are evaluated as turns rather than independent flat blocks.

---

## 18. User Message Conversion

### 18.1 Text

Pi string/TextContent:

```text
→ {
  type: "text",
  text
}
```

Empty request text is not automatically removed.

### 18.2 Image

Pi:

```text
ImageContent
├── data
└── mimeType
```

maps to:

```text
{
  type: "image",
  image: "data:<mimeType>;base64,<data>",
  mimeType
}
```

Before sending:

```text
model.input includes "image"
→ valid

otherwise
→ Pi error
```

Wire representability and model capability remain separate checks.

---

## 19. Historical Assistant Message Conversion

### 19.1 Eligibility by stop state

Replayable:

```text
stop
length
toolUse
```

Omit:

```text
error
aborted
```

Reject:

```text
pending
deferred
```

After omission, ToolCall/ToolResult relationships are revalidated.

### 19.2 Same-target identity

Same target iff:

```text
assistant.provider == invokedProvider
AND
assistant.api == invokedApi
AND
assistant.model == invokedModelId
```

Captured invocation identity is authoritative.

### 19.3 Text continuity

Same target:

```text
textSignature absent / empty
→ convert

non-empty
→ Pi error
```

Foreign target:

```text
text
→ convert

textSignature
→ discard
```

### 19.4 Thinking continuity

Same target:

```text
redacted
→ Pi error

visible + no signature
→ CommandCode reasoning

visible + non-empty signature
→ Pi error
```

Foreign target:

```text
redacted
→ omit

visible
→ reasoning

signature
→ discard
```

No opaque continuity is invented.

---

## 20. Assistant Tool Turn

ToolCall/ToolResult semantics are modeled as one hierarchical unit:

```text
Assistant Tool Turn
│
├── AssistantMessage
│   └── ToolCall[]
│
└── Immediately Following ToolResultMessage(s)
    └── ToolResult[]
```

### 20.1 ToolCall mapping

Pi:

```text
ToolCall
├── id
├── name
├── arguments
├── thoughtSignature?
└── namespace?
```

CommandCode:

```text
{
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: arguments
}
```

### 20.2 Request ToolCall input

Require:

```text
non-null
non-array
object
losslessly JSON-representable
```

Reject semantic values involving:

```text
undefined
NaN
Infinity
-Infinity
bigint
function
symbol
cycles
custom serialization changing semantic value
```

Do not validate Tool arguments against Tool schema here.

### 20.3 ToolCall continuity

Same-target non-empty `thoughtSignature`:

```text
→ Pi error
```

Foreign:

```text
thoughtSignature
→ discard
```

Any:

```text
namespace !== undefined
```

is unsupported:

```text
→ Pi error
```

until CommandCode has an explicit mapping.

### 20.4 Duplicate ToolCall IDs

Within one Assistant Tool Turn:

```text
ToolCall(A)
ToolCall(A)
→ Pi error
```

Detect before constructing the turn-local correlation map.

Conversation-global uniqueness is not required.

### 20.5 ToolResult correlation

A real ToolResult must:

```text
reference ToolCall in current turn
consume it once
agree with expected tool identity/name
```

Reject:

```text
orphan ToolResult
duplicate ToolResult
```

### 20.6 ToolResult mapping

Pi:

```text
ToolResultMessage
├── toolCallId
├── toolName
├── content[]
└── isError
```

CommandCode:

```text
{
  type: "tool-result",
  toolCallId,
  toolName: "",
  output: {
    type: "text" | "error-text",
    value
  }
}
```

Text parts:

```text
textParts.join("\n")
```

Error mapping:

```text
isError = false
→ output.type = "text"

isError = true
→ output.type = "error-text"
```

ToolResult ImageContent:

```text
→ Pi error
```

### 20.7 Missing ToolResult

For a known unresolved ToolCall, synthesize the exact CommandCode placeholder:

```text
{
  type: "tool-result",
  toolCallId: "<id>",
  toolName: "",
  output: {
    type: "text",
    value:
      "No result — the tool call did not complete (interrupted or lost)."
  }
}
```

Synthetic results preserve original ToolCall order.

This is narrow CommandCode-defined repair.

Do not generalize it into malformed-history guessing.

---

## 21. Tool Definitions

```text
Pi Tool
├── name
├── description
├── parameters
└── constrainedSampling?
        │
        ▼
CommandCode WireTool
├── name
├── description
└── input_schema
```

Base mapping:

```text
name        → name
description → description
parameters  → input_schema
```

### 21.1 Constrained sampling hierarchy

```text
constrainedSampling
│
├── absent / false
│   → ordinary WireTool
│
├── json_schema
│   ├── strict = prefer
│   │   → ordinary non-strict WireTool
│   │
│   └── strict = require
│       → Pi error
│
└── grammar
    → ordinary WireTool
    → no grammar wire representation
```

No unproven:

```text
strict
grammar
regex
lark
```

CommandCode fields are invented.

---

## 22. Untrusted `onPayload` Boundary

The callback boundary is organized as one lifecycle:

```text
Resolve Provider Facts
        ↓
Capture Authority
        ↓
Build Callback-Visible GenerateRequest
        ↓
onPayload
        ↓
Serialize
        ↓
Parse Wire Validation View
        ↓
Validate
        ↓
Request-Validation Authority Dies
        ↓
PreparedCommandCodeRequest
```

---

## 23. Pre-Callback Authority Capture

### 23.1 Request-validation authority

Before callback capture:

```text
Request-Validation Authority
├── resolvedSessionUuid
├── resolvedPermissionMode
├── authoritativeConfig
└── supportedCommandCodeEfforts
```

### 23.2 Response-lifetime authority

Already captured and retained:

```text
Response-Lifetime Authority
├── invokedApi
├── invokedProvider
├── invokedModelId
├── responseTimestamp
└── capturedPricingBasis
```

### 23.3 Model mutability rule

Any mutable model-derived fact needed after callback execution MUST already be captured before callback.

Post-callback code MUST NOT re-establish authority from:

```text
model.id
model.api
model.provider
model.reasoning
model.thinkingLevelMap
model.cost
model.cost.tiers
```

---

## 24. Alias Isolation

### 24.1 Project config

Callback-visible config MUST NOT share identity with the authoritative snapshot.

Conceptually:

```ts
const authoritativeConfig =
  structuredClone(projectConfig);

const generateRequest = {
  config: structuredClone(authoritativeConfig),
  // ...
};
```

Equivalent lossless isolation is allowed.

Thus:

```text
callback mutation of payload.config
≠
mutation of authoritativeConfig
```

### 24.2 Model

Callback receives Pi `model`, but that object is only a callback argument after authority capture.

It cannot redefine the current invocation by mutating itself.

---

## 25. `onPayload`

### 25.1 Invocation

Callback representation:

```text
GenerateRequest
```

Invoke:

```text
onPayload(generateRequest, model)
```

at most once per Provider invocation.

If callback returns `undefined`:

```text
→ callback-visible object remains effective
```

If callback returns replacement:

```text
→ replacement becomes effective
```

### 25.2 Exactly-once invariant

`onPayload` belongs to semantic request preparation.

Forbidden:

```text
attempt 1
→ onPayload

retry

attempt 2
→ onPayload again
```

### 25.3 Cancellation

Waiting for asynchronous `onPayload` MUST be raced against caller cancellation, or provide equivalent behavior.

```text
onPayload Promise
        │
        ├───────────────┐
        │               │
        ▼               ▼
callback settles    caller abort wins
        │               │
        ▼               ▼
continue            stop waiting
                    callback result loses authority
                    no serialization
                    no HTTP
                    late rejection observed
```

Pi `raceWithAbortSignal()` is an appropriate primitive.

Synchronous CPU work already executing cannot be preempted by normal JavaScript cancellation; the contract concerns async waiting.

### 25.4 Mutation Surface

Subject to successful post-serialization structural, protocol, capability and Provider-authority validation, `onPayload` MAY modify CommandCode-native generation semantics including:

```text
params.system
params.messages
params.tools
params.max_tokens
params.temperature
params.reasoning_effort
mode
```

The callback MAY therefore modify the effective generation request semantics.

It MUST NOT replace Provider-owned facts including:

```text
threadId / session identity
params.model / selected model identity
permissionMode
config / Project Snapshot facts
```

Nor may callback mutation redefine captured:

```text
supportedCommandCodeEfforts
response identity
pricing authority
```

The distinction is:

```text
onPayload
├── MAY change generation semantics
└── MUST NOT change Provider-owned identity/policy authority
```

Part IV verifies this mutation surface; it does not define it.

---

## 26. Serialization Boundary

The callback object is untrusted JavaScript.

`JSON.stringify()` may execute:

```text
toJSON()
nested toJSON()
getters
undefined omission
normal JSON conversion
```

Therefore validating the pre-serialization object is insufficient.

Authoritative flow:

```text
effective callback object
        ↓
JSON.stringify exactly once
        ↓
bodyText
        ↓
JSON.parse(bodyText)
        ↓
validationValue
        ↓
validate actual wire semantics
```

Serialization failure:

```text
→ Pi error
→ no HTTP
→ no retry
```

---

## 27. Wire Validation View

```text
bodyText
→ JSON.parse(bodyText)
→ validationValue
```

`validationValue` is:

```text
short-lived
wire-equivalent
validation-only
```

It is not:

```text
Generic IR
new protocol model
persistent normalized request
```

Lifecycle:

```text
callback object
→ serialization
→ dies

validationValue
→ validation
→ dies

bodyText
→ survives retries
```

---

## 28. Post-Serialization Validation

Validation has four nested domains.

### 28.1 Structural validity

Require:

```text
request object

config valid ServerConfig

memory === null
taste === null
skills === null

permissionMode valid

threadId valid UUID

params object
params.model non-empty string
params.messages valid array
params.tools valid array
params.max_tokens valid
params.stream === true

temperature finite when present

reasoning_effort valid when present

mode:
├── absent
└── non-empty string
```

### 28.2 CommandCode protocol invariants

Revalidate:

```text
ToolCall.input object

ToolResult output shape

ToolResult output.type
∈ text | error-text

Assistant Tool Turn adjacency

exact result coverage

no orphan ToolResult

no duplicate ToolResult

no duplicate ToolCall ID
within a turn

required fields remain present
```

### 28.3 Reasoning capability

If final serialized request contains:

```text
params.reasoning_effort
```

require:

```text
value ∈ {
  low,
  medium,
  high,
  xhigh,
  max
}
```

AND:

```text
supportedCommandCodeEfforts.has(value)
```

Capability is not recalculated after callback.

### 28.4 Provider authority

Require:

```text
wire.threadId
===
captured resolvedSessionUuid
```

```text
wire.permissionMode
===
captured resolvedPermissionMode
```

```text
wire.params.model
===
captured invokedModelId
```

```text
wire.config
deeply equals
captured authoritativeConfig
```

Callback changes to these facts:

```text
→ Pi error
```

Do not modify Provider headers or Provider policy to follow callback mutations.

---

## 29. Authority Death After Wire Validation

After successful serialized-wire validation:

```text
authoritativeConfig
supportedCommandCodeEfforts
resolvedPermissionMode
validationValue
```

SHOULD die.

`resolvedSessionUuid` MAY also die once both authoritative representations have been validated into:

```text
bodyText
baseHeaders
```

These are request-validation facts.

They MUST NOT be confused with response-lifetime identity/pricing authority.

---

## 30. Prepared CommandCode Wire Request

After validation:

```text
PreparedCommandCodeRequest
├── url
├── bodyText
├── baseHeaders
├── fetchImpl
└── logicalTraceId?
```

### 30.1 Stable body

`bodyText` becomes the authoritative stable request body.

Every retry sends the exact same string.

### 30.2 Fetch resolution

Resolve once:

```text
fetchImpl =
options.fetch
?? boundDefaultFetch
?? globalThis.fetch
```

Every attempt uses this exact function.

### 30.3 What PreparedCommandCodeRequest does not contain

After successful validation it does not retain duplicate facts such as:

```text
project config
permission mode
model identity
supported effort set
```

when those facts have completed their request-validation role.

---

## 31. Provider Execution Lifecycle

Prepared wire state is only one branch of execution.

```text
Provider Execution
│
├── PreparedCommandCodeRequest
│   └── stable wire state
│
├── Execution Controls
│   ├── callerSignal
│   ├── timeoutMs
│   ├── maxRetries
│   ├── maxRetryDelayMs
│   ├── onResponse
│   └── retry budget/index
│
└── Attempt*
    └── fresh physical state
```

Thus:

```text
Prepared wire state
≠
complete Provider execution state
```

---

## 32. Execution Control Domains

### 32.1 Timer domain

For ordinary Node/JavaScript timers:

```text
MAX_TIMER_DELAY_MS = 2_147_483_647
```

### 32.2 `maxRetries`

Absent:

```text
0
```

Present require:

```text
Number.isSafeInteger(value)
AND
value >= 0
```

Otherwise:

```text
→ Pi error
```

### 32.3 `timeoutMs`

Absent:

```text
→ no Provider-created attempt timeout
```

Present require:

```text
safe integer
> 0
<= MAX_TIMER_DELAY_MS
```

Reject:

```text
0
negative
fractional
NaN
Infinity
unsafe integer
too large
```

### 32.4 `maxRetryDelayMs`

Absent:

```text
60_000
```

Zero:

```text
disable server-requested-delay cap
```

Positive require:

```text
safe integer
<= MAX_TIMER_DELAY_MS
```

Otherwise:

```text
→ Pi error
```

---

## 33. HTTP Attempt

Each physical attempt owns:

```text
Attempt
├── fresh spanId
├── fresh traceparent
├── fresh attemptHeaders
├── fresh timeout/cancellation scope
├── fresh Request
├── fresh Response
├── fresh reader
├── fresh TextDecoder
├── fresh line buffer
└── fresh CommandCode assembler
```

No physical attempt object is reused across retries.

---

## 34. Attempt Timeout Boundary

One attempt is:

```text
fetch establishment
        ↓
HTTP Response
        ↓
onResponse
        ↓
response body consumption
        ↓
JSONL decoder
        ↓
assembler
        ↓
physical EOF / attempt failure
```

The same attempt timeout covers this entire lifecycle.

Receiving HTTP headers does not end timeout authority.

Retry sleep is outside the previous attempt timeout.

---

## 35. `onResponse`

### 35.1 Invocation

Called once per physical HTTP `Response`.

Retries may therefore produce multiple `onResponse` calls.

Callback receives:

```text
ProviderResponse
├── status
└── headers
```

and the Pi `model` hook argument.

The callback-visible model is not semantic/pricing authority.

### 35.2 Timing

`onResponse` runs before body consumption.

### 35.3 Cancellation

Waiting for asynchronous `onResponse` MUST be raced against attempt cancellation.

If timeout/cancellation wins:

```text
stop waiting
cancel response body
do not begin JSONL body consumption
fail attempt
observe late callback rejection safely
```

If callback itself rejects before cancellation:

```text
→ Provider failure
→ not automatically retryable
```

---

## 36. Retry Classification

Retryable by current profile:

```text
network exception
HTTP 429
HTTP 500–599
2xx response with missing body
EOF without finish/abort
stream error with isRetryable === true
```

Non-retryable by default:

```text
other non-2xx
wire abort
pause_turn
malformed JSON
invalid event
unknown event
lifecycle violation
Pi semantic conversion failure
```

Retry requires remaining retry budget.

---

## 37. Retry Delay

Retry delay forms one deterministic hierarchy:

```text
Retry Delay
│
├── retry-after-ms
│
├── retry-after
│   ├── numeric seconds
│   └── HTTP date
│
└── fallback exponential backoff
```

### 37.1 `retry-after-ms`

If present:

```text
Number.parseFloat(value)
```

Usable if:

```text
finite
>= 0
```

Value is milliseconds.

Malformed / non-finite / negative:

```text
→ ignore
→ try retry-after
```

Malformed hint is not a Provider failure.

### 37.2 `retry-after`

If no usable `retry-after-ms`:

First attempt numeric seconds:

```text
finite
>= 0
```

Then:

```text
delayMs = seconds * 1000
```

If not usable numeric seconds, try HTTP-date parsing.

Valid date:

```text
delayMs =
max(0, parsedDateMs - nowMs)
```

Expired date:

```text
→ 0
```

Malformed:

```text
→ fallback backoff
```

A numeric negative value such as:

```text
retry-after: -1
```

is an unusable numeric hint and falls back.

It is not treated as an expired date.

### 37.3 Normalization

Once usable delay exists:

```text
delayMs = Math.ceil(delayMs)
```

Then require:

```text
Number.isSafeInteger(delayMs)
delayMs >= 0
delayMs <= MAX_TIMER_DELAY_MS
```

### 37.4 Malformed vs valid-but-unacceptable

```text
malformed / unusable hint
→ ignore
→ next source / fallback
```

But:

```text
successfully parsed delay
+
delay > positive maxRetryDelayMs
→ Provider execution failure
```

and:

```text
successfully parsed delay
+
timer-unrepresentable
→ Provider execution failure
```

Do not silently clamp either case.

### 37.5 Fallback backoff

Fallback backoff must also be:

```text
finite
integer after normalization
>= 0
<= MAX_TIMER_DELAY_MS
```

Retry sleep is cancellable by caller signal.

---

## 38. Retry Stability

Across retries remain stable:

```text
url
bodyText
baseHeaders
fetchImpl
logicalTraceId
```

The Provider does not rerun:

```text
Project Snapshot
message conversion
ToolResult synthesis
tool conversion
reasoning mapping
onPayload
serialization
wire validation
```

Attempt/retry execution MUST NOT reread:

```text
callback-visible payload
callback-visible model
dead request-validation snapshots
```

to reconstruct request semantics.

Execution controls remain separately available because they are infrastructure/lifecycle state.

---

## 39. Cancellation Hierarchy

```text
Caller Cancellation
│
├── Before Producer Work
│   → no preparation
│
├── During Project Snapshot
│   → stop / discard snapshot
│
├── During onPayload
│   → callback result loses authority
│
├── Before HTTP Attempt
│   → no HTTP request
│
├── During fetch/onResponse/body
│   → cancel attempt
│
├── During Retry Sleep
│   → stop waiting
│
└── Before Pi Replay
    → no semantic replay
```

### 39.1 Pre-attempt gate

Immediately before every HTTP attempt:

```text
caller signal aborted?
├── yes
│   → Pi aborted
│   → no Request
└── no
    → start attempt
```

If cancellation is observed before the first HTTP attempt:

```text
fetch call count = 0
```

### 39.2 Failure provenance

When attempt work fails:

```text
caller signal aborted
→ Pi aborted

else attempt timeout fired
→ timeout error

else
→ actual Provider/upstream failure
```

CommandCode wire abort is not caller cancellation.

---

# Part III — Response: CommandCode → Pi AI IR

## 1. Response Conversion Boundary

The response direction has three nested stages:

```text
CommandCode → Pi Response Conversion
│
├── Stage A — CommandCode Reconstruction
│   CommandCode HTTP Response
│   → CommandCodeResult
│
├── Stage B — Semantic Conversion
│   CommandCodeResult
│   → Pi AssistantMessage
│
└── Stage C — Pi Replay
    Pi AssistantMessage
    → AssistantMessageEventStream
```

They are internal stages of one direction.

They do not create a third protocol layer.

---

## 2. Atomicity

Before Stage A commits:

```text
NO Pi semantic content event is emitted
```

All partial CommandCode state remains Provider-private.

Atomicity protects against:

```text
retry
wire abort
stream error
transport truncation
protocol lifecycle error
pause_turn
Pi representability failure
```

No partial content escapes before the response is known to be valid.

---

# Stage A — CommandCode Reconstruction

## 3. HTTP Response

### 3.1 Success candidate

After `fetchImpl` and `onResponse`:

```text
2xx
+
readable body
→ consume CommandCode response
```

### 3.2 Non-2xx

Read complete response body as HTTP error detail.

Do not treat non-2xx body as successful CommandCode event framing.

### 3.3 Missing 2xx body

```text
2xx + missing body
→ retryable transport failure
```

---

## 4. Physical Stream

CommandCode may use HTTP:

```text
Content-Type: text/event-stream
```

but physical framing is:

```text
JSON.stringify(event) + "\n"
```

Therefore the response is:

```text
bare JSON Lines
```

not conventional SSE.

Do not interpret:

```text
data:
event:
id:
retry:
blank-line SSE framing
[DONE]
```

as CommandCode framing.

`[DONE]` is invalid JSON.

---

## 5. UTF-8 and Line Decoding

```text
ReadableStream<Uint8Array>
        ↓
TextDecoder.decode(chunk, { stream: true })
        ↓
text buffer
        ↓
complete LF-delimited line
```

Network chunk boundaries have no semantic meaning.

Repeatedly:

```text
buffer
→ locate LF
→ extract complete line
→ trim
├── empty
│   → ignore
└── non-empty
    → JSON.parse
    → validate event
    → assembler.consume()
```

CRLF is handled through trimming.

At physical EOF:

```text
1. flush TextDecoder
2. append decoder remainder
3. parse final unterminated non-empty line
4. finalize assembler
```

The last event does not require a trailing LF.

---

## 6. Malformed Input

```text
non-JSON complete line
→ non-retryable protocol error
```

```text
JSON value not representing valid event
→ non-retryable protocol error
```

```text
unknown event type
→ non-retryable protocol error
```

Unknown event is not equivalent to known ignored event.

---

## 7. Event Model

```text
CommandCode Event
│
├── Content
│   ├── Text
│   │   ├── text-start
│   │   ├── text-delta
│   │   └── text-end
│   │
│   ├── Reasoning
│   │   ├── reasoning-start
│   │   ├── reasoning-delta
│   │   └── reasoning-end
│   │
│   └── Tool
│       ├── tool-input-start
│       ├── tool-input-delta
│       ├── tool-input-end
│       └── tool-call
│
├── Known Ignored
│   ├── start
│   ├── start-step
│   ├── provider-metadata
│   ├── finish-step
│   └── response-side tool-result
│
└── Control
    ├── finish
    ├── error
    └── abort
```

---

## 8. Atomic Assembler

The assembler is an ordered, ID-indexed state machine:

```text
CommandCode Assembler
│
├── Ordered Content
│   ├── textById
│   ├── reasoningById
│   ├── toolById
│   └── slots[]
│
├── Terminal Candidate
│   └── finish?
│
├── Usage
│   ├── rawUsage?
│   └── normalizedUsage
│
└── Diagnostics
    ├── systemPromptTokens?
    └── raw diagnostics?
```

Fresh assembler state is created for every physical attempt.

Failed assembler state never crosses retry.

---

## 9. Content Ordering

Only content-start events reserve order:

```text
text-start
reasoning-start
tool-input-start
```

Final content order is:

```text
start-event arrival order
```

Do not reorder by:

```text
completion order
ID
content type
timestamp
```

Separate maps are used:

```text
Map<string, TextSlot>
Map<string, ReasoningSlot>
Map<string, ToolSlot>
```

The same ID string may exist in different content-kind namespaces unless protocol rules say otherwise.

Duplicate start within the same type/ID:

```text
→ protocol error
```

Mutation after slot closure:

```text
→ protocol error
```

---

## 10. Text Slot Lifecycle

```text
TextSlot
└── text-start
    → text-delta*
    → text-end
```

Delta without matching open start:

```text
→ protocol error
```

End without matching open start:

```text
→ protocol error
```

Mutation after close:

```text
→ protocol error
```

At close:

```text
trim(text).length > 0
```

must hold.

Otherwise:

```text
EMPTY_CONTENT_BLOCK
→ protocol error
```

No delta-first auto-reservation.

No EOF auto-close.

---

## 11. Reasoning Slot Lifecycle

```text
ReasoningSlot
└── reasoning-start
    → reasoning-delta*
    → reasoning-end
```

Same strict lifecycle rules as Text.

Completed reasoning must be non-empty after trimming.

Provider metadata on reasoning events is diagnostic only.

It does not become Pi ThinkingContent metadata.

---

## 12. Tool Slot Lifecycle

```text
ToolSlot
└── tool-input-start
    → tool-input-delta*
    → tool-input-end
    → tool-call
```

No final-only ToolCall.

### 12.1 Minimal ToolSlot

```text
ToolSlot
├── id
├── order
├── startToolName
├── inputEnded
├── finalToolName?
├── finalInput?
└── state
```

No parsed preview semantic object is required.

### 12.2 `tool-input-start`

Requires:

```text
valid ID
non-empty start tool name
no existing same-ID ToolSlot
```

Then reserve ordering slot.

### 12.3 `tool-input-delta`

Requires:

```text
matching open ToolSlot
inputEnded === false
delta is string
```

Delta is preview information only.

Do not:

```text
parse partial JSON
construct Pi preview arguments
emit Pi semantic toolcall_delta
```

from this preview.

### 12.4 `tool-input-end`

Requires matching open ToolSlot with:

```text
inputEnded === false
```

Then:

```text
inputEnded = true
```

Repeated end:

```text
→ protocol error
```

### 12.5 Final `tool-call`

Requires:

```text
matching open ToolSlot
AND
inputEnded === true
```

Final authority:

```text
final toolName =
event.toolName
```

and:

```text
final input =
event.input
??
event.args
??
{}
```

Then close slot.

Start/final tool name mismatch alone is not failure.

Final event name wins.

### 12.6 Final input representation

Assembler preserves:

```text
finalInput: unknown
```

Pi object-shape validation belongs to Stage B.

Preview input is not used to repair invalid final input.

---

## 13. Known Ignored Events

Current known ignored events:

```text
start
start-step
provider-metadata
finish-step
response-side tool-result
```

They produce no Pi semantic content.

Known ignored:

```text
≠
unknown
```

Do not infer committed semantics from unfamiliar raw field names unless CommandCode protocol explicitly assigns such semantics.

Current committed ToolUse semantics remain:

```text
id
toolName
input
```

---

## 14. Control Events

### 14.1 `finish`

`finish` is a terminal candidate, not a commit.

On every finish:

```text
replace current finish candidate
replace extracted finish metadata
continue reading body
```

No Pi content/terminal event is emitted.

### 14.2 Multiple finish events

Later finish completely replaces previous finish state.

There is no field carry-forward.

Example:

```text
finish A has usage
finish B omits usage
→ final usage missing / normalized zero
```

### 14.3 `error`

CommandCode:

```text
type = "error"
```

fails the attempt.

If:

```text
event.isRetryable === true
```

the attempt may retry if budget allows.

Otherwise failure is non-retryable.

No committed result exists.

### 14.4 `abort`

CommandCode:

```text
type = "abort"
```

means upstream abandoned the response.

Handling:

```text
discard staging
cancel reader
non-retryable Provider failure
```

Pi classification:

```text
error
```

unless caller signal independently establishes cancellation provenance.

Wire abort is not caller cancellation.

---

## 15. EOF and Commit

Commit is governed by physical EOF.

### 15.1 EOF without finish

```text
physical EOF
+
no finish
→ retryable transport truncation
```

If open blocks also exist:

```text
no-finish transport classification wins
```

No auto-completion.

### 15.2 Finish + open block + EOF

```text
finish exists
+
open Text / Reasoning / Tool slot
+
EOF
→ INVALID_BLOCK_LIFECYCLE
→ non-retryable protocol error
```

Do not:

```text
auto-close Text
auto-close Reasoning
omit incomplete Tool and succeed
```

### 15.3 `pause_turn`

At final EOF:

```text
effectiveRawReason =
finish.rawFinishReason
??
finish.finishReason
```

If:

```text
pause_turn
```

then:

```text
rollback
non-retryable failure
no continuation
no Pi semantic output
```

### 15.4 Commit condition

A response commits only when:

```text
physical EOF
+
final finish exists
+
all content slots closed
+
no wire abort
+
no stream error
+
no protocol violation
+
not pause_turn
```

Only then construct successful `CommandCodeResult`.

---

## 16. CommandCodeResult

```text
CommandCodeResult
├── content[]
│   ├── Text
│   ├── Reasoning
│   └── ToolUse
├── finish
├── rawUsage?
├── normalizedUsage
├── systemPromptTokens?
└── diagnostics?
```

This is concrete committed CommandCode state.

It is not Generic LuckyToken IR.

It dies after Pi semantic conversion.

---

## 17. Retry Isolation

Retryable failed response attempt:

```text
discard complete ResponseState
→ retry delay
→ fresh HTTP attempt
```

Fresh:

```text
span
traceparent
timeout
Request
Response
reader
decoder
line buffer
assembler
```

No failed semantic state survives.

---

# Stage B — CommandCodeResult → Pi AssistantMessage

## 18. Conversion Order

Only committed `CommandCodeResult` enters Stage B.

Order is fixed:

```text
CommandCodeResult
        ↓
Finish Conversion
        ↓
Usage Conversion
        ↓
Content Conversion
        ↓
Final AssistantMessage
```

Usage intentionally precedes content.

---

## 19. Finish Conversion

### 19.1 Pi stopReason

```text
finishReason == "tool-calls"
→ toolUse

finishReason == "length"
→ length

everything else
→ stop
```

Unknown future finish-reason strings:

```text
→ stop
```

Unknown finish reason is not an unknown event type.

### 19.2 Raw stop reason

```text
rawStopReason =
finish.rawFinishReason
??
finish.finishReason
```

when available.

Diagnostic only.

---

## 20. Usage Conversion

Pi usage structure:

```text
Usage
├── input
├── cacheRead
├── cacheWrite
├── output
├── reasoning?
├── totalTokens
└── cost
```

Cached input must not be double counted.

---

## 21. Input Usage Partition

```text
Input Accounting
│
├── noCacheTokens?
├── cacheReadTokens
├── cacheWriteTokens
└── inputTokens?
```

### 21.1 Cache read/write

```text
cacheRead =
rawUsage?.inputTokenDetails?.cacheReadTokens
??
normalizedUsage.cacheReadTokens
```

```text
cacheWrite =
rawUsage?.inputTokenDetails?.cacheWriteTokens
??
normalizedUsage.cacheWriteTokens
```

Present values must be:

```text
finite
integer
>= 0
```

otherwise usage conversion fails.

### 21.2 `noCacheTokens`

If explicitly present:

```text
finite
integer
>= 0
```

then:

```text
usage.input = noCacheTokens
```

subject to consistency rules.

### 21.3 Explicit partition consistency

When raw upstream explicitly provides all:

```text
inputTokens
noCacheTokens
cacheReadTokens
cacheWriteTokens
```

require:

```text
inputTokens
===
noCacheTokens
+ cacheReadTokens
+ cacheWriteTokens
```

Mismatch:

```text
→ usage conversion error
→ trustworthyUsage unavailable
```

If raw `inputTokens` is absent, do not compare partition values against normalized zero.

### 21.4 Fallback without `noCacheTokens`

```text
totalInput =
rawUsage?.inputTokens
??
normalizedUsage.inputTokens
```

Require:

```text
totalInput >= cacheRead + cacheWrite
```

Then:

```text
usage.input =
totalInput
- cacheRead
- cacheWrite
```

No silent clamp to zero.

---

## 22. Output and Reasoning Usage

### 22.1 Output

```text
usage.output =
rawUsage?.outputTokens
??
normalizedUsage.outputTokens
```

Present value must be:

```text
finite
integer
>= 0
```

### 22.2 Reasoning

Candidate:

```text
rawUsage?.outputTokenDetails?.reasoningTokens
??
rawUsage?.reasoningTokens
```

Absent:

```text
→ omit usage.reasoning
```

Present require:

```text
finite
integer
>= 0
reasoning <= usage.output
```

Reasoning is already included in output.

---

## 23. Total Tokens

Compute:

```text
usage.totalTokens =
usage.input
+ usage.cacheRead
+ usage.cacheWrite
+ usage.output
```

Do not blindly copy upstream totalTokens.

Raw totals may remain diagnostic evidence.

---

## 24. Pricing

Pricing belongs to response-lifetime authority:

```text
capturedPricingBasis
→ cost calculation
```

After usage categories are valid:

```text
usage categories
        ↓
pricingModelSnapshot / capturedPricingBasis
        ↓
calculateCost(...)
        ↓
usage.cost
```

Do not calculate current-invocation cost from callback-visible mutable `model`.

Required invariants:

```text
original model.cost = X

onPayload mutates model.cost = Y
→ final cost uses X
```

```text
original model.cost = X

onResponse mutates model.cost = Y
→ final cost uses X
```

Nested:

```text
model.cost.tiers
```

mutations likewise must not affect current invocation.

---

## 25. `trustworthyUsage`

Only successful:

```text
CommandCode accounting
→ Pi token partition
→ pre-hook pricing authority
→ Pi Usage
```

creates:

```text
trustworthyUsage
```

A committed CommandCode response alone is insufficient.

---

## 26. `systemPromptTokens`

CommandCode:

```text
systemPromptTokens
```

has no dedicated Pi usage category.

Keep as diagnostic information only.

Do not add it again to Pi input.

---

## 27. Content Conversion

Committed order is preserved:

```text
CommandCode Content
│
├── Text
│   → Pi TextContent
│
├── Reasoning
│   → Pi ThinkingContent
│
└── ToolUse
    → Pi ToolCall
```

No reordering by content kind.

---

## 28. Text

```text
CommandCode:
{ type:"text", text }

→

Pi:
{ type:"text", text }
```

No signature is invented.

---

## 29. Reasoning

```text
CommandCode:
{ type:"reasoning", text }

→

Pi:
{ type:"thinking", thinking:text }
```

Do not invent:

```text
thinkingSignature
redacted
```

---

## 30. ToolUse

```text
CommandCode ToolUse
├── id
├── toolName
└── input: unknown
        │
        ▼
Pi ToolCall
├── id
├── name
└── arguments
```

Mapping:

```text
id       → id
toolName → name
input    → arguments
```

### 30.1 Pi representability

Require final input:

```text
non-null
non-array
object
```

Otherwise:

```text
→ Pi content conversion error
```

Ignored preview data is not used to repair invalid final input.

### 30.2 Unsupported execution semantics

Do not invent Pi execution semantics based on unfamiliar upstream fields.

Only explicit committed CommandCode semantics establishing unrepresentable execution ownership may cause failure.

Response-side raw `tool-result` remains independently ignored.

---

## 31. Stage B Failure Matrix

```text
CommandCode not committed
→ usage unavailable
→ failure usage = zero
```

```text
CommandCode committed
+
usage conversion fails
→ trustworthyUsage unavailable
→ failure usage = zero
```

```text
CommandCode committed
+
usage conversion succeeds
+
content conversion fails
→ content = []
→ usage = trustworthyUsage
→ stopReason = error
```

```text
usage succeeds
+
content succeeds
→ normal AssistantMessage
```

No partial content survives content-conversion failure.

---

## 32. Final AssistantMessage

Success/failure identity uses response-lifetime captured facts:

```text
AssistantMessage
├── role = assistant
├── content
├── api = invokedApi
├── provider = invokedProvider
├── model = invokedModelId
├── usage
├── stopReason
├── rawStopReason?
└── timestamp = responseTimestamp
```

Do not reread callback-mutated model identity.

---

# Stage C — Pi Event Replay

## 33. Replay Boundary

Replay begins only after complete Stage B semantic conversion.

Replay understands:

```text
Pi AssistantMessage
```

not CommandCode wire events.

Immediately before first Pi semantic event:

```text
re-check caller AbortSignal
```

If already aborted:

```text
→ Pi aborted
→ no start/content replay
```

---

## 34. Replay Lifecycle

```text
Pi Replay
│
├── Start
│
├── Content
│   ├── Text
│   ├── Thinking
│   └── ToolCall
│
└── Terminal
    ├── done
    └── error
```

---

## 35. Start

After Stage B succeeds:

```text
push(start)
```

No `start` event is emitted during:

```text
request conversion
retry
CommandCode buffering
Stage A
Stage B
```

---

## 36. Text Replay

For each Pi TextContent:

```text
text_start
→ text_delta(full text)
→ text_end(full text)
```

One full delta is sufficient.

---

## 37. Thinking Replay

For each Pi ThinkingContent:

```text
thinking_start
→ thinking_delta(full thinking)
→ thinking_end(full thinking)
```

---

## 38. ToolCall Replay

Minimal valid lifecycle:

```text
toolcall_start
→ toolcall_end
```

Zero:

```text
toolcall_delta
```

events are legal.

Do not reconstruct CommandCode preview deltas.

---

## 39. `contentIndex`

For every replayed block:

```text
contentIndex =
index in final AssistantMessage.content
```

The value remains stable for that block lifecycle.

---

## 40. Success Terminal

Emit exact Pi shape:

```ts
stream.push({
  type: "done",
  reason: finalMessage.stopReason,
  message: finalMessage,
});
```

Implementation must first narrow `finalMessage.stopReason` to a legal successful reason.

`push(done)` is:

```text
semantic terminal
+
EventStream result terminal
```

---

## 41. Failure Terminal

Emit exact Pi error shape:

```ts
stream.push({
  type: "error",
  reason: failureMessage.stopReason,
  error: failureMessage,
});
```

where reason is:

```text
error
or
aborted
```

`push(error)` resolves EventStream result with the failure message.

---

## 42. `stream.end()`

After `done` or `error`:

```text
stream.end()
```

may close the generic stream container.

It is not:

```text
another semantic terminal
another result commit
another AssistantMessage
```

---

## 43. Async Exception Boundary

Before terminal:

```text
unexpected failure
├── caller signal aborted
│   → aborted
└── otherwise
    → error
```

After terminal:

```text
late rejection
→ observe safely
→ no state mutation
→ no second terminal
```

---

## 44. Response-Lifetime Authority Death

After:

```text
usage conversion
content conversion / failure normalization
final AssistantMessage construction
terminal processing
```

the following may die:

```text
capturedPricingBasis
invokedApi
invokedProvider
invokedModelId
responseTimestamp
```

Their lifetime extends beyond request-wire validation because Stage B and terminal processing still consume them.

---

# Part IV — Verification

Verification mirrors the contract hierarchy.

```text
Verification
│
├── Request Conversion
│   ├── Invocation Authority
│   ├── CommandCode Request
│   ├── Messages / Tool Turns
│   ├── Tools / Reasoning
│   ├── onPayload Boundary
│   └── Prepared Request
│
├── Provider Runtime
│   ├── Fetch
│   ├── Cancellation
│   ├── Timeout
│   ├── onResponse
│   ├── Retry
│   └── Trace / Attempt Isolation
│
├── Response Reconstruction
│   ├── JSONL Decoder
│   ├── Event Classification
│   ├── Text Slot
│   ├── Reasoning Slot
│   ├── Tool Slot
│   └── Commit / EOF / Atomic Retry
│
├── Pi Semantic Conversion
│   ├── Finish
│   ├── Usage
│   ├── Pricing
│   └── Content
│
└── Pi Replay
    ├── Content Lifecycles
    └── Terminal
```

---

## 1. Request — Authority Tests

### 1.1 Config aliasing

```text
authoritativeConfig.workingDir = "/A"

callback-visible config = "/A"

onPayload:
payload.config.workingDir = "/B"

→ authoritativeConfig remains "/A"
→ serialized body contains "/B"
→ wire validation rejects
```

### 1.2 Model identity mutation

```text
captured invokedModelId = model-a

onPayload:
payload.params.model = model-b
model.id = model-b

→ validation compares against model-a
→ reject
```

### 1.3 Pricing mutation through `onPayload`

```text
original model.cost = X

onPayload mutates model.cost = Y

→ final cost uses X
```

### 1.4 Pricing mutation through `onResponse`

```text
original model.cost = X

onResponse mutates model.cost = Y

→ final cost uses X
```

### 1.5 Pricing tier mutation

```text
original model.cost.tiers = T1

hook mutates model.cost.tiers = T2

→ current invocation uses T1
```

---

## 2. Request — Session / Project / Headers

### 2.1 Session

```text
valid caller UUID
→ preserved

missing sessionId
→ generated UUID

invalid sessionId
→ generated UUID

threadId
===
x-session-id
```

### 2.2 Project boundary

```text
existing projectDir
→ project-bound

nonexistent non-empty projectDir
→ still project-bound

missing projectDir
→ project-less

no process.cwd fallback

Project Snapshot called once

snapshot completed before onPayload authority capture
```

Detailed Project Snapshot algorithm tests belong to the Project Snapshot capability / CommandCode v1.3 §4 tests.

### 2.3 Headers

Verify:

```text
case-insensitive names
null suppression

reserved override rejected/ignored
in all casings

Authorization from resolved apiKey only

caller Authorization
→ not auth authority

OAuth headers
→ absent

x-oss-primary-provider
→ only bound config source

x-cmd-zdr
→ "1"
```

### 2.4 Runtime information-source closure

Verify Provider request semantics do not read undeclared sources.

Examples:

```text
no raw downstream client request dependency
no global RequestContext bag
no CredentialStore semantic reads
no agent-session semantic reads
no client-render-state dependency
no process.cwd project fallback
no ambient trace outside bound Trace Context capability
```

---

## 3. Request — Message and Continuity Tests

### 3.1 User image capability

```text
ImageContent
+
selected model supports image
→ CommandCode image content
```

```text
ImageContent
+
selected model does not support image
→ Pi error
```

### 3.2 Same-target text continuity

```text
same-target TextContent
+
no textSignature
→ convert
```

```text
same-target TextContent
+
non-empty textSignature
→ Pi error
```

Foreign text signature:

```text
→ discard signature
→ preserve visible text
```

### 3.3 Same-target thinking continuity

```text
same-target visible ThinkingContent
+
no signature
→ CommandCode reasoning
```

```text
same-target visible ThinkingContent
+
non-empty thinkingSignature
→ Pi error
```

```text
same-target redacted thinking
→ Pi error
```

Foreign:

```text
redacted
→ omit

visible
→ reasoning

signature
→ discard
```

---

## 4. Request — Reasoning Tests

Default mapping:

```text
minimal → low
low     → low
medium  → medium
high    → high
```

Non-reasoning model:

```text
model.reasoning = false
+
requested high
→ effective off
→ omit reasoning_effort
```

Explicit mapping:

```text
explicit xhigh mapping
→ xhigh may appear in captured supported set
```

```text
explicit max mapping
→ max may appear in captured supported set
```

Ordinary unsupported high-level request:

```text
requested xhigh
+
no explicit xhigh/max support
+
high is supported
        ↓
clampThinkingLevel(...)
        ↓
effective high
        ↓
reasoning_effort = high
```

Likewise, an unsupported requested level MUST follow Pi nearest-supported clamping semantics rather than fail merely because the original requested level lacked explicit support.

Defensive impossible/configuration case:

```text
supported-level derivation yields xhigh/max
+
corresponding explicit mapping is absent
→ defensive configuration error
```

Another defensive case:

```text
getSupportedThinkingLevels() returns level
+
thinkingLevelMap[level] === null
→ defensive configuration error
```

Post-callback capability:

```text
onPayload sets xhigh
+
xhigh not in captured supportedCommandCodeEfforts
→ reject
```

Mutation isolation:

```text
callback mutates model.reasoning
or thinkingLevelMap
→ captured supported set unchanged
```

---

## 5. Request — Tool Definition Tests

```text
constrainedSampling absent
→ ordinary WireTool

false
→ ordinary WireTool

json_schema strict=prefer
→ ordinary non-strict WireTool

json_schema strict=require
→ Pi error

grammar
→ ordinary WireTool
→ no grammar wire fields
```

---

## 6. Request — Assistant Tool Turn Tests

Legal:

```text
assistant(A)
→ tool(A)
```

```text
assistant(A,B)
→ tool(A)
→ tool(B)
```

```text
assistant(A,B)
→ grouped tool(A,B)
```

Missing result:

```text
assistant(A,B)
→ real tool(A)
→ synthetic B
```

Invalid:

```text
assistant(A,A)
→ Pi error
```

```text
orphan ToolResult
→ Pi error
```

```text
duplicate ToolResult
→ Pi error
```

### 6.1 ToolResult mapping

Success:

```text
ToolResult.isError = false
→ output.type = text
```

Error:

```text
ToolResult.isError = true
→ output.type = error-text
```

Text content order:

```text
TextContent[]
→ join with "\n"
```

Image:

```text
ToolResult contains ImageContent
→ Pi error
```

Post-`onPayload` validation must repeat the relevant structural relationship checks.

---

## 7. Request — `onPayload` Tests

```text
callback absent
→ one serialization
```

```text
callback returns undefined
→ callback-visible object used
```

```text
callback returns replacement
→ replacement used
```

```text
retries
→ callback called only once
```

Allowed semantic changes when final request remains valid:

```text
system
messages
tools
max_tokens
temperature
reasoning_effort
mode
```

Rejected changes:

```text
threadId
model
permissionMode
config
stream=false
unsupported reasoning effort
```

### 7.1 Mode validation

```text
mode absent
→ valid
```

```text
mode = arbitrary non-empty string
→ valid
```

```text
mode = ""
→ reject
```

```text
mode = non-string
→ reject
```

---

## 8. Request — Serialized Semantics Tests

Root custom `toJSON()`:

```text
object validates pre-serialization
toJSON changes threadId
→ parsed wire validation rejects
```

Nested `toJSON()`:

```text
params.stream=true in object
nested serializer produces false
→ reject
```

Undefined removal:

```text
required field omitted by JSON serialization
→ reject
```

Verify:

```text
JSON.stringify
→ exactly once
```

and:

```text
bodyText
→ byte-for-byte stable across retries
```

---

## 9. Request — `onPayload` Cancellation Tests

```text
onPayload never settles
caller aborts
→ stop waiting
→ no serialization
→ no HTTP
```

Later callback rejection:

```text
→ observed
→ no unhandled rejection
```

---

## 10. Provider Runtime — Fetch and Execution Controls

### 10.1 Custom fetch

```text
options.fetch supplied
→ exact supplied implementation used
```

```text
options.fetch absent
+
boundDefaultFetch present
→ bound default used
```

```text
neither supplied
→ globalThis.fetch
```

All retries use the same resolved `fetchImpl`.

### 10.2 `timeoutMs`

Valid:

```text
undefined
1
2_147_483_647
```

Invalid:

```text
0
-1
1.5
NaN
Infinity
2_147_483_648
```

### 10.3 `maxRetryDelayMs`

```text
undefined
→ 60_000

0
→ no server-delay cap

positive safe integer <= max
→ valid
```

Reject:

```text
negative
fractional
NaN
Infinity
too large
```

### 10.4 `maxRetries`

Require:

```text
safe integer
>= 0
```

---

## 11. Provider Runtime — Cancellation Tests

```text
signal aborted before producer work
→ no project work
→ no onPayload
→ no HTTP
```

```text
abort during Project Snapshot
→ no HTTP
```

```text
abort after snapshot before onPayload
→ no onPayload
→ no HTTP
```

```text
abort during onPayload
→ stop waiting
→ no serialization
→ no HTTP
```

```text
abort after onPayload before attempt
→ no HTTP
```

```text
abort during fetch
→ Pi aborted
```

```text
abort during onResponse
→ stop waiting
→ cancel response body
```

```text
abort during body
→ discard staging
```

```text
abort during retry delay
→ no next attempt
```

Required:

```text
observed caller cancellation before first HTTP
→ fetch call count = 0
```

---

## 12. Provider Runtime — Attempt / `onResponse` Tests

### 12.1 Timeout

```text
fetch never resolves
→ timeout
```

```text
headers arrive
body stalls
→ same attempt timeout
```

```text
body streams beyond timeout
→ timeout
```

```text
onResponse never settles
→ timeout
→ cancel body
→ no body consumption
```

Timeout is not limited to response headers.

### 12.2 `onResponse` invocation count

```text
one physical HTTP Response
→ onResponse exactly once
```

Retry:

```text
Response attempt 1
→ onResponse once

Response attempt 2
→ onResponse once
```

There is no logical-invocation-only `onResponse` call.

### 12.3 `onResponse` callback rejection

```text
onResponse rejects before timeout/cancellation
→ Provider failure
→ not automatically retryable
```

---

## 13. Provider Runtime — Retry Delay Tests

Priority:

```text
retry-after-ms
→ retry-after
→ fallback
```

Cases:

```text
retry-after-ms = 1500
→ 1500 ms
```

```text
retry-after-ms malformed
retry-after = 2
→ 2000 ms
```

```text
retry-after-ms malformed
retry-after = future HTTP date
→ date-based delay
```

```text
both malformed
→ fallback backoff
```

```text
retry-after = -1
→ unusable
→ fallback
```

```text
expired HTTP date
→ 0
```

```text
valid parsed delay > configured cap
→ Provider execution failure
```

```text
valid parsed delay exceeds timer domain
→ Provider execution failure
```

---

## 14. Provider Runtime — Retry Isolation Tests

Across retries verify stable:

```text
url
bodyText
baseHeaders
fetchImpl
logical traceId
```

Fresh:

```text
spanId
traceparent
timeout scope
Request
Response
reader
decoder
assembler
```

Retry MUST NOT reread callback-visible model/payload to reconstruct request semantics.

---

## 15. Response Reconstruction — JSONL Decoder Tests

```text
event split across chunks
UTF-8 codepoint split
multiple lines in one chunk
CRLF
empty line
final line without LF
non-JSON
non-event JSON
[DONE]
```

---

## 16. Response Reconstruction — Event Classification Tests

Known ignored events:

```text
start
start-step
provider-metadata
finish-step
response-side tool-result
```

must:

```text
→ be recognized
→ produce no Pi semantic content
→ not be treated as unknown events
```

Unknown event:

```text
→ non-retryable protocol error
```

Stream error:

```text
type = error
isRetryable = true
→ retryable if budget permits
```

```text
type = error
isRetryable != true
→ non-retryable
```

Wire abort:

```text
→ non-retryable Provider failure
→ Pi error unless caller cancellation independently applies
```

---

## 17. Response Reconstruction — Text / Reasoning Slot Tests

For both Text and Reasoning:

```text
start
→ delta*
→ end
→ valid
```

Invalid:

```text
delta without start
end without start
duplicate start
mutation after end
empty completed content
```

---

## 18. Response Reconstruction — Tool Slot Tests

Valid:

```text
tool-input-start
→ delta*
→ input-end
→ tool-call
```

Invalid:

```text
delta without start
end without start
repeated input-end
tool-call without start
tool-call before input-end
tool-call after close
```

Authority:

```text
start name = A
final name = B
→ final B
```

Input:

```text
event.input
??
event.args
??
{}
```

Preview content never repairs final input.

---

## 19. Response Reconstruction — Finish / EOF / Atomic Retry Tests

```text
finish
→ continue reading
```

```text
finish + EOF + all slots closed
→ commit
```

```text
finish A + finish B
→ B fully replaces A
```

```text
A has usage
B omits usage
→ final usage missing/zero
```

```text
EOF without finish
→ retryable truncation
```

```text
EOF without finish + open block
→ retryable truncation
```

```text
finish + open Text
→ protocol error
```

```text
finish + open Reasoning
→ protocol error
```

```text
finish + open Tool
→ protocol error
```

```text
pause_turn
→ rollback / non-retryable failure
```

```text
wire abort
→ rollback / error
```

### 19.1 Atomic retry

For any retryable pre-commit failure:

```text
attempt 1 produces provisional CommandCode content
→ attempt 1 fails retryably
→ provisional state discarded
→ zero Pi semantic content emitted
→ attempt 2 begins with fresh assembler
```

If later attempt succeeds:

```text
only successful committed attempt
→ enters Stage B
→ enters Pi replay
```

No content from failed attempts may leak into:

```text
Pi start
Pi content events
final AssistantMessage
```

---

## 20. Pi Semantic Conversion — Usage Tests

Cover:

```text
inputTokens only
inputTokens + cacheRead
inputTokens + cacheWrite
inputTokens + cacheRead + cacheWrite

noCacheTokens
explicit noCache partition
```

Consistency:

```text
inputTokens
=
noCacheTokens
+ cacheReadTokens
+ cacheWriteTokens
```

Mismatch:

```text
→ usage conversion error
```

Partial evidence:

```text
no raw inputTokens
+
partition fields
→ no false comparison with normalized zero
```

Reasoning:

```text
reasoning <= output
→ valid

reasoning > output
→ error
```

Completely missing final usage:

```text
→ CommandCode normalized usage is zero
→ Pi usage categories resolve to zero
→ no invented token accounting
```

If usage conversion itself cannot establish trustworthy Pi usage:

```text
→ trustworthyUsage unavailable
→ failure usage = zero
```

---

## 21. Pi Semantic Conversion — Pricing Authority Tests

```text
model.cost = X

onPayload mutates model.cost = Y

→ final cost uses X
```

```text
model.cost = X

onResponse mutates model.cost = Y

→ final cost uses X
```

```text
cost.tiers = T1

hook mutates tiers = T2

→ final pricing uses T1
```

---

## 22. Pi Semantic Conversion — Failure Accounting Tests

```text
request failure
→ zero usage
```

```text
transport failure
→ zero usage
```

```text
CommandCode commit
+
usage conversion failure
→ zero usage
```

```text
CommandCode commit
+
usage succeeds
+
content conversion fails
→ content=[]
→ preserve trustworthyUsage
→ Pi error
```

---

## 23. Pi Replay Tests

Verify:

```text
start emitted first
```

Text:

```text
text_start
→ text_delta
→ text_end
```

Thinking:

```text
thinking_start
→ thinking_delta
→ thinking_end
```

Tool:

```text
toolcall_start
→ toolcall_end
```

with zero deltas valid.

Verify stable `contentIndex`.

---

## 24. Terminal Tests

Success exact shape:

```text
{
  type: "done",
  reason,
  message
}
```

Failure exact shape:

```text
{
  type: "error",
  reason,
  error
}
```

Verify:

```text
push(done/error)
→ EventStream result resolves
```

```text
stream.end()
→ no second semantic/result commit
```

---

# Final Freeze Gate

```text
LuckyToken CommandCode Private Provider Conversion v0.20
│
├── Architecture
│   ├── exactly two semantic directions
│   ├── no Generic Provider IR
│   └── no live cross-protocol streaming translation
│
├── Runtime Information Closure
│   ├── Pi invocation inputs
│   ├── explicit bound dependencies
│   ├── owned/derived request-local state
│   └── no undeclared fourth source
│
├── Request
│   ├── Pi invocation hierarchy preserved
│   ├── CommandCode request hierarchy preserved
│   ├── messages/tools remain naturally nested
│   ├── Assistant Tool Turn remains one relationship unit
│   ├── reasoning capability has one authority chain
│   └── onPayload is one explicit untrusted boundary
│       ├── formal mutation surface
│       └── Provider authority remains immutable
│
├── Authority
│   ├── response-lifetime authority
│   │   └── survives to Pi terminal
│   └── request-validation authority
│       └── dies after wire validation
│
├── Prepared Request
│   ├── concrete wire state only
│   └── separate from execution controls
│
├── Execution
│   ├── custom fetch honored
│   ├── stable semantic/wire request
│   ├── fresh physical attempt state
│   ├── per-attempt timeout
│   ├── onResponse exactly once per physical Response
│   ├── deterministic retry delay
│   └── caller cancellation authoritative
│
├── Response Stage A
│   ├── bare JSONL
│   ├── ID-indexed ordered assembler
│   ├── strict content lifecycles
│   ├── known ignored vs unknown explicit
│   ├── finish is candidate only
│   ├── physical EOF required for commit
│   └── atomic retry leaks no Pi semantics
│
├── Response Stage B
│   ├── finish
│   ├── usage
│   │   ├── missing usage → zero
│   │   └── cache partition consistency
│   ├── pricing
│   ├── content
│   └── late failure accounting
│
├── Response Stage C
│   ├── legal Pi content lifecycle
│   ├── stable contentIndex
│   ├── exact done/error shapes
│   └── end() is container closure only
│
└── Documentation Structure
    ├── hierarchy mirrors semantic hierarchy
    ├── ownership is colocated with owned information
    ├── lifecycle is colocated with state
    ├── tests mirror the complete contract
    └── documentation hierarchy introduces no new runtime abstraction
```

---

# Final Information Topology

```text
LuckyToken CommandCode Private Provider
│
├── Foundations
│   ├── Source Basis
│   ├── Runtime Information Closure
│   ├── Global Invariants
│   └── Authority Hierarchy
│
├── Request
│   │
│   ├── Pi Invocation
│   │   ├── Model
│   │   ├── Context
│   │   │   ├── Messages
│   │   │   └── Tools
│   │   └── Options
│   │
│   ├── Provider Authority
│   │   ├── Response-Lifetime
│   │   └── Request-Validation
│   │
│   ├── CommandCode Request
│   │   ├── Endpoint
│   │   ├── Headers
│   │   └── GenerateRequest
│   │       ├── Config
│   │       └── Params
│   │           ├── Generation
│   │           ├── Messages
│   │           └── Tools
│   │
│   ├── onPayload Boundary
│   │   ├── Capture
│   │   ├── Isolation
│   │   ├── Callback
│   │   │   └── Mutation Surface
│   │   ├── Serialization
│   │   └── Validation
│   │
│   ├── Prepared Wire Request
│   │
│   └── Execution
│       ├── Controls
│       ├── Fetch
│       ├── Attempt
│       │   └── onResponse
│       ├── Retry
│       └── Cancellation
│
└── Response
    │
    ├── Stage A — Reconstruction
    │   ├── HTTP
    │   ├── Physical JSONL Stream
    │   ├── Event Model
    │   ├── Atomic Assembler
    │   │   ├── TextSlot
    │   │   ├── ReasoningSlot
    │   │   └── ToolSlot
    │   └── Commit
    │
    ├── Stage B — Semantic Conversion
    │   ├── Finish
    │   ├── Usage
    │   │   ├── Input Partition
    │   │   ├── Output / Reasoning
    │   │   └── Pricing
    │   ├── Content
    │   └── Failure Accounting
    │
    └── Stage C — Pi Replay
        ├── Start
        ├── Content
        │   ├── Text
        │   ├── Thinking
        │   └── ToolCall
        └── Terminal
            ├── done
            ├── error
            └── end()
```

---

# Post-Freeze Governance

v0.20 closes the v0.19 structure-refactor parity issues.

Its architecture remains the frozen v0.18 architecture.

From this point:

```text
test failure
→ implementation defect

race / cleanup bug
→ implementation defect

helper awkwardness
→ implementation issue

implementation diverges from contract
→ implementation defect

new pinned source contradicts exact contract
→ reopen only affected contract

new CommandCode/Pi capability
→ explicit capability-change review

desire for Manager / Generic IR convenience
→ not a reopen reason

desire to flatten hierarchical concepts
→ not a simplification
```

---

# Final Principle

The Provider remains:

```text
Pi
→ concrete CommandCode request

atomic CommandCode result
→ Pi
```

The specification mirrors the real information hierarchy:

```text
parent concept
→ child structures
→ owned facts
→ lifecycle
→ invariants
→ verification
```

without inventing additional semantic models.

**This document is the frozen, structurally organized implementation specification for the LuckyToken CommandCode Private Provider.**