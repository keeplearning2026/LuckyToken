# LuckyToken — TypeScript Core Architecture Specification

**Status:** Draft for Review
**Scope:** Core only
**Primary Runtime:** `@earendil-works/pi-ai`
**Excluded:** UI、Desktop Presentation、Manager UI、发布界面、产品交互设计

------

# 1. Architecture Foundation

## 1.1 Purpose

LuckyToken Core 是一个本地 HTTP / Protocol Router。

它负责把不同客户端协议转换为 Pi 能理解的模型调用，并把 Pi 的结果转换回客户端协议。

Core 的本质不是重新实现一个 LLM Engine。

其核心数据流只有：

```text
Client Request
      ↓
Model + Context + Options
      ↓
pi-ai
      ↓
AssistantMessage
      ↓
Client Response
```

其中：

```text
Model
= 调用哪个模型

Context
= 模型看到什么

Options
= 本次如何调用模型
```

Router 的前半段最终必须收敛到：

```text
Model + Context + Options
```

Router 的后半段只从：

```text
AssistantMessage
```

开始。

不得在两者之间建立第二套语义 IR。

------

## 1.2 Core Design Principles

### High Cohesion

信息与处理该信息的逻辑必须位于同一模块。

例如：

```text
Anthropic message semantics
→ anthropic module

CommandCode SSE semantics
→ commandcode provider

Provider credential
→ Pi Provider/Auth

HTTP disconnect
→ HTTP boundary
```

不得让同一语义散落在多个模块。

------

### Low Coupling

模块只能依赖完成自身职责所需要的最小 Contract。

如果模块只需要：

```ts
Model<Api>
```

就不得同时传：

```text
providerId
modelId
model selector
ProviderConfig
ModelConfig
```

------

### Information Ownership

每一类信息必须有明确 owner。

一个模块不得因为“以后可能有用”而保留不属于自己的信息。

------

### Short Information Lifetime

信息完成使命后立即退出主调用链。

例如：

```text
client model selector
↓
Model Resolver
↓
Pi Model
```

得到 `Model` 后，selector 即死亡。

------

### Single Representation

同一事实在同一生命周期阶段只保留一种有效表示。

禁止长期同时存在：

```text
modelSelector
providerId
modelId
resolvedProvider
resolvedModel
executionTarget
```

成功 resolve 后，只保留：

```ts
Model<Api>
```

------

### Small Contracts

模块间使用真实的小型 Contract。

优先：

```ts
toContext(request, model)
```

而不是：

```ts
toContext(
  request,
  config,
  auth,
  project,
  provider,
  logger,
  timing,
  runtime,
)
```

------

### No Universal Request Context

禁止建立：

```ts
interface RequestContext {
  request
  auth
  project
  provider
  model
  config
  timing
  logger
  signal
  ...
}
```

如果某个函数需要其中很多字段，应重新检查模块边界。

------

### Reuse Pi Contracts

凡是 `pi-ai` 已有公开语义类型，应直接使用。

例如：

```text
Model
Context
Provider
Models
AssistantMessage
Credential
CredentialStore
ModelsStore
AuthInteraction
```

不得重新定义 Router 版本。

------

### No Premature Abstraction

不为了“以后可能扩展”提前建立：

```text
Router Core
ExecutionPlan
Policy Engine
Engine Registry
Provider Engine
Routing Engine
Canonical Request
Canonical Response
```

只有真实重复或真实能力缺口出现时才允许增加抽象。

------

# 2. System Layering

Core 分为六层。

```text
┌─────────────────────────────────────────────┐
│ Layer 0 — Application Composition           │
│                                             │
│ config / files / providers / Models         │
└───────────────────┬─────────────────────────┘
                    │ Models
                    ▼
┌─────────────────────────────────────────────┐
│ Layer 1 — HTTP Boundary                     │
│                                             │
│ HTTP request / response / AbortSignal       │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ Layer 2 — Router Access                     │
│                                             │
│ Client authorization                       │
│ → minimal RequestOverrides                  │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ Layer 3 — Client Protocol                   │
│                                             │
│ Anthropic / OpenAI Chat / Responses         │
│ → Model + Context + Options                 │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ Layer 4 — Pi Execution                      │
│                                             │
│ model resolution / atomic execution         │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ Layer 5 — Provider                          │
│                                             │
│ Pi built-ins / CommandCode / Provider Auth  │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
                 Upstream
```

返回路径：

```text
Provider
↓
AssistantMessageEventStream
↓
Atomic Executor
↓
AssistantMessage
↓
Protocol Renderer
↓
HttpResponse
```

------

## 2.1 Dependency Direction

允许：

```text
Application Composition
        ↓
HTTP
        ↓
Router Access
        ↓
Protocol
        ↓
Pi Contracts
        ↓
Provider
```

Startup 依赖方向：

```text
Pi-derived infrastructure
        ↓
create-models
        ↓
Models
        ↓
Request Plane
```

禁止：

```text
Provider
→ Client Protocol

Client Protocol
→ CommandCode implementation

Protocol
→ models.json parser

Request Plane
→ ModelConfig

HTTP
→ CommandCode SSE parser

Provider
→ Router Auth internals
```

------

# 3. Pi Integration Layer

## 3.1 Runtime Dependency

Core 直接依赖：

```text
@earendil-works/pi-ai
```

不直接依赖完整：

```text
@earendil-works/pi-coding-agent
```

原因是 Coding Agent 同时包含：

```text
Agent session
TUI
tools
compaction
extensions
RPC
package management
interactive mode
```

这些不属于 Router Core。

------

## 3.2 Directly Reused Pi Contracts

Core 直接使用：

| Area                   | Pi Contract                   |
| ---------------------- | ----------------------------- |
| Model                  | `Model<Api>`                  |
| Semantic input         | `Context`                     |
| Provider               | `Provider`                    |
| Provider collection    | `Models` / `MutableModels`    |
| Runtime creation       | `createModels()`              |
| Execution              | `stream()` / `streamSimple()` |
| Result                 | `AssistantMessage`            |
| Streaming              | `AssistantMessageEventStream` |
| Credentials            | `Credential`                  |
| Credential persistence | `CredentialStore`             |
| Model cache            | `ModelsStore`                 |
| Provider auth          | `AuthResult` / `AuthCheck`    |
| Login                  | `Models.login()`              |
| Logout                 | `Models.logout()`             |
| Login interaction      | `AuthInteraction`             |
| Login prompt           | `AuthPrompt`                  |
| Login events           | `AuthEvent`                   |
| Provider refresh       | `Models.refresh()`            |
| Available models       | `Models.getAvailable()`       |

这些 Contract 不做 Router wrapper，除非出现真实 Router-specific policy。

------

## 3.3 Pi Agent-derived Infrastructure

从 Pi Coding Agent 中只派生构造 `Models` 所必须的成熟基础设施。

预计包括：

```text
model-config
provider-composer
auth-storage
models-store
resolve-config-value
```

以及真实 import graph 中必要的 minimal helpers。

------

## 3.4 Extraction Rule

正式抽取前必须执行：

```text
target source files
↓
import closure audit
↓
classify dependencies
↓
copy only necessary code
```

不得：

```text
复制整个 core/
复制整个 coding-agent/
复制 ModelRuntime 及其全部依赖
```

------

## 3.5 Explicitly Excluded Pi Agent Modules

Core 不引入：

```text
ModelRuntime
ModelRegistry
RuntimeCredentials
AgentSession
interactive /login command
/model TUI
extensions runtime
tools
session
RPC
package manager
remote catalog product layer
```

除非未来出现明确需求重新评估。

------

## 3.6 Vendor Isolation

Pi-derived 代码推荐位于：

```text
src/vendor/pi-models/
```

例如：

```text
src/vendor/pi-models/
├─ model-config.ts
├─ provider-composer.ts
├─ auth-storage.ts
├─ models-store.ts
├─ resolve-config-value.ts
└─ minimal-support-files/
```

Request Plane 不得直接 import 这些文件。

唯一主要消费者应为：

```text
src/pi/create-models.ts
```

------

## 3.7 Upstream Synchronization

每个派生文件记录：

```text
Upstream repository
Upstream source path
Upstream version / commit
Router-specific modifications
```

原则：

> Vendor-derived code 尽量保持 upstream shape。

禁止为了统一 Router 风格进行无必要重写。

更新 Pi 时：

```text
old upstream
vs
new upstream
vs
Router derived copy
```

必须可直接审查。

------

# 4. Startup Layer

Startup Layer 的目标只有一个：

```text
configuration
→ Models
```

------

## 4.1 Router Data Directory Module

### Responsibility

提供 Router 自己的可写数据目录。

Core 不访问：

```text
~/.pi/agent/
```

推荐逻辑结构：

```text
<router-data>/
├─ config.json
├─ models.json
├─ auth.json
└─ models-store.json
```

Windows 可映射到应用独立 data directory，例如 AppData。

------

### Owns

```text
data directory path
config file paths
```

------

### Must Not Know

```text
Anthropic
OpenAI
Pi Context
CommandCode SSE
model selection
```

------

### Output Contract

推荐：

```ts
interface RouterPaths {
  config: string
  models: string
  auth: string
  modelsStore: string
}
```

这个对象只属于 Startup Plane。

不得进入普通 request execution。

------

## 4.2 `config.json` Module

### Responsibility

只保存 Router 自身运行配置。

例如：

```text
host
port
LAN
Router Auth
timeouts
atomic limits
Direct mode
logging
```

------

### Must Not Contain

```text
Pi Model catalog
Pi Provider models
Provider OAuth credential
Provider model metadata
```

------

## 4.3 `models.json` Module

### Responsibility

定义 Provider / Model 配置。

采用 Pi Agent-compatible 语义。

包含：

```text
Provider
baseUrl
api
apiKey source
headers

models
reasoning
thinkingLevelMap
input
cost
contextWindow
maxTokens
samplingParams
compat
modelOverrides
```

------

### Output

```text
ModelConfig
```

随后进入：

```text
Provider Composer
```

------

### Lifetime

```text
models.json bytes
↓
ModelConfig
↓
Providers
↓
Models
```

Provider composition 完成后，parsed config 不进入 Request Plane。

------

## 4.4 CredentialStore Module

### Responsibility

提供：

```text
CredentialStore
↔ auth.json
```

------

### Owns

```text
credential persistence
file locking
serialized modification
credential deletion
```

------

### Must Not Know

```text
HTTP client token
Router project token
Anthropic message format
CommandCode protocol
```

------

### Contract

直接实现 Pi：

```ts
CredentialStore
```

------

### Lifetime

`CredentialStore` 实例进入 `Models` composition。

普通请求不直接读取：

```text
auth.json
```

------

## 4.5 ModelsStore Module

### Responsibility

提供：

```text
ModelsStore
↔ models-store.json
```

用于动态 Provider catalog persistence。

------

### Owns

```text
provider model cache
cache persistence
cache serialization
```

------

### Must Not Know

```text
Protocol
Router Auth
request model selector
```

------

## 4.6 Provider Composer Module

### Responsibility

组合：

```text
Pi built-in Provider
+
models.json
+
Router custom provider extension
↓
final Pi Provider
```

------

### Owns

```text
model configuration projection
provider override
model override
provider auth composition
custom streamSimple registration
```

------

### Output Contract

```ts
Provider
```

------

### Important Rule

Router 不自行构造：

```ts
Model<Api>
```

Pi-compatible Provider Composer 负责：

```text
models.json
→ Pi Model[]
```

------

## 4.7 Built-in Provider Registration Module

### Responsibility

从 `pi-ai` 获取 built-in Providers。

不得复制 built-in Provider implementations。

------

### Output

```text
Provider[]
```

------

## 4.8 CommandCode Registration Module

### Responsibility

为 Provider Composer 提供 CommandCode custom execution implementation。

只提供类似：

```ts
{
  api: "commandcode",
  streamSimple: commandCodeStreamSimple,
}
```

------

### Must Not Own

```text
CommandCode Model construction
model catalog
Router Model schema
```

这些来自：

```text
models.json
+
provider composer
```

------

## 4.9 `createRouterModels` Composition Root

推荐模块：

```text
src/pi/create-models.ts
```

### Responsibility

唯一负责构建 `Models`。

------

### Conceptual Flow

```text
RouterPaths
   │
   ├─ models.json
   │      ↓
   │   ModelConfig
   │
   ├─ auth.json
   │      ↓
   │ CredentialStore
   │
   └─ models-store.json
          ↓
       ModelsStore

           +
      createModels()
           +
 Pi built-in Providers
           +
 CommandCode registration
           ↓
         Models
```

------

### Public Contract

```ts
async function createRouterModels(
  paths: RouterPaths,
  signal?: AbortSignal,
): Promise<Models>
```

具体参数在实现阶段保持最小。

------

### Must Not Do

```text
login presentation
HTTP routing
model request resolution
Protocol parsing
Context conversion
Options conversion
Pi execution
response rendering
```

------

### Information Lifetime

完成：

```ts
Models
```

构造后，以下 Startup 信息不得继续传播：

```text
RouterPaths
ModelConfig
CredentialStore implementation
ModelsStore implementation
ProviderConfig
```

Request Plane 只获得：

```ts
Models
```

------

# 5. HTTP and Access Layer

## 5.1 HTTP Boundary Module

### Responsibility

负责 transport。

------

### Owns

```text
method
path
headers
body bytes
connection
AbortSignal

response status
response headers
response bytes
```

------

### Input Contract

真实 socket / HTTP runtime。

------

### Internal Contract

```ts
interface HttpRequest {
  method: string
  path: string
  headers: Headers
  body: Uint8Array
  signal: AbortSignal
}
```

------

### Output Contract

```ts
interface HttpResponse {
  status: number
  headers: Headers
  body: Uint8Array
}
```

------

### Must Not Know

```text
tool_use
tool_result
reasoning
thinking
Pi ToolCall
CommandCode SSE
Provider credentials
```

------

### Information Lifetime

```text
raw HTTP
↓
HttpRequest
↓
Protocol selection
```

Raw body 在 Protocol parse 后结束生命周期。

------

## 5.2 Abort Ownership

HTTP Boundary 创建唯一 request-level：

```ts
AbortSignal
```

来源：

```text
client disconnect
request abort
Ctrl+C propagated disconnect
```

Signal 是少数允许贯穿整个 request lifetime 的信息。

传播：

```text
HTTP
↓
Options.signal
↓
Pi
↓
Provider
↓
fetch
```

------

## 5.3 Router Authentication Module

### Responsibility

回答：

> Client 是否允许调用 CCR？

------

### Owns

```text
global token
project token
authorization validation
project lookup
```

------

### Input

最小 HTTP auth information。

------

### Output Contract

推荐：

```ts
interface RequestOverrides {
  headers?: Record<string, string>
}
```

只有真实需要时才增加：

```ts
apiKey?: string
```

------

### Global Token

成功后通常：

```text
RequestOverrides = empty
```

原 token 立即死亡。

------

### Project Token

可能产生：

```text
x-project-slug
```

等 request-local upstream information。

转换为：

```text
RequestOverrides.headers
```

后：

```text
project credential
project auth object
project lookup state
```

立即退出核心调用链。

------

### Must Not Know

```text
Pi Context
Anthropic tool structure
CommandCode SSE
Provider OAuth credential
```

------

## 5.4 Router Auth vs Provider Auth

必须严格区分：

```text
Router Auth
= 谁可以调用 CCR？

Provider Auth
= CCR 如何认证到上游？
```

两者不得共享 Auth Manager。

------

# 6. Client Protocol Layer

Client Protocol Layer 负责：

```text
Client wire
↔
Pi semantics
```

每个协议独立。

------

## 6.1 Common Module Shape

推荐：

```text
protocols/<protocol>/
├─ parse.ts
├─ context.ts
├─ options.ts
└─ response.ts
```

这是组织约定，不强制建立大型 `ProtocolAdapter` interface。

------

## 6.2 Protocol Module Contract

每个协议最终完成：

```text
request.model
→ Model

semantic request
→ Context

call controls
→ Options
```

返回路径：

```text
AssistantMessage
→ Client protocol response
```

------

# 6.3 Model Resolution Module

推荐：

```text
src/pi/resolve-model.ts
```

虽然在物理目录属于 Pi support，但逻辑上服务于 Protocol Request Processing。

------

### Responsibility

```text
client model selector
+
Models
→
Model<Api>
```

------

### Input Contract

```ts
resolveRequestModel(
  models: Models,
  selector: string,
): Model<Api>
```

------

### Standard Selector

```text
provider/model-id
```

例如：

```text
commandcode/DeepSeekAI/DeepSeek-V4-Pro
openrouter/openai/gpt-5.6
anthropic/claude-opus-4-8
```

------

### Parsing Rule

只在第一个 `/` 分割。

```text
openrouter/openai/gpt-5.6
```

解析为：

```text
provider = openrouter

modelId = openai/gpt-5.6
```

Model ID 本身允许包含 `/`。

------

### Provider-prefixed Resolution

如果 prefix 对应已注册 Pi Provider：

```ts
models.getModel(provider, modelId)
```

必须 exact。

------

### Bare Model Resolution

如果没有有效 provider prefix：

```text
model-id
```

只允许全局 exact match。

如果恰好一个：

```text
success
```

如果多个：

```text
ambiguous_model
```

如果零个：

```text
model_not_found
```

------

### Explicitly Forbidden

API request model resolution 不允许：

```text
fuzzy matching
substring matching
model display-name matching
default provider guessing
credential-based provider guessing
catalog order fallback
unknown model fallback
weighted routing
combo routing
```

------

### Must Not Know

```text
HTTP auth
Anthropic
OpenAI
CommandCode
Provider credential
Direct policy
```

------

### Lifetime

```text
selector
↓
Model
```

成功后 selector parsing state 死亡。

核心执行只保留：

```ts
Model<Api>
```

------

# 6.4 Anthropic Protocol Module

## Responsibility

```text
Anthropic Messages wire
↔
Pi semantics
```

------

## Submodules

```text
anthropic/
├─ parse.ts
├─ context.ts
├─ options.ts
└─ response.ts
```

------

## `parse.ts`

### Owns

```text
Anthropic request JSON shape
field validation
protocol-level syntax
```

### Input

```text
body bytes
```

### Output

```text
Anthropic request object
```

### Death Point

raw body 不再继续传播。

------

## `context.ts`

### Responsibility

```text
Anthropic semantic request
→ Pi Context
```

### Owns

```text
system
user
assistant
tool_use
tool_result
image
thinking
redacted thinking
tools
```

### May Know

必要的 Pi Model capability：

```text
model.input
model.reasoning
```

用于验证：

```text
image supported?
reasoning supported?
```

### Must Not Know

```text
model.provider === commandcode
Provider credential
Router Auth
HTTP status
CommandCode wire
```

### Output

```ts
Context
```

### Death Point

Anthropic message semantic representation 转成 Context 后，不再进入 Pi execution。

------

## `options.ts`

### Responsibility

```text
Anthropic call controls
+
request-local infrastructure controls
→ Pi Options
```

### Inputs

```text
Anthropic request controls
AbortSignal
RequestOverrides
Router defaults
```

### Output

Pi-compatible execution options。

### Typical Fields

```text
maxTokens
temperature
reasoning
metadata
headers
signal
```

### Must Not Read

```text
auth.json
Provider OAuth credential
models.json
```

Provider Auth 由 `Models` 负责。

------

## `response.ts`

### Responsibility

```text
AssistantMessage
→ Anthropic response
```

支持：

```text
non-stream JSON
atomic SSE
```

### May Know

```text
AssistantMessage
requested stream flag
response-facing model string
```

### Must Not Know

```text
CommandCode events
Provider auth
CredentialStore
raw upstream body
```

------

# 6.5 OpenAI Chat Protocol Module

使用与 Anthropic 相同的模块边界：

```text
openai-chat/
├─ parse.ts
├─ context.ts
├─ options.ts
└─ response.ts
```

但不强求内部实现共享。

------

## Responsibility

```text
OpenAI Chat wire
↔
Pi semantics
```

------

## Invariant

不得：

```text
OpenAI
→ Anthropic intermediate
→ Pi
```

必须：

```text
OpenAI
→ Pi
```

响应同理：

```text
Pi
→ OpenAI
```

------

# 6.6 OpenAI Responses Protocol Module

结构相同：

```text
openai-responses/
├─ parse.ts
├─ context.ts
├─ options.ts
└─ response.ts
```

初期只支持能够自然表达为 Pi Context 的 stateless/full-context path。

涉及：

```text
previous_response_id
provider-specific continuation
```

等 stateful semantics 时，必须单独评估。

不得提前把这些状态加入全局 Request Context。

------

# 7. Pi Execution Layer

## 7.1 Atomic Executor Module

推荐：

```text
src/pi/execute-atomic.ts
```

------

### Responsibility

```text
Models
+
Model
+
Context
+
Options
→
AssistantMessage
```

------

### Public Contract

```ts
executeAtomic(
  models,
  model,
  context,
  options,
): Promise<AssistantMessage>
```

------

### Owns

```text
Pi event stream consumption
terminal state handling
atomic success/failure
```

------

### Must Not Know

```text
Anthropic
OpenAI
CommandCode
HTTP response
Router Auth
models.json
CredentialStore
```

------

## 7.2 Execution Flow

```text
models.streamSimple(
  model,
  context,
  options
)
↓
consume every event
↓
done
↓
AssistantMessage
```

不得只依赖：

```text
completeSimple()
```

作为 Atomic Router 的唯一消费路径。

原因是 Router 需要主动 drain intermediate events，确保长输出不会因为无人迭代而在内部积压。

------

## 7.3 Terminal States

### `done`

唯一正常成功终态。

```text
done
→ return AssistantMessage
```

------

### `error`

```text
error
→ execution failure
```

不得提交 partial result。

------

### EOF before terminal

```text
EOF
without done/error
→ execution protocol failure
```

不得 salvage。

------

## 7.4 Atomic Commit Invariant

在合法 `done` 前：

```text
zero downstream semantic commit
```

因此 partial：

```text
text
thinking
tool call
```

全部只是未提交中间状态。

------

## 7.5 Provider Resolution

Executor 不做：

```text
resolve Provider
resolve API key
resolve OAuth
resolve endpoint
```

只调用：

```ts
models.streamSimple(...)
```

Pi `Models` 负责找到：

```text
model.provider
→ owning Provider
```

并处理 Provider Auth。

------

## 7.6 Information Lifetime

```text
Model + Context + Options
↓
Pi EventStream
↓
AssistantMessage
```

terminal 后：

```text
Context
Options
Pi intermediate events
```

全部结束生命周期。

------

# 8. Provider Layer

## 8.1 Pi Provider Contract

所有 Provider 都通过 Pi：

```ts
Provider
```

参与系统。

Router 不建立：

```text
ProviderEngine
ProviderExecutor
ProviderRegistry
```

------

## 8.2 Provider Responsibility

Provider 回答：

```text
我拥有哪些 models？
如何认证？
如何把 Pi request 调到 upstream？
如何返回 Pi events？
```

------

## 8.3 Provider Must Not Know

```text
Anthropic Client
OpenAI Client
Router token
HTTP response format
UI
```

------

# 8.4 Provider Authentication Module

Provider Auth owner：

```text
Pi Models
+
Provider.auth
+
CredentialStore
```

------

## Responsibility

```text
Provider credential
→ request auth
```

------

## Public Pi Operations

直接使用：

```ts
models.checkAuth(providerId)

models.getAuth(providerId)
models.getAuth(model)

models.getAvailable()

models.login(...)
models.logout(...)
```

------

## Must Not Create

```text
ProviderAuthManager
OAuthManager
CredentialManager
```

除非未来出现真实 Router-specific policy。

------

# 8.5 Credential Lifecycle

```text
CredentialStore
↓
stored Credential
↓
Models
↓
Provider auth resolution
↓
ModelAuth
↓
upstream request
```

Resolved：

```text
API key
OAuth access token
auth headers
```

只存在当前 Provider request lifetime。

请求完成后死亡。

长期持久化的是：

```text
Credential
```

而不是 request auth result。

------

# 8.6 Login Capability Module

Core 支持登录能力，但不实现 Pi Agent `/login` TUI。

------

## Core Capability

```ts
models.login(
  providerId,
  authType,
  interaction,
)
```

------

## Supported Flows

由 Provider auth contract 决定，可支持：

```text
API key
OAuth browser flow
device code
manual code
select prompts
progress notifications
logout
OAuth refresh
```

------

## AuthInteraction

直接使用 Pi：

```ts
interface AuthInteraction {
  signal?: AbortSignal

  prompt(prompt: AuthPrompt): Promise<string>

  notify(event: AuthEvent): void
}
```

------

## Presentation Isolation

未来：

```text
CLI
Desktop
Admin HTTP API
```

分别实现：

```text
AuthInteraction
```

Core Login Flow 不知道 UI 类型。

------

## `/login` Slash Command

不属于 Core。

```text
/login
= presentation
```

真正的核心能力是：

```text
Models.login()
```

------

## Login Information Lifetime

```text
provider id
auth type
↓
Models.login()
↓
AuthPrompt / AuthEvent
↓
presentation
↓
user response
↓
Credential
↓
CredentialStore
```

登录完成后：

```text
prompt
auth URL
device code
manual auth code
```

全部死亡。

只有：

```text
Credential
```

持久化。

------

# 8.7 Built-in Providers Module

Pi built-in Providers 直接来自：

```text
pi-ai
```

例如：

```text
Anthropic
OpenAI
OpenRouter
Google
DeepSeek
...
```

Router 不维护这些 Provider implementation。

------

# 8.8 CommandCode Provider Module

推荐：

```text
providers/commandcode/
├─ request.ts
├─ sse.ts
└─ stream-simple.ts
```

------

## Responsibility

唯一职责：

```text
Pi semantics
↔
CommandCode wire
```

------

## Input Contract

```text
Model
Context
Options
```

------

## Output Contract

```ts
AssistantMessageEventStream
```

------

## Must Not Know

```text
Anthropic client request
OpenAI client request
Router Auth object
HttpRequest
HttpResponse
Protocol Renderer
```

------

# 8.9 CommandCode Request Encoder

```
request.ts
```

### Responsibility

```text
Model + Context + Options
→ CommandCode /alpha/generate request
```

### Owns

```text
CommandCode request schema
message mapping
tool serialization
thinking/reasoning request mapping
model request fields
```

### Must Not Own

```text
network lifecycle
SSE parser state
Anthropic response format
```

------

# 8.10 CommandCode Transport

属于 `stream-simple.ts` orchestration。

### Responsibility

```text
CommandCode request
→ fetch
→ response stream
```

### Owns

```text
upstream HTTP transport
AbortSignal
upstream network failures
```

### Must Not Know

```text
Client HTTP connection
Client protocol semantics
```

------

# 8.11 CommandCode SSE Module

```
sse.ts
```

### Responsibility

```text
CommandCode SSE bytes/events
→ Pi AssistantMessage events
```

------

### Owns

```text
SSE framing
CommandCode event ordering
text state
thinking state
tool state
terminal state
EOF validation
```

------

## FSM Invariants

必须严格保证：

```text
start before delta
no illegal interleaving
end matches start
one terminal state
no semantic event after terminal
EOF only valid after terminal
```

------

# 8.12 Tool Call State

必须保证：

```text
partial tool call
≠
complete Pi ToolCall
```

只有以下全部成立：

```text
tool start received
valid tool id
valid tool name
arguments complete
JSON complete
tool end received
state valid
```

才能形成最终 Pi ToolCall。

------

## Abort During Tool Call

如果请求 Abort 时工具调用未完成：

```text
discard partial tool state
```

不得：

```text
emit partial ToolCall
persist partial arguments
reuse state in next request
```

------

# 8.13 CommandCode `streamSimple`

### Responsibility

仅组合：

```text
request encoder
+
transport
+
SSE decoder
+
Pi EventStream
```

------

### Must Not Grow Into

```text
Provider Manager
Router
Protocol Adapter
Execution Engine
```

------

# 8.14 Direct Path Module

Direct 是与 Pi semantic path 正交的 execution choice。

```text
Provider
= 调谁

Pi / Direct
= 怎么调
```

------

## Direct Purpose

只允许：

```text
same-protocol forwarding
```

例如：

```text
Anthropic Client
→ Anthropic-compatible Provider
```

------

## Direct May Do

```text
resolve Provider URL
resolve Provider auth
set headers
model selection
transport adaptation
AbortSignal
buffer complete response
error mapping
```

------

## Direct Must Not Do

```text
Anthropic → OpenAI semantics
OpenAI → Anthropic semantics

tool_use → tool_call semantic conversion
thinking → reasoning semantic conversion
```

跨协议必须走 Pi。

------

## Direct Information Isolation

Direct path 不生成：

```text
Pi Context
```

Pi path 不使用：

```text
Direct raw request
```

两条路径只共享必要边界信息：

```text
Protocol Request
resolved Model
AbortSignal
Protocol Response
```

是否最终保留 `resolved Model` 作为 Direct capability check 依赖，可在具体实现时按真实 Provider contract决定，但不能发展成 Routing Engine。

------

# 9. Cross-Cutting Invariants

## 9.1 Information Ownership Matrix

| Information                  | Owner                | Allowed Next Contract | Death Point          |
| ---------------------------- | -------------------- | --------------------- | -------------------- |
| method/path                  | HTTP                 | endpoint selection    | endpoint selected    |
| raw body                     | HTTP / Parser        | Protocol Request      | parsed               |
| Client token                 | Router Auth          | RequestOverrides      | authorized           |
| Project credential           | Router Auth          | RequestOverrides      | authorized           |
| Model selector               | Model Resolver       | Pi Model              | resolved             |
| provider/model substrings    | Model Resolver       | none                  | resolved             |
| `models.json` representation | Startup              | Providers             | composition complete |
| Provider config              | Startup              | Pi Provider           | composition complete |
| AuthPrompt                   | Provider Auth        | Presentation          | answered             |
| AuthEvent                    | Provider Auth        | Presentation          | displayed            |
| OAuth auth code              | Provider Auth        | Credential            | credential created   |
| Credential                   | CredentialStore      | Models                | logout/replace       |
| Resolved API key/token       | Models/Provider      | upstream              | request complete     |
| Pi Model                     | Request              | Pi execution          | request complete     |
| Client semantic messages     | Protocol             | Context               | Context built        |
| Context                      | Pi                   | Provider execution    | terminal             |
| Request controls             | Protocol             | Options               | Options built        |
| Options                      | Pi                   | Provider execution    | terminal             |
| AbortSignal                  | HTTP                 | whole request         | request complete     |
| CommandCode request          | CommandCode Provider | upstream              | sent                 |
| Raw CC SSE                   | CC SSE parser        | Pi events             | parsed               |
| Pi events                    | Atomic Executor      | AssistantMessage      | terminal             |
| AssistantMessage             | Renderer             | Client response bytes | rendered             |
| Response bytes               | HTTP                 | socket                | written              |
| reqId/timing                 | Observation          | logs/metrics          | request complete     |

------

## 9.2 Context Purity

`Context` 只包含模型可见信息。

禁止：

```text
requestId
timestamp
client token
project slug
HTTP headers
Provider auth
Router debug data
routing metadata
AbortSignal
timeout
```

进入 Context。

------

## 9.3 Input Cache Stability

必须保持：

```text
system stable
message order stable
tool schema stable
provider compatibility wrappers stable
```

不得在稳定 prefix 前插入：

```text
timestamp
random IDs
debug text
project metadata
```

------

## 9.4 Abort Invariant

一个 request 只有一个主 AbortSignal。

```text
HTTP
↓
Options
↓
Pi
↓
Provider
↓
fetch
```

Client abort 后：

```text
upstream cancelled
partial semantic state discarded
partial tool state discarded
no downstream write
abort != upstream failure
```

------

## 9.5 Atomic Commit Invariant

任何下游 semantic response 都只能在完整成功后生成。

```text
Pi terminal success
↓
AssistantMessage
↓
Renderer
↓
HttpResponse
```

在此前：

```text
no semantic commit
```

------

## 9.6 Tool Completeness Invariant

半截工具调用永远不是工具调用。

```text
partial tool state
→ temporary provider-local state
```

只有完整后：

```text
→ Pi ToolCall
```

------

## 9.7 Error Ownership

错误由最接近语义的模块产生。

| Error                       | Owner           |
| --------------------------- | --------------- |
| body too large              | HTTP            |
| invalid Client token        | Router Auth     |
| model not found             | Model Resolver  |
| ambiguous model             | Model Resolver  |
| malformed Anthropic message | Anthropic       |
| invalid OpenAI request      | OpenAI          |
| upstream network failure    | Provider        |
| malformed CommandCode SSE   | CommandCode     |
| Pi EOF before terminal      | Atomic Executor |
| client disconnect           | HTTP lifecycle  |

------

## 9.8 Error Translation

底层模块不得构造客户端协议 HTTP response。

正确：

```text
Provider Error
↓
Execution Error
↓
Protocol Error Mapping
↓
HttpResponse
```

例如：

```text
CommandCodeProtocolError
```

不得直接生成：

```text
Anthropic 502 body
```

------

## 9.9 Observation Isolation

Logging / metrics / timings 是旁路信息。

例如：

```text
reqId
R0
U0
U1
U2
D1
D2
```

不得进入：

```text
Context
Model
CommandCode semantic request
```

除非某字段本身就是 Provider 的真实业务字段。

------

## 9.10 Windows File Lifecycle

可写文件必须位于 Router data directory。

不得默认写：

```text
Program Files
application binary directory
~/.pi/agent
```

CredentialStore / ModelsStore 必须：

```text
close handles correctly
serialize writes
respect process lifetime
avoid concurrent destructive cleanup
```

不得使用：

```text
arbitrary sleep
infinite retry
forced delete
```

掩盖 EBUSY / EPERM 根因。

------

## 9.11 Abstraction Admission Rule

新 abstraction 只有在至少满足一个真实条件时允许建立：

```text
多个真实实现已有稳定重复 Contract

不抽象会造成 correctness divergence

Pi public contract 无法表达真实业务能力

抽象可以明显减少模块知道的信息

抽象可以明显缩短信息生命周期
```

以下理由不足：

```text
以后可能增加 Provider
以后可能增加协议
企业级架构看起来更完整
目录更统一
也许未来用得上
```

------

# 10. Recommended Physical Structure

```text
src/
├─ http/
│  ├─ server.ts
│  └─ types.ts
│
├─ auth/
│  └─ authorize.ts
│
├─ protocols/
│  ├─ anthropic/
│  │  ├─ parse.ts
│  │  ├─ context.ts
│  │  ├─ options.ts
│  │  └─ response.ts
│  │
│  ├─ openai-chat/
│  │  ├─ parse.ts
│  │  ├─ context.ts
│  │  ├─ options.ts
│  │  └─ response.ts
│  │
│  └─ openai-responses/
│     ├─ parse.ts
│     ├─ context.ts
│     ├─ options.ts
│     └─ response.ts
│
├─ pi/
│  ├─ create-models.ts
│  ├─ resolve-model.ts
│  └─ execute-atomic.ts
│
├─ providers/
│  └─ commandcode/
│     ├─ request.ts
│     ├─ sse.ts
│     └─ stream-simple.ts
│
└─ vendor/
   └─ pi-models/
      ├─ model-config.ts
      ├─ provider-composer.ts
      ├─ auth-storage.ts
      ├─ models-store.ts
      ├─ resolve-config-value.ts
      └─ minimal-support-files/
```

目录不是架构本身。

真实边界由前文 Contract 决定。

如果两个职责足够小且天然高内聚，可以存在于同一物理文件。

不得为了目录完整性人为拆文件。

------

# 11. Testing Architecture

测试按模块 Contract 编写，而不是按“大型集成流程”覆盖全部逻辑。

------

## 11.1 Startup Tests

### ModelConfig

验证：

```text
valid models.json
invalid provider
invalid model
model override
custom API string
```

------

### Provider Composer

验证：

```text
built-in provider composition
custom model creation
model overrides
custom CommandCode API
streamSimple registration
auth composition
```

重点确认：

> Router 没有自己构造 Pi Model。

------

### CredentialStore

验证：

```text
read
modify
delete
concurrent modification
OAuth credential persistence
file errors
AbortSignal
```

------

### ModelsStore

验证：

```text
read
write
delete
provider isolation
concurrent access
```

------

### createRouterModels

验证：

```text
built-ins available
models.json applied
CommandCode provider registered
CredentialStore connected
ModelsStore connected
no dependency on ~/.pi/agent
```

------

## 11.2 Model Resolver Tests

覆盖：

```text
provider/model exact
model ID containing /
bare globally unique model
bare ambiguous model
unknown provider
unknown model
empty selector
case policy
```

明确测试：

```text
no fuzzy matching
no auth-based guessing
no catalog-order fallback
```

------

## 11.3 Router Auth Tests

覆盖：

```text
global token
project token
invalid token
missing token
project header generation
no project info leakage
```

------

## 11.4 Protocol Tests

每个协议分别测试：

```text
parse
Context conversion
Options conversion
response rendering
error mapping
```

不得要求真实 Provider。

------

## 11.5 Anthropic Semantic Tests

至少覆盖：

```text
system
user
assistant
tool_use
tool_result
tool ID preservation
image
thinking
redacted thinking
message order
invalid tool pairing
```

------

## 11.6 OpenAI Chat Tests

至少覆盖：

```text
system/developer/user/assistant
tool calls
tool results
images
reasoning-compatible input
finish reason mapping
```

------

## 11.7 Provider Auth / Login Tests

使用 fake Provider auth。

覆盖：

```text
API key login
OAuth login
AuthPrompt
AuthEvent
logout
credential persistence
expired OAuth refresh
concurrent OAuth refresh
missing credential
ambient auth
```

这些测试核心能力：

```text
Models.login()
CredentialStore
Provider auth
```

而不是 `/login` UI。

------

## 11.8 Atomic Executor Tests

Fake Pi Provider：

```text
start
text deltas
done

thinking
done

toolcall stream
done

error

EOF without terminal

abort

very long event stream
```

验证：

```text
all events drained
partial state never returned
only terminal done returns AssistantMessage
```

------

## 11.9 CommandCode Provider Tests

### Request

```text
Model mapping
system
user
assistant
tool history
image
reasoning
options
headers
```

------

### SSE

```text
text
thinking
tool start
tool delta
tool end
finish
terminal error
EOF
invalid order
```

------

### Abort

```text
abort before first event
abort during text
abort during thinking
abort during partial tool call
```

确认：

```text
no state leaks into next request
```

------

## 11.10 End-to-End Core Tests

至少覆盖：

```text
Anthropic non-streaming
Anthropic atomic streaming

OpenAI Chat non-streaming
OpenAI Chat atomic streaming

provider/model resolution

bare model resolution

tool call
tool result follow-up

thinking
image

Provider auth

client abort

Provider error

invalid request

model_not_found

ambiguous_model
```

------

## 11.11 Input Cache Tests

必须验证：

```text
message ordering stable
system stable
tool definitions stable
Router Auth metadata excluded
requestId excluded
timestamps excluded
Provider transport metadata excluded
```

------

# 12. Module Review Template

实现每个模块时，必须能填写：

## Responsibility

这个模块唯一负责什么？

## Owned Information

它拥有哪些信息？

## Input Contract

它真正需要什么？

## Processing

它对这些信息做什么？

## Output Contract

下一个真实 Contract 是什么？

## Must Not Know

它绝对不应该知道什么？

## Information Lifetime

哪些输入信息在本模块结束生命周期？

## Dependencies

它允许依赖哪些模块？

## Errors

它产生什么语义错误？

## Invariants

哪些规则绝对不能破坏？

## Tests

哪些行为由本模块测试闭合？

如果无法清楚填写这些项目，说明模块边界仍然不够健康。

------

# 13. Architecture Simplification Checklist

在新增任何中间层前，应先问：

```text
RouterModel
→ 为什么不能直接使用 Pi Model？

ProviderRegistry
→ 为什么不能直接使用 Models？

ExecutionPlan
→ 为什么不能直接传 Model + Context + Options？

CanonicalResponse
→ 为什么不能直接使用 AssistantMessage？

RequestContext
→ 为什么不能把信息还给各自 owner？

AuthManager
→ 为什么不能直接使用 Pi Models auth？

ProviderExecutor
→ 为什么不能直接 models.streamSimple()？

ProtocolAdapter interface
→ 是否真的已有多个稳定重复实现？
```

如果没有明确答案，则不增加。

------

# 14. Frozen Core Decisions

以下决策作为当前 Core baseline。

### Architecture

1. Router 是 `pi-ai` 的 HTTP / Protocol 外壳。
2. 前半段最终产生 `Model + Context + Options`。
3. 后半段从 `AssistantMessage` 开始。
4. 不创建第二套 Canonical IR。
5. 不建立 Router Core。
6. 不建立 ExecutionPlan。
7. 不建立 Policy Engine。
8. 不建立 Engine Registry。

### Pi

1. `@earendil-works/pi-ai` 是唯一核心 Pi runtime dependency。
2. Pi public types 直接使用。
3. Pi built-in Providers 直接使用。
4. 不依赖完整 `pi-coding-agent`。
5. 只从 Pi Agent 派生必要的 configuration / composition / persistence infrastructure。
6. 派生范围由真实 import closure 决定。
7. 不移植 ModelRuntime。
8. 不移植 ModelRegistry。
9. 不移植 RuntimeCredentials。
10. 不移植 Agent TUI/session/tools/RPC。
11. Pi-derived code 与 Router business code 隔离。
12. Pi-derived code 保留 upstream provenance。

### Models

1. Router 不维护第二套 Model Catalog。
2. Router 不自行构造 Pi Model。
3. `models.json` 使用 Pi-compatible provider/model semantics。
4. Model selector 标准形式为 `provider/model-id`。
5. 只 split 第一个 `/`。
6. Model ID 可以包含 `/`。
7. Bare Model 只允许全局唯一 exact match。
8. API model resolution 不 fuzzy、不猜 provider、不 silent fallback。
9. resolve 完成后只传播 Pi Model。

### Auth

1. Router Auth 与 Provider Auth 分离。
2. Router Auth 只产生最小 request-local overrides。
3. Provider Auth 由 Pi Models + Provider + CredentialStore 管理。
4. Core 支持 `Models.login()` / `logout()` capability。
5. Core 不实现 Pi Agent `/login` TUI。
6. `auth.json` 属于 Router data directory。
7. Router 不读取 `~/.pi/agent/auth.json`。
8. 普通 Protocol Adapter 不读取 Provider credential。

### Context / Options

1. Context 只包含模型可见信息。
2. Options 只包含本次调用控制。
3. Auth transport metadata 不进入 Context。
4. Logging/Timing 不进入 Context。
5. Input cache 稳定性是硬约束。

### Provider

1. Provider-specific 信息只存在 Provider。
2. Client Protocol-specific 信息只存在 Protocol。
3. CommandCode 只实现 `Pi ↔ CommandCode wire`。
4. CommandCode partial tool call 永不成为 Pi ToolCall。
5. Provider Auth 不泄漏给 Protocol Renderer。

### Execution

1. 一个 request 只有一个主 AbortSignal。
2. Pi execution 默认 Atomic。
3. 必须主动消费 Pi event stream。
4. 只有合法 `done` 才 commit。
5. `error`、abort、unexpected EOF 都不 commit partial semantic output。
6. response 已关闭后不得继续写。

### Direct

1. Direct 与 Provider selection 正交。
2. Direct 只用于 same-protocol forwarding。
3. Direct 不做跨协议 semantic conversion。
4. Pi Context 不成为 Direct intermediate representation。

### Information

1. 每类信息只有明确 owner。
2. 信息完成使命后立即结束生命周期。
3. 同一事实不得以多种表示长期并存。
4. 模块只能知道完成职责所需的最小信息。
5. 新 abstraction 必须证明它减少耦合或解决真实重复，而不是只增加结构。

------

# 15. Core Architecture Summary

最终整个 Core 应保持为：

```text
                         STARTUP

 Router-owned data
       │
       ├─ models.json
       ├─ auth.json
       └─ models-store.json
       │
       ▼
 Pi-compatible config / persistence
       │
       ▼
 Pi built-in Providers
       +
 CommandCode Provider
       │
       ▼
     Models


────────────────────────────────────────


                         REQUEST

Client HTTP
    │
    ▼
HTTP Boundary
    │
    ├──── Router Auth
    │          │
    │          ▼
    │   minimal overrides
    │
    ▼
Protocol Parser
    │
    ├──── model selector
    │          ↓
    │   resolveRequestModel
    │          ↓
    │        Model
    │
    ├──── semantic request
    │          ↓
    │       Context
    │
    └──── call controls
               ↓
             Options
               │
        ┌──────┴──────┐
        │             │
      Model        Context
        │             │
        └──────┬──────┘
               │
            Options
               │
               ▼
             pi-ai
               │
               ▼
             Models
               │
        Provider Auth
               │
               ▼
            Provider
               │
               ▼
            Upstream
               │
               ▼
 AssistantMessageEventStream
               │
               ▼
       Atomic Executor
               │
               ▼
      AssistantMessage
               │
               ▼
      Protocol Renderer
               │
               ▼
         HttpResponse
```

核心应始终可以用一句话概括：

> **LuckyToken 把 Client Wire 转换为 Pi 的 `Model + Context + Options`，把 Pi 的 `AssistantMessage` 转换回 Client Wire；其余信息全部被限制在自己所属的模块和生命周期内。**