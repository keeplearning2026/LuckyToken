# CommandCode `/alpha/generate` Wire Protocol

> Source-backed protocol reference for LuckyToken.
>
> This document describes the CommandCode upstream wire format as reconstructed from the current `commandcode-router` implementation, its strict wire types, runtime request generation, SSE parser, tests, fixtures, and captured Command Code CLI traffic.
>
> `docs/PROTOCOLS.md` is used as a reference draft, but source code and real capture fixtures are authoritative where they differ.

------

## 1. Scope and Evidence

### 1.1 Protocol boundary

The primary CommandCode inference endpoint is:

```text
POST /alpha/generate
```

Current default upstream:

```text
https://api.commandcode.ai/alpha/generate
```

The interaction is:

```text
HTTP Request
├── Headers
└── JSON Body
    ├── config
    ├── memory
    ├── taste
    ├── skills
    ├── permissionMode
    ├── threadId
    └── params

            ↓

     CommandCode upstream

            ↓

HTTP 200
└── text/event-stream
    └── CommandCode events
```

### 1.2 Evidence priority

This document uses the following evidence order:

1. strict CommandCode Rust wire types;
2. actual upstream request builder;
3. runtime request/context generation;
4. SSE parser and stream lifecycle implementation;
5. tests and golden/capture fixtures;
6. `docs/PROTOCOLS.md`.

Important source files include:

```text
crates/ccr-protocol/src/commandcode/types.rs
crates/ccr-protocol/src/commandcode/sse.rs

crates/ccr-runtime/src/handlers/router/pipeline.rs
crates/ccr-runtime/src/handlers/router/request_context.rs

crates/ccr-runtime/src/config_store.rs
crates/ccr-runtime/src/project_paths.rs
crates/ccr-runtime/src/request_thread.rs
crates/ccr-runtime/src/request_session.rs

crates/ccr-runtime/src/model_catalog.rs
crates/ccr-runtime/src/model_routing.rs

crates/ccr-runtime/src/streaming/commandcode_sse.rs

fixtures/runtime/cc-config-official-capture.json
```

The strict request shape is defined by `CommandCodeRequest`, `CcConfig`, `CcParams`, `CcMessage`, and `CcContentBlock`.

### 1.3 Wire fact vs producer policy

Two kinds of facts must not be confused.

**Wire contract** describes the structure actually exchanged with CommandCode, for example:

```text
threadId
params.model
params.messages
toolCallId
toolName
input_schema
finishReason
totalUsage
```

**Current CCR producer policy** describes how `commandcode-router` chooses values, for example:

```text
x-taste-learning = false
memory = null
permissionMode default = auto-accept
params.stream = true
temperature fallback = 0.3
```

LuckyToken can preserve producer policy for compatibility without assuming the CommandCode server accepts no other value.

------

# 2. HTTP Endpoint

## 2.1 Base URL

Current configuration contains:

```json
{
  "commandCode": {
    "apiBaseUrl": "https://api.commandcode.ai",
    "version": "1.7.0"
  }
}
```

The endpoint is constructed as:

```text
trimTrailingSlash(apiBaseUrl)
+ "/alpha/generate"
```

Therefore:

```text
https://api.commandcode.ai
→ https://api.commandcode.ai/alpha/generate

https://api.commandcode.ai/
→ https://api.commandcode.ai/alpha/generate
```

The base URL is configuration-driven rather than a wire constant.

## 2.2 Method

```http
POST /alpha/generate
```

Request body:

```text
application/json
```

Current runtime expects a successful inference response to be an SSE response.

------

# 3. Request Headers

## 3.1 Header hierarchy

```text
Headers
├── Authentication
│   └── Authorization
│
├── HTTP representation
│   ├── Content-Type
│   ├── Accept
│   └── Accept-Encoding
│
├── CommandCode client metadata
│   ├── x-command-code-version
│   ├── x-cli-environment
│   ├── x-taste-learning
│   └── x-co-flag
│
├── Request identity
│   ├── x-session-id
│   └── traceparent
│
├── Project identity
│   └── x-project-slug?
│
└── Generic client metadata
    ├── User-Agent
    ├── accept-language
    └── sec-fetch-mode
```

The current upstream request builder creates this set directly.

## 3.2 Header field table

| Header                   | Presence                     | Classification        | Current value / generation     |
| ------------------------ | ---------------------------- | --------------------- | ------------------------------ |
| `Authorization`          | required by current producer | dynamic secret        | `Bearer <CommandCode API key>` |
| `Content-Type`           | always                       | constant              | `application/json`             |
| `Accept`                 | always                       | constant              | `*/*`                          |
| `Accept-Encoding`        | always                       | constant              | `br, gzip, deflate`            |
| `x-command-code-version` | always                       | configuration         | `commandCode.version`          |
| `x-cli-environment`      | always                       | producer constant     | `production`                   |
| `x-taste-learning`       | always                       | producer policy       | `false`                        |
| `x-co-flag`              | always                       | producer policy       | `false`                        |
| `x-session-id`           | always                       | request-derived       | resolved upstream thread ID    |
| `x-project-slug`         | conditional                  | project-derived       | project slug                   |
| `traceparent`            | always                       | generated per request | W3C-style trace context        |
| `User-Agent`             | always                       | producer constant     | `cli`                          |
| `accept-language`        | always                       | producer constant     | `*`                            |
| `sec-fetch-mode`         | always                       | producer constant     | `cors`                         |

------

## 3.3 `Authorization`

Format:

```http
Authorization: Bearer <api-key>
```

The credential is the upstream CommandCode API key.

It is distinct from credentials used by a client to authenticate to LuckyToken/Router:

```text
Client credential
→ authenticates client to Router

CommandCode API key
→ authenticates Router to CommandCode
```

The current runtime reads the upstream credential from its secret store before constructing the request.

------

## 3.4 `x-command-code-version`

Type:

```text
string
```

Current bundled value:

```text
1.7.0
```

Source:

```text
router configuration
└── commandCode.version
```

The request builder sends the configured string directly.

It is therefore:

```text
configuration-driven
```

rather than generated per request.

------

## 3.5 `x-session-id`

Type:

```text
string
```

The current producer guarantees:

```text
header x-session-id
=
body threadId
```

Both receive the same resolved upstream thread ID.

Thread calculation is described in §6.

------

## 3.6 `x-project-slug`

### Presence

```text
project-bound request
→ header present

project-less request
→ header omitted
```

It is not sent as an empty string for project-less requests.

### Generation

Current function:

```text
project_root_to_cc_slug(projectRoot)
```

Algorithm:

```text
project root
↓
trim whitespace
↓
replace "\" with "/"
↓
normalize Windows extended-path prefix
↓
lowercase
↓
split by "/"
↓
discard empty components
↓
strip trailing ":" from components
↓
join with "-"
```

Examples:

```text
D:\project\commandcode-router
→ d-project-commandcode-router

D:/project/app
→ d-project-app

//?/D:/project/app
→ d-project-app

/home/user/project
→ home-user-project

//?/UNC/server/share/app
→ unc-server-share-app
```

### Important correction to the old documentation

The current source does **not** generate:

```text
/d/project/app
```

for `x-project-slug`.

That Git-Bash-style representation exists as a different path utility.

The actual current header value is:

```text
d-project-app
```

for `D:/project/app`.

------

## 3.7 `traceparent`

Generated once per upstream request.

Format:

```text
00-{trace-id}-{span-id}-01
```

where:

```text
trace-id = 16 random bytes = 32 hexadecimal characters
span-id  = 8 random bytes  = 16 hexadecimal characters
```

Example shape:

```text
00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

The implementation generates new random trace/span identifiers for every upstream request.

------

# 4. Request Body

## 4.1 Top-level structure

Exact structure:

```ts
interface CommandCodeRequest {
  config: CcConfig

  memory: unknown
  taste: unknown
  skills: unknown

  permissionMode: string
  threadId: string

  params: CcParams
}
```

Wire hierarchy:

```text
CommandCodeRequest
├── config
├── memory
├── taste
├── skills
├── permissionMode
├── threadId
└── params
```

## 4.2 Top-level field table

| Field            | Wire type  | Presence | Current producer         |
| ---------------- | ---------- | -------- | ------------------------ |
| `config`         | object     | always   | project context          |
| `memory`         | JSON value | always   | `null`                   |
| `taste`          | JSON value | always   | `null`                   |
| `skills`         | JSON value | always   | `null`                   |
| `permissionMode` | string     | always   | runtime configuration    |
| `threadId`       | string     | always   | resolved thread identity |
| `params`         | object     | always   | model invocation         |

------

## 4.3 `memory`, `taste`, `skills`

The strict type permits arbitrary JSON:

```ts
memory: unknown
taste: unknown
skills: unknown
```

The current Router producer always emits:

```json
{
  "memory": null,
  "taste": null,
  "skills": null
}
```

This establishes:

```text
current CCR producer behavior = null
```

It does **not** prove:

```text
CommandCode protocol requires these fields to be null
```

------

## 4.4 `permissionMode`

Type:

```text
string
```

Converter default:

```text
auto-accept
```

Before upstream transmission the runtime overwrites it using:

```text
runtime.permissionMode
```

Current bundled default:

```text
auto-accept
```

Therefore actual upstream generation is:

```text
permissionMode
=
current runtime.permissionMode
```

------

## 4.5 `threadId`

Type:

```text
string
```

This is request/conversation identity.

Current producer invariant:

```text
body.threadId
=
header.x-session-id
```

See §6 for calculation.

------

# 5. `config` — Project Context

## 5.1 Structure

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

The exact casing is part of the wire shape.

A repository fixture contains an actual captured Command Code CLI `config` object and validates this structure against the strict type.

------

## 5.2 Project context modes

Current Router has two producer modes:

```text
Project Context
├── Project-bound
│   └── dynamic filesystem/Git config
│
└── Project-less
    └── fixed empty config
```

Selection is based on:

```text
project exists?
```

rather than directly on credential type.

------

## 5.3 `workingDir`

Type:

```text
string
```

Project-bound calculation:

```text
workingDir = projectRoot
```

There is no Git-Bash-path conversion inside `build_cc_config()`.

An actual Command Code CLI capture contains:

```json
{
  "workingDir": "D:\\project\\commandcode protocol\\outputs"
}
```

Project-less value:

```text
""
```

------

## 5.4 `date`

Type:

```text
string
```

Format:

```text
YYYY-MM-DD
```

Calculation:

```text
current UTC time
↓
format("%Y-%m-%d")
```

Example:

```text
2026-08-07
```

This is a **UTC date**, not explicitly the local system calendar date.

The same calculation is used for project-bound and project-less configurations.

------

## 5.5 `environment`

Type:

```text
string
```

Normal project-bound calculation:

```text
OS identifier
↓
CommandCode mapping
```

Current mapping:

```text
windows → win32
macos   → darwin
other   → original platform name
```

Typical values:

```text
win32
darwin
linux
```

The official captured Windows config contains:

```json
{
  "environment": "win32"
}
```

Project-less value:

```text
""
```

------

## 5.6 `structure`

Type:

```text
string[]
```

Meaning:

> Names of entries directly under the project root.

It is **not recursive**.

Generation:

```text
read projectRoot directory
↓
take immediate children
↓
convert each file name to string
↓
exclude hidden entries
↓
exclude selected directories
↓
sort
↓
truncate to 500 entries
```

### Hidden-entry rule

Anything whose top-level name starts with `.` is discarded.

Examples:

```text
.git
.github
.claude
.cc
.env
```

### Explicit excluded directories

Current list:

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

The explicit list is checked for directories.

### Ordering

The remaining names are sorted.

### Limit

Maximum:

```text
500
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

The real CLI capture also verifies sorted top-level entries and hidden-entry exclusion.

Project-less value:

```json
[]
```

------

## 5.7 `isGitRepo`

Type:

```text
boolean
```

Calculation:

```text
git -C <projectRoot> rev-parse --is-inside-work-tree
```

Current implementation uses command success:

```text
exit success
→ true

command fails / non-zero
→ false
```

------

## 5.8 `currentBranch`

Type:

```text
string
```

If not a Git repository:

```text
""
```

Otherwise:

```text
git -C <projectRoot> branch --show-current
↓
trim
```

Example:

```text
main
```

Detached HEAD or command failure can produce an empty string.

------

## 5.9 `mainBranch`

Type:

```text
string
```

Only resolved for Git repositories.

Resolution order:

```text
1. git symbolic-ref refs/remotes/origin/HEAD

2. if successful:
   strip "refs/remotes/origin/"

3. otherwise probe:
   main
   master

4. if no usable candidate:
   ""
```

For candidate fallback:

```text
git rev-parse --verify main
git rev-parse --verify master
```

The current implementation accepts a candidate when the trimmed hash has length 40.

------

## 5.10 `gitStatus`

Type:

```text
string
```

It is a single string containing Git porcelain output.

Command:

```text
git -C <projectRoot> status --porcelain=v1
```

Then:

```text
stdout.trim()
```

If trimmed output is empty:

```text
Working tree clean
```

If the Git command itself fails:

```text
""
```

### Important official-client behavior

The entire stdout string is trimmed once.

This means a leading space on the **first** porcelain line disappears.

Raw:

```text
 D input.txt
 M outputs/readme.txt
```

Wire value:

```text
D input.txt
 M outputs/readme.txt
```

Later lines retain their leading status space.

This unusual behavior is intentionally reproduced because an actual Command Code CLI capture demonstrates it.

Therefore an implementation aiming for parity should **not trim every Git-status line independently**.

------

## 5.11 `recentCommits`

Type:

```text
string[]
```

Command:

```text
git -C <projectRoot> log -3 --oneline
```

Processing:

```text
split lines
↓
trim each line
↓
drop empty lines
```

Maximum normal length:

```text
3
```

Example:

```json
[
  "c89c728 Initial commit"
]
```

------

## 5.12 Complete project-bound `config`

```json
{
  "workingDir": "D:\\project\\LuckyToken",
  "date": "2026-08-09",
  "environment": "win32",
  "structure": [
    "AGENTS.md",
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

------

## 5.13 Project-less `config`

Project-less requests do not scan the filesystem and do not run Git.

Exact current producer shape:

```json
{
  "workingDir": "",
  "date": "2026-08-09",
  "environment": "",
  "structure": [],
  "isGitRepo": false,
  "currentBranch": "",
  "mainBranch": "",
  "gitStatus": "",
  "recentCommits": []
}
```

Only:

```text
date
```

is dynamic.

Project-less requests also omit `x-project-slug`.

------

# 6. Thread and Session Identity

## 6.1 Identity hierarchy

```text
Client session information
        ↓
Thread resolution policy
        ↓
upstreamThreadId
        ├── body.threadId
        └── header.x-session-id
```

## 6.2 Thread modes

Current configuration supports:

```text
clientSession
requestId
```

Bundled default:

```text
clientSession
```

### `requestId`

```text
threadId = Router request ID
```

regardless of client session headers.

### `clientSession`

```text
valid client session exists
→ threadId = client session ID

otherwise
→ threadId = Router request ID
```

------

## 6.3 Request ID

Router request IDs use UUID v4 string format.

Example:

```text
762c56a7-fc82-4178-9da5-ce6b1cc833d0
```

------

## 6.4 Current client-session sources

This is producer policy rather than CommandCode wire structure.

Anthropic-side requests:

```text
x-claude-code-session-id
x-session-affinity
```

OpenAI-side requests:

```text
x-session-id
```

Current resolution rules:

```text
no candidate
→ no client session

one usable candidate
→ use trimmed value

multiple candidates with identical value
→ use value

multiple conflicting candidates
→ reject session identity and fall back

empty value
→ fall back

invalid header value
→ fall back
```

------

# 7. `params` — Model Invocation

## 7.1 Structure

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

Wire hierarchy:

```text
params
├── Model Selection
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
└── Generation Controls
    ├── stream
    └── temperature?
```

------

## 7.2 `model`

Type:

```text
string
```

This is the resolved CommandCode model ID.

It is not necessarily the client's original requested model.

Current producer flow:

```text
client model
↓
ordered routing regex rules
↓
first matching rule
        OR
mandatory fallback
↓
target model
↓
params.model
```

Example target model IDs:

```text
deepseek/deepseek-v4-pro
deepseek/deepseek-v4-flash
Qwen/Qwen3.7-Flash
gpt-5.6-luna
```

------

## 7.3 Model routing semantics

Routing rules are evaluated in stored order.

```text
for rule in rules:
    if rule.regex matches trimmed client model:
        return rule target

return fallback target
```

An empty client model also falls back.

The fallback is mandatory.

------

## 7.4 `max_tokens`

Type:

```text
unsigned integer
```

Current producer rule:

```text
params.max_tokens
=
resolved model catalog.maxOutputTokens
```

It is **not currently copied from client `max_tokens`**.

Examples from the current bundled catalog:

| Target model                 | `max_tokens` |
| ---------------------------- | ------------ |
| `Qwen/Qwen3.7-Flash`         | 64000        |
| `deepseek/deepseek-v4-pro`   | 64000        |
| `deepseek/deepseek-v4-flash` | 32000        |
| `gpt-5.6-luna`               | 64000        |

This is an important correction to simplified documentation that describes `64000` as a universal default.

------

## 7.5 `reasoning_effort`

Wire key:

```text
reasoning_effort
```

Current known strict values:

```text
high
max
```

Generation:

```text
routing rule / fallback
└── reasoningEffort
        ↓
model resolution
        ↓
params.reasoning_effort
```

The current Router intentionally treats routing configuration as the authority rather than client reasoning-effort fields.

The routing compiler also verifies that the selected effort is supported by the target model.

The wire field is optional at the type level, but current conversion paths populate it.

------

## 7.6 `system`

Type:

```text
string
```

Always represented as a string.

Example:

```json
{
  "system": "You are a coding assistant."
}
```

No structured system-block array exists inside `CcParams`.

How Anthropic, OpenAI, or Pi system representations become this string belongs in conversion specifications rather than the CommandCode protocol itself.

------

## 7.7 `stream`

Type:

```text
boolean
```

At conversion time it may initially reflect the client value.

However, before the actual CommandCode request is transmitted, current Router handlers force:

```json
{
  "stream": true
}
```

Therefore the actual current upstream producer behavior is:

```text
CCR → CommandCode
params.stream = true
```

Client streaming preference affects downstream rendering, not whether CommandCode itself streams.

------

## 7.8 `temperature`

Type:

```text
number
```

Optional.

Generation:

```text
client temperature exists
→ use client value

otherwise configured temperatureFallback exists
→ use fallback

otherwise
→ omit field
```

Equivalent current logic:

```text
request.temperature ?? temperatureFallback
```

Current bundled fallback:

```text
0.3
```

Because serialization skips `None`, the key is completely absent when no temperature is selected.

------

# 8. Messages and Content Blocks

## 8.1 Message structure

```ts
interface CcMessage {
  role: string
  content: CcContentBlock[]
}
```

Important invariant:

```text
content is always an array
```

There is no string shorthand in the strict CommandCode representation.

------

## 8.2 Current roles

The wire type itself stores:

```text
role: string
```

Current producer paths primarily generate:

```text
user
assistant
tool
```

A `system` string value is also representable by the type.

Role should therefore not be assumed to be a closed server-side enum solely from the Rust type.

------

## 8.3 Content hierarchy

```text
content[]
├── text
├── reasoning
├── image
├── tool-call
└── tool-result
```

------

## 8.4 Text block

```json
{
  "type": "text",
  "text": "Hello"
}
```

Fields:

| Field  | Type   | Rule              |
| ------ | ------ | ----------------- |
| `type` | string | constant `"text"` |
| `text` | string | content           |

------

## 8.5 Reasoning block

```json
{
  "type": "reasoning",
  "text": "Reasoning content"
}
```

Fields:

| Field  | Type   | Rule                   |
| ------ | ------ | ---------------------- |
| `type` | string | constant `"reasoning"` |
| `text` | string | reasoning content      |

The content field is named:

```text
text
```

not `thinking`.

------

## 8.6 Image block

```json
{
  "type": "image",
  "image": "data:image/png;base64,iVBORw0KGgo...",
  "mimeType": "image/png"
}
```

Structure:

```text
image block
├── type = "image"
├── image
└── mimeType
```

`image` contains a data URL:

```text
data:<mime-type>;base64,<base64-data>
```

`mimeType` is separately present in camelCase.

------

## 8.7 Tool-call block

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

Fields:

| Field        | Type          | Required |
| ------------ | ------------- | -------- |
| `type`       | `"tool-call"` | yes      |
| `toolCallId` | string        | yes      |
| `toolName`   | string        | yes      |
| `input`      | JSON value    | yes      |

Notice the mixed naming style:

```text
type         → kebab-case value
toolCallId   → camelCase
toolName     → camelCase
```

------

## 8.8 Tool-result block

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

Structure:

```text
tool-result
├── type = "tool-result"
├── toolCallId
├── toolName?
└── output
    ├── type
    └── value
```

`toolName` is optional in the strict wire type.

Output types:

```text
text
error-text
```

Success example:

```json
{
  "type": "text",
  "value": "result"
}
```

Error example:

```json
{
  "type": "error-text",
  "value": "tool failed"
}
```

------

## 8.9 Tool identity invariant

Conversation history should preserve:

```text
tool-call.toolCallId
=
tool-result.toolCallId
```

Current Router runs tool-pair cleanup before producing the final upstream request.

That cleanup is a producer correctness mechanism; the basic wire requirement is that tool identity remains traceable.

------

# 9. Tool Definitions

## 9.1 Structure

```ts
interface CcToolDefinition {
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

Important wire naming:

```text
input_schema
```

not:

```text
inputSchema
```

There is also no required OpenAI-style wrapper:

```json
{
  "type": "function",
  "function": {}
}
```

Current converters normalize the top-level schema to an object schema before upstream transmission.

------

# 10. Complete Request Examples

## 10.1 Project-bound request

Representative shape:

```json
{
  "config": {
    "workingDir": "D:\\project\\LuckyToken",
    "date": "2026-08-09",
    "environment": "win32",
    "structure": [
      "AGENTS.md",
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

Relevant headers:

```http
Authorization: Bearer <command-code-api-key>

Content-Type: application/json
Accept: */*
Accept-Encoding: br, gzip, deflate

x-command-code-version: 1.7.0
x-cli-environment: production
x-taste-learning: false
x-co-flag: false

x-session-id: 5a0df440-c8f0-4cea-b159-c9e401408e07
x-project-slug: d-project-luckytoken

traceparent: 00-<32hex>-<16hex>-01

User-Agent: cli
accept-language: *
sec-fetch-mode: cors
```

------

## 10.2 Project-less request

```json
{
  "config": {
    "workingDir": "",
    "date": "2026-08-09",
    "environment": "",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },

  "memory": null,
  "taste": null,
  "skills": null,

  "permissionMode": "auto-accept",
  "threadId": "<resolved-thread-id>",

  "params": {
    "model": "deepseek/deepseek-v4-pro",
    "system": "",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Hello"
          }
        ]
      }
    ],
    "tools": [],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max",
    "temperature": 0.3
  }
}
```

There is no:

```text
x-project-slug
```

header.

------

# 11. Response Transport

## 11.1 Response type

Current Router expects the upstream inference response to use:

```http
Content-Type: text/event-stream
```

Response body is consumed as a stream of lines.

------

## 11.2 Accepted event framing

Standard SSE:

```text
data: {"type":"start"}

data: {"type":"text-delta","text":"Hello"}
```

Current parser also accepts bare JSON event lines:

```text
{"type":"start"}
{"type":"text-delta","text":"Hello"}
```

------

## 11.3 Ignored transport lines

The parser ignores:

```text
blank lines
whitespace-only lines

: comments

event: ...
id: ...
retry: ...
```

It also ignores non-JSON bare metadata lines.

------

## 11.4 Raw event envelope

Conceptually:

```ts
interface RawCcSseEvent {
  type?: string
  [key: string]: unknown
}
```

Extra fields are retained rather than rejected.

This provides wire-level forward compatibility.

Known event types are normalized more strictly.

------

# 12. SSE Event Protocol

## 12.1 Event hierarchy

```text
CommandCode Stream
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
├── Tool Lifecycle
│   ├── tool-input-start
│   ├── tool-input-delta
│   ├── tool-input-end
│   └── tool-call
│
├── tool-result
│
└── Terminal
    ├── finish
    └── error
```

Unknown event types remain representable separately.

------

## 12.2 Event field table

| Event               | Required fields                   | Optional / additional     |
| ------------------- | --------------------------------- | ------------------------- |
| `start`             | none                              | extra fields tolerated    |
| `start-step`        | none                              | metadata                  |
| `provider-metadata` | none in normalized core           | provider payload          |
| `text-start`        | none                              | metadata                  |
| `text-delta`        | `text: string`                    | extra fields              |
| `text-end`          | none                              | extra fields              |
| `reasoning-start`   | none                              | extra fields              |
| `reasoning-delta`   | `text: string`                    | extra fields              |
| `reasoning-end`     | none                              | extra fields              |
| `tool-input-start`  | `id`, `toolName`                  | `dynamic?: boolean`       |
| `tool-input-delta`  | `id`, `delta`                     | extra fields              |
| `tool-input-end`    | `id`                              | extra fields              |
| `tool-call`         | `toolCallId`, `toolName`, `input` | extra fields              |
| `finish-step`       | none                              | `finishReason?`, `usage?` |
| `finish`            | `finishReason`, `totalUsage`      | extra fields              |
| `error`             | flexible message source           | `code?`                   |
| `tool-result`       | none in normalized core           | raw data retained         |
| unknown             | `type`                            | raw fields retained       |

------

## 12.3 Text lifecycle

Normal text lifecycle:

```text
text-start
↓
text-delta*
↓
text-end
```

Delta example:

```json
{
  "type": "text-delta",
  "text": "Hello"
}
```

`text` is required for a known `text-delta`.

------

## 12.4 Reasoning lifecycle

```text
reasoning-start
↓
reasoning-delta*
↓
reasoning-end
```

Delta:

```json
{
  "type": "reasoning-delta",
  "text": "..."
}
```

Again, the incremental content field is named:

```text
text
```

------

## 12.5 Tool-input lifecycle

Tool generation has two semantic levels:

```text
Incremental tool input
├── tool-input-start
├── tool-input-delta*
└── tool-input-end

Completed semantic tool call
└── tool-call
```

This distinction is critical.

A `tool-input-delta` sequence is not itself a completed tool call.

------

### `tool-input-start`

```json
{
  "type": "tool-input-start",
  "id": "toolu_01ABC",
  "toolName": "read",
  "dynamic": false
}
```

Required:

```text
id
toolName
```

Optional:

```text
dynamic
```

------

### `tool-input-delta`

```json
{
  "type": "tool-input-delta",
  "id": "toolu_01ABC",
  "delta": "{\"file_path\":\"src/"
}
```

Followed by, for example:

```json
{
  "type": "tool-input-delta",
  "id": "toolu_01ABC",
  "delta": "index.ts\"}"
}
```

`delta` is a string fragment.

Do not treat it as already-parsed complete tool input.

------

### `tool-input-end`

```json
{
  "type": "tool-input-end",
  "id": "toolu_01ABC"
}
```

This ends the incremental input lifecycle for that ID.

------

### `tool-call`

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

Required exact fields:

```text
toolCallId
toolName
input
```

The strict parser does not replace these with legacy aliases such as:

```text
args
arguments
name
text
```

------

## 12.6 Tool identity

Expected lifecycle relationship:

```text
tool-input-start.id
=
tool-input-delta.id
=
tool-input-end.id
=
tool-call.toolCallId
```

A consumer should therefore track in-progress tools by ID.

Do not use one global tool-input buffer.

This also allows multiple tool inputs to be interleaved safely.

------

## 12.7 `provider-metadata`

Example possible shape:

```json
{
  "type": "provider-metadata",
  "providerMetadata": {
    "cai": {}
  }
}
```

Current core parser recognizes the event type but does not define a closed typed schema for provider metadata.

This should therefore be treated as provider-specific extensible metadata.

------

## 12.8 `finish-step`

Structure:

```text
finish-step
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

Both fields are optional at the current normalized event level.

A stream can contain more than one `finish-step`.

------

## 12.9 `finish`

`finish` is the normal successful semantic terminal event.

Shape:

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

Required:

```text
finishReason
totalUsage
```

------

# 13. Usage, Errors, and Terminal Semantics

## 13.1 Usage structure

Stable normalized core:

```ts
interface CcUsage {
  inputTokens: number
  outputTokens: number

  inputTokenDetails: {
    cacheReadTokens: number
    cacheWriteTokens: number
  }
}
```

------

## 13.2 Usage fallback values

When normalizing `finish.totalUsage`:

```text
missing inputTokens
→ 0

missing outputTokens
→ 0

missing inputTokenDetails
→ cacheReadTokens = 0
→ cacheWriteTokens = 0

missing cacheReadTokens
→ 0

missing cacheWriteTokens
→ 0
```

This is consumer normalization behavior, not proof that the server always omits or always supplies any of these fields.

------

## 13.3 Extended observed usage fields

Real upstream data can contain additional usage information such as:

```text
totalUsage
├── inputTokens
├── inputTokenDetails
│   ├── noCacheTokens
│   ├── cacheReadTokens
│   └── cacheWriteTokens
│
├── outputTokens
├── outputTokenDetails
│   ├── textTokens
│   └── reasoningTokens
│
├── totalTokens
├── reasoningTokens
└── cachedInputTokens
```

The current core model intentionally retains only:

```text
inputTokens
outputTokens
cacheReadTokens
cacheWriteTokens
```

Unknown/extra fields do not invalidate the event.

------

## 13.4 `finishReason`

Wire representation:

```text
string
```

The parser does not impose a closed enum at the CommandCode wire layer.

Observed/current compatibility values include families such as:

```text
normal
├── stop
├── end_turn
└── end-turn

tool
├── tool-calls
├── tool_calls
├── tool_use
├── function_call
└── function_calls

length
├── length
├── max_tokens
├── max-tokens
└── max_output_tokens

stop sequence
├── stop_sequence
└── stop-sequence

pause
├── pause_turn
└── pause-turn

refusal/safety
├── refusal
├── content_filter
├── content-filter
├── safety
└── blocked
```

These are observed/compatibility values rather than a formally established closed CommandCode enum.

------

## 13.5 Error events

Core normalized shape:

```ts
interface CommandCodeError {
  type: "error"
  message: string
  code?: string
}
```

Accepted message forms include:

### String `error`

```json
{
  "type": "error",
  "error": "Something failed"
}
```

### Object `error`

```json
{
  "type": "error",
  "error": {
    "message": "Something failed"
  }
}
```

### Top-level `message`

```json
{
  "type": "error",
  "message": "Something failed"
}
```

Optional:

```json
{
  "code": "..."
}
```

If no message can be extracted:

```text
Unknown error
```

------

## 13.6 Unknown events

For:

```json
{
  "type": "future-event",
  "anything": "..."
}
```

the raw event remains valid and is normalized as an unknown event carrying:

```text
future-event
```

Therefore:

```text
unknown event type
≠
malformed known event
```

Known event missing a required field is an error.

Unknown future event type is preserved.

------

## 13.7 `[DONE]`

The parser recognizes:

```text
data: [DONE]
```

and:

```text
[DONE]
```

However:

```text
[DONE]
```

is **transport framing**, not the successful CommandCode terminal.

Successful semantic completion requires:

```text
finish
```

A `[DONE]` encountered before `finish` or `error` is treated by the current runtime as:

```text
EndedBeforeTerminal
```

------

## 13.8 EOF

EOF is also not semantic success.

```text
finish
→ successful terminal

error
→ semantic failure

EOF before finish/error
→ incomplete stream
```

Current runtime reports an incomplete stream as:

```text
EndedBeforeTerminal
```

and retains diagnostic metadata such as the last event type.

------

## 13.9 Terminal rule

The source-backed semantic rule is:

```text
SUCCESS
└── finish

FAILURE
├── error
├── parse error
├── read/network error
├── timeout
├── cancellation
├── premature [DONE]
└── EOF before semantic terminal
```

The current stream reader stops after yielding `finish` or `error`.

------

## 13.10 Typical stream lifecycles

### Text

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

### Reasoning + text

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

### Tool call

```text
start
↓
start-step
↓
tool-input-start
↓
tool-input-delta*
↓
tool-input-end
↓
tool-call
↓
finish-step
↓
finish
```

------

# 14. `GET /v1/models` — Model Discovery Companion Contract

> This section is deliberately separated from `/alpha/generate`.
>
> `GET /v1/models` is a **client-facing commandcode-router discovery endpoint**.
>
> It is not evidence that `api.commandcode.ai` exposes the same endpoint.

## 14.1 Endpoint

```http
GET /v1/models
```

Purpose:

```text
Router model catalog
↓
filter visible models
↓
project capability metadata
↓
client model discovery
```

The implementation directly projects the current model catalog.

------

## 14.2 Authentication

The endpoint is protected by the Router authentication middleware.

Credential transport can be:

```http
Authorization: Bearer <token>
```

or:

```http
x-api-key: <token>
```

Authorization Bearer is checked first.

Because `/v1/models` does not map to one protocol, configured global Anthropic or OpenAI client credentials can satisfy the global-token path.

------

## 14.3 Query parameters

Current handler does not consume a pagination parameter.

For example:

```text
/v1/models
```

and:

```text
/v1/models?limit=1000
```

return the same visible catalog.

A test explicitly verifies this behavior.

------

## 14.4 Response hierarchy

```text
ModelsResponse
├── object = "list"
└── data[]
    └── ModelResponseEntry
        ├── id
        ├── object
        ├── type
        ├── owned_by
        ├── context_length
        ├── max_input_tokens
        ├── reasoning_efforts[]
        ├── input_modalities[]
        └── capabilities[]
```

Exact conceptual shape:

```ts
interface ModelsResponse {
  object: "list"
  data: ModelResponseEntry[]
}

interface ModelResponseEntry {
  id: string

  object: "model"
  type: "model"

  owned_by: string

  context_length: number
  max_input_tokens: number

  reasoning_efforts: string[]
  input_modalities: string[]
  capabilities: string[]
}
```

------

## 14.5 Visibility rule

A catalog model appears when:

```text
enabled == true
AND
advertised == true
```

There is no separate advertised-model list.

------

## 14.6 `id`

Source:

```text
catalog map key
```

Example:

```text
deepseek/deepseek-v4-pro
```

No display-name transformation is performed.

------

## 14.7 `object`

Constant:

```text
model
```

------

## 14.8 `type`

Constant:

```text
model
```

------

## 14.9 `owned_by`

Generation:

```text
model ID
↓
split at first "/"
↓
first component
```

Examples:

```text
Qwen/Qwen3.7-Flash
→ Qwen

deepseek/deepseek-v4-pro
→ deepseek

gpt-5.6-luna
→ gpt-5.6-luna
```

If no slash exists, the complete model ID is returned.

------

## 14.10 `context_length`

Direct projection:

```text
catalog.contextWindow
```

No calculation beyond serialization.

------

## 14.11 `max_input_tokens`

Direct projection:

```text
catalog.maxInputTokens
```

------

## 14.12 `reasoning_efforts`

Direct projection:

```text
catalog.reasoningEfforts
```

Current known values:

```text
high
max
```

An empty array means no reasoning capability according to the current catalog model.

------

## 14.13 `input_modalities`

Direct projection:

```text
catalog.capabilities.input
```

Current possible values:

```text
text
image
```

Current catalog validation requires text input.

------

## 14.14 `capabilities`

This field is derived.

Algorithm:

```text
capabilities = []

if reasoning_efforts is non-empty:
    capabilities.push("reasoning")

if catalog.capabilities.tools:
    capabilities.push("tools")
```

Therefore when both apply, current ordering is:

```json
[
  "reasoning",
  "tools"
]
```

------

## 14.15 Catalog information not exposed

The internal catalog also contains:

```text
enabled
advertised
maxOutputTokens
pricing
capabilities.output
```

These fields are not currently included in `/v1/models`.

For example:

```text
maxOutputTokens
```

still controls upstream `params.max_tokens`, even though discovery clients do not see it.

------

## 14.16 Ordering

The catalog uses an ordered map.

The handler iterates it directly.

Therefore the returned model list has deterministic model-ID key ordering.

------

## 14.17 Current bundled models

Current bundled catalog includes:

```text
Qwen/Qwen3.7-Flash
deepseek/deepseek-v4-pro
deepseek/deepseek-v4-flash
gpt-5.6-luna
```

All four are currently enabled and advertised in the bundled catalog.

Example response entry:

```json
{
  "id": "Qwen/Qwen3.7-Flash",
  "object": "model",
  "type": "model",
  "owned_by": "Qwen",
  "context_length": 1000000,
  "max_input_tokens": 1000000,
  "reasoning_efforts": [
    "high",
    "max"
  ],
  "input_modalities": [
    "text",
    "image"
  ],
  "capabilities": [
    "reasoning",
    "tools"
  ]
}
```

------

# Appendix A. Current Producer Value Classification

The current `commandcode-router` behavior can be summarized by source of information.

## A.1 Constants

```text
Content-Type = application/json

Accept = */*

Accept-Encoding = br, gzip, deflate

x-cli-environment = production

x-taste-learning = false

x-co-flag = false

User-Agent = cli

accept-language = *

sec-fetch-mode = cors

memory = null

taste = null

skills = null

actual upstream params.stream = true
```

## A.2 Configuration-derived

```text
apiBaseUrl

x-command-code-version

permissionMode

temperature fallback

thread-ID mode

model routing

reasoning effort
```

## A.3 Project-derived

```text
config.workingDir

config.structure

config.isGitRepo

config.currentBranch

config.mainBranch

config.gitStatus

config.recentCommits

x-project-slug
```

## A.4 Time-derived

```text
config.date
```

Format:

```text
UTC YYYY-MM-DD
```

## A.5 Request/session-derived

```text
threadId

x-session-id

system

messages

tools

temperature when explicitly supplied
```

## A.6 Model/catalog-derived

```text
params.model

params.max_tokens

params.reasoning_effort
```

## A.7 Random per upstream request

```text
traceparent.trace-id

traceparent.span-id
```

------

# Appendix B. Observed `mode` Variants

Captured material referenced by `PROTOCOLS.md` shows that other CommandCode clients can send a top-level `mode`.

Observed examples include:

```text
mode = "custom-agent"

mode = "title-gen"
```

The strict request produced by current `commandcode-router` contains no `mode` field.

Therefore:

```text
mode
```

should currently be treated as an observed client-mode extension rather than a required `/alpha/generate` field for LuckyToken's initial CommandCode producer.

------

# Appendix C. Core Implementation Invariants

A LuckyToken implementation targeting the behavior documented here should preserve at least:

```text
HTTP
├── POST /alpha/generate
├── JSON body
└── upstream SSE response

Request identity
├── threadId is a string
└── current parity behavior keeps threadId == x-session-id

Config
├── all config keys are present
├── date = UTC YYYY-MM-DD
├── structure = sorted top-level entries
├── gitStatus = whole-string-trimmed porcelain v1
└── recentCommits = git log -3 --oneline

Messages
├── content is always an array
├── content blocks use exact type strings
├── toolCallId remains stable
└── tool-result refers to its tool call

Tools
├── tool definition uses input_schema
└── tool-call uses toolCallId/toolName/input

Streaming
├── text has start/delta/end lifecycle
├── reasoning has start/delta/end lifecycle
├── tool input has start/delta/end lifecycle
├── tool-call is the completed semantic call
├── finish is semantic success
├── error is semantic failure
├── [DONE] is not semantic success
└── EOF before terminal is incomplete
```

------

# Appendix D. Protocol Boundary for LuckyToken

This document should remain the specification for:

```text
LuckyToken
↔
CommandCode wire
```

It should not contain mappings such as:

```text
Anthropic → Pi
Pi → CommandCode
CommandCode → Pi
Pi → Anthropic
```

Those belong in separate conversion specifications.

The clean architecture boundary is:

```text
Protocol Spec
└── What CommandCode wire means

Conversion Spec
└── How another semantic model maps to it

Architecture Spec
└── Which LuckyToken module performs that conversion
```