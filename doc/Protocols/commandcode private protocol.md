# CommandCode Private Protocol

**Version:** 0.2
**Protocol:** CommandCode Private Generate Protocol
**Primary Endpoint:** `POST /alpha/generate`
**Transport:** HTTP + JSON request / event-stream response
**Status:** Reverse-engineered private protocol
**Purpose:** Source-backed specification of the CommandCode request, response, event lifecycle, and observed CommandCode client producer behavior.

This document describes the CommandCode private protocol itself.

It defines:

- the upstream HTTP endpoint;
- request headers;
- request JSON structure;
- project/config context;
- message and content block structures;
- tool definitions and tool identity;
- response stream framing;
- CommandCode stream events;
- usage and termination semantics;
- observed CommandCode client field-generation behavior.

It does **not** define:

- how another protocol maps into CommandCode;
- client model routing;
- model aliases or fallback routing;
- downstream client authentication;
- local model-discovery APIs;
- application-specific session policy;
- application-specific retry, timeout, or cancellation policy;
- application-specific response rendering.

Because CommandCode is a private protocol, this specification distinguishes verified wire facts from reconstructed client behavior and unknown server-side requirements.

------

# 1. Scope and Evidence

## 1.1 Protocol Boundary

The observed CommandCode inference interaction is:

```text
HTTP Request
│
├── POST /alpha/generate
├── Request Headers
└── JSON Body
    ├── mode?
    ├── config
    ├── memory
    ├── taste
    ├── skills
    ├── permissionMode
    ├── threadId
    └── params
        ├── model
        ├── system
        ├── messages[]
        ├── tools[]
        ├── max_tokens
        ├── stream
        ├── reasoning_effort?
        └── temperature?

                ↓

         CommandCode Service

                ↓

HTTP Response
└── Event Stream
    ├── start / step events
    ├── text events
    ├── reasoning events
    ├── tool events
    ├── usage / finish-step
    └── terminal
        ├── finish
        └── error
```

The observed API origin is:

```text
https://api.commandcode.ai
```

The primary generation path is:

```text
/alpha/generate
```

Therefore the observed production endpoint is:

```text
https://api.commandcode.ai/alpha/generate
```

Whether alternate origins are accepted is outside the established protocol evidence.

The reconstructed core request does not require a top-level `mode`, but captured CommandCode traffic includes an observed optional `mode` extension such as `custom-agent` and `title-gen`. This extension is documented separately in Appendix A and should not be confused with a universally required core field.

------

## 1.2 Evidence Classes

Because this is a private protocol, every important claim belongs to one of four evidence classes.

### Captured Wire

A structure or value directly observed in captured CommandCode HTTP or SSE traffic.

Example:

```text
config.environment = "win32"
```

Captured wire evidence is the strongest evidence available in this specification, but it still proves only that the observed service/client exchange used that shape or value. It does not prove that every alternate value would be rejected.

### Observed Client Behavior

A value or derivation observed from a CommandCode or CommandCode-compatible client implementation or capture.

Example:

```text
x-cli-environment = "production"
```

This describes what an observed producer sends.

It does **not** prove that the server rejects every other value.

### Reconstructed Contract / Producer Behavior

A structure or algorithm reconstructed from strict wire types, compatibility source, capture parity, and source-backed fixtures.

Examples:

```text
params.messages[].content is reconstructed as an array.

project root
→ lowercase path segments
→ "-" joined x-project-slug
```

This evidence is useful for implementing a compatible producer or parser, but reconstructed representability must not be promoted into a server guarantee. For example, a local type such as `serde_json::Value` proves that the implementation can represent arbitrary JSON; it does not prove that the CommandCode service accepts every possible JSON shape.

### Unknown

The available evidence does not establish a closed rule.

Examples:

```text
all possible permissionMode values
all possible finishReason values
complete provider-metadata schema
complete error payload schema
```

A compatible implementation should preserve these unknowns rather than inventing closed enums without evidence.

------

## 1.3 Naming and Casing

CommandCode uses mixed naming conventions.

Examples:

```text
Request root
├── permissionMode     camelCase
├── threadId           camelCase
└── params.max_tokens  snake_case

Content blocks
├── toolCallId         camelCase
├── toolName           camelCase
└── mimeType           camelCase

Tool definition
└── input_schema       snake_case

Events
├── type = "text-delta"
├── type = "tool-input-start"
└── finishReason       camelCase
```

Field names and discriminator strings should therefore be preserved exactly.

Do not normalize casing globally.

------

# 2. HTTP Transport

## 2.1 Request

Method:

```http
POST /alpha/generate
```

Request body media type:

```http
Content-Type: application/json
```

The body is one JSON object described in Chapter 4.

------

## 2.2 Response

Observed successful generation responses use an event-stream transport:

```http
Content-Type: text/event-stream
```

The canonical observed framing carries JSON events in SSE `data:` fields:

```text
data: {"type":"text-delta","text":"Hello"}
```

The reconstructed strict consumer also accepts a bare JSON event line inside the event-stream body:

```text
{"type":"text-delta","text":"Hello"}
```

This alternate physical framing should be treated as a transport/compatibility observation rather than as a different semantic protocol. The semantic event object is still identified by its JSON `type` field.

SSE comments and metadata lines such as blank lines, `:`, `event:`, `id:`, and `retry:` do not themselves constitute CommandCode semantic events.

The semantic event protocol is described in Chapters 7 and 8.

### 2.2.1 Early / Non-Event Error Bodies

Compatibility handling also recognizes that an upstream response may begin with a plain JSON error object, for example an object carrying `error` or `success: false`, without a CommandCode event `type`. The complete server-side schema for these early/non-event error bodies is not established and is therefore outside the closed event schema in Chapter 7.

------

# 3. Request Headers

## 3.1 Header Hierarchy

Observed CommandCode-compatible requests contain:

```text
Request Headers
│
├── Authentication
│   └── Authorization
│
├── HTTP Representation
│   ├── Content-Type
│   ├── Accept
│   └── Accept-Encoding
│
├── CommandCode Client Metadata
│   ├── x-command-code-version
│   ├── x-cli-environment
│   ├── x-taste-learning
│   └── x-co-flag
│
├── Request / Conversation Identity
│   └── x-session-id
│
├── Project Identity
│   └── x-project-slug?
│
├── Trace Context
│   └── traceparent
│
└── Generic Client Metadata
    ├── User-Agent
    ├── accept-language
    └── sec-fetch-mode
```

------

## 3.2 Header Field Contract

| Header                   | Wire Type | Observed Presence | Observed Value / Meaning        |
| ------------------------ | --------- | ----------------- | ------------------------------- |
| `Authorization`          | string    | yes               | `Bearer <credential>`           |
| `Content-Type`           | string    | yes               | `application/json`              |
| `Accept`                 | string    | yes               | `*/*`                           |
| `Accept-Encoding`        | string    | yes               | `br, gzip, deflate`             |
| `x-command-code-version` | string    | yes               | observed client version         |
| `x-cli-environment`      | string    | yes               | observed `"production"`         |
| `x-taste-learning`       | string    | yes               | producer-dependent; observed `"false"` and `"true"` |
| `x-co-flag`              | string    | yes               | observed `"false"`              |
| `x-session-id`           | string    | yes               | opaque request/session identity |
| `x-project-slug`         | string    | conditional       | project identity                |
| `traceparent`            | string    | yes               | trace context                   |
| `User-Agent`             | string    | yes               | observed `"cli"`                |
| `accept-language`        | string    | yes               | observed `"*"`                  |
| `sec-fetch-mode`         | string    | yes               | observed `"cors"`               |

Unless explicitly stated otherwise, “observed presence” describes the reconstructed compatible producer profile rather than a proven server-required-header list.

------

## 3.3 `Authorization`

Observed format:

```http
Authorization: Bearer <credential>
```

The value authenticates the caller to the CommandCode upstream service.

The credential itself is opaque to this protocol.

Its storage, acquisition, rotation, or selection is outside the wire contract.

------

## 3.4 HTTP Representation Headers

Observed values:

```http
Content-Type: application/json
Accept: */*
Accept-Encoding: br, gzip, deflate
```

These values are part of the observed CommandCode client request profile.

------

## 3.5 `x-command-code-version`

Type:

```text
string
```

Observed value in the reconstructed baseline:

```text
1.7.0
```

Example:

```http
x-command-code-version: 1.7.0
```

This identifies the CommandCode client/protocol version presented upstream.

The available evidence does not establish that the server requires exactly `1.7.0`.

Implementations should therefore treat the value as a compatibility/version parameter rather than a permanently fixed protocol literal.

------

## 3.6 CommandCode Client Metadata

Observed producer profiles include:

```http
x-cli-environment: production
x-co-flag: false
```

`x-taste-learning` is producer-controlled rather than a fixed protocol literal. Observed profiles include at least:

```text
commandcode-router producer
└── x-taste-learning: false

pi CommandCode provider profile
└── x-taste-learning: true
```

Therefore `false` must not be treated as a universal CommandCode server requirement.

The available evidence does not establish the full allowed value space for these headers.

------

## 3.7 `x-session-id`

Type:

```text
string
```

Example:

```http
x-session-id: 5a0df440-c8f0-4cea-b159-c9e401408e07
```

Semantically it carries an opaque conversation/request identity.

The private protocol does not expose an algorithm for deriving the value from another client protocol.

A compatibility producer must generate or obtain an opaque identity string appropriate to its own request/session model. Its lifetime and stability are producer policy, not an established CommandCode wire requirement.

### Observed relationship

The reconstructed producer profile uses the same logical thread identity for:

```text
x-session-id
```

and:

```text
request.threadId
```

Whether the CommandCode server strictly requires equality is not established.

Therefore:

```text
same value
```

is a useful compatibility profile, not a formally proven server invariant.

------

## 3.8 `x-project-slug`

Type:

```text
string
```

The header identifies project context.

Example:

```http
x-project-slug: d-project-example
```

Observed project-aware requests include it.

The exact server behavior when the header is omitted is not established by the core private protocol evidence.

### Reconstructed producer derivation

The compatibility producer algorithm is:

```text
project root
↓
trim surrounding whitespace
↓
replace "\" with "/"
↓
normalize Windows extended path prefix
↓
lowercase
↓
split on "/"
↓
discard empty segments
↓
strip trailing ":" from path components
↓
join components with "-"
```

Examples:

```text
D:\project\example
→ d-project-example

D:/project/app
→ d-project-app

//?/D:/project/app
→ d-project-app

/home/user/project
→ home-user-project

//?/UNC/server/share/app
→ unc-server-share-app
```

Important representation:

```text
D:\project\app
```

produces:

```text
d-project-app
```

not:

```text
/d/project/app
```

------

## 3.9 `traceparent`

Observed format follows the W3C traceparent shape:

```text
00-{trace-id}-{span-id}-01
```

where:

```text
trace-id
= 32 lowercase hexadecimal characters
= 16 bytes

span-id
= 16 lowercase hexadecimal characters
= 8 bytes
```

Example:

```text
00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

Reconstructed producer behavior generates new random trace and span identifiers for each upstream request.

------

## 3.10 Generic Client Metadata

Observed values:

```http
User-Agent: cli
accept-language: *
sec-fetch-mode: cors
```

These belong to the observed CommandCode client profile.

The available evidence does not establish whether they are semantically required by the service.

------

# 4. Request Body

## 4.1 Request Hierarchy

The reconstructed request object is:

```text
CommandCodeRequest
│
├── mode?                  # observed extension; not required by reconstructed core type
├── config
│   └── CcConfig
│
├── memory
├── taste
├── skills
│
├── permissionMode
├── threadId
│
└── params
    └── CcParams
        ├── model
        ├── system
        ├── messages[]
        ├── tools[]
        ├── max_tokens
        ├── stream
        ├── reasoning_effort?
        └── temperature?
```

Conceptual TypeScript representation:

```ts
interface CommandCodeRequest {
  // observed extension in some captures; not required by reconstructed core type
  mode?: string

  config: CcConfig

  memory: unknown
  taste: unknown
  skills: unknown

  permissionMode: string
  threadId: string

  params: CcParams
}
```

------

## 4.2 Top-Level Field Contract

| Field            | Wire Type  | Observed Presence | Meaning / Evidence                                           |
| ---------------- | ---------- | ----------------- | ------------------------------------------------------------ |
| `mode`           | string     | conditional       | observed client-mode extension; not part of reconstructed core type, we can ignore mode |
| `config`         | object     | yes               | environment/project context                                  |
| `memory`         | JSON value | yes               | opaque context field                                         |
| `taste`          | JSON value | yes               | opaque context field                                         |
| `skills`         | JSON value | yes               | opaque context field                                         |
| `permissionMode` | string     | yes               | permission/execution mode                                    |
| `threadId`       | string     | yes               | opaque thread identity                                       |
| `params`         | object     | yes               | model invocation                                             |

------

## 4.3 `memory`

Reconstructed representation:

```text
JSON value
```

This means the compatibility implementation can represent arbitrary JSON at this field. It does **not** establish that the CommandCode service accepts every possible non-null JSON shape.

Observed baseline value:

```json
null
```

The available evidence establishes that `null` is used by the compatibility profile.

It does not establish the full schema accepted by the server for non-null `memory`.

Therefore a minimal compatible producer may use:

```json
"memory": null
```

unless it has separate evidence for richer memory semantics.

------

## 4.4 `taste`

Reconstructed representation:

```text
JSON value
```

The non-null server schema is not established; representability in the compatibility implementation is not evidence of universal server acceptance.

Observed baseline:

```json
"taste": null
```

The non-null schema is not established.

------

## 4.5 `skills`

Reconstructed representation:

```text
JSON value
```

The non-null server schema is not established; representability in the compatibility implementation is not evidence of universal server acceptance.

Observed baseline:

```json
"skills": null
```

The non-null schema is not established.

------

## 4.6 `permissionMode`

Wire type:

```text
string
```

Observed value:

```text
auto-accept
```

Example:

```json
{
  "permissionMode": "auto-accept"
}
```

The complete allowed value set is not established by the available evidence.

Therefore the protocol should not define a closed `permissionMode` enum without additional captures.

------

## 4.7 `threadId`

Wire type:

```text
string
```

Example:

```json
{
  "threadId": "5a0df440-c8f0-4cea-b159-c9e401408e07"
}
```

It identifies the logical generation thread.

The value is opaque.

The server-visible wire protocol does not define how a caller must derive it from another protocol or local session object.

------

# 4.8 `config`

## 4.8.1 Structure

```ts
interface CcConfig {
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

Hierarchy:

```text
config
│
├── Environment
│   ├── workingDir
│   ├── date
│   └── environment
│
├── Project Structure
│   └── structure[]
│
└── Git Context
    ├── isGitRepo
    ├── currentBranch
    ├── mainBranch
    ├── gitStatus
    └── recentCommits[]
```

The field names and casing are part of the reconstructed wire structure.

------

## 4.8.2 Field Contract

| Field           | Type     | Meaning                         |
| --------------- | -------- | ------------------------------- |
| `workingDir`    | string   | project working directory       |
| `date`          | string   | current date context            |
| `environment`   | string   | operating-system environment    |
| `structure`     | string[] | project-root entries            |
| `isGitRepo`     | boolean  | whether root is a Git work tree |
| `currentBranch` | string   | current Git branch              |
| `mainBranch`    | string   | inferred main/default branch    |
| `gitStatus`     | string   | Git porcelain status text       |
| `recentCommits` | string[] | recent one-line Git commits     |

------

## 4.8.3 `workingDir`

Wire type:

```text
string
```

Observed representation preserves a normal native path string.

Example Windows capture form:

```json
{
  "workingDir": "D:\\project\\example"
}
```

There is no evidence that the field itself uses the hyphenated `x-project-slug` representation.

Therefore:

```text
workingDir
```

and:

```text
x-project-slug
```

are distinct representations.

------

## 4.8.4 `date`

Wire type:

```text
string
```

Observed format:

```text
YYYY-MM-DD
```

Example:

```text
2026-08-09
```

Reconstructed producer generation:

```text
current UTC date
↓
YYYY-MM-DD
```

The use of UTC is part of the reconstructed compatible producer profile.

------

## 4.8.5 `environment`

Wire type:

```text
string
```

Observed examples:

```text
win32
darwin
linux
```

Reconstructed producer mapping:

```text
Windows
→ win32

macOS
→ darwin

other platform
→ platform identifier
```

Windows capture evidence confirms:

```json
{
  "environment": "win32"
}
```

------

## 4.8.6 `structure`

Wire type:

```text
string[]
```

Meaning:

> Names of entries directly below `workingDir`.

The reconstructed producer profile does **not** recursively enumerate the entire project tree.

Generation:

```text
read workingDir
↓
take immediate children
↓
convert entry name to string
↓
filter excluded entries
↓
sort
↓
limit
```

### Hidden Entries

Entries whose names begin with:

```text
.
```

are excluded by the reconstructed producer.

Examples:

```text
.git
.github
.claude
.cc
.env
```

### Reconstructed Directory Exclusion Set

Observed/reconstructed compatibility logic excludes directories including:

```text
node_modules
.git
.cc
dist
build
.next
.nuxt
.output
__pycache__
.venv
venv
```

Because hidden entries are already filtered by name, several entries above are excluded by more than one rule.

### Ordering

Entries are sorted lexicographically by the reconstructed producer.

### Limit

The reconstructed limit is:

```text
500 entries
```

### Example

```json
{
  "structure": [
    "README.md",
    "package.json",
    "scripts",
    "src",
    "tsconfig.json"
  ]
}
```

These generation rules describe the reconstructed CommandCode-compatible client profile.

The available evidence does not prove that the server itself rejects a differently generated `structure`.

------

## 4.8.7 `isGitRepo`

Wire type:

```text
boolean
```

Reconstructed generation command:

```text
git -C <workingDir> rev-parse --is-inside-work-tree
```

Producer interpretation:

```text
command succeeds
→ true

command fails
→ false
```

Example:

```json
{
  "isGitRepo": true
}
```

------

## 4.8.8 `currentBranch`

Wire type:

```text
string
```

Reconstructed producer command:

```text
git -C <workingDir> branch --show-current
```

Then:

```text
trim stdout
```

Example:

```json
{
  "currentBranch": "main"
}
```

If Git does not provide a branch name, the reconstructed profile can produce:

```text
""
```

for example under detached HEAD.

------

## 4.8.9 `mainBranch`

Wire type:

```text
string
```

Reconstructed producer resolution:

```text
1. git symbolic-ref refs/remotes/origin/HEAD

2. if stdout starts with "refs/remotes/origin/":
   strip that prefix and return the branch name

3. otherwise, if symbolic-ref produced a non-empty string:
   preserve and return that non-empty string

4. otherwise probe:
   main
   master

5. if no candidate is resolved:
   ""
```

Candidate probing uses:

```text
git rev-parse --verify <candidate>
```

The compatibility implementation accepts a candidate when it resolves to a 40-character Git object ID.

This is a reconstructed producer algorithm, not a proven server validation rule.

------

## 4.8.10 `gitStatus`

Wire type:

```text
string
```

Observed/reconstructed source:

```text
git -C <workingDir> status --porcelain=v1
```

The complete stdout string is then:

```text
trimmed once
```

If the trimmed output is empty, the reconstructed profile uses:

```text
Working tree clean
```

### Whole-String Trim Behavior

This produces an important representation detail.

Raw Git output:

```text
 D input.txt
 M output.txt
```

After trimming the **whole string**:

```text
D input.txt
 M output.txt
```

The first line loses the leading whitespace at the beginning of the entire string.

Later lines keep their leading whitespace.

This behavior has capture/parity evidence and should be reproduced by implementations targeting close CommandCode CLI compatibility.

Do **not** trim every line independently.

------

## 4.8.11 `recentCommits`

Wire type:

```text
string[]
```

Reconstructed command:

```text
git -C <workingDir> log -3 --oneline
```

Processing:

```text
split by line
↓
trim line
↓
drop empty line
```

Maximum normal result:

```text
3 entries
```

Example:

```json
{
  "recentCommits": [
    "c89c728 Initial commit",
    "a18b332 Add protocol fixtures"
  ]
}
```

------

## 4.8.12 Representative `config`

```json
{
  "workingDir": "D:\\project\\example",
  "date": "2026-08-09",
  "environment": "win32",
  "structure": [
    "README.md",
    "package.json",
    "src"
  ],
  "isGitRepo": true,
  "currentBranch": "main",
  "mainBranch": "main",
  "gitStatus": "M src/index.ts",
  "recentCommits": [
    "abc1234 fix: example"
  ]
}
```

This example illustrates the observed/reconstructed project-aware producer profile.

------

# 4.9 `params`

## 4.9.1 Structure

```ts
interface CcParams {
  model: string
  system: string

  messages: CcMessage[]
  tools: CcToolDefinition[]

  max_tokens: number
  stream: boolean

  reasoning_effort?: "high" | "max"
  temperature?: number
}
```

Hierarchy:

```text
params
│
├── Model
│   ├── model
│   ├── max_tokens
│   └── reasoning_effort?
│
├── Prompt
│   ├── system
│   └── messages[]
│
├── Tools
│   └── tools[]
│
└── Generation
    ├── stream
    └── temperature?
```

------

## 4.9.2 `model`

Wire type:

```text
string
```

Example observed model identifiers include:

```text
deepseek/deepseek-v4-pro
deepseek/deepseek-v4-flash
Qwen/Qwen3.7-Flash
gpt-5.6-luna
```

The protocol only establishes that the field carries the target upstream model identifier.

How a caller selects that identifier is outside the CommandCode wire contract.

------

## 4.9.3 `system`

Wire type:

```text
string
```

Example:

```json
{
  "system": "You are a coding assistant."
}
```

The field is a single string.

The reconstructed `CcParams` schema does not use a structured system-block array.

------

## 4.9.4 `max_tokens`

Wire type:

```text
integer
```

Observed values depend on the selected model/request.

Examples include:

```text
32000
64000
```

The private wire protocol does not establish how a caller must select the value.

It is therefore best treated as:

```text
caller-supplied model invocation limit
```

rather than as one universal constant.

------

## 4.9.5 `stream`

Wire type:

```text
boolean
```

Observed generation requests use:

```json
{
  "stream": true
}
```

The response protocol documented here is therefore based on the streaming form.

Whether all CommandCode server behavior for:

```json
{
  "stream": false
}
```

is equivalent or supported has not been established by the available evidence.

------

## 4.9.6 `reasoning_effort`

Wire field:

```text
reasoning_effort
```

Optional.

Reconstructed strict values:

```text
high
max
```

Example:

```json
{
  "reasoning_effort": "max"
}
```

The available evidence supports these values in the reconstructed baseline.

It does not establish whether future/alternate CommandCode versions accept additional values.

------

## 4.9.7 `temperature`

Wire type:

```text
number
```

Optional.

Example:

```json
{
  "temperature": 0.3
}
```

The protocol does not establish a universal default.

If omitted, the server/provider behavior is not defined by the evidence in this specification.

------

# 4.10 Messages

## 4.10.1 Message Structure

```ts
interface CcMessage {
  role: string
  content: CcContentBlock[]
}
```

Hierarchy:

```text
CcMessage
├── role
└── content[]
    └── CcContentBlock
```

Important structural rule:

```text
content
```

is an array in the reconstructed wire representation.

There is no established string shorthand.

------

## 4.10.2 Roles

Observed roles include:

```text
user
assistant
tool
```

The wire type itself stores the role as a string rather than a closed enum.

Therefore a parser should preserve unknown role strings rather than inventing an unsupported closed server enum.

A role should not be declared valid solely because the underlying implementation type is `string`; observed roles and theoretically representable strings are different evidence classes.

------

## 4.10.3 Content Block Hierarchy

```text
CcContentBlock
│
├── Text
│   └── type = "text"
│
├── Reasoning
│   └── type = "reasoning"
│
├── Image
│   └── type = "image"
│
├── Tool Call
│   └── type = "tool-call"
│
└── Tool Result
    └── type = "tool-result"
```

------

## 4.10.4 Text Block

Structure:

```json
{
  "type": "text",
  "text": "Hello"
}
```

Field contract:

| Field  | Type             | Presence |
| ------ | ---------------- | -------- |
| `type` | literal `"text"` | required |
| `text` | string           | required |

------

## 4.10.5 Reasoning Block

Structure:

```json
{
  "type": "reasoning",
  "text": "Reasoning content"
}
```

Field contract:

| Field  | Type                  | Presence |
| ------ | --------------------- | -------- |
| `type` | literal `"reasoning"` | required |
| `text` | string                | required |

The reasoning content property is:

```text
text
```

not:

```text
thinking
```

or:

```text
reasoning
```

------

## 4.10.6 Image Block

Structure:

```text
ImageBlock
├── type = "image"
├── image
└── mimeType
```

Example:

```json
{
  "type": "image",
  "image": "data:image/png;base64,iVBORw0KGgo...",
  "mimeType": "image/png"
}
```

`image` contains a complete data URL:

```text
data:<mime-type>;base64,<base64-data>
```

`mimeType` separately carries the MIME type.

Field contract:

| Field      | Type              | Presence |
| ---------- | ----------------- | -------- |
| `type`     | literal `"image"` | required |
| `image`    | string            | required |
| `mimeType` | string            | required |

------

## 4.10.7 Tool Call Block

Structure:

```text
ToolCallBlock
├── type = "tool-call"
├── toolCallId
├── toolName
└── input
```

Example:

```json
{
  "type": "tool-call",
  "toolCallId": "toolu_01ABC",
  "toolName": "read",
  "input": {
    "file_path": "src/index.ts"
  }
}
```

Field contract:

| Field        | Type                  | Presence |
| ------------ | --------------------- | -------- |
| `type`       | literal `"tool-call"` | required |
| `toolCallId` | string                | required |
| `toolName`   | string                | required |
| `input`      | JSON value            | required |

The reconstructed representation permits `input` to carry a JSON value. Observed coding-tool invocations are object-shaped; acceptance of arbitrary non-object input by the service is not established.

The discriminator uses:

```text
tool-call
```

while the identity/name fields use camelCase.

------

## 4.10.8 Tool Result Block

Structure:

```text
ToolResultBlock
├── type = "tool-result"
├── toolCallId
├── toolName?
└── output
    ├── type
    └── value
```

Example success:

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

Example failure:

```json
{
  "type": "tool-result",
  "toolCallId": "toolu_01ABC",
  "toolName": "read",
  "output": {
    "type": "error-text",
    "value": "tool failed"
  }
}
```

Field contract:

| Field          | Type                      | Presence |
| -------------- | ------------------------- | -------- |
| `type`         | literal `"tool-result"`   | required |
| `toolCallId`   | string                    | required |
| `toolName`     | string                    | optional |
| `output`       | object                    | required |
| `output.type`  | `"text"` / `"error-text"` | required |
| `output.value` | string                    | required |

------

## 4.10.9 Tool Identity

The conversation-level identity relationship is:

```text
assistant tool-call
└── toolCallId = X

        ↓

tool result
└── toolCallId = X
```

Therefore:

```text
tool-call.toolCallId
=
tool-result.toolCallId
```

is the reconstructed semantic pairing rule.

A compatible producer should preserve the ID exactly.

------

# 4.11 Tool Definitions

## 4.11.1 Structure

```ts
interface CcToolDefinition {
  name: string
  description?: string
  input_schema: unknown
}
```

Hierarchy:

```text
CcToolDefinition
├── name
├── description?
└── input_schema
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

The wire field is:

```text
input_schema
```

not:

```text
inputSchema
```

The reconstructed CommandCode tool definition does not require an outer OpenAI-style `function` wrapper. `input_schema` is represented generically by the compatibility implementation, while observed usage is JSON-Schema-like object data; the complete accepted schema language is not established.

------

# 4.12 Representative Core Request

The following is a neutral representative request using only the reconstructed protocol structures:

```json
{
  "config": {
    "workingDir": "D:\\project\\example",
    "date": "2026-08-09",
    "environment": "win32",
    "structure": [
      "README.md",
      "package.json",
      "src"
    ],
    "isGitRepo": true,
    "currentBranch": "main",
    "mainBranch": "main",
    "gitStatus": "M src/index.ts",
    "recentCommits": [
      "abc1234 fix: example"
    ]
  },

  "memory": null,
  "taste": null,
  "skills": null,

  "permissionMode": "auto-accept",

  "threadId": "5a0df440-c8f0-4cea-b159-c9e401408e07",

  "params": {
    "model": "deepseek/deepseek-v4-pro",

    "system": "You are a coding assistant.",

    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Read src/index.ts"
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
    "stream": true,
    "reasoning_effort": "max",
    "temperature": 0.3
  }
}
```

Representative observed header profile:

```http
POST /alpha/generate

Authorization: Bearer <credential>
Content-Type: application/json
Accept: */*
Accept-Encoding: br, gzip, deflate

x-command-code-version: 1.7.0
x-cli-environment: production
x-taste-learning: false
x-co-flag: false

x-session-id: 5a0df440-c8f0-4cea-b159-c9e401408e07
x-project-slug: d-project-example

traceparent: 00-<32hex>-<16hex>-01

User-Agent: cli
accept-language: *
sec-fetch-mode: cors
```

------

# 5. Observed CommandCode Client Producer Profile

This chapter describes behavior useful for reproducing an observed CommandCode-compatible client.

It is deliberately separated from the wire schema.

These rules describe **how a known compatible producer constructs fields**.

They do not prove that the CommandCode server requires every rule.

------

## 5.1 Field Provenance

```text
Observed Literal / Stable Values in the Router-Compatible Producer Profile
├── Content-Type = application/json
├── Accept = */*
├── Accept-Encoding = br, gzip, deflate
├── x-cli-environment = production
├── x-co-flag = false
├── User-Agent = cli
├── accept-language = *
├── sec-fetch-mode = cors
├── memory = null
├── taste = null
└── skills = null

Producer-Dependent Metadata
└── x-taste-learning
    ├── false  (commandcode-router profile)
    └── true   (observed pi CommandCode provider profile)

Per-Request Generated
└── traceparent

Project-Derived
├── x-project-slug
└── config
    ├── workingDir
    ├── structure
    ├── isGitRepo
    ├── currentBranch
    ├── mainBranch
    ├── gitStatus
    └── recentCommits

Time-Derived
└── config.date

Platform-Derived
└── config.environment

Conversation / Request Values
├── threadId
├── x-session-id
├── system
├── messages
└── tools

Invocation Parameters
├── model
├── max_tokens
├── reasoning_effort
├── temperature
└── stream
```

------

## 5.2 Project Context Generation

The reconstructed project-context producer executes approximately:

```text
project root
│
├── workingDir
│   └── original native path
│
├── date
│   └── current UTC YYYY-MM-DD
│
├── environment
│   └── OS mapping
│
├── structure
│   └── top-level filtered/sorted names
│
└── Git context
    ├── rev-parse --is-inside-work-tree
    ├── branch --show-current
    ├── symbolic-ref origin/HEAD
    ├── status --porcelain=v1
    └── log -3 --oneline
```

This is useful for producer parity.

It is not evidence that the server itself computes or validates the same data.

------

## 5.3 Project Slug Generation

Compatibility algorithm:

```text
native project path
↓
slash normalization
↓
lowercase
↓
segment normalization
↓
"-" join
↓
x-project-slug
```

Example:

```text
D:\Project\Example
→ d-project-example
```

------

## 5.4 Trace Generation

Compatibility algorithm:

```text
random 16-byte trace ID
+
random 8-byte span ID
↓
lowercase hex
↓
00-{trace-id}-{span-id}-01
```

------

## 5.5 Thread Identity

The wire fields are:

```text
x-session-id
threadId
```

The reconstructed compatibility profile sends the same logical thread identity in both locations.

The actual source of that identity is a caller responsibility.

This protocol intentionally does not prescribe:

- UUID generation;
- another protocol's session header;
- request-ID fallback;
- client-specific session resolution.

Those are outside the CommandCode private wire protocol.

------

# 6. Response Transport

## 6.1 Event-Stream Framing

Observed CommandCode events use an HTTP event-stream response. The canonical physical framing is an SSE `data:` line:

```text
data: {"type":"start"}

data: {"type":"text-delta","text":"Hello"}
```

Compatibility evidence and the reconstructed strict consumer also support a bare JSON event line inside the same event-stream body:

```text
{"type":"start"}

{"type":"text-delta","text":"Hello"}
```

The event payload is JSON in either case.

The primary semantic discriminator is:

```text
type
```

Known non-semantic framing/metadata includes:

```text
blank / whitespace-only line
: comment
event: ...
id: ...
retry: ...
```

These lines do not create CommandCode semantic events.

A transport sentinel may also appear as:

```text
[DONE]
```

or:

```text
data: [DONE]
```

Its semantics are described separately in §8.7. Bare JSON acceptance is documented here as an observed/compatibility transport behavior; it does not create a separate semantic event protocol.

------

## 6.2 Event Envelope

Conceptually:

```ts
interface CommandCodeEvent {
  type: string
  [field: string]: unknown
}
```

This conceptual form expresses only a wire property:

> Event payloads are JSON objects identified primarily by `type`, and observed events may contain additional fields.

It does not imply that `type` is optional for valid protocol events.

Known event structures are described below.

------

## 6.3 Stream Hierarchy

```text
CommandCode Stream
│
├── Stream / Step
│   ├── start
│   ├── start-step
│   ├── provider-metadata
│   └── finish-step
│
├── Text
│   ├── text-start
│   ├── text-delta*
│   └── text-end
│
├── Reasoning
│   ├── reasoning-start
│   ├── reasoning-delta*
│   └── reasoning-end
│
├── Tool Input
│   ├── tool-input-start
│   ├── tool-input-delta*
│   └── tool-input-end
│
├── Tool Invocation
│   └── tool-call
│
├── Tool Result Event
│   └── tool-result
│
└── Terminal
    ├── finish
    └── error
```

------

# 7. SSE Event Protocol

## 7.1 Event Summary

| Event               | Established Core Fields                   |
| ------------------- | ----------------------------------------- |
| `start`             | no core payload established               |
| `start-step`        | no core payload established               |
| `provider-metadata` | provider-specific payload                 |
| `text-start`        | no core payload established               |
| `text-delta`        | `text`                                    |
| `text-end`          | no core payload established               |
| `reasoning-start`   | no core payload established               |
| `reasoning-delta`   | `text`                                    |
| `reasoning-end`     | no core payload established               |
| `tool-input-start`  | `id`, `toolName`, optional `dynamic`      |
| `tool-input-delta`  | `id`, `delta`                             |
| `tool-input-end`    | `id`                                      |
| `tool-call`         | `toolCallId`, `toolName`, `input`         |
| `tool-result`       | schema not fully established              |
| `finish-step`       | optional `finishReason`, optional `usage` |
| `finish`            | `finishReason`, `totalUsage`              |
| `error`             | payload exists; complete shape not closed |

Additional fields may be present.

The table intentionally does not turn every compatibility-parser requirement into a claim about every possible upstream event.

------

# 7.2 Stream and Step Events

## 7.2.1 `start`

Example:

```json
{
  "type": "start"
}
```

This marks stream initialization in observed event sequences.

No additional stable payload schema is established here.

------

## 7.2.2 `start-step`

Example:

```json
{
  "type": "start-step"
}
```

This marks the beginning of a provider/model generation step.

The protocol evidence does not establish a required additional core payload.

Observed streams may additionally carry fields such as:

```text
request
warnings
```

These are observed optional payload fields, not established universal requirements, and consumers should preserve unknown additional fields at the raw protocol layer when lossless capture matters.

------

# 7.3 Text Lifecycle

## 7.3.1 Lifecycle

```text
text-start
↓
text-delta*
↓
text-end
```

------

## 7.3.2 `text-start`

Example:

```json
{
  "type": "text-start"
}
```

Additional metadata can exist, but no additional field is part of the established minimal contract in this specification.

------

## 7.3.3 `text-delta`

Structure:

```text
TextDelta
├── type = "text-delta"
└── text
```

Example:

```json
{
  "type": "text-delta",
  "text": "Hello"
}
```

`text` is incremental generated text.

Multiple events are concatenated in stream order for the corresponding text lifecycle.

------

## 7.3.4 `text-end`

Example:

```json
{
  "type": "text-end"
}
```

This closes the current text lifecycle.

------

# 7.4 Reasoning Lifecycle

## 7.4.1 Lifecycle

```text
reasoning-start
↓
reasoning-delta*
↓
reasoning-end
```

------

## 7.4.2 `reasoning-start`

Example:

```json
{
  "type": "reasoning-start"
}
```

------

## 7.4.3 `reasoning-delta`

Structure:

```text
ReasoningDelta
├── type = "reasoning-delta"
└── text
```

Example:

```json
{
  "type": "reasoning-delta",
  "text": "..."
}
```

The incremental reasoning property is named:

```text
text
```

------

## 7.4.4 `reasoning-end`

Example:

```json
{
  "type": "reasoning-end"
}
```

This closes the reasoning lifecycle.

------

# 7.5 Tool Input Lifecycle

## 7.5.1 Hierarchy

Tool generation is represented in two semantic stages:

```text
Incremental Tool Input
│
├── tool-input-start
├── tool-input-delta*
└── tool-input-end

        ↓

Completed Tool Invocation
└── tool-call
```

This is an important protocol distinction.

A sequence of tool-input fragments is not itself the completed tool call.

------

## 7.5.2 `tool-input-start`

Structure:

```text
ToolInputStart
├── type = "tool-input-start"
├── id
├── toolName
└── dynamic?
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

Established fields:

| Field      | Type     |
| ---------- | -------- |
| `id`       | string   |
| `toolName` | string   |
| `dynamic`  | boolean? |

------

## 7.5.3 `tool-input-delta`

Structure:

```text
ToolInputDelta
├── type = "tool-input-delta"
├── id
└── delta
```

Example:

```json
{
  "type": "tool-input-delta",
  "id": "toolu_01ABC",
  "delta": "{\"file_path\":\"src/"
}
```

followed by:

```json
{
  "type": "tool-input-delta",
  "id": "toolu_01ABC",
  "delta": "index.ts\"}"
}
```

`delta` is a serialized incremental fragment.

It is not the final structured input object.

------

## 7.5.4 `tool-input-end`

Structure:

```json
{
  "type": "tool-input-end",
  "id": "toolu_01ABC"
}
```

It closes the incremental input lifecycle associated with `id`.

------

## 7.5.5 `tool-call`

Structure:

```text
ToolCallEvent
├── type = "tool-call"
├── toolCallId
├── toolName
└── input
```

Example:

```json
{
  "type": "tool-call",
  "toolCallId": "toolu_01ABC",
  "toolName": "read",
  "input": {
    "file_path": "src/index.ts"
  }
}
```

This represents the completed semantic tool invocation.

The field names are:

```text
toolCallId
toolName
input
```

No alternate aliases are part of the established wire structure in this specification.

------

## 7.5.6 Incremental Preview vs Completed Input

The reconstructed compatibility consumer treats the concatenation of:

```text
tool-input-delta.delta
```

as a serialized preview of the eventual input. At `tool-input-end`, that preview can be parsed and validated as a JSON object when possible.

The later:

```text
tool-call.input
```

is the completed structured invocation payload and is semantically stronger than the partial stream fragments. Compatibility implementations may compare the assembled preview against the completed `tool-call` to detect mismatches.

Therefore:

```text
concatenated tool-input-delta fragments
≠ authoritative completed tool call
```

------

## 7.5.7 Tool Stream Identity

Observed compatible lifecycle:

```text
tool-input-start.id
=
tool-input-delta.id
=
tool-input-end.id
=
tool-call.toolCallId
```

This allows incremental fragments to be correlated with their eventual completed tool call.

A compatible stream consumer should therefore track incremental tool state by ID.

------

## 7.5.8 Interleaving and Concurrent Content Lifecycles

CommandCode content lifecycles are not guaranteed to be globally serialized into one open block at a time. Compatibility source explicitly accounts for multiple content/tool lifecycles being interleaved in one response stream.

A valid consumer therefore should not model the stream as only:

```text
one current block
```

Instead, it may need to track independent state by block kind and, for tool input, by ID.

Illustrative interleaving:

```text
reasoning-start
reasoning-delta

tool-input-start(A)

text-start

tool-input-delta(A)
text-delta
reasoning-delta

tool-input-end(A)
tool-call(toolCallId=A)

reasoning-end
text-end
```

This example is illustrative rather than a closed ordering grammar. The key protocol property is that start/delta/end identity must be preserved independently and that a consumer must not assume an arbitrary delta is a complete standalone block.

------

# 7.6 `provider-metadata`

Observed event:

```json
{
  "type": "provider-metadata",
  "providerMetadata": {
    "cai": {}
  }
}
```

The event type is established.

The internal schema of:

```text
providerMetadata
```

is provider-specific and not closed by the available evidence.

It should therefore be treated as opaque/extensible metadata.

------

# 7.7 `finish-step`

Structure:

```text
FinishStep
├── type = "finish-step"
├── finishReason?
└── usage?
```

Example:

```json
{
  "type": "finish-step",
  "finishReason": "stop",
  "usage": {
    "inputTokens": 7583,
    "outputTokens": 25,
    "inputTokenDetails": {
      "cacheReadTokens": 7424,
      "cacheWriteTokens": 0
    }
  }
}
```

The reconstructed event model allows:

```text
finishReason
usage
```

to be absent.

Observed streams may contain more than one generation step and therefore more than one `finish-step`.

`finish-step` is **not** the final message/stream success boundary.

------

# 7.8 `finish`

`finish` is the established successful semantic terminal event.

Structure:

```text
FinishEvent
├── type = "finish"
├── finishReason
├── totalUsage
└── rawFinishReason?   # observed optional extension; semantics not closed
```

Example:

```json
{
  "type": "finish",
  "finishReason": "stop",
  "totalUsage": {
    "inputTokens": 7583,
    "outputTokens": 25,
    "inputTokenDetails": {
      "cacheReadTokens": 7424,
      "cacheWriteTokens": 0
    }
  }
}
```

Observed finish events may also carry `rawFinishReason`. The current reconstructed semantic normalizer does not require or consume it, and its complete semantics are not established; it should therefore be treated as an optional observed extension rather than a core required field.

The important protocol distinction is:

```text
finish-step
→ step-level completion

finish
→ overall semantic terminal
```

------

# 7.9 `tool-result` Event

The event type:

```text
tool-result
```

is recognized in the reconstructed CommandCode event family.

The complete stable event payload schema has not been established by the available evidence.

Observed/compatibility payloads may carry fields such as:

```text
toolCallId
output
status
```

These names are useful evidence but are not promoted here into a closed required schema.

Therefore this specification does not invent one.

Consumers needing lossless compatibility should preserve the raw event payload.

------

# 7.10 `error`

The stream can terminate semantically with:

```text
type = "error"
```

The available compatibility evidence shows error payloads can carry message/code information, but the complete upstream wire schema is not sufficiently established to define one closed error object.

A safe conceptual form is:

```text
ErrorEvent
├── type = "error"
└── error-specific payload
```

Possible observed/compatibility fields include:

```text
error
message
code
```

The exact value representation should be preserved rather than aggressively normalized at the protocol boundary.

------

# 8. Usage and Termination

## 8.1 Usage Hierarchy

Observed usage data is carried primarily in:

```text
finish-step.usage
```

and:

```text
finish.totalUsage
```

A representative hierarchy is:

```text
Usage
│
├── inputTokens
├── outputTokens
│
├── inputTokenDetails
│   ├── noCacheTokens?
│   ├── cacheReadTokens?
│   └── cacheWriteTokens?
│
├── outputTokenDetails?
│   ├── textTokens?
│   └── reasoningTokens?
│
├── totalTokens?
├── reasoningTokens?
└── cachedInputTokens?
```

Not every observed event contains every field.

------

## 8.2 Core Observed Usage Fields

The most consistently reconstructed fields are:

```ts
interface CommandCodeUsageCore {
  inputTokens: number
  outputTokens: number

  inputTokenDetails?: {
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}
```

These are a useful implementation baseline.

However the wire object may carry additional fields.

The raw protocol specification should distinguish field presence on the wire from local normalization defaults. The current reconstructed Router normalizer may substitute numeric zero for some missing usage members when constructing its narrower `CcUsage` representation; that parser behavior does **not** prove that the corresponding raw wire members are required, nor that omission and zero are semantically identical upstream.

A protocol parser should not discard additional fields unless its application intentionally chooses a narrower semantic representation.

------

## 8.3 Extended Observed Usage

Observed/reconstructed upstream data may additionally include:

```text
noCacheTokens
textTokens
reasoningTokens
totalTokens
cachedInputTokens
```

Example conceptual object:

```json
{
  "inputTokens": 7583,
  "inputTokenDetails": {
    "noCacheTokens": 159,
    "cacheReadTokens": 7424,
    "cacheWriteTokens": 0
  },
  "outputTokens": 25,
  "outputTokenDetails": {
    "textTokens": 20,
    "reasoningTokens": 5
  },
  "totalTokens": 7608,
  "reasoningTokens": 5,
  "cachedInputTokens": 7424
}
```

This specification intentionally does not define parser-side default values for omitted fields.

Missing on the wire and numeric zero are different states unless additional CommandCode evidence proves otherwise.

------

## 8.4 `finishReason`

Wire type:

```text
string
```

Example verified by the documented event examples:

```text
stop
```

The complete CommandCode `finishReason` enum is **not established**.

Therefore the correct protocol model is:

```ts
type FinishReason = string
```

with known observed values recorded separately as evidence becomes available.

A compatible implementation should:

```text
preserve unknown finishReason strings
```

rather than collapsing them into a guessed closed enum.

Values accepted by unrelated downstream-compatibility code must not automatically be treated as CommandCode wire values.

------

## 8.5 Successful Terminal

The established successful semantic terminal is:

```text
finish
```

Conceptually:

```text
stream events
↓
finish
↓
successful CommandCode generation terminal
```

`finish-step` does not replace `finish`.

------

## 8.6 Error Terminal

The established semantic failure event is:

```text
error
```

Conceptually:

```text
stream events
↓
error
↓
upstream semantic failure
```

Application-level timeout, network failure, cancellation, or local parse failure are not CommandCode semantic events and therefore are not defined as protocol terminal variants here.

------

## 8.7 `[DONE]`

Compatibility/capture evidence includes a transport sentinel:

```text
[DONE]
```

or SSE form:

```text
data: [DONE]
```

where encountered.

It must be distinguished from:

```text
finish
```

The established semantic completion signal is the JSON:

```text
type = "finish"
```

event.

Therefore `[DONE]` should be treated as transport framing rather than a replacement for the semantic `finish` event.

In the reconstructed strict consumer, `[DONE]` encountered before a semantic `finish`/`error` terminal is treated as an ended-before-terminal condition rather than successful completion. This is a consumer safety rule consistent with the distinction above; it should not be reinterpreted as proof that every CommandCode server version always emits `[DONE]` after `finish`.

------

## 8.8 Physical EOF

EOF is a transport condition, not a JSON protocol event.

The protocol-level success evidence is:

```text
finish
```

Consequently a consumer seeking strict semantic completion should not infer a `finish` event merely because the transport ended.

The application-specific error assigned to premature EOF is outside this private protocol specification.

------

# 8.9 Typical Event Lifecycles

The following sequences are illustrative common lifecycles, not an exclusive global ordering grammar. Content/tool lifecycles may interleave as described in §7.5.8, and multi-step streams may repeat step-level boundaries.

## 8.9.1 Text Completion

```text
start
↓
start-step
↓
text-start
↓
text-delta*
↓
text-end
↓
finish-step
↓
finish
```

------

## 8.9.2 Reasoning + Text Completion

```text
start
↓
start-step
↓
reasoning-start
↓
reasoning-delta*
↓
reasoning-end
↓
text-start
↓
text-delta*
↓
text-end
↓
finish-step
↓
finish
```

------

## 8.9.3 Tool Invocation

```text
start
↓
start-step
↓
tool-input-start(id)
↓
tool-input-delta(id)*
↓
tool-input-end(id)
↓
tool-call(toolCallId=id)
↓
finish-step
↓
finish
```

------

## 8.9.4 Multi-Step Generation

Because:

```text
start-step
finish-step
```

are step-level events, the general structure can be understood as:

```text
start

↓
Step 1
├── start-step
├── content events
└── finish-step

↓
Step 2
├── start-step
├── content events
└── finish-step

↓
finish
```

where the number of steps depends on upstream behavior.

------

# 9. Protocol Invariants

## 9.1 Exact Field Naming

The protocol uses exact mixed casing.

Examples:

```text
permissionMode
threadId
max_tokens
reasoning_effort
toolCallId
toolName
mimeType
input_schema
finishReason
totalUsage
```

Do not globally camelCase or snake_case wire objects.

------

## 9.2 Message Content Is Structured

The reconstructed message representation is:

```text
message.content[]
```

not:

```text
message.content = string
```

Text itself is represented as:

```json
{
  "type": "text",
  "text": "..."
}
```

------

## 9.3 Content Block Type Is Semantic

Known block discriminators:

```text
text
reasoning
image
tool-call
tool-result
```

Each discriminator has its own field schema.

Do not flatten them into one generic text representation.

------

## 9.4 Tool Call Identity Is Stable

Historical conversation:

```text
tool-call.toolCallId
```

must remain associated with:

```text
tool-result.toolCallId
```

Streamed invocation:

```text
tool-input-*.id
```

must remain associated with the eventual:

```text
tool-call.toolCallId
```

when they describe the same invocation.

------

## 9.5 Tool Input Has Partial and Complete States

```text
tool-input-delta.delta
```

is serialized partial input.

```text
tool-call.input
```

is completed semantic input.

Therefore:

```text
partial tool input
≠
complete tool call
```

------

## 9.6 Text and Reasoning Have Explicit Lifecycles

Text:

```text
text-start
→ text-delta*
→ text-end
```

Reasoning:

```text
reasoning-start
→ reasoning-delta*
→ reasoning-end
```

Consumers should not treat an arbitrary delta as an independently complete block.

------

## 9.7 Step Completion and Stream Completion Differ

```text
finish-step
```

means:

```text
step boundary
```

while:

```text
finish
```

means:

```text
overall semantic terminal
```

They are not interchangeable.

------

## 9.8 Successful Terminal Is `finish`

The core semantic success rule is:

```text
SUCCESS
└── finish
```

Transport closure or `[DONE]` does not itself create a semantic `finish`.

------

## 9.9 Semantic Failure Is `error`

The upstream protocol failure terminal is:

```text
ERROR
└── error event
```

Network, timeout, local parser failure, or caller cancellation are separate transport/application states.

------

## 9.10 Forward-Compatibility Guidance for Unknown Values

The following are not established as permanently closed:

```text
role
permissionMode
finishReason
providerMetadata
error payload
extra usage fields
future event types
```

At the raw protocol layer, an implementation should prefer preserving unknown fields and unknown event-type strings over inventing unsupported mappings or silently collapsing them into known values.

A higher semantic conversion layer may still reject an unknown event when it cannot safely preserve downstream state-machine semantics. That stricter application behavior is distinct from the raw wire fact that the unknown value existed and should remain diagnosable.

------

# Appendix A. Observed Top-Level `mode` Extension

Captured CommandCode traffic indicates that some requests can carry an additional top-level:

```text
mode
```

field.

Observed values include:

```text
custom-agent
title-gen
```

Current provenance notes:

```text
custom-agent
└── observed in Claude Code CLI direct CommandCode traffic

title-gen
└── observed in CommandCode internal title-generation traffic

commandcode-router baseline producer
└── omits mode
```

Examples:

```json
{
  "mode": "custom-agent"
}
```

and:

```json
{
  "mode": "title-gen"
}
```

The baseline generate request does not require `mode` in the reconstructed core request type.

Therefore:

```text
mode
```

is best classified as:

> observed CommandCode client-mode extension

rather than a universally required `/alpha/generate` field.

The complete enum and semantics are not established.

------

# Appendix B. Evidence Gaps

The following areas remain intentionally open because the current evidence does not establish a complete contract:

```text
Transport
├── exact server/producer provenance of bare JSON event lines
└── exact relationship between `[DONE]` and semantic `finish` across producer/service versions

Headers
├── which observed metadata headers are server-required
├── complete accepted version/header value space
└── complete producer/server semantics of x-taste-learning

Request
├── non-null memory schema
├── non-null taste schema
├── non-null skills schema
├── complete permissionMode enum
├── server requirements for x-session-id/threadId equality
└── stream=false behavior

Messages
└── complete role enum

Model Invocation
├── complete supported model catalog
├── complete reasoning_effort enum across versions
└── server-side temperature semantics/defaults

Events
├── complete provider-metadata schema
├── complete optional start-step payload schema
├── complete tool-result event schema
├── complete error-event schema
├── complete rawFinishReason semantics
├── complete finishReason value set
├── exact constraints on interleaving content lifecycles
└── future/unknown event types

Usage
└── exact presence requirements for all extended usage fields

Extensions
├── complete mode enum and behavior
└── which producer modes require or omit mode
```

These gaps should remain explicit.

A private protocol specification becomes less reliable, not more reliable, when unknown behavior is silently filled in from unrelated compatibility code.

------

# Appendix C. Canonical Protocol Trees

## C.1 Request

```text
POST /alpha/generate
│
├── Headers
│   ├── Authorization
│   ├── Content-Type
│   ├── Accept
│   ├── Accept-Encoding
│   ├── x-command-code-version
│   ├── x-cli-environment
│   ├── x-taste-learning
│   ├── x-co-flag
│   ├── x-session-id
│   ├── x-project-slug?
│   ├── traceparent
│   ├── User-Agent
│   ├── accept-language
│   └── sec-fetch-mode
│
└── CommandCodeRequest
    │
    ├── mode?  (observed extension)
    │
    ├── config
    │   ├── workingDir
    │   ├── date
    │   ├── environment
    │   ├── structure[]
    │   ├── isGitRepo
    │   ├── currentBranch
    │   ├── mainBranch
    │   ├── gitStatus
    │   └── recentCommits[]
    │
    ├── memory
    ├── taste
    ├── skills
    ├── permissionMode
    ├── threadId
    │
    └── params
        │
        ├── model
        ├── system
        │
        ├── messages[]
        │   ├── role
        │   └── content[]
        │       ├── text
        │       ├── reasoning
        │       ├── image
        │       ├── tool-call
        │       └── tool-result
        │
        ├── tools[]
        │   ├── name
        │   ├── description?
        │   └── input_schema
        │
        ├── max_tokens
        ├── stream
        ├── reasoning_effort?
        └── temperature?
```

------

## C.2 Response Stream

```text
CommandCode Stream
│
├── start
│
├── Step*
│   │
│   ├── start-step
│   │
│   ├── Content*
│   │   │
│   │   ├── Text
│   │   │   ├── text-start
│   │   │   ├── text-delta*
│   │   │   └── text-end
│   │   │
│   │   ├── Reasoning
│   │   │   ├── reasoning-start
│   │   │   ├── reasoning-delta*
│   │   │   └── reasoning-end
│   │   │
│   │   ├── Tool Input / Invocation
│   │   │   ├── tool-input-start
│   │   │   ├── tool-input-delta*
│   │   │   ├── tool-input-end
│   │   │   └── tool-call
│   │   │
│   │   └── Tool Result
│   │       └── tool-result
│   │
│   ├── provider-metadata*
│   └── finish-step
│
└── Terminal
    ├── finish
    └── error
```

------

# Appendix D. Minimal Implementation Surface

A compatible implementation benefits from separating the minimum **parser surface** from the minimum **semantic generation surface**.

## D.1 Parser Minimum

A parser that wants to recognize the reconstructed protocol without misclassifying known ignorable events should understand at minimum:

```text
HTTP / Framing
├── text/event-stream response
├── data: JSON event lines
├── observed bare JSON event lines
├── ignorable SSE metadata/comments
└── [DONE] transport sentinel

Known Event Discriminators
├── start
├── start-step
├── provider-metadata
├── text-start / text-delta / text-end
├── reasoning-start / reasoning-delta / reasoning-end
├── tool-input-start / tool-input-delta / tool-input-end
├── tool-call
├── tool-result
├── finish-step
├── finish
└── error

Forward Compatibility
└── preserve/diagnose unknown event type strings and extra raw fields
```

## D.2 Semantic Generation Minimum

An implementation that produces or consumes the core generation semantics needs at minimum:

```text
Request
├── headers
├── config
├── threadId
└── params
    ├── model
    ├── system
    ├── messages
    ├── tools
    ├── max_tokens
    ├── stream
    ├── reasoning_effort?
    └── temperature?

Message Content
├── text
├── reasoning
├── image
├── tool-call
└── tool-result

Stream Semantics
├── text lifecycle
├── reasoning lifecycle
├── interleaving-aware block tracking
├── tool-input lifecycle
├── completed tool-call
├── finish-step
├── finish
└── error
```

The producer profile additionally defines how to reproduce:

```text
config
x-project-slug
traceparent
observed metadata headers
```

without introducing unrelated routing, authentication, discovery, conversion, or application-session policy into the CommandCode private protocol itself.