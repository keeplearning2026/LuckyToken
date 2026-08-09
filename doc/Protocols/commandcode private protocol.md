# CommandCode `/alpha/generate` Protocol Specification

**Protocol:** CommandCode Generate API
**Endpoint:** `POST /alpha/generate`
**Transport:** HTTP request + Server-Sent Events / line-delimited JSON response
**Specification Status:** Observed wire contract
**Primary Evidence:** Current CommandCode Router strict wire types and SSE parser

------

# 1. Protocol Overview

CommandCode `/alpha/generate` uses a structured JSON request and an event-stream response.

The overall protocol is:

```text
CommandCode Generate
│
├── HTTP Request
│   ├── Headers
│   └── GenerateRequest
│
└── HTTP Response
    └── CommandCode Event Stream
        │
        ├── Stream Lifecycle
        ├── Text Lifecycle
        ├── Reasoning Lifecycle
        ├── Tool Input Lifecycle
        ├── Step Lifecycle
        └── Terminal
```

The request-side semantic hierarchy is:

```text
GenerateRequest
│
├── Project / Runtime Context
│   ├── config
│   ├── memory
│   ├── taste
│   ├── skills
│   ├── permissionMode
│   └── threadId
│
└── Generation Parameters
    └── params
        ├── model
        ├── system
        ├── messages[]
        ├── tools[]
        ├── max_tokens
        ├── temperature?
        ├── reasoning_effort?
        └── stream
```

The response-side hierarchy is:

```text
CommandCode Event Stream
│
├── Stream Start
│
├── Step
│
├── Content*
│   ├── Text
│   ├── Reasoning
│   └── Tool Input
│
├── Step Completion
│
└── Terminal
    ├── finish
    └── error
```

The current strict request types and event types are defined explicitly in the protocol crate.

------

# 2. HTTP Layer

## 2.1 Endpoint

```text
HTTP Request
│
├── Method
│   └── POST
│
└── Path
    └── /alpha/generate
```

Observed production endpoint:

```http
POST https://api.commandcode.ai/alpha/generate
```

------

## 2.2 Header Hierarchy

The observed client request carries several categories of headers:

```text
Headers
│
├── Authentication
│   └── Authorization
│
├── Protocol Version
│   └── x-command-code-version
│
├── Session Identity
│   ├── x-session-id
│   └── x-project-slug?
│
├── Client Metadata
│   ├── x-cli-environment
│   ├── x-taste-learning
│   ├── x-co-flag
│   └── User-Agent
│
├── Distributed Trace
│   └── traceparent
│
└── HTTP Transport
    ├── Content-Type
    ├── Accept
    ├── Accept-Encoding
    ├── accept-language
    └── sec-fetch-mode
```

The current observed request headers include:

```http
Authorization: Bearer <api-key>
Content-Type: application/json
Accept: */*
Accept-Encoding: br, gzip, deflate

x-command-code-version: <version>
x-cli-environment: production

x-session-id: <thread-id>
x-project-slug: <project-slug>    # optional/project-dependent

x-taste-learning: false
x-co-flag: false

traceparent: <trace-id>
User-Agent: cli
accept-language: *
sec-fetch-mode: cors
```

The current project uses the same resolved thread identifier for `x-session-id` and body `threadId`.

Not every generic HTTP/client metadata header should be interpreted as a semantic field of the CommandCode generation protocol.

------

# 3. Request Protocol

## 3.1 GenerateRequest Tree

The strict request object is:

```text
GenerateRequest
│
├── config
│   └── Config
│
├── memory
│   └── JSON value
│
├── taste
│   └── JSON value
│
├── skills
│   └── JSON value
│
├── permissionMode
│   └── string
│
├── threadId
│   └── string
│
└── params
    └── Params
```

Equivalent structural type:

```ts
interface GenerateRequest {
  config: Config

  memory: unknown
  taste: unknown
  skills: unknown

  permissionMode: string

  threadId: string

  params: Params
}
```

The current strict Rust wire structure requires these top-level keys when it serializes a request. `memory`, `taste`, and `skills` are intentionally represented as generic JSON values rather than protocol-specific nested Rust structures.

------

# 4. Project / Runtime Context

## 4.1 Context Tree

```text
GenerateRequest
│
├── config
│
├── memory
├── taste
├── skills
├── permissionMode
└── threadId
```

This part of the request is separate from:

```text
params
```

which contains the actual generation conversation.

------

# 5. Config

## 5.1 Config Tree

```text
config
│
├── workingDir
├── date
├── environment
├── structure[]
├── isGitRepo
├── currentBranch
├── mainBranch
├── gitStatus
└── recentCommits[]
```

Exact observed shape:

```ts
interface Config {
  workingDir: string
  date: string
  environment: string

  structure: string[]

  isGitRepo: boolean

  currentBranch: string
  mainBranch: string

  gitStatus: string

  recentCommits: string[]
}
```

The strict wire type requires `structure` and `recentCommits` to be arrays of strings and `gitStatus` to be a string.

------

## 5.2 Working Directory

```text
config
└── workingDir
    └── string
```

Represents the working/project directory associated with the generation request.

Example:

```json
{
  "workingDir": "D:\\project\\example"
}
```

------

## 5.3 Date

```text
config
└── date
    └── string
```

Observed format:

```text
YYYY-MM-DD
```

Example:

```json
{
  "date": "2026-08-08"
}
```

------

## 5.4 Environment

```text
config
└── environment
    └── string
```

Represents the runtime platform/environment.

Observed values may resemble:

```text
win32
darwin
linux
```

------

## 5.5 Project Structure

```text
config
└── structure[]
    └── string
```

Example:

```json
{
  "structure": [
    "package.json",
    "src",
    "scripts",
    "docs"
  ]
}
```

This is project-context information rather than conversation content.

------

## 5.6 Git Context

```text
config
├── isGitRepo
├── currentBranch
├── mainBranch
├── gitStatus
└── recentCommits[]
```

Example:

```json
{
  "isGitRepo": true,
  "currentBranch": "main",
  "mainBranch": "main",
  "gitStatus": "M src/example.ts",
  "recentCommits": [
    "abc1234 fix: example",
    "def5678 feat: previous change"
  ]
}
```

The observed protocol treats `gitStatus` as one string rather than a structured array/object.

------

# 6. Additional Runtime Context Fields

## 6.1 Opaque Context Slots

```text
GenerateRequest
├── memory
├── taste
└── skills
```

The currently frozen wire type deliberately describes all three as:

```text
arbitrary JSON value
```

rather than assigning a narrower schema.

A valid observed request may therefore contain:

```json
{
  "memory": null,
  "taste": null,
  "skills": null
}
```

The current Router sends these as `null`, but that is a client behavior and should not be interpreted as proof that the upstream protocol only accepts `null`.

------

## 6.2 Permission Mode

```text
GenerateRequest
└── permissionMode
    └── string
```

Observed default:

```json
{
  "permissionMode": "auto-accept"
}
```

The wire representation is a string.

------

## 6.3 Thread Identity

```text
GenerateRequest
└── threadId
    └── string
```

Observed transport relationship:

```text
body.threadId
        │
        └──────────────┐
                       ▼
header.x-session-id
```

Both are used to identify the logical upstream thread/session in the current observed request pattern.

------

# 7. Generation Parameters

## 7.1 Params Tree

```text
params
│
├── Model
│   └── model
│
├── System Prompt
│   └── system
│
├── Conversation
│   └── messages[]
│
├── Tools
│   └── tools[]
│
├── Generation Controls
│   ├── max_tokens
│   ├── temperature?
│   └── reasoning_effort?
│
└── Transport
    └── stream
```

Structural representation:

```ts
interface Params {
  model: string

  system: string

  messages: Message[]

  tools: ToolDefinition[]

  max_tokens: number

  stream: boolean

  reasoning_effort?: ReasoningEffort

  temperature?: number
}
```

These exact wire fields are represented by the strict `CcParams` type.

------

# 8. Model

```text
params
└── model
    └── string
```

Example:

```json
{
  "model": "deepseek/deepseek-v4-pro"
}
```

The field contains the upstream CommandCode model identifier.

------

# 9. System Prompt

```text
params
└── system
    └── string
```

Unlike protocols that represent system prompts as message blocks, the CommandCode request has a dedicated:

```text
params.system
```

string.

Example:

```json
{
  "system": "You are a coding assistant."
}
```

The wire structure does not require a structured array for this field.

------

# 10. Conversation Messages

## 10.1 Messages Tree

```text
params.messages[]
└── Message
    │
    ├── role
    │
    └── content[]
        └── ContentBlock
```

Type:

```ts
interface Message {
  role: string
  content: ContentBlock[]
}
```

One important protocol characteristic is:

```text
content is always an array
```

There is no string-content shorthand in the frozen CommandCode wire type.

------

## 10.2 Observed Message Roles

The frozen request and conversion fixtures use:

```text
Message.role
│
├── user
├── assistant
├── tool
└── system
```

Their semantic content relationships are:

```text
user
└── text / image

assistant
└── text / reasoning / tool-call

tool
└── tool-result

system
└── text
```

`tool` is an independent message role in CommandCode; a tool result is not embedded inside a normal user message. The repository's protocol documentation explicitly records this wire shape.

------

# 11. Content Block Hierarchy

## 11.1 Content Tree

```text
ContentBlock
│
├── Text
│   └── TextBlock
│
├── Reasoning
│   └── ReasoningBlock
│
├── Image
│   └── ImageBlock
│
└── Tool Protocol
    ├── ToolCallBlock
    └── ToolResultBlock
```

The exact discriminator is:

```text
type
```

with kebab-case values for tool-related blocks.

------

# 12. TextBlock

```text
TextBlock
│
├── type = "text"
└── text
```

Example:

```json
{
  "type": "text",
  "text": "Hello."
}
```

Used for ordinary user/assistant textual conversation content.

------

# 13. ReasoningBlock

```text
ReasoningBlock
│
├── type = "reasoning"
└── text
```

Example:

```json
{
  "type": "reasoning",
  "text": "I should inspect the repository first."
}
```

CommandCode distinguishes reasoning from visible text through the content-block discriminator.

The reasoning content field itself is still named:

```text
text
```

rather than `thinking` or `reasoning`.

------

# 14. ImageBlock

## 14.1 Image Tree

```text
ImageBlock
│
├── type = "image"
├── image
│   └── data URL
└── mimeType
```

Exact type:

```ts
interface ImageBlock {
  type: "image"

  image: string

  mimeType: string
}
```

The current strict type documents `image` as a complete data URL:

```text
data:<mime>;base64,<payload>
```

while `mimeType` separately contains the lowercase MIME type.

Example:

```json
{
  "type": "image",
  "image": "data:image/png;base64,iVBORw0KGgo...",
  "mimeType": "image/png"
}
```

------

# 15. Tool Protocol — Request History

## 15.1 Tool Message Hierarchy

CommandCode represents historical client-tool interaction as:

```text
Tool Protocol
│
├── Assistant Tool Invocation
│   └── ToolCallBlock
│
└── Tool Execution Result
    └── Tool Message
        └── ToolResultBlock
```

This creates a cross-message relationship:

```text
assistant
└── tool-call
    └── toolCallId
          │
          ▼
tool
└── tool-result
    └── toolCallId
```

------

# 16. ToolCallBlock

## 16.1 Tree

```text
ToolCallBlock
│
├── type = "tool-call"
├── toolCallId
├── toolName
└── input
    └── JSON value
```

Exact shape:

```ts
interface ToolCallBlock {
  type: "tool-call"

  toolCallId: string

  toolName: string

  input: unknown
}
```

Example:

```json
{
  "type": "tool-call",
  "toolCallId": "toolu_01ABC",
  "toolName": "read",
  "input": {
    "file_path": "src/main.ts"
  }
}
```

The current strict wire type stores `input` as arbitrary JSON, although normal tool-call semantics use an object.

------

# 17. ToolResultBlock

## 17.1 Tree

```text
ToolResultBlock
│
├── type = "tool-result"
├── toolCallId
├── toolName?
└── output
    ├── type
    │   ├── text
    │   └── error-text
    └── value
```

Exact shape:

```ts
interface ToolResultBlock {
  type: "tool-result"

  toolCallId: string

  toolName?: string

  output: {
    type:
      | "text"
      | "error-text"

    value: string
  }
}
```

The strict wire type makes `toolName` optional on tool results.

------

## 17.2 Successful Tool Result

```json
{
  "type": "tool-result",
  "toolCallId": "toolu_01ABC",
  "toolName": "read",
  "output": {
    "type": "text",
    "value": "file contents"
  }
}
```

------

## 17.3 Failed Tool Result

```json
{
  "type": "tool-result",
  "toolCallId": "toolu_01ABC",
  "toolName": "read",
  "output": {
    "type": "error-text",
    "value": "File not found"
  }
}
```

The protocol encodes tool success/error status through:

```text
output.type
```

rather than a separate Boolean `is_error`.

------

# 18. Tool Definition

## 18.1 Tool Tree

```text
params.tools[]
└── ToolDefinition
    ├── name
    ├── description?
    └── input_schema
        └── JSON schema
```

Exact shape:

```ts
interface ToolDefinition {
  name: string

  description?: string

  input_schema: unknown
}
```

Example:

```json
{
  "name": "read",
  "description": "Read a file",
  "input_schema": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string"
      }
    },
    "required": [
      "file_path"
    ]
  }
}
```

There is no required:

```text
type = "function"
```

wrapper around a normal CommandCode tool definition. The repository contains a serialization test specifically protecting this property.

------

# 19. Tool Identity

The primary tool-call relationship is:

```text
Assistant Message
└── ToolCallBlock
    ├── toolCallId
    └── toolName
          │
          ▼
Tool Message
└── ToolResultBlock
    ├── toolCallId
    └── toolName?
```

Core identity:

```text
ToolCallBlock.toolCallId
=
ToolResultBlock.toolCallId
```

The observed conversation contract also expects a tool result to follow its corresponding tool call before the next ordinary user turn. The current protocol fixtures enforce this relationship when generating valid CommandCode history.

------

# 20. Reasoning Effort

## 20.1 Tree

```text
params
└── reasoning_effort?
    ├── high
    └── max
```

The current strict CommandCode reasoning-effort type has exactly two representable wire values:

```ts
type ReasoningEffort =
  | "high"
  | "max"
```

They serialize as lowercase strings.

This is distinct from a `reasoning` content block:

```text
reasoning_effort
= generation control

reasoning content block
= historical conversation content
```

------

# 21. Temperature

```text
params
└── temperature?
    └── number
```

The strict wire type permits omission.

Example:

```json
{
  "temperature": 0.3
}
```

------

# 22. Maximum Output Tokens

```text
params
└── max_tokens
    └── unsigned number
```

Exact wire spelling:

```text
max_tokens
```

not:

```text
maxTokens
```

The current strict type uses an unsigned 32-bit integer.

------

# 23. Stream Selection

```text
params
└── stream
    └── boolean
```

The field is present in the frozen request type.

The currently implemented CommandCode response contract in this repository is the streaming form. There is no separate frozen CommandCode non-streaming response object in `ccr-protocol`; the upstream execution path expects `text/event-stream`.

Therefore this specification treats the SSE/event stream as the authoritative observed response protocol.

------

# 24. Complete Request Hierarchy

```text
GenerateRequest
│
├── Runtime / Project Context
│   │
│   ├── config
│   │   ├── workingDir
│   │   ├── date
│   │   ├── environment
│   │   ├── structure[]
│   │   ├── isGitRepo
│   │   ├── currentBranch
│   │   ├── mainBranch
│   │   ├── gitStatus
│   │   └── recentCommits[]
│   │
│   ├── memory
│   ├── taste
│   ├── skills
│   │
│   ├── permissionMode
│   │
│   └── threadId
│
└── params
    │
    ├── model
    │
    ├── system
    │
    ├── messages[]
    │   │
    │   ├── UserMessage
    │   │   └── content[]
    │   │       ├── TextBlock
    │   │       └── ImageBlock
    │   │
    │   ├── AssistantMessage
    │   │   └── content[]
    │   │       ├── TextBlock
    │   │       ├── ReasoningBlock
    │   │       └── ToolCallBlock
    │   │
    │   ├── ToolMessage
    │   │   └── content[]
    │   │       └── ToolResultBlock
    │   │
    │   └── SystemMessage
    │       └── content[]
    │           └── TextBlock
    │
    ├── tools[]
    │   └── ToolDefinition
    │       ├── name
    │       ├── description?
    │       └── input_schema
    │
    ├── Generation Controls
    │   ├── max_tokens
    │   ├── temperature?
    │   └── reasoning_effort?
    │       ├── high
    │       └── max
    │
    └── stream
```

------

# 25. Complete Request Example

```json
{
  "config": {
    "workingDir": "D:\\project\\example",
    "date": "2026-08-08",
    "environment": "win32",
    "structure": [
      "package.json",
      "src",
      "docs"
    ],
    "isGitRepo": true,
    "currentBranch": "main",
    "mainBranch": "main",
    "gitStatus": "M src/main.ts",
    "recentCommits": [
      "abc1234 fix: example"
    ]
  },

  "memory": null,
  "taste": null,
  "skills": null,

  "permissionMode": "auto-accept",

  "threadId": "session-123",

  "params": {
    "model": "deepseek/deepseek-v4-pro",

    "system": "You are a coding assistant.",

    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Read src/main.ts"
          }
        ]
      },
      {
        "role": "assistant",
        "content": [
          {
            "type": "text",
            "text": "I'll inspect it."
          },
          {
            "type": "tool-call",
            "toolCallId": "toolu_01ABC",
            "toolName": "read",
            "input": {
              "file_path": "src/main.ts"
            }
          }
        ]
      },
      {
        "role": "tool",
        "content": [
          {
            "type": "tool-result",
            "toolCallId": "toolu_01ABC",
            "toolName": "read",
            "output": {
              "type": "text",
              "value": "console.log('hello')"
            }
          }
        ]
      }
    ],

    "tools": [
      {
        "name": "read",
        "description": "Read a file",
        "input_schema": {
          "type": "object",
          "properties": {
            "file_path": {
              "type": "string"
            }
          },
          "required": [
            "file_path"
          ]
        }
      }
    ],

    "max_tokens": 64000,

    "temperature": 0.3,

    "reasoning_effort": "max",

    "stream": true
  }
}
```

------

# 26. Response Transport

## 26.1 Stream Framing

The observed CommandCode response is event-stream oriented.

Two payload forms are accepted by the current parser:

```text
SSE-framed JSON

data: {"type":"text-delta","text":"Hello"}
```

and:

```text
bare JSON line

{"type":"text-delta","text":"Hello"}
```

Normal CommandCode traffic is commonly represented as:

```text
data: <JSON event>

data: <JSON event>

...

data: [DONE]
```

The parser also ignores normal SSE framing metadata such as:

```text
event:
id:
retry:
:
```

when these lines do not carry CommandCode JSON event data.

------

# 27. Response Event Hierarchy

## 27.1 Top-Level Event Tree

The known normalized CommandCode event set is:

```text
CommandCode Event
│
├── Stream Lifecycle
│   └── start
│
├── Step Lifecycle
│   ├── start-step
│   ├── provider-metadata
│   └── finish-step
│
├── Text Lifecycle
│   ├── text-start
│   ├── text-delta
│   └── text-end
│
├── Reasoning Lifecycle
│   ├── reasoning-start
│   ├── reasoning-delta
│   └── reasoning-end
│
├── Tool Input Lifecycle
│   ├── tool-input-start
│   ├── tool-input-delta
│   ├── tool-input-end
│   └── tool-call
│
├── Tool Result Event
│   └── tool-result
│
├── Terminal
│   ├── finish
│   └── error
│
└── Extension
    └── unknown event type
```

This event union is defined directly by the strict normalized SSE implementation.

------

# 28. High-Level Stream Lifecycle

A normal observed generation follows approximately:

```text
STREAM
│
├── start
│
├── start-step
│
├── content events*
│
├── provider-metadata*
│
├── finish-step
│
├── finish
│
└── [DONE]
```

Content events may include any of:

```text
text
reasoning
tool input
```

depending on the model output.

The `[DONE]` line is transport framing and is distinct from the semantic:

```text
finish
```

event.

------

# 29. `start`

```text
start
└── no required normalized payload
```

Minimal wire form:

```text
data: {"type":"start"}
```

This marks the beginning of the CommandCode response stream.

------

# 30. Step Lifecycle

## 30.1 Tree

```text
Step Lifecycle
│
├── start-step
│
├── provider-metadata*
│
├── Content Lifecycle*
│
└── finish-step
```

A stream may contain provider-specific metadata around the generation step.

------

## 30.2 `start-step`

Normalized shape:

```text
start-step
└── no required fields
```

Observed raw events may contain additional information such as:

```text
request
warnings
```

but these fields are not required by the frozen normalized event contract.

Example:

```text
data: {
  "type": "start-step",
  "request": {...},
  "warnings": []
}
```

The raw parser deliberately preserves extra fields even when the normalized semantic event ignores them.

------

## 30.3 `provider-metadata`

```text
provider-metadata
└── provider-defined metadata
```

Example observed shape:

```text
data: {
  "type": "provider-metadata",
  "providerMetadata": {
    "cai": {}
  }
}
```

The current normalized protocol recognizes the event but does not impose a structured generic schema on the provider metadata.

------

# 31. Text Streaming

## 31.1 Text Lifecycle Tree

```text
Text Lifecycle
│
├── text-start
│
├── text-delta*
│   └── text
│
└── text-end
```

State model:

```text
NONE
 │
 │ text-start
 ▼
TEXT_OPEN
 │
 ├── text-delta*
 │
 │ text-end
 ▼
TEXT_COMPLETE
```

------

## 31.2 `text-start`

Normalized shape:

```text
text-start
└── no required fields
```

Minimal form:

```text
data: {"type":"text-start"}
```

Raw upstream events may contain additional identifiers.

------

## 31.3 `text-delta`

```text
text-delta
└── text
    └── string
```

Exact required field:

```json
{
  "type": "text-delta",
  "text": "Hello"
}
```

The current normalizer rejects a known `text-delta` event if the required `text` string is missing.

------

## 31.4 `text-end`

```text
text-end
└── no required normalized fields
```

Minimal form:

```text
data: {"type":"text-end"}
```

This terminates the current text content lifecycle.

------

# 32. Reasoning Streaming

## 32.1 Reasoning Lifecycle Tree

```text
Reasoning Lifecycle
│
├── reasoning-start
│
├── reasoning-delta*
│   └── text
│
└── reasoning-end
```

State:

```text
NONE
 │
 │ reasoning-start
 ▼
REASONING_OPEN
 │
 ├── reasoning-delta*
 │
 │ reasoning-end
 ▼
REASONING_COMPLETE
```

------

## 32.2 `reasoning-start`

```text
reasoning-start
└── no required normalized fields
```

------

## 32.3 `reasoning-delta`

```text
reasoning-delta
└── text
    └── string
```

Wire example:

```json
{
  "type": "reasoning-delta",
  "text": "I should inspect the code first."
}
```

The required incremental field is named:

```text
text
```

rather than `reasoning` or `thinking`.

------

## 32.4 `reasoning-end`

```text
reasoning-end
└── no required normalized fields
```

Ends the reasoning content lifecycle.

------

# 33. Tool Input Streaming

## 33.1 Tool Lifecycle Tree

CommandCode tool streaming has an important two-part structure:

```text
Tool Input Lifecycle
│
├── Incremental Input Stream
│   ├── tool-input-start
│   ├── tool-input-delta*
│   └── tool-input-end
│
└── Completed Tool Call
    └── tool-call
```

This distinction is fundamental.

The incremental input stream builds a textual JSON representation.

The later `tool-call` event contains the completed structured tool invocation.

------

# 34. `tool-input-start`

## 34.1 Tree

```text
tool-input-start
│
├── id
├── toolName
└── dynamic?
```

Exact known fields:

```ts
{
  type: "tool-input-start"

  id: string

  toolName: string

  dynamic?: boolean
}
```

Example:

```json
{
  "type": "tool-input-start",
  "id": "toolu_01ABC",
  "toolName": "read",
  "dynamic": false
}
```

Both `id` and `toolName` are required by the current strict parser. `dynamic` is optional.

------

# 35. `tool-input-delta`

```text
tool-input-delta
│
├── id
└── delta
    └── string
```

Example:

```json
{
  "type": "tool-input-delta",
  "id": "toolu_01ABC",
  "delta": "{\"file_path\":\"src/"
}
```

Followed by:

```json
{
  "type": "tool-input-delta",
  "id": "toolu_01ABC",
  "delta": "main.ts\"}"
}
```

The `delta` is incremental serialized input data.

It is not yet the final structured JSON object.

------

# 36. `tool-input-end`

```text
tool-input-end
└── id
```

Example:

```json
{
  "type": "tool-input-end",
  "id": "toolu_01ABC"
}
```

This establishes the end boundary of the incremental input sequence for that ID.

------

# 37. `tool-call`

## 37.1 Completed Tool Call Tree

```text
tool-call
│
├── toolCallId
├── toolName
└── input
    └── JSON value
```

Exact normalized shape:

```ts
{
  type: "tool-call"

  toolCallId: string

  toolName: string

  input: unknown
}
```

Example:

```json
{
  "type": "tool-call",
  "toolCallId": "toolu_01ABC",
  "toolName": "read",
  "input": {
    "file_path": "src/main.ts"
  }
}
```

All three fields are required by the strict event normalizer.

------

# 38. Tool Input Identity Relationship

The observed tool lifecycle relates:

```text
tool-input-start.id
        │
        ├── tool-input-delta.id
        │
        ├── tool-input-end.id
        │
        ▼
tool-call.toolCallId
```

Conceptually:

```text
Incremental Tool Input
id = X
    │
    ▼
Completed ToolCall
toolCallId = X
```

The completed event also repeats:

```text
toolName
```

and supplies the authoritative structured:

```text
input
```

object/value.

------

# 39. Partial vs Complete Tool State

The protocol has two distinct representations:

```text
Incremental State
│
└── tool-input-delta.delta
    └── string fragments
```

versus:

```text
Completed State
│
└── tool-call.input
    └── structured JSON
```

Therefore:

```text
tool-input-delta
≠
complete tool call
```

A complete tool invocation exists only once the `tool-call` event is available.

This distinction is reflected directly in the project's strict stream FSM.

------

# 40. Interleaved Tool Input

Different tool-input IDs are independently addressable:

```text
tool A start
tool B start
tool A delta
tool B delta
tool A end
tool A call
tool B end
tool B call
```

The use of explicit:

```text
id
```

on incremental events permits multiple tool-input streams to coexist logically.

This is why consumers should identify tool state by ID rather than assume one globally open tool buffer.

------

# 41. `tool-result` Stream Event

CommandCode also exposes a recognized stream event:

```text
tool-result
```

The current frozen normalizer intentionally treats this event as:

```text
recognized
but payload-opaque
```

rather than assigning required generic fields.

Observed raw variants may carry fields such as:

```text
toolCallId
output
status
```

but these are not part of the strict normalized contract in the current protocol crate.

This stream event is distinct from the historical request-side:

```text
ContentBlock.type = "tool-result"
```

even though both refer to tool-result semantics.

------

# 42. Step Completion

## 42.1 `finish-step` Tree

```text
finish-step
│
├── finishReason?
└── usage?
    └── JSON value
```

Normalized type:

```ts
{
  type: "finish-step"

  finishReason?: string

  usage?: unknown
}
```

Both fields are optional in the raw normalized event contract.

Observed raw events may additionally contain:

```text
rawFinishReason
providerMetadata
response
```

These are preserved by the loose raw event representation but are not required fields of `CcEvent::FinishStep`.

------

## 42.2 Example

```text
data: {
  "type": "finish-step",

  "finishReason": "stop",

  "usage": {
    "inputTokens": 7583,
    "outputTokens": 25,
    "inputTokenDetails": {
      "cacheReadTokens": 7424,
      "cacheWriteTokens": 0
    }
  },

  "providerMetadata": {...},

  "response": {...}
}
```

------

# 43. Final Finish Event

## 43.1 `finish` Tree

```text
finish
│
├── finishReason
│   └── string
│
└── totalUsage
    └── Usage
```

Unlike `finish-step`, the frozen `finish` event requires:

```text
finishReason
totalUsage
```

to exist.

------

# 44. Usage

## 44.1 Core Normalized Usage Tree

The strict normalized usage retained by the project is:

```text
Usage
│
├── inputTokens
├── outputTokens
└── inputTokenDetails
    ├── cacheReadTokens
    └── cacheWriteTokens
```

Exact core type:

```ts
interface Usage {
  inputTokens: number

  outputTokens: number

  inputTokenDetails: {
    cacheReadTokens: number

    cacheWriteTokens: number
  }
}
```

The strict type intentionally does **not** flatten cache usage into top-level:

```text
cacheRead
cacheWrite
```

fields.

------

# 45. Extended Observed Usage

Actual `totalUsage` payloads may contain more data than the normalized core needs:

```text
totalUsage
│
├── inputTokens
│
├── inputTokenDetails
│   ├── noCacheTokens?
│   ├── cacheReadTokens
│   └── cacheWriteTokens?
│
├── outputTokens
│
├── outputTokenDetails?
│   ├── textTokens?
│   └── reasoningTokens?
│
├── totalTokens?
│
├── reasoningTokens?
│
└── cachedInputTokens?
```

An observed example:

```json
{
  "inputTokens": 7583,

  "outputTokens": 25,

  "inputTokenDetails": {
    "noCacheTokens": 100,
    "cacheReadTokens": 7424,
    "cacheWriteTokens": 0
  },

  "outputTokenDetails": {
    "textTokens": 25,
    "reasoningTokens": 0
  },

  "totalTokens": 7608,

  "reasoningTokens": 0,

  "cachedInputTokens": 7424
}
```

The repository's strict normalized `CcUsage` deliberately retains only the stable subset required by its protocol consumers.

------

# 46. Finish Reasons

## 46.1 Core Observed Values

The protocol documentation identifies these as normal CommandCode finish-reason values:

```text
finishReason
│
├── stop
├── end_turn
│
├── tool-calls
│
└── Length Family
    ├── length
    ├── max_tokens
    ├── max-tokens
    └── max_output_tokens
```

Their broad semantic classes are:

```text
stop / end_turn
└── natural completion

tool-calls
└── model requests tool execution

length / max-token variants
└── output ended because of a generation limit
```

------

## 46.2 Compatibility Values

The current downstream mappings additionally recognize several aliases seen across compatible upstream behavior:

```text
Tool aliases
├── tool_calls
├── tool_use
├── function_call
└── function_calls

End-turn alias
└── end-turn

Stop-sequence aliases
├── stop_sequence
└── stop-sequence

Pause aliases
├── pause_turn
└── pause-turn

Refusal / Safety family
├── refusal
├── content_filter
├── content-filter
├── safety
└── blocked
```

These should be treated as **compatibility/observed aliases**, not as evidence that every value is part of the canonical CommandCode schema.

------

# 47. Error Event

## 47.1 Error Tree

```text
error
│
├── Error Payload
│   ├── error
│   │   ├── string
│   │   └── object
│   │       └── message
│   │
│   └── fallback message?
│
└── code?
```

The normalized representation is:

```ts
{
  type: "error"

  message: string

  code?: string
}
```

The wire parser accepts multiple observed error shapes:

```json
{
  "type": "error",
  "error": "Something failed",
  "code": "..."
}
```

or:

```json
{
  "type": "error",
  "error": {
    "message": "Something failed"
  },
  "code": "..."
}
```

or a top-level:

```json
{
  "type": "error",
  "message": "Something failed"
}
```

When no usable message is found, the normalized message becomes:

```text
Unknown error
```

------

# 48. Terminal Semantics

## 48.1 Semantic Terminal Tree

At the normalized CommandCode stream level:

```text
Terminal
│
├── Success
│   └── finish
│
└── Failure
    └── error
```

The runtime SSE reader treats exactly these normalized events as semantic terminal events:

```text
finish
error
```

Once either is received, the CommandCode event stream ends.

------

# 49. `[DONE]` Sentinel

The transport may subsequently emit:

```text
data: [DONE]
```

However:

```text
[DONE]
```

is **not** the semantic success event.

The expected relationship is:

```text
finish
  │
  ▼
semantic success already established

[DONE]
  │
  ▼
transport framing sentinel
```

The current strict reader explicitly treats `[DONE]` received **before** a semantic `finish` or `error` as:

```text
stream ended before terminal event
```

rather than successful completion.

This is one of the most important CommandCode stream invariants.

------

# 50. EOF Semantics

Normal transport completion alone is also insufficient.

```text
EOF
│
├── semantic terminal already received
│   └── valid stream completion
│
└── no finish/error received
    └── incomplete stream
```

The current reader rejects EOF without `finish` or `error` as:

```text
EndedBeforeTerminal
```

and records metadata such as:

```text
last event type
last payload type
whether [DONE] was seen
```

without logging raw content.

------

# 51. Malformed Event Semantics

The raw event parser is intentionally loose about:

```text
unknown fields
unknown event types
```

but strict about the required fields of **known** event types.

For example:

```text
text-delta
└── requires text:string
tool-input-start
├── requires id:string
└── requires toolName:string
tool-call
├── requires toolCallId:string
├── requires toolName:string
└── requires input
finish
├── requires finishReason:string
└── requires totalUsage
```

Missing required fields cause event normalization failure.

------

# 52. Unknown Events

The raw wire representation deliberately preserves unknown event types:

```text
UnknownEvent
└── event_type
    └── original string
```

The normalized representation is:

```ts
{
  type: "Unknown",
  eventType: string
}
```

Conceptually:

```text
wire event
{
  "type": "future-new-event",
  ...
}

        ↓

Unknown {
  event_type:
    "future-new-event"
}
```

This indicates that the CommandCode wire protocol should be considered evolvable.

The raw parser does not reject a future event merely because its `type` string is unknown.

------

# 53. Raw Event vs Normalized Event

There are two layers in the observed protocol implementation:

```text
Wire JSON
│
└── RawCcSseEvent
    │
    ├── type?
    └── all additional fields
          │
          ▼
Normalization
          │
          ▼
CcEvent
```

The raw event representation is intentionally:

```text
open / forward-compatible
```

while known normalized event variants are:

```text
strict about required fields
```

This distinction is useful when interpreting the protocol.

------

# 54. Complete Text Stream Example

A minimal normal text response can be represented as:

```text
data: {"type":"start"}

data: {"type":"start-step"}

data: {"type":"text-start"}

data: {"type":"text-delta","text":"Hello"}

data: {"type":"text-delta","text":" world"}

data: {"type":"text-end"}

data: {
  "type":"finish-step",
  "finishReason":"stop",
  "usage":{
    "inputTokens":100,
    "outputTokens":10,
    "inputTokenDetails":{
      "cacheReadTokens":0,
      "cacheWriteTokens":0
    }
  }
}

data: {
  "type":"finish",
  "finishReason":"stop",
  "totalUsage":{
    "inputTokens":100,
    "outputTokens":10,
    "inputTokenDetails":{
      "cacheReadTokens":0,
      "cacheWriteTokens":0
    }
  }
}

data: [DONE]
```

Semantic structure:

```text
Stream
├── start
├── step
│   ├── start-step
│   ├── text
│   │   ├── text-start
│   │   ├── text-delta*
│   │   └── text-end
│   └── finish-step
└── finish
```

------

# 55. Complete Reasoning + Text Stream

```text
start

start-step

reasoning-start
reasoning-delta*
reasoning-end

text-start
text-delta*
text-end

finish-step

finish

[DONE]
```

Hierarchically:

```text
Generation Step
│
├── ReasoningBlock
│   ├── start
│   ├── delta*
│   └── end
│
├── TextBlock
│   ├── start
│   ├── delta*
│   └── end
│
└── finish-step
```

Reasoning and visible text are independent content lifecycles.

------

# 56. Complete Tool Call Stream

A normal tool-call response follows:

```text
start
│
start-step
│
tool-input-start
│   ├── id
│   └── toolName
│
tool-input-delta*
│   └── JSON fragments
│
tool-input-end
│
tool-call
│   ├── toolCallId
│   ├── toolName
│   └── structured input
│
finish-step
│
finish
│
[DONE]
```

Example:

```text
data: {"type":"start"}

data: {"type":"start-step"}

data: {
  "type":"tool-input-start",
  "id":"toolu_01ABC",
  "toolName":"read",
  "dynamic":false
}

data: {
  "type":"tool-input-delta",
  "id":"toolu_01ABC",
  "delta":"{\"file_path\":\"src/"
}

data: {
  "type":"tool-input-delta",
  "id":"toolu_01ABC",
  "delta":"main.ts\"}"
}

data: {
  "type":"tool-input-end",
  "id":"toolu_01ABC"
}

data: {
  "type":"tool-call",
  "toolCallId":"toolu_01ABC",
  "toolName":"read",
  "input":{
    "file_path":"src/main.ts"
  }
}

data: {
  "type":"finish-step",
  "finishReason":"tool-calls",
  "usage":{...}
}

data: {
  "type":"finish",
  "finishReason":"tool-calls",
  "totalUsage":{...}
}

data: [DONE]
```

------

# 57. Stream State Model

The observed CommandCode event stream can be modeled hierarchically as:

```text
NOT_STARTED
    │
    │ start
    ▼
STREAM_RUNNING
    │
    ├── STEP*
    │   │
    │   ├── start-step
    │   │
    │   ├── CONTENT*
    │   │   │
    │   │   ├── TEXT
    │   │   │   ├── text-start
    │   │   │   ├── text-delta*
    │   │   │   └── text-end
    │   │   │
    │   │   ├── REASONING
    │   │   │   ├── reasoning-start
    │   │   │   ├── reasoning-delta*
    │   │   │   └── reasoning-end
    │   │   │
    │   │   └── TOOL
    │   │       ├── tool-input-start
    │   │       ├── tool-input-delta*
    │   │       ├── tool-input-end
    │   │       └── tool-call
    │   │
    │   ├── provider-metadata*
    │   └── finish-step
    │
    ├── finish
    │      ▼
    │   SUCCESS
    │
    └── error
           ▼
        FAILURE
```

`[DONE]` is transport framing outside this semantic state machine.

------

# 58. Request-Side Tool Lifecycle

The request-side historical tool protocol is:

```text
AssistantMessage
│
└── ToolCallBlock
    │
    ├── toolCallId
    ├── toolName
    └── input
         │
         ▼
Tool execution
         │
         ▼
ToolMessage
└── ToolResultBlock
    ├── toolCallId
    ├── toolName?
    └── output
```

The response-side tool-generation protocol is:

```text
tool-input-start
↓
tool-input-delta*
↓
tool-input-end
↓
tool-call
```

These two representations describe different lifecycle phases:

```text
SSE tool events
= generation of a new tool call

request tool-call / tool-result blocks
= persisted conversation history
```

------

# 59. Request vs Stream Content Relationship

The protocol has corresponding request-history and response-stream concepts:

| Request history      | Response stream                         |
| -------------------- | --------------------------------------- |
| `type:"text"`        | `text-start/delta/end`                  |
| `type:"reasoning"`   | `reasoning-start/delta/end`             |
| `type:"tool-call"`   | `tool-input-*` + `tool-call`            |
| `type:"tool-result"` | no required generated-result equivalent |
| `type:"image"`       | input only in current frozen contract   |

The request-side blocks are completed semantic values.

The streaming events represent incremental construction of new assistant output.

------

# 60. Core Protocol Invariants

## 60.1 Request Hierarchy

```text
GenerateRequest
├── runtime/project context
└── params
    └── generation semantics
```

These are distinct information domains.

------

## 60.2 Message Content

```text
Message.content
```

is always represented as an array in the frozen wire type.

------

## 60.3 Tool Identity

Historical request relationship:

```text
tool-call.toolCallId
=
tool-result.toolCallId
```

Streaming relationship:

```text
tool-input-start.id
=
tool-input-delta.id
=
tool-input-end.id
=
tool-call.toolCallId
```

------

## 60.4 Partial Tool Input

```text
tool-input-delta.delta
```

is incomplete stream state.

```text
tool-call.input
```

is completed structured semantic input.

They must not be conflated.

------

## 60.5 Text Lifecycle

Normal text content follows:

```text
text-start
↓
text-delta*
↓
text-end
```

------

## 60.6 Reasoning Lifecycle

Normal reasoning follows:

```text
reasoning-start
↓
reasoning-delta*
↓
reasoning-end
```

------

## 60.7 Semantic Terminal

```text
finish
```

is successful terminal state.

```text
error
```

is failed terminal state.

------

## 60.8 `[DONE]` Is Not Success

```text
[DONE]
```

alone does not establish a successful CommandCode generation.

A semantic terminal event must already have occurred.

------

## 60.9 EOF Is Not Success

Transport EOF before:

```text
finish
or
error
```

is an incomplete stream.

------

## 60.10 Known Events Are Strict

Known event types have required field contracts.

Malformed known events are protocol errors rather than silently interpreted using legacy field aliases.

For example, tool events specifically use:

```text
id
toolName
delta
toolCallId
input
```

The current parser explicitly rejects legacy guessing such as:

```text
args
arguments
name
text
```

when those are not the defined fields for the event.

------

## 60.11 Unknown Events Are Extensible Wire Data

Unknown `type` values are preserved by the raw parser.

Therefore:

```text
unknown event type
≠
malformed known event
```

They are separate protocol conditions.

------

# 61. Complete Protocol Hierarchy

```text
                    COMMANDCODE /alpha/generate

                              │
               ┌──────────────┴──────────────┐
               │                             │
            REQUEST                       RESPONSE
               │                             │
               ▼                             ▼

        GenerateRequest             CommandCode Event Stream
               │                             │
      ┌────────┴────────┐           ┌────────┴───────────┐
      │                 │           │                    │
Runtime Context       Params      Lifecycle            Content
      │                 │           │                    │
      │        ┌────────┼───────┐   │         ┌──────────┼─────────┐
      │        │        │       │   │         │          │         │
    config   messages  tools controls         Text    Reasoning    Tool
      │        │                         │      │          │         │
      │   ┌────┼────┐                   │  start/delta/end │  input lifecycle
      │   │    │    │                   │                 │         │
      │ user assist tool                │                 │    tool-call
      │   │    │    │                   │                 │
      │   ▼    ▼    ▼                   │                 │
      │ content blocks                  │                 │
      │                                 │                 │
      └─────────────────────────────────┼─────────────────┘
                                        │
                                  finish-step
                                        │
                                      finish
                                        │
                                     SUCCESS

                                 error → FAILURE

                             [DONE] = transport sentinel
```

------

# 62. Canonical Mental Model

The CommandCode protocol can be reduced to four structural layers:

```text
Layer 1 — Execution Context

config
memory
taste
skills
permissionMode
threadId


Layer 2 — Model Invocation

params
├── model
├── system
├── messages
├── tools
└── generation controls


Layer 3 — Incremental Assistant Construction

text lifecycle
reasoning lifecycle
tool-input lifecycle


Layer 4 — Completion

finish-step
↓
finish

or

error
```

The core wire contract is therefore:

```text
Execution Context
+
Conversation / Tools / Generation Parameters
        │
        ▼
CommandCode Model
        │
        ▼
Incremental Event Stream
        │
        ├── text
        ├── reasoning
        └── tool calls
        │
        ▼
finish / error
```

This hierarchy represents the observed CommandCode `/alpha/generate` request and streaming-response protocol.