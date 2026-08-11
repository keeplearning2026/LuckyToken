# PART I: PI AI IR Request -> Commandcode Private Request

**Target是Commandcode Private, source是PI AI IR**

## 1. HTTP

### 1.1 Target

CommandCode HTTP request：

```text
HTTP Request
├── Method
└── Endpoint
```

要求：

```text
Method
→ POST

Endpoint
→ <baseUrl>/alpha/generate
```

`alpha/generate` 是追加到 Base URL 后的固定 CommandCode path。

------

### 1.2 Source

Endpoint 的 Base URL 来自 Pi selected model：

```text
Model
└── baseUrl: string
```

对应：

```text
Target Base URL
← model.baseUrl
```

`Method` 和 `alpha/generate` 不需要 Source。

------

### 1.3 Construction Method

```text
Method
→ fixed "POST"

Endpoint
← model.baseUrl
+ fixed "alpha/generate"
```

构造 endpoint 时必须保留 `model.baseUrl` 已有 path。

例如：

```text
https://host
→ https://host/alpha/generate

https://host/proxy
→ https://host/proxy/alpha/generate
```

因此不能使用会重置已有 path 的：

```ts
new URL("/alpha/generate", model.baseUrl)
```

`model.baseUrl` 无法构造有效 endpoint 时：

```text
→ error
```

不使用其他 Base URL fallback。

## 2. Headers

### 2.1 Target

CommandCode request 的 application-level headers 为：

```text
Headers
├── Content-Type: application/json
├── Accept: */*
├── User-Agent: cli
├── x-command-code-version: 1.9.0
├── x-cli-environment: string
├── x-project-slug: string
├── x-taste-learning: string
├── x-co-flag: string
├── x-session-id: UUID
├── x-cmd-zdr: "1"
├── Authorization?: "Bearer <apiKey>"
├── traceparent?: string
└── x-oss-primary-provider?: string
```

其中：

- `x-cli-environment` 默认值为 `"production"`；`"prod"` normalize 为 `"production"`。
- `x-project-slug` 在 cwd 不存在时为 `"root"`；存在时为 `slugify(cwd) || "root"`。
- `x-session-id` 必须是 valid UUID，并与 body `threadId` 使用同一个 authoritative session identity。
- `Authorization`、`traceparent`、`x-oss-primary-provider` 为 optional headers。
- `traceparent` 为 optional attempt-owned header。存在时必须满足 CommandCode 接受的 W3C traceparent format；它由 HTTP attempt runtime 构造，不属于 Pi AI IR → CommandCode semantic conversion。
- 当前 profile 不发送 `x-oauth-token` 或 `x-oauth-provider`。

`Host`、`Connection`、`Content-Length`、`Accept-Encoding` 等 transport headers 不属于 application request construction，由 HTTP runtime 负责。

### 2.2 Source

以下 Target fields 需要 Pi AI IR source：

```text
SimpleStreamOptions
├── apiKey?: string
├── sessionId?: string
└── metadata?
    └── projectDir?: unknown
```

对应关系：

```text
Authorization
← options.apiKey

x-session-id
← options.sessionId

x-project-slug
← options.metadata.projectDir
```

`projectDir` 是 LuckyToken 用来提供 CommandCode caller cwd 的约定。

其他 Headers 不需要从 Pi AI IR source 转换；它们由 CommandCode target rule、provider-bound configuration 或 request/attempt-local calculation 构造。

### 2.3 Construction Method

`traceparent` 与其他 application-level semantic headers 的 lifecycle 不同。Semantic conversion 只保留可用于 tracing 的 logical trace context；最终 `traceparent` 由 HTTP attempt runtime 构造，因此 retry attempt 可以拥有不同的 span ID。

```text
Headers
│
├── Content-Type
│   └── fixed
│       → "application/json"
│
├── Accept
│   └── fixed
│       → "*/*"
│
├── User-Agent
│   └── fixed
│       → "cli"
│
├── x-command-code-version
│   └── fixed
│       → "1.9.0"
│
├── x-cmd-zdr
│   └── fixed
│       → "1"
│
├── x-taste-learning
│   └── no Pi source
│       → target default "false"
│
├── x-co-flag
│   └── no Pi source
│       → target default "false"
│
├── x-cli-environment
│   └── provider-bound cliEnvironment
│       ├── absent
│       │   → "production"
│       ├── "prod"
│       │   → "production"
│       └── other string
│           → preserve
│
├── x-project-slug
│   └── ← options.metadata.projectDir
│       ├── absent or ""
│       │   → "root"
│       ├── non-empty string
│       │   → slugify(projectDir) || "root"
│       └── present with invalid type
│           → error
│
├── x-session-id
│   └── ← options.sessionId
│       ├── valid UUID
│       │   → preserve
│       └── absent or invalid UUID
│           → generate one random UUID
│
│       The resolved UUID is shared with:
│       → body.threadId
│
├── Authorization
│   └── ← options.apiKey
│       ├── absent or empty
│       │   → omit
│       └── non-empty string
│           → "Bearer <apiKey>"
│
├── x-oss-primary-provider
│   └── provider-bound OSS provider
│       ├── absent
│       │   → omit
│       └── present
│           → preserve
│
└── traceparent
└── not constructed by semantic conversion
└── HTTP attempt runtime
├── valid trace context available
│   → construct valid traceparent
└── unavailable
→ omit

```

`x-session-id` 与 `threadId` 不应分别计算。Request construction 只解析一次 session identity，header 和 body 共享该结果。

`x-project-slug` 与后续 `GenerateRequest.config` 使用同一个 caller cwd source；两者不应独立推断 project identity。

Caller-provided generic headers 不属于这些 CommandCode protocol-owned Target fields 的 semantic conversion。若 Provider 保留 generic header extension 能力，应作为独立 runtime/header-extension policy 处理，并不得改变这些 protocol-owned headers。

## 3. `config`

### 3.1 Target

`GenerateRequest.config` 是一个完整的 `ServerConfig`：

```ts
interface ServerConfig {
  workingDir: string;
  date: string;
  environment: string;
  structure: string[];
  isGitRepo: boolean;
  currentBranch: string;
  mainBranch: string;
  gitStatus: string;
  recentCommits: string[];
}
```

自然结构为：

```text
config
├── Project
│   ├── workingDir
│   ├── date
│   └── environment
│
├── Structure
│   └── structure[]
│
└── Git
    ├── isGitRepo
    ├── currentBranch
    ├── mainBranch
    ├── gitStatus
    └── recentCommits[]
```

所有字段都是 required。`config` 本身不能 omission。

当没有 project cwd 时，CommandCode 定义稳定的 empty config：

```json
{
  "workingDir": "",
  "date": "",
  "environment": "",
  "structure": [],
  "isGitRepo": false,
  "currentBranch": "",
  "mainBranch": "",
  "gitStatus": "",
  "recentCommits": []
}
```

只有存在 non-empty cwd 时，才构造 project-bound config，并读取 filesystem 和 Git。

------

### 3.2 Source

`config` 只需要一个 Pi request source，由 LuckyToken CommandCode provider 从 Pi generic metadata 中提取：

```text
SimpleStreamOptions
└── metadata
    └── projectDir?: unknown
```

Pi 将 `metadata` 定义为 provider 可按需解释的 generic metadata；`projectDir` 是 LuckyToken CommandCode provider 用来承载 caller cwd 的约定。

LuckyToken 将：

```text
options.metadata.projectDir
```

解释为 CommandCode caller cwd。

它只直接提供：

```text
workingDir
← projectDir
```

并作为 filesystem / Git calculation 的工作目录。

其他 `ServerConfig` 字段不从 Pi AI IR 转换。

------

### 3.3 Construction Method

`config` 首先根据 cwd 分成两个 construction path：

```text
options.metadata.projectDir
│
├── absent / ""
│   → construct empty config
│   → do not use process.cwd()
│   → do not read filesystem
│   → do not execute Git
│
├── non-empty string
│   → use as cwd
│   → construct project-bound config
│
└── present but not a string
    → error
```

#### Project fields

```text
workingDir
└── 需要 Source
    └── projectDir
        → preserve original path string
date
└── 不需要 additional Source
    └── request-local calculation
        → new Date().toISOString().split("T")[0]
```

`date` 使用 UTC date。只有 project-bound config 计算日期；empty config 中固定为 `""`。

```text
environment
└── 不需要 Pi Source
    └── runtime calculation
        → process.platform
```

其值例如：

```text
win32
linux
darwin
```

#### `structure`

`structure` 不从 Pi message/context 转换，而是根据 cwd 读取 filesystem。

construction：

```text
cwd
↓
readdir(cwd) once
↓
immediate names only
↓
remove hidden names
↓
remove fixed exclusions
↓
JavaScript default sort()
↓
append formatted additional workspace scopes
↓
structure[]
```

只读取 cwd 的 immediate entries：

- 不 recurse；
- 不 `stat`；
- 不构造 recursive tree；
- 不设置 entry-count cap。

删除所有以 `.` 开头的 name，并删除以下 fixed case-sensitive exclusions：

```text
node_modules
dist
build
.git
.svn
.hg
coverage
.nyc_output
.cache
tmp
temp
.next
.nuxt
out
```

普通 single-root request 使用：

```text
workspaceRoots = [cwd]
```

因此没有额外 scope entry。

如果存在额外 workspace roots，则在普通 directory names 完成排序后，以：

```text
scope:<formatted-path>
```

的形式 append；scope entries 不参与前面的 sort。

`readdir(cwd)` 失败不使整个 request conversion 失败：

```text
readdir success
→ sorted directory names + scope entries

readdir failure
→ scope entries only
```

#### Git fields

Git information同样不从 Pi AI IR 获取，而是以 cwd 为工作目录计算。

首先执行：

```text
git rev-parse --git-dir
```

结果决定 Git branch：

```text
command failure
→ non-Git config

command success
→ Git repository
```

Non-Git repository：

```text
isGitRepo     = false
currentBranch = ""
mainBranch    = ""
gitStatus     = ""
recentCommits = []
```

Git repository：

```text
isGitRepo = true
```

然后分别构造其余字段。

`currentBranch`：

```text
git branch --show-current

success
→ stdout.trim()

failure
→ ""
```

`mainBranch`：

```text
git symbolic-ref --short refs/remotes/origin/HEAD
│
├── success + non-empty
│   → remove leading "origin/"
│
└── otherwise
    ↓
    git branch -r
    │
    ├── failure
    │   → ""
    │
    ├── contains origin/main
    │   → "main"
    │
    ├── contains origin/master
    │   → "master"
    │
    └── success without known branch
        → "main"
```

`gitStatus`：

```text
git status --porcelain
│
├── failure
│   → ""
│
├── success + empty output
│   → "Working tree clean"
│
└── success + non-empty output
    → stdout.trim()
```

`recentCommits`：

```text
git log --oneline -3
│
├── failure / empty output
│   → []
│
└── success + non-empty output
    → split by newline
```

Git command execution必须区分：

```text
successful empty output
≠
command failure
```

因此 command result 应保留类似：

```ts
type GitOutput =
  | { ok: true; output: string }
  | { ok: false };
```

的状态，而不能只根据 empty string 判断成功或失败。

整个 `config` 在一个 logical completion 内构造一次并保持固定；request construction 的其他阶段不应再次读取 project state 并产生另一份不同的 `config`。

## 4. GenerateRequest Top-Level Fields

本章定义 `config` 和 `params` 之外的 `GenerateRequest` top-level fields：

```text
GenerateRequest
├── memory
├── taste
├── skills
├── permissionMode
├── threadId
└── mode?
```

### 4.1 Target

Target fields：

```ts
interface GenerateRequest {
  memory: null;
  taste: null;
  skills: null;
  permissionMode: "standard" | "plan" | "auto-accept";
  threadId: string;
  mode?: string;
}
```

字段语义：

```text
memory
└── required
    └── null

taste
└── required
    └── null

skills
└── required
    └── null

permissionMode
└── required
    ├── "standard"
    ├── "plan"
    └── "auto-accept"

threadId
└── required
    └── valid UUID

mode
└── optional
    └── non-empty string when present
```

`memory:null`、`taste:null`、`skills:null` 是 CommandCode request body 的固定 compatibility fields。它们不表示相应 information 不存在于 model-visible context；相关信息可以已经被 application 编译进 `params.system`。

`threadId` 与 HTTP header `x-session-id` 是同一个 authoritative logical session identity 的两种 wire representation，必须使用同一个 UUID。

`mode` 与 `permissionMode` 是两个不同字段，不表达同一种语义。

### 4.2 Source

这一组 Target fields 中，只有 `threadId` 需要 Pi AI IR source：

```text
SimpleStreamOptions
└── sessionId?: string
threadId
← options.sessionId
```

`memory`、`taste`、`skills`、`permissionMode` 不需要 Pi AI IR source。

当前 Pi AI IR 也没有用于普通 CommandCode main request 的 `mode` source。

### 4.3 Construction Method

#### `memory` / `taste` / `skills`

三个字段均不需要 Source，由 Target contract 直接构造：

```text
memory
→ fixed null

taste
→ fixed null

skills
→ fixed null
```

必须显式保留 `null`，不能 omission。

#### `permissionMode`

`permissionMode` 不需要 Pi AI IR source，由 provider-bound permission policy 和 CommandCode mapping rule 构造：

```text
bound permission mode
│
├── "plan"
│   → "plan"
│
├── "bypass"
│   → "auto-accept"
│
├── "auto-accept"
│   → "auto-accept"
│
└── absent / other value
    → "standard"
```

因此 `"standard"` 是没有可用 mapping 时的 Target default。

`permissionMode` 的构造不读取 conversation state，也不从 Pi messages 或 model metadata 推断。

#### `threadId`

`threadId` 需要 `options.sessionId`：

```text
options.sessionId
│
├── valid UUID
│   → preserve
│
└── absent or invalid UUID
    → generate random UUID
```

解析或生成 session identity 只执行一次：

```text
options.sessionId
        ↓
resolve session identity once
        ↓
resolved UUID
├── Headers.x-session-id
└── GenerateRequest.threadId
```

不得为 `x-session-id` 和 `threadId` 分别生成、normalize 或覆盖 UUID。

生成后的值必须是 valid UUID；如果 session identity generator 本身产生无效值，则 request construction 失败。

#### `mode`

`mode` 是 optional Target field。

当前 Pi AI IR → CommandCode normal request conversion 没有对应 Source，因此：

```text
mode
└── no Pi source
    → omit
```

不能根据 `permissionMode`、model、messages、tools 或其他 Pi information 推导 `mode`。

如果后续 request mutation boundary 显式加入合法的 non-empty `mode`，那属于 CommandCode target-native mutation，而不是 Pi AI IR → CommandCode semantic conversion。

## 5. `Params` Scalar Controls

本章定义 `GenerateParams` 中除 `messages` 和 `tools` 之外的 scalar fields：

```text
params
├── model
├── system?
├── max_tokens
├── stream
├── temperature?
└── reasoning_effort?
```

### 5.1 Target

CommandCode target：

```ts
interface GenerateParams {
  model: string;
  system?: string;
  max_tokens: number;
  stream: true;
  temperature?: number;
  reasoning_effort?:
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
}
```

字段要求：

- `model` required，表示 CommandCode selected model identifier。
- `system` optional；不存在时 omission。
- `max_tokens` required；caller 未提供 override 时，CommandCode default 为 `64000`。
- `stream` required，并且必须为 literal `true`。
- `temperature` optional；不存在时 omission。
- `reasoning_effort` optional；当 Pi reasoning resolution 得到 non-off effective thinking level 时发送对应的 CommandCode effort。

### 5.2 Source

这些 Target fields 使用以下 Pi AI IR source：

```text
Model
├── id: string
├── reasoning: boolean
└── thinkingLevelMap?: ThinkingLevelMap

Context
└── systemPrompt?: string

SimpleStreamOptions
├── maxTokens?: number
├── temperature?: number
└── reasoning?: ThinkingLevel
```

其中：

```text
ThinkingLevel
├── minimal
├── low
├── medium
├── high
├── xhigh
└── max
```



reasoning_effort` construction 使用：

options.reasoning
+
selected Pi Model

其中 Pi Model 的 reasoning capability 由：

model.reasoning
model.thinkingLevelMap?

表达。

Pi 提供：

getSupportedThinkingLevels(model)
clampThinkingLevel(model, level)

负责根据 selected model capability 解析 effective thinking level。

CommandCode conversion 只负责把 effective Pi thinking level
映射为 CommandCode `reasoning_effort`。

**`stream` 不需要 Source。**

### 5.3 Construction Method

#### `model`

```text
model.id
│
├── valid model identifier
│   → params.model = model.id
│
└── cannot construct valid target
    → error
```

CommandCode 使用 selected Pi `Model.id` 作为 `params.model`。

不使用 `Model.provider`、`Model.api` 或其他 identity fields 拼接新的 wire model identifier。

------

#### `system`

```text
context.systemPrompt
│
├── absent
│   → omit params.system
│
└── present
    → params.system = context.systemPrompt
```

Source string 原样保留，包括 empty string。

Converter 不增加 prefix、suffix 或其他 system content。

------

#### `max_tokens`

```text
options.maxTokens
│
├── absent
│   → params.max_tokens = 64000
│
├── present + valid
│   → params.max_tokens = options.maxTokens
│
└── present but invalid
    → error
```

`max_tokens` 是需要 Pi Source 的 Target field。

`options.maxTokens` 存在时使用 request-level value；不存在时使用 CommandCode target-defined default `64000`。

不使用：

```text
model.maxTokens
```

作为 Source absence 时的 fallback，也不执行 Pi shared context-window clamp。

------

#### `stream`

`stream` 不需要 Source：

```text
params.stream
→ fixed true
```

CommandCode request 不支持在这个 Target 中构造 `stream:false`。

------

#### `temperature`

```text
options.temperature
│
├── absent
│   → omit params.temperature
│
├── present + finite number
│   → params.temperature = options.temperature
│
└── present but invalid
    → error
```

`0` 是合法值，必须保留，不能因为 falsy 而 omission。

------

#### `reasoning_effort`

Target：

```text
reasoning_effort?
├── low
├── medium
├── high
├── xhigh
└── max
```

Source：

```text
options.reasoning?
selected Model
```

Construction：

```text
options.reasoning
│
├── absent
│   → omit params.reasoning_effort
│
└── present
    ↓
    clampThinkingLevel(model, options.reasoning)
    │
    ├── "off"
    │   → omit params.reasoning_effort
    │
    └── effectiveLevel
        ↓
        map to CommandCode effort
        ↓
        params.reasoning_effort
```

Mapping 优先使用 selected model 的 explicit Pi mapping：

```text
model.thinkingLevelMap?.[effectiveLevel]
```

不存在 explicit mapping 时使用：

```text
minimal → low
low     → low
medium  → medium
high    → high
xhigh   → xhigh
max     → max
```

不创建额外：

```text
supportedReasoningEfforts
```

reasoning capability 由 selected Pi `Model` 表达，并使用 Pi 的：

```text
clampThinkingLevel()
```

解析当前 model 的 effective reasoning level。

## 6. `Params`- UserMessage

### 6.1 Target

CommandCode `UserMessage`：

```ts
type UserMessage = {
  role: "user";
  content: (
    | {
        type: "text";
        text: string;
      }
    | {
        type: "image";
        image: string;
        mimeType: string;
      }
  )[];
};
```

自然结构：

```text
UserMessage
├── role: "user"
└── content[]
    ├── TextBlock
    │   ├── type: "text"
    │   └── text: string
    │
    └── ImageBlock
        ├── type: "image"
        ├── image: string
        └── mimeType: string
```

`UserMessage` 表示发送给模型的用户消息。

#### `role`

```text
role: "user"
```

required。

值固定为：

```text
"user"
```

#### `content`

```text
content: (TextBlock | ImageBlock)[]
```

required。

`content` 是有序 content block 数组，允许：

```text
content: []
```

数组中的 block 顺序具有语义，应保持原顺序。

CommandCode UserMessage 只允许两种 block：

```text
TextBlock
ImageBlock
```

------

#### TextBlock

结构：

```ts
{
  type: "text";
  text: string;
}
```

自然结构：

```text
TextBlock
├── type: "text"
└── text: string
```

含义：

- `type` 标识这是 text content；
- `text` 是用户文本内容。

`type` required，固定为：

```text
"text"
```

`text` required，类型为 `string`。

CommandCode 接受：

```text
""
"   "
"\n"
```

因此 converter 不需要清理 empty 或 whitespace-only text。

------

#### ImageBlock

结构：

```ts
{
  type: "image";
  image: string;
  mimeType: string;
}
```

自然结构：

```text
ImageBlock
├── type: "image"
├── image
└── mimeType
```

含义：

- `type` 标识这是 image content；
- `image` 保存实际图片内容的 complete data URL；
- `mimeType` 表示图片 MIME type。

`type` required，固定为：

```text
"image"
```

`mimeType` required，类型为 `string`。

`image` required，必须是完整 data URL：

```text
data:<mimeType>;base64,<base64-data>
```

例如其 wire representation 的结构是：

```text
data:
↓
MIME type
↓
;base64,
↓
base64 image data
```

`image` 不是：

```text
raw base64
file path
HTTP URL
```

并且：

```text
ImageBlock.mimeType
```

必须与：

```text
ImageBlock.image
```

中 data URL 的 MIME segment 一致。

------

### 6.2 Source

UserMessage 的不同 Target 局部分别需要不同 Source。

#### Message content

构造：

```text
Target UserMessage.content
```

需要 Pi：

```ts
interface UserMessage {
  role: "user";

  content:
    | string
    | (TextContent | ImageContent)[];

  timestamp: number;
}
```

这里只需要：

```text
UserMessage.content
```

Pi `content` 有两种合法 representation：

```text
content
├── string
└── (TextContent | ImageContent)[]
```

它表示用户消息实际包含的 semantic content。

------

#### TextBlock source

构造：

```text
Target TextBlock.text
```

需要 Pi：

```ts
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

其中真正需要的 Source 是：

```text
TextContent.text: string
```

它表示用户文本内容。

对应：

```text
Target TextBlock.text
← Pi TextContent.text
```

------

#### ImageBlock value source

构造：

```text
Target ImageBlock.mimeType
Target ImageBlock.image
```

需要 Pi：

```ts
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
```

自然结构：

```text
ImageContent
├── data: string
└── mimeType: string
```

其中：

```text
data
```

表示 base64-encoded image bytes。

它不是完整 data URL。

```text
mimeType
```

表示图片 MIME type。

对应关系：

```text
Target ImageBlock.mimeType
← ImageContent.mimeType
```

而：

```text
Target ImageBlock.image
```

不是 Source 中已有的完整 field。

它需要两个 Source components：

```text
ImageContent.mimeType
+
ImageContent.data
```

然后按照 CommandCode Target wire format 组合。

------

#### ImageBlock capability source

构造 ImageBlock 还需要确认 selected model 能够接受 image input。

需要 Pi selected `Model`：

```text
Model
└── input: ("text" | "image")[]
```

这里需要的 information 是：

```text
Model.input
```

它不提供 ImageBlock 的 wire value，而是决定这个 Target block 是否允许构造。

对应：

```text
Target ImageBlock construction eligibility
← selected Model.input
```

如果：

```text
Model.input
```

不包含：

```text
"image"
```

则不能为当前 selected model 构造这个 image input。

------

### 6.3 Construction Method

#### UserMessage

Target：

```text
UserMessage
├── role
└── content[]
```

##### `role`

不需要 Source。

```text
Target role
└── fixed value
    → "user"
```

构造：

```ts
role: "user"
```

------

##### `content`

需要 Source：

```text
Pi UserMessage.content
```

先根据 Source representation 决定 Target content construction：

```text
Pi UserMessage.content
│
├── string
│   → construct one TextBlock
│
└── structured content[]
    → convert blocks in source order
```

Source content 不存在或无法形成合法的 Pi UserMessage content 时，无法构造 required Target `content`：

```text
→ error
```

不对 message content 做 same-role merge、text cleanup 或 reordering。

------

#### String content

如果 Pi：

```text
content: string
```

则 Target `content` 构造为单个 TextBlock：

```text
source string
↓
[
  {
    type: "text",
    text: source string
  }
]
```

其中：

```text
TextBlock.type
→ fixed "text"
TextBlock.text
← source string
```

Source string 原样 preserve。

因此：

```text
empty string
whitespace-only string
```

也直接保留。

------

#### Structured content array

如果 Pi：

```text
content: (TextContent | ImageContent)[]
```

则：

```text
source content[]
↓
iterate in source order
↓
convert each block
↓
Target content[]
```

不合并相邻 TextBlock。

不重新排序。

不删除合法 empty TextBlock。

如果 Source：

```text
content: []
```

则 Target：

```text
content: []
```

------

#### TextContent → TextBlock

Target：

```text
TextBlock
├── type
└── text
```

##### `type`

不需要 Source：

```text
fixed value
→ "text"
```

##### `text`

需要：

```text
TextContent.text
```

Construction：

```text
Source exists
│
├── valid string
│   → preserve
│
└── cannot faithfully construct Target string
    → error
```

最终：

```ts
{
  type: "text",
  text: source.text,
}
```

不执行 trim、merge 或 normalization。

------

#### ImageContent → ImageBlock

Target：

```text
ImageBlock
├── type
├── image
└── mimeType
```

这个 Target block 同时依赖：

```text
ImageContent.data
ImageContent.mimeType
Model.input
Target data-URL format
```

因此不是简单字段 rename。

------

##### Image capability

首先判断当前 Target ImageBlock 是否能够为 selected model 构造：

```text
selected Model.input
│
├── contains "image"
│   → continue ImageBlock construction
│
└── does not contain "image"
    → error
```

不把 image block silently drop，也不转换成 text。

当前 provider 同样在构造 CommandCode image block 前执行 selected-model image capability check。

------

##### `type`

不需要 Source：

```text
fixed value
→ "image"
```

------

##### `mimeType`

需要：

```text
ImageContent.mimeType
```

Construction：

```text
ImageContent.mimeType
│
├── valid + convertible
│   → preserve
│
└── cannot faithfully construct Target
    → error
```

最终：

```text
Target mimeType
=
source.mimeType
```

------

##### `image`

需要：

```text
ImageContent.mimeType
+
ImageContent.data
```

Source 中不存在完整 CommandCode `image` representation。

Target 要求 complete data URL，因此这个字段属于 **multiple-source composition + target-defined format construction**。

Construction：

```text
Target image
↓
requires complete data URL
↓
read source.mimeType
+
read source.data
↓
construct
```

具体格式：

```text
"data:"
+ source.mimeType
+ ";base64,"
+ source.data
```

即：

```ts
image =
  `data:${source.mimeType};base64,${source.data}`;
```

最终 ImageBlock：

```ts
{
  type: "image",
  image: `data:${source.mimeType};base64,${source.data}`,
  mimeType: source.mimeType,
}
```

这里：

```text
source.mimeType
```

同时用于：

```text
Target mimeType
```

和：

```text
Target image data-URL MIME segment
```

因此同一个 authoritative Source value 应直接复用，不能分别推断两个 MIME type。

Converter 不：

```text
re-encode image bytes
load files
fetch remote URLs
upload images
generate an external URL
```

它只把 Pi 已经持有的：

```text
mimeType + base64 data
```

按照 CommandCode Target wire representation 组合成 complete data URL。

------

#### Final UserMessage construction

最终结构：

```text
Pi UserMessage
│
├── content: string
│   ↓
│   TextBlock
│
└── content[]
    │
    ├── TextContent
    │   ↓
    │   TextBlock
    │
    └── ImageContent
        +
        selected Model.input
        ↓
        ImageBlock
```

构造完成后的 Target 必须满足：

```text
UserMessage
├── role === "user"
└── content[]
    ├── valid TextBlock
    └── valid ImageBlock
```

无法忠实构造任一 required block 时：

```text
→ error
```

不能通过删除该 block 来制造一个不同语义的 Target message。

## 7. `Params`- AssistantMessage

### 7.1 Target

CommandCode `AssistantMessage`：

```ts
type AssistantMessage = {
  role: "assistant";
  content: (
    | {
        type: "text";
        text: string;
      }
    | {
        type: "reasoning";
        text: string;
      }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        input: Record<string, unknown>;
      }
  )[];
};
```

自然结构：

```text
AssistantMessage
├── role: "assistant"
└── content[]
    ├── TextBlock
    │   ├── type: "text"
    │   └── text: string
    │
    ├── ReasoningBlock
    │   ├── type: "reasoning"
    │   └── text: string
    │
    └── ToolCallBlock
        ├── type: "tool-call"
        ├── toolCallId: string
        ├── toolName: string
        └── input: Record<string, unknown>
```

`AssistantMessage` 表示 historical assistant output。

#### `role`

```text
role: "assistant"
```

required。

值固定为：

```text
"assistant"
```

#### `content`

```text
content:
  (TextBlock | ReasoningBlock | ToolCallBlock)[]
```

required。

`content` 是有序 block 数组。

CommandCode AssistantMessage 只允许：

```text
TextBlock
ReasoningBlock
ToolCallBlock
```

并允许：

```text
content: []
```

合法 block 必须保持原始顺序。

CommandCode 不要求 converter 清理 empty text、empty reasoning 或 empty assistant content。

------

#### TextBlock

结构：

```ts
{
  type: "text";
  text: string;
}
```

自然结构：

```text
TextBlock
├── type: "text"
└── text: string
```

`type` required，固定为：

```text
"text"
```

`text` required，表示 assistant 的文本输出。

Empty string 和 whitespace-only string 是合法 Target representation。

------

#### ReasoningBlock

结构：

```ts
{
  type: "reasoning";
  text: string;
}
```

自然结构：

```text
ReasoningBlock
├── type: "reasoning"
└── text: string
```

`type` required，固定为：

```text
"reasoning"
```

`text` required，表示可以作为普通 reasoning text 重放的 assistant reasoning content。

CommandCode 使用：

```text
reasoning
```

而不是：

```text
thinking
redacted_thinking
```

后两种 wire block 不属于合法 CommandCode AssistantMessage。

------

#### ToolCallBlock

结构：

```ts
{
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}
```

自然结构：

```text
ToolCallBlock
├── type: "tool-call"
├── toolCallId
├── toolName
└── input
```

含义：

- `type` 标识 assistant 发起工具调用；
- `toolCallId` 是该 invocation 的 correlation identity；
- `toolName` 是 historical tool name；
- `input` 是传给工具的 JSON object。

`type` required，固定为：

```text
"tool-call"
```

`toolCallId` required，类型为 `string`。

同一 assistant turn 中不同 tool call 必须拥有不同的 `toolCallId`。

`toolName` required，类型为 `string`。

Historical `toolName` 不要求仍存在于当前 request 的 `params.tools`。

`input` required，并且必须是 JSON object：

```text
Record<string, unknown>
```

空对象：

```json
{}
```

合法。

CommandCode 不在 historical ToolCall replay 时根据当前 `input_schema` 重新验证参数内容。字段名称必须是：

```text
input
```

不能发送：

```text
arguments
```

`ToolCallBlock` 与后续 `ToolMessage` 的 adjacency 和 result coverage 属于跨 message contract，不在本章处理。

------

### 7.2 Source

AssistantMessage 的不同 Target block 分别读取不同的 Pi source。

Pi AssistantMessage：

```ts
interface AssistantMessage {
  role: "assistant";

  content:
    (TextContent |
     ThinkingContent |
     ToolCall)[];

  api: Api;
  provider: ProviderId;
  model: string;

  responseModel?: string;
  responseId?: string;

  diagnostics?: AssistantMessageDiagnostic[];

  usage: Usage;

  stopReason: StopReason;
  deferred?: DeferredHandle;

  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;

  timestamp: number;
}
```

本章需要的入口只有：

```text
AssistantMessage.content[]
```

Pi AssistantMessage 的合法 content 为：

```text
TextContent
ThinkingContent
ToolCall
```

------

#### TextBlock source

Target：

```text
TextBlock.text
```

需要：

```ts
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

其中真正用于 Target construction 的 Source 是：

```text
TextContent.text
```

对应：

```text
Target TextBlock.text
← TextContent.text
```

------

#### ReasoningBlock source

Target：

```text
ReasoningBlock.text
```

需要：

```ts
interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
```

这里有两种不同作用的 Source。

Value Source：

```text
ThinkingContent.thinking
```

对应：

```text
Target ReasoningBlock.text
← ThinkingContent.thinking
```

Construction condition Source：

```text
ThinkingContent.redacted?
```

它不提供 Target wire value，但决定 Pi block 中的 reasoning 是否能够被忠实表示为普通 CommandCode reasoning text。

Pi 明确区分普通 ThinkingContent 和：

```text
redacted = true
```

的 redacted reasoning state。

CommandCode ReasoningBlock 没有：

```text
redacted
signature
opaque replay state
```

等 representation。

因此：

```text
ThinkingContent.redacted
```

属于 ReasoningBlock construction correctness 所需的 condition Source。

`thinkingSignature` 不参与 CommandCode ReasoningBlock construction。

------

#### ToolCallBlock source

Pi ToolCall：

```ts
interface ToolCall {
  type: "toolCall";

  id: string;
  name: string;

  arguments: Record<string, any>;

  thoughtSignature?: string;
  namespace?: string;
}
```

自然结构：

```text
ToolCall
├── id
├── name
├── arguments
├── thoughtSignature?
└── namespace?
```

Target 对应：

```text
Target toolCallId
← ToolCall.id

Target toolName
← ToolCall.name

Target input
← ToolCall.arguments
```

其中：

```text
ToolCall.id
```

表示工具调用 correlation identity。

```text
ToolCall.name
```

表示 historical tool name。

```text
ToolCall.arguments
```

表示工具调用参数 object。Pi static contract 将其定义为 object-shaped `Record<string, any>`。

构造 Target `input` 还需要确认该 object 能够作为 CommandCode JSON request 的 object 被无损表示。

`thoughtSignature` 不提供 CommandCode `ToolCallBlock` 所需的信息，因此不读取。

`namespace` 不提供 Target wire value，但会决定当前 `ToolCall` 是否能够忠实构造为 CommandCode `ToolCallBlock`，因此属于 construction condition Source：

```text
ToolCall.namespace
├── absent
│   → continue ToolCallBlock construction
└── present
    → no faithful Target representation
    → error
```

不能：

```text
drop namespace
merge namespace into toolName
guess an equivalent CommandCode tool identity
```

------

### 7.3 Construction Method

#### AssistantMessage

Target：

```text
AssistantMessage
├── role
└── content[]
```

##### `role`

不需要 Source：

```text
Target role
└── fixed value
    → "assistant"
```

------

##### `content`

需要：

```text
Pi AssistantMessage.content[]
```

Construction：

```text
Pi content[]
↓
iterate in source order
↓
construct one Target block
for each Source block
↓
CommandCode content[]
```

对应结构：

```text
Pi TextContent
→ CommandCode TextBlock

Pi ThinkingContent
→ CommandCode ReasoningBlock

Pi ToolCall
→ CommandCode ToolCallBlock
```

不：

```text
merge adjacent blocks
reorder blocks
remove empty text
remove empty reasoning
```

如果：

```text
Pi content = []
```

则：

```text
Target content = []
```

如果 runtime source 中出现不能映射到这三种 Target block 的 assistant content：

```text
→ error
```

不能静默删除。

------

#### TextContent → TextBlock

Target：

```text
TextBlock
├── type
└── text
```

##### Construction eligibility

CommandCode `ToolCallBlock` 没有 `namespace` representation。

因此：

```text
ToolCall.namespace
├── absent
│   → continue construction
└── present
    → error
```

不能静默删除 `namespace`，也不能将其合并进 `toolName`。

##### `type`

不需要 Source：

```text
fixed value
→ "text"
```

##### `text`

需要：

```text
TextContent.text
```

Construction：

```text
source.text
│
├── valid string
│   → preserve exactly
│
└── cannot faithfully construct Target
    → error
```

最终：

```ts
{
  type: "text",
  text: source.text,
}
```

不 trim、不 merge、不修改内容。

`textSignature` 不读取、不验证。

------

#### ThinkingContent → ReasoningBlock

Target：

```text
ReasoningBlock
├── type
└── text
```

这个 Target block 同时依赖：

```text
ThinkingContent.thinking
ThinkingContent.redacted
CommandCode reasoning representation
```

##### Construction eligibility

首先判断 Pi ThinkingContent 是否可以忠实表示为普通 CommandCode reasoning text：

```text
ThinkingContent.redacted
│
├── true
│   → Target 无法表示 redacted reasoning state
│   → error
│
└── false / absent
    → continue construction
```

这里不能：

```text
drop the block
convert redacted reasoning to normal reasoning
guess missing reasoning text
```

因为这些行为都会改变 Source semantic。

##### `type`

不需要 Source：

```text
fixed value
→ "reasoning"
```

##### `text`

需要：

```text
ThinkingContent.thinking
```

Construction：

```text
source.thinking
│
├── valid string
│   → preserve exactly
│
└── cannot faithfully construct Target
    → error
```

最终：

```ts
{
  type: "reasoning",
  text: source.thinking,
}
```

Pi block name：

```text
thinking
```

在 CommandCode wire 中转换为：

```text
reasoning
```

但 reasoning text 本身保持不变。

`thinkingSignature` 不读取、不验证。

------

#### ToolCall → ToolCallBlock

Target：

```text
ToolCallBlock
├── type
├── toolCallId
├── toolName
└── input
```

##### `type`

不需要 Source：

```text
fixed value
→ "tool-call"
```

##### `toolCallId`

需要：

```text
ToolCall.id
```

Construction：

```text
ToolCall.id
│
├── valid string
│   → preserve
│
└── cannot construct Target identity
    → error
```

最终：

```text
toolCallId = source.id
```

在同一个 AssistantMessage 中：

```text
toolCallId
```

必须唯一。

如果两个 Source ToolCall 使用相同 `id`：

```text
→ error
```

不能重新生成 ID，因为后续 ToolResult correlation 使用的就是这个 identity。

------

##### `toolName`

需要：

```text
ToolCall.name
```

Construction：

```text
toolName = source.name
```

原样 preserve。

不：

```text
look up current params.tools
rename historical tool
reject because tool no longer exists
```

------

##### `input`

需要：

```text
ToolCall.arguments
```

但 Target representation 是：

```text
Record<string, unknown>
```

并最终进入 JSON request body。

因此 construction 不是单纯属性 rename，而是：

```text
ToolCall.arguments
↓
verify object-shaped
↓
verify JSON-lossless representability
↓
preserve object content
↓
Target input
```

判断：

```text
source.arguments
│
├── object-shaped
│   +
│   can be represented losslessly
│   in CommandCode JSON request
│
│   → input = source.arguments
│
└── otherwise
    → error
```

不能通过 JSON coercion 静默改变数据。

例如不能允许 serialization 自动：

```text
drop undefined properties
convert non-JSON values
change unsupported values
```

从而形成与 Source arguments 不同的 Target input。

最终：

```ts
{
  type: "tool-call",
  toolCallId: source.id,
  toolName: source.name,
  input: losslessJsonObject(source.arguments),
}
```

不根据当前 tool schema 再验证 historical arguments。

------

#### ToolCall block-local invariant

一个 AssistantMessage 内可能包含多个 ToolCallBlock：

```text
AssistantMessage
└── content[]
    ├── ToolCall A
    └── ToolCall B
```

它们的 `toolCallId` 必须彼此不同：

```text
A.toolCallId !== B.toolCallId
```

因此 construction 时需要维护当前 AssistantMessage 内已经使用的 call IDs：

```text
ToolCall.id
│
├── not seen in current AssistantMessage
│   → construct
│
└── already seen
    → error
```

这个检查属于当前 Target AssistantMessage 的结构正确性。

后续：

```text
tool-call
↔
tool-result
```

的跨 message correlation、adjacency 和 coverage 不属于本章。

------



## 8. `Params`- ToolMessage

### 8.1 Target

CommandCode `ToolMessage`：

```ts
type ToolMessage = {
  role: "tool";
  content: {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: {
      type: "text" | "error-text";
      value: string;
    };
  }[];
};
```

自然结构：

```text
ToolMessage
├── role: "tool"
└── content[]
    └── ToolResultBlock
        ├── type: "tool-result"
        ├── toolCallId: string
        ├── toolName: string
        └── output
            ├── type: "text" | "error-text"
            └── value: string
```

`ToolMessage` 表示对 historical assistant `tool-call` 的执行结果。

------

#### `role`

```text
role: "tool"
```

required。

固定值：

```text
"tool"
```

------

#### `content`

```text
content: ToolResultBlock[]
```

required。

一个 CommandCode `ToolMessage` 可以包含一个或多个 `ToolResultBlock`。

每个 block 分别回应一个 `tool-call`。

因此自然关系是：

```text
ToolMessage
└── content[]
    ├── result for tool-call A
    ├── result for tool-call B
    └── ...
```

对于一个 Pi `ToolResultMessage` 的局部转换，本章构造一个 `ToolResultBlock`。

多个 tool call 的跨 message adjacency 和 coverage 在后续 message-sequence construction 中处理。

本 conversion 不聚合多个 Pi `ToolResultMessage`；每个 Pi `ToolResultMessage` 保持为一个独立的 CommandCode `ToolMessage`。

------

#### ToolResultBlock

Target：

```ts
{
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: {
    type: "text" | "error-text";
    value: string;
  };
}
```

自然结构：

```text
ToolResultBlock
├── type
├── toolCallId
├── toolName
└── output
    ├── type
    └── value
```

##### `type`

required。

固定值：

```text
"tool-result"
```

##### `toolCallId`

required，类型：

```text
string
```

表示结果对应的 historical tool-call identity。

它是 tool-call / tool-result correlation 的 authoritative identifier。

最终：

```text
ToolCallBlock.toolCallId
=
ToolResultBlock.toolCallId
```

必须成立。

##### `toolName`

required，类型：

```text
string
```

CommandCode canonical representation 使用：

```text
""
```

服务端虽然接受 non-empty value，但 result correlation 不依赖 `toolName`，而依赖 `toolCallId`。

因此 Pi → CommandCode conversion 使用 canonical：

```text
toolName: ""
```

##### `output`

required。

必须是单个 object：

```ts
{
  type: "text" | "error-text";
  value: string;
}
```

不能是：

```text
string
array
null
missing
```

------

#### `output.type`

表达 tool execution result state：

```text
"text"
→ successful tool result

"error-text"
→ failed tool result
```

------

#### `output.value`

required，类型：

```text
string
```

表示 tool result 的 textual output。

CommandCode ToolResultBlock 没有 image、structured content array 或其他 multimodal output representation。

多个文本片段需要最终构造成一个 string。

当前协议定义多行 textual output 使用：

```text
"\n"
```

连接。

------

### 8.2 Source

对应的 Pi source：

```ts
interface ToolResultMessage<TDetails = any> {
  role: "toolResult";

  toolCallId: string;
  toolName: string;

  content:
    (TextContent | ImageContent)[];

  details?: TDetails;
  usage?: Usage;

  addedToolNames?: string[];

  isError: boolean;
  timestamp: number;
}
```

自然结构：

```text
ToolResultMessage
├── Tool Identity
│   ├── toolCallId
│   └── toolName
│
├── Content
│   ├── TextContent
│   └── ImageContent
│
├── Result State
│   └── isError
│
├── Auxiliary Data
│   ├── details?
│   ├── usage?
│   └── addedToolNames?
│
└── timestamp
```

Pi 定义：

```text
toolCallId
→ links result to originating ToolCall

isError = false
→ successful tool execution

isError = true
→ failed tool execution
```

Pi ToolResultMessage 的合法 content 包括：

```text
TextContent
ImageContent
```

------

#### `toolCallId` Source

构造 Target：

```text
ToolResultBlock.toolCallId
```

需要：

```text
ToolResultMessage.toolCallId: string
```

对应：

```text
Target toolCallId
← Source toolCallId
```

该值表达的是 originating ToolCall identity，因此必须原样保留。

------

#### `toolName` Source

Target `toolName` 不需要 Pi Source。

CommandCode canonical representation 直接构造：

```text
toolName: ""
```

因此：

```text
Pi ToolResultMessage.toolName
```

既不提供 Target wire value，也不参与 correlation correctness。

本层 conversion 不读取、不比较、不验证它。

------

#### `output.type` Source

构造：

```text
Target output.type
```

需要：

```text
ToolResultMessage.isError: boolean
```

对应：

```text
isError
├── false
│   → "text"
└── true
    → "error-text"
```

`isError` 提供 Target result-state semantic。

------

#### `output.value` Source

构造：

```text
Target output.value
```

需要整个：

```text
ToolResultMessage.content[]
```

因为 Target 与 Source 的 representation 不同：

```text
Pi
content:
(TextContent | ImageContent)[]

↓

CommandCode
output.value: string
```

所以这是一个 subtree conversion，而不是单字段 rename。

------

#### Text content Source

Pi：

```ts
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

其中真正需要：

```text
TextContent.text
```

用于构造：

```text
Target output.value
```

`textSignature` 不提供 Target output 所需的信息，因此不进入 conversion state。

------

#### Image content Source

Pi：

```ts
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
```

CommandCode ToolResultBlock 没有 image output representation。

因此对于 ImageContent，conversion 只需要识别：

```text
content block is ImageContent
```

即可确定：

```text
no faithful Target representation
→ error
```

一旦确定 block 类型是 image，就不需要继续读取：

```text
ImageContent.data
ImageContent.mimeType
```

因为这些值无法用于构造任何合法 CommandCode ToolResultBlock field。

这与 UserMessage image conversion 不同：

```text
UserMessage ImageContent
→ CommandCode 有 ImageBlock
→ 可以转换
```

而：

```text
ToolResultMessage ImageContent
→ CommandCode ToolResult 没有 image representation
→ cannot faithfully convert
```

------

### 8.3 Construction Method

#### ToolMessage

对于一个 Pi `ToolResultMessage`：

```text
Pi ToolResultMessage
↓
construct one CommandCode ToolResultBlock
↓
wrap in ToolMessage.content[]
```

最终：

```text
ToolMessage
├── role
│   → fixed "tool"
│
└── content
    → [
        converted ToolResultBlock
      ]
```

即：

```ts
{
  role: "tool",
  content: [
    {
      // converted tool-result
    },
  ],
}
```

------

#### `role`

不需要 Source：

```text
fixed value
→ "tool"
```

------

#### ToolResultBlock `type`

不需要 Source：

```text
fixed value
→ "tool-result"
```

------

#### `toolCallId`

需要：

```text
ToolResultMessage.toolCallId
```

Construction：

```text
source.toolCallId
│
├── valid string
│   → preserve exactly
│
└── cannot construct Target identity
    → error
```

最终：

```text
toolCallId = source.toolCallId
```

不能重新生成或修改该 ID，因为这会破坏后续 correlation semantic。

它与 preceding ToolCall 是否实际匹配，属于跨 message invariant，在后续 sequence construction 中验证。

------

#### `toolName`

不需要 Source。

直接构造 CommandCode canonical value：

```text
toolName = ""
```

因此不存在：

```text
ToolResultMessage.toolName
→ Target toolName
```

的 mapping。

也不存在：

```text
ToolResultMessage.toolName
==
preceding ToolCall.toolName
```

这样的 conversion requirement。

Tool result correlation authority 是：

```text
toolCallId
```

而不是：

```text
toolName
```

------

#### `output.type`

需要：

```text
ToolResultMessage.isError
```

Construction：

```text
source.isError
│
├── false
│   → output.type = "text"
│
└── true
    → output.type = "error-text"
```

即：

```ts
const type =
  source.isError
    ? "error-text"
    : "text";
```

不根据 output text 内容猜测 execution state。

------

#### `output.value`

需要：

```text
ToolResultMessage.content[]
```

Target 要求最终得到：

```text
string
```

先检查 Source content structure：

```text
content[]
│
├── every block is TextContent
│   → continue
│
└── contains ImageContent
    → no faithful CommandCode representation
    → error
```

不能：

```text
drop image blocks
encode image as ordinary text
convert image to data URL text
replace image with placeholder
```

因为 Target contract 没有定义这样的 lossy conversion。

------

##### Text-only content construction

如果所有 block 都是 TextContent：

```text
TextContent[]
↓
read each .text
↓
preserve source order
↓
join with "\n"
↓
output.value
```

具体：

```text
output.value
=
source.content
  .map(block => block.text)
  .join("\n")
```

例如自然结构：

```text
TextContent A.text
+
"\n"
+
TextContent B.text
+
"\n"
+
TextContent C.text
↓
one Target output.value
```

这里的 `"\n"` 是 Target representation 所需的 request-local composition rule。

不 trim 每个 text。

不删除 empty text block。

不根据内容做其他 normalization。

------

##### Empty content

如果：

```text
source.content = []
```

则：

```text
[].map(...).join("\n")
→ ""
```

因此：

```text
output.value = ""
```

仍然可以构造 required Target string。

------

#### Complete ToolResultBlock

Text-only result 最终构造为：

```ts
{
  type: "tool-result",
  toolCallId: source.toolCallId,
  toolName: "",
  output: {
    type: source.isError
      ? "error-text"
      : "text",
    value: source.content
      .map(block => block.text)
      .join("\n"),
  },
}
```

这里有三个不同 construction mode：

```text
fixed values
├── type = "tool-result"
└── toolName = ""

direct Source preservation
└── toolCallId ← source.toolCallId

Source-derived values
├── output.type ← source.isError
└── output.value
    ← source.content[].text
    + "\n" composition
```

------

## 9. Message Sequence constraint

前面的章节已经定义单条 message conversion：

```text
UserMessage
→ Chapter 6

AssistantMessage
→ Chapter 7

ToolResultMessage
→ Chapter 8
```

本章只负责：

```text
Context.messages[]
↓
CommandCode params.messages[]
```

中的跨 message tool-call / tool-result sequence constraint。

------

### 9.1 Target

CommandCode `params.messages[]` 保持 message 顺序。

普通 message role 不要求交替。

额外 sequence constraint 只有包含 `tool-call` 的 AssistantMessage：

```text
AssistantMessage
└── tool-call IDs
    ↓
immediately-following ToolMessage run
└── must cover every tool-call ID
```

Correlation authority 是：

```text
toolCallId
```

不是：

```text
toolName
```

因此：

```text
Assistant(A, B)
Tool(A)
Tool(B)
```

合法。

如果真实 Source result 缺失，则使用 CommandCode 定义的 synthetic ToolMessage 补齐。

Orphan、duplicate、late 或不属于当前 preceding AssistantMessage 的 ToolResultMessage 不能形成合法 Target sequence：

```text
→ error
```

------

### 9.2 Source

Source 是有序的：

```text
Context.messages[]
```

其中单条 message 的字段 conversion 已由 Chapters 6–8 定义，本章不重复读取这些字段。

Sequence construction 额外需要读取的 Source information只有：

```text
ToolResultMessage.toolCallId
```

用于判断一个真实 ToolResultMessage 是否属于当前尚未完成的 Target assistant tool turn。

Assistant tool-call IDs 不需要从 Pi AssistantMessage 再读取一遍。

它们直接来自已经由 Chapter 7 构造完成的：

```text
Target AssistantMessage.content[]
└── ToolCallBlock.toolCallId
```

Pi `AssistantMessage.stopReason` 不提供任何 CommandCode message-sequence Target 所需的信息：

```text
→ do not read
```

------

### 9.3 Construction Method

按 Source order 线性处理：

```text
Context.messages[]
```

只维护一个 request-local temporary state：

```text
unresolvedToolCallIds: string[]
```

它表示：

> 当前 preceding Target AssistantMessage 中尚未被真实或 synthetic ToolMessage 覆盖的 tool-call IDs。

初始：

```text
unresolvedToolCallIds = []
```

#### Flush missing results

定义一个局部操作：

```text
flushMissingResults()
```

如果：

```text
unresolvedToolCallIds = []
```

则什么都不做。

否则按照 remaining IDs 的原始 tool-call 顺序，为每个 ID append：

```ts
{
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName: "",
      output: {
        type: "text",
        value:
          "No result — the tool call did not complete (interrupted or lost).",
      },
    },
  ],
}
```

然后：

```text
unresolvedToolCallIds = []
```

这是 CommandCode Target-defined generation，不调用 Chapter 8。

------

#### UserMessage

遇到 Source UserMessage：

```text
flushMissingResults()
↓
Chapter 6
↓
append Target UserMessage
```

------

#### AssistantMessage

遇到 Source AssistantMessage：

```text
flushMissingResults()
↓
Chapter 7
↓
Target AssistantMessage
↓
append
```

然后从已经构造完成的 Target：

```text
AssistantMessage.content[]
```

按 content order 收集：

```text
ToolCallBlock.toolCallId
```

成为新的：

```text
unresolvedToolCallIds
```

如果没有 ToolCallBlock：

```text
unresolvedToolCallIds = []
```

不读取 `AssistantMessage.stopReason` 判断是否需要 tool result。

------

#### ToolResultMessage

遇到 Source ToolResultMessage 时，先只读取：

```text
source.toolCallId
```

判断：

```text
unresolvedToolCallIds
│
├── does not contain source.toolCallId
│   → error
│
└── contains source.toolCallId
    ↓
    Chapter 8
    ↓
    append Target ToolMessage
    ↓
    remove source.toolCallId
    from unresolvedToolCallIds
```

因此自然覆盖：

```text
orphan result
duplicate result
late result
result belonging to another assistant
```

它们都会因为：

```text
toolCallId ∉ unresolvedToolCallIds
```

而失败。

如果 matching ToolResultMessage 存在，但 Chapter 8 无法忠实转换：

```text
→ error
```

不能把它当成 missing result 并生成 synthetic replacement。

真实 ToolResultMessage 按 Source order append，不重新排序。

------

#### End of messages

Source sequence结束后：

```text
flushMissingResults()
```

完成最终 Target sequence。

------

### 9.4 Invariants

最终：

```text
params.messages[]
```

必须满足：

```text
1. Source message order is preserved.

2. Synthetic ToolMessages are inserted only
   to complete missing tool results.

3. Every ToolMessage consumes a toolCallId
   from the current unresolvedToolCallIds.

4. All unresolved tool calls are completed
   before the next UserMessage or AssistantMessage,
   or before end of messages.

5. Correlation uses toolCallId only.

6. Real matching result
   → Chapter 8 conversion.

7. Missing result
   → synthetic ToolMessage.

8. Non-matching / orphan / duplicate / late result
   → error.
```

No additional repaired Pi message representation is constructed.



## 10. Tools

### 10.1 Target

CommandCode：

```ts
interface GenerateParams {
  tools: WireTool[];
}

interface WireTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
```

自然结构：

```text
params.tools[]
└── WireTool
    ├── name
    ├── description
    └── input_schema
```

`tools` required。

当当前请求没有可用 tool 时：

```text
tools = []
```

CommandCode `WireTool` 只包含：

```text
name
description
input_schema
```

不包含：

```text
runtime callback
permission state
MCP connection object
application metadata
strict
grammar
provider-specific tool configuration
```

CommandCode protocol 明确要求 tool definition 只发送这三个 wire fields。

------

#### `name`

required：

```text
name: string
```

表示发送给模型的 tool name。

------

#### `description`

required：

```text
description: string
```

表示模型可见的 tool description。

------

#### `input_schema`

required：

```text
input_schema: Record<string, unknown>
```

表示该 tool 接受的 input JSON Schema。

Target wire 中：

```text
input_schema
```

是 JSON object。

它描述 tool input structure，但本 conversion 不使用它重新验证 historical tool-call arguments。

Historical `tool-call.input` 的 conversion 和 validity 已由 AssistantMessage conversion 负责。

------

### 10.2 Source

Pi：

```ts
interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

本章使用：

```text
Context.tools?
```

Pi Tool：

```ts
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  constrainedSampling?:
    | false
    | ConstrainedSamplingConfig;
}
```

其中：

```text
name
description
parameters
```

提供 CommandCode `WireTool` 的实际 wire information。

`constrainedSampling` 是 Pi 定义的 optional provider-side constrained sampling configuration，与 `parameters` 并列，并不是 JSON Schema 本体的一部分。

------

#### `Tool.name`

构造：

```text
WireTool.name
```

需要：

```text
Tool.name
```

对应：

```text
Target name
← Source name
```

------

#### `Tool.description`

构造：

```text
WireTool.description
```

需要：

```text
Tool.description
```

对应：

```text
Target description
← Source description
```

------

#### `Tool.parameters`

构造：

```text
WireTool.input_schema
```

需要：

```text
Tool.parameters
```

Pi 使用 TypeBox `TSchema` 表示 tool parameter schema。

Pi 的 provider adapters 直接把 `Tool.parameters` 作为 JSON Schema representation 使用。例如 OpenAI adapter 直接：

```ts
parameters:
  tool.parameters as Record<string, unknown>
```

并明确说明 TypeBox 已经生成 JSON Schema。

Google adapter 同样可以直接把：

```text
Tool.parameters
```

作为 `parametersJsonSchema`。

因此 CommandCode conversion 不需要为 tool schema 创建新的 intermediate representation。

------

#### `Tool.constrainedSampling`

`constrainedSampling` 不直接构造任何 CommandCode field。

CommandCode WireTool 没有：

```text
strict
grammar
constrainedSampling
```

其中：

```text
json_schema + strict: "prefer"
→ target 不支持 strict 时允许 ordinary fallback

json_schema + strict: "require"
→ target 不支持 strict 时必须 error
```

因此 `constrainedSampling` 虽然不提供 CommandCode wire field，但会影响当前 Tool 的 construction result。

Pi 定义：

```ts
type ConstrainedSamplingConfig =
  | {
      type: "json_schema";
      strict: "prefer" | "require";
    }
  | {
      type: "grammar";
      variants: GrammarVariants;
    };
```

Pi 的实际 adapter helper 对这些 configuration 按目标 provider capability 进行 resolution，而不是把它们当作所有 provider 都必须实现的 Tool wire fields。

------

### 10.3 Construction Method

#### Constructing `params.tools`

先读取：

```text
Context.tools
```

如果 absent：

```text
Context.tools === undefined
↓
params.tools = []
```

如果存在：

```text
Tool[]
```

则保持 Source array order，逐个构造：

```text
Tool
↓
WireTool
```

不主动：

```text
sort tools
rename tools
merge tools
deduplicate tools
```

除非 Target contract 以后明确要求。

------

#### `name`

Construction：

```text
WireTool.name
=
Tool.name
```

Source value 原样保留。

------

#### `description`

Construction：

```text
WireTool.description
=
Tool.description
```

Source value 原样保留。

------

#### `input_schema`

Construction dependency：

```text
Tool.parameters
+
Target JSON object representation
```

构造：

```text
Tool.parameters
↓
preserve its JSON Schema structure
↓
WireTool.input_schema
```

语义上：

```text
input_schema
=
JSON-representable schema expressed by
Tool.parameters
```

不重新：

```text
compile schema
normalize schema
rename schema fields
remove schema keywords
rebuild properties
infer required fields
```

Pi provider source已经证明 `Tool.parameters` 本身就是可直接发送的 JSON Schema representation。

如果 `Tool.parameters` 在实际 Target serialization 中不能忠实表示为：

```text
Record<string, unknown>
```

则：

```text
→ error
```

不能通过 silent JSON loss 构造不同 schema。

------

#### `constrainedSampling`

`constrainedSampling` 不产生 Target wire field。

它决定当前 Pi Tool 是否可以退化为普通 CommandCode `WireTool`，或者必须因为无法满足 Source requirement 而失败。

------

##### Absent or `false`

```text
constrainedSampling absent
or
constrainedSampling === false
↓
ordinary WireTool construction
```

即：

```text
{
  name,
  description,
  input_schema
}
```

------

##### `json_schema` + `strict: "prefer"`

Pi shared resolution semantics：

```text
provider supports strict
→ use strict constrained sampling

provider does not support strict
+
strict = "prefer"
→ fallback
```

CommandCode WireTool 当前没有明确的 strict control：

```text
name
description
input_schema
```

因此按照 Pi 的 fallback semantic：

```text
strict = "prefer"
↓
ordinary CommandCode WireTool construction
```

不报错。

不需要为此修改：

```text
input_schema
```

也不添加任何额外 field。

------

##### `json_schema` + `strict: "require"`

Pi shared resolution semantics 对：

```text
strict = "require"
```

定义了 hard capability requirement。

当目标 provider 不支持 strict mode：

```text
→ error
```

当前 CommandCode protocol 没有定义：

```text
strict: true
validated tool mode
equivalent constrained-sampling guarantee
```

因此不能假设普通：

```text
input_schema
```

已经等价于 Pi：

```text
strict: "require"
```

当前 construction：

```text
constrainedSampling.type = "json_schema"
+
strict = "require"
+
no proven equivalent CommandCode capability
↓
cannot satisfy Source hard requirement
↓
error
```

如果以后 CommandCode protocol 明确证明存在等价 strict capability，则可以重新修改这一 branch。

------

##### `grammar`

Pi grammar constrained sampling 是 provider-specific alternative tool representation。

当 adapter 不支持 grammar tool 时，Pi helper直接：

```text
→ undefined
```

即允许 fallback，而不是 error。

只有当目标 adapter实际支持 grammar，并准备使用该 capability 时，Pi 才进一步读取：

```text
grammar variants
parameter schema shape
required string property
```

并构造 provider-specific grammar tool representation。

CommandCode WireTool 没有 grammar representation。

因此本 conversion：

```text
constrainedSampling.type = "grammar"
↓
CommandCode grammar capability unavailable
↓
use Pi-defined unsupported-provider fallback
↓
ordinary WireTool construction
```

不报错。

同时不需要继续读取或验证：

```text
variants.openai_lark
variants.openai_regex
grammar-specific parameter-shape restrictions
```

因为这些 information 只有在 Target 支持并实际使用 grammar capability 时才会影响 construction。

------

## 11. Final Request Assembly and Serialization

前面的章节已经分别完成 CommandCode request 各 Target subtree 的 construction。

本章不重新解释这些 Target values 如何从 Pi Source 构造，也不重新读取 Pi Source 做第二次 semantic conversion。

本章只负责：

```text
resolved CommandCode Target subtrees
↓
GenerateRequest assembly
↓
onPayload
↓
JSON serialization
↓
Prepared CommandCode Request
```

------

### 11.1 Final Assembly

前面的章节已经得到：

```text
resolved endpoint
resolved headers

GenerateRequest
├── config
├── memory
├── taste
├── skills
├── permissionMode
├── threadId
├── mode?
└── params
    ├── model
    ├── messages
    ├── tools
    ├── system?
    ├── max_tokens
    ├── stream
    ├── temperature?
    └── reasoning_effort?
```

这些 Target values 的 construction authority 属于前面的对应章节。

Final assembly 只组合这些已经构造完成的 values。

信息流：

```text
Pi Source
↓
local Target construction
↓
resolved Target subtrees
↓
GenerateRequest
```

本章不重新：

```text
read Model
read Context.messages
read Context.tools

convert messages
convert tools

resolve reasoning
repair tool sequence
calculate config
resolve session identity
```

如果 assembly 阶段仍然需要重新读取 Pi Source 才能决定某个 Target value，则该 information 的 conversion ownership 应回到前面的对应章节解决。

------

### 11.2 Semantic Conversion Completion

Pi → CommandCode request semantic conversion 完成于：

```text
Pi AI IR
↓
Target-driven construction
↓
GenerateRequest
```

此时：

```text
GenerateRequest
```

已经是 CommandCode-native representation。

后续：

```text
onPayload
JSON serialization
HTTP execution
```

不再属于 Pi Source semantic conversion。

因此：

```text
semantic conversion completion
≠
HTTP request execution
```

------

### 11.3 `onPayload`

Pi request options 提供：

```ts
onPayload?: (
  payload: unknown,
  model: Model
) =>
  | unknown
  | undefined
  | Promise<unknown | undefined>;
```

传给 callback 的 payload 是已经构造完成的：

```text
GenerateRequest
```

即 CommandCode HTTP body object。

它不包括：

```text
HTTP method
endpoint
headers
```

调用顺序：

```text
GenerateRequest
↓
onPayload(GenerateRequest, model)
↓
effectivePayload
```

如果：

```text
onPayload(...)
→ undefined
```

则：

```text
effectivePayload
=
original GenerateRequest
```

如果：

```text
onPayload(...)
→ replacement
```

则：

```text
effectivePayload
=
replacement
```

replacement 是后续 serialization 使用的完整 effective payload。

`onPayload` 不重新执行：

```text
Pi Message → CommandCode Message

Pi Tool → CommandCode Tool

Pi reasoning → CommandCode reasoning_effort
```

这些 conversion 已经在 callback 之前完成。

`onPayload` 是 Target-native payload hook。

如果 callback throw 或返回 rejected Promise：

```text
→ request preparation error
→ do not send request
```

一个 Provider invocation 中：

```text
onPayload
```

只在 request preparation 时执行一次。

HTTP retry 复用已经准备完成的 request payload，不重新运行 semantic conversion 或 `onPayload`。

------

### 11.4 JSON Serialization

CommandCode request body 使用 JSON wire representation。

因此：

```text
effectivePayload
↓
JSON.stringify
↓
bodyText
```

`bodyText` 才是实际发送的 HTTP body。

如果：

```text
JSON.stringify(effectivePayload)
```

throw，例如因为：

```text
BigInt
circular reference
other serialization failure
```

则：

```text
→ request preparation error
→ do not send request
```

如果 serialization 没有产生 string，例如：

```text
JSON.stringify(effectivePayload)
→ undefined
```

同样：

```text
→ request preparation error
→ do not send request
```

成功条件：

```text
typeof bodyText === "string"
```

本章不执行：

```text
JSON.stringify
↓
JSON.parse
↓
second full Target validation
```

也不在 serialization 后重新执行前面章节已经拥有的：

```text
message conversion
message sequence construction
tool conversion
reasoning resolution
image capability resolution
session identity resolution
config construction
```

------

### 11.5 `onPayload` and Target Validity

进入 `onPayload` 前：

```text
GenerateRequest
```

由 Chapters 3–10 按 CommandCode Target contract 构造。

如果 `onPayload` 返回 replacement，则该 replacement 是 caller 对 provider-native payload 的显式修改。

因此本 conversion 不为 replacement 建立第二套：

```text
GenerateRequest certification
provider authority
captured capability state
```

也不通过重新读取 Pi Source 来判断 callback 是否保留了原来的 semantic decisions。

例如本章不 capture 并重新比较：

```text
threadId
permissionMode
params.model
config
image capability
reasoning capability
```

`onPayload` replacement 的最终 wire compatibility 由：

```text
JSON serialization
+
CommandCode server
```

决定。

Converter 不对 callback result做猜测、修复或 silent normalization。

------

### 11.6 Request Preparation Completion

完整 request preparation 为：

```text
resolved CommandCode request values
↓
GenerateRequest assembly
↓
onPayload
↓
effectivePayload
↓
JSON.stringify
↓
bodyText
```

成功后形成：

```text
Prepared CommandCode Request
├── endpoint
├── stable application headers
└── bodyText
```

其中：

```text
bodyText
```

是当前 Provider invocation 的 authoritative serialized request body。

到这里 request preparation 完成。

------

### 11.7 Execution Boundary

以下行为属于 provider execution / transport runtime：

```text
attempt-local headers
traceparent construction
HTTP Request creation
fetch
timeout
retry
connection handling
response status
onResponse
response stream decoding
response reconstruction
cancellation
```

它们不属于 Pi → CommandCode semantic conversion。

尤其：

```text
traceparent
```

是 attempt-owned transport information，不进入 stable semantic request body。

------

### 11.8 Final Flow

最终 request path：

```text
Pi AI IR
↓
Target-driven conversion
↓
CommandCode GenerateRequest
──────── semantic conversion complete ────────
onPayload
↓
effective payload
↓
JSON.stringify
↓
bodyText
──────── request preparation complete ────────
HTTP execution
```

本章的核心原则：

```text
Construct Target once.

Do not recertify the same semantics
through a parallel authority model.

Allow the Pi provider-native payload hook
to inspect or replace the constructed payload.

Serialize the effective payload once.

If preparation cannot produce a JSON body,
fail before sending.
```





# Part II — Response: CommandCode → Pi AI IR

**Target是PI AI IR, source是Commandcode Private**

## 1. Overall Response Flow

CommandCode response path 包含三个连续但职责不同的阶段：

```text
CommandCode HTTP Response
↓
Response Reconstruction
↓
Committed CommandCode Response
↓
CommandCode → Pi AI IR Conversion
↓
Pi AssistantMessage
↓
Pi Event Emission
```

这三个阶段属于同一个 Provider response lifecycle，但不是同一种处理。

------

### 1.1 Response Reconstruction

Response Reconstruction 负责消费 CommandCode response protocol：

```text
CommandCode HTTP Response
↓
physical response stream
↓
CommandCode events
↓
protocol lifecycle validation
↓
Committed CommandCode Response
```

它负责理解：

```text
HTTP response
stream framing
event types
content lifecycle
finish / error / abort
physical EOF
```

它不负责构造 Pi `AssistantMessage`。

只有完整、合法并满足 CommandCode commit condition 的 response 才能进入下一阶段。

------

### 1.2 CommandCode → Pi AI IR Conversion

Semantic conversion 的输入是：

```text
Committed CommandCode Response
```

Target 是：

```text
Pi AssistantMessage
```

该阶段使用 Target-driven conversion：

```text
Pi AssistantMessage Target
↓
determine how each Target field is constructed
↓
read only the CommandCode information required
for that construction
↓
construct
↓
validate
↓
or fail
```

CommandCode response reconstruction 中存在、但 Pi Target construction 不需要的信息，不进入 conversion state。

------

### 1.3 Pi Event Emission

Semantic conversion 完成后得到完整：

```text
Pi AssistantMessage
```

然后按照 Pi `AssistantMessageEventStream` lifecycle 输出：

```text
Pi AssistantMessage
↓
start
↓
content events
↓
done / error
```

Pi Event Emission 不再解释 CommandCode response semantics，也不重新执行 CommandCode → Pi conversion。

Provider 使用 Pi 提供的：

createAssistantMessageEventStream()

创建返回给 Pi runtime 的 event stream。

------

### 1.4 Atomicity Boundary

在 CommandCode response commit 之前：

```text
no Pi semantic content is emitted
```

因此：

```text
failed physical attempt
malformed response
incomplete response
retryable transport failure
protocol lifecycle failure
```

都只能丢弃当前 attempt-local response state。

它们不能把 partial CommandCode content 泄漏到：

```text
Pi AssistantMessage
Pi start event
Pi content events
```

只有 committed CommandCode response 可以进入 semantic conversion。

## 2. CommandCode Response Reconstruction

CommandCode response reconstruction 负责把一个 HTTP response 的物理 JSONL stream 重建为一个完整、合法、可提交的 CommandCode response。

```text
CommandCode HTTP Response
↓
physical JSONL decoding
↓
accepted CommandCode events
↓
content lifecycle reconstruction
↓
finish / EOF validation
↓
Committed CommandCode Response
```

本章只负责 CommandCode response reconstruction。

它不构造 Pi `AssistantMessage`。

只有成功 committed 的 CommandCode response 才进入后续 Pi semantic conversion。

------

### 2.1 HTTP Response

Successful response：

```text
2xx
+
readable response body
→ consume response stream
```

如果：

```text
2xx
+
response body missing
```

则：

```text
→ transport failure
```

Non-2xx：

```text
→ HTTP failure
```

其 body 不进入 successful response reconstruction。

CommandCode successful response parsing 不以 `Content-Type` 为 gate。

即使 response header 为：

```http
Content-Type: text/event-stream
```

body 仍按 CommandCode bare JSONL 处理。

------

### 2.2 Physical Stream Decoding

CommandCode response framing：

```text
JSON object
LF
JSON object
LF
...
```

不是 conventional SSE。

因此不处理：

```text
data:
event:
id:
retry:
blank-line framing
[DONE]
```

Network chunk 不具有 event semantic。

Decoding：

```text
ReadableStream<Uint8Array>
↓
TextDecoder.decode(chunk, { stream: true })
↓
append to line buffer
↓
split complete LF-delimited lines
↓
trim framing whitespace
↓
skip empty lines
↓
JSON.parse(whole line)
↓
CommandCode event
```

Physical EOF：

```text
flush TextDecoder
↓
append remaining decoded text
↓
if final non-empty unterminated line exists
    parse it as one final JSON line
```

因此：

```text
HTTP chunk
≠ JSON line
≠ CommandCode event
```

一个 JSON line 可以跨多个 network chunks。

------

### 2.3 Accepted Event Types

LuckyToken response reconstruction 只接受当前 supported CommandCode response lifecycle 所需要的 event types：

```text
start
start-step

reasoning-start
reasoning-delta
reasoning-end

text-start
text-delta
text-end

tool-input-start
tool-input-delta
tool-input-end
tool-call

finish-step
finish
provider-metadata

error
```

每个 parsed JSON value 必须满足：

```text
object
+
non-empty string type
```

否则：

```text
→ protocol error
→ no committed response
```

以下 events 被接受但不改变 reconstruction state：

```text
start
start-step
finish-step
provider-metadata
```

即：

```text
accepted
→ no-op
```

Explicit CommandCode error：

```text
type = "error"
→ immediate response failure
→ no committed response
```

任何不在上述 whitelist 中的 event type：

```text
→ protocol error
→ no committed response
```

因此当前 reconstruction 不维护额外 unknown / ignored event taxonomy。

------

### 2.4 Ordered Content Reconstruction

Committed CommandCode content 是一个 ordered block sequence：

```text
content[]
├── Text
├── Reasoning
└── ToolUse
```

新的 content position 只由：

```text
text-start
reasoning-start
tool-input-start
```

创建。

Content order：

```text
content order
=
content-start event arrival order
```

而不是：

```text
completion order
content type
ID order
timestamp
```

Reconstruction state：

```text
Response Reconstruction State
├── slots[]
├── textById
├── reasoningById
├── toolById
└── finishCandidate?
```

`slots[]` 保存 start-event arrival order。

不同 content lifecycle 可以 overlap。

例如：

```text
reasoning-start A
text-start B
reasoning-end A
tool-input-start C
text-end B
...
```

最终 order：

```text
A
B
C
```

------

#### ID namespaces

Text、Reasoning、Tool 使用独立 ID namespaces：

```text
textById
reasoningById
toolById
```

同一个 ID 可以同时存在于不同 content kinds。

例如：

```text
Text id = "0"
Reasoning id = "0"
```

不冲突。

但同一 content kind 中 duplicate start ID：

```text
→ protocol error
```

任何：

```text
delta
end
final tool-call
```

如果找不到 matching open lifecycle：

```text
→ protocol error
```

Closed lifecycle 不再接受新的 lifecycle event。

不能：

```text
create placeholder
guess correlation
generate replacement ID
reorder slots
```

------

### 2.5 Text and Reasoning

#### Text

Lifecycle：

```text
text-start(id)
↓
text-delta(id)*
↓
text-end(id)
```

`text-start`：

```text
validate id
↓
reserve ordered content slot
↓
create open Text state
```

`text-delta`：

```text
require matching open Text
↓
require text string
↓
append text exactly
```

`text-end`：

```text
require matching open Text
↓
require completed text is non-empty after trim
↓
close Text
```

Validation：

```text
trim(reconstructedText).length > 0
```

`trim()` 只用于 validity check。

Stored content 不被 trim：

```text
validate with trim
≠
store trimmed text
```

完成后：

```text
Text.id
```

不再具有 downstream semantic用途。

最终 committed Text：

```text
{
  type: "text",
  text
}
```

------

#### Reasoning

Lifecycle：

```text
reasoning-start(id)
↓
reasoning-delta(id)*
↓
reasoning-end(id)
```

规则与 Text 相同：

```text
start
→ reserve ordered slot

delta
→ append exact text

end
→ require non-empty completed reasoning
→ close
```

`reasoning-start.providerMetadata` 不参与当前 committed response construction。

因此不保存。

完成后：

```text
Reasoning.id
```

同样只完成 reconstruction correlation 生命周期。

最终 committed Reasoning：

```text
{
  type: "reasoning",
  text
}
```

EOF 不能自动 close incomplete Text 或 Reasoning block。

------

### 2.6 Tool Lifecycle

CommandCode ToolUse lifecycle：

```text
tool-input-start
↓
tool-input-delta*
↓
tool-input-end
↓
tool-call
```

Correlation identity：

```text
tool-input-start.id
=
tool-input-delta.id
=
tool-input-end.id
=
tool-call.toolCallId
```

因此：

```text
Tool slot key
=
tool-input-start.id
```

不生成额外 internal Tool identity。

------

#### `tool-input-start`

Required fields：

```text
id
toolName
```

处理：

```text
validate id
validate toolName
↓
reserve ordered Tool slot
↓
create open Tool lifecycle
```

Start `toolName` 只需要满足 Source event validity。

Final ToolUse name 由后续：

```text
tool-call.toolName
```

提供，因此 start `toolName` 不需要保存为第二个 name representation。

------

#### `tool-input-delta`

每个 delta 必须：

```text
have matching open Tool
+
occur before tool-input-end
+
delta is string
```

`delta` 只属于 streamed input lifecycle。

Final ToolUse input 不由这些 deltas构造。

因此 reconstruction：

```text
validate delta
↓
discard delta value
```

不积累：

```text
preview
partial JSON
raw input buffer
```

也不使用 streamed delta 修补 final ToolCall input。

------

#### `tool-input-end`

```text
tool-input-end(id)
```

要求：

```text
matching open Tool
+
input not already ended
```

然后：

```text
inputEnded = true
```

Repeated `tool-input-end`：

```text
→ protocol error
```

它本身不 materialize ToolUse。

------

#### `tool-call`

Final `tool-call` 必须：

```text
have matching open Tool
+
toolCallId matches lifecycle id
+
input lifecycle already ended
```

Final ToolUse authority：

```text
id
← tool-call.toolCallId

toolName
← tool-call.toolName

input
← tool-call.input
   ?? tool-call.args
   ?? {}
```

Final `tool-call.toolName` 是唯一 committed ToolUse name authority。

不比较：

```text
tool-input-start.toolName
vs
tool-call.toolName
```

来制造额外 consistency requirement。

Final input 同样只来自 final `tool-call`。

不能使用 earlier `tool-input-delta` 内容修补：

```text
missing input
malformed input
null input
```

Nullish fallback：

```text
input
?? args
?? {}
```

完成后关闭 Tool lifecycle。

最终 committed ToolUse：

```text
{
  type: "tool_use",
  id,
  toolName,
  input
}
```

不保存：

```text
providerExecuted
dynamic
tool input preview
start toolName
```

因为后续 Pi Target construction 不需要这些 information。

------

### 2.7 Finish, Error, EOF and Commit

#### `finish`

`finish` 是当前 final response candidate。

当前后续 Pi conversion 只需要：

```text
finishReason?
totalUsage?
```

但 reconstruction 在 commit 前还需要：

```text
rawFinishReason?
```

判断 `pause_turn`。

因此 attempt-local finish candidate 可以包含：

```text
finishCandidate
├── finishReason?
├── rawFinishReason?
└── totalUsage?
```

每个新的 `finish`：

```text
→ completely replaces previous finish candidate
```

不能把 earlier finish 的 fields carry forward。

例如：

```text
finish #1
└── totalUsage exists

finish #2
└── totalUsage absent
```

最终：

```text
totalUsage absent
```

------

#### `finish` does not commit

收到：

```text
finish
```

后仍然继续读取 body。

因为：

```text
finish
≠ physical EOF
≠ commit
```

例如合法 transport sequence 可以是：

```text
finish-step
↓
finish
↓
provider-metadata
↓
physical EOF
```

所以：

```text
finish
→ update finish candidate
→ continue reading
```

不能在收到 finish 时提前开始 Pi semantic conversion。

------

#### `error`

```text
event.type = "error"
```

立即：

```text
→ response failure
→ no committed response
```

Error details 可以用于上层 error reporting / retry decision。

它不进入 committed semantic state。

------

#### Unsupported event

任何 whitelist 之外的 event：

```text
→ protocol error
→ no committed response
```

例如当前：

```text
abort
tool-result
future unknown event
```

都不具有单独 reconstruction semantic。

------

#### EOF without finish

Physical EOF 时如果：

```text
finishCandidate absent
```

则：

```text
→ incomplete / truncated response
→ no committed response
```

EOF 不能作为 implicit successful finish。

------

#### EOF with open content

如果 final finish 已存在，但 EOF 时仍存在：

```text
open Text
open Reasoning
open Tool
```

则：

```text
→ protocol error
→ no committed response
```

不能：

```text
auto-close
drop incomplete content
materialize partial ToolUse
guess missing lifecycle event
```

------

#### `pause_turn`

在 EOF commit evaluation 时：

```text
effectiveRawReason
=
rawFinishReason
?? finishReason
```

如果：

```text
effectiveRawReason === "pause_turn"
```

则：

```text
→ response failure
→ no committed response
```

`pause_turn` 到此处理结束。

它不会进入后续 `stopReason` conversion。

------

#### Commit

只有：

```text
physical EOF
+
final finish exists
+
all content lifecycles closed
+
no explicit error
+
no unsupported event
+
no malformed event
+
no lifecycle violation
+
final effective reason != "pause_turn"
```

才：

```text
→ commit
```

------

### 2.8 Committed CommandCode Response

成功 commit 后，只保留后续 Pi Target construction 真正需要的信息：

```text
Committed CommandCode Response
│
├── content[]
│   │
│   ├── Text
│   │   ├── type = "text"
│   │   └── text
│   │
│   ├── Reasoning
│   │   ├── type = "reasoning"
│   │   └── text
│   │
│   └── ToolUse
│       ├── type = "tool_use"
│       ├── id
│       ├── toolName
│       └── input
│
└── finish
    ├── finishReason?
    └── totalUsage?
```

对应 downstream dependencies：

```text
content[]
→ Chapter 4

finish.totalUsage?
→ Chapter 5

finish.finishReason?
→ Chapter 6
```

以下 information 在 commit 前已经完成生命周期，不进入 committed response：

```text
Text.id
Reasoning.id

tool input deltas
start toolName

rawFinishReason
```

当前 downstream Pi Target construction 也不需要：

```text
providerExecuted
dynamic
systemPromptTokens
finish-step
provider-metadata
response headers
gateway cost metadata
```

因此不保存。

Reconstruction 同样不创建：

```text
RawUsage
NormalizedUsage
response-level usage copy
```

Usage 保持为：

```text
finish.totalUsage?
```

直到 Chapter 5 直接构造 Pi `Usage`。

------

#### Attempt isolation

每个 HTTP attempt 拥有独立 reconstruction state。

```text
Attempt A
├── decoder
├── buffer
├── content lifecycle state
└── finish candidate

Attempt B
└── fresh independent state
```

Failed attempt：

```text
→ discard reconstruction state
```

Retry：

```text
→ start fresh reconstruction state
```

Atomic boundary：

```text
physical CommandCode response
↓
attempt-local reconstruction
↓
──────── COMMIT ────────
↓
Committed CommandCode Response
↓
Pi semantic conversion
```

Commit 前不产生 committed Pi semantic state。

## 3. Pi AssistantMessage Top-Level Fields

本章构造 Pi `AssistantMessage` 的简单 top-level fields。

复杂 Target subtree 分别由后续章节负责：

```text
AssistantMessage
│
├── role
│
├── content[]
│   └── Chapter 4
│
├── api
├── provider
├── model
├── responseModel?
├── responseId?
│
├── diagnostics?
│   └── later chapter if required
│
├── usage
│   └── Chapter 5
│
├── stopReason
│   └── Chapter 6
│
├── deferred?
├── errorMessage?
│   └── failure construction
│
├── rawStopReason?
│   └── Chapter 6
│
├── endTurn?
└── timestamp
```

本章只处理：

```text
role
api
provider
model
responseModel?
responseId?
deferred?
endTurn?
timestamp
```

------

### 3.1 Target

#### `role`

```ts
role: "assistant"
```

Required。

表示当前 Pi message 是 assistant response。

Target-defined fixed value：

```text
"assistant"
```

------

#### `api`

```ts
api: Api
```

Required。

表示产生当前 AssistantMessage 的 Pi API identity。

------

#### `provider`

```ts
provider: ProviderId
```

Required。

表示产生当前 AssistantMessage 的 Pi provider identity。

------

#### `model`

```ts
model: string
```

Required。

表示当前 Pi invocation 使用的 model identity。

`model` 属于 invocation identity，而不是从 response content 推导出来的 response metadata。

------

#### `responseModel`

```ts
responseModel?: string
```

Optional。

Pi 可以用它保存与 invoked `model` 不同的 concrete upstream response model。

当前 LuckyToken CommandCode conversion 不要求保存该额外 metadata。

因此当前 construction：

```text
responseModel
→ omit
```

既然 Target 当前允许 omission，就不需要继续读取或研究 CommandCode 中可能存在的 model-related response metadata。

------

#### `responseId`

```ts
responseId?: string
```

Optional。

Pi 可以用它保存 upstream provider-specific response/message identifier。

当前 LuckyToken CommandCode conversion 不要求保存该 identifier。

因此：

```text
responseId
→ omit
```

既然 Target 当前允许 omission，就不需要读取或分类 CommandCode response 中可能存在的各种 response、generation 或 request identifiers。

------

#### `deferred`

```ts
deferred?: DeferredHandle
```

Optional。

表示当前 AssistantMessage 对应一个 Pi deferred response。

当前 CommandCode response path 构造 ordinary completed AssistantMessage，不构造 deferred response。

因此：

```text
deferred
→ omit
```

------

#### `endTurn`

```ts
endTurn?: boolean
```

Optional。

表示 Provider 明确提供了 model 是否结束当前 turn 的 semantic。

当前 CommandCode → Pi conversion 不要求保存该额外 semantic。

因此：

```text
endTurn
→ omit
```

不能仅因为：

```text
finish
EOF
stopReason
absence of tool calls
```

存在，就生成该字段。

------

#### `timestamp`

```ts
timestamp: number
```

Required。

Pi `AssistantMessage.timestamp` 使用 Unix timestamp milliseconds。

当前 construction 使用当前 logical response lifetime 绑定的 local clock value。

------

### 3.2 Source

本章只读取构造 required Target fields 真正需要的信息。

需要的 dependency 为：

```text
Invocation
├── model.api
├── model.provider
└── model.id

Bound runtime dependency
└── now()
```

分别构造：

```text
api
provider
model
timestamp
```

本章不需要读取：

```text
Committed CommandCode Response
├── content
├── finish
└── response metadata
```

因为本章 required fields 不依赖这些 Source information。

同样，以下 optional Target fields 当前全部 omission：

```text
responseModel
responseId
deferred
endTurn
```

因此不会为了这些 fields 去读取：

```text
finish-step.response
providerMetadata
response headers
generation identifiers
model identifiers
timestamps
routing metadata
```

这些 Source information 不进入本章 conversion state。

------

### 3.3 Construction Method

#### `role`

不需要 Source。

Target-defined fixed value：

```text
role
→ "assistant"
```

Construction：

```ts
role: "assistant"
```

------

#### `api`

Construction dependency：

```text
AssistantMessage.api
← invoked model.api
```

在当前 logical response lifetime 开始时确定：

```text
model.api
↓
invokedApi
↓
AssistantMessage.api
```

该 value 在当前 response lifetime 内保持稳定。

不从 CommandCode response metadata 重新推断 `api`。

------

#### `provider`

Construction dependency：

```text
AssistantMessage.provider
← invoked model.provider
```

Resolve once：

```text
model.provider
↓
invokedProvider
↓
AssistantMessage.provider
```

不从 downstream routing metadata、HTTP headers 或 response provider metadata 推断。

------

#### `model`

Construction dependency：

```text
AssistantMessage.model
← invoked model.id
```

Resolve once：

```text
model.id
↓
invokedModelId
↓
AssistantMessage.model
```

它表达：

```text
the model used for this Pi invocation
```

而不是：

```text
arbitrary model-looking value found in response metadata
```

因此本字段不需要读取 CommandCode response。

------

#### `responseModel`

Target optional。

当前 conversion 不要求 preservation：

```text
responseModel
→ omit
```

Construction 到此结束。

不继续：

```text
search response metadata
compare model identifiers
normalize model names
select a candidate Source field
```

------

#### `responseId`

Target optional。

当前 conversion 不要求 preservation：

```text
responseId
→ omit
```

Construction 到此结束。

不继续读取：

```text
response IDs
generation IDs
request IDs
trace IDs
session IDs
```

也不维护这些 identifiers 的 unsupported / ignored inventory。

------

#### `deferred`

当前 CommandCode response construction 不产生 Pi deferred state：

```text
deferred
→ omit
```

不从其他 Source conditions推导 DeferredHandle。

------

#### `endTurn`

当前 conversion 不要求该 optional semantic：

```text
endTurn
→ omit
```

不从：

```text
finishReason
rawFinishReason
EOF
tool presence
```

推导 boolean value。

------

#### `timestamp`

不需要 CommandCode Source。

使用 bound local clock：

```text
now()
↓
responseTimestamp
↓
AssistantMessage.timestamp
```

`responseTimestamp` 在当前 logical response lifetime 中 resolve once。

随后同一个 authoritative value用于最终 AssistantMessage。

不因为 CommandCode response 中存在其他 timestamp-like metadata，就读取或比较这些 values。

------

### 3.4 Result

本章完成后构造出的 Target fields：

```text
AssistantMessage
│
├── role
│   → "assistant"
│
├── api
│   ← invokedApi
│
├── provider
│   ← invokedProvider
│
├── model
│   ← invokedModelId
│
├── responseModel
│   → omit
│
├── responseId
│   → omit
│
├── deferred
│   → omit
│
├── endTurn
│   → omit
│
└── timestamp
    ← responseTimestamp
```

其 information flow 为：

```text
Target required fields
↓
identify minimum dependencies
↓
Invocation identity
+
bound local clock
↓
construct
```

而不是：

```text
CommandCode response metadata
↓
enumerate identifiers / models / timestamps
↓
attempt to map everything into Pi
```

本章不会读取任何仅因为 Source 中存在、但当前 Pi Target construction 不需要的信息。

最终 boundary：

```text
Invocation / runtime dependencies
│
├── information required by Target
│   ├── api
│   ├── provider
│   ├── model
│   └── local timestamp
│
└── construct Pi fields

CommandCode response metadata
└── not required by this Target level
    → does not enter conversion state
```



## 4. `content[]`

本章构造 Pi `AssistantMessage.content`。

Pi Target：

```ts
content: (TextContent | ThinkingContent | ToolCall)[];
```

本章输入不是 CommandCode raw event stream。

第二章已经完成：

```text
CommandCode events
↓
content lifecycle reconstruction
↓
ordering
↓
completion validation
↓
Committed CommandCode Response
```

因此本章只处理：

```text
Committed CommandCode content[]
↓
Pi AssistantMessage.content[]
```

------

### 4.1 Target

Pi `content` 是 required ordered array：

```text
content[]
├── TextContent
├── ThinkingContent
└── ToolCall
```

Target type 允许：

```text
content = []
```

当前 conversion 需要构造的 fields：

```text
TextContent
├── type = "text"
└── text

ThinkingContent
├── type = "thinking"
└── thinking

ToolCall
├── type = "toolCall"
├── id
├── name
└── arguments
```

Pi 还允许以下 optional fields：

```text
TextContent.textSignature?

ThinkingContent.thinkingSignature?
ThinkingContent.redacted?

ToolCall.thoughtSignature?
ToolCall.namespace?
```

当前 conversion 不需要这些 optional metadata，因此：

```text
textSignature
thinkingSignature
redacted
thoughtSignature
namespace
→ omit
```

不为这些 fields 继续读取或研究 CommandCode metadata。

------

### 4.2 Source

本章只读取：

```text
Committed CommandCode Response
└── content[]
```

Relevant Source subtree：

```text
content[]
│
├── Text
│   ├── type = "text"
│   └── text
│
├── Reasoning
│   ├── type = "reasoning"
│   └── text
│
└── ToolUse
    ├── type = "tool_use"
    ├── id
    ├── toolName
    └── input
```

其中：

```text
block.type
```

决定构造哪个 Pi content variant。

其余 fields 直接提供对应 Target values。

本章不需要读取：

```text
Text.id
Reasoning.id
```

因为对应 Pi `TextContent` 和 `ThinkingContent` 没有 block ID。

同样不需要读取：

```text
ToolUse.providerExecuted
ToolUse.dynamic
```

因为当前 Pi required `ToolCall` construction 不依赖这些 fields。

------

### 4.3 Construction Method

保持 committed Source array order，逐项转换：

```text
Source content[0]
→ Target content[0]

Source content[1]
→ Target content[1]

...

Source content[n]
→ Target content[n]
```

因此：

```text
Pi content[] order
=
Committed CommandCode content[] order
```

不执行：

```text
sorting
grouping by type
merging adjacent blocks
splitting blocks
dropping representable blocks
```

------

#### Text

Source：

```text
Text
└── text
```

Target：

```text
TextContent
├── type
└── text
```

Construction：

```text
type
→ "text"

text
← Source.text
```

最终：

```ts
{
  type: "text",
  text: source.text
}
```

Source text 原值保留。

------

#### Reasoning

Source：

```text
Reasoning
└── text
```

Target：

```text
ThinkingContent
├── type
└── thinking
```

Construction：

```text
type
→ "thinking"

thinking
← Source.text
```

最终：

```ts
{
  type: "thinking",
  thinking: source.text
}
```

不需要读取：

```text
model.reasoning
```

来重新判断已经 committed 的 Reasoning block 是否可以构造为 Pi `ThinkingContent`。

------

#### ToolUse

Source：

```text
ToolUse
├── id
├── toolName
└── input
```

Target：

```text
ToolCall
├── type
├── id
├── name
└── arguments
```

Construction：

```text
type
→ "toolCall"

id
← Source.id

name
← Source.toolName
```

`arguments` 的 Target type 为：

```ts
Record<string, any>
```

因此 Source `input` 必须具有 top-level object shape：

```text
typeof input === "object"
&& input !== null
&& !Array.isArray(input)
```

如果成立：

```text
arguments
← Source.input
```

最终：

```ts
{
  type: "toolCall",
  id: source.id,
  name: source.toolName,
  arguments: source.input
}
```

如果 `input` 是：

```text
null
array
string
number
boolean
```

则不能构造 Pi required：

```text
arguments: Record<string, any>
```

因此 conversion error。

本章不执行额外：

```text
tool registry lookup
tool schema validation
deep clone requirement
custom serialization validation
argument normalization
future request replay validation
```

这些 information 不属于当前 Pi `ToolCall` construction dependency。

------

### 4.4 Information Boundary

进入本章 conversion state：

```text
Committed content[]
├── block order
├── block type
├── Text.text
├── Reasoning.text
└── ToolUse
    ├── id
    ├── toolName
    └── input
```

不进入本章：

```text
Text.id
Reasoning.id

ToolUse.providerExecuted
ToolUse.dynamic

model reasoning capability
tool definitions
provider metadata
CommandCode raw content deltas
```

Optional Pi fields：

```text
textSignature
thinkingSignature
redacted
thoughtSignature
namespace
```

当前全部：

```text
omit
```

最终 information flow：

```text
Committed CommandCode content[]
↓
preserve order
↓
map each block

Text.text
→ TextContent.text

Reasoning.text
→ ThinkingContent.thinking

ToolUse.id
→ ToolCall.id

ToolUse.toolName
→ ToolCall.name

ToolUse.input
→ ToolCall.arguments
↓
Pi AssistantMessage.content[]
```

## 5. `usage`

本章构造 Pi `AssistantMessage.usage`。

Pi Target：

```ts
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

自然结构：

```text
AssistantMessage
└── usage
    ├── input
    ├── output
    ├── cacheRead
    ├── cacheWrite
    ├── cacheWrite1h?
    ├── reasoning?
    ├── totalTokens
    └── cost
        ├── input
        ├── output
        ├── cacheRead
        ├── cacheWrite
        └── total
```

本章直接从 final CommandCode `finish.totalUsage` 构造 Pi `Usage`。

不创建额外：

```text
RawUsage
NormalizedUsage
```

作为中间 semantic representation。

------

### 5.1 Target

Pi 将 input-side token accounting 分为：

```text
input
cacheRead
cacheWrite
```

其中：

```text
input
```

表示普通 input tokens，不包含：

```text
cacheRead
cacheWrite
```

因此完整 input-side token count 为：

```text
input
+ cacheRead
+ cacheWrite
```

------

#### `output`

```ts
output: number
```

表示完整 model output token count。

------

#### `reasoning`

```ts
reasoning?: number
```

Optional。

当 provider 提供 reasoning token breakdown 时，它表示：

```text
reasoning
⊆
output
```

它不是额外 output token category，因此不再次加入：

```text
totalTokens
```

------

#### `cacheWrite1h`

```ts
cacheWrite1h?: number
```

Optional。

它表示：

```text
cacheWrite
```

中的 1-hour retention subset。

当前 CommandCode usage 不提供本 Target construction 所需的该 breakdown，因此当前 conversion：

```text
cacheWrite1h
→ omit
```

------

#### `totalTokens`

当前 Target 使用：

```text
totalTokens
=
input
+ cacheRead
+ cacheWrite
+ output
```

不另外加入：

```text
reasoning
cacheWrite1h
```

------

#### `cost`

```text
cost
├── input
├── output
├── cacheRead
├── cacheWrite
└── total
```

是 Pi `Usage` 的 required subtree。

LuckyToken 不重新定义 Pi pricing algorithm。

Cost 使用 Pi AI 提供的：

```ts
calculateCost(model, usage)
```

构造。

------

## 5.2 Source

本章只读取：

```text
Committed CommandCode Response
└── finish
    └── totalUsage?
```

当前 Target construction 所需的 Source subtree：

```text
totalUsage?
│
├── inputTokens?
│
├── inputTokenDetails?
│   ├── noCacheTokens?
│   ├── cacheReadTokens?
│   └── cacheWriteTokens?
│
├── outputTokens?
│
└── outputTokenDetails?
    └── reasoningTokens?
```

这些 fields 分别参与：

```text
noCacheTokens
→ input

inputTokens
→ input fallback

cacheReadTokens
→ cacheRead

cacheWriteTokens
→ cacheWrite

outputTokens
→ output

outputTokenDetails.reasoningTokens
→ reasoning
```

如果：

```text
totalUsage
```

absent，则等价于上述 Target dependencies 全部 absent。

各 required Pi usage categories 按下面的 construction rules 得到其 fallback values。

------

### Source information not required

本章不读取：

```text
totalUsage.totalTokens
totalUsage.cachedInputTokens
totalUsage.reasoningTokens
outputTokenDetails.textTokens
```

因为当前 Target construction 已经有其他直接 dependency。

同样不读取：

```text
finish-step.usage
finish-step.usage.raw

providerMetadata
gateway cost metadata
provider billing metadata
```

这些 information 不参与当前 Pi `Usage` construction。

------

## 5.3 Construction Method

### `cacheRead`

Target：

```ts
cacheRead: number
```

Source：

```text
inputTokenDetails.cacheReadTokens
```

Construction：

```text
cacheReadTokens present
→ cacheRead = cacheReadTokens

cacheReadTokens absent
→ cacheRead = 0
```

不读取：

```text
cachedInputTokens
```

作为第二个 representation。

------

### `cacheWrite`

Target：

```ts
cacheWrite: number
```

Source：

```text
inputTokenDetails.cacheWriteTokens
```

Construction：

```text
cacheWriteTokens present
→ cacheWrite = cacheWriteTokens

cacheWriteTokens absent
→ cacheWrite = 0
```

------

### `input`

Target：

```ts
input: number
```

Pi `input` 不包含 cache-read 或 cache-write tokens。

最直接 Source：

```text
inputTokenDetails.noCacheTokens
```

如果 present：

```text
input
=
noCacheTokens
```

到此完成 `input` construction。

不再为了该 Target field读取：

```text
inputTokens
```

------

如果：

```text
noCacheTokens
```

absent，则读取 aggregate：

```text
inputTokens
```

并构造：

```text
totalInput
=
inputTokens ?? 0
```

然后：

```text
input
=
totalInput
- cacheRead
- cacheWrite
```

如果该计算无法形成合法的 non-negative input token count，则：

```text
→ conversion error
```

不使用：

```text
cachedInputTokens
```

或其他 alias 来修补结果。

------

### `output`

Target：

```ts
output: number
```

Source：

```text
totalUsage.outputTokens
```

Construction：

```text
outputTokens present
→ output = outputTokens

outputTokens absent
→ output = 0
```

不通过：

```text
textTokens
+
reasoningTokens
```

反推 output。

因此：

```text
outputTokenDetails.textTokens
```

不进入 conversion state。

------

### `reasoning`

Target：

```ts
reasoning?: number
```

当前使用：

```text
outputTokenDetails.reasoningTokens
```

作为 Source。

如果 present：

```text
reasoning
=
outputTokenDetails.reasoningTokens
```

如果 absent：

```text
reasoning
→ omit
```

不继续读取：

```text
totalUsage.reasoningTokens
```

作为第二个 alias。

当前 conversion 不维护 reasoning token source precedence 或 consistency checks。

------

### `cacheWrite1h`

当前 CommandCode usage 没有构造该 Target field 所需的 1-hour cache-write breakdown。

因此：

```text
cacheWrite1h
→ omit
```

到此停止。

不继续读取其他 metadata 来推断 retention duration。

------

### `totalTokens`

不需要额外 CommandCode Source。

直接使用已经构造完成的 Pi token categories：

```text
totalTokens
=
input
+ cacheRead
+ cacheWrite
+ output
```

因此不读取：

```text
totalUsage.totalTokens
```

也不拿 Source `totalTokens` 做额外 consistency validation。

------

### `cost`

先构造 Pi `Usage` token fields：

```text
usage
├── input
├── output
├── cacheRead
├── cacheWrite
├── cacheWrite1h → omit
├── reasoning?
├── totalTokens
└── cost
```

初始化 required cost subtree，然后使用当前 invocation 的 Pi model：

```text
model
+
usage
↓
Pi calculateCost(model, usage)
↓
usage.cost
```

具体 pricing tier、cache pricing 和 cost calculation semantics 由 Pi AI `calculateCost()` 定义。

LuckyToken 不复制这些算法到 conversion contract，也不根据 CommandCode gateway billing metadata重新计算另一套 cost。

------

## 5.4 Complete Construction

完整信息流：

```text
finish.totalUsage
↓
read only fields required by Pi Usage
↓
construct
│
├── cacheRead
├── cacheWrite
├── input
├── output
└── reasoning?
↓
cacheWrite1h
→ omit
↓
totalTokens
=
input + cacheRead + cacheWrite + output
↓
Pi calculateCost(model, usage)
↓
Pi Usage
```

最终 Target：

```text
Usage
├── input
├── output
├── cacheRead
├── cacheWrite
├── cacheWrite1h → omit
├── reasoning?
├── totalTokens
└── cost
    ├── input
    ├── output
    ├── cacheRead
    ├── cacheWrite
    └── total
```

------

## 5.5 Information Boundary

进入本章 conversion state：

```text
finish.totalUsage
├── inputTokens?
├── inputTokenDetails?
│   ├── noCacheTokens?
│   ├── cacheReadTokens?
│   └── cacheWriteTokens?
├── outputTokens?
└── outputTokenDetails?
    └── reasoningTokens?
```

Bound dependency：

```text
invoked Pi model
```

仅用于：

```text
calculateCost(model, usage)
```

不进入本章：

```text
totalUsage.totalTokens
totalUsage.cachedInputTokens
totalUsage.reasoningTokens
outputTokenDetails.textTokens

finish-step.usage
finish-step.usage.raw

gateway-reported cost
provider billing metadata
```

本章不创建：

```text
RawUsage
NormalizedUsage
PricingAuthority
UsageConsistencyState
```

正确 information lifecycle：

```text
CommandCode finish.totalUsage
↓
Pi Usage token construction
↓
Pi calculateCost()
↓
complete Pi Usage
```

构造完成后，CommandCode usage representation 不再需要继续存在于后续 Pi semantic conversion state。

## 6. `stopReason`

本章构造 Pi `AssistantMessage.stopReason`。

进入本章的 Source 已经是：

```text
Committed CommandCode Response
```

CommandCode response reconstruction 已经负责处理 response error、abort、protocol failure 和 `pause_turn`。

因此本章只处理 successful committed response 的 terminal reason conversion。

### 6.1 Target

当前 successful CommandCode response 需要构造的 Pi `stopReason` 只有：

```text
stop
length
toolUse
```

其中：

```text
"stop"
→ normal end-turn

"length"
→ output token limit

"toolUse"
→ model emitted tool calls
```

Pi 其他 `StopReason` variants 不属于本章 construction。

### 6.2 `rawStopReason`

Pi Target 允许：

```ts
rawStopReason?: string;
```

当前 CommandCode conversion 不需要保存 provider-specific raw terminal reason。

因此：

```text
rawStopReason
→ omit
```

不读取 `rawFinishReason` 来构造其他 Target field。

### 6.3 Source

本章只读取：

```text
Committed CommandCode Response
└── finish
    └── finishReason?: string
```

`finishReason` 是本章唯一 Source dependency。

CommandCode terminal normalization：

```text
finishReason
├── "tool-calls"
│   → tool-use termination
│
├── "length"
│   → token-limit termination
│
└── other string / missing
    → ordinary end-turn
```

其中 `other` 包括任何不是：

```text
"tool-calls"
"length"
```

的 value。

例如：

```text
"stop"
"error"
future provider-specific string
```

都属于 ordinary end-turn fallback。

这里的：

```text
finishReason = "error"
```

只是 `finish` event 中的一个 reason value。

它不同于：

```text
event.type = "error"
```

后者已经由 CommandCode response reconstruction 作为 response failure 处理，不会产生 committed response。

### 6.4 Construction Method

Construction 只需要三个 branch：

```text
finishReason === "tool-calls"
→ stopReason = "toolUse"

finishReason === "length"
→ stopReason = "length"

otherwise
→ stopReason = "stop"
```

即：

```text
CommandCode finishReason     Pi stopReason
──────────────────────────────────────────
"tool-calls"              → "toolUse"
"length"                  → "length"
other string              → "stop"
missing                   → "stop"
```

不维护 CommandCode finish-reason whitelist。

不因为 unknown or future string 报错。

不因为 `finishReason` missing 报错。

### 6.5 Information Boundary

进入本章 conversion state：

```text
finish.finishReason?
```

不进入本章：

```text
finish.rawFinishReason
content
usage
provider metadata
finish-step
HTTP metadata
```

最终信息流：

```text
Committed CommandCode Response
↓
finish.finishReason
↓
exact "tool-calls" ?
├── yes → "toolUse"
└── no
    ↓
    exact "length" ?
    ├── yes → "length"
    └── no  → "stop"
↓
Pi AssistantMessage.stopReason
```

## 7. Pi Event Stream API Integration

CommandCode → Pi conversion 在完整 `AssistantMessage`
构造完成后结束。

Provider 使用 Pi 提供的：

createAssistantMessageEventStream()

创建返回给 Pi runtime 的 event stream。

由于 CommandCode response 在 commit 后才转换为完整
AssistantMessage，LuckyToken 将完整 message replay 为 Pi
events：

Successful AssistantMessage
↓
start
↓
for each content[] in order
├── Text
│   → text_start
│   → text_delta(full text)
│   → text_end
├── Thinking
│   → thinking_start
│   → thinking_delta(full thinking)
│   → thinking_end
└── ToolCall
    → toolcall_start
    → toolcall_end
↓
done {
  reason: message.stopReason,
  message
}

原始 CommandCode deltas 不参与 replay。

ToolCall 已经只有完整 arguments，因此不制造
synthetic toolcall_delta。
