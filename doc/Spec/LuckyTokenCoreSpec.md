# LuckyToken Core Architecture Specification v5.6

**Status:** FROZEN — Per-Client-Protocol Auth Isolation Added

本文件描述 LuckyToken 的 Core Architecture。

全文使用中文作为主要说明语言，同时保留关键英文概念、类型名、协议名和 runtime terminology，避免因为翻译造成术语歧义。

本架构同时冻结 capability cohesion 原则：一个 capability 的功能、数据语义、
持久文件、内存状态、代码模块与测试应由同一个 boundary 拥有。其他模块只接收
自己消费的窄 facts/operations；不得为了方便把 file schema、mutable store、
classification state 或完整 config object 作为共享 context 到处传播。一个
capability 应能通过修改自己的 module/files/tests 与一个 composition binding 被
替换或删除，而不要求清理 Runtime、Client Protocol、Pi 或 Provider 中的散落知识。

# 1. 目的与核心流程 — Purpose and Core Flow

> **Concept Primer — 先理解这些词**
>
> - **LuckyToken Core**：LuckyToken 的路由核心，不是完整的 Agent、UI、CLI、TUI 或会话产品。它负责接收一次模型请求、完成必要的 protocol conversion 与 runtime execution，再返回结果。
> - **Router**：把入口请求送到正确处理路径的组件。在本 Spec 中，Router 不是“万能中间层”，而是协调 `HTTP Boundary`、`Client Protocol`、authorization、Pi runtime 和 response rendering。
> - **Wire / Wire Representation**：真正通过 HTTP、SSE 或其他 transport 传输的 bytes、JSON、headers 或 events。`Client Wire` 是 client 看到的格式，`Upstream Wire` 是 `Provider` 对 upstream 使用的格式。
> - **Protocol**：定义 wire structure、字段语义、合法状态、event lifecycle 与 invariants 的 contract。Protocol 说明“接口上的数据是什么意思”，不说明整个系统由谁拥有它。
> - **Runtime Contract**：运行时模块之间直接使用的类型和行为 contract。LuckyToken 直接使用 Pi 的 `Model`、`Context`、`ModelsSimpleStreamOptions`、`AssistantMessageEventStream`、`AssistantMessage` 等，而不是再造等价的通用 IR。
> - **Boundary**：两个不同 responsibility 或 representation 相接的位置。Boundary 只需要理解自己两侧紧邻的 contract，并负责在这里完成必要转换。
> - **Provider**：Pi 中代表一个 concrete upstream integration 的 runtime unit。它把 Pi runtime contracts 转成 upstream request/lifecycle，再转换回 Pi stream lifecycle。
> - **Upstream**：LuckyToken 最终调用的外部模型服务或 API，不属于 LuckyToken Core 内部。
>
> 阅读本章时先记住主线：**`Client Protocol` 负责 Client ↔ Pi；`Provider` 负责 Pi ↔ Upstream；`HTTP Boundary` 负责 HTTP transport lifecycle。**

## 1.1 Purpose

LuckyToken Core 是一个本地 HTTP / Protocol Router。

它接收 HTTP request，由 `HTTP Boundary` 完成 route / Client Protocol selection、raw request ownership 与 request lifecycle 建立；随后对应 `Client Protocol` 解析并验证 source protocol，提取 external model selector 与 protocol-owned request information。

External model selector 通过 Pi `Models` 被解析为 `Model<Api>`。在 resolved model 已知以后，Client Protocol boundary 完成 model-aware Pi representability 检查，并把可表达的 conversational semantics 转成 Pi `Context`，把可表达的 invocation controls 投影到 Pi `ModelsSimpleStreamOptions` semantics。

成功的调用直接进入 Pi runtime：

```text
Model<Api>
+
Context
+
ModelsSimpleStreamOptions
        │
        ▼
      Models
        │
        ▼
     Provider
        │
        ▼
     Upstream
```

Provider 将 upstream lifecycle 转成 Pi `AssistantMessageEventStream`。LuckyToken `Execution` 主动消费这个 stream。Pi terminal contract 是 Pi execution outcome 的主要 semantic source；同时，HTTP-owned request `AbortSignal` 在 successful commit 前始终是 independently authoritative cancellation fact。

```text
Execution Outcome
├── success
│   └── supported done.message
│       AND request signal not aborted at commit point
│
└── failure
    ├── aborted
    └── error
```

成功时，`done.message` 作为完整 `AssistantMessage` 进入 Client Protocol renderer。失败时，failure 进入 Client Protocol / HTTP error rendering，而不是伪造一个成功的 `AssistantMessage`。

LuckyToken 不重新实现 LLM runtime，也不建立与 Pi 平行的通用 request/message/response semantic model。

完整核心路径是：

```text
HTTP Request
    │
    ▼
HTTP Boundary
├── route / protocol selection
├── inbound headers / body
└── AbortSignal
    │
    ├───────────────────────────────┐
    │                               │
    ▼                               ▼
Client Protocol                    Auth
├── validated state               ├── authorized?
├── model selector                ├── sessionId
└── renderState                   └── projectDir?
    │
    ▼
resolveModel(models, selector)
    │
    ▼
Model<Api>
    │
    ├───────────────────────┐
    │                       │
validated state            │
    │                       │
    ▼                       │
Client → Pi conversion      │
├── Context                 │
└── protocol controls       │
                            │
protocol controls ──────────┐
sessionId / projectDir? ────┤
AbortSignal ────────────────┤
Router defaults ────────────┘
             │
             ▼
       composeOptions(...)
             │
             ▼
           Options

Models + Model + Context + Options
             │
             ▼
          Execution
             │
             ▼
 Models.streamSimple(...)
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
   AssistantMessage | failure
             │
renderState ─┤
             ▼
 Client Protocol Renderer
             │
             ▼
      HTTP Boundary
             │
             ▼
        Client Wire
```

当某个 Client Protocol 的 response representation 需要 request-side information 时，该 Protocol 可以保留一个最小的 request-local `render state` 直到 success/failure rendering 完成。

这个 `render state`：

```text
belongs to Client Protocol
survives Pi execution
never enters Pi invocation
never becomes a generic LuckyToken request object
```

---

## 1.2 Pi Runtime Contracts

LuckyToken 当前 Core text-generation baseline 直接使用 Pi public runtime contracts：

```text
Model<Api>
Context
ModelsSimpleStreamOptions
AssistantMessageEventStream
AssistantMessage
```

本文为简洁通常把：

```text
ModelsSimpleStreamOptions-compatible invocation controls
```

简称为：

```text
Options
```

但这里的 `Options` 不是 LuckyToken 自己定义的新类型。它表示 LuckyToken 调用：

```text
Models.streamSimple(model, context, options)
```

时交给 Pi `Models` 的 invocation controls。

Pi `Models` 随后仍会根据自身 public runtime contract 处理 Provider auth、effective headers、environment、base URL 等 Provider-facing request preparation。这些属于 Pi runtime ownership，不构成 LuckyToken 的第二套 request model。

关键 contracts 的含义是：

```text
Model<Api>
= resolved model identity + capabilities

Context
= conversational semantic state

ModelsSimpleStreamOptions
= Pi streamSimple invocation controls

AssistantMessageEventStream
= Pi execution lifecycle

AssistantMessage
= Pi assistant-message representation
```

`AssistantMessage` 本身不等于 LuckyToken success，因为 Pi 的 `error` terminal 同样携带一个 error-shaped `AssistantMessage`。

LuckyToken completed success 明确定义为：

```text
supported done.message
+
request AbortSignal not aborted at the success commit point
```

LuckyToken execution failure 的最小 downstream classification 仍然是：

```text
aborted
error
```

Pi `error.reason` 是 execution failure 的主要 classification source；但是 HTTP-owned request `AbortSignal` 不因为进入 Pi execution 就失去 authority。若 signal 在 successful commit 前已经 aborted，则 request outcome 必须是 `aborted`，即使 Pi 的 lazy setup/auth path 晚到一个 `error(reason=error)` 或其他 terminal。

更细的 Pi-internal setup/runtime classifications，例如：

```text
auth
oauth
provider
stream
model_source
model_validation
```

不是当前 Core execution contract 的一部分，也不会通过分析 `errorMessage` 字符串重新推断。

> **Raw exception text is diagnostic information, not an architectural classification mechanism.**

正常信息路径保持：

```text
Client Protocol
        ↓
Pi Runtime Contracts
        ↓
Provider
```

而不是：

```text
Client Protocol
        ↓
LuckyToken General IR
        ↓
Pi
        ↓
Provider
```

---

## 1.3 Client Protocol、Pi 与 Provider 是不同 Boundary

LuckyToken 连接三个方向不同的 contract boundary：

```text
Client
  │
  ▼
Client Protocol
  │
  ▼
Pi Runtime
  │
  ▼
Provider
  │
  ▼
Upstream
```

`Client Protocol` owns：

```text
Client Wire
↔
Pi-compatible semantics
```

`Provider` owns：

```text
Pi Runtime Contracts
↔
Upstream Protocol / Transport
```

`HTTP Boundary` owns：

```text
HTTP transport
request connection lifecycle
final response write
```

因此：

- Client Protocol 不理解 concrete Provider wire。
- Provider 不承担 Client Protocol parsing、source validity 或 Client ↔ Pi conversion。
- HTTP Boundary 不判断 Client conversational semantics，也不解释 Provider protocol。

Client Protocol 与 Provider 通过 Pi contracts 相邻，而不是互相直接转换。

---

## 1.4 Core Scope

LuckyToken Core 包含完成 Router request 所必需的：

```text
HTTP request / response boundary
route / Client Protocol selection
request lifecycle and cancellation
Client authorization
Client Protocol parsing / validation / conversion
model resolution
Pi runtime composition
Pi execution
Provider integration
Client success / failure rendering
```

Provider authentication、credential handling、Provider dispatch 和 Pi runtime-level model management 优先使用 Pi public runtime capabilities，而不是由 LuckyToken 建立平行 infrastructure。

---

## 1.5 Out of Scope

当前 Core Architecture 不包含产品展示层或完整 Agent product architecture，例如：

```text
Desktop / Manager / CLI / TUI presentation
Agent session runtime
Agent tool execution runtime
conversation persistence
Pi Agent extension / RPC / package-management subsystems
live downstream token forwarding
```

当前 Core v1 的 downstream semantic boundary 是 atomic：

```text
Pi stream
→ Pi done
→ completed AssistantMessage
→ Client rendering
```

即使某个 Client Protocol 使用 streaming-shaped response format，也不代表 LuckyToken 当前支持 live token forwarding。当前 contract 只允许在 Pi `done` 后，根据完整 `AssistantMessage` 渲染 protocol-compatible response representation。

如果未来产品 requirement 需要 live downstream streaming，则必须显式修改 Execution / rendering contract，而不能把现有 atomic architecture 静默解释成 streaming architecture。

Pi / Pi Agent 中存在某个 subsystem，不构成 LuckyToken Core 必须采用它的理由。

---

## 1.6 Specification Boundary

本文件是 **Architecture Spec**。

它定义：

```text
information ownership
architecture boundaries
dependencies
information flow
representation lifecycle
failure ownership
cross-boundary invariants
```

它不定义：

```text
Client wire schemas
Provider wire schemas
exact protocol fields
exact conversion mappings
exact stream event schemas
feature support matrices
```

这些内容分别属于：

```text
Protocol Specs
Conversion Specs
```

三种 spec 的关系是职责正交，而不是上下级替代：

```text
Protocol Spec
= what one representation means

Conversion Spec
= how adjacent representations map

Architecture Spec
= who owns each representation and where conversion occurs
```

Architecture 可以依赖 Protocol / Conversion 提供的事实，但不复制其详细 wire schema 或 mapping rules。

# 2. 架构原则 — Architectural Principles

> **Concept Primer — 本章使用的架构词汇**
>
> - **Architecture Principle**：用于约束设计选择的长期规则，例如减少重复 representation、缩短 information lifecycle。它不是某个 concrete protocol 的字段规则。
> - **Ownership**：谁对一个 fact 的正确性、lifecycle 和修改负责。暂时拿到一个值不等于拥有它。
> - **Contract**：两个 boundary/module 之间明确约定的 input、output、semantics 与 failure behavior。好的 contract 应小且稳定。
> - **Representation**：同一个事实在某个 lifecycle stage 的具体表达，例如 external model selector、validated protocol object、Pi `Model<Api>`。
> - **Authoritative**：在当前 stage 被视为事实来源的 representation。若两个 representation 临时共存，必须知道哪个决定后续行为。
> - **Lifecycle**：information 从创建、使用、转换到不再需要的全过程。
> - **Abstraction**：把多个具体情况抽成共享 concept/interface。只有真实共享 semantics、ownership 或 correctness requirement 已经出现时才值得引入。
> - **Semantic State vs Infrastructure State**：前者表达 model conversation semantics，后者支撑 runtime，例如 credentials、headers、logging、timing、transport。
>
> 本章回答的是：**什么样的设计允许进入 LuckyToken Core。**

本章定义适用于 Generic Core 的 architecture principles，不依赖任何具体 `Client Protocol` 或 `Provider` integration。

Concrete integration 可以提供证据证明某条 generic rule 有必要，但它自己的：

```text
protocol fields
Provider identity
wire events
headers
runtime facts
session concepts
tool lifecycle
```

不会因为当前存在，就自动成为 Generic Core concepts。

新增、替换或删除一个 concrete Client Protocol / Provider，正常情况下只应影响它自己的 owning boundary 与 runtime composition。

如果一个 concrete integration 的变化迫使无关 generic architecture 改动，优先重新检查 boundary，而不是立即引入更大的 abstraction。

---

## 2.1 最小正确架构 — Minimum Correct Architecture

LuckyToken 优先选择能够正确满足已证明 requirement 的最小 architecture。

当多个设计都正确时，优先：

```text
fewer concepts
shorter information paths
less duplicated state
fewer transformations
clearer ownership
smaller contracts
simpler control flow
easier tests
```

一个 abstraction 只有在解决已经存在的 architecture problem 时才成立，例如：

```text
important information has no natural owner

multiple real implementations already share
identical semantics + lifecycle

without a shared contract,
correctness would diverge

an existing Pi contract cannot express
a demonstrated requirement

the abstraction materially reduces
information exposure or lifetime
```

以下理由本身不足以建立 abstraction：

```text
a future Provider may need it

a future Protocol may need it

the directory structure looks more uniform

the architecture looks more complete

a generic framework may be useful later
```

Future possibility 不是 architecture evidence。

---

## 2.2 Ownership、Contracts 与 Information Lifetime

每个重要 fact 都必须有明确 owner。

对于一个 fact，architecture 应能回答：

```text
Who creates it?

Who owns it now?

Who needs it next?

What representation is authoritative now?

Where does that representation change?

When does the older representation stop being needed?
```

Module 只应接收其 responsibility 真正需要的信息。

共享同一个 HTTP request lifetime，不代表这些 information 必须共享一个 ownership model。

Correctness failure 应由拥有被违反 contract 的 boundary 检测。

后续 boundary 可以 translate/render failure，但不应该重新承担自己无法理解的 contract validation。

Failure information 也遵守 ownership/lifecycle 原则：

```text
detecting boundary
        │
        ▼
preserve the minimum classification
required by downstream rendering
        │
        ▼
Client Protocol / HTTP renderer
```

这不意味着所有 failure 必须进入统一 enum 或 `LuckyTokenError`。

特别是：

```text
before Pi execution
→ failure semantics remain owned by detecting boundary

after Pi execution begins
(defined operationally as invoking Models.streamSimple(...)
and adopting its returned stream as the outcome channel)
→ Pi stream contract exposes only aborted | error
```

Raw exception text 可以用于 diagnostics，但不是 architecture classification。

当 information 已经被 resolve/convert 成下一 stage 需要的 representation 后，较早的 parsing、lookup、transport representation 通常应停止传播。

概念上：

```text
representation A
        │
        ▼
boundary conversion
        │
        ▼
representation B
```

成功转换后：

```text
B
= authoritative for the new lifecycle stage

A
= no longer understood by later unrelated modules
```

同一 fact 的两个 representation 可以在 conversion 期间短暂共存，但 architecture 必须明确：

```text
which representation is authoritative
why both exist
when the older one disappears
```

Generic context object 不能代替 unresolved ownership。

---

## 2.3 保留自然信息层级 — Preserve Natural Information Hierarchy

Architecture 应跟随 information 与 lifecycle 的真实结构，而不是为了统一接口把天然 hierarchy 压平。

例如：

```text
Request
└── Messages
    └── Content
```

以及：

```text
Stream
├── Start
├── Content
│   ├── Text
│   ├── Thinking / Reasoning
│   └── Tool
└── Terminal
```

如果 adjacent contract 中包含结构关系，architecture 应保留：

```text
identity
parent / child relationships
ordering
lifecycle boundaries
authoritative completion
```

Concrete wire protocol 的 exact hierarchy / lifecycle 属于对应 `Protocol Spec`。

Architecture Spec 只定义哪个 boundary owns 这些 hierarchy，以及在哪里发生 conversion。

---

## 2.4 Boundary Isolation

LuckyToken 有两个 fundamentally different conversion direction：

```text
Client Protocol
      │
      ▼
      Pi
```

以及：

```text
      Pi
      │
      ▼
   Provider
      │
      ▼
   Upstream
```

它们必须保持隔离。

`Client Protocol` boundary 可以理解：

```text
its own wire semantics
its own validity rules
Pi representability
Pi response rendering
```

但不理解 concrete upstream Provider wire protocol。

`Provider` 可以理解：

```text
Pi runtime contracts
its own upstream protocol
its own transport
its own request-local lifecycle
```

但不理解 unrelated Client Protocol semantics。

一个 Client Protocol 也不能被用作另一个 Client Protocol 的 intermediate representation。

同样，一个 concrete Provider 的特殊 requirement 不能在没有多个真实 integration evidence 的情况下升级为 generic Provider requirement。

Generic Core rule 应描述 boundary responsibility，而不是某一个 integration 的 vocabulary。

---

## 2.5 Conversational State 与 Infrastructure State 分离

Pi conversational state 与 Router / execution infrastructure 有不同 ownership。

概念上：

```text
Pi conversational state
├── model-relevant semantics
├── conversational relationships
└── Pi-required continuity / structural state
```

不同于：

```text
Router / execution infrastructure
├── credentials
├── authorization state
├── HTTP headers
├── AbortSignal
├── request IDs
├── logging / tracing
├── timing
├── transport state
└── deployment configuration
```

Observability 属于 infrastructure。

Logging、metrics、tracing 可以观察 runtime behavior，但不能改变：

```text
conversational semantics
authentication
lifecycle ordering
Provider behavior
terminal outcome
```

Infrastructure 不能因为“方便传值”被塞进 conversational state。

Conversational semantics 也不能隐藏到：

```text
logging metadata
transport configuration
authentication state
Provider configuration
```

Pi message object 中可能存在 Pi-required structural fields，即使它们本身不是 model-visible semantics。

当 LuckyToken 必须合成这类 structural state 时，representation 应满足：

```text
stable
minimal
semantically inert
```

并且应通过 relevant Pi Provider path 验证，而不是假设其 harmless。

---

## 2.6 保护 Stable Model Input

当 semantic request 没有变化时，LuckyToken 应避免向 model-visible 或 continuity-sensitive input 引入无关 instability。

避免无必要加入：

```text
current timestamps
random identifiers
request identifiers
debug text
transport metadata
observability metadata
unstable tool definitions
unrelated runtime state
```

Dynamic information 并非永远禁止。如果它确实属于 requested semantics，就应该保留。

真正的原则是：

> **Infrastructure variability must not accidentally become semantic variability.**

Protocol conversion 与 Provider integration 在 adjacent contracts 允许时，应尽量保护 stable semantic prefix。

---

## 2.7 优先复用 Pi Runtime — Reuse Pi Before Adding Infrastructure

Pi 是 LuckyToken 的 model runtime。

在为以下能力增加 LuckyToken-owned infrastructure 之前：

```text
models
Providers
Provider dispatch
authentication
credentials
model catalogs
streaming
Provider construction
```

必须先确认 Pi public contracts 是否已经提供需要的 capability。

优先顺序：

```text
demonstrated requirement
        │
        ▼
Pi public contract
        │
        ├── sufficient
        │      ↓
        │    use Pi
        │
        └── insufficient
               ↓
        smallest missing capability
```

当 Pi public API 不提供一个已证明的 implementation capability 时，可以检查 Pi Agent。

Pi Agent 是：

```text
reference implementation
+
selective extraction source
```

而不是 LuckyToken 必须继承的 runtime architecture。

目标是：

> **minimum total complexity, not maximum reuse.**

Concrete extraction procedure、source-file selection、provenance maintenance 属于 engineering concern，不属于 Core architecture structure。

---

## 2.8 Configuration 只表达 Genuine Policy

Configuration 应表达 deployment/product 之间真正允许变化的行为，例如：

```text
network endpoints
timeouts
credentials
Provider configuration
runtime defaults
```

Correctness property 不是 configuration。

Architecture 不能通过 switch 让以下行为变成可选：

```text
invalid protocol state becomes valid

ambiguous identity resolution is guessed

required semantic information is silently discarded

incomplete lifecycle is treated as success
```

一个 rule 是否 configurable，取决于其 semantics，而不是 implementation 是否容易加一个 setting。

---

## 2.9 Architecture Stability Test

Generic LuckyToken concept 应能够承受一个 unrelated Client Protocol / Provider 的新增或删除，而不吸收那个 integration 的 vocabulary 或 lifecycle。

对每个 proposed generic concept，都问：

```text
What information does it own?

Which boundary needs it?

How long does it live?

Is the information already represented by an existing contract?

Would this concept still make sense
if the concrete integration that motivated it disappeared?
```

如果最后一个问题答案是否定的，这个 concept 大概率属于 concrete integration，而不是 Generic Core。

因此 Core 应主要通过以下内容解释：

```text
clear ownership
small adjacent contracts
short representation lifetimes
Pi runtime reuse
isolated Protocol and Provider boundaries
```

而不是不断增长的：

```text
managers
registries
contexts
wrappers
intermediate representations
```

## 2.10 Module and Operation Runtime Closure — 模块与操作运行依赖闭包

Ownership closure 与 dependency closure 是两个不同问题。

一个 module 可以公开很小的 operation：

```text
headers → AuthResult
```

但 module 本身仍可能依赖：

```text
authorization policy
credential/project lookup capability
session-resolution capability
```

反过来，一个 runtime object 也可能公开多个不同 operations，而这些 operations 不应被压成一个假的统一 invocation contract。

因此 v5.5 正式区分：

```text
Module Contract
└── module-level dependency / state / operation surface

Operation Contract
└── one invocation's input / result / effect / temporary state
```

### Module Contract

LuckyToken-owned module 的 architecture contract：

```text
Module
├── Responsibility
├── Bound Dependencies
├── Owned State
├── Operations
└── Must Not Access
```

#### Bound Dependency

module 完成 responsibility 所直接需要、但 authoritative lifecycle 不由该 module owns 的 runtime capability / stable dependency。

例如：

```text
Auth
├── authorization policy/configuration
└── credential/project lookup capability

CommandCode Provider
├── Project Snapshot capability
└── Trace Context generation capability
```

`Bound Dependency` 是 architecture relationship，不规定 implementation 必须使用：

```text
constructor injection
factory closure
explicit first function argument
another direct binding mechanism
```

Architecture 只冻结：

```text
dependency exists
+
dependency source is explicit
```

#### Owned State

module 对其 authoritative lifecycle 或 mutation 负责的 state。

必须按 lifetime 区分：

```text
Owned State
├── Runtime / Long-Lived
└── Request-Local, if the module actually retains request-local state
```

核心判定：

> **A bound dependency may be retained by a module, but retaining its reference or value does not make it module-owned state. Owned State means state whose authoritative lifecycle or mutation is owned by that module.**

因此：

```text
stable injected config
→ Bound Dependency

module stores that config reference
→ still Bound Dependency

module-created mutable provider catalog/cache
→ Owned State
```

`Bound Dependency` 与 `Owned State` 不能因为“对象被保存在 field 中”而重复分类。

#### Operations

module 可以公开一个或多个 operation。

每个 operation 单独声明自己的 invocation contract。

### Operation Contract

```text
Operation
├── Responsibility
├── Bound Dependencies, if this is a standalone operation
├── Inputs
├── Result
├── Effects
├── Temporary State
└── Must Not Access
```

对于属于某个 module 的 operation：

```text
module Bound Dependencies
+
module Owned State
+
operation Inputs
```

共同形成该 operation 的 runtime closure。

`Result` 只描述产生给调用者继续使用的 value / semantic outcome。

`Effects` 描述：

```text
write HTTP response
mutate owned runtime state
register provider
persist credential
start upstream I/O
```

等 side effect。

不要把 effect 假装成 output value。

### Closure Invariant

对于 LuckyToken-owned code：

> **Every runtime requirement must be accounted for by a declared bound dependency, operation input, or explicitly owned state. There is no fourth undeclared source.**

对于 standalone operation，例如：

```text
resolveModel
composeOptions
execute
```

不需要为了套模板创建 runtime class。

### External Runtime Contracts

这个 normative closure rule 约束 LuckyToken-owned architecture。

Pi `Models` 等 external/reference runtime objects 由其自己的 public contract/source 定义。

LuckyToken Architecture 应：

```text
describe the Pi runtime accurately
+
declare how LuckyToken uses it
```

而不是重新规定 Pi 必须如何 construction/injection。

因此 Pi `Models` 使用：

```text
Pi Models Runtime Ownership and Dependency View
```

而不是套用 LuckyToken-owned `Module Contract` 重新定义其 constructor。

## 2.11 Direct Dependencies Only — 直接依赖，而不是依赖包

Dependency closure 是递归的。

一个 module 只声明自己**直接**需要的 runtime dependency，不把 dependency 后面的 transitive implementation graph 全部抬到顶层。

正确：

```text
CommandCode Provider
└── Project Snapshot capability

Project Snapshot implementation
├── filesystem
├── Git
└── clock/date
```

不要求：

```text
CommandCode Provider
├── filesystem
├── Git executable
├── wall clock
├── cwd
├── environment reader
├── random source
└── every other transitive primitive
```

除非 Provider 自己直接理解并使用这些 primitives。

核心 invariant：

> **Dependency closure is recursive. A module declares only its direct runtime dependencies; transitive dependencies remain behind the capability that owns them.**

Dependency abstraction 的粒度应跟 responsibility 一致，不跟底层 API 数量一致。

这条规则防止 dependency closure 反过来制造：

```text
DependencyBag
RuntimeServices
ApplicationContext
ServiceLocator
```

之类 generic container。

---

## 2.12 Fact Flow Contract — 信息边的语义闭包

Module / Operation Runtime Closure 回答：

> 这个 node 凭什么能够运行？

Fact Flow Contract 回答：

> 这条 information edge 为什么存在？

对于重要的跨-boundary fact，architecture 应能回答：

```text
Fact
├── Producer / Owner
├── Carrier
├── Semantic Consumers
├── Transparent Transit
└── Death Point
```

### Producer / Owner

谁建立这个 fact，并负责它在当前 stage 的正确性。

### Carrier

fact 穿越 adjacent contract 时使用的 representation。

例如：

```text
sessionId
→ Options.sessionId

projectDir
→ Options.metadata.projectDir
```

Carrier 是 representation，不是 module。

### Semantic Consumer

真正理解该 field semantics、并根据其 meaning 改变行为的 module。

### Transparent Transit

携带或转发该 carrier、但不理解该 fact 业务语义的 module / operation。

核心 invariant：

> **Transporting a fact does not make a module its semantic owner or semantic consumer.**

例如：

```text
projectDir

Producer
└── Auth

Carrier
└── Options.metadata.projectDir

Semantic Consumer
└── CommandCode Provider

Transparent Transit
├── composeOptions
└── Models

Death Point
└── Provider derives the request-local CommandCode project representation
```

因此不能因为 `Models` 接收整个 `Options` 就推出：

```text
Models understands project semantics
```

同一个 `Options` 对不同 field 可以产生不同 classification：

```text
Options.signal
→ Models is a semantic consumer

Options.metadata.projectDir
→ Models is transparent transit
```

> **Semantic-consumer classification is per fact / per field, not per container object.**

### Death Point

当 fact 已经完成自己的责任，并被转换成下一 stage 的 owning representation 时，应停止继续传播。

Fact Flow Contract 不要求对所有局部变量建立 data dictionary。

它只用于：

```text
cross-boundary facts
facts with non-obvious ownership
facts whose carrier may be mistaken for semantic ownership
facts whose lifetime affects correctness
```

---

## 2.13 No Dependency Escape Hatches

LuckyToken-owned modules 不得通过以下方式绕过 declared dependency closure。

### Global Singleton

真实 runtime dependency 不应隐藏成：

```ts
import { models } from "./global-runtime"
import { config } from "./global-config"
```

唯一合理的例外是 composition root / explicit runtime owner 本身正在建立这些 objects。

### Undeclared Ambient Reads

如果以下值参与 LuckyToken-owned responsibility 的行为决定：

```text
process.env
process.cwd()
wall clock
random identity source
global mutable configuration
```

它们必须位于 owning capability 的 declared dependency closure 内。

但 framework/library 已经明确规定的 implementation default 不会自动变成 LuckyToken architecture abstraction。

例如 Pi contract 允许 Provider adapter 在未注入 custom `fetch` 时使用其 own default transport behavior；LuckyToken 不需要为此包装每一个 library primitive。

判断标准是：

> **Does this ambient value participate in a LuckyToken-owned responsibility or semantic/runtime decision?**

如果是，则它不能是 undeclared ambient dependency。

### Generic Metadata Bag

以下结构不能成为 information smuggling channel：

```text
metadata:any
extras:any
locals:any
context:any
```

Pi `Options.metadata` 可以使用，但只能承载：

```text
explicit field
+
known producer
+
known semantic consumer
+
matching Pi Provider metadata semantics
```

`projectDir` 是这种 narrow field；`metadata` 本身不是 generic LuckyToken context。

### Whole Request Object

不得把 unrelated state 通过：

```text
RequestContext
ExecutionContext
ApplicationContext
```

整体传入深层 module，再由 module 自己寻找：

```text
auth
headers
project
protocol
connection
config
```

一个 module 需要什么，就通过其 adjacent contract 或 bound dependency 得到什么。

# 3. 系统信息流 — System Information Flow

> **Concept Primer — 本章先建立生命周期视角**
>
> - **Long-Lived Runtime**：进程启动后持续存在、被多个 request 复用的 runtime state，例如 LuckyToken `Auth`、`Models`、registered `Provider`、Provider-side credential/store capability。
> - **Request-Local Lifecycle**：只属于一次 HTTP request 的 information 和 mutable state，从 request 进入系统开始，到 response 完成、失败或取消时结束。
> - **HTTP Boundary**：LuckyToken 与 HTTP transport 相接的 boundary。它 owns method/path、raw body/headers、route selection、request `AbortSignal`、connection state 和 final response write。
> - **Sibling Information Sources**：多个 fact 同时属于一个 request，但 ownership 不同。例如 Client Protocol input、Auth input、HTTP lifecycle 是 siblings，不应该因为同属一次 request 就塞进一个 generic request object。
> - **Representation Transition**：information 从一种 authoritative representation 转成下一 owner 需要的 representation。
> - **Death Point**：一个旧 representation 从 architecture 角度不再应该被后续 unrelated boundary 理解或依赖的时刻。它不要求立即物理释放 memory。

LuckyToken Core 有两个主要 information lifetime：

```text
LuckyToken Core
├── Long-Lived Runtime
└── Request-Local Lifecycle
```

Provider execution 不是第三条 peer flow，而是一次 request 内 Pi execution 的一部分：

```text
Request
└── Pi execution
    └── Models
        └── Provider
            └── Upstream
```

本章描述 whole-system information flow。Detailed Client conversion、composition、execution semantics 与 concrete Provider behavior 由对应章节拥有。

---

## 3.1 Composition Root and Long-Lived Runtime

Startup 负责把 deployment configuration 转成 normal request 所需的少量 long-lived runtime objects。

这是一项 **composition root responsibility**。

对于 LuckyToken-owned objects，composition root 建立和绑定 direct dependencies。

对于 Pi `Models`，composition root 遵守 Pi 自己的 construction/registration lifecycle，而不重新定义它。

Current Pi source establishes：

```text
createModels({
  credentials?: CredentialStore,
  modelsStore?: ModelsStore,
  authContext?: AuthContext,
})
        │
        │ omitted values use Pi defaults
        ▼
      Models
        ▲
        │
models.setProvider(provider)
        │
     Provider
```

因此 deployment wiring 更准确地表示为：

```text
Deployment / Router Configuration
                │
                ▼
        Startup Composition Root
                │
        ├── create Client Protocol implementations
        │   └── bind one Auth authority per handler
        ├── create Providers
        │
        ├── optionally provide custom Pi stores/context
        │   ├── CredentialStore?
        │   ├── ModelsStore?
        │   └── AuthContext?
        │
        ├── createModels(optional customizations)
        │        │
        │        ▼
        │      Models
        │        ▲
        │        │ setProvider(...)
        │        └──────── Providers
        │
        ├── bind Router policy/defaults
        └── start HTTP runtime
```

Pi defaults 可以留在 Pi 内部：

```text
credentials omitted
→ InMemoryCredentialStore

modelsStore omitted
→ InMemoryModelsStore

authContext omitted
→ default AuthContext
```

只有 LuckyToken deployment 确实需要：

```text
persistent credentials
persistent model catalog
custom auth environment/context
```

时，composition root 才显式提供 custom implementation。

Provider 也不是 `createModels()` 的 required construction argument。

它通过 Pi `MutableModels.setProvider(...)` registration operation 进入 `Models` 持有的 provider collection。

Composition root 的责任是：

```text
construct LuckyToken-owned runtime objects
configure external Pi runtime through its public contract
bind direct dependencies
register Providers
publish stable runtime objects to request handling
start runtime
```

它不 owns：

```text
Auth policy semantics
Client conversational semantics
Pi Context semantics
Provider wire conversion
projectDir interpretation
request business state
```

因此 composition root 不是：

```text
DependencyManager
ServiceContainer
RuntimeRegistry
ApplicationContext
```

Architecture 只要求 dependency source 可见，不要求 DI framework。

普通 implementation 可以很直接：

```text
auth = createAuth(...)
models = createModels(optionalCustomStores)
providers = createProviders(...)

for provider in providers:
  models.setProvider(provider)

protocols = createProtocols(...)
policy = loadRouterPolicy(...)

handleRequest(
  request,
  auth,
  models,
  protocols,
  policy
)
```

关键 long-lived runtime objects：

```text
LuckyToken Runtime
├── Client Protocol implementations
│   └── handler-bound Auth instances
├── Router policy/defaults
├── HTTP runtime
└── Pi Models
    └── registered Providers
```

Pi `CredentialStore` / `ModelsStore` / `AuthContext` 可能是：

```text
Pi internal defaults
or
deployment-provided custom implementations
```

它们不应被 architecture diagram 错写成 LuckyToken 永远必须单独 construction 的 sibling runtime modules。

这里的两个 auth concern 必须保持分离：

```text
LuckyToken Auth
→ inbound client → LuckyToken authorization
→ normalized request-local sessionId / projectDir?

Pi Models / Provider auth
→ LuckyToken → selected upstream authentication
→ credential resolution / effective Provider request preparation
```

Startup representation 不等于 request representation。

Persistence 只有在产品明确要求跨 process restart 保存 state 时才引入。

## 3.2 HTTP Boundary

### Module Contract

```text
Responsibility
- own HTTP request/response transport lifecycle
- route to the selected Client Protocol
- own request AbortSignal and connection writability

Bound Dependencies
- HTTP framework/runtime capability
- route / protocol selection policy

Owned State
Runtime:
- none required beyond state owned by the bound HTTP runtime

Request-Local:
- request transport state when retained by this boundary
- AbortSignal/controller state
- connection / response-open state

Operations

route/read
  Inputs
  - one HTTP request

  Result
  - selected Client Protocol boundary
  - raw body / headers view for owning boundaries
  - request AbortSignal

  Effects
  - establish request-local transport lifecycle

emit
  Inputs
  - already-decided client/HTTP response representation

  Result
  - none

  Effects
  - mechanically write final status / headers / body when still writable

Must Not Access
- Client conversational semantics
- Provider wire semantics
- Provider credentials
- project semantics
- Pi Context internals
```


`HTTP Boundary` 是 HTTP transport 与 LuckyToken semantic/runtime boundaries 的接口。

它的 responsibility 很小，但必须明确，因为 request cancellation 与 final response delivery 都依赖它。

`HTTP Boundary` owns：

```text
HTTP method / path
raw request headers
raw request body
route selection
Client Protocol selection
HTTP transport validity
request size / transport limits
request AbortSignal
client connection state
response open / closed state
final transport emission of the already-decided HTTP status / headers / body
```

它不 owns：

```text
Client conversational semantics
Client Protocol source validity
model resolution
Pi representability
Provider credentials
Provider wire semantics
upstream lifecycle interpretation
```

`HTTP Boundary` owns **transport emission**，不 owns response semantics 的决定本身。

例如：

```text
Client Protocol / Router-owned failure semantics
        │
        ▼
decided HTTP status / headers / body
        │
        ▼
HTTP Boundary
        │
        ▼
mechanical transport emission
```

因此 `400 / 401 / 429 / 500` 等 status 的语义来源仍由 detecting / rendering boundary 决定；`HTTP Boundary` 负责把已经决定的 transport response 安全写出。

### Route 与 Client Protocol Selection

HTTP route 可以决定哪个 Client Protocol boundary 处理请求：

```text
method + path
        │
        ▼
HTTP routing
        │
        ▼
selected Client Protocol
```

Route selection 只决定“由哪个 boundary 解释 body”，不决定 body 的 conversational meaning。

### AbortSignal Ownership

一次 request 的 `AbortSignal` 由 HTTP lifecycle 创建并拥有。

概念上：

```text
HTTP request begins
        │
        ▼
create request AbortSignal
        │
        ▼
request assembly
        │
        ▼
Options.signal
        │
        ▼
Models → Provider → Upstream
```

关键 invariant：

```text
client disconnect
→ abort request signal
```

同样，如果 HTTP runtime 因 shutdown、timeout 或 transport-level cancellation 终止 request，必须触发同一 request-local cancellation path。

`AbortSignal` 是 lifecycle carrier，不是 conversational semantic state。

### Response Write Ownership

Client Protocol / error renderer 决定 protocol-visible response representation；`HTTP Boundary` 负责把已决定的 response 写回 transport。

概念上：

```text
Client response representation
        │
        ▼
HTTP Boundary
        │
        ▼
status + headers + body
```

HTTP Boundary 必须知道 connection/response 是否仍可写。

关键 invariant：

```text
response closed
→ no later write
```

因此，即使 Provider 或 Execution 在 client disconnect 后晚到一个 terminal，也不能重新打开已关闭 response 或继续写入。

HTTP Boundary 不需要 `HttpManager`、`RequestManager` 或 global connection registry 才能满足这些责任；ordinary request-local framework state 通常足够。

---

## 3.3 Request Dependency DAG

一个 normal request 以多个 sibling sources 开始：

```text
HTTP Request
│
├── Client Protocol input
├── Auth input
└── HTTP lifecycle
```

它们共享 request lifetime，但不共享一个 generic request representation。

Dependency DAG：

```text
                          Models
                            │
selector ───────────────► resolveModel
                            │
                            ▼
                         Model<Api>
                            │
validated Client state ─────┤
                            ▼
                     Client → Pi
                       │          │
                       ▼          ▼
                    Context    controls


Auth(headers)
├── sessionId
└── projectDir?

HTTP Boundary
└── AbortSignal

Router Policy
└── defaults


controls ───────────────┐
sessionId ──────────────┤
projectDir? ────────────┤
AbortSignal ────────────┤
defaults ───────────────┘
          │
          ▼
    composeOptions(...)
          │
          ▼
ModelsSimpleStreamOptions


Models ───────────────┐
Model ────────────────┤
Context ──────────────┤
Options ──────────────┘
          │
          ▼
        execute
          │
          ▼
AssistantMessage | failure


renderState ──────────┐
result / failure ─────┘
          │
          ▼
   protocol.render
          │
          ▼
     HTTP Boundary
```

这个 DAG 的 architecture property 是：

> **本 DAG 展示 request-local information flow 与直接参与 request execution 的 runtime objects；它不重复展开每个 module 的全部 bound dependencies。一个 node 的完整 runtime closure 由本 DAG 与对应 Module / Operation Contract 共同确定。**
>
> 两者结合以后，仍然必须满足：
>
> **不存在从 unrelated environment 临时获取的 undeclared fourth source。**

同时它不表示所有 transit node 都理解经过它的所有 facts。

例如：

```text
Context
```

的 semantic consumer 是 concrete Provider/API conversion。

而：

```text
request orchestration
Execution
Models dispatch
```

只是 Context 的 transparent transit。

---

### Client Protocol path

Client Protocol 先产生：

```text
validated Client state
external model selector
protocol-owned render state
```

Model selector 被 resolve：

```text
external model selector
        │
        ▼
resolveModel(models, selector)
        │
        ▼
Model<Api>
```

当 resolved model 已知后，Client Protocol 完成 model-aware Pi conversion：

```text
validated Client state
+
Model<Api>
        │
        ▼
model-aware representability
        │
        ├── unsupported → failure
        │
        └── representable
               │
               ├── Context
               └── protocol-derived invocation controls
```

`protocol-derived invocation controls` 不是新的 LuckyToken IR。

它只是 Client Protocol 对已经属于 Pi `ModelsSimpleStreamOptions` semantic space 的 fields 做 protocol-owned projection。

---

### Auth / HTTP / Router sibling facts

Auth 建立：

```text
sessionId
projectDir?
```

HTTP Boundary 建立：

```text
AbortSignal
```

Router policy 提供真正属于 invocation policy 的 defaults。

这些 fact 不需要先进入：

```text
RequestContext
CanonicalInvocation
RuntimeContext
```

才能组合。

---

### Options composition

`composeOptions(...)` 是一个 small request-local operation：

```text
protocol controls
+
Auth facts
+
HTTP AbortSignal
+
Router invocation defaults
        │
        ▼
composeOptions(...)
        │
        ▼
ModelsSimpleStreamOptions
```

它只构造 `Options`。

它不重新包装或拥有：

```text
Model
Context
sessionId
projectDir
AbortSignal
```

`Model` 已由 model resolution 建立。

`Context` 已由 Client Protocol conversion 建立。

`sessionId` / `projectDir?` 由 Auth 建立。

`AbortSignal` 由 HTTP Boundary 拥有。

因此不再把：

```text
request assembly
→ Model + Context + Options
```

作为 architectural module relationship。

---

### Execution and rendering

Execution receives:

```text
Models
+
Model
+
Context
+
Options
```

and establishes one atomic outcome.

Protocol-owned `render state` 作为窄旁路跨越 Pi execution：

```text
Client Protocol parse
        │
        ├── Model/Context/Options path ───────────────→ execution
        │
        └── protocol-owned render state ──────────────┐
                                                      │
AssistantMessage or request failure ──────────────────┤
                                                      ▼
                                            Client Renderer
```

这个 state 不进入 `Context` 或 `Options`。

如果 concrete integration 证明还需要一个不属于现有 adjacent contracts 的 request-local fact，必须在 concrete boundary 明确：

```text
producer
carrier
semantic consumer
death point
```

而不是提前建立 generic：

```text
ProviderMetadata
SessionContext
ProjectContext
ProviderExecutionContext
RequestOverrides
```

## 3.4 Representation Boundaries

Information 只有在 next owner 需要另一种 representation 时才转换。

主要 Core transitions：

```text
Client Wire
↓
parsed Client Protocol state

parsed Client Protocol state
↓
validated Client Protocol state

external model selector
↓
Model<Api>

validated Client conversational semantics
+
Model<Api>
↓
Context

supported Client invocation controls
↓
protocol-owned projection
↓
ModelsSimpleStreamOptions fields

HTTP lifecycle controls
+
Router invocation policy
+
protocol projection
↓
Options

Model + Context + Options
↓
Provider-owned upstream representation

upstream wire lifecycle
↓
Pi stream lifecycle

AssistantMessageEventStream
↓
AssistantMessage or execution failure

AssistantMessage / failure
+
protocol render state
↓
Client Protocol response representation

Client Protocol response representation
↓
HTTP Boundary
↓
Client Wire
```

每个 transition 由理解两侧 adjacent contract 的 boundary 拥有。

因此：

- Client Protocol 不构造 Provider wire state。
- Provider 不接收 raw Client Protocol message object。
- HTTP Boundary 不解释 conversational semantics。
- Startup configuration 不变成 request-level semantic representation。

Concrete Provider fields、headers、events、runtime concepts 只存在于 concrete Provider boundary 以下。

Exact field/event mapping 属于 Protocol / Conversion Specs。

---

## 3.5 Information Lifetimes

Representation 应在 next authoritative representation 建立后结束 architectural lifetime。

典型 death points：

| Information | Architectural death point |
| --- | --- |
| Raw HTTP request body | selected Client Protocol 完成 parsing |
| Raw HTTP authorization material | Auth completes |
| Model selector / lookup candidates | `Model<Api>` resolved |
| Client Protocol parser state | validated Client state established |
| Full validated Client conversation representation | successful conversion to `Context` |
| Protocol-owned invocation-control projection | composed `Options` exists |
| Protocol-owned render state | Client success/failure rendering completes |
| Startup composition state | long-lived runtime constructed |
| Provider request representation | upstream transport no longer needs it |
| Raw upstream event | converted to Provider-local or Pi state |
| Provider request-local partial state | completion, failure, or abort |
| `AssistantMessageEventStream` tracking | Execution resolves |
| `Context` / `Options` | Pi invocation terminates |
| `committed successful AssistantMessage` | Client success rendering completes |
| Client response representation | HTTP final write completes or response closes |
| HTTP request-local transport state | response completes / closes |

Death point 不代表必须立即做 memory erase。

它表示：

> **后续 unrelated boundary 不再拥有、依赖或理解旧 representation。**

Conversion 期间允许：

```text
old representation
+
new representation
```

短暂共存，但新的 representation 必须成为 authoritative，旧 representation 随后停止传播。

Whole-system lifecycle 可以简化为：

```text
LONG-LIVED

Composition Root
├── Models
│   └── Providers
├── Client Protocol implementations
│   └── independently bound Auth snapshots
└── Router / HTTP policy


ONE REQUEST

Selected Client Protocol ──► Model / Context / controls
Its bound Auth ─────────────► sessionId / projectDir?
HTTP ─────────────► AbortSignal
Router ───────────► defaults
                         │
                         ▼
                  composeOptions
                         │
                         ▼
                       Options

Models + Model + Context + Options
                         │
                         ▼
                     Execution
                         │
                         ▼
                 Pi / Provider path
                         │
                         ▼
              AssistantMessage | failure
                         │
renderState ─────────────┤
                         ▼
                 Client Protocol Renderer
                         │
                         ▼
                    HTTP Boundary
```

Detailed dependency edges are defined by §3.3; Fact producer/carrier/consumer/death-point relationships are summarized in Chapter 11.

Core 不需要额外 `CanonicalRequest`、`ExecutionPlan` 或 `UniversalContext` 来连接这些 stages。

# 4. Pi 集成 — Pi Integration

> **Concept Primer — 本章说明 LuckyToken 如何复用 Pi runtime**
>
> - **Pi Runtime**：LuckyToken 使用的 model runtime。它已经拥有 model、Provider、auth、credential、stream 等 runtime responsibilities。
> - **Models**：Pi 的 runtime collection，负责 Provider collection、model lookup、auth integration、credential resolution 与 request dispatch。
> - **Provider**：一个 concrete runtime integration，拥有自己的 Provider identity、auth semantics、model catalog behavior 与 upstream stream implementation。
> - **Provider Composition**：把 concrete Provider 注册到一个 `Models` runtime 的过程。
> - **Provider Authentication**：同一个已注册 Provider 的 credential/login/logout lifecycle。它和 Provider registration 是两件事。
> - **CredentialStore**：Pi runtime 保存 Provider credential state 的 contract。
> - **ModelsStore**：Pi `Models` 持有的 model-state store contract。当前 Pi runtime 默认使用 in-memory implementation；只有 persistent/custom implementation 是可选能力。
> - **Pi Public Contract vs Pi Agent**：Pi public API 是首选依赖；Pi Agent 只在 public API 存在已证明 capability gap 时作为 reference/extraction source。

LuckyToken 使用 `@earendil-works/pi-ai` 作为 model runtime。

目标不是把 Pi 包一层，而是直接复用 Pi 已经拥有的 runtime responsibilities。

Normal runtime path：

```text
Model<Api>
+
Context
+
ModelsSimpleStreamOptions
        │
        ▼
      Models
        │
        ▼
     Provider
        │
        ▼
AssistantMessageEventStream
```

本章只定义 Generic LuckyToken ↔ Pi runtime boundary，不定义：

```text
Client Protocol exact field mapping
Client conversion algorithms
Provider-specific compatibility mapping
concrete upstream wire protocol
CommandCode Private runtime facts
```

---

## 4.1 Pi Runtime Dependency

LuckyToken Core 直接依赖 Pi public runtime contracts。

主要 contracts：

```text
Model
Context
ModelsSimpleStreamOptions

Models
Provider

AssistantMessageEventStream
AssistantMessage

CredentialStore
ModelsStore
```

Architecture 依赖这些 contract 的 responsibility，而不是冻结某个 convenience helper 的名字。

Exact factory/helper function 属于 implementation choice，除非其行为后来成为 architecture invariant。

当 Pi 已经拥有对应责任时，LuckyToken 不建立平行的：

```text
RouterModel
ProviderRegistry
ModelRegistry
ProviderManager
ModelManager
ProviderExecutor
```

---

## 4.2 Pi Runtime Ownership

### Pi `Models` Runtime Ownership and Dependency View

Pi `Models` 是 external/runtime dependency owned by Pi，LuckyToken 不重新定义它的 constructor contract。

Current Pi source establishes：

```text
createModels({
  credentials?: CredentialStore,
  modelsStore?: ModelsStore,
  authContext?: AuthContext,
})
```

如果这些 optional customization 缺失，Pi 自己创建：

```text
InMemoryCredentialStore
InMemoryModelsStore
default AuthContext
```

Provider collection 则由 `ModelsImpl` 自己持有，并通过后续 operations 修改：

```text
setProvider(provider)
deleteProvider(id)
clearProviders()
```

因此更准确的 runtime view 是：

```text
Pi Models
│
├── internal/default-or-custom dependencies
│   ├── CredentialStore
│   ├── ModelsStore
│   └── AuthContext
│
├── owned runtime state
│   ├── Provider collection / registration state
│   ├── refresh generations/controllers
│   └── publication coordination
│
└── operations
    ├── provider registration/read
    ├── model lookup
    ├── model refresh
    ├── auth check/resolution
    ├── login/logout
    ├── stream/complete
    └── deferred fetch/cancel
```

这不是 LuckyToken 对 Pi 的新 abstraction；只是准确描述 current Pi public/source contract。

### Important Pi Operations

Provider collection：

```text
setProvider(provider)
deleteProvider(id)
clearProviders()
getProvider(id)
getProviders()
```

Model access：

```text
getModels(...)
getModel(provider, id)
getAvailable(...)
refresh(...)
```

Auth：

```text
checkAuth(...)
getAuth(...)
login(...)
logout(...)
```

Inference：

```text
stream(...)
complete(...)
streamSimple(...)
completeSimple(...)
fetchDeferred(...)
cancelDeferred(...)
```

所以不能把整个 `Models` runtime 错写成单一：

```text
Model + Context + Options → Stream
```

module contract。

### `streamSimple(...)` Operation View

LuckyToken Core 主要依赖：

```text
Models.streamSimple(
  model,
  context,
  options,
)
```

该 operation 的 current source behavior：

```text
Inputs
├── Model<Api>
├── Context
└── ModelsSimpleStreamOptions

Models consumes
├── model.provider
│   └── requireProvider(...)
│
├── model.headers
│   └── participates in getAuth(model)
│
└── request auth overrides/options
    ├── apiKey
    ├── headers
    ├── env
    └── signal

Models request preparation
├── resolve effective auth
├── merge effective apiKey / headers / env
├── apply transformHeaders
├── possibly derive requestModel.baseUrl
└── delegate to owning Provider

Result
└── AssistantMessageEventStream
```

因此：

> **Pi Models is a semantic consumer of selected runtime-relevant `Model<Api>` fields; it is not transparent transit for the whole Model object.**

这不意味着 Models owns all Model capability semantics。

Client model-aware conversion 与 concrete Provider 仍然消费它们各自需要的 model capabilities。

### Store Ownership Distinction

如果 LuckyToken 提供 custom `CredentialStore` / `ModelsStore`：

```text
Models
→ uses/co-ordinates the store contracts
```

但 underlying stored data 的 authoritative lifecycle 属于对应 Store contract。

不要重复表示为：

```text
Models owns copied credential/model-store data
```

Pi `Provider` contract 要求 concrete Provider 声明自己的 auth semantics；但：

```text
credential storage/resolution
effective request auth preparation
```

属于 `Models` runtime responsibility。

Concrete CommandCode Provider 不直接依赖 Pi `CredentialStore`。

### Generic Core Rule

LuckyToken 应保持：

```text
Models
├── Provider collection
├── model lookup
├── Provider authentication integration
├── credential integration
├── model availability / refresh orchestration
└── request dispatch

Provider
├── concrete Provider identity
├── Provider authentication semantics
├── model catalog behavior
├── upstream-specific execution behavior
└── stream implementation
```

而不是插入另一个 runtime layer。

## 4.3 Provider Identity、Composition 与 Authentication

Provider composition 与 authentication 是分开的 lifecycle。

先有 concrete Provider integration：

```text
concrete Provider
        │
        ▼
      Models
```

Authentication state 可以独立变化：

```text
login / logout / credential update
        │
        ▼
   CredentialStore
        │
        ▼
same registered Provider identity
```

Authentication 不创建 Provider integration。

Credential 变化也不等于改变 Provider 的：

```text
protocol implementation
model behavior
stream behavior
runtime identity
```

LuckyToken 把一个 Pi Provider identity 看成一个 concrete runtime integration，而不是单纯 upstream brand name。

更准确地说：

```text
Provider identity
=
one concrete upstream/runtime integration contract
```

而不是：

```text
Provider identity
=
product or company brand
```

因此同一个 upstream product 如果真的存在不同：

```text
protocol
model catalog
auth semantics
request behavior
stream lifecycle
```

可以是不同 Provider identity。

反过来，只有 login mechanism 增加，但 underlying runtime integration 没变，不应仅因此新建 Provider。

Architecture 不为 hypothetical future integrations 提前占 Provider identity。

在同一个 `Models` runtime 中，每个 Provider ID 都必须有清楚且 deliberate 的 integration ownership，避免 unrelated composition path 意外替换同一个 identity。

---

## 4.4 Built-in 与 LuckyToken-Specific Providers

如果 Pi built-in Provider 已满足 upstream integration requirement，应直接复用：

```text
Pi built-in Provider
        │
        ▼
      Models
```

LuckyToken-specific integration 也使用同一个 Pi `Provider` contract：

```text
LuckyToken-specific integration
        │
        ▼
    Pi Provider
        │
        ▼
      Models
```

Custom Provider 不构成建立第二个 LuckyToken-wide Provider framework 的理由。

因此不要先创建：

```text
RouterProvider
ProviderDefinition
ProviderAdapter
ProviderRuntime
ProviderFactoryRegistry
```

再把它们翻译成 Pi Provider。

Generic architecture contract 就是：

```text
Pi Provider
```

Implementation 可以使用 Pi construction helpers，也可以直接实现 Provider contract，取决于哪个更简单。

只有多个真实 integration 证明存在 Pi `Provider` 无法正确表达的共同 capability 时，才考虑 broader LuckyToken abstraction。

Concrete Provider-specific information 保留在 concrete Provider chapter，不进入本 generic Pi Integration chapter。

---

## 4.5 Stores 与 Persistence

Pi runtime authentication 使用：

```text
CredentialStore
```

Pi `Models` 同时持有：

```text
ModelsStore
```

用于 model-state storage contract。当前 Pi runtime 在调用方未提供 custom store 时使用 in-memory `ModelsStore` implementation。

这些都是 Provider-side runtime infrastructure，不是 conversational state，也不等于 LuckyToken inbound `Auth` 的 private storage/policy。

概念上：

```text
CredentialStore
└── Provider credential state
    └── persistent/custom implementation only if credentials must survive restart

ModelsStore
└── Provider/model state
    ├── in-memory implementation by default
    └── persistent/custom implementation only when required
```

如果 process-local model state 已经足够，Pi 的 in-memory `ModelsStore` 就是正确的最小实现。

Persistent/custom implementations 只在产品明确要求对应 state 跨 process restart 保存时引入，例如：

```text
Provider credentials survive process restart
dynamic model catalog survives process restart
```

Architecture 不冻结：

```text
file names
directory layouts
JSON formats
database schemas
```

Protocol modules 也不直接访问这些 stores。

Persistence implementation 必须保持在 normal conversational semantic path 之外。

---

## 4.6 Pi Agent Boundary

Pi public contract 是第一选择。

当一个已证明 LuckyToken capability 无法通过 Pi public API 获得时，才检查 Pi Agent：

```text
demonstrated capability
        │
        ▼
Can Pi public contracts provide it?
        │
        ├── yes
        │      ↓
        │    use Pi
        │
        └── no
               ↓
          inspect Pi Agent
               │
               ▼
          extract smallest
          coherent capability
```

Pi Agent 是：

```text
reference implementation
+
selective extraction source
```

不是 LuckyToken 的 runtime architecture template。

不应因为相关代码“就在附近”而把这些 Agent product concerns 引入 Core：

```text
Agent sessions
TUI
Agent tool execution
compaction
extension runtime
RPC
package management
interactive workflows
```

Detailed extraction workflow、source-file selection、provenance、upgrade strategy 属于 engineering process。

Architecture rule 只有：

> **直接复用 Pi public runtime ownership；只有出现已证明的 capability gap 时，才从 Pi Agent 提取最小 coherent subset。**

# 5. Client Protocol 边界 — Client Protocol Boundary

> **Concept Primer — 本章处理 Client Wire ↔ Pi 的语义边界**
>
> - **Client Protocol**：LuckyToken 对外暴露的一种 client-facing protocol，例如某种 Anthropic/OpenAI-compatible request/response contract。每种 Protocol 独立理解自己的 wire semantics。
> - **Source Validity**：一个 request 是否满足它自己的 source Protocol Spec。Syntax parse 成功不等于 semantic validity 成立。
> - **Pi Representability**：一个 source-valid fact 是否能够在 LuckyToken 选择的 Pi contracts 中正确表达，而不丢失必要 semantics。
> - **Model-Aware Representability**：某些 representability decision 需要知道 resolved `Model<Api>` capability，因此必须在 Model Resolution 后完成。
> - **Context**：Pi 的 conversational semantic state，包括 `systemPrompt`、`messages`、`tools`。
> - **Historical State**：Client 提供的历史 conversation 被转换成 Pi history 时所需的 semantic、continuity 与 structural information。
> - **Protocol-Owned Render State**：同一个 Client Protocol 为了在 execution 结束后正确渲染 response，而从 request side 保留下来的最小 request-local information。它不是 Pi state。
> - **Error Rendering**：把 boundary-owned failure semantics 转成 client-visible protocol/HTTP failure response 的过程。

`Client Protocol Boundary` owns 一个 client-facing protocol 与 Pi adjacent contracts 之间的 conversion。

Inbound：

```text
Client Wire
    │
    ▼
Client Protocol Boundary
    │
    ▼
Pi-compatible request information
```

Outbound：

```text
AssistantMessage or request failure
    │
    ▼
Client Protocol Boundary
    │
    ▼
Client response representation
```

每个 Client Protocol 只理解：

```text
its own protocol semantics
+
Pi contracts adjacent to it
```

不同 Client Protocol 独立转换到 Pi。

Normal path 不使用：

```text
Client Protocol A
        │
        ▼
Client Protocol B
        │
        ▼
       Pi
```

也不使用：

```text
Client Protocol
        │
        ▼
LuckyToken Universal Protocol
        │
        ▼
       Pi
```

Client Protocol Boundary 不理解 concrete upstream Provider wire。

---

## 5.1 Boundary Ownership

### Module Contract

```text
Responsibility
- own one Client wire protocol
- validate source protocol state
- perform model-aware Client ↔ Pi conversion
- render protocol-visible success/failure responses

Bound Dependencies
- protocol-specific stable policy/configuration only when required

Owned State
Runtime:
- protocol-owned mutable runtime state, if any
- bound policy/configuration references remain Bound Dependencies

Request-Local:
- no hidden retained state is required by architecture;
  validated state / renderState remain explicit operation values

Operations

parse
  Inputs
  - Client wire representation

  Result
  - validated Client state
  - external model selector
  - protocol-owned renderState, if required / established

  Effects
  - none required beyond parsing/validation

convertToPi
  Inputs
  - validated Client state
  - resolved Model<Api>

  Result
  - Context
  - protocol-derived Pi invocation-control projection

  Effects
  - none required

render
  Inputs
  - committed successful AssistantMessage or preserved failure
  - protocol-owned renderState, if established / required

  Result
  - Client response representation

  Effects
  - none; HTTP emission belongs to HTTP Boundary

Must Not Access
- concrete Provider implementation
- Provider credentials
- upstream wire
- filesystem/project inspection
- HTTP connection state
```

Client Protocol module 本身就是 conversion implementation；不要把“protocol/conversion implementation”再包装成一个 generic construction dependency。


Inbound processing 分成几个有明确 dependency 的步骤：

```text
Client Wire
    │
    ▼
parse
    │
    ▼
source-protocol validity
    │
    ▼
validated Client Protocol state
    │
    ├── model selector ───────────────→ Model Resolution
    │                                      │
    │                                      ▼
    │                                  Model<Api>
    │                                      │
    └──────────────────────────────────────┘
                     │
                     ▼
          model-aware Pi representability
                     │
                     ▼
            Pi-compatible conversion
```

Client Protocol Boundary 可以产生：

```text
external model selector
Context
protocol-derived invocation controls
protocol-owned render state
```

这些 output 的 ownership 不相同。

### External Model Selector

`model selector` 只是 Client/Router API 的 external representation。

它不是 authoritative Pi model identity。

```text
external selector
        │
        ▼
Model Resolution
        │
        ▼
Model<Api>
```

Model Resolution 由 Chapter 6 定义。

### Context

`Context` 是成功 Client → Pi conversational conversion 的 authoritative result。

当 `Context` 建立后，完整 Client conversation representation 不继续进入 Provider execution。

### Protocol-Derived Invocation Controls

这个名称描述的是 ownership，不定义一个新的 type family。

> **`protocol-derived invocation controls` is not a new generic LuckyToken contract. It is only the Client Protocol-owned projection of fields whose target semantics already belong to Pi `ModelsSimpleStreamOptions`.**

例如，一个 Protocol 可以从 source request 中解释：

```text
max token request
temperature
reasoning level
```

但只有当这些 semantics 能进入 `ModelsSimpleStreamOptions` 时，才形成对应 projection。

概念上：

```text
Client request controls
        │
        ▼
Protocol interpretation
        │
        ▼
projection of ModelsSimpleStreamOptions semantics
```

Implementation 可以临时使用 ordinary object 保存这些 fields，但不应把它演化为：

```text
ProtocolOptions
→ RouterOptions
→ PiOptions
```

这种第二套 generic Options model。

### Protocol-Owned Render State

Protocol-owned `render state` 不是 Pi state。

它是同一个 Client Protocol 为了在 execution 后正确渲染 success/failure 所需要的最小 request-local value。

可能包含：

```text
requested response mode
protocol-visible request identifier
source model selector when the response contract requires echoing it
another protocol-specific response preference
```

但只能保留真正需要的 fact。

它不应变成：

```text
ResponseContext
RequestContext
UniversalRenderState
```

Lifecycle：

```text
Client parsing
        │
        ▼
protocol-owned render state
        │
        ├──────────── survives Pi execution ────────────┐
        │                                               │
AssistantMessage or failure ────────────────────────────┤
                                                        ▼
                                              Client rendering
                                                        │
                                                        ▼
                                                   death point
```

---

## 5.2 Inbound Validity

Syntax parse 成功不足以进入 Pi execution。

在 Client state 被转换成 Pi semantic state 前，Protocol boundary 必须建立 source Protocol Spec 要求的 validity。

概念上：

```text
syntactically parseable
        │
        ▼
source-protocol validation
        │
        ▼
valid Client Protocol state
```

Source validity 可能包含 local structure，也可能包含跨 request sections/messages 的 relationship，例如：

```text
message roles
content variants
ordering
tool-call / tool-result relationships
request-control combinations
cross-message continuity
```

这些 exact rules 属于对应 `Protocol Spec`，Architecture 不复制。

Client Protocol implementation 必须在产生 Pi state 前 enforce source validity。

### Known Malformed vs Unknown Extension

已知 event/field 结构 malformed 与 unknown future extension 是不同条件。

对应 Protocol Spec 决定 unknown extension 是：

```text
accepted
ignored
preserved
rejected
```

Architecture 不为所有 Client Protocol 强制一个统一 forward-compatibility policy。

---

## 5.3 Model-Aware Pi Representability

一个 request 可以在 source protocol 中完全 valid，但仍无法正确表示为 LuckyToken 当前使用的 Pi contracts。

因此：

```text
source-valid
≠
automatically Pi-representable
```

而且 representability 可能依赖 resolved model capability。

所以 dependency order 必须是：

```text
parse + source validation
        │
        ▼
model selector
        │
        ▼
Model Resolution
        │
        ▼
Model<Api>
        │
        ▼
model-aware representability
```

这不会把 Client Protocol meaning 交给 Model Resolution。

Ownership 仍然是：

```text
Model Resolution
→ supplies authoritative Model<Api>

Client Protocol Boundary
→ uses that capability information
  to decide representability
```

Conversion 必须区分：

```text
source-invalid
→ protocol failure

source-valid
+
Pi-representable
→ convert

source-valid
+
not Pi-representable
→ explicit unsupported failure
```

Conversion 必须 loss-aware。

如果一个 semantic field、relationship 或 content type 在 Pi 中没有正确 representation，不能因为“Provider 也许会修”而静默删除。

Model capability 可以参与 representability，例如：

```text
Pi model capability
→ may affect whether source semantics can be preserved
```

但 concrete upstream wire implementation 不参与 Client Protocol meaning：

```text
concrete Provider wire behavior
→ not part of Client Protocol representability
```

Exact feature support 与 mapping 属于对应 `Conversion Spec`。

Architecture 冻结的 rule 是：

> **Unsupported semantics fail explicitly rather than disappearing during conversion.**

---

## 5.4 Pi Historical State

Client conversation history 在 execution 前必须成为 valid Pi history。

Target `Context` hierarchy：

```text
Context
├── systemPrompt?
├── messages[]
└── tools?
```

External history 可能没有 Pi historical message 所要求的完全相同 fields。

因此 historical conversion 必须区分：

```text
conversation semantics

continuity / provenance information

Pi-required structural state
```

这三者不能混为一谈。

会影响 historical message meaning 或 continuity 的 information 必须从 source protocol 一致地 derive，而不能 arbitrarily fabricate。

纯 structural Pi-required value 只有在以下条件满足时才允许 synthesize：

```text
stable
minimal
semantically inert
```

并且应对 supported Pi paths 做验证。

Exact synthetic value/algorithm 不属于 Architecture，而属于 Client Protocol ↔ Pi `Conversion Spec`。

Conversion Spec 负责回答 source protocol 缺少 identical representation 时，如何构造 Pi-required information，例如：

```text
historical assistant provenance
stop state
tool-result identity information
usage where required
timestamps or other structural fields
```

成功转换后：

```text
Context
```

成为 Pi request lifecycle 的 authoritative conversational representation。

完整 Client history representation 不继续传播到 Provider。

---

## 5.5 Outbound and Error Rendering

### Success Rendering

Execution success 后，Client Protocol Boundary 收到：

```text
AssistantMessage
+
protocol-owned render state
```

并生成对应 Client response representation：

```text
AssistantMessage
        │
        ▼
Client response semantics
        │
        ▼
Client response representation
        │
        ▼
HTTP Boundary
        │
        ▼
Client Wire
```

Renderer 可以理解：

```text
Client response schema
Client content representation
Client finish / stop representation
Client usage representation
protocol-owned render state
```

但不消费：

```text
raw upstream events
Provider transport state
Provider credentials
Provider request objects
```

Outbound conversion 同样 loss-aware。

如果 `AssistantMessage` 包含 target Client Protocol 无法表达的信息，exact policy 属于 Conversion Spec。

Architecture 不定义：

```text
Pi content blocks
Pi stop reasons
Pi usage
```

到某一个 concrete Client schema 的 exact mapping。

### Failure Rendering

Request failure 走 parallel path，但 `protocol-owned render state` **不是所有 failure 的前置条件**。

Failure rendering 根据 failure 发生的 lifecycle stage 使用当时已经建立的最小信息：

```text
HTTP failure before Client Protocol selection
        │
        ▼
HTTP Boundary renders transport-level failure directly


Client Protocol selected
but render state not yet established
        │
        ▼
selected Client Protocol error renderer
        │
        └── render state not required


later request / execution failure
        │
        ├── preserved failure classification
        └── protocol-owned render state, if established / required
                │
                ▼
        Client Protocol / HTTP rendering
```

因此：

```text
request failure
+
protocol-owned render state if established / required
→ Client-visible failure response
```

Failure 不需要被伪造成 successful `AssistantMessage`。

Architecture 也不要求所有 failure 先统一成 `GlobalError`。

Failure lifecycle 分成两个阶段理解：

```text
Request
│
├── Before Pi execution
│   ├── Client Protocol failure
│   ├── Auth denial
│   ├── model resolution failure
│   ├── representability failure
│   └── composition failure
│
└── After Pi execution begins
    ├── request AbortSignal observed before success commit
    │      └── aborted
    │
    └── Pi error terminal
           ├── aborted
           └── error
```

这里的 **Pi execution begins** 有 operational definition：

> **For LuckyToken failure ownership, the Pi execution phase begins when LuckyToken invokes `Models.streamSimple(...)` and adopts the returned `AssistantMessageEventStream` as the authoritative outcome channel.**

因此即使 upstream request 尚未发送，只要 failure 是通过该 Pi stream 暴露，例如：

```text
Provider lookup failure
Provider auth resolution failure
lazy Provider / API setup failure
Provider startup failure
```

它们都已经属于 Pi execution phase。通常按 Pi stream contract collapse 为：

```text
aborted | error
```

但 request `AbortSignal` 在 successful commit 前仍然独立决定 cancellation precedence。Pi lazy setup 把一个 abort rejection 暴露成 `error(reason=error)` 时，Execution 仍必须把已观察到的 request cancellation 保留为：

```text
aborted
```

Pre-execution failure 继续由 detecting boundary 拥有它的 semantic classification。

例如：

```text
Client Protocol validation failure
→ Client Protocol-owned semantics

Auth denial
→ Auth-owned semantics

model resolution failure
→ Model Resolution-owned semantics
```

Architecture 不把这些强制压成一个统一 enum。

在 Pi execution 开始后，LuckyToken 只承诺保留 Pi `AssistantMessageEventStream` public terminal contract 直接暴露的 distinction：

```text
error.reason
├── aborted
└── error
```

更细的 Pi-internal setup/runtime category 不属于当前 Core execution contract。

尤其不能通过：

```text
errorMessage string
```

反推：

```text
auth
oauth
provider
stream
...
```

Architecture invariant 是：

> **A failure must retain exactly the classification required by the downstream client error contract until rendering; raw exception text is diagnostic information, not an architectural classification mechanism.**

如果未来某个真实 Client Protocol requirement 要求在 Pi execution 后区分更细的 Provider/runtime category，则必须重新证明 Pi public contract 不足，再设计最小 preservation mechanism。

当前不提前建立 error hierarchy。

### Atomic Downstream Semantics

Core v1 的 downstream semantic boundary 是 atomic。

```text
Pi stream
        │
        ▼
Pi done
        │
        ▼
complete AssistantMessage
        │
        ▼
Client rendering
```

因此：

> **Client streaming response format does not mean live token forwarding.**

当某个 Client Protocol 支持 streaming-shaped response 时，当前 Core 只能在 Pi `done` 后，根据完整 `AssistantMessage` 渲染 protocol-compatible event sequence / response shape。

Live upstream token → live client token forwarding 不属于当前 Execution contract。

---

## 5.6 Specification and Lifetime Boundary

Client Protocol Boundary 同时与三个 spec responsibility 相邻：

```text
Protocol Spec
→ wire + source semantics + validity

Architecture Spec
→ ownership + dependency order + lifetime + failure ownership

Conversion Spec
→ exact Client ↔ Pi mapping + support policy
```

Inbound lifecycle：

```text
raw Client Wire
        │
        ▼
parsed Client representation
        │
        ▼
validated Client state
        │
        ├── selector ───────────→ Model<Api>
        │
        └── + Model<Api>
               │
               ▼
        Pi representability
               │
               ▼
        Context + control projection
```

Typical death points：

| Information | Architectural death point |
| --- | --- |
| Raw request bytes | protocol parsing completes |
| Temporary parser state | parsed representation established |
| Source validation state | validity established |
| Model selector | `Model<Api>` resolved |
| Full Client conversation representation | `Context` established |
| Temporary representability state | conversion decision completes |
| Protocol-derived control projection | composed `Options` exists |
| Protocol-owned render state | success/failure rendering completes |
| Client response conversion state | Client response representation established |

Outbound：

```text
AssistantMessage or failure
        │
        ├── protocol-owned render state
        │
        ▼
Client Protocol Renderer
        │
        ▼
Client response representation
        │
        ▼
HTTP Boundary
        │
        ▼
Client Wire
```

Client Protocol module 在 response rendering 后不需要保留 upstream execution state。

完整 boundary rule：

> **A Client Protocol owns the meaning and validity of its own wire representation, and converts only valid, explicitly representable semantics into Pi contracts. It preserves only the smallest protocol-owned render state required for response rendering, and it never inherits concrete Provider vocabulary or lifecycle.**

# 6. Request Assembly — 请求装配

> **Concept Primer — 本章描述几个 request-local assembly operations，而不是一个新的 runtime module**
>
> - **Request Assembly**：ordinary orchestration control flow；负责按依赖顺序调用 owning boundaries/operations。
> - **Model Resolution**：`external selector + Models → Model<Api>`。
> - **Client → Pi Conversion**：`validated Client state + Model<Api> → Context + protocol-derived Pi controls`。
> - **`composeOptions(...)`**：只把已经建立的 request facts / controls 投影为 Pi `ModelsSimpleStreamOptions`。
> - **Composed Options**：LuckyToken → Pi `Models` 的 invocation input；它不是 Pi `Models` 完成 auth preparation 后交给 concrete Provider 的最终 effective options。
> - **Precedence Rule**：多个 producer 能影响同一 Pi option field 时，必须显式定义优先级，而不能依赖 object-spread 顺序。
> - **Non-Pi Request Fact**：若 concrete integration 真正需要、但现有 Pi invocation contract 无法正确承载的 fact，应作为 concrete integration gap 单独证明，而不是建立 generic bag。

本章不定义一个：

```text
RequestComposition service
```

也不定义一个：

```text
Model + Context + Options wrapper
```

三个 authoritative representations 各自由自己的 owner 建立：

```text
Model<Api>
← Model Resolution

Context
← Client Protocol conversion

Options
← composeOptions(...)
```

Request orchestration 只负责把它们按 dependency DAG 连接起来。

主要 request sources：

```text
Client Protocol
├── external model selector
├── validated Client state
├── protocol-owned invocation-control projection
└── protocol-owned render state

Auth Boundary
├── access decision
├── sessionId
└── projectDir?

HTTP Boundary
└── AbortSignal

Router Runtime Policy
└── applicable invocation defaults
```

这些 sources 不被重新包装成 generic request object。

---

## 6.1 Assembly Is Control Flow, Not a Runtime Module

Request assembly 不建立一个 long-lived `request assembly` service。

它只是 ordinary endpoint / orchestration code 中的几步显式 operation：

```text
selector
→ resolveModel(...)

validated Client state + Model
→ protocol.toPi(...)

protocol controls
+ Auth facts
+ HTTP AbortSignal
+ Router defaults
→ composeOptions(...)
```

最终 authoritative Pi invocation 仍然是：

```text
Model<Api>
+
Context
+
ModelsSimpleStreamOptions
```

没有额外：

```text
CanonicalRequest
ExecutionPlan
RequestContext
ProviderExecutionContext
```

### Dependency Order

Natural dependency order：

```text
1. HTTP route selects Client Protocol
2. Client Protocol parses and source-validates
3. Auth establishes authorization + request identity facts
4. external selector resolves through Models → Model<Api>
5. Client Protocol performs model-aware Pi conversion
6. composeOptions(...) creates ModelsSimpleStreamOptions
7. Execution invokes Models.streamSimple(...)
```

步骤 3 与前面的 source parsing 可以在 implementation 中按安全/efficiency requirement 排序，只要：

```text
Auth owns Auth semantics
Client Protocol owns protocol validity
Model Resolution owns selector resolution
```

不发生 responsibility leakage。

### `composeOptions` Operation Contract

```text
Responsibility
- project already-established invocation controls/facts into Pi ModelsSimpleStreamOptions
- apply explicit field precedence/default rules

Bound Dependencies
- Router invocation defaults/policy, if bound rather than passed directly

Inputs
- protocol-derived Pi controls
- Auth sessionId
- Auth projectDir?
- HTTP AbortSignal

Result
- ModelsSimpleStreamOptions

Effects
- none

Temporary State
- ordinary local values only

Must Not Access
- raw HTTP body
- raw Auth credential material
- Client conversational representation
- Provider implementation
- filesystem/Git
- upstream wire
```

`composeOptions` 是 transparent carrier step。

它可能写入：

```text
sessionId → Options.sessionId
projectDir? → Options.metadata.projectDir
signal → Options.signal
```

但它不是这些 facts 的 semantic consumer。

### No Orchestration Service Graph

不需要：

```text
RequestCompositionManager
InvocationBuilderRegistry
ExecutionContextFactory
DependencyContainer
```

ordinary visible control flow 更符合 LuckyToken Core 的 architecture。

## 6.2 Model Resolution

### Operation Contract

```text
Responsibility
- deterministically resolve an external model selector into one authoritative Pi Model<Api>

Bound Dependencies
- Models

Inputs
- external model selector

Result
- Model<Api> or resolution failure

Effects
- none required

Temporary State
- selector parsing / candidate lookup state only

Must Not Access
- Client message semantics
- Auth
- Provider wire
- request project/session facts
```

Model Resolution 可以是普通 function/operation；Architecture 不要求 `ModelResolver` service。


Client Protocol 提供 external model selector。

Model Resolution 把它转为 authoritative Pi representation：

```text
external model selector
        │
        ▼
deterministic lookup
        │
        ▼
   Model<Api>
```

Resolver 使用 Pi `Models` 作为 available model catalog。

Architecture contract：

```text
Models
+
external model selector
→
Model<Api>
```

Resolution 必须 deterministic。

除非 Router API contract 明确允许，否则不能依赖：

```text
fuzzy matching
substring guessing
catalog order
credential-based Provider guessing
silent fallback
```

Exact external selector syntax 不属于 Architecture。

例如 client 使用：

```text
provider/model
protocol-native model id
another structured selector
```

属于 Client / Router API contract。

Architecture 只冻结：

```text
external selector
↓
Model<Api>
```

一旦 resolution 成功：

```text
Model<Api>
```

成为 authoritative model representation。

Temporary selector parsing、candidate lookup、ambiguity state 在这里结束 lifecycle。

Resolved model capability 随后可以被 Client Protocol 用于 model-aware representability。

---

## 6.3 Auth Boundary

### Module Contract

```text
Responsibility
- authorize inbound LuckyToken requests
- normalize request identity facts

Bound Dependencies
- authorization policy/configuration
- credential/project lookup capability
- session resolution policy
- fallback identity generation capability

Owned State
Runtime:
- private mutable auth lookup/index/cache state only when Auth owns its lifecycle
- bound policy/configuration references remain Bound Dependencies

Request-Local:
- no hidden retained state required;
  parsing/lookup intermediates belong to the operation

Operations

resolve
  Inputs
  - ReadonlyHeaders

  Result
  - denied
  - or:
    - sessionId
    - projectDir?

  Effects
  - may consult/update Auth-owned lookup/cache state according to Auth policy

  Temporary State
  - credential/session parsing
  - lookup/intermediate normalization state

Must Not Access
- Model
- Context
- Pi Options
- Pi Provider credential store
- concrete Provider implementation
- CommandCode wire representation
```

这些 dependencies 表达 capability，不要求建立对应 manager/class。

例如：

```text
credential/project lookup capability
```

可以由 Auth 内部很小的 function/data structure 实现。


LuckyToken 保留一个始终存在的 `Auth` boundary。

它不是 Provider authentication，也不是 Client Protocol conversion。它位于 request edge，只消费 inbound HTTP headers，并把 header-level credential/session representations 归一化成固定的 request-local contract。

Auth 不负责判断 Client Protocol。HTTP Boundary 先按 method/path 选择
`ClientProtocolHandler`，每个 handler 在 composition 时绑定自己的通用
`Auth` instance：

```text
POST /v1/messages
→ Anthropic handler
→ handler-bound Auth snapshot

POST /v1/responses
→ OpenAI Responses handler
→ independently bound Auth snapshot
```

Anthropic 与 OpenAI Responses 不共享 token authority，也不导入、枚举或调用
对方。通用 Auth contract 不增加 protocol ID、pathname 或 Client Wire 类型。
只有 composition root 知道 auth file 与 concrete handler 的绑定关系。

Per-request contract 概念上是：

```ts
interface AuthInput {
  headers: ReadonlyHeaders
}

type AuthResult =
  | {
      authorized: false
    }
  | {
      authorized: true
      sessionId: string
      projectDir?: string
    }
```

这里的 `ReadonlyHeaders` 只表示 framework 提供的只读 inbound header view；Architecture 不冻结具体 HTTP library 类型。

Auth 内部可以拥有：

```text
credential extraction
token validation
token → project binding lookup
session-header registry / precedence
structured session-header parsing
request-local ID fallback generation
other Router-owned access policy
```

当 deployment 选择 current file-backed Auth capability 时，每个 configured
Client Protocol handler 绑定一个独立 authority snapshot；其 Auth-owned token
file 只保存 optional global token 与 `projectDir → token` bindings，不重复保存
protocol marker。Global/project 分类只在 file-backed authority 内存在：

```text
Auth-owned token file
→ startup immutable authority snapshot
→ composition binds the snapshot to one handler
→ generic Auth.authorizeToken(token)
→ AuthorizedClient { projectDir? }
```

Token mutation 是显式、非并发 CLI 管理操作。正在运行的 handler 不 watch 或
重读文件；create/rotate/remove 后必须重启进程才能建立新的 Auth snapshot。
因此 request path 没有 filesystem I/O，也不引入 token file lock manager。

Generic Core 冻结的是 per-handler authority isolation、窄 Auth contract 与上述
information lifecycle；exact JSON fields、CLI spelling 与 filesystem mutation
mechanics 属于 file-backed Auth capability 自己的 implementation contract。

但这些全部是 Auth implementation details。外部不会知道：

```text
global token
project token
which session header matched
whether the session ID was client supplied or generated
token/project lookup representation
```

Auth 只暴露最终事实：

```text
authorized / denied
sessionId
projectDir?
```

`sessionId` 是成功请求的 normalized logical session identity。Auth 应按明确、可测试的 known-source precedence 解析 client session information；没有 usable client session identity 时，生成 fresh request-local fallback ID。Architecture 只冻结“必须存在 request-local fallback identity”，不冻结 UUID version。Current CommandCode-compatible implementation 可以使用 UUID v4 以匹配 source-backed Router producer behavior；exact generator、header registry 与 precedence 保持 Auth-internal。

`projectDir?` 表示 Auth 最终确认的 request-local project directory。缺失只表示没有 project binding fact；外部不区分其内部原因。

Auth 不知道：

```text
Pi Context
Pi Provider implementation
CommandCode headers
x-project-slug
CommandCode config schema
Provider credentials
```

Auth 与 Provider Auth 仍然是两种独立语义：

```text
Auth
= client 是否允许使用 LuckyToken
  + normalize header-derived request facts

Provider Auth
= LuckyToken 如何认证到 selected upstream
```

Provider authentication 继续由 Pi `Models` / Provider runtime owns。

Auth 完成后，以下 temporary representations 应结束 lifecycle：

```text
raw client credential
token classification
token/project lookup state
token file schema / path
Client Protocol configuration key
session header aliases / parsing state
```

后续只传播 normalized facts，不传播 Auth business model。

---

## 6.4 Pi Options Composition — `composeOptions(...)`

`Context` 由 Client Protocol conversion 产生。

`Model<Api>` 由 Model Resolution 产生。

`Options` 是剩余的 Pi invocation contract，可以合法地从多个 owner 组合 fields。

概念上：

```text
Protocol-owned projection
of ModelsSimpleStreamOptions semantics
          │
HTTP-owned AbortSignal
          │
Auth-owned normalized request facts
├── sessionId
└── projectDir?
          │
applicable Router invocation policy
          │
          ▼
composed ModelsSimpleStreamOptions
```

### Auth-Derived Pi Fields

Current frozen mapping is：

```text
Auth.sessionId
        ↓
Options.sessionId

Auth.projectDir?
        ↓
Options.metadata.projectDir?
```

`sessionId` 使用 Pi 已有的 session carrier。`metadata.projectDir` 使用 Pi request metadata 作为 Provider-consumable request fact。它不带 concrete Provider namespace：

```text
metadata.projectDir
```

而不是：

```text
metadata.commandCode.projectDir
metadata.auth.projectDir
```

原因是 `projectDir` 本身只是当前 request 可用的 project fact；selected Provider 自己决定理解、使用或忽略它。

这不是 generic arbitrary-metadata policy。Frozen allowlisted Auth → Pi projection 当前只有：

```text
sessionId
projectDir?
```

Auth 不直接构造 Pi `Options`；`composeOptions(...)` 只做 mechanical projection。

### Protocol-Derived Controls 不是 Intermediate IR

再次明确：

```text
protocol-derived invocation controls
```

不是独立 generic contract。

它只是：

> **the Client Protocol-owned projection of fields whose target semantic space is already Pi `ModelsSimpleStreamOptions`.**

Implementation 可以临时构造：

```ts
const protocolOptions = {
  maxTokens,
  temperature,
  reasoning,
}
```

但这个 object 的 semantic authority 仍来自 `ModelsSimpleStreamOptions`。

不得自然演化成：

```text
ProtocolOptions
→ RouterOptions
→ ExecutionOptions
→ PiOptions
```

### Core v1 Supported Options Subset

Pi `ModelsSimpleStreamOptions` 提供的 capability 不等于 LuckyToken Core 自动支持全部 capability。

当前 Core v1 **不启用 Pi deferred execution**：

```text
ModelsSimpleStreamOptions.deferred
→ outside current supported invocation subset
```

原因是 Pi `deferred` 的语义是：

```text
submit capable generation
→ receive durable DeferredHandle
→ generation continues asynchronously
→ fetch result later
```

这与当前 LuckyToken：

```text
one HTTP request
→ Pi execution
→ completed AssistantMessage
→ Client rendering
```

不是同一个 lifecycle。

因此：

> **Core v1 does not enable Pi deferred execution. `ModelsSimpleStreamOptions.deferred` is outside the current supported invocation subset. Supporting deferred execution would require an explicit lifecycle and Client rendering contract.**

Client Protocol projection 与 Router policy 都不得在 current Core path 中设置 `deferred`。

这不需要 `DeferredManager`、`JobStore` 或新的 async execution architecture；如果未来出现 demonstrated requirement，再显式重新设计该 lifecycle。

### 每个 Option Field 必须有 Ownership / Precedence

每个 composed option field 必须满足：

```text
one authoritative source
```

或者：

```text
one explicit precedence rule
```

不能依赖 incidental object-spread order 决定 semantics。

例如：

```text
explicit Client request value
+
Router default
```

可以定义：

```text
explicit value
→ authoritative

otherwise
→ Router default
```

而：

```text
AbortSignal
```

天然 owner 是：

```text
HTTP request lifecycle
```

所以不应存在 competing override source。

普通 explicit object construction 足够，不需要：

```text
OptionsBuilder
OptionsManager
OptionsComposer
ExecutionOptionsFactory
```

### Composed Options 不是 Provider-Final Options

`composeOptions(...)` 产生的是：

```text
composed ModelsSimpleStreamOptions
```

也就是 LuckyToken → Pi `Models` 的 invocation input。

Pi `Models` 随后可能根据自己的 runtime contract 进行：

```text
Provider auth resolution
apiKey resolution
header merging
environment merging
baseUrl override
Provider-facing request preparation
```

因此不要把 LuckyToken composition output 称为：

```text
final Provider options
```

更准确的是：

```text
Pi invocation Options
or
composed Options
```

---

### Pi Options Are Not a Generic Transport Channel

Pi option field 存在，不代表 unrelated LuckyToken state 可以塞进去。

使用一个 Pi option 的要求是：

```text
source fact semantics
=
Pi option semantics
```

这适用于看起来很 generic 的：

```text
headers
metadata
env
sessionId
```

Name/shape 相似不能证明 semantic equivalence。

Current source/Pi evidence 已经关闭两个具体映射：

```text
normalized session identity → Options.sessionId
normalized project directory → Options.metadata.projectDir
```

除此之外仍不得把 `metadata`、`headers` 或其他 Pi options 当作 generic state bag。

Client HTTP headers 也不能 generic forward 到 Pi request headers：

```text
Client Headers
        │
        ╳
        ▼
Options.headers
```

不是 architecture path。

一个 Client header 只有在 owning HTTP/Protocol boundary 把它解释成受支持 LuckyToken concept 后，才可以通过 semantics 真正匹配的 contract 继续传播。

这保护：

```text
Client → LuckyToken authorization / protocol state
```

与：

```text
LuckyToken → Provider runtime controls
```

之间的 isolation。

---

### Non-Pi Request Facts

Normal composition target 保持：

```text
Model + Context + Options
```

如果 concrete integration 证明需要额外 request-local fact，而现有 Pi contract 无法正确表示，那么不能通过把它藏到以下位置来“解决”：

```text
Context
arbitrary metadata
arbitrary headers
unrelated Options field
```

Decision order：

```text
required fact
    │
    ▼
Does an existing Pi contract express
matching semantics + lifecycle?
    │
    ├── yes
    │      ↓
    │   reuse it
    │
    └── no
           ↓
explicit concrete integration gap
```

Concrete integration 再拥有关闭这个 gap 的最小 contract。

Generic Core 不提前建立 universal carrier。

---

## 6.5 Composition Lifecycle and Failure

request assembly 可以在 Pi execution 开始前失败。

例如：

```text
Auth denied
model resolution failure
Client Protocol validation failure
Pi representability failure
invalid invocation configuration
```

Failure 由 detecting boundary owns semantics。

Pre-execution failure 不被强制转换成统一 `LuckyTokenError` enum。

Architecture 只要求：

```text
detector
→ preserves minimum classification needed by renderer
→ Client Protocol / HTTP error rendering
```

Failure 不会变成 fake successful `AssistantMessage`。

在 Pi execution 尚未开始时，不存在 Provider request-local execution state。

Successful composition 后，execution input 是：

```text
Model<Api>
+
Context
+
ModelsSimpleStreamOptions
```

Temporary state 随后结束 lifecycle：

```text
external model selector
model lookup candidates
raw client authorization material
authorization lookup state
AuthResult after sessionId/projectDir projection
full Client parsing / validation state
representability scratch state
temporary Options merge state
```

保留到后面的只有仍有 owner/consumer 的 information，例如：

```text
Model<Api>
Context
Options
protocol-owned render state
HTTP connection state
```

request assembly 自己不拥有 long-lived state。

它的完整 responsibility 是：

```text
independently owned request facts
↓
Pi invocation
```

且不建立第二个 canonical request representation。

# 7. Execution — 执行生命周期

> **Concept Primer — 本章只处理 Pi execution lifecycle**
>
> - **Execution**：把一个 composed Pi invocation 运行成一个 request outcome 的 request-local control flow。它不重新解释 Client Protocol 或 Provider wire。
> - **AssistantMessageEventStream**：Pi 的 async event stream。它包含 start/content/tool 等 intermediate events，并以 `done` 或 `error` terminal 定义正常可观察的 execution outcome。
> - **Active Consumption / Drain**：真正通过 async iteration 消费 stream events，而不是只调用 `.result()`。这既避免 intermediate event queue 无界积压，也让 Execution 看到 terminal discriminator。
> - **Intermediate Event**：`start`、text/thinking/tool deltas 等 request-local lifecycle state。它们不是最终 request result。
> - **Terminal Event**：决定 Pi execution outcome 的 event。`done` 是 success，`error` 是 failure。
> - **Atomic Result**：只有成功 terminal 后，完整 `AssistantMessage` 才成为下一 boundary 的 successful semantic result。
> - **Cancellation**：request 因 client disconnect、HTTP abort、timeout 等原因停止。Cancellation 是 failure outcome，不是正常 success。
> - **Liveness vs Correctness**：Correctness 说明什么 terminal 才算成功；Liveness 说明系统是否能保证最终观察到 outcome。Malformed Provider stream 可能造成 liveness problem，不能靠“假设 EOF 可观察”解决。

Execution 接收：

```text
Model<Api>
+
Context
+
ModelsSimpleStreamOptions
```

成功 output：

```text
AssistantMessage
```

失败 output：

```text
aborted
or
error
```

Normal path：

```text
Model + Context + Options
        │
        ▼
      Models
        │
        ▼
AssistantMessageEventStream
        │
        ▼
active consumption
        │
        ├── done
        │      ↓
        │ AssistantMessage
        │
        └── error
               ↓
         aborted | error
```

Execution 只理解 Pi stream lifecycle。

它不理解：

```text
Client Protocol wire events
upstream Provider events
Provider request representations
Provider-specific partial state
Client response encoding
```

它的 responsibility 是：

> **Consume the Pi execution lifecycle and establish one atomic successful result or Pi-exposed failure outcome.**

---

## 7.1 Execution Boundary

### Operation Contract — `execute`

```text
Responsibility
- invoke Pi Models for one request
- actively consume the Pi execution lifecycle
- independently observe request cancellation
- establish one atomic success/failure outcome

Bound Dependencies
- Models

Inputs
- Model<Api>
- Context
- ModelsSimpleStreamOptions

Result
- committed successful AssistantMessage
- or aborted failure
- or error failure

Effects
- consume the AssistantMessageEventStream
- trigger no downstream live-forwarding in Core v1

Temporary State
- stream iterator/reference
- terminal observation
- abort observation
- success-commit state
- temporary event references

Must Not Access
- raw HTTP request
- LuckyToken Auth
- Client Protocol internal state
- concrete Provider implementation
- upstream wire/events
- global runtime configuration
```

`Models` 可以通过 closure binding、factory 或显式 function argument 进入 Execution。Architecture 不规定语法，只禁止 hidden global dependency。


request assembly 已经建立：

```text
Model<Api>
Context
ModelsSimpleStreamOptions
```

Execution 把它们交给 Pi：

```text
models.streamSimple(
  model,
  context,
  options,
)
```

得到：

```text
AssistantMessageEventStream
```

从这个调用点开始，LuckyToken 把返回的 `AssistantMessageEventStream` 作为 authoritative outcome channel。

因此：

```text
PRE-PI
├── source validation
├── Auth
├── Model resolution
├── Pi representability
└── Options composition


PI EXECUTION
└── begins at Models.streamSimple(...)
    ├── Provider lookup
    ├── Pi auth resolution
    ├── lazy Provider / API setup
    ├── Provider startup
    ├── upstream execution
    └── Pi terminal
```

即使 Provider auth/setup failure 发生在 upstream request 发送之前，只要 Pi 通过该 stream 的 `error` terminal 暴露它，它就是 Pi execution phase 的：

```text
aborted | error
```

而不是 pre-execution boundary failure。

Pi `Models` 继续 owns：

```text
Provider selection
Provider auth integration
Provider dispatch
```

selected Provider owns upstream execution。

Execution 不增加另一层 model runtime。

因此不需要：

```text
Executor class hierarchy
ExecutionManager
StreamManager
LifecycleCoordinator
ExecutionRegistry
```

一个 small request-local function 可以完成 required control flow。

---

## 7.2 Active Stream Consumption

Execution 必须 active consume `AssistantMessageEventStream`。

不能只把 stream 当成最终 Promise：

```text
AssistantMessageEventStream
        │
        ▼
for await (...)
        │
        ├── intermediate event
        │      ↓
        │    consume
        │
        └── terminal event
               ↓
          establish outcome
```

原因有两个。

### 1. Intermediate Events 是真实 queue state

Pi `EventStream` 在没有 waiting consumer 时会 queue events。

如果只等待 `.result()`，intermediate events 可能继续积压。

所以 active drain 是 resource/lifecycle requirement，而不只是“为了看 token”。

### 2. `.result()` 不能区分 success 与 failure

Pi `AssistantMessageEventStream.result()` 的 final result type 都是 `AssistantMessage`。

无论 terminal 是：

```text
done
or
error
```

都可能 resolve 一个 `AssistantMessage`。

因此 Execution 必须观察 terminal discriminator，而不能用“拿到了 AssistantMessage”推断 success。

Atomic execution 不要求理解每个 intermediate content event 的业务 semantics。

这些 event 可以被 consume 后丢弃，除非 request-local diagnostics 有明确需要。

关键区别：

```text
intermediate Pi event
≠
request result
```

---

## 7.3 Terminal Semantics and Failure Contract

Pi terminal events are the authoritative semantic source for Pi execution completion, but they are not the only request-outcome input. The HTTP-owned request `AbortSignal` remains independently authoritative for cancellation until a completed success is committed.

Public Pi terminal contract:

```text
done.reason
= stop | length | toolUse | deferred

error.reason
= aborted | error
```

Pi public terminal union 包含 `deferred`，但 LuckyToken Core v1 的 supported invocation subset **不启用 deferred execution**。

因此需要区分：

```text
Pi public terminal contract
├── done(stop | length | toolUse | deferred)
└── error(aborted | error)


LuckyToken Core v1 supported execution outcomes
├── completed success
│   └── done(stop | length | toolUse).message
│       AND request signal not aborted at commit point
│
└── failure
    ├── aborted
    └── error
```

其中：

```text
done(reason=deferred)
= Pi execution success

but

done(reason=deferred)
≠ completed model generation
```

所以 `deferred` 不能被当前 renderer 当成 completed generation success。

在 valid Core v1 invocation path 中，`composeOptions(...)` 不会设置 `ModelsSimpleStreamOptions.deferred`；因此正常情况下不应产生 `done(reason=deferred)`。如果 malformed/unexpected Provider 仍返回该 variant，它属于 unsupported Core outcome，不能被 silently rendered as completed success。

### Success

Current Core v1 只有同时满足：

```text
done.reason = stop | length | toolUse
+
request AbortSignal is not aborted at the success commit point
```

才建立 completed successful generation。

```text
supported done.message
        │
        ├── signal not aborted
        │
        ▼
AssistantMessage
```

成为 authoritative success result。

如果 request signal 已经在 commit 前 aborted，则晚到的 `done` 不能重新把 request 变成 success。

### Failure

`error` terminal 永远不是 success，即使它携带一个 final-shaped `AssistantMessage`。

正常情况下，Execution 保留：

```text
error.reason
├── aborted
└── error
```

作为 Pi execution 后的最小 failure classification。

但是 cancellation precedence 是独立 rule：

```text
request AbortSignal observed aborted
before successful commit
        │
        ▼
outcome = aborted
```

因此即使 Pi lazy setup / auth / Provider startup 在 cancellation 后最终暴露：

```text
error.reason = error
```

LuckyToken 也不能把这个 request 降格成 ordinary `error`。

> **After LuckyToken invokes `Models.streamSimple(...)`, Pi terminal events remain the semantic completion channel, while the request `AbortSignal` remains independently authoritative for cancellation until success commit. More specific Pi-internal setup/runtime classifications are not part of the current Core execution contract.**

因此不能从：

```text
errorMessage
```

重新推断：

```text
auth
oauth
provider
stream
model_source
...
```

> **Raw exception text is diagnostic information, not an architectural classification mechanism.**

### Malformed Pi Stream End：Defensive Rule Only

如果 Execution **实际观察到** async iteration 在没有任何：

```text
done
error
```

的情况下结束，则必须把它视为 malformed/incomplete execution failure。

即：

```text
observed iterator end
without done/error
→ failure
```

但是这只是一条 **defensive correctness rule**，不是 LuckyToken 检测所有 malformed Provider lifecycle 的 primary liveness mechanism。

Pi runtime 的 lazy stream forwarding 可能在 inner stream silent-end、但其 `.result()` 永不 resolve 时，使 outer stream 本身不结束。

因此 Architecture **不能承诺**：

```text
any malformed Provider stream
→ Execution will always observe EOF
```

真正的主要 correctness path 是：

```text
Upstream incomplete termination
        │
        ▼
Provider detects incomplete lifecycle
        │
        ▼
Provider emits Pi error terminal
        │
        ▼
Execution observes error
        │
        ▼
      failure
```

Provider responsibility 在 Chapter 8 冻结。

如果还需要防御一个违反 Pi terminal contract、导致 stream 永久挂起的 third-party/malformed Provider，则这是独立 **liveness policy**，应通过 existing request cancellation mechanism，例如：

```text
HTTP abort
configured timeout
```

解决，而不是建立 EOF watchdog manager。

Execution 不 repair incomplete Pi lifecycle，也不：

```text
invent terminal event
invent stop reason
assume transport silence means success
promote partial content to final result
```

Execution 也不诊断导致问题的 upstream protocol；那属于 Provider boundary。

---

## 7.4 Atomic Result and Downstream Semantics

Current Core execution 使用 atomic semantic commit boundary。

在 successful commit 前：

```text
start
content starts
content deltas
content completions
partial AssistantMessage state
supported done observed but request signal already aborted
```

都不是 successful request result。

概念上：

```text
Pi stream
│
├── intermediate events
│      ↓
│ request-local execution only
│
└── supported done
    (stop | length | toolUse)
       │
       ├── request signal aborted
       │       ↓
       │   failure: aborted
       │
       └── request signal not aborted
               ↓
          success commit
               ↓
        AssistantMessage
               ↓
          next boundary
```

Execution 的唯一 successful output 是：

```text
AssistantMessage
```

Successful commit 是一个 request-local semantic boundary：

```text
supported done observed
+
request signal not aborted at commit point
        ↓
success committed
```

一旦 success 已经 committed，之后发生的 client disconnect / response close 不会 retroactively 改变 model execution semantics；它只影响 downstream delivery：

```text
success committed
→ semantic result remains success

later disconnect / closed response
→ no further HTTP write
```

### Streaming-Shaped Response ≠ Live Forwarding

Core v1 明确冻结：

> **Core v1 has an atomic downstream semantic boundary. Client streaming response formats, when supported, are rendered only after a supported completed Pi `done` (`stop | length | toolUse`) has been successfully committed; live token forwarding and Pi deferred execution are outside the current execution contract.**

所以：

```text
Client requests stream=true
```

并不自动意味着：

```text
Pi text_delta
→ immediately write Client delta
```

当前允许的是：

```text
Pi done(stop | length | toolUse)
+
request signal still live
→ complete AssistantMessage
→ renderer creates protocol-compatible response
```

如果 protocol 要求 streaming-shaped wire，可以在完整 result 后产生对应 event sequence，但其 semantic commit 仍是 atomic。

Future live downstream forwarding 会改变：

```text
commit boundary
response write lifecycle
partial failure behavior
closed-response behavior
```

因此必须显式重新设计，不能隐藏在 current renderer 中。

---

## 7.5 Cancellation and Lifecycle

Request `AbortSignal` 由 `HTTP Boundary` 创建，并通过 `composeOptions(...)` 进入 Pi `Options`。

Propagation：

```text
HTTP AbortSignal
        │
        ▼
      Options
        │
        ▼
      Models
        │
        ▼
     Provider
        │
        ▼
     Upstream
```

Execution 不 owns Provider transport cancellation implementation，但它必须独立 observe request cancellation while draining the Pi stream。

这是因为 Pi 的 Provider auth / lazy setup path 可能把 abort-triggered rejection 暴露成普通：

```text
error.reason = error
```

而不是：

```text
error.reason = aborted
```

所以 request cancellation 不能完全委托给 Pi terminal classification。

Execution owns the following precedence rule：

```text
request AbortSignal observed aborted
before successful commit
        │
        ▼
request outcome = aborted
```

这个 rule 高于之后晚到的 ordinary Pi error，也阻止 late `done` 被 commit 成 success。

概念上：

```text
                    active Pi drain
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
         Pi stream event        request AbortSignal
              │                       │
              │                       └── aborted before commit
              │                                ↓
              │                           failure: aborted
              │
              ├── error(aborted)
              │       ↓
              │   failure: aborted
              │
              ├── error(error)
              │       ↓
              │   failure: error
              │   unless signal already aborted
              │
              └── supported done
                      │
                      ├── signal aborted
                      │      ↓
                      │  failure: aborted
                      │
                      └── signal live
                             ↓
                        success commit
```

Implementation 应以普通 request-local control flow 独立等待 stream progress 和 abort，例如 semantic equivalent of：

```text
race(next stream progress, abort signal)
```

Architecture 不要求特定 helper、manager 或 wrapper；只要求 cancellation 不能因为 Provider/lazy stream 没及时结束而失去 liveness。

Execution 不能在 cancellation 后：

```text
wait indefinitely for later normal success
commit partial output as success
synthesize a successful AssistantMessage
promote a late done to success
```

HTTP Boundary 同时 owns response connection state。

如果 client disconnect 在 success commit 前发生：

```text
client disconnect
→ abort signal fires
→ request outcome = aborted
→ response becomes non-writable
```

如果 client disconnect 在 success commit 后发生：

```text
success already committed
→ semantic execution remains success
→ response becomes non-writable
→ HTTP Boundary skips/ends delivery as applicable
```

所以：

```text
abort before success commit
→ execution cancellation

abort/disconnect after success commit
→ delivery lifecycle only
```

Provider-owned incomplete state 由 Provider cleanup。

Execution 自身只保留 minimal request-local state，例如：

```text
stream reference
abort observation
terminal observation
success-commit state
temporary event reference
```

没有 execution state 跨 request 共享。

Success committed 时：

```text
AssistantMessage
```

成为 authoritative successful result，execution-local stream state 结束。

Failure / cancellation 时：

```text
stream reference
intermediate event references
abort / terminal tracking
```

结束 lifecycle，不产生 success result。

Defensive iterator-end failure 只有在 iterator **实际结束** 时成立；它不替代 Provider 的 upstream incomplete lifecycle detection，也不替代 AbortSignal-based liveness。

完整 boundary：

```text
Model + Context + Options
        │
        ▼
      Models
        │
        ▼
AssistantMessageEventStream
        │
        ▼
active drain + independent abort observation
        │
        ├── request abort before commit
        │      ↓
        │   failure: aborted
        │
        ├── done(stop | length | toolUse)
        │      ├── signal aborted → failure: aborted
        │      └── signal live    → AssistantMessage success commit
        │
        ├── error(aborted)
        │      ↓
        │   failure: aborted
        │
        ├── error(error)
        │      ├── signal aborted → failure: aborted
        │      └── signal live    → failure: error
        │
        └── observed end without terminal
               ↓
          defensive failure
```

Execution owns no long-lived state、Provider-specific semantic state 或 upstream EOF semantics。

---

# 8. Provider 边界 — Provider Boundary

> **Concept Primer — 本章处理 Pi ↔ concrete upstream 的边界**
>
> - **Provider Boundary**：Pi runtime contracts 与一个 concrete upstream integration 相接的位置。
> - **Upstream Representation**：只对该 upstream 有意义的 request/response/event representation，例如 endpoint-specific JSON、headers、SDK values、raw stream events。
> - **Compatibility Normalization**：Provider 为了让已经 valid 的 Pi state 满足 upstream constraints 而进行的 adaptation。它不是 Client Protocol repair。
> - **Transport**：实际发送 request / 接收 response 的机制，例如 HTTP、streaming HTTP、SDK、WebSocket。
> - **Upstream Lifecycle Conversion**：把 upstream-specific start/content/tool/terminal lifecycle 转成 Pi `AssistantMessageEventStream` lifecycle。
> - **Provider-Lifetime State**：Provider object 可以跨 request 保留的 stable state，例如 identity、static config、auth behavior。
> - **Provider Request-Local State**：只属于一次 upstream request 的 mutable state，例如 parser buffer、partial tool state、transport handle、terminal tracking。
> - **Late Conversion**：Provider-specific wire representation 只有到 Provider 真正需要时才创建，避免 upstream vocabulary 向 Generic Core 泄漏。

Provider Boundary 把 Pi runtime contracts 转成一个 concrete upstream integration，再把 upstream lifecycle 转回 Pi。

Normal contract：

```text
Model<Api>
+
Context
+
Provider-facing stream options
        │
        ▼
     Provider
        │
        ▼
     Upstream
        │
        ▼
     Provider
        │
        ▼
AssistantMessageEventStream
```

LuckyToken 进入 Pi `Models` 时使用 composed `ModelsSimpleStreamOptions`。Pi `Models` 可以进行 auth/header/env preparation，再调用 Provider。因此 Provider-facing options 是 Pi runtime 派生后的 request input，不是 LuckyToken 自己维护的第二套 Options。

Provider 只 owns upstream-specific part。

它不 owns：

```text
HTTP routing
Client Protocol parsing
Client Protocol validity
Client → Pi representability
external model selector resolution
Auth
generic Execution outcome
Client response rendering
```

LuckyToken 直接使用 Pi `Provider` 作为 generic Provider runtime contract，不增加第二层：

```text
ProviderAdapter
ProviderRuntime
ProviderExecutor
ProviderRouter
TransportManager
```

---

## 8.1 Provider Boundary

### Pi Provider Boundary Contract

Pi `Provider` is the generic external runtime contract used by LuckyToken.

Pi-owned Provider implementations remain Pi-owned. LuckyToken does not redefine their internal dependency closure.

When LuckyToken implements a concrete Provider itself, that implementation is a LuckyToken-owned module and must satisfy the Module / Operation Runtime Closure rules in Chapter 2.

### LuckyToken-Owned Concrete Provider Module Shape

```text
Responsibility
- own one concrete Pi ↔ upstream integration
- expose Pi Provider operations
- convert upstream lifecycle into Pi AssistantMessageEventStream

Bound Dependencies
- stable Provider/upstream configuration
- concrete compatibility policy
- direct upstream capability required by that integration
- direct request-environment capability only when the Provider itself owns that responsibility

Owned State
Runtime:
- provider-owned mutable model/catalog/cache/runtime state, if any
- stable injected configuration/policy references remain Bound Dependencies

Request-Local:
- no hidden cross-request state;
  request parser/transport/partial state belongs to the stream operation

Operations

stream / streamSimple
  Inputs
  - Model<Api>
  - Context
  - Provider-facing Options prepared by Pi Models

  Result
  - AssistantMessageEventStream

  Effects
  - create upstream request
  - execute upstream transport
  - emit Pi stream lifecycle

  Temporary State
  - upstream request representation
  - transport/parser state
  - partial structured state
  - terminal state

optional provider operations
  - refreshModels
  - fetchDeferred
  - cancelDeferred
  as supported by the concrete Provider contract

Must Not Access
- LuckyToken inbound Auth implementation
- raw Client Protocol representation
- Client renderer state
- generic whole-request context
```

LuckyToken-owned concrete Provider 的 direct dependencies 必须按 concrete integration 声明。

Generic Provider chapter 不要求每个 Provider 都注入：

```text
filesystem
Git
clock
fetch wrapper
environment reader
```

这些只有在 concrete Provider 直接 owns 相应 responsibility 时才进入它的 closure。

同样，`CredentialStore` 不属于 concrete Provider 的 direct dependency：Pi `Models` owns credential storage/resolution，并通过 Provider-facing options 传递 effective auth material。


Pi `Models` 根据 resolved model 找到 owning Provider，并 delegate execution。

```text
Model<Api>
    │
    ▼
  Models
    │
    ▼
owning Provider
```

Provider authentication integration 与 dispatch 属于 Pi `Models`，Chapter 4 已定义。

Provider invocation 开始后，Provider 只需要理解两侧 adjacent domains：

```text
Pi runtime contracts
↕
its own upstream integration
```

Client Protocol object 不进入 Provider。

Provider wire object 也不返回 Client Protocol。

---

## 8.2 Provider-Owned Representation

只对某 upstream 有意义的信息保持 Provider-owned。

典型包括：

```text
upstream endpoint selection
upstream request objects
Provider-specific headers
query parameters
SDK request values
raw response objects
raw stream events
upstream finish representation
upstream usage representation
request-local parser state
```

这些 representation 只在 Provider 需要时创建：

```text
Pi representation
        │
        ▼
Provider boundary conversion
        │
        ▼
upstream representation
```

Return path：

```text
upstream representation
        │
        ▼
Provider boundary conversion
        │
        ▼
Pi representation
```

Provider-specific state 不向前泄漏到：

```text
Client Protocol
Auth Boundary
Model Resolution
composeOptions / request assembly
```

也不在转换成 Pi stream state 后继续向 Generic Execution 泄漏。

Concrete Provider 可能需要 integration-specific config 或 request-local facts。

这种 need 仍然属于 concrete integration。

Generic chapter 不预定义：

```text
ProviderMetadata
ProviderOverrides
ProviderExecutionContext
SessionContext
ProjectContext
```

---

## 8.3 Compatibility Normalization

Provider 可能需要把已经 valid 的 Pi state adaptation 成 upstream-compatible form：

```text
valid Pi state
      │
      ▼
Provider compatibility
      │
      ▼
upstream-compatible state
```

这个阶段发生在 Client Protocol 已经建立：

```text
source validity
+
Pi representability
```

之后。

因此：

> **Provider compatibility is not Client Protocol repair.**

LuckyToken normal path 不能依赖 Provider compatibility：

```text
repair invalid Client history
invent missing Client relationships
recover unsupported Client semantics
turn malformed Client state into valid Pi state
```

同时，compatibility 也不能被假设为 semantically inert。

真实 Provider normalization 可能：

```text
remove content
replace content
insert content
normalize identities
change continuity metadata
change model-visible representation
```

所以任何会 material change model-visible meaning 的 compatibility behavior 都必须通过 integration tests 理解和验证。

特别应覆盖类似：

```text
unsupported images
cross-model thinking/signatures
tool-call ID normalization
orphan tool calls
error/aborted historical assistant messages
```

的 paths，确保 LuckyToken accepted `Context` 不依赖 repair behavior 才变成 valid。

Architecture 不复制每个 Provider 的 compatibility algorithm，只冻结 boundary：

```text
already-valid Pi state
↓
Provider-owned compatibility
↓
upstream representation
```

---

## 8.4 Request and Transport

Provider 把 Pi invocation 转成 upstream request：

```text
Model
+
Context
+
Provider-facing options
        │
        ▼
Provider request conversion
        │
        ▼
upstream request
        │
        ▼
transport
```

Transport 可以是：

```text
HTTP
streaming HTTP
SDK call
WebSocket
another Provider-specific transport
```

Generic Core 不要求所有 Provider 共享一个 transport abstraction。

Provider request object 是 temporary boundary representation，不是：

```text
new canonical LuckyToken request
persistent execution model
cross-Provider IR
```

Provider-specific wire representation 应 late-create。

Transport state，例如：

```text
headers
HTTP status
socket state
retry counters
request identifiers
raw response handles
```

属于 Provider infrastructure，不进入 Pi `Context`。

Exact Pi ↔ upstream field mapping 属于 concrete Provider `Conversion Spec`。

---

## 8.5 Upstream Lifecycle Conversion

Provider owns upstream response lifecycle interpretation。

```text
Upstream
    │
    ▼
raw response / stream
    │
    ▼
Provider parser + request-local state
    │
    ▼
AssistantMessageEventStream
```

Raw upstream events 不跨 Provider boundary。

Generic Execution 只看到 Pi events。

Provider 必须满足 Pi stream terminal contract，不管 upstream 内部怎样表示 streaming。

如果 upstream 定义：

```text
explicit semantic success
explicit semantic failure
content lifecycle
structured partial state
```

Provider 必须先根据 upstream Protocol Spec 正确解释，再发 Pi events。

### Incomplete Upstream Termination Ownership

这是 Core correctness 的明确 Provider responsibility。

如果 Provider 能观察到 upstream transport/lifecycle 已结束，但 upstream protocol 规定的 semantic terminal 没有出现，则 Provider 必须把它转换成 Pi failure terminal，而不能 silent-end Pi stream。

正确路径：

```text
Upstream EOF / incomplete lifecycle
        │
        ▼
Provider detects protocol incompleteness
        │
        ▼
Provider emits Pi error terminal
        │
        ▼
Execution observes error
        │
        ▼
      failure
```

因此：

> **A Provider is responsible for converting observable incomplete upstream termination into a Pi `error` terminal before ending its Pi stream. Execution must not rely on malformed Pi stream EOF as its primary failure signal.**

Provider 不应：

```text
upstream EOF
→ Pi stream.end() without terminal
```

当 upstream protocol 要求 explicit semantic terminal 时，transport completion 本身不能升级为 success。

### Known Malformed vs Unknown Extension

```text
known malformed upstream state
```

和：

```text
unknown upstream extension
```

是不同 protocol condition。

Exact behavior 属于 concrete Protocol / Conversion Spec。

Generic Architecture 不强制所有 Provider 对 unknown event 使用同一个 policy。

### Partial Structured State

Partial state 保持 Provider-local：

```text
partial upstream state
        │
        ▼
Provider-local temporary state
        │
        ▼
protocol-established completion
        │
        ▼
completed Pi state
```

Generic Execution 不从 raw upstream partial state 重建 semantic completion。

---

## 8.6 Provider Lifetime Scope

Provider-lifetime 与 request-lifetime state 必须分开。

```text
Provider
│
├── Bound Lifetime Dependencies
│   ├── upstream implementation / configuration
│   ├── endpoint / static configuration
│   ├── authentication / compatibility policy
│   └── direct integration capabilities
│
├── Provider-Owned Runtime State
│   └── mutable model / catalog / cache / runtime state, if any
│
└── One Request
    ├── upstream request representation
    ├── effective request configuration
    ├── transport state
    ├── parser state
    ├── partial upstream state
    └── terminal state
```

A dependency being retained for the Provider lifetime does not make it Provider-owned state. Ownership follows the authoritative-lifecycle rule defined in §2.10.

Provider object 可能并发服务多个 request，因此 request-specific mutable state 不能变成 Provider-global mutable state。

这不需要：

```text
ProviderRequestRegistry
ActiveStreamManager
RequestStateManager
```

request-local variables / closures 通常足够。

Cancellation 通过 Pi request lifecycle 到达 Provider。

Provider owns：

```text
cancel upstream work where supported
discard incomplete Provider-local state
stop processing after request terminal
```

Cancellation 不得转换为 upstream success。

当 Provider 已经 emit Pi terminal 后，任何 later upstream activity 都不能继续 mutate/extend 这个 Pi request lifecycle。

Typical death points：

| Information | Architectural death point |
| --- | --- |
| Provider request representation | transport no longer requires it |
| Provider-specific request headers | request has been sent / transport no longer needs them |
| Raw upstream response/event | converted into Provider-local or Pi state |
| Partial upstream state | semantic completion, failure, abort, or request termination |
| Provider parser state | request terminal |
| Provider transport state | request terminal |
| Final Provider stream state | Pi terminal emitted |

完整 generic Provider lifecycle：

```text
                   Models
                     │
                     ▼
                  Provider
                     │
             valid Pi invocation
                     │
          ┌──────────┴──────────┐
          │                     │
          ▼                     ▼
 compatibility            request conversion
          │                     │
          └──────────┬──────────┘
                     │
                     ▼
                  Upstream
                     │
                     ▼
          upstream response lifecycle
                     │
                     ▼
        Provider-local parser/state
                     │
          ┌──────────┴──────────┐
          │                     │
   valid semantic terminal   incomplete / error
          │                     │
          ▼                     ▼
    Pi done / error        Pi error terminal
          │                     │
          └──────────┬──────────┘
                     ▼
       AssistantMessageEventStream
```

Provider Boundary 只 owns 这段 upstream-specific transition。

一个 concrete Provider 证明的 requirement 保持 local，直到另一个真实 integration 证明相同 semantics、ownership 与 lifecycle。

# 9. CommandCode Private Provider — Concrete Integration

> **Concept Primer — 本章只描述一个 concrete integration**
>
> - **CommandCode**：upstream product/service family 的名称，不等于某一个固定 API contract。
> - **CommandCode Private Protocol**：LuckyToken 当前基于 observed behavior 推断出的 private `/alpha/generate` wire protocol。它是 observed private contract，不是 CommandCode product 的 universal protocol。
> - **CommandCode Private Provider**：实现这个 Private Protocol 的 concrete Pi `Provider` integration。
> - **Generation Semantics**：来自 Pi `Model + Context + Options`、直接影响 model generation 的 information。
> - **Runtime / Project Facts**：Private Protocol request 中与 generation conversation 不同的一支，例如 `config`、`permissionMode`、`threadId` 等。
> - **Logical Thread Identity**：同时映射到 body `threadId` 与 header `x-session-id` 的一个 authoritative logical identity。Current integration 已冻结为 Auth-normalized `sessionId` → Pi `Options.sessionId` → Provider wire mapping。
> - **Semantic Terminal vs Transport Sentinel**：`finish/error` 决定 Private Protocol semantic outcome；`[DONE]` 只表示 transport framing，不等于 success。
> - **Incremental Tool Input**：`tool-input-start/delta/end` 形成的 temporary partial serialized input。
> - **Authoritative Tool Completion**：只有后续 `tool-call` event 才建立 completed invocation。
> - **Keyed Temporary State**：因为多个 tool ID 可以 interleave，partial state 必须按 tool identity 隔离。

LuckyToken 当前维护一个 concrete Pi Provider：

```text
CommandCode Private Provider
        │
        ▼
CommandCode Private Protocol
        │
        ▼
POST /alpha/generate
```

本章只讨论这个 integration。

它不会定义未来其他 CommandCode API 的 architecture，也不会把 Private Protocol facts 升级为 Generic Core concepts。

Boundary：

```text
Model<Api> + Context + Options
                     │
                     │ Options.sessionId
                     │ Options.metadata.projectDir?
                     ▼
          CommandCode Private Provider
                     │
                     ├── Provider auth / configuration / policy
                     ├── late CommandCode request construction
                     └── upstream lifecycle conversion
                     │
                     ▼
            POST /alpha/generate
                     │
                     ▼
        CommandCode Private event lifecycle
                     │
                     ▼
          AssistantMessageEventStream
```

Generic Provider ownership 已在 Chapter 8 定义。

本章只记录 Private Protocol 相对于 generic Provider boundary 增加的 architecture delta。

---

## 9.1 Request Information Hierarchy

### Module Contract — CommandCode Private Provider

```text
Responsibility
- own Pi ↔ CommandCode Private conversion
- derive CommandCode request-local project representation
- execute the Private upstream lifecycle
- convert it back to Pi stream semantics

Bound Dependencies
- stable CommandCode endpoint/provider configuration
- CommandCode compatibility / permission policy
- Project Snapshot capability
- Trace Context generation capability
- upstream transport implementation/configuration when not supplied through Pi invocation

Owned State
Runtime:
- provider-owned mutable model/catalog/cache/runtime state, if any
- stable endpoint/configuration/policy references remain Bound Dependencies

Request-Local:
- no hidden cross-request state;
  request-specific representations belong to the stream operation

Operations

streamSimple
  Inputs
  - Model<Api>
  - Context
  - Provider-facing Options
    - effective auth material
    - signal
    - sessionId
    - metadata.projectDir?
    - invocation controls

  Result
  - AssistantMessageEventStream

  Effects
  - derive project snapshot / project slug when applicable
  - generate per-upstream-request trace context
  - build and send CommandCode Private request
  - consume Private event lifecycle
  - emit Pi lifecycle

  Temporary State
  - CommandCode request representation
  - project snapshot result
  - trace context value
  - transport/parser state
  - keyed partial tool state
  - terminal state

Must Not Access
- LuckyToken Auth implementation
- raw inbound client headers
- Client Protocol representation
- HTTP response object
- generic RequestContext/ApplicationContext
```

`Project Snapshot capability` 的 implementation 可以继续使用小函数。

它后面的 filesystem / Git / clock/date dependencies 属于该 capability 的 recursive closure；不要求把所有 primitives 提升成 CommandCode Provider 顶层 dependency。

`Trace Context generation capability` owns one narrow responsibility：

```text
one upstream request
→ fresh W3C-shaped traceparent value
```

Current CommandCode compatibility evidence generates a new random trace ID and span ID per upstream request.

Architecture 不把底层：

```text
random bytes
crypto API
telemetry library
```

直接提升成 Provider dependency；这些 transitive primitives 保持在 trace-context capability 后面。

如果未来统一 telemetry/transport capability 已经 authoritative 地 owns outbound trace context，则该 capability 可以替代 standalone trace generator，但 Provider 仍不得从 undeclared random source 临时生成 `traceparent`。


Observed `CommandCodeRequest` 有两个天然不同的 wire branch：

```text
CommandCodeRequest
├── Runtime / Project Context
│   ├── config
│   ├── memory
│   ├── taste
│   ├── skills
│   ├── permissionMode
│   └── threadId
│
└── Generation Parameters
    └── params
```

这两个 wire branch 保持 conceptually distinct，但 LuckyToken 不再需要一条额外的 non-Pi request carrier。Current integration 的 Provider input 已经完整表达为：

```text
Model<Api>
+
Context
+
Options
├── sessionId
└── metadata.projectDir?
+
Provider-lifetime configuration / policy
        │
        ▼
CommandCode Private Provider
```

### Generation Parameters

CommandCode Provider owns conversion of the Pi Provider invocation into CommandCode generation parameters.

Architecture 只冻结 conversion ownership：

Model<Api>
+
Context
+
Provider-facing Options
        │
        ▼
CommandCode Private Provider
        │
        ▼
CommandCode generation parameters

Exact field mappings、precedence、validation、normalization 与 fallback rules 属于 Pi ↔ CommandCode Conversion Specification。

这包括：

- `max_tokens`
- `stream`
- `reasoning_effort`
- `temperature`
- 以及其他 generation controls

Core Architecture 不规定某个 wire parameter 具体由 `Model`、`Context`、`Options`、Provider policy 或它们的组合如何导出，除非这种 source relationship 本身是解释 architecture ownership 所必需的。

Field-level source selection is a conversion concern, not an architecture ownership concern.

### Runtime / Project Context

Current runtime/project source 已关闭：

```text
Options.sessionId
        └── threadId

Options.metadata.projectDir?
        ├── project-bound config source
        └── x-project-slug source

Provider policy/configuration
        ├── memory / taste / skills current compatibility values
        └── permissionMode

Project Snapshot capability
        └── request-time project/runtime snapshot
            ├── date
            ├── filesystem view
            └── Git-derived state
```

这些 facts 不进入 Pi conversational `Context`。

Exact `CommandCodeRequest` schema 属于 CommandCode Private Protocol Spec；exact Pi ↔ CommandCode mapping 属于 Conversion Spec。

---

## 9.2 Runtime / Project Facts

### `config`

`config` 是 request-time project/runtime snapshot。Current source-backed compatibility producer establishes two project-context modes：

```text
Options.metadata.projectDir exists
        ↓
project-bound
        ↓
Provider uses projectDir as project root
        ↓
request-time filesystem / Git snapshot

Options.metadata.projectDir absent
        ↓
project-less
        ↓
current compatibility producer project-less config
        ↓
no filesystem/Git scan
```

因此 authoritative project source 是：

```text
Auth
  ↓
projectDir?
  ↓
Options.metadata.projectDir?
  ↓
CommandCode Private Provider
```

Provider owns project snapshot derivation because only the Provider understands the CommandCode `config` representation and compatibility behavior. Exact field-generation rules，例如 top-level structure filtering、Git commands、UTC date formatting 与 project-less empty values，继续由 CommandCode Protocol / Provider implementation specification owns，而不是复制成 Generic Core rules。

如果 `projectDir` 已存在但 Provider 无法完成 required project inspection/request construction，该 request 必须失败；不能 silent downgrade 成 project-less request，因为那会改变已经建立的 request fact。Since failure occurs after `Models.streamSimple(...)` enters Pi execution, it is surfaced through the Pi error lifecycle.

`config` 的存在不支持新建：

```text
ProjectManager
WorkspaceManager
GitService
CodingAgentRuntime
```

ordinary Provider-local functions are sufficient.

### `memory`, `taste`, `skills`

These are CommandCode-specific request fields owned by the CommandCode Private Provider boundary.

Their exact current values, non-null semantics, defaulting rules, and compatibility behavior belong to the CommandCode Private Protocol and the Pi ↔ CommandCode Conversion Specification.

Their presence does not justify LuckyToken-wide memory, taste, or skills semantic models.

### `permissionMode`

`permissionMode` is owned by narrow CommandCode Provider policy/configuration.

Its exact wire value, defaulting behavior, supported value space, and compatibility mapping belong to the CommandCode Private Protocol and Pi ↔ CommandCode Conversion Specification.

Its presence does not justify a LuckyToken-wide permission subsystem.

---

## 9.3 Thread and Project Identity

### Thread Identity

Current source-backed CommandCode producer policy已经证明：

```text
valid client session identity
→ use that identity

otherwise
→ use Router request ID
```

并保持 invariant：

```text
body.threadId
=
header.x-session-id
```

LuckyToken 将 client/session source normalization 封装在 Auth 中。Auth 成功时始终产生一个 normalized：

```text
sessionId: string
```

信息流被冻结为：

```text
inbound headers
        ↓
      Auth
        ↓
normalized sessionId
        ↓
Options.sessionId
        ↓
CommandCode Private Provider
        ├── body.threadId
        └── header.x-session-id
```

Cross-request continuity 只来自 client 重复提供同一个 recognized session identity。没有 usable client session 时，fallback ID 只属于该 inbound request。Architecture 不要求特定 UUID version；Current CommandCode-compatible implementation 可以使用 UUID v4 以匹配 source-backed Router producer behavior。

Client Protocol conversion 不创建 thread identity；它也不知道 header aliases。

### Project Identity

Auth 对外不暴露 token classification，只输出 optional：

```text
projectDir?
```

`composeOptions(...)` 将它投影到：

```text
Options.metadata.projectDir?
```

CommandCode Private Provider 从同一个 projectDir 同时 derive：

```text
projectDir
├── project-bound config snapshot
└── x-project-slug
```

没有 `projectDir` 时：

```text
project-less config
+
omit x-project-slug
```

`x-project-slug` 仍然只在 Provider transport boundary 创建。Exact `project_root_to_cc_slug(...)` algorithm 是 CommandCode Protocol / Provider conversion detail，不在 Generic Core 中传播。

这里不保留第二个长期 authoritative `projectSlug` fact：

```text
projectDir
= request-local authoritative project fact

x-project-slug
= late Provider wire representation
```

Other Providers 可以看到 `Options.metadata.projectDir`，但它们没有义务理解或使用它。

---

## 9.4 Request Construction

CommandCode Private Provider owns final construction：

```text
CommandCodeRequest
+
Private Protocol transport headers
```

完整 input ownership：

```text
                    CommandCode Private Provider

Pi Model ────────────────────────────────┐
Pi Context ──────────────────────────────┤
Pi Options                               │
├── sessionId ───────────────────────────┤
└── metadata.projectDir? ────────────────┤
Provider auth/config/policy ─────────────┤
Project Snapshot capability ──────────────┤
Trace Context generation capability ──────┤
                                        ▼
                               CommandCodeRequest
                                        │
                                        ├── threadId
                                        ├── config
                                        ├── memory/taste/skills
                                        ├── permissionMode
                                        └── params
                                        │
                                        ▼
                              Provider-owned headers
                                        │
                                        ├── x-session-id
                                        ├── x-project-slug?
                                        ├── traceparent
                                        └── other Private headers
                                        │
                                        ▼
                              POST /alpha/generate
```

CommandCode-specific representations，例如：

```text
threadId
x-session-id
x-project-slug
config wire object
traceparent
Private version/client headers
```

全部在 Provider boundary late-create。

Upstream CommandCode API credential 仍由 Pi Provider authentication path 解决，与 inbound LuckyToken Auth credential 完全分离。

Provider request object 是 temporary transport state，不是 new LuckyToken canonical request。

Exact mapping of Pi messages、tools、system、model and generation controls—including field precedence、validation、normalization、fallback behavior and compatibility policy—belongs to the Pi ↔ CommandCode Conversion Specification.

Core Architecture owns the conversion boundary; it does not duplicate field-level conversion rules.

---

## 9.5 Stream Lifecycle

CommandCode Private Provider 把 upstream event stream 转成 Pi：

```text
AssistantMessageEventStream
```

Private Protocol 有 explicit semantic terminals：

```text
finish
→ semantic success

error
→ semantic failure
```

因此 successful Pi completion 必须建立在 valid upstream：

```text
finish
```

之上。

Transport sentinel：

```text
[DONE]
```

不是 semantic success。

关系：

```text
finish
    │
    ▼
semantic success established

[DONE]
    │
    ▼
transport framing only
```

因此：

```text
[DONE] before finish/error
→ incomplete Private lifecycle
→ Provider emits Pi error terminal
```

以及：

```text
EOF before finish/error
→ incomplete Private lifecycle
→ Provider emits Pi error terminal
```

这里正是 Chapter 8 定义的 Provider incomplete-upstream responsibility 的 concrete instance。

CommandCode Provider 可以直接观察 Private upstream EOF，所以不能 silent-end Pi stream。

正确 path：

```text
Private EOF without finish/error
        │
        ▼
CommandCode Private Provider
recognizes incomplete protocol lifecycle
        │
        ▼
Pi error terminal
        │
        ▼
Execution failure: error
```

Provider 不从 transport end synthesize `done`。

### Known Malformed vs Unknown Event

以下情况是 protocol failure：

```text
known event type
+
missing / invalid required fields
```

以下情况是 forward-compatibility condition：

```text
unknown future event type
```

Unknown event 在 semantics 未知时不能擅自：

```text
append text
append reasoning
complete tool
modify usage
establish success
establish failure
```

Exact handling 属于 Private Protocol / Conversion Specs。

### Text vs Reasoning

Private Protocol 区分：

```text
text
```

和：

```text
reasoning
```

为不同 content lifecycle。

Provider 转 Pi 时必须保留 semantic distinction。

Exact event-to-Pi mapping 属于 Conversion Spec。

---

## 9.6 Tool Lifecycle

CommandCode Private tool streaming 有两个不同 semantic stages：

```text
Incremental Tool Input
        │
        ├── tool-input-start
        ├── tool-input-delta*
        └── tool-input-end
        │
        ▼
temporary state only


Completed Invocation
        │
        └── tool-call
        │
        ▼
authoritative completed tool state
```

核心 invariant：

> **`tool-input-end` does not establish a completed Pi `ToolCall`.**

Incremental lifecycle 只建立某个 tool identity 的 partial serialized input boundary。

真正 authoritative completed invocation 来自后续：

```text
tool-call
```

它提供：

```text
toolCallId
toolName
input
```

### Keyed Temporary State

Tool input events 有 explicit identity，而且不同 tool 可以 interleave：

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

所以 temporary state 必须是：

```text
keyed
request-local
interleaving-safe
```

概念上：

```text
temporary tool state
├── tool A
├── tool B
└── ...
```

`Map<toolId, ToolInputState>` 是一个可能 implementation，不是 architecture requirement。

单个：

```text
currentTool buffer
```

不够正确。

### Authoritative Completion

`tool-call` arrival 后：

```text
tool-call
├── toolCallId
├── toolName
└── input
```

这些 completed structured fields 是 authoritative。

Incremental JSON reconstruction 不覆盖：

```text
tool-call.input
```

Incremental state 可以用于：

```text
lifecycle validation
partial stream bookkeeping
```

但不会成为第二个 authoritative completed invocation。

### Pi Representability

Adjacent contracts 有真实 representation mismatch：

```text
CommandCode Private
completed tool-call.input
=
arbitrary JSON
```

而 Pi：

```text
ToolCall.arguments
=
object-shaped arguments
```

因此 completed Private tool input 必须做 representability check：

```text
completed Private input
        │
        ├── object-shaped / Pi-representable
        │      ↓
        │  completed Pi ToolCall
        │
        └── non-object / not representable
               ↓
         conversion failure
```

Provider 不能通过以下方式 repair：

```text
wrap primitive in invented object
guess from partial JSON
substitute reconstructed incremental input
discard mismatch
```

Exact conversion failure representation 属于 Conversion Spec。

Temporary keyed state 的 death point：

```text
authoritative tool-call
or
request terminal
```

---

## 9.7 State Lifetime and Specification Boundary

Chapter 8 已定义 generic Provider lifetime split。

CommandCode Private request scope includes：

```text
Invocation Facts
├── sessionId
└── projectDir?

Provider-Owned Temporary State
├── request-time project snapshot
├── CommandCodeRequest representation
├── Provider-owned outbound headers / trace context
├── transport / parser state
├── text / reasoning partial state
├── keyed tool-input state
├── usage accumulation
└── terminal state
```

`sessionId` 与 `projectDir?` 只是 Provider operation scope 中可见的 invocation facts。

它们由上游 boundary 建立，Provider 是 semantic consumer；Provider 暂时持有这些值，不会因此取得它们的 semantic ownership。

即：

```text
in scope
≠
owned state
```

这些 incomplete state 不共享到另一 request。

在以下任何 terminal/outcome：

```text
finish
error
abort
incomplete upstream failure
```

request-local state 结束 lifecycle。

重要 death points：

| Information | Architectural death point |
| --- | --- |
| Auth session-header/token parsing state | AuthResult established |
| `projectDir?` / `sessionId` source representation | composed Pi `Options` established |
| runtime/project snapshot | upstream request no longer needs it |
| `threadId` / `x-session-id` / `x-project-slug` | Provider wire mapping no longer needs them |
| `CommandCodeRequest` | transport no longer needs it |
| raw Private event | converted into Provider-local or Pi state |
| text/reasoning partial state | content completion or request terminal |
| keyed tool-input state | authoritative `tool-call` or request terminal |
| usage/finish accumulation | final Pi terminal produced |
| parser/transport state | request terminal |

这些是 ownership boundary，不要求 explicit memory erasure。

### Specification Ownership

三层 spec 保持分离：

```text
CommandCode Private Protocol Spec
├── exact request schema
├── exact headers / wire structures
├── exact event types
├── producer-policy evidence
└── Private Protocol lifecycle

CommandCode Private ↔ Pi Conversion Spec
├── exact field mappings
├── message/content mappings
├── finishReason → Pi StopReason
├── usage mapping
├── event → Pi event mapping
└── representability failures

Architecture Spec — this chapter
├── ownership
├── authoritative input sources / carriers
├── integration boundaries
├── information hierarchy
├── authoritative completion
└── information lifetime
```

Current Architecture 已经关闭：

```text
runtime/project source
logical thread source/lifetime/carrier
project fact carrier
```

仍未冻结的 exact details，例如：

```text
finishReason → Pi StopReason exact table
usage exact mapping
exact message/content field mapping
future non-null memory/taste/skills product semantics
future permission-mode product semantics
```

分别属于 Conversion Spec 或 future product requirement，不是 Architecture blocker。

完整 integration：

```text
                  inbound headers
                       │
                       ▼
                      Auth
               ┌───────┴────────┐
               ▼                ▼
          sessionId         projectDir?
               │                │
               ▼                ▼
       Options.sessionId   Options.metadata.projectDir?
               │                │
               └───────┬────────┘
                       │
Model + Context + Options
                       │
                       ▼
          CommandCode Private Provider
                       │
          ┌────────────┴────────────┐
          │                         │
   Pi generation mapping    runtime/project derivation
          │                         │
          └────────────┬────────────┘
                       ▼
             CommandCodeRequest
                       │
                       ▼
              POST /alpha/generate
                       │
                       ▼
            Private event lifecycle
                       │
          ┌────────────┴────────────┐
          │                         │
     content state              tool state
          │                         │
          └────────────┬────────────┘
                       ▼
           finish / error / incomplete
                       │
                       ▼
          AssistantMessageEventStream
```

本章只定义 CommandCode Private integration 相对于 Generic Core 的 architecture delta。

删除这个 concrete integration 不应该要求修改 Generic Core 的 Client/Pi/Provider boundaries；`metadata.projectDir` 作为 request metadata fact 可以被其他 Provider忽略。

# 10. Resolved Integration Decision Index — 已关闭决策索引

> **本章不是第二套 normative contract。**
>
> Authoritative architecture definitions remain in the owning chapters below. 本章只提供 resolved-decision index 与 reopen rule，避免同一事实在多个章节重复维护。

Current source basis 包括新的 CommandCode `/alpha/generate` source-backed protocol document、current Pi `ModelsSimpleStreamOptions` contract，以及 LuckyToken 已冻结的 Auth boundary。

| Resolved decision | Authoritative architecture section |
| --- | --- |
| LuckyToken Auth 固定 input/output、业务隐藏、session/project normalization ownership | §6.3 |
| `sessionId` / `projectDir?` 如何进入 Pi invocation | §6.4 |
| CommandCode runtime/project facts 的 Provider ownership | §9.2 |
| `Options.sessionId → threadId / x-session-id` 与 `metadata.projectDir? → project-derived wire state` | §9.3 |
| CommandCode request construction ownership | §9.4 |
| CommandCode stream / terminal lifecycle ownership | §9.5 |
| CommandCode keyed partial tool state 与 authoritative completion | §9.6 |
| Generic cancellation precedence 与 success commit | §7.3–§7.5 |

Resolved facts 的当前 shape 可以导航性地概括为：

```text
inbound headers
        │
        ▼
      Auth
        │
        ├── authorized?
        ├── sessionId
        └── projectDir?
                │
                ▼
      composeOptions(...)
                │
                ├── Options.sessionId
                └── Options.metadata.projectDir?
                │
                ▼
              Models
                │
                ▼
             Provider
```

对于 CommandCode Private：

```text
Options.sessionId
        ↓
CommandCode Provider
├── body.threadId
└── header.x-session-id

Options.metadata.projectDir?
        ↓
CommandCode Provider
├── project-bound request state when present
└── project-less request state when absent
```

Exact header-source registry、fallback-ID generator、`project_root_to_cc_slug(...)`、`config` field algorithms、model routing、finish-reason conversion、usage conversion、message/tool field mapping 仍属于 Auth implementation / Protocol / Conversion Specs，而不是本章新增的 architecture truth。

## 10.1 Reopen Rule

Once v5.5 is frozen, architecture contract 只在新的 evidence 或 demonstrated requirement 证明现有 boundary 不再正确时重开，例如：

```text
Pi sessionId no longer expresses the required logical session semantics
project identity cannot be carried as projectDir and derived safely by Provider
Pi metadata no longer provides the required Provider-visible request carrier
current Auth fixed output cannot express a demonstrated request-edge fact
request cancellation cannot be made correct within current Execution boundary
a new capability changes the atomic downstream commit model
```

以下变化本身不重新打开 Architecture：

```text
adding/changing recognized session header aliases
changing request-local fallback UUID version
exact CommandCode wire field mapping
model routing changes
usage conversion changes
finish-reason conversion changes
future memory / taste / skills semantics
Provider-private implementation refactoring
Conversion Spec refinement
```

---

# 11. 架构地图 — Architecture Map

> **Concept Primer — 本章是导航，不增加新的 architecture truth**
>
> - **Module Closure View**：从 node 角度回答“这个 module 凭什么运行”。
> - **Fact Flow View**：从 edge 角度回答“这个 fact 为什么穿过系统”。
> - **Transparent Transit**：一个 module/operation 携带 fact，但不理解该 fact 的业务语义。
> - **Composition Root**：startup wiring responsibility；负责建立和绑定 runtime objects，不负责业务 semantics。
> - **Architecture Map**：把前面章节定义的 runtime、request DAG、module closure 与 information closure 汇总。
>
> 本章只总结前面已经建立的 contracts。

---

## 11.1 Runtime Composition

LuckyToken 有两个主要 lifetime：

```text
LuckyToken
├── Long-Lived Runtime
└── Request-Local Lifecycle
```

### Composition Root

```text
Deployment / Router Configuration
                │
                ▼
        Startup Composition Root
                │
        ├── Client Protocol implementations
        │   └── bind one Auth authority per handler
        ├── Providers
        │
        ├── optional Pi customizations
        │   ├── CredentialStore?
        │   ├── ModelsStore?
        │   └── AuthContext?
        │
        ├── createModels(optional customizations)
        │        │
        │        ▼
        │      Models
        │        ▲
        │        │ setProvider(...)
        │        └──────── Providers
        │
        ├── Router policy/defaults
        └── HTTP runtime
```

如果 Pi customizations 没有提供，Pi 使用自己的 default stores/context。

因此：

```text
CredentialStore
ModelsStore
AuthContext
```

不是 LuckyToken composition root 永远必须显式 construction 的 sibling modules。

Provider 也通过 Pi registration operation：

```text
models.setProvider(provider)
```

进入 `Models` provider collection，而不是 `createModels()` 的 required constructor dependency。

Normal request 依赖已经 constructed/bound 的 runtime objects，不依赖 startup parsing state，也不通过 service locator 重新发现 dependency。

两个 auth concern 保持分离：

```text
LuckyToken Auth
→ inbound client authorization / session-project fact normalization

Pi Models / Provider auth
→ LuckyToken-to-upstream credential resolution and request preparation
```

---

## 11.2 Request Dependency DAG

```text
                          Models
                            │
selector ───────────────► resolveModel
                            │
                            ▼
                         Model<Api>
                            │
validated Client state ─────┤
                            ▼
                     Client → Pi
                       │          │
                       ▼          ▼
                    Context    controls


Auth(headers)
├── sessionId
└── projectDir?

HTTP Boundary
└── AbortSignal

Router Policy
└── defaults


controls ───────────────┐
sessionId ──────────────┤
projectDir? ────────────┤
AbortSignal ────────────┤
defaults ───────────────┘
          │
          ▼
    composeOptions(...)
          │
          ▼
ModelsSimpleStreamOptions


Models ───────────────┐
Model ────────────────┤
Context ──────────────┤
Options ──────────────┘
          │
          ▼
        Execution
          │
          ▼
AssistantMessage | failure


renderState ──────────┐
result / failure ─────┘
          │
          ▼
   Client Protocol Renderer
          │
          ▼
     HTTP Boundary
          │
          ▼
       Client Wire
```

Request 的 authoritative Pi invocation 是：

```text
Model<Api>
+
Context
+
ModelsSimpleStreamOptions
```

没有额外 LuckyToken-wide：

```text
CanonicalRequest
ExecutionPlan
UniversalContext
ProviderExecutionContext
GlobalErrorIR
```

`composeOptions(...)` 只构造 Pi `Options`，不拥有或重新包装 `Model` / `Context`。

---

## 11.3 Module / Operation Contract Map

v5.5 正式区分 module-level contract 与 operation-level contract。

### LuckyToken-Owned Module Contract

```text
Module
├── Responsibility
├── Bound Dependencies
├── Owned State
├── Operations
└── Must Not Access
```

Summary：

| Module | Bound Dependencies | Important Owned State | Main Operations | Must Not Access |
| --- | --- | --- | --- | --- |
| **HTTP Boundary** | HTTP runtime; route/protocol policy | request transport lifecycle state while active; no separate long-lived state required | `route/read`; `emit` | conversational semantics; Provider wire |
| **Client Protocol** | protocol-specific stable policy/config if needed | protocol-owned mutable runtime state only if any | `parse`; `convertToPi`; `render` | Provider credentials/wire; filesystem; HTTP connection internals |
| **Auth** | auth policy/config; credential/project lookup capability; session-resolution policy; fallback identity capability | Auth-owned mutable lookup/index/cache state only if any | `resolve(headers)` | Model; Context; Pi Options; Provider wire |
| **LuckyToken-owned concrete Provider** | stable integration config; compatibility policy; direct integration capabilities | provider-owned mutable catalog/cache/runtime state only if any | `stream`; `streamSimple`; optional refresh/deferred operations | inbound Auth; Client wire; generic whole-request object |
| **CommandCode Private Provider** | endpoint/config; compatibility policy; Project Snapshot; Trace Context generation; direct transport capability where needed | provider-owned mutable runtime state only if any | `streamSimple` | raw client headers; Client Protocol; HTTP response object |

Bound configuration/policy may be retained by a module but is not repeated under `Owned State`.

### Standalone Operation Contract

```text
Operation
├── Responsibility
├── Bound Dependencies
├── Inputs
├── Result
├── Effects
├── Temporary State
└── Must Not Access
```

Summary：

| Operation | Bound Dependencies | Inputs | Result | Effects |
| --- | --- | --- | --- | --- |
| **Model Resolution** | Models | external selector | `Model<Api>` or failure | none required |
| **`composeOptions`** | Router defaults/policy when bound | protocol controls; sessionId; projectDir?; AbortSignal | `ModelsSimpleStreamOptions` | none |
| **`execute`** | Models | Model + Context + Options | committed success or aborted/error failure | consume Pi stream; commit one atomic outcome |



### External Pi Runtime View

LuckyToken uses Pi's public runtime contracts rather than redefining them:

```text
Pi Runtime
├── Models
└── Provider contract

createModels(optional CredentialStore / ModelsStore / AuthContext)
        │
        ▼
      Models
        ▲
        │
 setProvider(provider)
```

and exposes multiple operations：

```text
provider registration
model lookup/refresh
auth/login/logout
stream/complete
deferred operations
```

LuckyToken Core's primary inference dependency is `Models.streamSimple(...)`, but that does not collapse the entire Pi `Models` API into one operation。

Pi built-in Provider implementations remain Pi-owned.

A LuckyToken-specific Provider, such as the CommandCode Private Provider, implements the same Pi Provider contract, while its own implementation dependency closure is LuckyToken-owned.

## 11.4 Fact Flow Contract Map

只列真正跨 boundary、容易产生 ownership confusion 的重要 facts。

| Fact | Producer / Owner | Carrier | Semantic Consumers | Transparent Transit | Death Point |
| --- | --- | --- | --- | --- | --- |
| **model-resolution selector** | Client Protocol | direct orchestration value | Model Resolution | request orchestration | `Model<Api>` established |
| **protocol-visible model echo fact**, if required | Client Protocol parse | protocol-owned `renderState` | same Client Protocol renderer | request orchestration | rendering completes |
| **`Model<Api>`** | Model Resolution | direct argument | Client model-aware conversion; **Pi Models**; Provider | request orchestration; Execution | Pi invocation terminal |
| **`Context`** | Client Protocol conversion | Pi `Context` direct argument | concrete Provider/API conversion | request orchestration; Execution; Models | Pi invocation terminal |
| **`sessionId`** | Auth | `Options.sessionId` | session-aware Provider | `composeOptions`; Models | Provider no longer requires logical request identity |
| **`projectDir`** | Auth | `Options.metadata.projectDir` | CommandCode Private Provider | `composeOptions`; Models | Provider derives request-local CommandCode project representation |
| **`AbortSignal`** | HTTP Boundary | `Options.signal` | Execution; Pi Models auth/setup; Provider/transport | `composeOptions` | request execution/cancellation lifecycle ends |
| **protocol render state** | Client Protocol | orchestration-local narrow state | same Client Protocol renderer | request orchestration | success/failure rendering completes |
| **committed successful AssistantMessage** | Execution success commit | direct result | Client Protocol renderer | request orchestration | rendering completes |

`Provider auth material` 不作为单一 Fact Flow row。

Current Pi `applyAuth()` 形成的是多个有不同 producer/precedence 的 effective fields：

```text
apiKey
headers
env
requestModel.baseUrl
```

它们不能被错误合并成一个拥有单一 producer 的 semantic fact。

Chapter 4 对 Pi Models request preparation 的描述已经足够；Fact Flow Map 保持小而准确。

### Per-field consumer invariant

本表不把：

```text
protocol invocation controls
Provider auth material
```

作为单一 semantic facts，因为它们都只是多个字段的集合。

每个 field 必须分别判断：

```text
producer
precedence
semantic consumer
carrier
lifetime
```

`Options` 是 container，不是一个单一 semantic fact。

例如：

```text
Options.signal
→ Models is semantic consumer

Options.metadata.projectDir
→ Models is transparent transit
```

`Model<Api>` 同样是 structured carrier，但在 architecture-level map 中可以整体标记 `Models` 为 semantic consumer，因为 current Pi runtime 明确读取其中的 runtime-relevant fields：

```text
model.provider
model.headers
effective baseUrl path
```

这不表示 Models 理解所有 model capability semantics。

同样：

```text
Context passes through Execution
```

不表示 Execution 理解 messages/tools semantics。

### Selector representation lifetime

Client Protocol 可能同时需要：

```text
model-resolution selector
```

以及 response contract 要求的：

```text
protocol-visible model echo fact
```

二者不能被当成同一个 representation 跨越不同 death point。

正确 lifecycle：

```text
source model field
        │
        ├── resolution representation
        │      └── dies when Model<Api> is established
        │
        └── if response must echo source representation
               ↓
             copy minimal echo fact into renderState
               ↓
             dies after rendering
```

因此不存在“同一个 selector 已死亡却又在 response 中复活”的 representation ambiguity。

## 11.5 Failure and Cancellation Summary

Failure lifecycle 保持既有 contract：

```text
Request
│
├── Before Pi execution
│   ├── Client Protocol failure
│   ├── Auth denial
│   ├── model resolution failure
│   ├── representability failure
│   └── options composition failure
│       └── owned by detecting boundary
│
└── After Pi execution begins
    ├── request AbortSignal before success commit
    │      └── aborted
    │
    └── Pi error terminal
           ├── aborted
           └── error
```

Pi execution begins when LuckyToken invokes:

```text
Models.streamSimple(...)
```

and adopts the returned `AssistantMessageEventStream` as Pi completion channel.

Cancellation precedence remains：

```text
request signal aborted before success commit
→ aborted
```

A supported successful commit requires：

```text
Pi done(stop | length | toolUse)
+
request signal not aborted at commit point
```

After semantic success commit，later disconnect affects delivery only。

Atomic downstream semantics remain unchanged：

```text
Pi intermediate events
→ consumed request-locally

successful commit
→ complete AssistantMessage
→ Client renderer
```

Current Core 不 live-forward upstream/Pi deltas to downstream Client wire。

---

## 11.6 Concrete CommandCode Private Extension

```text
                    Pi Invocation
                         │
         ┌───────────────┴────────────────┐
         │                                │
         ▼                                ▼
   Model + Context                     Options
                                  ├── sessionId
                                  └── metadata.projectDir?
         │                                │
         └───────────────┬────────────────┘
                         ▼
             CommandCode Private Provider
                         │
             Bound Dependencies:
          Project Snapshot capability
       Trace Context generation capability
                         │
                         ▼
                POST /alpha/generate
                         │
                         ▼
              Private event lifecycle
                         │
           ┌─────────────┴──────────────┐
           │                            │
    finish / error            incomplete upstream end
           │                            │
           ▼                            ▼
       Pi terminal                  Pi error terminal
           │                            │
           └─────────────┬──────────────┘
                         ▼
             AssistantMessageEventStream
                         │
                         ▼
             Generic Execution rules
```

CommandCode Private vocabulary 不进入 Generic Core。

`projectDir` 的 flow 是：

```text
Auth establishes projectDir
        │
        ▼
Options.metadata.projectDir
        │
        │ transparent through Models
        ▼
CommandCode Private Provider
        │
        ▼
request-local CommandCode project representation
```

只有 Auth 与 CommandCode Provider 理解这个 fact 的 project semantics。

---

## 11.7 Specification Map

LuckyToken 保持三种 specification responsibility 分离：

| Spec | 回答的问题 |
| --- | --- |
| **Protocol Spec** | wire/semantic representation 是什么？valid/malformed state 与 event lifecycle 是什么？ |
| **Conversion Spec** | 两个 adjacent representations 如何 exact mapping？什么 representable / unsupported？ |
| **Architecture Spec** | 谁 owns representation？module 如何闭合 dependencies？fact 如何流动、谁理解、何时死亡？ |

关系：

```text
Protocol A Spec                 Protocol B / Pi Spec
      │                                  │
      └─────────────┐      ┌─────────────┘
                    ▼      ▼
                 Conversion Spec
                       │
                       │ implemented at
                       ▼
               an Architecture-owned boundary
```

v5.5 的 dependency-semantics corrections 不把 conversion rules 搬进 Architecture。

---

### v5.6 Frozen Status

```text
LuckyToken Core Architecture v5.6
        │
        ├── Existing information/data flow
        │      ├── Client ↔ Pi boundary                 preserved
        │      ├── Pi ↔ Provider boundary               preserved
        │      ├── Auth input/output                     preserved
        │      ├── cancellation precedence               preserved
        │      ├── atomic downstream commit              preserved
        │      └── CommandCode ownership/carriers        preserved
        │
        ├── Dependency semantics remain explicit and corrected
        │      ├── Module Contract vs Operation Contract
        │      ├── direct Bound Dependencies
        │      ├── Owned State authority distinction
        │      ├── external Pi Models runtime view
        │      ├── Composition Root visibility
        │      ├── no undeclared ambient dependencies
        │      ├── Fact Flow Contract
        │      ├── Transparent Transit
        │      └── per-field Semantic Consumer
        │
        └── Per-Client-Protocol Auth isolation now explicit
               ├── method/path selects Client Protocol handler
               ├── one independently bound Auth authority per handler
               ├── Auth-owned persistence hidden behind startup snapshot
               ├── no protocol ID/pathname in generic Auth
               └── only sessionId/projectDir? survive authorization
```

v5.5 保留的 assumption correction：

```text
Previous:
ownership + representation lifecycle were assumed
sufficient to expose complete module requirements.

Finding:
invocation data can be explicit while bound runtime
capabilities remain implicit.

Correction:
make module dependency closure and fact-flow semantics
explicit architecture contracts.

Required runtime behavior change:
none inherently.

Architecture strengthening:
hidden dependencies are no longer valid by contract.
```

v5.6 新增的 assumption correction：

```text
Previous:
one long-lived Auth sibling was sufficient in composition maps.

Finding:
multiple independent Client Protocols require independently bound
authorization authorities without passing protocol identity through Auth.

Correction:
route to a handler first; bind one generic Auth authority to that handler;
end token-file/scope representations before Pi invocation composition.

Required cross-boundary behavior change:
none for Pi or Providers.
```

LuckyToken Core Architecture v5.6 冻结 per-handler Auth isolation，同时保留
v5.5 已冻结的 Generic Core dependency semantics。
