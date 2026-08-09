# LuckyToken CommandCode Private Provider Conversion Method

**File:** `LuckyToken CommandCode Private Provider Conversion Method v0.9.1.md`  
**Version:** 0.9.1  
**Status:** FROZEN  
**Revision Type:** Contract Closure / Pi Runtime Boundary Sync  
**Boundary:** Pi Runtime Contracts ↔ CommandCode Private Protocol  
**Provider:** CommandCode Private Provider  
**Upstream Path:** `POST /alpha/generate`

## Source Provenance

```text
LuckyToken Documentation Basis
→ main @ f65b5c8f54516317fd911308b636f0402a17217a

Pi Protocol Document Basis
→ doc/Protocols/Pi AI IR Protocol.md
→ Version 0.9.2
→ document @ f65b5c8

Pi Runtime Source Basis
→ pi-agent/packages/ai
→ commit eb3c46d6ce28cb87147bb0d05645ebae28524713
→ @earendil-works/pi-ai 0.84.1

CommandCode Protocol Basis
→ doc/Protocols/commandcode private protocol.md
→ Version 0.2

LuckyToken Core Basis
→ doc/Spec/LuckyTokenCoreSpec.md
→ Version 5.5
```

The documentation commit and the Pi runtime source commit are deliberately recorded separately.

`f65b5c8` rewrites the complete Pi AI IR Protocol document.

The Pi protocol itself pins its runtime extraction to:

```text
eb3c46d
@earendil-works/pi-ai 0.84.1
```

These provenance facts must not be collapsed into one source SHA.

---

# 1. Scope and Boundary

## 1.1 Purpose

This specification defines the conversion performed by the LuckyToken **CommandCode Private Provider**.

The Provider is a LuckyToken-owned concrete Pi `Provider` integration.

Request-side boundary:

```text
Pi Runtime
│
├── Model<Api>
├── Context
└── Provider-facing SimpleStreamOptions
        │
        ▼
CommandCode Private Provider
        │
        ├── Pi → CommandCode conversion
        ├── request-local runtime/project derivation
        ├── CommandCode request construction
        └── upstream execution
        │
        ▼
CommandCode Private Protocol
```

Response-side boundary:

```text
CommandCode HTTP Event-Stream
        │
        ▼
Framing Decoder
        │
        ▼
CommandCode semantic event objects
        │
        ▼
CommandCode Private Provider
        │
        ├── lifecycle interpretation
        ├── request-local temporary state
        └── CommandCode → Pi conversion
        │
        ▼
AssistantMessageEventStream
```

This document defines:

```text
1. Pi Provider invocation
   → CommandCode Private request

2. CommandCode physical stream framing
   → CommandCode semantic event objects

3. CommandCode semantic events
   → Pi AssistantMessageEventStream
```

It does not define Client Protocol conversion or LuckyToken Core execution architecture.

---

## 1.2 Position in LuckyToken Core

Before this Provider is invoked:

```text
Client Protocol
      │
      ▼
Model<Api> + Context + ModelsSimpleStreamOptions
      │
      ▼
Pi Models
├── Provider lookup
├── Provider auth resolution
├── effective apiKey / headers / env
├── possible request Model.baseUrl override
└── Provider dispatch
      │
      ▼
CommandCode Private Provider
```

The concrete Provider receives Pi runtime representations.

It must not directly access:

```text
LuckyToken inbound Auth implementation
raw Client Protocol request
raw inbound client authorization headers
Pi CredentialStore
Client Protocol render state
HTTP response object
generic RequestContext
generic ApplicationContext
```

---

# 2. Pi Helper Boundary

The CommandCode Provider consumes **Pi contracts directly**.

Pi shared helpers are selectively reused only where their semantics exactly match this Provider's conversion contract.

Critical rule:

> **Pi shared normalization helpers are not an implicit middleware pipeline for CommandCode `streamSimple()`.**

Conceptually:

```text
Pi Contract
├── Model
├── Context
├── SimpleStreamOptions
└── AssistantMessageEventStream
        │
        ▼
CommandCode Provider
        │
        ├── selective helper reuse
        └── concrete conversion policy
```

Not:

```text
Pi Contract
        │
        ▼
all Pi shared helpers
        │
        ▼
CommandCode Provider
```

---

## 2.1 `buildBaseOptions()` Is Not a Preprocessing Stage

The CommandCode Provider must **not** run:

```text
SimpleStreamOptions
→ buildBaseOptions()
→ CommandCode conversion
```

as its whole-request preprocessing pipeline.

`buildBaseOptions()` is shared simplified-option behavior.

It performs behavior including:

```text
Model.samplingParams
+
options.samplingParams
→ merged samplingParams
```

and:

```text
options.maxTokens ?? model.maxTokens
→ clampMaxTokensToContext(...)
```

before returning `StreamOptions`.

Those operations are not universally required by `Provider.streamSimple()`.

For CommandCode, they would also destroy information needed by stricter LuckyToken validation.

Example:

```text
options.maxTokens = -10
model.contextWindow <= 0
```

If `buildBaseOptions()` runs first:

```text
clampMaxTokensToContext(...)
→ 1
```

The original invalid `-10` request can no longer be detected by the CommandCode conversion policy.

Therefore the required ordering is:

```text
raw Provider-facing SimpleStreamOptions
        │
        ▼
LuckyToken CommandCode validation
        │
        ▼
selective Pi helper use
```

---

## 2.2 Selective Simplified Helper Reuse

Allowed focused reuse includes:

```text
clampMaxTokensToContext(...)
→ only after CommandCode max-token validation

clampThinkingLevel(...)
→ reasoning-level resolution

parseStreamingJson(...)
→ tool-input preview parsing

calculateCost(...)
→ normalized Pi usage pricing
```

Pi retry behavior may also be extracted selectively as described later.

The Provider does not gain correctness merely by running an entire Pi helper pipeline.

---

# 3. Historical Replay Helper Boundary

## 3.1 `transformMessages()` Is Not a CommandCode Preprocessing Stage

The CommandCode Provider must **not** run:

```text
Context.messages
→ transformMessages(...)
→ convertMessages(...)
```

as its default history-conversion pipeline.

Pi `transformMessages()` is a shared historical replay normalization helper.

It is not a mandatory `Models`, `Provider`, or `ProviderStreams` stage.

Its behavior intentionally differs from CommandCode's strict conversion rules.

---

## 3.2 Why Wholesale `transformMessages()` Is Incorrect Here

The shared helper can perform:

```text
unsupported user image
→ synthesized text placeholder

unsupported tool-result image
→ synthesized text placeholder

failed AssistantMessage
→ omitted

missing ToolResult
→ synthetic ToolResult("No result provided")

cross-model signatures
→ normalized / removed according to helper policy
```

It can also leave a pre-existing `ToolResultMessage` orphaned when its failed assistant ToolCall was removed.

Therefore:

```text
transformMessages()
≠
complete conversation-validity repair
```

CommandCode conversion intentionally uses different strict behavior:

```text
unsupported image
→ Pi error

orphan ToolResult
→ Pi error

unresolved historical ToolCall
→ Pi error

same-target unrepresentable continuity
→ Pi error
```

Running `transformMessages()` first could hide or mutate precisely the state that CommandCode must validate.

---

## 3.3 CommandCode Historical Conversion Policy

Required flow:

```text
original Context.messages
        │
        ▼
CommandCode representability validation
        │
        ▼
direct Pi → CommandCode conversion
```

The implementation may inspect or extract an individual Pi helper behavior only when:

```text
that behavior
=
the explicit CommandCode conversion rule
```

No shared replay helper is adopted wholesale merely for reuse.

This preserves:

```text
history provenance
prompt-prefix stability
strict representability checks
tool relationship evidence
```

---

# 4. Provider `streamSimple()` Failure Boundary

## 4.1 Required Observable Shape

The concrete CommandCode:

```ts
provider.streamSimple(...)
```

must synchronously return:

```text
AssistantMessageEventStream
```

before expected request/runtime validation or execution work can fail.

Required conceptual implementation:

```text
provider.streamSimple(...)
        │
        ▼
create AssistantMessageEventStream
        │
        ▼
create conforming initial AssistantMessage state
        │
        ▼
start async producer work
        │
        ├── pre-abort
        ├── execution-control validation
        ├── endpoint validation
        ├── history conversion
        ├── project snapshot
        ├── request construction
        ├── transport
        └── stream conversion
        │
        ▼
return stream immediately
```

The async producer owns Provider-side failure classification.

---

## 4.2 No Expected Synchronous Runtime Failure Escape

No expected request/runtime failure may synchronously escape `streamSimple()`.

This includes:

```text
pre-aborted signal

invalid maxRetries
invalid maxRetryDelayMs
invalid timeoutMs

unsupported onPayload
unsupported deferred request

invalid model.baseUrl
missing/invalid sessionId
invalid projectDir

invalid maxTokens
invalid reasoning mapping
invalid temperature

invalid historical messages
invalid tool relationships
unsupported same-target continuity

project snapshot failure

header/auth validation failure

request establishment failure
stream/framing failure
```

They must terminate the Provider's own returned stream.

---

## 4.3 Why This Boundary Is Required

LuckyToken normally invokes the Provider through:

```text
Models.streamSimple()
        │
        ▼
outer lazyStream()
        │
        ▼
applyAuth()
        │
        ▼
provider.streamSimple(...)
```

Pi's generic lazy catch currently normalizes a caught setup rejection as:

```text
stopReason = error
error.reason = error
```

It does not inspect:

```text
signal.aborted
AbortError
signal.reason
```

Therefore:

```text
Provider pre-abort
→ synchronous throw
→ Models outer lazy catch
→ generic error
```

would lose the CommandCode Provider's intended:

```text
aborted
```

classification.

The concrete Provider therefore must produce its own pre-start error event rather than relying on the outer lazy boundary.

---

## 4.4 Pre-Start Provider Failure

A Provider failure before CommandCode semantic `start` is valid Pi runtime behavior.

Example:

```text
Provider stream exists
        │
        ▼
caller signal already aborted
        │
        ▼
Pi error(reason = aborted)
```

No Pi `start` is emitted first.

Similarly:

```text
invalid request/runtime input
→ Pi error(reason = error)
```

without a preceding Pi `start`.

---

## 4.5 Async Producer Exception Normalization

Before Pi terminal commit:

```text
async producer exception
        │
        ├── callerSignal.aborted
        │   → aborted
        │
        └── otherwise
            → error
```

must be converted into the Provider's terminal error stream state.

After Pi terminal commit:

```text
late internal rejection
→ cannot alter committed Pi result
```

The implementation should observe abandoned asynchronous work safely but must not emit a second semantic terminal.

---

# 5. Initial AssistantMessage Producer State

Pi defines the `AssistantMessage` contract but does not define a universal constructor.

The CommandCode Provider therefore owns a small conforming producer initialization policy.

Create once per Provider invocation:

```text
AssistantMessage
├── role = "assistant"
├── content = []
│
├── api = model.api
├── provider = model.provider
├── model = model.id
│
├── usage = zero Pi Usage
├── stopReason = "pending"
└── timestamp = one request-local creation timestamp
```

Zero usage:

```text
input = 0
output = 0
cacheRead = 0
cacheWrite = 0
totalTokens = 0

cost.input = 0
cost.output = 0
cost.cacheRead = 0
cost.cacheWrite = 0
cost.total = 0
```

Initially absent unless later established:

```text
responseModel
responseId
diagnostics
deferred
errorMessage
rawStopReason
endTurn
cacheWrite1h
reasoning
```

The timestamp is created once for this assistant response rather than regenerated per event.

---

# 6. Cancellation Before Upstream Execution

## 6.1 Initial Abort Check

Inside the Provider's async producer, the first runtime classification is:

```text
callerSignal.aborted?
├── yes
│   → stopReason = aborted
│   → Pi error(reason = aborted)
│   → stop
│
└── no
    → continue
```

This occurs before execution-control validation.

Therefore:

```text
signal.aborted = true
maxRetries = NaN
```

produces:

```text
aborted
```

not an invalid-retry error.

---

## 6.2 Abort During Local Preparation

Caller cancellation may occur while performing:

```text
endpoint resolution
project snapshot
semantic conversion
header preparation
```

Where a bound capability supports cancellation, propagate the caller signal.

Regardless, immediately before upstream execution:

```text
re-check callerSignal.aborted
```

If aborted:

```text
→ Pi aborted
→ no HTTP request
```

---

# 7. Execution-Control Validation

These are **LuckyToken Provider execution policies**, not universal Pi/CommandCode numeric contracts.

## 7.1 `maxRetries`

Absent:

```text
→ 0 retries after initial attempt
```

Present:

```ts
Number.isSafeInteger(maxRetries)
&& maxRetries >= 0
```

Otherwise:

```text
→ Pi error
```

No hidden implementation-specific stricter retry-count policy is permitted.

---

## 7.2 Timer Representation

For current direct timer-backed execution:

```text
MAX_TIMER_DELAY_MS = 2_147_483_647
```

Accepted timer durations must not silently overflow, truncate, wrap, or clamp.

---

## 7.3 `maxRetryDelayMs`

Absent:

```text
→ Pi-derived default cap = 60,000 ms
```

Zero:

```text
→ disable configured server-requested-delay cap
```

Non-zero:

```ts
Number.isSafeInteger(maxRetryDelayMs)
&& maxRetryDelayMs > 0
&& maxRetryDelayMs <= MAX_TIMER_DELAY_MS
```

---

## 7.4 `timeoutMs`

Absent:

```text
→ no Provider-created upstream timeout
```

Present:

```ts
Number.isSafeInteger(timeoutMs)
&& timeoutMs > 0
&& timeoutMs <= MAX_TIMER_DELAY_MS
```

`0` is invalid.

---

# 8. Effective Endpoint

## 8.1 Authority

Provider-facing:

```text
model.baseUrl
```

is the sole request-time base URL authority.

Pi auth resolution may already have replaced the catalog URL before concrete Provider dispatch.

The Provider must not overwrite it with an ambient default.

---

## 8.2 Base-Path-Preserving Join

The final endpoint is:

```text
<effective model.baseUrl>
+
alpha/generate path segment
```

Existing base paths must be preserved.

Examples:

```text
https://host
→ https://host/alpha/generate

https://host/
→ https://host/alpha/generate

https://host/proxy
→ https://host/proxy/alpha/generate

https://host/proxy/
→ https://host/proxy/alpha/generate
```

The implementation must not use root-relative URL resolution that turns:

```text
https://host/proxy/
+
/alpha/generate
```

into:

```text
https://host/alpha/generate
```

A path-preserving join is required.

---

## 8.3 Invalid Endpoint

Unusable Provider-facing `model.baseUrl`:

```text
→ Pi error
```

Not:

```text
invalid request URL
→ silent bound-default fallback
```

---

## 8.4 Endpoint Lifetime

Resolve once:

```text
One Provider Invocation
├── endpoint once
├── semantic request once
├── stable headers once
└── retry attempts
    └── same endpoint
```

---

# 9. Semantic Request Hierarchy

```text
CommandCodeRequest
│
├── mode?                 # omitted in v0.9.1
│
├── Runtime / Project Context
│   ├── config
│   ├── memory
│   ├── taste
│   ├── skills
│   ├── permissionMode
│   └── threadId
│
└── params
    ├── model
    ├── system
    ├── messages[]
    ├── tools[]
    ├── max_tokens
    ├── stream
    ├── reasoning_effort?
    └── temperature?
```

One Provider invocation constructs one semantic request.

Retries do not reconstruct it.

---

# 10. Runtime and Project Context

## 10.1 Project

Authoritative source:

```text
options.metadata.projectDir?
```

Project-bound:

```text
projectDir
→ Project Snapshot capability
→ config
```

Project snapshot failure:

```text
→ Pi error
```

No project-less fallback.

Project-less:

```text
workingDir = ""
date = current UTC YYYY-MM-DD
environment = ""
structure = []
isGitRepo = false
currentBranch = ""
mainBranch = ""
gitStatus = ""
recentCommits = []
```

No filesystem/Git scan occurs.

---

## 10.2 `memory`, `taste`, `skills`

Current compatibility policy:

```text
memory = null
taste = null
skills = null
```

---

## 10.3 `permissionMode`

Source:

```text
Provider compatibility / permission policy
→ request.permissionMode
```

The full wire value set remains open.

---

## 10.4 Session

Source:

```text
options.sessionId
```

Mapping:

```text
options.sessionId
├── request.threadId
└── x-session-id
```

Normal LuckyToken Core supplies normalized `sessionId:string`.

Missing/invalid session identity is a defensive Provider failure.

---

# 11. Invocation Controls

## 11.1 `model`

```text
model.id
→ params.model
```

---

## 11.2 `system`

```ts
params.system = context.systemPrompt ?? ""
```

---

## 11.3 `max_tokens`

Raw candidate:

```text
options.maxTokens ?? model.maxTokens
```

First apply **LuckyToken validation**:

```text
finite
positive
integer
```

Only after validation:

```text
candidate
→ clampMaxTokensToContext(model, context, candidate)
→ params.max_tokens
```

The Provider must not use `buildBaseOptions()` to pre-clamp the raw value.

---

## 11.4 `stream`

```text
params.stream = true
```

---

## 11.5 `temperature`

Present finite:

```text
→ serialize
```

Present non-finite:

```text
→ Pi error
```

Absent:

```text
explicit compatibility default
→ validate/use

otherwise
→ omit
```

---

# 12. Reasoning

Explicit request:

```text
options.reasoning
→ clampThinkingLevel(model, requested)
→ effective Pi level
```

Effective `off`:

```text
→ omit reasoning_effort
```

Other level:

```text
model.thinkingLevelMap?.[effective]
├── string → mapped value
├── null   → unsupported → Pi error
└── undefined → effective level
```

Final CommandCode value must currently be:

```text
high
max
```

---

## 12.1 Reasoning Absent

```text
options.reasoning absent
├── explicit compatibility default
│   → validate/use
└── otherwise
    → omit reasoning_effort
```

No implicit `high`.

---

# 13. Deferred Policy

Pi exposes:

```text
deferred?:
  boolean
  | { window?: "15m" | "1h" | "24h" }
```

The generic Pi protocol does not close all runtime semantics of explicit `false`.

LuckyToken v0.9.1 therefore defines its own interpretation policy:

```text
deferred absent
→ ordinary synchronous streaming request

deferred = false
→ ordinary synchronous streaming request

deferred = true
→ unsupported
→ Pi error

deferred = object
→ unsupported
→ Pi error
```

This is a **LuckyToken CommandCode Provider policy**, not a universal Pi invariant.

No deferred CommandCode semantics are invented.

---

# 14. `samplingParams`

Pi sampling merge is shared-helper behavior where the corresponding helper/adapter uses it.

It is not a mandatory Provider stage.

CommandCode v0.9.1 intentionally performs:

```text
model.samplingParams
options.samplingParams
→ not merged into CommandCode request
→ not serialized
```

This is another reason not to wholesale invoke `buildBaseOptions()`.

---

# 15. Other Unsupported Semantic Controls

```text
thinkingBudgets
→ not serialized

cacheRetention
→ not serialized

mode
→ omitted
```

`mode` remains an observed CommandCode extension whose semantics are not closed.

---

# 16. Historical Assistant Replay Eligibility

Replayable successful states:

```text
stop
length
toolUse
```

Failed historical assistant states:

```text
error
aborted
```

are omitted by CommandCode's own conversion policy.

The Provider does not use `transformMessages()` to perform this omission.

If removing a failed assistant exposes an orphan ToolResult or otherwise invalid tool history:

```text
→ Pi error
```

Incomplete:

```text
pending
deferred
→ Pi error
```

---

# 17. UserMessage Conversion

String:

```text
→ one CommandCode text block
```

TextContent:

```text
text
→ text

textSignature
→ not serialized for user content
```

ImageContent:

```text
data
→ data:<mimeType>;base64,<data>

mimeType
→ mimeType
```

If the target model cannot accept the image:

```text
→ Pi error
```

No synthesized `(image omitted...)` placeholder is introduced.

---

# 18. Assistant History Identity

Same-target means exactly:

```text
assistant.provider == model.provider
AND
assistant.api == model.api
AND
assistant.model == model.id
```

This definition is used for opaque Provider continuity decisions.

---

# 19. Same-Target Text Continuity

For same-target `TextContent`:

```text
textSignature absent
→ map text normally

textSignature = ""
→ treat as inert/empty
→ map text normally

textSignature non-empty
→ unsupported continuity
→ Pi error
```

The CommandCode request model currently has no established mapping for a non-empty Pi `textSignature`.

It must not be silently dropped from same-target replay.

---

# 20. Foreign Text Continuity

For foreign historical assistant content:

```text
TextContent.text
→ ordinary CommandCode text

textSignature
→ discard
```

Foreign provider continuity does not remain authoritative when replayed through the CommandCode target.

---

# 21. Same-Target Thinking Continuity

Same-target `ThinkingContent`:

```text
redacted = true
→ Pi error
```

For non-redacted thinking:

```text
thinkingSignature absent
→ visible reasoning may map

thinkingSignature = ""
→ inert/empty
→ visible reasoning may map

thinkingSignature non-empty
→ unsupported opaque continuity
→ Pi error
```

Then:

```text
non-empty visible thinking
→ CommandCode reasoning
```

No same-target opaque reasoning state is discarded silently.

---

# 22. Foreign Thinking

Foreign history:

```text
redacted thinking
→ omit

visible non-redacted thinking
→ ordinary CommandCode text

thinkingSignature
→ discard
```

This intentionally removes foreign provider-specific reasoning continuity.

---

# 23. Same-Target ToolCall Continuity

Basic ToolCall mapping:

```text
id
→ toolCallId

name
→ toolName

arguments
→ input
```

For same-target history:

```text
thoughtSignature absent
→ normal mapping

thoughtSignature = ""
→ inert/empty
→ normal mapping

thoughtSignature non-empty
→ unsupported opaque continuity
→ Pi error
```

`namespace` is different from an opaque signature.

Any:

```text
namespace !== undefined
```

currently means:

```text
→ Pi error
```

because CommandCode has no established namespace mapping and namespace can affect tool identity/semantics.

It is not treated as safely discardable opaque continuity.

---

# 24. Foreign ToolCall Continuity

For foreign historical ToolCalls:

```text
thoughtSignature
→ discard
```

but:

```text
namespace present
→ Pi error
```

The converter does not rely on `transformMessages()` because that helper may preserve namespace through cross-model replay.

---

# 25. ToolResult Conversion

One Pi `ToolResultMessage` remains one CommandCode tool message.

```text
toolCallId
→ toolCallId

toolName
→ toolName
```

Text blocks:

```text
join with "\n"
```

Output:

```text
isError = false
→ text

isError = true
→ error-text
```

Image:

```text
→ Pi error
```

Not serialized:

```text
addedToolNames
details
usage
timestamp
textSignature
```

---

# 26. Historical Tool Relationship Validation

Track only unresolved historical ToolCalls.

```text
ToolCall
→ unresolved relationship

matching ToolResult
→ consumes relationship
→ relationship dies
```

Requirements:

```text
ToolResult references preceding unresolved ToolCall

toolName agrees

one unresolved call cannot be consumed twice

ordinary user/assistant turn cannot cross unresolved state

history cannot end unresolved
```

No synthetic `"No result provided"` ToolResult is created.

No orphan call/result is silently removed.

---

## 26.1 Historical ID Reuse

After a relationship closes:

```text
ID leaves unresolved tracking
```

A later historical ToolCall may reuse the ID if no unresolved ambiguity exists.

Historical IDs are not conversation-global unique.

---

# 27. Tool Definitions

```text
name
→ name

description
→ description

parameters
→ input_schema
```

Constrained sampling:

```text
none
→ ordinary tool

json_schema strict=prefer
→ ordinary tool

json_schema strict=require
→ Pi error

grammar
→ ordinary-tool fallback
```

The CommandCode Provider does not wholesale apply Pi tool-constraint helper pipelines.

---

# 28. Header Construction

Stable header base:

```text
Authorization
Content-Type
x-session-id
x-project-slug? / explicit absence
x-command-code-version
compatibility-profile headers
```

Merge order:

```text
1. compatibility defaults
2. effective options.headers
3. Authorization resolution
4. structural invariants
5. Provider semantic invariants
```

Authority:

```text
compatibility defaults
<
effective caller/Pi headers
<
Provider correctness invariants
```

---

## 28.1 Authorization

Explicit non-empty string:

```text
→ use exact value
```

Empty/whitespace:

```text
→ Pi error
```

Explicit null:

```text
→ suppress generated Bearer
→ Pi error
```

Absent:

```text
apiKey exists
→ Bearer <apiKey>

apiKey absent
→ Pi error
```

Explicit null must not collapse into absence before this resolution.

---

## 28.2 Structural Header

```text
Content-Type = application/json
```

is reasserted.

---

## 28.3 Provider Semantic Headers

```text
x-session-id
→ authoritative options.sessionId

x-command-code-version
→ authoritative Provider compatibility/version policy
```

Project-bound:

```text
remove generic x-project-slug
→ set derived slug
```

Project-less:

```text
remove generic x-project-slug
→ set nothing
```

---

# 29. Attempt-Local Headers

Each transport establishment attempt receives a fresh:

```text
traceparent
```

Attempt-local construction:

```text
copy stable header base
→ remove traceparent conflicts
→ create fresh traceparent
→ set traceparent
```

The semantic request, endpoint, project snapshot and stable headers are not recomputed on retry.

---

# 30. Provider Execution Support Matrix

| Pi option | CommandCode v0.9.1 |
|---|---|
| `signal` | supported |
| `fetch` | supported |
| `onResponse` | supported |
| `onPayload` | unsupported |
| `timeoutMs` | supported |
| `maxRetries` | supported |
| `maxRetryDelayMs` | supported |
| `env` | not interpreted unless an explicit future Provider policy uses it |
| `telemetryContext` | not serialized as CommandCode semantics |
| `transport` | ignored; SSE is used |
| `websocketConnectTimeoutMs` | ignored |
| `samplingParams` | not applied |
| `deferred` absent/false | ordinary streaming |
| `deferred` true/object | unsupported |

---

# 31. `onPayload`

Pi v0.9.2 defines `onPayload` as an adapter-selected **callback-visible representation** replacement boundary.

It does not guarantee:

```text
onPayload output
=
final wire payload
```

CommandCode v0.9.1 does not define such a callback-visible request representation.

Supporting it would require:

```text
define callback-visible representation
→ invoke callback
→ accept possible replacement
→ revalidate all CommandCode Provider invariants
→ perform remaining serialization/transport work
```

Current policy:

```text
options.onPayload !== undefined
→ Pi error
```

No PayloadManager is introduced.

---

# 32. Retry Policy

Retry is Pi/LuckyToken Provider execution policy, not CommandCode protocol semantics.

Current Pi behavior may be selectively extracted for:

```text
x-should-retry

status undefined

408
409
429
5xx

retry-after-ms
retry-after

exponential fallback
```

A non-public Pi internal helper must not be imported through a brittle internal package path.

Extract the smallest coherent implementation with provenance when necessary.

---

# 33. Retry Delay Normalization

Server-requested delay parsing must never create `NaN` timer behavior.

Precedence:

```text
retry-after-ms
→ valid numeric milliseconds
→ use

otherwise retry-after
→ valid numeric seconds
→ seconds × 1000

otherwise valid HTTP date
→ date - now

otherwise
→ exponential fallback
```

Before direct scheduling:

```text
candidate
→ finite check
→ Math.ceil(candidate)
→ max(0, candidate)
→ integer milliseconds
```

The server-requested cap applies after normalization.

Timer representability still applies when the configured cap is disabled.

---

# 34. Establishment Error Adapter

Retry-classifier-compatible establishment errors contain physically present:

```text
status
headers
```

properties.

Conceptually:

```ts
interface RetryCompatibleEstablishmentError extends Error {
  status: number | undefined;
  headers: Headers | undefined;
}
```

Network failure:

```text
status = undefined
headers = undefined
```

with both properties present.

Non-adoptable response:

```text
status = response.status
headers = response.headers
```

This is transport execution state, not semantic IR.

---

# 35. Response Establishment and Candidate Cleanup

```text
establishResponse()
├── use stable endpoint
├── use stable semantic body
├── create attempt-local headers
├── execute request
├── evaluate adoption
│
├── adoptable
│   → return response
│
└── non-adoptable
    → cancel/close candidate body
    → await cleanup
    → normalize establishment failure
    → retry classifier may run
```

A new retry attempt cannot begin while the previous candidate body remains live.

Candidate cleanup failure:

```text
→ Pi error
→ no further retry
```

`onResponse` is never invoked for a rejected candidate.

---

# 36. Response Adoption

Adoptable response:

```text
2xx
AND
non-null body
AND
Content-Type media type = text/event-stream
```

Media type comparison is case-insensitive and ignores parameters.

Examples:

```text
text/event-stream
text/event-stream; charset=utf-8
```

are accepted.

After adoption:

```text
request-level retry permanently closes
```

even if no semantic SSE event has yet been consumed.

---

# 37. `onResponse`

Pi callback input:

```ts
interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
}
```

Construct:

```text
ProviderResponse.status
← adopted Response.status

ProviderResponse.headers
← materialized string header record
```

Invoke:

```text
options.onResponse(
  providerResponse,
  providerFacingModel
)
```

Lifecycle:

```text
response adoption
→ onResponse exactly once
→ framing/body consumption
```

It is:

```text
outside retry
inside upstream timeout
```

Callback failure:

```text
→ Pi error
→ no retry
```

---

# 38. Upstream Execution Timeout

`timeoutMs` means:

> whole upstream execution deadline.

Outside timeout:

```text
pre-abort classification
execution-control validation
endpoint resolution
project snapshot
Pi → CommandCode semantic conversion
stable header construction
```

Immediately before upstream execution:

```text
re-check caller signal
```

Then start timeout.

Inside:

```text
request attempts
candidate cleanup
retry backoff
response adoption
onResponse
framing decode
SSE semantic consumption
```

Timeout:

```text
callerSignal not aborted
→ Pi error(reason = error)
```

Caller abort:

```text
→ Pi error(reason = aborted)
```

---

# 39. Framing Decoder Byte Boundary

The transport body is a byte stream.

A `ReadableStream` chunk is **not** assumed to be:

```text
one UTF-8 code point
one line
one SSE field
one JSON event
```

Required physical decoding:

```text
ReadableStream<Uint8Array>
        │
        ▼
streaming UTF-8 decoder
        │
        ▼
decoded character buffer
        │
        ▼
line buffering
        │
        ▼
framing classification
```

---

## 39.1 Streaming UTF-8

Use a streaming UTF-8 decoder so a multibyte code point split across transport chunks is reconstructed correctly.

Conceptually:

```text
chunk N
+
decoder retained state
+
chunk N+1
→ correct Unicode text
```

Do not decode each byte chunk independently as a complete string.

At physical EOF:

```text
flush decoder
→ append remaining decoded text
→ process final buffered line if applicable
```

---

## 39.2 Line Buffering

Framing classification operates on complete logical lines, not transport chunks.

Support line endings:

```text
LF
CRLF
```

A line may span any number of `ReadableStream` chunks.

A single chunk may also contain multiple lines.

---

## 39.3 Supported Framing Lines

Canonical:

```text
data: {"type":"text-delta","text":"Hello"}
```

Observed compatibility:

```text
{"type":"text-delta","text":"Hello"}
```

Ignorable:

```text
blank line
: comment
event: ...
id: ...
retry: ...
```

Sentinel:

```text
[DONE]
data: [DONE]
```

The framing decoder does not create a persistent framing IR.

---

## 39.4 JSON Decode

Supported event/error payload line:

```text
→ parse JSON
→ require JSON object
```

Invalid JSON or non-object JSON where an event/error object is expected:

```text
→ Pi error
```

---

## 39.5 Early Non-Event Error

Before ordinary semantic initialization, recognized objects such as:

```text
{ "error": ... }
```

or:

```text
{ "success": false, ... }
```

without `type` are treated as:

```text
known compatibility upstream failure
→ retain raw diagnostic evidence where practical
→ Pi error
```

Unknown object with no safe semantics:

```text
→ diagnose raw evidence
→ Pi error
```

---

# 40. Response Semantic State

Conceptually:

```ts
interface ToolPreviewState {
  contentIndex: number;
  name: string;
  rawInput: string;
  inputEnded: boolean;
}

interface StreamState {
  assistant: AssistantMessage;

  started: boolean;
  piTerminalCommitted: boolean;

  activeText?: number;
  activeReasoning?: number;

  activeToolPreviews: Map<string, ToolPreviewState>;
  completedToolIds: Set<string>;
}
```

This is request-local mutable producer state.

---

# 41. Interleaving

CommandCode and Pi both establish that independent content lifecycles can interleave.

Track independently:

```text
text
reasoning
tool inputs keyed by ID
```

No:

```text
global currentBlock
```

invariant exists.

v0.9.1 remains strict for same-kind anonymous lifecycles:

```text
second text-start while text active
→ Pi error

second reasoning-start while reasoning active
→ Pi error
```

because established CommandCode text/reasoning lifecycle events do not expose a block identifier.

---

# 42. Start Lifecycle

Before CommandCode `start`:

```text
recognized error event
→ Pi error

recognized early non-event error
→ Pi error

start
→ Pi start

finish
→ Pi error

content/tool lifecycle
→ Pi error

[DONE]
→ Pi error

EOF
→ Pi error
```

Duplicate `start`:

```text
→ Pi error
```

`start` is required for normal content/success lifecycle, not pre-start failure.

---

# 43. Text Lifecycle

```text
text-start
→ create TextContent("")
→ emit text_start

text-delta
→ append text
→ emit text_delta

text-end
→ emit text_end with complete accumulated string
```

Normal:

```text
text_start
→ text_delta*
→ text_end
```

Failure may instead be:

```text
text_start
→ text_delta*
→ error
```

No synthetic `text_end` is required on failure.

---

# 44. Reasoning Lifecycle

```text
reasoning-start
→ create ThinkingContent
→ emit thinking_start

reasoning-delta
→ append reasoning text
→ emit thinking_delta

reasoning-end
→ emit thinking_end with complete accumulated string
```

Failure may interrupt:

```text
thinking_start
→ thinking_delta*
→ error
```

No synthetic `thinking_end` is emitted merely to make the failed lifecycle look complete.

---

# 45. Tool Streaming

Hierarchy:

```text
tool-input-start
→ tool-input-delta*
→ tool-input-end
→ tool-call
```

Incremental preview is not authoritative completion.

---

## 45.1 Tool Preview Start

ID must be absent from:

```text
activeToolPreviews
completedToolIds
```

Append placeholder:

```ts
{
  type: "toolCall",
  id,
  name,
  arguments: {}
}
```

Emit `toolcall_start`.

---

## 45.2 Tool Preview Delta

Require active preview with `inputEnded = false`.

Accumulate exact:

```text
rawInput += delta
```

Then use:

```text
parseStreamingJson(rawInput)
```

only as best-effort preview parsing.

Pi requires object-shaped arguments.

Therefore only:

```text
non-null object
AND
not Array
```

may become live `ToolCall.arguments`.

Otherwise:

```text
arguments = {}
```

Raw delta remains available as the Pi `toolcall_delta.delta`.

---

## 45.3 Tool Input End

Require active, not-ended preview.

Set:

```text
inputEnded = true
```

Do not emit `toolcall_end`.

---

## 45.4 Authoritative `tool-call`

Final `input` must be object-shaped.

With preview:

```text
require inputEnded
require name match

final input
→ authoritative arguments

emit toolcall_end

destroy preview state

retain completed ID guard
```

Final-only:

```text
append final ToolCall
emit toolcall_start
emit toolcall_end
retain completed ID guard
```

---

## 45.5 No Tool Schema Execution Validation

`toolcall_end` means:

```text
Pi streamed ToolCall lifecycle ended
```

It does not mean:

```text
Tool.parameters validated
tool executable
agent should execute
```

The CommandCode Provider does not call Pi Agent-style:

```text
validateToolArguments()
```

as a prerequisite for emitting `toolcall_end`.

Provider conversion and Agent tool execution validation remain separate boundaries.

---

# 46. Response Tool ID Guard

Within one generated AssistantMessage:

```text
completed ToolCall ID
→ may not be reused before response terminal
```

This response-side guard is distinct from historical request-side ID reuse after a ToolCall/ToolResult relationship has closed.

---

# 47. Non-Content / Unknown Events

```text
start-step
→ no Pi content event

finish-step
→ no Pi terminal

provider-metadata
→ no Pi conversational event
```

Raw metadata may be retained diagnostically.

---

## 47.1 Streamed `tool-result`

Known discriminator, incomplete stable stream-event schema:

```text
retain raw type/payload diagnostically where practical
→ do not invent Pi semantics
→ Pi error
```

---

## 47.2 Unknown Event

```text
unknown type string
→ retain discriminator/raw payload diagnostically
→ do not invent semantics
→ Pi error
```

---

## 47.3 CommandCode `error`

```text
known error discriminator
→ best-effort errorMessage
→ preserve raw diagnostic evidence where practical
→ Pi error(reason = error)
```

---

# 48. Usage Conversion

Final authority:

```text
ccUsage = finish.totalUsage
```

Hierarchy:

```text
ccUsage
├── inputTokens
├── outputTokens
├── inputTokenDetails?
│   ├── noCacheTokens?
│   ├── cacheReadTokens?
│   └── cacheWriteTokens?
├── outputTokenDetails?
│   ├── textTokens?
│   └── reasoningTokens?
├── totalTokens?
├── reasoningTokens?
└── cachedInputTokens?
```

---

## 48.1 Required-for-Conversion Core

v0.9.1 strict conversion policy requires:

```text
inputTokens
outputTokens
```

to be present and valid.

This is:

```text
CommandCode evidence
+
LuckyToken representability policy
```

not a universal CommandCode wire-presence claim.

---

## 48.2 Numeric Validation

Consumed usage counts must be:

```text
finite
non-negative
integer
```

This is a LuckyToken runtime validation policy.

Safe-integer validation may be adopted as additional implementation hardening, but it is not asserted here as a Pi or CommandCode protocol invariant.

---

## 48.3 Cache Mapping

```text
cacheRead =
ccUsage.inputTokenDetails?.cacheReadTokens ?? 0

cacheWrite =
ccUsage.inputTokenDetails?.cacheWriteTokens ?? 0
```

If:

```text
ccUsage.inputTokenDetails?.noCacheTokens
```

is valid and present:

```text
Pi usage.input = noCacheTokens
```

Otherwise:

```text
Pi usage.input =
max(
  ccUsage.inputTokens
  - cacheRead
  - cacheWrite,
  0
)
```

---

## 48.4 Output / Reasoning

```text
Pi usage.output
=
ccUsage.outputTokens
```

Reasoning:

```text
ccUsage.outputTokenDetails?.reasoningTokens
?? ccUsage.reasoningTokens
?? undefined
```

Invariant:

```text
reasoning <= output
```

---

## 48.5 Other Usage Evidence

Currently not separately consumed:

```text
outputTokenDetails?.textTokens
totalTokens
cachedInputTokens
```

May be retained diagnostically.

Pi total is recomputed from the normalized Pi partition.

---

## 48.6 Cost

```text
calculateCost(model, usage)
```

after Pi usage normalization.

No duplicate pricing system.

---

# 49. Finish Reason

CommandCode:

```text
finish.finishReason
```

is semantic stop authority.

Known mapping:

```text
"stop"
→ Pi done(reason = stop)
```

Always:

```text
Pi rawStopReason
=
finish.finishReason
```

Unknown/unsupported finishReason:

```text
preserve rawStopReason
→ Pi error
```

---

## 49.1 `rawFinishReason?`

CommandCode:

```text
finish.rawFinishReason?
```

is a distinct optional extension with unresolved semantics.

It:

```text
does not replace finishReason
does not drive Pi stop mapping
does not replace Pi rawStopReason
```

It may be retained only in diagnostics/observability.

---

# 50. Semantic Terminal Validation

Successful `finish` requires:

```text
started = true

no active text lifecycle
no active reasoning lifecycle
no active tool preview

supported finishReason

convertible final usage
```

Otherwise:

```text
→ Pi error
```

Private `error` may terminate before or after start.

---

# 51. Failure Snapshot Semantics

This section closes active partial-content behavior explicitly.

Pi permits failure to interrupt active text, reasoning and ToolCall lifecycles.

Therefore the terminal failed `AssistantMessage` is constructed as follows:

```text
Failure AssistantMessage
├── completed text blocks
├── accumulated active partial text
├── completed reasoning blocks
├── accumulated active partial reasoning
├── completed authoritative ToolCalls
└── no preview-only incomplete ToolCalls
```

---

## 51.1 Partial Text

If failure occurs after:

```text
text_start
→ text_delta*
```

but before `text_end`:

```text
accumulated TextContent
→ preserved in terminal error AssistantMessage
```

Do not emit a fabricated:

```text
text_end
```

The terminal `error` itself closes the overall assistant response.

---

## 51.2 Partial Reasoning

Likewise:

```text
thinking_start
→ thinking_delta*
→ error
```

preserves the accumulated `ThinkingContent` in the terminal error assistant.

Do not emit a fake `thinking_end`.

---

## 51.3 Incomplete Tool Preview

An active preview-only ToolCall remains semantically incomplete.

Therefore:

```text
preview-only ToolCall placeholder
→ excluded from terminal error snapshot
```

The live partial object is not spliced or reindexed.

---

## 51.4 Completed ToolCalls

ToolCalls that received authoritative CommandCode:

```text
tool-call
```

remain in the terminal failed AssistantMessage.

---

## 51.5 Content Index Stability

Previously emitted:

```text
contentIndex
```

relationships remain stable in the live partial state.

Failure cleanup must not renumber live content.

The terminal snapshot may filter incomplete preview-only ToolCalls without mutating the already exposed live partial object's index relationships.

---

# 52. `[DONE]` and EOF

Before semantic terminal:

```text
[DONE]
data: [DONE]
EOF
→ Pi error
```

Transport completion is not semantic success.

After Pi terminal:

```text
semantic parsing stops
```

The Provider is not required to drain until `[DONE]` or EOF.

If cleanup naturally observes them:

```text
→ ignore as transport framing
```

---

# 53. Pi Terminal Commit vs Core Success Commit

Provider:

```text
CommandCode finish/error
→ Pi done/error
→ PI TERMINAL COMMIT
```

This freezes the Pi stream result.

LuckyToken Core separately owns:

```text
supported Pi done.message
+
request AbortSignal not aborted
at Core success commit
→ LuckyToken success
```

Thus:

```text
Pi done committed
→ request signal aborts
→ Core checks signal
→ Core outcome aborted
```

does not mutate the Provider's already committed Pi result.

---

# 54. Post-Terminal Transport Lifecycle

After Pi terminal:

```text
stop semantic parsing
→ best-effort cancel/close upstream body
→ release decoder/parser/transport state
```

Late semantic data cannot:

```text
change done → error
change error → done
mutate committed AssistantMessage
emit second terminal
```

---

# 55. Information Death Points

```text
Project snapshot
→ dies with Provider invocation

semantic CommandCodeRequest
→ dies with Provider invocation

stable headers
→ die with Provider invocation

attempt traceparent
→ dies with attempt

non-adopted candidate response
→ cleaned before retry

raw framing buffer
→ dies after line classification / terminal cleanup

active text/reasoning state
→ dies at local end or terminal

tool rawInput/preview state
→ dies at authoritative tool-call or terminal

completed response ToolCall ID guard
→ dies at response terminal

diagnostic raw unknown/error evidence
→ survives only if explicitly attached to diagnostics/observability
```

No temporary transport/conversion representation becomes long-lived semantic state.

---

# 56. Implementation Shape

A small concrete implementation remains sufficient.

```text
commandcode-private/
├── provider.ts
├── request.ts
├── stream.ts
└── project.ts
```

Possible focused functions:

```text
Provider
└── streamSimple(...)
    ├── create stream
    ├── create initial assistant
    └── start async producer

Request
├── validateExecutionControls(...)
├── resolveEffectiveEndpoint(...)
├── buildCommandCodeRequest(...)
├── convertMessages(...)
├── convertTools(...)
├── resolveReasoning(...)
└── resolveMaxTokens(...)

Headers
├── buildStableHeaderBase(...)
└── buildAttemptHeaders(...)

Transport
├── establishResponse(...)
├── cleanupCandidateResponse(...)
├── isAdoptableResponse(...)
├── normalizeEstablishmentError(...)
├── normalizeRetryDelay(...)
├── createUpstreamExecutionDeadline(...)
└── executeEstablishmentWithRetry(...)

Framing
└── decodeCommandCodeStream(...)
    ├── streaming UTF-8
    ├── line buffer
    └── frame classification

Response
├── consumeCommandCodeEvents(...)
├── convertUsage(...)
├── mapFinishReason(...)
└── buildFailureSnapshot(...)
```

---

# 57. Pi Reuse Policy

## 57.1 Reuse Contracts

Directly use Pi public/runtime contracts:

```text
Model<Api>
Context
SimpleStreamOptions
AssistantMessage
AssistantMessageEventStream
Pi content/message types
```

---

## 57.2 Selective Helper Reuse

Focused helper reuse is allowed where semantics match:

```text
clampMaxTokensToContext()
→ after LuckyToken validation

clampThinkingLevel()
→ reasoning resolution

parseStreamingJson()
→ preview parsing + LuckyToken object guard

calculateCost()
→ normalized usage pricing
```

---

## 57.3 Explicit Non-Reuse as Pipeline

Do not wholesale invoke:

```text
buildBaseOptions()
transformMessages()
```

as mandatory preprocessing stages.

Their behavior is broader/different from this Provider's explicit conversion policy.

---

## 57.4 Source Extraction

Internal Pi helpers such as retry behavior or useful abort-race patterns may be extracted only as the smallest coherent source subset when no intentional supported public boundary exists.

Preserve provenance.

Do not import brittle internal source paths.

---

# 58. No New Frameworks

Do not introduce without demonstrated need:

```text
CommandCodeIR
CommandCodeFrameIR
ConversionManager
ProviderExecutionContext
MessageConverterRegistry
ProtocolDecoderManager
StreamManager
RuntimeServices
DependencyBag
RetryManager
TimeoutManager
CallbackManager
HistoryNormalizer
ModeResolver
```

The required logic fits focused concrete functions and request-local state.

---

# 59. Test Matrix

## 59.1 No `buildBaseOptions()` Preprocessing

```text
options.maxTokens = -10
model.contextWindow <= 0

expected:
→ invalid maxTokens
→ Pi error

must not become:
→ buildBaseOptions clamp
→ 1
→ accepted request
```

Verify samplingParams are not implicitly merged.

---

## 59.2 No `transformMessages()` Preprocessing

Unsupported user image:

```text
→ Pi error

NOT:
→ "(image omitted...)"
```

Missing historical ToolResult:

```text
→ Pi error

NOT:
→ synthetic "No result provided"
```

Failed assistant followed by orphan result:

```text
→ strict history error after failed-turn omission
```

---

## 59.3 `streamSimple()` Return Boundary

For each:

```text
signal already aborted
maxRetries invalid
timeoutMs invalid
model.baseUrl invalid
sessionId missing
onPayload supplied
history invalid
project snapshot failure
```

verify:

```text
provider.streamSimple(...)
→ returns AssistantMessageEventStream

failure
→ emitted through returned stream
```

and not:

```text
provider.streamSimple(...)
→ synchronous throw
```

---

## 59.4 Abort Provenance

Through `Models.streamSimple()`:

```text
Provider called with already-aborted request signal
→ inner Provider stream emits aborted
→ outer lazy forwarding preserves aborted terminal
```

Expected final:

```text
stopReason = aborted
error.reason = aborted
```

not generic `error`.

---

## 59.5 Initial Assistant

Pre-start error:

```text
role = assistant
content = []
api/provider/model = request model identity
usage = zero
stopReason transitions pending → error/aborted
timestamp stable
```

No Pi start required.

---

## 59.6 Continuity Matrix

Same-target text:

```text
textSignature absent/empty
→ map

non-empty
→ error
```

Same-target thinking:

```text
redacted
→ error

non-empty thinkingSignature
→ error

ordinary visible no-signature thinking
→ reasoning
```

Same-target ToolCall:

```text
thoughtSignature absent/empty
→ map

non-empty thoughtSignature
→ error

namespace present
→ error
```

Foreign signatures:

```text
textSignature
thinkingSignature
thoughtSignature
→ discard
```

Foreign namespace:

```text
→ error
```

---

## 59.7 Deferred

```text
absent
→ ordinary stream

false
→ ordinary stream

true
→ error

{ window: "1h" }
→ error
```

---

## 59.8 Base-Path Endpoint Join

```text
https://host/proxy/
→ https://host/proxy/alpha/generate
```

Ensure implementation does not produce:

```text
https://host/alpha/generate
```

---

## 59.9 Chunk-Safe Framing

Split UTF-8 code point across chunks:

```text
chunk A
chunk B
→ decoded correctly
```

Split JSON line across chunks:

```text
chunk A: data: {"type":"text-
chunk B: delta","text":"hi"}\n
→ one event
```

Multiple lines in one chunk:

```text
→ each classified independently
```

CRLF:

```text
→ supported
```

Trailing final line at EOF:

```text
→ processed before premature-EOF classification
```

---

## 59.10 Interleaving

```text
reasoning-start
tool-input-start(A)
text-start
tool-input-delta(A)
text-delta
reasoning-delta
tool-input-end(A)
tool-call(A)
reasoning-end
text-end
```

→ valid independent state tracking.

---

## 59.11 Failure With Active Text

```text
text-start
text-delta("abc")
upstream error
```

Terminal failure snapshot contains:

```text
TextContent("abc")
```

No `text_end` event is fabricated.

---

## 59.12 Failure With Active Reasoning

```text
reasoning-start
reasoning-delta("abc")
upstream error
```

Terminal failure snapshot contains accumulated reasoning.

No `thinking_end` is fabricated.

---

## 59.13 Failure With Tool Preview

```text
tool-input-start(A)
tool-input-delta(A)
error
```

Live partial indices remain unchanged.

Terminal failure snapshot excludes incomplete ToolCall A.

---

## 59.14 Tool Completion Validation Boundary

Valid object-shaped final tool input:

```text
→ toolcall_end
```

even if the arguments would later fail the Agent's Tool.parameters validation.

Provider does not run Agent execution validation here.

---

# 60. v0.9.1 Changes from v0.9

v0.9.1 does not redesign the Provider.

It closes boundaries made explicit by the complete Pi AI IR Protocol v0.9.2 rewrite.

## Pi Shared Helper Boundary

```text
1. Explicitly prohibits wholesale buildBaseOptions()
   preprocessing.

2. CommandCode consumes Provider-facing
   SimpleStreamOptions directly.

3. maxTokens is validated before
   clampMaxTokensToContext().

4. samplingParams remains intentionally unapplied.
```

## Historical Replay Boundary

```text
5. Explicitly prohibits wholesale transformMessages()
   preprocessing.

6. CommandCode performs strict history conversion directly
   from original Context.messages.

7. Pi placeholder/synthetic ToolResult behavior does not
   leak into CommandCode conversion.
```

## Provider Stream Failure Contract

```text
8. streamSimple() must synchronously return its own
   AssistantMessageEventStream.

9. Expected request/runtime failures must not synchronously
   escape Provider streamSimple().

10. Provider owns pre-start aborted/error classification.

11. This prevents generic lazyStream from losing
    AbortSignal provenance for Provider-owned failures.
```

## Initial Assistant State

```text
12. Added explicit conforming CommandCode Provider
    initial AssistantMessage producer state.

13. Classified it as LuckyToken Provider policy,
    not a universal Pi initializer.
```

## Opaque Continuity

```text
14. Closed TextContent.textSignature behavior.

15. Closed ThinkingContent.thinkingSignature behavior.

16. Closed ToolCall.thoughtSignature behavior.

17. Reaffirmed ToolCall.namespace as unrepresentable
    rather than generic discardable continuity.
```

## Failure Snapshot

```text
18. Active partial text is preserved on error.

19. Active partial reasoning is preserved on error.

20. No fake text_end / thinking_end is emitted.

21. Preview-only incomplete ToolCalls remain excluded.
```

## Deferred

```text
22. Explicitly defines absent/false as ordinary invocation.

23. true/object remains unsupported.

24. Classified as LuckyToken interpretation policy.
```

## Endpoint / Framing

```text
25. Added base-path-preserving endpoint join.

26. Added byte-chunk-safe streaming UTF-8 decode contract.

27. Added complete-line buffering before framing
    classification.
```

## Provenance

```text
28. Split protocol-document provenance:
    f65b5c8

    from Pi runtime-source provenance:
    eb3c46d / @earendil-works/pi-ai 0.84.1.
```

No new semantic IR, middleware pipeline, manager, or architecture layer is introduced.

---

# 61. Reopen Conditions

Reopen only when evidence or requirements establish:

```text
CommandCode support for Pi opaque continuity
textSignature
thinkingSignature
thoughtSignature
namespace

CommandCode deferred execution

explicit CommandCode mode semantics

additional finishReason mappings

closed rawFinishReason semantics

closed streamed tool-result schema

same-kind concurrent text/reasoning IDs

new usage mappings

new physical framing forms

alternate authentication

safe onPayload callback representation

different response-adoption rules

different server-mandated retry policy

CommandCode WebSocket transport

intentional Pi public helper APIs that materially
change selective-reuse decisions
```

Until then:

```text
Pi contracts
→ consume directly

Pi shared helpers
→ reuse selectively

known CommandCode semantics
→ map explicitly

unknown raw evidence
→ preserve diagnostically where practical

unrepresentable semantics
→ fail closed
```

---

# 62. Final Information Flow

```text
Models.streamSimple()
        │
        ├── auth resolution
        └── request-effective Model / Options
        │
        ▼
CommandCode Provider.streamSimple()
        │
        ├── CREATE INNER STREAM IMMEDIATELY
        ├── create initial AssistantMessage
        └── start async producer
                │
                ├── pre-abort classification
                ├── validate raw SimpleStreamOptions
                │   └── NO buildBaseOptions pipeline
                │
                ├── resolve endpoint
                ├── project snapshot
                │
                ├── direct historical conversion
                │   └── NO transformMessages pipeline
                │
                ├── one semantic CommandCodeRequest
                ├── stable headers
                │
                ├── caller abort re-check
                ├── start upstream timeout
                │
                ├── HTTP attempts
                │   ├── same endpoint/body
                │   ├── fresh traceparent
                │   ├── reject candidate
                │   │   └── cleanup before retry
                │   └── adopt response
                │
                ├── RESPONSE ADOPTION
                │   └── retry permanently closes
                │
                ├── onResponse
                │
                ├── byte stream
                │   ↓
                ├── streaming UTF-8 decoder
                │   ↓
                ├── line buffer
                │   ↓
                ├── framing decoder
                │   ↓
                ├── CommandCode semantic lifecycles
                │   ├── text
                │   ├── reasoning
                │   ├── tool previews
                │   ├── tool completion
                │   ├── usage
                │   └── finish/error
                │
                ├── Pi done/error
                │   └── PI TERMINAL COMMIT
                │
                ├── stop semantic parsing
                ├── close/cancel upstream
                └── request-local state dies
                        │
                        ▼
LuckyToken Core
        │
        ├── observe Pi terminal
        └── independently check request AbortSignal
                │
                ▼
        CORE SUCCESS COMMIT
```

The final architectural rule is:

> **CommandCode Provider reuses Pi's contracts and narrowly selected helpers. It does not inherit Pi shared normalization helpers as an implicit middleware pipeline, and it does not delegate its own failure classification to an outer lazy wrapper.**