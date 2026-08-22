# LuckyToken 实现架构说明

**文档性质：** 当前实现的维护者地图（implementation architecture map）<br>
**对应代码：** `src/` Backend/Core、`packages/desktop-shell/` Electron Desktop、`packages/` Provider/Control Plane 生产路径，Node.js 22.19+，TypeScript，Pi AI 0.84.2<br>
**源码基线：** commit `e6f56dd`（2026-08-20，Backend InstanceAuthority + Desktop connection lifecycle）<br>
**架构规范：** [LuckyToken Core Architecture Specification](./Spec/LuckyTokenCoreSpec.md)<br>
**Desktop 架构：** [LuckyToken Electron Product Architecture Specification](./Spec/LuckyTokenElectronArchitectureSpec.md)（已实现；Windows packaged lifecycle 已认证，macOS/Linux 仍待真实平台认证）<br>
**设计约束：** [AGENTS.md](../AGENTS.md)

本文回答六个问题：LuckyToken 最终提供什么功能；一次请求如何完成；系统由哪些
模块构成；每个模块的接口、输入、输出和配套文件是什么；模块上下左右连接谁；
当前实现是否遵守高内聚、低耦合与信息生命周期原则。

本文以当前源码为准，不把未来计划写成已经实现的能力。Core Spec 定义规范性
架构，Protocol/Conversion 文档定义协议语义与映射；本文只负责把这些规则对应到
真实代码、真实文件和真实调用链。

文档章节：

1. 项目总功能与边界；
2. 总体模块图与完整流程；
3. Transport 与 Runtime；
4. Credential 与管理安全 authority；
5. Anthropic Messages Client Protocol；
6. Pi Runtime、配置、Composition 与 CLI；
7. CommandCode Private Provider；
8. 持久文件、生成物与公共 API；
9. 全部生产模块索引；
10. 测试、Certification 与真实证据；
11. 对 `AGENTS.md` 的符合性审计；
12. 正确扩展方式；
13. 推荐阅读顺序。

## 零基础读者怎么使用本文

如果你没有编程经验，不需要先理解代码框中的英文。每章新增的“**小白导读**”和
“**小白理解**”是另一条独立阅读路线：先看生活类比，再看简图，最后只在需要核对
细节时阅读原有开发者内容。

先记住几个常用词：

| 术语 | 小白解释 |
| --- | --- |
| Agent | 你实际使用的 AI 软件，例如能写代码、聊天或调用工具的客户端 |
| API / endpoint | 软件之间约定好的“服务窗口”和地址；本项目当前窗口是 `/v1/messages` |
| Protocol | 双方说话必须遵守的格式和规则，类似表格模板或交通规则 |
| Token（本地认证） | Agent 进入 LuckyToken 的门票，不是模型输出消耗的 token 数量 |
| Provider | 真正连接外部模型服务的适配模块，类似负责向特定供应商下单的采购员 |
| Runtime | 请求正在处理时负责调度和控制生命周期的运行部分 |
| Pi / IR | 左右双方都能理解的中间语义，类似翻译工作中的“标准中间稿” |
| Stream | 内容分多段到达；本项目会先完整确认上游结果，再生成客户端 SSE |
| Composition | 程序启动时把各模块连接起来，类似开店前安排柜台、员工和钥匙 |

```mermaid
flowchart LR
    You["你"] --> Agent["AI Agent"]
    Agent --> LT["LuckyToken 本地服务"]
    LT --> Model["外部模型服务"]
    Model --> LT
    LT --> Agent
    Agent --> You
```

---

# 1. 项目总功能与边界

## 1.0 小白导读：LuckyToken 是什么

可以把 LuckyToken 想成一家“翻译兼转运服务”。Agent 按 Anthropic 或 OpenAI
Responses 格式下单，而当前外部模型服务使用 CommandCode 的格式。LuckyToken 不替模型思考，
只负责验票、翻译、转交、确认结果完整，再按 Agent 能理解的格式送回来。

```mermaid
flowchart LR
    A["Agent<br/>说 Anthropic 格式"] --> B["LuckyToken<br/>验票与翻译"]
    B --> C["Pi 标准中间语义"]
    C --> D["CommandCode 适配员"]
    D --> E["真实模型服务"]
    E --> D --> C --> B --> A
```

读完本章只需要判断两件事：项目今天确实能做什么，以及哪些能力只是未来可能增加，
不能因为架构图中出现名称就误认为已经实现。

## 1.1 当前对外功能

LuckyToken 当前是一个本地模型协议桥接服务。它在 loopback TCP 上提供 Anthropic
Messages 与 OpenAI Responses endpoints，让 Claude Code、Codex CLI 等 Agent 使用
本地 Data Plane 固定为 loopback，不需要 LuckyToken 自己的 per-protocol client token。
每个请求先按明确 contract 选择 Local Native、Provider Native 或 Semantic Conversion lane；
只有 Semantic Conversion 把 Client semantics 转成 Pi AI runtime contract，再由注册到 Pi
`Models` 的 Provider 调用真实上游并渲染回 Client Protocol。`GET /v1/models` 提供当前
published model discovery。

> **小白理解：** Agent 连接的是你电脑上的本地地址，但真正回答问题的是远端模型。
> LuckyToken 像中间服务台：Agent 不需要知道远端供应商的专用格式，远端供应商也不
> 需要知道客户端使用的是哪种 Agent。

当前完整路径是：

```text
Claude Code / Codex CLI
  POST /v1/messages or POST /v1/responses
        │
        ▼
Node HTTP adapter
        │ WHATWG Request / Response
        ▼
Runtime route/profile selection
        │
        ├── Local Native Preservation ───────→ compatible local upstream
        │
        ├── Provider Native Preservation ────→ provider-native upstream
        │
        └── Semantic Conversion
              │ selected Client Protocol handler
              │ Model + Context + ModelsSimpleStreamOptions
              ▼
           Pi Models / Pi AI IR
              │ Pi Provider contract
              ▼
           CommandCode Private / other Pi Provider
              │
              ▼
           Provider Wire upstream
```

反向结果路径是：

```text
CommandCode JSONL events
        │
        ▼
CommandCode content assembler / semantic converter
        │ AssistantMessageEventStream
        ▼
Pi execution consumer
        │ committed AssistantMessage
        ▼
selected Client Protocol renderer
        │ JSON or Atomic SSE bytes
        ▼
WHATWG Response → Node ServerResponse → Agent
```

当前已经实现的产品操作包括：

- 启动本地 Anthropic `/v1/messages`、OpenAI Responses `/v1/responses` 与
  model discovery `/v1/models` routes；
- Data Plane 固定为 loopback-only，不维护 LuckyToken global/project client-token；
- Codex Local Native 请求只接受与当前 Codex `auth.json` access token 匹配的 request Bearer，并把该 credential 限定在 Local Native lane；
- 通过 Pi `Provider.auth` 接口执行 Provider login/logout，并把 credential 保存到
  Pi-owned `auth.json`；
- CommandCode Private Provider 作为私有 workspace package 从 `node_modules` 加载
  （模型与上游地址由包拥有，配置只需声明 package 根名）；
- 支持 `models.json` 注册用户自定义 Provider（`baseUrl` + `api` + `apiKey` +
  `models`），复用 Pi 内置 api adapter（如 `anthropic-messages`），经同一
  Anthropic endpoint 按 `provider/model_id` selector 访问；
- 支持 Anthropic text、history、thinking replay、tool call/tool result、JSON 与
  Atomic SSE；
- 支持 Responses incremental input、`previous_response_id` 的有界持久化展开、
  Responses JSON/Atomic SSE、Codex tool shapes 与 `store:false` policy；
- 支持 `output_config.effort` → Pi reasoning 映射、`metadata.user_id` 透传、
  `max_tokens=0` 保留；未知 effort 降级为 Pi reasoning default；
- 支持 Claude Code 等真实 Anthropic Agent 接入；recognized fields 按冻结转换方法
  直接转换或显式 omit/degrade，例如 `top_p` 与 thinking budget 进入 Pi，
  `tool_choice` 无 Pi 表示时不伪造控制；
- 支持请求超时、客户端断开、服务关闭、Provider retry 与取消传播；
- Provider 通过受信任的 neutral Pi diagnostic 提供有界 upstream failure facts；
  Execution 把已验证 fact 保存在 `ExecutionFailure.failure`，Anthropic/Responses
  renderer 只据此映射 status、safe message/type/code 与 allowlisted headers；没有
  structured fact 的 execution failure 固定返回 generic 502 `api_error` +
  `Upstream provider failed`，不暴露 Pi `errorMessage`；
- 用 serving certification 和真实在线 conformance 固定当前可服务组合。

## 1.2 当前没有实现的能力

> **小白理解：** 这一节相当于产品包装上的“暂不支持”。它防止我们把“设计上可以
> 扩展”误解为“今天打开软件就能使用”。

下列内容不能从现有架构图误读为已实现：

- TLS、公网暴露、反向代理配置、多租户或管理后台；
- Agent loop、工具实际执行或 TUI；
- `/health` 或除 `/v1/models` 外的其他未认证 endpoint；
- 跨 Client Protocol 共享本地 token；
- Provider Package 自动扫描/安装、热加载或插件市场；
- 把 Client Protocol 请求直接转换为 CommandCode 请求的旁路；
- 在 LuckyToken 中重新实现一套与 Pi 平行的通用 LLM IR。

以后增加新的 Client Protocol 时，应新增独立 route/profile、handler、conversion tests
和 composition binding；如果支持 native preservation，还必须新增明确的 lane eligibility
contract。不得修改 existing Provider 来识别新 Client 术语，也不得重新引入 per-protocol
LuckyToken token file。

## 1.3 第一原则：三条 lane 独立；Pi 只做共享语义转换边界

> **小白理解：** 需要“翻译语言”时才进入 Pi；如果 client/upstream 本来就是兼容
> wire，就保持原始表达直通，不强行翻译。三条路彼此独立，不能为了复用代码把它们
> 合成一个万能 executor。

```text
Local Native Preservation
Provider Native Preservation
Semantic Conversion: Client Wire ↔ Client Protocol ↔ Pi ↔ Provider ↔ Upstream Wire
```

因此：

- Anthropic/OpenAI conversion 模块可以依赖 Pi types，但不能 import、命名或判断 concrete Provider；
- CommandCode Provider 可以依赖 Pi types，但不能 import、命名或判断 Client Protocol；
- Local Native 与 Provider Native 不进入 Pi AI IR，也不共享 credential/transport/executor authority；
- native lane 以 compatible raw Client Wire 为 authority，只做 endpoint、auth、header filtering、identity projection 等 preservation 必要变化；
- `sessionId`、`AbortSignal` 等可以作为窄 infrastructure/request facts，但不会形成第二套通用 request DTO；
- composition root 可以看见各 lane seam 并进行选择/注入，但不做跨侧语义转换；
- lane 一旦开始执行，failure 不得 fallback 到另一个 lane。

这使 Client Protocol、Provider 和 native integration 可以分别扩展，而不把另一侧的
vocabulary 拉进自己的 module。

---

# 2. 总体模块图与完整流程

## 2.0 小白导读：一次请求要经过哪些岗位

LuckyToken 不是一个什么都做的巨大模块，而像一条先分流、再由各 lane 自己完成任务的流水线。HTTP/Runtime 先确定 route/profile 与 eligible lane；只有 Semantic Conversion 才进入 Client Protocol → Pi → Provider 翻译链。

```mermaid
flowchart LR
    Edge["HTTP request edge"] --> Desk["route/profile + lane selection"]
    Desk --> Local["Local Native"]
    Desk --> Native["Provider Native"]
    Desk --> Translator["Semantic Client Protocol"]
    Translator --> Standard["Pi AI IR"]
    Standard --> Buyer["Pi Provider"]
    Local --> Supplier["compatible upstream"]
    Native --> Supplier
    Buyer --> Supplier
```

每个岗位只拿到完成任务必需的信息。例如 request-identity authority 只建立 session identity；Local Native credential 只进入 Local Native transport；Provider credential 只进入 Pi/Provider auth。没有一个通用 Auth/project object 在三条 lane 之间传播。

## 2.1 五组生产模块

> **小白理解：** 表中的五组模块就是五个部门。判断设计是否清晰，可以看一个部门
> 是否偷偷做了另一个部门的工作。例如 HTTP 部门只搬运请求，不应理解工具调用或
> CommandCode 字段。

| 模块组 | 主要目录/文件 | 负责什么 | 明确不负责什么 |
| --- | --- | --- | --- |
| Transport/Runtime | `server.ts`, `runtime.ts`, `http.ts` | TCP、Node/Web 类型适配、route、取消、timeout、response delivery | Anthropic 字段、Pi message、Provider 配置 |
| Credential/security authorities | `credentials/`, `integrations/codex/local-auth.ts`, Application Control Plane capability | Provider credential mutation/status、Codex Local Native request credential、management capability authentication | Client/Provider semantic conversion |
| Anthropic adapter | `protocols/anthropic/` | Anthropic Wire ↔ Pi，Anthropic error/JSON/SSE | CommandCode 协议与 Provider 决策 |
| Pi integration/composition | `pi/`, `composition.ts`, `cli-config.ts`, `cli.ts` | 配置加载、Pi Models、Provider 注册、credential persistence、进程装配 | 两侧协议转换语义 |
| CommandCode Provider Package | `packages/provider-commandcode-private/` | Pi ↔ CommandCode、fixed runtime compatibility config、HTTP attempts、JSONL lifecycle | Anthropic/OpenAI 响应格式与 Core 注册策略 |

上表是 model-serving 语义模块，不包含产品生命周期。当前产品另外有三组 lifecycle 模块：

- `src/application.ts`：Backend Application composition/lifecycle authority；
- `src/instance-authority.ts` + `src/control-plane-discovery.ts`：分别拥有 Backend singleton authority 与 Control Plane discovery publication；
- `packages/desktop-shell/src/main/`：Electron Main 的 `DesktopBackendConnection`、`BackendLauncher`、`ControlPlaneSession` 与 `DesktopOwnerLease`。

这些模块不改变 Client Wire ↔ Pi ↔ Provider 的语义边界；它们只负责进程、管理连接、ownership 与关闭顺序。

静态依赖方向如下。箭头表示“调用或持有”，不是数据在 wire 上的方向：

```mermaid
flowchart LR
    APP["Backend Application"] --> Server["Node HTTP server"]
    APP --> Runtime["LuckyToken Runtime"]
    APP --> AH["Anthropic/Responses handlers"]
    APP --> Identity["Request Identity"]
    APP --> Models["Pi Models"]
    APP --> CCP["CommandCode Provider"]
    APP --> Native["Native lane seams"]

    Server --> Runtime
    Runtime --> AH
    AH --> Identity
    AH --> Models
    Models --> CCP
    Runtime --> Native
    CCP --> Upstream["Provider upstream"]
    Native --> Upstream
    PiAuth["Pi auth.json"] --> Models
```

需要特别注意：图中没有 `Anthropic handler → CommandCode Provider`，也没有
`CommandCode Provider → Anthropic renderer`。二者唯一相遇的位置是 Pi public
contract 和启动期 composition/certification。

## 2.2 进程启动与恢复流程

> **小白理解：** 现在 LuckyToken 有两个长期生命周期：Backend 负责“服务本身活多久”，Electron Main 负责“桌面如何找到、连接并管理这个 Backend”。两边通过 Control Plane discovery/IPC 相遇，但 Desktop 不拥有 Backend 的业务状态。

### Backend lifecycle

生产 Backend 启动先取得 current-user singleton authority，再构造管理能力；Control Plane 真正监听成功之后才发布 discovery descriptor，最后才启动 Data Plane：

```text
startLuckyTokenApplication()
  ↓
InstanceAuthority.acquire()
  └── ~/.luckytoken/instance.sqlite
      BEGIN IMMEDIATE
      connection lifetime == InstanceLease lifetime
  ↓
load/validate config
  ↓
construct Backend-lifetime authorities
  ├── Provider Runtime / credential authority
  ├── Models / Catalog / Public Models
  ├── diagnostics / request ledger / history / backup
  └── settings / Codex integration
  ↓
start Application Control Plane
  ↓
DiscoveryPublication.publish(endpoint)
============================== Management Ready
  ↓
DataPlaneRuntimeSupervisor.start()
============================== Running / Degraded
```

`instance.sqlite` 只是 OS/SQLite lock carrier，文件存在本身没有语义；它不删除、不 heartbeat、不靠 PID 或 stale timeout。`control-plane.json` 只是当前 endpoint/capability 的 discoverability publication，也不代表 Backend 存活。

如果另一个 Backend candidate 无法取得 `InstanceAuthority`，它只会尝试 discovery + Control Plane attach；如果原 owner 在 publication 前退出，candidate 会重新 acquire，而不是依赖 descriptor stale repair。

关闭顺序反向收敛，并保证 `InstanceLease` 最后释放：

```text
stop/drain Data Plane
→ stop timers/subscriptions and restore integration-owned state
→ close DiscoveryPublication
→ close Control Plane
→ dispose/flush Backend-lifetime authorities and stores
→ InstanceLease.close()
```

因此新 Backend 不能在旧 Backend 仍 flush/close shared state 时提前成为 authority。

### Desktop connection lifecycle

Electron Main 不再使用 `BackendSupervisor`。它只启动一个 deep `DesktopBackendConnection`：

```text
DesktopBackendConnection.start()
  ↓
Discovery.read()
  ↓
connect + hello
  ├── usable Backend → attach
  ├── stale desktop build on initial start → acknowledged graceful replace
  └── CLI-owned Backend → preserve + attach
  ↓
DesktopOwnerLease.bind()   # only for a Backend this shell is allowed to own
```

如果没有 usable publication，`BackendLauncher` 只负责 spawn bundled Backend 并提供 `pid + exited` 启动诊断；Management Ready 仍由 discovery + Control Plane 判断。多个 benign spawn attempt 可以同时发生，最终 correctness 由 Backend `InstanceAuthority` 仲裁。

session 丢失后不再循环重试旧 endpoint：

```text
session unavailable
→ discard old endpoint assumption
→ fresh discovery
→ reconnect existing Backend or launch a candidate
```

如果 recovery 发现另一个 desktop build 已经成为 authority，旧 shell 只作为 viewer attach：它停止 desktop-owner lease，不得反向替换新 Backend，也不得在之后断线时重新 spawn Backend。Product Quit 只有当前 shell 真正持有 active DesktopOwnerLease 时才可以关闭 desktop-owned Backend。

## 2.3 单次请求流程

> **小白理解：** 每一步都会把信息整理成下一步真正需要的样子，并丢掉旧包装。这样
> 后面的模块不必知道请求最初来自 Node socket、哪个 JSON 写法或哪种 token scope。

请求中的 ownership 依次变化：

```text
1. server.ts
   IncomingMessage + socket
   → WHATWG Request

2. http.ts / runtime.ts
   method + pathname
   → one ClientProtocolHandler

3. anthropic/handler.ts
   Headers → RequestIdentity
   raw JSON → validated Anthropic request
   model selector → Pi Model
   request semantics → Pi Context + protocol options

4. protocols/options.ts
   protocol options
   + RequestIdentity.effectiveSessionId
   + HTTP AbortSignal
   + bounded infrastructure facts
   → ModelsSimpleStreamOptions

5. execution.ts / Pi Models
   Model + Context + Options
   → AssistantMessageEventStream
   → one supported done.message or failure

6. anthropic renderer
   AssistantMessage + protocol render state
   → exact Anthropic JSON or Atomic SSE bytes

7. server.ts
   WHATWG Response
   → ServerResponse status + headers + complete bytes
```

## 2.4 信息生命周期

> **小白理解：** “生命周期”就是一条信息从出现到销毁的旅程。门票只应在门口使用；
> 如果门票号码一路传到模型回复里，就是信息泄漏。下面的表专门检查每种信息应在哪一站
> 停止继续传播。

```mermaid
flowchart LR
    Raw["原始信息<br/>socket / token / JSON"] --> Owner["负责它的模块"]
    Owner --> Fact["提炼后的必要事实"]
    Fact --> Consumer["真正使用事实的模块"]
    Owner -. "旧表示在这里销毁" .-> Stop["不再传播"]
```

| 信息 | 产生位置 | 最远传播位置 | 死亡点 |
| --- | --- | --- | --- |
| Node socket / `IncomingMessage` | Node HTTP server | `server.ts` | Web `Request` 建立、response 完成或连接关闭 |
| Codex request Bearer | Local Native request headers | `CodexLocalCredentialAuthority` → Local Native transport | request-local forward auth 建立并完成 native transport 后 |
| Codex `auth.json` access token | Codex credential authority | constant-time comparison / bounded scrub memory | 不进入 Pi/Provider credential state |
| Provider credential raw value | Pi `CredentialStore` / `LiveCredentialAuthority` | Provider auth resolution / request composition | request-local Provider auth 建立后；management projection 永不返回 secret |
| Control Plane capability | Backend discovery publication | trusted Main/CLI Control Plane handshake | authenticated management session 关闭后 |
| `sessionId` / request identity | request identity authority | interested execution/diagnostics consumers | request terminal 后 |
| Anthropic raw JSON | Anthropic handler | validation | validated source state 建立后 |
| Anthropic render state | Anthropic conversion | Anthropic renderer | response bytes 建立后 |
| Pi `Context` / `Options` | Anthropic adapter/options composer | Pi Models/Provider | Pi invocation terminal 后 |
| CommandCode request JSON | CommandCode Provider | upstream transport | transport 不再需要 body 后 |
| partial JSONL/tool state | CommandCode assembler | Provider stream | content completion、terminal、abort 或 error 后 |
| Anthropic 未转换字段（`top_p`、`thinking`、`context_management` 等） | Anthropic handler | 读取所需字段时 | 不进入任何 Pi 状态；在 validation 读取阶段即死亡 |
| CommandCode non-content 事件（`start`、`start-step`、`finish-step`、`provider-metadata`、`tool-result`） | CommandCode assembler | validate-then-drop；仅 finish-step last id/modelId 成为 response identity | committed result 建立前，其余 metadata/header/body 销毁 |
| CommandCode `providerExecuted`/`dynamic` 元数据 | CommandCode assembler | event 校验阶段 | committed response 建立前；不保留 |

这张表是判断“信息是否到处飞”的主要依据：一个模块可以透明传递 Pi contract
中的窄字段，但不应同时保留其旧 wire representation、文件 schema 或来源分类。

---

# 3. Transport 与 Runtime 模块

## 3.0 小白导读：把网络请求当成快递

这一章可以用快递系统理解。`server.ts` 是收发货车辆，负责真实网络连接；
`runtime.ts` 是分拨中心，保存有哪些服务窗口；`http.ts` 根据包裹上的“请求方法和
路径”把它送到正确窗口，并在客户取消、超时或关店时停止配送。

```mermaid
flowchart LR
    Agent["Agent 发出包裹"] --> Truck["server.ts<br/>网络收发车"]
    Truck --> Hub["runtime.ts<br/>分拨中心"]
    Hub --> Sorter["http.ts<br/>按地址分拣"]
    Sorter --> Window["协议窗口<br/>例如 /v1/messages"]
    Window --> Sorter --> Hub --> Truck --> Agent
```

这三个模块只关心“包裹怎么安全送达”，不打开包裹研究 Anthropic、工具调用或模型
内容，所以将来换网络框架时不应影响业务翻译模块。

这一组只拥有 HTTP transport、route 和 request delivery lifecycle。它的共同边界是
Node 22 WHATWG `Request/Response`，不建立 LuckyToken 自定义 HTTP DTO。

## 3.1 Node HTTP adapter — `src/server.ts`

> **小白理解：** 这是唯一直接接触端口、网络连接和 socket 的模块。它像快递车，
> 负责把 Node 网络包裹换成项目统一使用的 `Request`，回来时再把 `Response` 原样
> 装车送走，但不会解读包裹里的业务内容。

| 项目 | 内容 |
| --- | --- |
| 功能 | 监听真实 TCP；在 Node HTTP types 与 WHATWG Web types 之间机械适配；管理连接断开和 server shutdown |
| 公共构造接口 | `startLuckyTokenHttpServer(options): Promise<RunningLuckyTokenHttpServer>` |
| 输入 | `{ runtime: LuckyTokenRuntime, host?: string, port?: number }` |
| 输出 | `{ host, port, origin, close(): Promise<void> }` |
| 默认值 | host=`127.0.0.1`，port=`3000`；port=`0` 时由 OS 选择测试端口 |
| 持有状态 | Node `Server`、当前实际 origin、活动 request 的 `AbortController` 与 `ServerResponse` set、幂等 close promise |
| 配套文件 | 无；host/port 由 composition/CLI 从 `.luckytoken/config.json` 投影进来 |
| 谁使用它 | CLI serve、程序化调用者、真实 TCP integration/online tests |
| 它使用谁 | Node `http`/`stream`；唯一业务依赖是 `LuckyTokenRuntime.handle(Request)` |

核心接口：

```ts
interface LuckyTokenRuntime {
  handle(request: Request): Promise<Response>;
}

interface LuckyTokenHttpServerOptions {
  runtime: LuckyTokenRuntime;
  host?: string;
  port?: number;
}
```

机械传输规则：

- URL 的 authority 来自实际绑定的 `origin`，不把客户端 `Host` 当作 route authority；
- `IncomingMessage` body 通过 `Readable.toWeb()` 进入 Web `Request`；
- Web `Response` 的 status、headers 和完整 body bytes 写入 `ServerResponse`；
- 客户端 request abort、response socket 提前关闭、server `close()` 都 abort 当前
  request signal；
- `close()` 停止新连接、abort/销毁活动响应，并且幂等；
- adapter catch 到未处理错误时只产生 transport-level 500，不解释 Anthropic 或
  Provider error。

边界判断：删除 `server.ts` 并换成其他 Web `Request/Response` host，不应修改
Anthropic、Pi 或 Provider 模块。

## 3.2 Runtime facade — `src/runtime.ts`

> **小白理解：** Runtime 像一张冻结的服务窗口清单。它知道“哪个地址由哪个窗口
> 处理”，但不知道窗口内部如何验票、翻译或联系模型。冻结清单能防止营业期间有人
> 悄悄换掉窗口规则。

| 项目 | 内容 |
| --- | --- |
| 功能 | 把一组独立 `ClientProtocolHandler` 冻结为稳定 route table，并暴露唯一 `handle(Request)` 接口 |
| 公共构造接口 | `createLuckyTokenRuntime(options): LuckyTokenRuntime` |
| 输入 | handlers、可选 request timeout、可选进程 shutdown signal |
| 输出 | frozen `{ handle(request): Promise<Response> }` |
| 持有状态 | frozen handler snapshots 和 HTTP lifecycle dependencies |
| 配套文件 | 无 |
| 谁使用它 | Node HTTP adapter；程序化调用者也可直接传 WHATWG `Request` |
| 它使用谁 | `http.ts` 的 `handleHttpRequest()` |

Runtime 构造时检查每个 route 有 method、absolute pathname，并拒绝重复
`method + pathname`。它保存 handler 的 method/path/handle snapshot，因此 serving
期间修改原始 handler object 不会改变 route table。

Runtime 不知道：

```text
Anthropic request schema
request credential stores / Control Plane capability
Pi Context / Model semantics
CommandCode Provider internals
Node socket / port
```

## 3.3 HTTP request lifecycle/router — `src/http.ts`

> **小白理解：** Router 是分拣员。它只看 `POST` 和 `/v1/messages` 这样的地址，
> 找不到窗口就回答 404；客户挂断、等待太久或系统关机时，它会立即给整条处理链发出
> “停止”信号，并阻止迟到的结果再次送达。

公共相邻接口是：

```ts
interface ClientProtocolHandler {
  readonly method: string;
  readonly pathname: string;
  handle(request: Request): Promise<Response>;
}
```

| 项目 | 内容 |
| --- | --- |
| 功能 | exact method/path route；合并连接、shutdown、timeout cancellation；保证 response 只交付一次 |
| 输入 | frozen handler list、request timeout、shutdown signal、单个 WHATWG `Request` |
| 输出 | handler 的 WHATWG `Response`、404、generic 500，或 abort error |
| Request-local state | composite `AbortController`、writable/delivered flags、timeout timer、signal listeners |
| 谁使用它 | `runtime.ts` |
| 它使用谁 | 被选中的 `ClientProtocolHandler`；不使用 request-identity/credential authority、Pi 或 concrete Provider |

选择顺序是先 route/profile，后进入 handler 或明确 native lane seam。Runtime 不解释
credential，也不会把某条 lane 的 credential authority 传播给另一条 lane；session
identity normalization 与 lane-specific auth 都在更窄的 owning seam 中完成。

失败语义：

- 没有 route：404；
- handler 抛出普通未分类错误：generic 500；
- request/shutdown/timeout abort：抛出 `HttpRequestAbortedError`，禁止交付 later
  response；
- response 已标记 delivered 后不能第二次 commit。

## 3.4 Transport/Runtime 的左右上下关系

> **小白理解：** 下图里只有协议窗口会理解业务内容。左边的网络层和中间的路由层
> 都只搬运标准 `Request/Response`，因此它们不会把 Anthropic 与某个 Provider 绑死。

```mermaid
flowchart LR
    NodeClient["Agent TCP connection"] --> Server["server.ts"]
    Server -->|"WHATWG Request"| Runtime["runtime.ts"]
    Runtime --> Http["http.ts lifecycle/router"]
    Http -->|"selected Request"| Handler["one ClientProtocolHandler"]
    Handler -->|"WHATWG Response"| Http
    Http --> Runtime
    Runtime --> Server
    Server -->|"status/headers/bytes"| NodeClient
```

- 上层构造者：CLI/composition 或程序化调用者；
- 左侧 caller：Agent/socket；
- 右侧 callee：一个已注册 handler；
- 下层基础设施：Node HTTP/stream；
- 该组对 Client Protocol 唯一要求：实现三字段接口，不泄漏 concrete protocol。

---

# 4. Credential 与管理安全 authority

## 4.0 小白导读：现在有三种完全不同的“钥匙”

LuckyToken 不再给本地 Agent 发一套 global/project client token。当前安全相关 credential 分成三个独立生命周期：

```text
1. Local Native Codex request credential
   Codex request Bearer
   → 只在 Local Native lane 验证/转发

2. Provider credential
   ~/.luckytoken/pi/auth.json 或 Provider/环境配置
   → Provider Runtime / Pi Models 使用

3. Control Plane capability
   control-plane.json 中的随机 capability
   → 只认证本机 management IPC
```

三类 credential 不互相转换，也不会进入 Pi AI IR 作为模型语义。

## 4.1 Data Plane request edge

Model Data Plane 固定绑定 loopback 地址。Anthropic/OpenAI Responses 的普通 semantic-conversion request 不需要 LuckyToken 自己的 client-token 文件，也没有 `client-token` CLI。

这并不表示所有 incoming credential 都被忽略：native preservation lane 可以把 client wire 上的 credential 当作该 lane 自己的 transport/auth fact，但它不能被提升成全局 LuckyToken credential。

## 4.2 Codex Local Native credential authority — `src/integrations/codex/local-auth.ts`

Local Native Codex lane 使用一个非常窄的 authority：

```ts
interface CodexLocalCredentialAuthority {
  resolveForwardAuth(headers: ReadonlyHeaders): Promise<CodexForwardAuth | undefined>;
  scrub(value: string): string;
}
```

它读取当前 Codex `auth.json` 的 access token，只接受 request 中 Bearer 与该当前 token 常量时间相等的请求，然后返回 request-local forward auth。credential 不会进入 Pi Models、Provider credential store 或其他 native lane。

该 authority 还维护有界 known-value scrub snapshot，供 diagnostics/redaction 消除当前和最近的 Codex token；读取失败只是 Local Native auth unavailable，不会让整个 Backend startup 失败。

## 4.3 Provider credential authority — `src/credentials/authority.ts`

Provider credential 由 Backend-lifetime `LiveCredentialAuthority` 与 Pi `CredentialStore` 拥有。生产文件是 `config.pi.directory/auth.json`，默认即 `~/.luckytoken/pi/auth.json`。

主要 contract：

```text
Control Plane / CLI login|logout|import
        ↓
LiveCredentialAuthority
        ↓ revision + per-slot CAS
CredentialStore
        ↓
auth.json
        ↓
Pi Models / Provider Runtime
```

所有 mutation 都经过 revision/CAS；外部文件修改会被重新观察成新 revision，stale UI/CLI write 不能覆盖新值。Control Plane status 只暴露 stored/environment/models-json/expired/unavailable 等结构性事实，不返回 secret、环境变量名、command 文本或原始 credential object。

Provider login 既可以是 API key，也可以由 Provider 自己声明 account/subscription/OAuth interaction；CLI/Desktop 只实现 typed interaction shell，不硬编码具体 Provider 登录语义。

## 4.4 Application Control Plane capability

Control Plane 的 `capability` 是 management-plane authorization，不是 Data Plane API key。它与 opaque local IPC `address` 一起出现在 current-user discovery descriptor 中：

```text
~/.luckytoken/control-plane.json
{ address, capability }
```

只有 Backend、Electron Main 与 CLI control client 可以看到它；preload/renderer 不得到 address/capability。descriptor 是 discovery publication，不是 singleton lock，也不是 liveness 证明。

---

# 5. Anthropic Messages Client Protocol 模块

## 5.0 小白导读：这是“Anthropic 语言翻译部”

假设 Agent 只会按照 Anthropic Messages 的表格办事，而后面的 Pi 只接受自己统一的
内部表格。本章这些模块合起来就是一个翻译部：先检查来件是否完整、门票是否有效，
再把内容翻译成 Pi 能理解的形式；模型完成工作后，它又把结果翻译回 Anthropic
格式。它不需要知道最后是哪一家 Provider 真正回答了问题。

```mermaid
flowchart LR
    A["Agent 的 Anthropic 请求"] --> B["检查版本、门票和表格"]
    B --> C["翻译成 Pi 统一请求"]
    C --> D["Pi 执行并确认完整结果"]
    D --> E["翻译成 Anthropic 回答"]
    E --> F["JSON 或 Atomic SSE"]
```

可以把这一章理解成一条有质检的翻译流水线。每个小模块只负责一道工序，所以未来
增加另一种 Client Protocol 时，不必修改这里来迁就它。

目录 `src/protocols/anthropic/` 是一个完整的 Client Wire ↔ Pi capability。它拥有
Anthropic headers/body 的合法性、Anthropic 到 Pi 的确定性转换、request-local
render state、Pi committed result 到 Anthropic target 的转换，以及 JSON/SSE wire
rendering。它不拥有 Provider 选择之外的任何 upstream 语义。

## 5.1 Handler/orchestrator — `handler.ts`

> **小白理解：** Handler 像翻译部的值班主管。它不亲自完成所有细节，而是严格按
> 顺序把来件交给门卫、表格检查员、翻译员、Pi 和包装员。顺序固定可以避免“还没
> 验证门票就开始工作”或“拿半成品当最终答案”这类问题。

```ts
interface AnthropicMessagesHandlerOptions {
  models: Models;
  createSessionId?: () => string;
  configuration?: AnthropicConfiguration;
  providerNativeLane?: AnthropicProviderNativeLane;
  modelValidityPolicy?: AnthropicModelValidityPolicy;
  createMessageId?: () => string;
  publicModels?: PublicModelSource;
  requestLedger?: RequestLedger;
  deepCapture?: DeepCaptureAuthority;
  maxRequestBytes: number;
  routerDefaults?: RouterOptionDefaults;
  executeOperation?: ExecutionOperation;
}

createAnthropicMessagesHandler(options): ClientProtocolHandler
```

输出 handler 固定为：

```text
method   = POST
pathname = /v1/messages
handle   = Request → Promise<Response>
```

| 项目 | 内容 |
| --- | --- |
| 功能 | 按固定顺序编排 Anthropic request 的 request identity、profile/body/model、lane selection、conversion、Pi execution 和 rendering |
| 输入 | WHATWG `Request`；构造期注入的 `Models`、Public Model source、policy/limits/identity/observation capabilities 与 native passthrough fetch |
| 输出 | Anthropic JSON/SSE `Response`；连接级 abort 继续向外抛 |
| 持有状态 | frozen dependency snapshot；无跨请求 message/session store |
| 配套文件 | 无直接 credential 文件 I/O；Provider credential 与 Local Native credential 由 owning authority 处理 |
| 谁使用它 | Runtime route table |
| 它使用谁 | 本目录 parsing/conversion/rendering、Request Identity、Public Model resolution、execution、Pi Models 与 narrow native passthrough seam |

固定处理顺序是：

```text
Content-Type check
→ resolve RequestIdentity(headers)
→ Anthropic source profile
→ bounded raw-body read + JSON parse
→ model-independent request validation
→ resolve Pi Model
→ model-aware validity
→ Anthropic → Pi conversion
→ compose infrastructure facts into Pi options
→ freeze invocation
→ execute Pi stream to semantic terminal
→ Pi AssistantMessage → Anthropic target
→ JSON or Atomic SSE bytes
```

这个顺序很重要：request identity/credential concerns 不参与 Anthropic source-validity judgment；model-aware
检查在确定性 conversion 之前完成；renderer 只接收 committed
`AssistantMessage`，不会把 partial Pi stream 暴露成客户端成功。

## 5.2 Protocol profile — `profile.ts`

> **小白理解：** Profile 是“版本检查员”。Anthropic 请求会声明自己遵循哪个版本、
> 也可能携带实验或 SDK headers。LuckyToken 这里只核对版本；遇到陌生版本会拒绝，
> 其他 headers 不分类、不传播，也不影响协议转换。

| 项目 | 内容 |
| --- | --- |
| 接口 | `resolveAnthropicSourceProfile(headers)`；`assertImplementedAnthropicProfile(profile)` |
| 输入 | Anthropic-related header view |
| 输出 | `{ version }` |
| 当前支持 | `anthropic-version=2023-06-01`；其他 headers 不参与协议转换判断 |
| 谁使用它 | Anthropic handler/request validator |
| 它使用谁 | 只使用 Anthropic error classes |

它只读取 `anthropic-version`。`anthropic-beta`、其他 `anthropic-*`、Agent/SDK 与
transport headers 均不分类、不传播，也不参与 Anthropic → Pi 转换判断。

## 5.3 Request validation/conversion — `request.ts`

> **小白理解：** 这里先像办事大厅一样检查表格，再像翻译员一样转换表格。检查阶段
> 判断字段是否正确、前后关系是否成立；转换阶段只处理已经合格的内容。它不会擅自
> 补写缺失的工具调用，也不会把客户填写的模型名称塞进模型可见的对话正文。

主要接口分成两个阶段：

```ts
validateAnthropicSourceRequest(value)
  → ValidatedAnthropicSourceRequest

convertValidatedAnthropicRequest(validated, receivedAt)
  → AnthropicInvocation
```

`AnthropicInvocation` 是该 Client Protocol 的短生命周期输出，不是新的通用 IR：

```ts
interface AnthropicInvocation {
  selector: string;
  context: Pi.Context;
  options: Pi.ModelsSimpleStreamOptions;
  renderState: { clientModel: string; stream: boolean };
}
```

| 阶段 | 输入 | 输出 | 死亡的信息 |
| --- | --- | --- | --- |
| Grammar/source validation | unknown JSON body | validated Anthropic-owned state | raw JSON shape errors/unsupported list |
| Canonicalization | string/block message forms | module-private canonical content | shorthand/adjacent same-role wire spelling |
| Pi conversion | validated supported state | Pi `Context`, protocol-owned options, minimal render state | canonical Anthropic representation |

当前 accepted deterministic surface 包括 text、system prompt、历史 ordinary thinking、
base64 image shape、client tool definition、tool use/result、temperature、
`output_config.effort`、`metadata.user_id` 和 stream flag；但 image 还必须通过
model-aware fidelity policy，production 默认 policy 当前不认证 image path，因此
不会仅凭 JSON shape 放行。

**只转换指定字段，其他一律忽略。** 这是本模块的第一原则：conversion 只读取
Part II 1-7 章定义的字段（`model`、`system`、`messages`、`tools`、`max_tokens`、
`temperature`、`output_config.effort`、`metadata.user_id`、`stream`），其他任何
字段（`top_p`、`top_k`、`thinking`、`tool_choice`、`stop_sequences`、
`cache_control`、`context_management` 以及未来未知字段）直接忽略，不报错、不进入
Pi 状态。转换器不维护"已知 vs 未知"字段清单——它只关心自己需要的字段，读不到/
读坏了才报错。同理，message 的额外字段、content block 的额外字段（如
`cache_control`、`citations`、`caller`）、tool definition 的额外控制字段
（`type`、`allowed_callers`、`defer_loading` 等）都忽略。

**只有真正转换不了才报错。** 错误分类只有两类：

- `InvalidRequest`：转换需要的字段 malformed（如 `messages` 不是数组、
  `output_config.effort` 不是 string、`tool_use.input` 不是对象）；
- `UnsupportedFeature`：源语义有效但 Pi 无 faithful 表示且丢弃会改变请求意义
  （如 URL image source、未知 content block type、不在支持集合的 image
  media type）。

`output_config.effort` 的五个已知值（`low/medium/high/xhigh/max`）映射到 Pi
`ThinkingLevel`；**未知 effort 值降级为不设置 `reasoning`**（使用 Pi reasoning
default behavior），绝不让 request 因 effort 失败，也不强转为已知 level。

重要 conversation 规则：

- adjacent same-role Anthropic messages 在 module-private canonicalization 中合并；
- historical assistant message 变成 Pi `AssistantMessage`，使用保留的 synthetic
  provider/api identity，不冒充真实 Provider output；
- `thinking + signature` 变成 Pi `ThinkingContent + thinkingSignature`；
- `redacted_thinking + data` 变成 Pi `ThinkingContent { thinking: "", redacted: true }`，
  signature 携带 opaque data；
- assistant `tool_use` 变成 Pi `ToolCall`，ID/name/arguments 精确保留；
- immediately following user `tool_result` 变成 Pi `ToolResultMessage`，通过
  `tool_use_id` 查回 tool name；
- tool results 必须领先该 user turn 的 ordinary content，不能 orphan、duplicate 或
  延迟到后续 turn；
- 空 content 数组（`content: []`）是合法输入，构造 Pi `UserMessage { content: [] }`；
- `max_tokens=0` 原样保留为 `maxTokens=0`，不 clamp 不拒绝；
- source-invalid lifecycle 直接失败，converter 不猜测或修复；
- `renderState.clientModel` 保留客户端请求中的 model identity，response 时使用，但
  不进入 Pi model-visible context。

## 5.4 Client tools conversion — `tools.ts`

> **小白理解：** Agent 不只会聊天，也可能递交一张“可使用工具说明书”。这里检查
> 工具名称、参数表和约束，再把说明书原样含义地交给 Pi。它不会把结构化说明书压成
> 一段随意文字，因此工具名称、参数和严格约束不会在途中丢失。

```ts
validateAnthropicTools(value)
  → ValidatedAnthropicTool[] | undefined

convertAnthropicTools(validated)
  → Pi.Tool[] | undefined
```

| 项目 | 内容 |
| --- | --- |
| 功能 | 验证 client tool identity、strict flag 和 strict 计数；转换为 Pi `Tool` |
| 输入 | Anthropic `tools[]` unknown JSON |
| 输出 | name/description/inputSchema/strict validated state，再到 Pi tool definitions |
| 持有状态 | 仅一次 validation traversal 的 cycle set 与 strict request-wide counters |
| 谁使用它 | `request.ts` |
| 它使用谁 | Pi `Tool` type；Anthropic `InvalidRequest` |

它保留 tool name 和 schema，不把 schema stringify 成 prompt。`strict:true` 转成 Pi
`constrainedSampling = { type: "json_schema", strict: "require" }`。

**`input_schema` 直接传递，不做 JSON Schema keyword 校验。** conversion 不 rewrite、
normalize、reconstruct schema，也不重新实现 JSON Schema keyword validation
（转换文档 §5）。`$schema`、`anyOf`、`oneOf`、`format`、type array、未知 keyword
等全部原样传给 Pi `Tool.parameters`。工具定义中未转换的额外控制字段（`type`、
`cache_control`、`allowed_callers`、`defer_loading`、`eager_input_streaming`、
`input_examples`）按"只读所需"原则忽略，不报错。

唯一保留的 schema 解析是**协议层 strict 源有效性计数**（协议文档 §5.2.3）：
最多 20 个 strict tools、24 个 optional parameters、16 个 union parameters，
request-wide 累计。这个计数需要解析 `properties`/`required`/`type`，但只计数、
不拒绝未知 keyword。malformed 结构（如 `properties` 不是对象、`required` 不是
string 数组）仍是 `InvalidRequest`。

## 5.5 Model-aware representability — `representability.ts`

> **小白理解：** 请求语法正确，不代表选中的模型真的能完成它。例如表格可以正确
> 填写“发送图片”，但某个模型未必可靠支持图片。这里就是开工前的能力复核；无法
> 确认时宁可明确拒绝，也不假装支持。

```ts
interface AnthropicModelValidityPolicy {
  revision: string;
  classifyFinalAssistantPrefill(model, sourceProfile):
    "allowed" | "forbidden" | "unknown";
  hasCertifiedImageFidelity(model): boolean;
}
```

此 policy 只补足 Pi `Model` 没有表达的 Anthropic source-validity facts，不能演变成
通用 capability registry。当前检查：

- image 同时要求 Pi model 声明 `input: image` 和 policy 认证 fidelity；
- final-assistant prefill 即使 source-valid，也仍超出当前 LuckyToken v1；unknown
  不能猜测放行；
- historical thinking 要求 resolved model `reasoning=true`。

谁使用：handler 在 model resolution 后调用。它使用：validated Anthropic facts、
Pi `Model` 和 source profile。Provider 不参与这一步。

## 5.6 Pi options composition — `options.ts`

> **小白理解：** 一次任务的控制信息来自几个不同岗位：Client Protocol 决定模型可见
> controls，Request Identity 提供 session identity，HTTP 提供取消信号，runtime policy
> 只能提供自己明确拥有的 infrastructure facts。这里像固定格子的汇总单，各 owner 不能
> 越权覆盖其他人的字段。

```ts
composeOptions(
  protocolOptions,
  { sessionId, signal, ...infrastructureFacts },
  routerDefaults,
): ModelsSimpleStreamOptions
```

这是不同 owner 的窄 facts 唯一汇合点：

| Fact owner | 输入字段 | Pi carrier |
| --- | --- | --- |
| Anthropic protocol | `maxTokens`, `temperature?`, `reasoning?`, `metadata.user_id?` | 对应 Pi option |
| Request Identity | `effectiveSessionId` | `sessionId` |
| HTTP lifecycle | `AbortSignal` | `signal` |
| Runtime/composition infrastructure | typed headers/env/transport/timeout/retry callbacks when explicitly owned | matching Pi infrastructure option |
| Router | classified semantic defaults only when explicitly defined | matching Pi semantic option |

它使用 closed-world allowlist 防止某一 owner 覆盖另一 owner 的字段。特别是 request identity
或 credential authority 不能制造 arbitrary metadata；Router defaults 也不能覆盖 Client
Protocol 已拥有的 `metadata.user_id`。输出建立后，各输入来源分类结束，只剩 Pi options fields。

Anthropic protocol 现在拥有的 Pi option keys 为：`maxTokens`、`temperature`、
`reasoning`、`metadata`（其下仅 `user_id`）。`reasoning` 来自
`output_config.effort` 的映射；Router defaults 不能注入 `reasoning`（它不属于
Router 的已分类 v1 policy）。

## 5.7 Model resolution — `src/model-resolution.ts`

> **小白理解：** Agent 写下一个模型名称后，这里负责在 Pi 的模型目录中找到唯一
> 对应项，类似用“厂商/商品编号”查目录。找不到或同名商品不止一个时就明确报错，
> 不会私自挑一家 Provider。

```ts
resolveModel(models, selector): Model<string>
```

先匹配 qualified `provider/id`，再匹配唯一 unqualified `id`；unknown 或 ambiguous
都抛 `ModelResolutionFailure`。它只依赖 Pi `Models.getModels()`，不读取
`models.json`，也不知道当前 Provider 是 CommandCode。Anthropic handler 使用它把
external selector 变成真实 Pi `Model`；404 rendering 由 handler 拥有。

## 5.8 Pi execution commit — `src/execution.ts`

> **小白理解：** 模型回答可能像连续寄来的多页传真。这里会一直等待 Pi 发出正式的
> “完成章”，并核对完成原因；仅仅传真机不再出纸（EOF）不等于任务成功。取消或
> 中途报错时，已经收到的半页内容会被丢弃，绝不包装成成功回答。

```ts
freezePiInvocation(model, context, options): void

execute(models, model, context, options): Promise<AssistantMessage>
```

`freezePiInvocation` 深冻 plain invocation data，但不冻结 live `AbortSignal`。
`execute` 主动消费 `Models.streamSimple()`：

- EOF 不是 success；没有 semantic terminal 的 EOF 是 malformed stream；
- `done(stop|length|toolUse)` 且 terminal reason 与 message 一致才 commit；
- `deferred` 当前不支持；
- `error/aborted` 分别成为 execution failure/abort；
- request signal 可以在 iterator wait 期间独立中止；
- partial content 从不作为成功返回。

该模块只认识 Pi event lifecycle，不知道 Anthropic JSON 或 CommandCode JSONL。当前
Anthropic handler 是它的 caller；任何未来 Client Protocol 也可复用它。

## 5.9 Pi result → Anthropic target — `response.ts`

> **小白理解：** 这是返程翻译员。它只接收已经盖过“完整完成章”的 Pi 结果，把正文、
> 思考、工具调用、停止原因和用量逐项翻译回 Anthropic 的表格。不能无损翻译的内容
> 会报错，不会静默删掉。

```ts
convertAssistantMessageToAnthropic(message, clientModel, messageId)
  → AnthropicResponseMessage
```

输入必须是已经 committed 的 Pi `AssistantMessage`。转换规则：

- Pi text → Anthropic text block；
- Pi ordinary thinking → Anthropic thinking + signature；redacted thinking fail closed；
- Pi toolCall → direct Anthropic `tool_use`，ID/name/JSON arguments 保留；
- `stop`/`length`/`toolUse` → `end_turn`/`max_tokens`/`tool_use`；
- Pi usage → Anthropic required usage shape，包括 cache/reasoning breakdown；
- response `model` 使用 request-local `clientModel`，不泄漏 Provider response model；
- unclassified Pi message/content/usage fields、非 lossless JSON tool arguments、非法
  count 全部抛 `OutboundResponseFidelityFailure`。

## 5.10 Exact JSON wire — `wire.ts`

> **小白理解：** 翻译好的答案还是一份内部对象，这里负责最后装箱成网络上真正发送
> 的字节。它再次核对箱内字段，并制作标准的成功或错误信封；它不再参与模型执行。

```ts
renderAnthropicJsonSuccess(target): PreparedHttpResponse
renderAnthropicError(status, type, message): PreparedHttpResponse
```

`PreparedHttpResponse = { status, contentType, body: Uint8Array }`。Success renderer
先按 exact field set 重新验证 target，再 UTF-8 JSON encode。Error renderer 只产生
Anthropic error envelope。`wire.ts` 是 bytes boundary；它不调用 Pi，也不保留 request。

## 5.11 Atomic SSE wire — `sse.ts`

> **小白理解：** SSE 看起来像答案一段段到达，但这里采用 **Atomic（原子）SSE**：
> 先等整个模型任务成功，再把完整答案切成一连串标准事件发送。它提供 SDK 需要的
> SSE 外形，却不是模型边生成边直播，因此失败时不会留下一个看似成功的半截回答。

```ts
createAnthropicAtomicSseEvents(target): AnthropicAtomicSseEvent[]
renderAnthropicAtomicSse(target): PreparedHttpResponse
```

事件生命周期严格为：

```text
message_start
→ 每个 content block:
   content_block_start
   → text/thinking/signature/input_json delta
   → content_block_stop
→ message_delta(stop + usage)
→ message_stop
```

这里的“Atomic”是关键：Provider/Pi 已经完成并 commit 完整
`AssistantMessage`，然后模块一次性派生全部 SSE events 和完整 bytes。它提供 SSE
wire compatibility，但不是把 upstream partial JSONL 直接透传给客户端。因此不存在
半个 tool input 被当成完整 tool call，也不会在后来 Provider error 时已经向客户端
提交 success prefix。

## 5.12 Anthropic error ownership — `failures.ts` 与 handler catch

> **小白理解：** 这是面向 Anthropic 客户的“错误服务台”。无论内部哪一步发现问题，
> 都由这一协议层选择客户认识的状态码和错误类型。内部诊断、Provider 私有格式和
> 密钥不会被原样抛给 Agent。

| 来源 | Client response |
| --- | --- |
| wrong content type | 415 `invalid_request_error` |
| invalid local client token | 401 `authentication_error` |
| body over limit | 413 `request_too_large` |
| malformed JSON/source-invalid/unsupported | 400 `invalid_request_error` |
| model unknown/ambiguous | 404 `not_found_error` |
| classified execution abort | 500 `api_error` |
| trusted neutral Provider failure | 只使用 `ExecutionFailure.failure` 中已验证的 status、safe message/type/code 与 allowlisted headers；bounded snapshot 不进入 Client body |
| provider execution failure（无 structured fact） | 固定 502 `api_error` + `Upstream provider failed`；不读取 Pi `errorMessage`、exception text 或 Provider 私有字段 |
| request connection/shutdown/timeout abort | 不再写 response，由 HTTP lifecycle 终止 |
| other internal failure | 500 `api_error` without internal diagnostic leakage |

Conversion handler 不注入 custom fetch，也不从旁路 transport state 恢复失败语义。
Provider 只通过 Pi `AssistantMessage.diagnostics` 发送 neutral fact；Execution 验证后
把它提升为 `ExecutionFailure.failure`，再由 owning Client renderer 映射。Native
passthrough 不进入 Pi，使用独立的窄 `passthroughFetch`，不能充当 conversion failure
acquisition path。

## 5.13 Anthropic 模块内部关系

> **小白理解：** 下图从主管 `handler.ts` 向外展开。箭头表示“调用谁完成下一道工序”，
> 不是表示这些模块共享全部数据。每道工序完成后，只把下一道真正需要的结果交出去。

```mermaid
flowchart TD
    H["handler.ts"] --> P["profile.ts"]
    H --> RQ["request.ts"]
    RQ --> T["tools.ts"]
    H --> MR["model-resolution.ts"]
    H --> MV["representability.ts"]
    H --> O["options.ts"]
    H --> E["execution.ts / Pi Models"]
    H --> RS["response.ts"]
    RS --> W["wire.ts JSON"]
    RS --> S["sse.ts Atomic SSE"]
    W --> RESP["WHATWG Response"]
    S --> RESP
```

配套规范是 [Anthropic Messages Protocol](./Protocols/Anthropic%20Message%20Protocol.md)
与 [Anthropic ↔ Pi Conversion Method](./Protocols/Anthropic-Pi%20AI%20IR%20Conversion%20Method.md)。
配套测试按 source profile、request conversion、tools、options、response、SSE、HTTP
integration 分开，避免只通过一个 end-to-end happy path 掩盖某个阶段的 semantic
loss。

---

# 6. Pi Runtime、配置、Composition 与 CLI

## 6.0 小白导读：Pi 是统一插座，Composition 是开机装配员

LuckyToken 两边会不断变化：左边将来可能有 Anthropic、OpenAI Responses 等不同
Client Protocol，右边也可能增加更多 Provider。Pi 就像中间统一规格的插座。左边只需
把请求变成 Pi 插头，右边只需做成 Pi 插座，双方不必互相认识。

```mermaid
flowchart LR
    CP["Client Protocol\n把客户请求变成 Pi 格式"] --> PI["Pi 统一接口\nModels / Model / Context / Events"]
    PI --> PR["Provider\n把 Pi 格式变成供应商请求"]
    AC["auth.json\nProvider 凭证"] --> PI
    CO --> PI
    CO --> CP
    CO --> PR
```

Composition 可以理解为“开门前装配员”：它读取文件、造好对象、把接口接起来，然后
退出日常请求流程。CLI 则是前台入口，负责启动服务、登录 Provider 或管理 Client
Token，但它自己不做协议翻译。

Pi 是 LuckyToken 的共享 runtime/IR contract，但 Pi Agent 不是 LuckyToken 的应用
架构。生产代码依赖 npm package `@earendil-works/pi-ai@0.84.2`；仓库中的
`pi-agent/packages/ai` 用于 source review/reference，不被 LuckyToken-specific 代码
修改。LuckyToken-owned 模块只补上文件加载、credential persistence、Provider
construction 和 CLI shell。

## 6.1 Pi public runtime contract

> **小白理解：** 这些 interface 是统一插座的尺寸图。`Models` 像总服务台，知道目前
> 安装了哪些 Provider 和模型；每个 `Provider` 像一个接入统一插座的供应商。Client
> Protocol 只把任务递给总服务台，不会越过 Pi 直接联系某个供应商。

LuckyToken 直接使用以下 Pi public interfaces：

```ts
interface Provider {
  id: string;
  name: string;
  auth: ProviderAuth;
  getModels(): readonly Model[];
  streamSimple(model, context, options?): AssistantMessageEventStream;
}

interface Models {
  getProviders(): readonly Provider[];
  getModels(provider?): readonly Model[];
  checkAuth(providerId): Promise<AuthCheck | undefined>;
  login(providerId, type, interaction): Promise<Credential>;
  logout(providerId): Promise<void>;
  streamSimple(model, context, options?): AssistantMessageEventStream;
}

interface MutableModels extends Models {
  setProvider(provider: Provider): void;
}
```

Pi `Models` 拥有 Provider collection、Provider auth resolution、credential application
和 request delegation；concrete Provider 拥有自己的 model list、auth methods 与
stream behavior。LuckyToken 不在两者之间加 Manager/Registry。

`Models.streamSimple()` 的输入/输出也是左右解耦的关键：

```text
Input
├── Model<Api>
├── Context
└── ModelsSimpleStreamOptions

Output
└── AssistantMessageEventStream
```

Client Protocol 只生产这些 Pi contracts；Provider 只消费这些 Pi contracts。

## 6.2 Provider model data — 内置模型目录，单一权威来源

> **小白理解：** 供应商的商品目录（模型 id、能力、容量）直接写在 LuckyToken 的
> Provider Package 里，用户不需要任何 `models.json`。安装并配置 package 后，
> `login` 填 API key 就能用。

CommandCode Private Provider Package 内置 **33 个模型**，全部硬编码在
`packages/provider-commandcode-private/src/models.ts`（`COMMANDCODE_MODEL_SOURCES`），这是
**唯一的模型权威来源**——没有运行时端点拉取，更新模型只需改这个文件。

模型数据来自 `doc/# CommandCode 1.9.0 模型信息表.md`（官方 command-code@1.9.0
bundle 静态分析）：

- `id`：官方权威 id（如 `deepseek/deepseek-v4-flash`、`Qwen/Qwen3.8-Max`）；
- `contextWindow` / `input`（text/image）：官方模态；
- `cost`：官方定价表（每百万 token USD）；
- `reasoningEfforts`：官方推理档位（如 DeepSeek 仅 `high/max`、Qwen3.8-Max 仅
  `low/medium/xhigh`）；官方未标注档位的模型保持全档位宽松。

`thinkingLevelMap` 由 `reasoningEfforts` 生成，语义是：客户端请求档位在模型支持
范围内 → 原样使用；不在范围内 → **fallback 到模型支持的最高档**（不报错、不发
无效参数）；模型明确标注 `null` 的档位 → 报错。

默认模型仍是 `deepseek/deepseek-v4-flash`（`COMMANDCODE_DEFAULT_MODEL_ID`）。

### 6.2.1 用户自定义 Provider — `models.json`（新增）

用户可通过 `pi.modelsJson` 配置（默认与 config 同目录的 `models.json`，桌面布局
即 `~/.luckytoken/models.json`；始终是 LuckyToken 自有数据目录，绝不隐式读写
Pi Agent 默认数据目录）注册自定义 Provider，复用 Pi 内置 api adapter：

```json
{
  "providers": {
    "my-anthropic": {
      "baseUrl": "https://gateway.example.com",
      "api": "anthropic-messages",
      "apiKey": "sk-...",
      "models": [
        { "id": "claude-sonnet", "contextWindow": 200000, "maxTokens": 64000 }
      ]
    }
  }
}
```

`src/providers/models-json.ts` 是 LuckyToken 自有解析器（最小 schema 子集，不
import coding-agent 参考源）；`catalog.ts` 用 Pi 公共接口 `createProvider` +
`getApiProvider(api)` 注册。apiKey 优先读 Pi `CredentialStore`（`login` 存储），
fallback 到配置字段。注册后走标准 Pi IR 路径：请求由对应 api adapter 按
`model.baseUrl` 直发，响应经 Pi 解析后渲染回 Anthropic。

## 6.3 Pi credential persistence — `src/pi/file-credential-store.ts`

> **小白理解：** `auth.json` 是“供应商保险柜”，保存 LuckyToken 登录外部 Provider
> 所需的 API key 或 OAuth 凭证。它不是 Agent 访问本地服务使用的门卡文件。加锁是
> 因为 Provider 凭证可能在运行时被登录、退出或自动刷新，多个动作不能同时改坏文件。

```ts
createFileCredentialStore(authPath): CredentialStore
```

实现的是上游 Pi 接口，而不是 LuckyToken 自定义 credential API：

```ts
interface CredentialStore {
  read(providerId): Promise<Credential | undefined>;
  list(): Promise<readonly CredentialInfo[]>;
  modify(providerId, fn): Promise<Credential | undefined>;
  delete(providerId): Promise<void>;
}
```

| 项目 | 内容 |
| --- | --- |
| 功能 | 按 Provider ID 保存一个 `api_key` 或 `oauth` credential；为 Pi login/refresh/logout 提供 serialized read-modify-write |
| 配套文件 | `.luckytoken/pi/auth.json` |
| 文件 owner | Pi `CredentialStore` implementation；Pi `Models` 是 semantic caller |
| 持有状态 | resolved auth path；操作期间的 file lock/parsed credential clone |
| 谁使用它 | `createModels({ credentials })` 间接通过 Pi `Models` 使用 |
| 它使用谁 | Node file API、`proper-lockfile`、Pi credential types |

每次操作可接收 `AbortSignal`，创建目录/文件时请求 0700/0600 权限，并用跨进程 file
lock 序列化 OAuth refresh、login write 与 logout delete。`list()` 只输出 Provider ID
和 credential type，不输出 secret。

这里使用 lock 是 Pi credential contract 的需要：运行时并发请求可能同时触发 OAuth
refresh。它与 Codex Local Native request credential、Control Plane capability 是三个不同
capability，不能因为都属于“认证信息”就共享 authority 或生命周期。

## 6.4 Main deployment config — `src/cli-config.ts`

> **小白理解：** `.luckytoken/config.json` 是部署地址簿：Data Plane 端口、各 Client
> Protocol 的 conversion/state policy、Provider package 配置、Pi 文件夹和请求限额。
> 它不保存 LuckyToken client token，也不承担 Backend singleton/discovery；后两者固定由
> current-user application state root 派生。

```ts
loadLuckyTokenCliConfig(path): Promise<LuckyTokenCliConfig>
```

严格文件 `.luckytoken/config.json` 的当前结构：

```json
{
  "schemaVersion": "luckytoken-config-v1",
  "server": { "port": 3000 },
  "clientProtocols": {
    "anthropic-messages": {
      "conversion": {
        "request": {
          "unknownContent": "error",
          "unresolvedToolCall": "xrepair",
          "localCacheControl": "ignore"
        },
        "response": { "unknownPiContent": "error" }
      }
    },
    "openai-responses": {
      "stateFile": "state/openai-responses.json",
      "providerNative": {
        "transport": {
          "maxRetries": 0,
          "maxRetryDelayMs": 60000
        }
      },
      "conversion": {
        "request": {
          "privilegedMessages": "first",
          "unknownInputItem": "error",
          "orphanToolOutput": "error",
          "unresolvedToolCall": "xrepair",
          "futureReasoningEffort": "max"
        },
        "response": { "unknownPiContent": "error", "storeFalse": "honor" }
      }
    }
  },
  "pi": { "directory": "pi" },
  "limits": {
    "maxRequestBytes": 268435456,
    "requestTimeoutMs": 120000
  }
}
```

| 项目 | 内容 |
| --- | --- |
| 功能 | 验证 deployment location/protocol policy/limits；把 relative path 按 config 所在目录解析；返回 frozen snapshot |
| 输入 | 必须显式提供的 config path |
| 输出 | loopback Data Plane port、protocol-specific conversion/state config、external user package root→opaque config、Pi directory/modelsJson、limits |
| 谁使用它 | top-level CLI；composition 接收已验证 snapshot |
| 它使用谁 | Node path/file/stat |

未知字段、错误类型、非法 port/limit、空 protocol map 都失败。Protocol map 使用
null-prototype object，并由 consumer 做 own-property lookup，避免
`__proto__`/inherited-name 污染。

Config loader 可以解析未来 protocol ID，但当前 concrete composition 会拒绝
“configured but not installed”的 protocol。Provider Package specifier 只允许 npm 根包名
或 scoped 根包名；相对/绝对路径、URL、Node builtin 与 package subpath 都失败。
旧 `providerAdapters.commandcode-private` 配置不保留兼容分支，直接报错。

## 6.5 Pi/Provider 与 Data Plane composition — `src/composition.ts`

> **小白理解：** Composition 是把“已经各自拥有语义的模块”接起来的工位。它知道哪些 Client Protocol、Provider、native transport 与 authority 要被注入，但不在这里重新解释协议。

当前 production 有两个主要构造层次：

```ts
createProviderRuntime(options)
  → Backend-lifetime Pi Models + Provider/Credential/Catalog facts

createConfiguredLuckyTokenDataPlane(options)
  → LuckyTokenRuntime + certification + idempotent close
```

### `createProviderRuntime()`

这一层只组装 Pi/Provider 侧：准备 CredentialStore，按 Pi builtins、`models.json`、bundled product Providers 与 external user Provider Packages 的当前契约构造模型集合。CommandCode Private 是 bundled product Provider，会自动进入 runtime；用户不得在 `providerPackages` 重复配置它。Core/Client Protocol 不 import 它的私有实现。

| 输入 | 输出/行为 |
| --- | --- |
| `piDirectory` / `modelsJsonPath` | 定位 `auth.json` 与 LuckyToken-owned models catalog |
| optional `CredentialStore` | 测试可替换 production file store；同一 store 同时交给 Models 与 Credential Authority |
| Provider package configuration | package-private conversion/request/response config |
| bound `fetch` / host capabilities | 交给需要 network/runtime capability 的 Provider |

缺少 Provider credential 不阻止 Backend composition；login/auth status 与真实 invocation 由 Provider Runtime / Pi credential path 处理。

### `createConfiguredLuckyTokenDataPlane()`

Data Plane composition 同时能看见三条独立 lane 的窄 seam，但不能把它们合并成一个 generic executor：

```text
Local Native Preservation
  compatible Client Wire
  → local model recognition + CodexLocalCredentialAuthority
  → local native transport

Provider Native Preservation
  compatible Client Wire
  → resolved Pi Model + Models credential resolution
  → provider-native transport

Semantic Conversion
  Client Wire
  → Client Protocol adapter
  → Pi AI IR / Pi Provider
  → Provider Wire
```

三条 lane 可以共享 request-edge identity/observation 等最小 infrastructure facts，但不共享 credential authority、native executor、transport 或 semantic-conversion state。选定 lane 后失败不得 fall through 到另一 lane。

Data Plane 只接收 `DataPlaneConfiguration`、`Models`、Public Model source、ledger/capture、protocol gate、`scrubSensitiveText` 与 lane-specific optional seams。完整 `ProviderRuntime`、credential representation、Catalog 和 persistence store configuration 都留在 Backend Application。Provider failure 只通过 trusted neutral diagnostics 跨越 execution boundary；native lane 以原始 client wire 为 authority，只做 endpoint/auth/header 等 preservation 所需变化。

当前 production runtime certification 只认证 provider-neutral Core；CommandCode package 与 distribution certification 位于测试/分发边界，分别证明 package contract、动态加载、协议冻结与授权的线上证据。

## 6.6 Serving certification — Core 与 Distribution 分离

> **小白理解：** Certification 像营业前的整套验收清单。它核对实际装上的模型、地址、
> 认证方式、取消策略和转换版本是否仍是经过测试的组合。验收失败就不启动，避免
> “零件都能单独工作，但接在一起已经不是测试过的系统”。

`src/core-serving-certification.ts` 只记录 Client Protocol、实际 Provider IDs、注册顺序
和 runtime limits，不绑定某个 private Provider。CommandCode-specific 的完整 conformance
manifest 位于 `test/support/commandcode-serving-certification.ts`，作为 Provider /
Distribution certification 验证 package、动态加载与线上证据，不进入 Core runtime。

```ts
certifyServingComposition(facts): ServingCertificationManifest
```

Core certification 不是 request processor。它在 startup 检查 provider-neutral 的
Client Protocol、实际 Provider IDs、注册顺序与 limits。Provider/Distribution
certification 另行绑定 CommandCode model、endpoint、Auth、转换 revision、package
identity 与 conformance hash。

| 输入 | 当前 bound facts 的只读描述，不是 live service objects |
| --- | --- |
| 输出 | deep-frozen `CERTIFIED` 或 `FAILED` manifest |
| 配套文件 | `test/fixtures/certification/serving-conformance-v2.json` 与 certification tests |
| 谁使用它 | composition root；失败时阻止启动 |
| 它使用谁 | provider-neutral composition facts；CommandCode-specific facts只存在于测试/分发认证 |

Certification 可以看见左右两侧是为了证明一个具体 serving route，但不能进行协议
转换。测试替身只有在覆盖同一 owning seam/contract 时才可计入证据；不能用 test-only
identity、credential 或 transport shortcut 冒充 production authority coverage。

## 6.7 Process CLI — `src/cli.ts`

> **小白理解：** CLI 只是进程入口，不再自己组装整套 Backend。`serve` 负责请求“启动或附着当前用户的 LuckyToken Backend”；`control ...` 连接已经运行的 Control Plane，并通过 Backend authority 管理 Provider 凭证。

Top-level CLI 是 adapter/shell，不是 Backend composition root：

| 命令 | 使用模块 | 产生的外部效果 |
| --- | --- | --- |
| `serve --config ...` | `startLuckyTokenApplication()` | 取得/附着 current-user Backend authority；运行或附着 Backend |
| `control ... --descriptor ...` | `ControlPlaneClient` | 查询/修改运行中 Backend 的 typed management state |
| `control auth login ...` | running Backend Control Plane | Provider-owned login flow；由 Backend-lifetime Models 写入 credential |
| `control credentials login/logout ...` | running Backend Control Plane | 由唯一 Credential Authority 修改 `auth.json` |

`serve` 不接受自定义 descriptor。生产 singleton 固定使用 `~/.luckytoken/instance.sqlite`，matching discovery 固定发布到 `~/.luckytoken/control-plane.json`；只有 `control ...` 客户端命令把 `--descriptor` 当作连接导航参数。integration tests 若需要隔离实例，应通过独立 HOME 或内部 composition dependency 隔离，而不是改变生产 instance domain。

Auth CLI 从运行中 Backend 的 typed Control Plane projection 读取 Provider login options；
它只实现通用 prompt/notify shell，不在独立进程中创建第二套 Models 或 credential owner，
也不硬编码 CommandCode key prompt。

Serve 获得 `RunningLuckyTokenApplication` 后只等待 process signal 或 application-owned exit。SIGINT/SIGTERM 调用 Backend Application 的 graceful shutdown seam；具体 Data Plane drain、Control Plane/publication、stores 与 `InstanceLease` 的关闭顺序由 `application.ts` 拥有，CLI 不重复实现。

## 6.8 Pi 文件与 ownership 关系

> **小白理解：** Pi 目录保存 Provider credential 与动态 catalog cache；LuckyToken 的
> `models.json`/`public-models.json` 仍由 LuckyToken application state root 单独拥有。

```mermaid
flowchart TB
    D[".luckytoken/pi/"] --> A["auth.json\nProvider credential"]
    D --> C["models-catalog-cache.json\n动态 catalog cache"]
    A --> P["Pi Models / Credential Authority"]
    C --> R["Catalog Refresh Controller"]
```

```text
.luckytoken/pi/
├── auth.json
│   owner: Pi CredentialStore / LiveCredentialAuthority
└── models-catalog-cache.json
    owner: Backend Catalog cache store
```

Provider credential 不得泄漏到 Client Protocol semantic state；Codex Local Native
credential authority 也不读写这个 Pi directory。

---

# 7. CommandCode Private Provider 模块

## 7.0 小白导读：这是只懂 CommandCode 的“供应商联络部”

Pi 给出的已经是统一任务单，但 CommandCode 有自己的网址、认证、请求表格和逐行返回
格式。本章模块像专门联系这家供应商的采购部门：把 Pi 任务单改写为 CommandCode
订单，可靠地发送和收货，确认所有包裹齐全后，再交回一份标准 Pi 结果。

```mermaid
flowchart LR
    PI["Pi 统一任务单"] --> CV["转换并封存\nCommandCode 请求"]
    CV --> CFG["构造 fixed empty\nServerConfig"]
    CFG --> HTTP["发送、超时、重试"]
    HTTP --> JL["逐行收取 JSONL\n按 ID 拼装"]
    JL --> OK["完整结束后提交"]
    OK --> OUT["Pi 标准结果与事件"]
```

这个部门不知道最初的客户讲 Anthropic 还是 OpenAI Responses；它只接收 Pi。
同样，Client Protocol 也不知道这里使用 CommandCode。这就是左右两侧解耦的实际落点。

目录 `packages/provider-commandcode-private/src/` 是完整 Pi ↔ CommandCode capability。它从
Pi Provider invocation 得到唯一语义输入，生成稳定 CommandCode request；执行真实
HTTP attempts；在 physical EOF 后原子提交 JSONL result；再把结果转换并 replay 为
Pi `AssistantMessageEventStream`。它完全不知道请求最初来自 Anthropic 还是未来
OpenAI Responses。

## 7.1 Provider factory 与 Pi 接口 — `provider.ts`

> **小白理解：** Provider factory 像为特定供应商创建一名专员。专员向 Pi 展示统一的
> 模型、登录和执行接口，内部才知道 CommandCode 的细节。API key 由 Pi 的凭证流程
> 交给它使用，不会写进模型目录，也不会暴露给 Client Protocol。

```ts
interface CommandCodePrivateProviderOptions {
  configuration?: CommandCodeConfiguration;
  apiKey?: string;
  fetch?: FetchFunction;
  model?: Model<string>;
  models?: readonly Model<string>[];
  now: () => number;
  compatibility?: CommandCodeCompatibilityPolicy;
  createSessionId?: () => string;
  traceContext?: CommandCodeTraceContextCapability;
  sleep?: (delayMs, signal) => Promise<void>;
}

createCommandCodePrivateProvider(options)
  → Pi.Provider<"commandcode-private">
```

输出 Provider identity 与 model API identity 固定为：

```text
Provider.id   = commandcode-private
Provider.name = CommandCode Private
Model.api     = commandcode-private
```

CommandCode 是 Pi 内置风格 Provider 实现（对齐 `deepseekProvider()` 形态），但由
独立 Provider Package 交付：
`createCommandCodePrivateProvider()` 由 package-owned configuration/model catalog
建立 CommandCode endpoint 与模型能力，`auth.apiKey.login` 让用户只填 API key 即可使用。
生产 bundled package 不需要用户在 `models.json` 中重建 CommandCode 模型；测试通过
Provider factory/configuration dependency 注入 fixture upstream，而不是 ambient 环境开关。

| 项目 | 内容 |
| --- | --- |
| 功能 | 实现 Pi Provider auth/model/stream contract；编排 request preparation、attempt、semantic commit、Pi replay |
| 输入 | Pi `Model + Context + SimpleStreamOptions`；构造期 bound dependencies |
| 输出 | Pi `AssistantMessageEventStream` |
| 持有状态 | frozen model/catalog、compatibility、trace/transport capabilities、stream functions；无 conversation store |
| 配套文件 | 自己不直接读取业务文件；Provider credential 由 Pi auth path 注入，runtime compatibility config 固定构造 |
| 谁使用它 | Pi `MutableModels.setProvider()` 后由 Pi `Models` dispatch |
| 它使用谁 | fixed config helper、attempts、assembler、semantic、lossless JSON；Pi provider helpers |

Provider auth 通过 Pi `Provider.auth.apiKey` 暴露：

- `login(interaction)` 只负责通用 secret prompt 并返回 Pi `ApiKeyCredential`；
- Pi `Models.login()` 负责调用并持久化到 `CredentialStore`；
- request-time `resolve()` 优先使用 Pi stored credential；只有未存储时才使用可选
  deployment fallback `options.apiKey`；
- Provider credential 只存于 Pi CredentialStore（`auth.json`），从不进入代码或
  配置文件。

## 7.2 Pi Context → CommandCode messages/tools — `provider.ts`

> **小白理解：** 这是“下单翻译”。它把 Pi 的对话、图片、思考、工具调用和工具结果
> 逐项换成 CommandCode 表格；无法准确表达的内容会拒绝，而不是删除。工具调用 ID
> 就像订单行号，必须从请求到结果始终一致。

主要纯转换接口：

```ts
convertCommandCodeMessages(model, context)
  → CommandCode wire messages[]

convertCommandCodeTools(context.tools)
  → CommandCode wire tools[]

buildCommandCodeBody(model, context, options, config, sessionId, compatibility, requestPolicy)
  → { body, supportedReasoningEfforts, notices }
```

### Message conversion

| Pi input | CommandCode output |
| --- | --- |
| user text | `{ role:"user", content:[{type:"text", text}] }` |
| user image | data URL image block；要求 model image capability |
| assistant text | assistant text block |
| assistant thinking | assistant reasoning block |
| assistant toolCall | `tool-call`，精确保留 ID/name/lossless JSON input |
| ToolResultMessage | adjacent `role:"tool"` 的 `tool-result`，error 映射为 `error-text` |

Historical `AssistantMessage.stopReason` 对 CommandCode request 是 targetless fact，所有
当前或未来值都被忽略，content 仍按顺序转换并独立校验。无 target slot 的 text/thinking/
tool signatures 被丢弃；redacted thinking 只丢弃该 block，不影响同一消息的其他内容。
ToolResult image 被丢弃、文字保留，image-only 使用空字符串保持 correlation。
真实 ToolResult 保留 Pi `toolCallId`、非空 `toolName` 与 `isError`；synthetic result 使用
pending call ID/name 和 Provider request policy 的 `text|error-text`。每次 missing-result
修复还会产生 request-local、非模型可见的 Provider notice。

如果 Pi history 含 tool call 但结果丢失，Provider 按 CommandCode wire 要求生成一个
与原 call ID 配对的明确 missing-result block，而不是删除 tool call 或猜测结果。

### Tool definition conversion

Pi tool name/description/parameters 变成 CommandCode tool definition。所有 schema
必须是 lossless JSON object。CommandCode 没有 constrained-sampling wire field，因此
absent/false/prefer/require/grammar 都降为同一个普通 target tool，不向 prompt、description
或 schema 注入指令。`strict=require` 是冻结的可用性例外：不拒绝请求，但产生
request-local、非模型可见的 Provider degradation notice；这不代表上游执行了 strict。

### Body controls

Request body 固定包含：

```text
config
memory = null
taste = null
skills = null
permissionMode
threadId
params
  ├── model
  ├── messages
  ├── tools
  ├── max_tokens
  ├── stream = true
  ├── system?
  ├── temperature?
  └── reasoning_effort?
```

Pi reasoning level 只在 selected model 支持时映射为 CommandCode
`low|medium|high|xhigh|max`。Pi deferred execution 当前明确不支持。

## 7.3 Fixed runtime compatibility config — `project.ts`

> **小白理解：** 当前 CommandCode Private 不再读取 LuckyToken/Pi 的项目目录，也不扫描
> filesystem/Git。上游 wire 仍要求一个 `config` object，所以 Provider 只构造协议要求的
> fixed empty representation；它是兼容性字段，不是 LuckyToken 的 workspace model。

```ts
createEmptyServerConfig(): ServerConfig
```

固定结果：

```text
workingDir     = ""
date           = ""
environment    = ""
structure      = []
isGitRepo      = false
currentBranch  = ""
mainBranch     = ""
gitStatus      = ""
recentCommits  = []
```

| 项目 | 内容 |
| --- | --- |
| 功能 | 构造当前 CommandCode wire 所需的 fixed empty `ServerConfig` |
| 输入 | 无 request project fact |
| 输出 | fresh mutable cloneable `ServerConfig` |
| 持有状态 | 无 |
| filesystem/Git | 不读取；`process.cwd()` 也不是 project identity |
| 谁使用它 | `prepareCommandCodeRequest()` |

`x-project-slug` 当前不生成。若未来真实 upstream requirement 重新需要 workspace/project
state，必须先在 Provider/Protocol contract 中证明 source、ownership、failure 与 lifecycle，
不能从 ambient cwd、generic Pi metadata 或旧 token 设计恢复隐式 project flow。

## 7.4 Request preparation/authority closure — `provider.ts`

> **小白理解：** 这里像正式封箱：先确定模型、逻辑 session、fixed compatibility config
> 和网络地址，再生成完整订单并重新验货，最后把它冻结。即使扩展回调参与修改载荷，
> 也不能偷换已经确认的模型/session。一次逻辑任务只封箱一次，重试仍发送同一权威订单。

```ts
prepareCommandCodeRequest(model, context, options, dependencies)
  → PreparedCommandCodeRequest
```

一次 logical invocation 只准备一次：

```text
snapshot invoked model
→ resolve sessionId / logical trace
→ create fixed empty ServerConfig
→ build authoritative headers/body
→ optional Pi onPayload callback
→ JSON serialize
→ parse and validate against captured authority
→ freeze endpoint/headers/bodyText/signal/fetch
```

`validateCommandCodeRequest()` 在 callback 和 serialization 之后重新检查 model ID、
session、fixed config、permission、image/reasoning capabilities、message/tool lifecycle
和 closed-world fields。因此 callback 可以参与 Pi-defined payload transform，但不能
偷偷改写 Provider authority。

Transport 选择 precedence 是 request `options.fetch` → Provider-bound fetch → global
fetch。当前 certified composition 总是显式绑定 fetch，并禁止依赖 global fallback。
在 certified composition 中，CommandCode Provider 直接持有原始 bound fetch。每个
physical attempt 在 Provider 内有界读取自己的失败 response，并只把 neutral fact 与
attempt summary 提升到 Pi diagnostics。Client conversion handler 不包装任何 Provider
transport，也不通过 `options.fetch` 建立观察旁路。

## 7.5 HTTP attempt/retry/cancellation — `attempts.ts`

> **小白理解：** 一张订单可能因为断网、限流或服务器故障需要重寄。订单内容和逻辑
> 编号保持不变，但每次寄送都有自己的超时和追踪编号。客户取消时，正在发送、等待
> 重试或收取回包的动作都会停止，不会留下后台任务继续消耗资源。

```ts
resolveCommandCodeExecutionControls(options)
  → { maxRetries, timeoutMs, maxRetryDelayMs, onResponse }

executeCommandCodeAttempts(prepared, model, controls, dependencies)
  → Promise<CommandCodeResult + immutable attempt summaries>
```

| Logical invocation state（跨 retry 稳定） | Physical attempt state（每次新建） |
| --- | --- |
| endpoint、headers baseline、bodyText、caller signal、logical trace ID | timeout controller、span ID/traceparent、Request/Response、reader/decoder、assembler |

Retry 只发生于 network/transport failure、429、5xx、terminal-less EOF 或明确
retryable stream error，并受 `maxRetries` 限制。Delay precedence 是
`retry-after-ms`、`retry-after` seconds/date、再 exponential fallback；server delay
不能超过 configured max。

Caller cancellation 在 retry sleep、fetch、onResponse callback、body read 和 commit
前传播；已经形成的 upstream stream terminal 不会被稍后翻转的 caller signal 重新标成
Pi aborted。Attempt timeout 只结束当前 attempt，并按触发位置保留 `connect`、
`response_headers` 或 `response_body` phase。响应 body cleanup 是 best-effort，不能
掩盖已经形成的 primary failure。

HTTP non-2xx、HTTP-200 stream error、connect/body/EOF、timeout、protocol、configuration、
callback、retry-delay 与 caller cancellation 都先形成 neutral failure。Retry 只读取
`failure.retryable === true`。每个 started attempt 都生成可信 diagnostic；execution 按序
提交到 handler-owned invocation sink，最终失败由 handler 恰好写一个 journal。

## 7.6 CommandCode response transport — `attempts.ts`

> **小白理解：** CommandCode 把回答写成一行一行的 JSON，但网络快递箱可以在任意
> 字节处拆分，一行也可能横跨多个箱子。这里先把字节重新拼成完整行，再交给内容
> 拼装器；看到“完成”行后仍要等运输真正结束，才能确认没有尾部错误。

上游 endpoint 是 resolved model base URL authority 上的 absolute path `/alpha/generate`；
任何 base path/query/fragment 都被替换或丢弃，而不是把 path 追加到 prefix。虽然 response media
type 可能写 SSE，实际 framing 是 bare newline-delimited JSON：没有 `event:`、`data:`、
blank-line delimiter 或 `[DONE]`。

`consumeCommandCodeResponse()` 使用 streaming `TextDecoder` 跨 HTTP chunks 组装完整
line，再逐行送入新的 `CommandCodeContentAssembler`。一个 chunk 不等于一个 event，
一个 UTF-8 code point 也可能跨 chunk。

Physical EOF 是成功条件的一部分：看到 `finish` 后仍继续读取；只有 EOF 到来且所有
content lifecycle closed 才可能返回成功 result。

## 7.7 Atomic ordered JSONL assembler — `assembler.ts`

> **小白理解：** Assembler 像按编号拼一套拼图。正文、思考和工具调用都可能分多次
> 到达，它按开始顺序预留位置，并按各自 ID 累积；工具参数预览绝不算完成。只有所有
> 拼图闭合、收到合法结束信息且运输 EOF 到达，整份结果才一次性成立。任何失败都会
> 清空本次拼图，不能污染下一次请求。

```ts
class CommandCodeContentAssembler {
  consumeRawLine(line): void;
  finalizeAfterTransportEnd(): CommandCodeResult;
}
```

内部状态高内聚在一个 request-local reducer：

```text
slots[]              start-event arrival order
textById             text lifecycle
reasoningById        reasoning lifecycle
toolById             partial tool-input lifecycle
finish/rawUsage      terminal candidate
```

关键不变量：

- **只有指定 event type 进入 content。** 进入 content 的事件只有三类生命周期：
  `text-start/delta/end`、`reasoning-start/delta/end`、
  `tool-input-start/delta/end + tool-call`；且只有 `*-start` reserve ordered slot；
  delta/end 不能重排；
- 其他事件按协议分类：`start`、`start-step`、`provider-metadata`、response-side
  `tool-result` validate-then-drop；`finish-step` 额外 stage 最后一个合法 response
  id/modelId pair，但其 usage 不覆盖 final finish；`finish` 决定终止 reason 与 final
  usage；`abort`/`error` 立即产生 neutral failure；
- `providerExecuted`/`dynamic` 等 server-owned 元数据**不读取、不校验、不保留**
  （协议文档 §2.8）：`tool-input-start`/`tool-call` 只消费 `id`/`toolName`/
  `toolCallId`/`input` 等转换所需字段，这些额外字段的生命周期在 event 消费时即
  结束，不进入 committed response；
- text/reasoning 必须 start → delta* → end，结束时不能是空内容；
- tool 必须 `tool-input-start → delta* → input-end → authoritative tool-call`；
- partial tool preview 不是 completed tool input；只有 final `tool-call` 的 lossless JSON
  object materialize；primitive/null/array input fail closed；
- known malformed lifecycle/field/non-JSON line 是 non-retryable protocol error；
- unknown future event 不猜测语义，使用 Provider `error|ignore` policy（default error）；
  ignore 只留下 bounded response notice，仍不能代替 finish；
- `abort`、stream error 无成功 result；exact raw `pause_turn` 在 closed slots/EOF 后使用
  `stop|error` policy（default stop），stop 保留 committed facts并添加 degrade notice；
- final `finish` 覆盖 earlier finish/usage，但不能代替 physical EOF；
- EOF 无 finish 是 retryable transport error；EOF 时还有 open slot 是 protocol error；
- 任意 failure 都清空 slots/maps/terminal/identity/notices，避免 partial state 泄漏；
- successful `CommandCodeResult` 的 content/tool input/finish/raw usage/identity/notices
  均 deep-frozen，交错或并发 response 不共享状态。

Assembler 输出仍是 Provider-local `CommandCodeResult`，生命周期只到 semantic
conversion；它不是 Pi contract，也不离开 Provider 目录。

## 7.8 CommandCode result → Pi semantic commit/replay — `semantic.ts`

> **小白理解：** 这是“收货验收并换回统一包装”。它把已经完整提交的 CommandCode
> 内容、停止原因和用量转换成 Pi 结果，然后按 Pi 的标准事件顺序重放。上层看到的
> 永远是 Pi 生命周期，不会看见 CommandCode 私有 JSONL 或半成品。

```ts
captureCommandCodeResponseAuthority(model, now)
  → CommandCodeResponseAuthority

convertCommittedCommandCodeResult(result, authority)
  → Pi.AssistantMessage

replayCommandCodeAssistantMessage(stream, message, signal): void
```

Provider invocation 开始时就 snapshot response identity、timestamp 和 pricing model，
避免 callback/mutable model 在 response 阶段改变 authority。

Conversion 只在 assembler commit 后发生：

- CommandCode text → Pi `TextContent`；
- reasoning → Pi `ThinkingContent`；已经收到的可表示内容不会因为 model catalog 的
  `reasoning:false` 请求能力声明而被拒绝；
- client-owned tool use → Pi `ToolCall`，ID/name/lossless JSON arguments 保留；
- last finish-step identity → Pi `responseId` / `responseModel`；没有来源时省略；
- `providerExecuted`/`dynamic` 等 server-owned 元数据在 assembler 阶段已不保留，
  这里不再读取或检查；
- usage 消费 final finish 的 raw total 与已知 alias：`inputTokens` 与显式
  `noCache + cacheRead + cacheWrite` 分区互相校验，nested/top-level cache-read 与
  reasoning aliases 必须一致，source `totalTokens` 必须等于 Pi components；当前 wire
  没有 one-hour cache-write split，因此不猜测 `cacheWrite1h`；最后用 captured pricing
  model 算 cost；
- finish 的 `length` 优先；否则由实际转换后的 ToolCall content 决定 `toolUse` / `stop`。
  Wire category 与内容不一致时只产生 non-model-visible diagnostic，原始 reason 仍保留；
  pause-stop 走同一个 converter。

Converter 只接受 immutable committed result，并返回 deep-frozen Pi message。任何 content
或 usage 不一致都产生 neutral `kind:"conversion"` error terminal，不重放 partial success。

Replay 在完整 `AssistantMessage` 已知后生成 Pi start/content/done events。任何 error 或
abort 只发 Pi error terminal；如果 signal 在 replay 前 abort，已完成内容也被丢弃并
替换为空 aborted message。这样 Client Protocol 看到的是 Pi 标准 lifecycle，而不是
CommandCode JSONL。

## 7.9 Lossless JSON boundary — `json.ts`

> **小白理解：** JSON 看起来简单，但程序对象里可能藏着 JSON 无法准确保存的数字、
> 循环引用或特殊属性。这个模块是“复印前检查员”，只允许真正可以原样复印的数据，
> 防止序列化时内容悄悄变化，尤其保护工具参数和 schema。

`cloneLosslessJson()`/`cloneLosslessJsonObject()` 只接受真正可无损 JSON 表达的数据：
finite non-`-0` numbers、dense arrays、plain/null-prototype objects、无 symbol/accessor/
cycle/custom serialization。它被 tool schemas、tool arguments 和 Provider request
conversion 共用，防止 `JSON.stringify` 静默改变 semantic value。

## 7.10 Provider 内部关系

> **小白理解：** 下图是一张供应商部门内部流程图。Pi 只连接最外层 Provider 接口；
> fixed runtime config、重试、JSONL 拼装和语义转换都是 CommandCode 模块自己的内部岗位，
> 不会散落到 Runtime、Request Identity 或 Anthropic 模块中。

```mermaid
flowchart TD
    Models["Pi Models"] --> Provider["Provider factory / stream"]
    Provider --> Prep["request preparation"]
    Prep --> Config["project.ts fixed empty ServerConfig"]
    Prep --> Convert["Pi→CommandCode conversion"]
    Prep --> Validate["request authority validation"]
    Validate --> Attempts["attempts.ts"]
    Attempts --> Wire["CommandCode /alpha/generate"]
    Wire --> Attempts
    Attempts --> Assembler["assembler.ts"]
    Assembler --> Semantic["semantic.ts"]
    Semantic --> Stream["Pi AssistantMessageEventStream"]
    Stream --> Models
```

配套规范是 [CommandCode Private Protocol](./Protocols/commandcode%20private%20protocol.md)
与 [Pi ↔ CommandCode Provider Conversion Method](./Protocols/PI%20AI%20IR-Commandcode%20Private%20Conversion.md)。

---

# 8. 持久文件、生成物与公共 API

## 8.0 小白导读：不同资料放进不同抽屉

这一章回答两个实际问题：磁盘上每个文件是谁的、改动何时生效；其他程序又能通过
哪些正式入口使用 LuckyToken。Singleton lock、Control Plane discovery、Provider
credential、model/publication state、protocol session state 与 diagnostics 都有不同 owner，
所以不能合并成一个“万能状态文件”。

```mermaid
flowchart LR
    APP["Backend Application"] --> IA["instance.sqlite\nInstanceAuthority"]
    APP --> DISC["control-plane.json\nDiscoveryPublication"]
    OP["操作者 / Control Plane"] --> CFG["config/models/settings/public-models"]
    PI["Provider login / refresh"] --> PA["pi/auth.json\nProvider credential"]
    RESP["Responses handler"] --> STATE["state/openai-responses.json\nbounded session state"]
    OBS["Backend observation"] --> LEDGER["request-ledger / diagnostics / capture"]
```

## 8.1 运行目录文件地图

> **小白理解：** 文件树就是一张文件柜标签图。“owner”表示哪个模块有权解释和修改
> 这份资料。特别注意：`instance.sqlite` 和 `control-plane.json` 都不是业务数据库，前者只承载
> OS/SQLite singleton lock，后者只承载 management discovery。

```text
.luckytoken/
├── config.json
│   owner: deployment config loader
│   lifetime: startup snapshot
│
├── instance.sqlite
│   owner: InstanceAuthority only
│   semantics: lock carrier; file existence means nothing
│
├── control-plane.json
│   owner: DiscoveryPublication
│   semantics: current local IPC address + capability hint
│
├── models.json
│   owner: ModelsJsonAuthority
│
├── public-models.json
│   owner: PublicModelAuthority
│   semantics: endpoint + Provider/model enable/rename state
│
├── settings.json
│   owner: SettingsRegistry/FileSettingsStore
│
├── integrations/codex/
│   ├── integration-state.json
│   └── model-catalog.json
│       owner: CodexIntegrationAuthority
│
├── state/
│   ├── openai-responses.json
│   │   owner: Responses session-state capability
│   ├── diagnostics/diagnostics.sqlite3
│   │   owner: RuntimeDiagnosticsStore
│   ├── request-ledger/ledger.sqlite3
│   │   owner: RequestLedgerStore
│   └── deep-diagnostics/capture.sqlite3
│       owner: DeepCaptureStore
│
├── logs/failed-requests/*.json
│   owner: invocation diagnostics failure journal
│
└── pi/
    ├── auth.json
    │   owner: Pi CredentialStore / LiveCredentialAuthority
    └── models-catalog-cache.json
        owner: Backend Catalog cache store
```

这些文件没有统一成一个“大配置文件”，因为它们的 semantic owner、mutation
frequency、secret level 和 lifetime 不同：

| 文件 | 静态/动态 | 是否 secret | 运行时语义 |
| --- | --- | --- | --- |
| `config.json` | 静态 deployment | 否 | Backend startup config snapshot |
| `instance.sqlite` | Backend lifetime | 否 | `BEGIN IMMEDIATE` singleton authority；永不按文件存在与否判断 owner |
| `control-plane.json` | Backend lifetime publication | capability 为敏感 management fact | discoverability only；不是 liveness |
| `models.json` | 管理态 | 可能引用 credential source，但不应含明文状态投影 | Provider/model composition authority |
| `public-models.json` | 管理态 | 否 | Public Model on/off、rename、endpoint；debounced persistence + shutdown flush |
| Responses state snapshot | 动态协议状态 | 含会话内容 | bounded `previous_response_id` state |
| Request Ledger / Diagnostics / Capture SQLite | 动态 observation state | 经过各自 redaction/sensitivity policy | Backend-owned persistence |
| `pi/auth.json` | 动态 Provider credential | 是 | Provider login/logout/refresh/CAS authority |

`instance.sqlite` 必须保持 InstanceAuthority 私有：backup、support bundle、generic scanner 或其他
module 不应打开/复制/删除它。生产 backup 使用显式 allowlist，不扫描整个 `.luckytoken/`。

## 8.2 测试专用 secret/evidence 文件

> **小白理解：** 这些是质检室的材料，不是营业中的数据库。真实在线测试会临时读取
> API key 并保存经过检查的协议证据，但生产请求不会自动被集中记录。它们都被 Git
> 忽略，避免把密钥或大量在线样本提交进源码仓库。

| 文件 | Owner/用途 | 是否进入 production |
| --- | --- | --- |
| `CommandcodeAPIKey.txt` | online runner 只在内存中读取真实 Provider key | 否 |
| `.online-artifacts/commandcode-conformance-samples.json` | online conformance 的 Client/Pi/Provider wire 证据，secret 被拒绝/替换 | 否 |
| `test/fixtures/certification/*.json` | immutable source-validity/serving coverage record | 只作为 startup certification 绑定证据 |
| `test/fixtures/commandcode-golden-request.json` | Provider request regression authority | 否 |

Online artifact 不是 runtime log store。Production persistence 分成两个窄 owner：
Responses session state 只保存其 `previous_response_id` 展开所需的有界 wire items；
invocation diagnostics 只为最终失败写有界/脱敏 journal。二者都不是跨协议的通用
conversation store 或全量 request logging subsystem。

## 8.3 Package/public module seams

> **小白理解：** Public seam 可以理解成正式对外开放的插口。Backend Application、
> Desktop lifecycle 与 concrete composition 大多是 product-internal；根包只导出少量
>可复用 runtime/diagnostics/credential/server 能力。

根导出 `luckytoken` 当前包括：

```text
resolveRequestIdentity + request identity types
createRuntimeDiagnosticsStoreFactory + diagnostics types/redaction helpers
createLuckyTokenRuntime + Runtime types
createFileCredentialStore
createCredentialAuthorityStore / createLiveCredentialAuthority
startLuckyTokenHttpServer + server types
```

Subpath `luckytoken/protocols/anthropic`：

```text
createAnthropicMessagesHandler
AnthropicMessagesHandlerOptions
defaultAnthropicModelValidityPolicy
AnthropicModelValidityPolicy
FinalAssistantPrefillValidity
```

私有包 `@luckytoken/provider-commandcode-private` 通过标准 Provider Package contract 进入
Pi Provider runtime；LuckyToken 根包不导出它的 concrete conversion implementation。
`@luckytoken/provider-contract` 只暴露 Provider package/diagnostics contract。

`application.ts`、`cli.ts`、`cli-config.ts`、`composition.ts`、InstanceAuthority、Control
Plane discovery 和 Electron Main lifecycle 都是 product composition seams，不属于根
package API。`package.json` 当前 `private:true`，所以这里的“public”指 build/package
boundary，而不是已经发布到 npm 的长期兼容承诺。

---

# 9. 生产模块总目录

## 9.0 小白导读：把这一章当成公司通讯录

前几章按一次请求的旅程讲系统，本章则按文件列出每个岗位。遇到“这个文件到底做
什么、它找谁帮忙、谁会找它”时，就查对应表格。箭头方向不是网络方向，而是代码
中的调用关系。

```mermaid
flowchart TB
    APP["Backend Application\ncomposition + lifecycle"] --> CORE["Core / Data Plane"]
    APP --> CPCTL["Application Control Plane"]
    APP --> IA["InstanceAuthority"]
    DESK["Electron Main\nDesktopBackendConnection"] --> CPCTL
    CORE --> CP["Client Protocol"]
    CORE --> PI["Pi integration"]
    PI --> PV["Provider"]
    SEC["Credential/security authorities"] --> CORE
    CP -. "只通过 Pi 合同" .-> PI
    PI -. "只通过 Pi 合同" .-> PV
```

本章用于快速回答“某个文件左右上下连接谁”。“上游 caller”表示谁调用/构造它，
“下游 dependency”表示它直接使用谁；不是 Client/Provider wire 的上下游含义。

## 9.1 Core、Backend lifecycle 与进程

> **小白理解：** 这组模块负责“谁可以成为 Backend、Backend 怎么开/关、请求怎么进入、
> Desktop 怎么重新找到 Backend”。它们不应该重新实现 Anthropic/Responses/Provider
> conversion；如果 lifecycle 模块开始理解具体模型内容，边界就错了。

| 模块 | 主要接口/输出 | 上游 caller | 下游 dependency | 配套验证 |
| --- | --- | --- | --- | --- |
| `src/index.ts` | package root re-exports | programmatic consumer | Runtime、diagnostics、Credential Authority、Server | public API tests |
| `src/application.ts` | `startLuckyTokenApplication()` → running/attached Backend | CLI / packaged Backend entry | InstanceAuthority、management authorities、Control Plane、Data Plane supervisor | Backend Application integration + ownership E2E |
| `src/instance-authority.ts` | `acquire()` → `InstanceLease` | Backend Application | dedicated `node:sqlite` connection | real-process SQLite certification + integration |
| `src/control-plane-discovery.ts` | `read()` / `publish()` → `DiscoveryPublication` | Backend Application / trusted clients | current-user descriptor file | discovery ownership tests |
| `src/runtime-supervisor.ts` | Data Plane start/stop/restart/quit | Backend Application Control Plane | Data Plane listener factory | runtime supervisor + lifecycle tests |
| `src/server.ts` | `startLuckyTokenHttpServer()` → running server | Data Plane composition/tests | Node HTTP/stream、`LuckyTokenRuntime` | local-http-server / atomic delivery |
| `src/runtime.ts` | `createLuckyTokenRuntime()` → `handle(Request)` | composition/programmatic | `http.ts` | Client Protocol boundary tests |
| `src/http.ts` | `ClientProtocolHandler`, `handleHttpRequest()` | Runtime | selected handler、AbortSignal/timer | HTTP lifecycle/atomic delivery tests |
| `src/request-identity.ts` | request headers → bounded request/session identity facts | handlers/runtime observation | crypto/headers only | request identity tests |
| `src/model-resolution.ts` | selector → Pi `Model` / lane selection facts | Client Protocol handler | Public Model / Pi Models seams | model-resolution tests |
| `src/execution.ts` | Pi stream → committed `AssistantMessage` | semantic Client Protocol handlers | Pi event stream | execution + provider-boundary tests |
| `src/cli-config.ts` | config file → frozen deployment facts | Backend/CLI composition | Node file/path | cli-config tests |
| `src/composition.ts` | Pi Models + three-lane Data Plane runtime | Backend Application/tests | concrete lane constructors/authorities | composition/certification tests |
| `src/credentials/authority.ts` | `LiveCredentialAuthority` | Backend Application / Control Plane | Pi CredentialStore | credential Control Plane tests |
| `src/core-serving-certification.ts` | provider-neutral facts → frozen Core manifest | composition | protocol/provider IDs、limits | certification tests |
| `src/cli.ts` | serve/control/login/logout process shell | `npm start` | Backend Application、ControlPlaneClient、Pi Models | CLI integration |
| `packages/desktop-shell/src/main/desktop-backend-connection.ts` | `start()` / `dispose()` | Electron Main | discovery、launcher、session、desktop lease | connection lifecycle tests + packaged E2E |
| `packages/desktop-shell/src/main/electron-backend-launcher.ts` | `launch()` → `SpawnedBackend` | DesktopBackendConnection | Node child process only | launcher tests + packaged E2E |
| `packages/desktop-shell/src/main/control-plane-session.ts` | one-endpoint typed Control Plane session | DesktopBackendConnection / Main IPC | `ControlPlaneClient` | session tests |
| `packages/desktop-shell/src/main/desktop-owner-lease.ts` | claim/renew/isBound | DesktopBackendConnection / Product Quit | application commands | lease + product lifecycle tests |

## 9.2 Pi integration

> **小白理解：** 这组模块把 LuckyToken 接到 Pi 的标准接口，并管理 Pi 所需的
> Provider 凭证。CommandCode 的模型与上游地址由其 Provider Package 拥有，无需
> `models.json`。仓库里的 `pi-agent/` 是供人核对上游行为的参考源，正式运行依赖 npm 包；
> `pi-agent/` 整棵树不可修改（见 AGENTS.md），LuckyToken 只通过 Pi 公共接口消费，
> 不在参考源码里打任何补丁。

| 模块 | 主要接口/输出 | 上游 caller | 下游 dependency | 配套验证 |
| --- | --- | --- | --- | --- |
| `src/pi/file-credential-store.ts` | Pi `CredentialStore` implementation | Pi `createModels()`/Models auth | Node file API、`proper-lockfile` | `pi-credential-login`、CLI tests |
| `src/execution.ts` | Pi terminal → atomic success 或 `ExecutionFailure`；验证 neutral diagnostic 并保存在 `.failure` | Client handlers | Pi public event/diagnostic contracts、execution facts sink | execution unit + provider-boundary integration |
| `packages/provider-contract/src/diagnostics.ts` | shared diagnostic contracts 与 trusted runtime identity | Providers、Execution、Client renderers | Pi `AssistantMessageDiagnostic` | upstream-failure + provider-boundary tests |
| `src/providers/models-json.ts` | 最小 models.json 解析；构建 Pi Model 与 apiKey auth | catalog（`registerLuckyTokenProviders`） | Pi Model/ApiKeyAuth types、Node fs | `test/unit/models-json.test.ts`、`models-json-provider` integration |
| `@earendil-works/pi-ai` | `Model/Context/Options/Models/Provider/EventStream` | both Client adapter and Provider adapter | its own upstream-clean runtime | Pi runtime fidelity + certification |
| `pi-agent/packages/ai` | reviewed reference/source mirror | maintainers/certification review | upstream Pi source | 不作为 LuckyToken production import |

## 9.3 Anthropic Client Protocol

> **小白理解：** 这里集中所有“Anthropic 请求是什么意思、怎样变成 Pi、怎样把 Pi
> 答案包装回 Anthropic”的知识。将来实现 OpenAI Responses 时应建立平行目录，不能
> 把 OpenAI 判断塞进这些文件。

| 模块 | 主要接口/输出 | 上游 caller | 下游 dependency | 配套验证 |
| --- | --- | --- | --- | --- |
| `protocols/anthropic/index.ts` | Anthropic subpath exports | programmatic consumer | handler、representability | public API tests/build |
| `handler.ts` | factory → `POST /v1/messages` handler；conversion 不注入 fetch，native 分支只用 `passthroughFetch` | composition/programmatic | Request Identity、Public Model resolution、profile/request/options/execution/renderers、lane-specific native seam | ingress order、minimal text、thinking/TCP integration |
| `failures.ts` | `InvalidRequest`, `UnsupportedFeature` | all Anthropic validators | none | ingress/error integration |
| `profile.ts` | headers → source profile | handler | failure types | Anthropic ingress tests + protocol sync |
| `request.ts` | unknown body → validated state → Pi invocation | handler | tools + Pi types | conversation/tool-turn/ingress tests |
| `tools.ts` | Anthropic tool schema → Pi tools | request converter | Pi Tool + failure | tool-definition unit/provider integration |
| `representability.ts` | model-aware source validity | handler | Pi Model/profile facts | model-aware-validity tests |
| `options.ts` | protocol + infrastructure facts → Pi options | handler | Pi options type | options/invocation-options tests |
| `response.ts` | committed Pi message → Anthropic Message | handler | Pi AssistantMessage | Anthropic response/thinking integration |
| `wire.ts` | Anthropic target/error → exact JSON bytes | handler/SSE | response target types | Anthropic wire + atomic delivery tests |
| `failure-rendering.ts` | trusted neutral failure fact → Anthropic status/type/message/safe headers | handler catch | protocol-neutral upstream fact、wire error type | error-rendering + provider-boundary integration |
| `passthrough.ts` | native Anthropic wire forwarding；独立窄 `passthroughFetch` | handler native branch | upstream-compatible wire + bound fetch | native passthrough tests |
| `sse.ts` | target → Atomic SSE events/bytes | handler | wire schema assertion | Anthropic SSE unit/integration |

## 9.4 CommandCode Provider

> **小白理解：** 这里集中所有“怎样联系 CommandCode、怎样拼装它的返回、怎样交还
> Pi 结果”的知识。它可以被任何能生成 Pi 请求的 Client Protocol 使用，不知道客户
> 来自哪个路由。

| 模块 | 主要接口/输出 | 上游 caller | 下游 dependency | 配套验证 |
| --- | --- | --- | --- | --- |
| `src/providers/catalog.ts` | `registerLuckyTokenProviders()`；只注册 Pi builtins 与 `models.json` | composition | Pi Providers、Pi Models | configured-composition、provider-boundary tests |
| `src/providers/package-loader.ts` | 校验 npm 根名/契约/Provider，冲突检查后原子注册 | composition | Contract、Pi Models、dynamic import | package-loader/runtime/distribution tests |
| `packages/provider-commandcode-private/src/models.ts` | **33 个模型的唯一权威目录**（id/context/模态/价格/推理档位，来自官方 1.9.0 分析）；`thinkingLevelMap` 生成 | provider factory | `constants.ts`、Pi Model type | `test/unit/commandcode-model-catalog.test.ts` |
| `packages/provider-commandcode-private/src/constants.ts` | provider identity 常量（id/api/baseUrl） | models、provider | none | 被 model tests 覆盖 |
| `packages/provider-commandcode-private/src/model.ts` | 默认模型工厂（从目录取 `deepseek/deepseek-v4-flash`） | provider factory | `models.ts` | `test/unit/commandcode-model.test.ts` |
| `packages/provider-commandcode-private/src/provider.ts` | factory、Pi→wire conversion、request preparation | Provider Package entry | fixed config helper、attempts、semantic、JSON、Pi helpers | golden request、payload authority、boundary/tools/history tests |
| `project.ts` | `createEmptyServerConfig()` | Provider preparation | none | provider/project-compatibility tests |
| `attempts.ts` | prepared request → committed `CommandCodeResult` | Provider stream | fetch/timers/assembler | attempt controls、decoder、retry/cancel integration |
| `assembler.ts` | JSONL lines + EOF → ordered result or typed error | attempts | no other business module | assembler/response lifecycle tests |
| `semantic.ts` | committed result → Pi message/event replay | Provider stream | Pi types/pricing、lossless JSON | semantic/replay/thinking tests |
| `json.ts` | strict lossless JSON clone | provider + semantic | JS reflection only | payload/tool/response fidelity tests |

## 9.5 Concrete import-boundary check

> **小白理解：** 这是一项结构体检：不仅文档说两边分开，源码的 import 也确实没有
> 让 Anthropic 与 CommandCode 直接互相引用。只有启动装配处同时知道两种零件，但
> 日常数据必须经过 Pi 接口。

当前源码检查结果：

```text
src/protocols/anthropic/**
  imports CommandCode modules?  no

packages/provider-commandcode-private/src/**
  imports/names Anthropic or /v1/messages?  no

src/runtime.ts / src/http.ts
  imports either concrete protocol/provider?  no

Node IncomingMessage/ServerResponse
  appears outside server.ts?  no
```

这比仅在文档中声明“解耦”更重要：TypeScript import graph 本身禁止两条 conversion
方向直接依赖。

---

# 10. 测试、Certification 与真实证据

## 10.0 小白导读：从零件质检到真实道路试车

测试不是只问“最后有没有回答”，而是分层确认每个岗位都守住自己的规则。小测试
容易精确定位坏零件，集成测试确认零件能一起工作，Certification 确认装配版本没有
漂移，Online 测试最后走真实网络和真实 Provider。

```mermaid
flowchart TB
    U["Unit\n单个零件质检"] --> I["Integration\n多模块与真实本地 TCP"]
    I --> C["Certification\n核对版本、政策与证据哈希"]
    C --> O["Online\n官方 SDK 到真实 Provider"]
    O --> G["全部 gate 通过\n当前组合才算完成"]
```

## 10.1 五层验证

> **小白理解：** 五层不是重复做同一件事。Unit 回答“一个转换规则对不对”，
> Integration 回答“模块接线对不对”，Certification 回答“现在启动的是不是测试过的
> 那套组合”，Distribution 回答“真实 tarball/node_modules 能否加载”，Online 回答
> “真实客户端与上游是否也按协议工作”。日常测试不会花在线额度。

| 层次 | 目的 | 代表文件 | 是否访问真实 CommandCode |
| --- | --- | --- | --- |
| Unit | 单个 parser/converter/assembler/lifecycle invariant | `test/unit/*.test.ts` | 否 |
| Integration | 多模块真实路径、fixture transport、真实 TCP/SDK/CLI subprocess | `test/integration/*.test.ts` | 否；只在最外部 fetch boundary 注入 fixture |
| Certification | spec hash、immutable conformance record、serving composition identity | `test/certification/*.test.mjs` | 否 |
| Distribution | workspace build/pack、干净临时安装、真实 `node_modules` 动态加载 | `test/distribution/package-smoke.test.mjs` | 否 |
| Online | direct Pi IR + Anthropic/Responses + Codex CLI/Claude Code + 真实 CommandCode | `test/online/*` | 是，五组显式命令 |

普通 `npm test` 不读取真实 key、不自动产生费用。Online runner 独立读取被忽略的
`CommandcodeAPIKey.txt`，默认模型是 `commandcode-private/deepseek/deepseek-v4-flash`，保存脱敏的完整
wire evidence。

## 10.2 Semantic coverage ownership

> **小白理解：** 每类故障都有明确负责的测试。例如拼错 JSONL 由 Provider 拼装测试
> 抓，客户端断线由 HTTP/Desktop recovery 测试抓，credential/lane 隔离由 owning
> authority 测试抓。这样一次失败能指出哪个部门出问题，而不是只留下“端到端失败”。

Immutable serving conformance record 把当前 route 分成这些维度：

```text
inbound grammar and semantics
Pi invocation integrity
Provider request/response conversion
cancellation and terminal consistency
outbound JSON and Atomic SSE
next-turn thinking/tool round trip
serving readiness and isolation
real loopback HTTP boundary
Pi config/credential/CLI
real Provider online conformance
request identity + credential/lane isolation
```

这样失败能定位到 owning boundary，而不是只有一个“端到端失败”。例如：

- malformed JSONL/unknown event/EOF fault 由 deterministic assembler tests 拥有；
- socket disconnect/server shutdown 由 HTTP integration 拥有；
- request identity precedence/fallback 由 request-identity 与真实 handler/HTTP tests 拥有；
- Local Native credential 与 Provider credential isolation 由各自 authority/native-lane tests 拥有；
- current CommandCode request 明确验证不存在 projectDir/project-slug propagation；
- healthy upstream 无法稳定制造的 protocol fault 不伪造成 online case。

## 10.3 Online 测试的数据路径与当前证据

> **小白理解：** 在线测试走的就是用户实际路径：官方 Client 连接本地端口，穿过
> production Runtime、request identity 与选定 lane；Semantic Conversion 场景继续经过
> Client Protocol/Pi/Provider，native 场景则验证自己的 preservation transport。捕获器只坐在
> 最外侧网络出口复印证据，不替换 LuckyToken 内部模块。

```text
official Anthropic SDK / Codex CLI / Claude Code
→ real loopback TCP
→ production Runtime / Request Identity / selected lane
→ Client Protocol + Pi when Semantic Conversion is selected
→ installed CommandCode Provider when that Provider is selected
→ capturing fetch wrapper
→ real https://api.commandcode.ai
```

Capturing wrapper 位于 Provider 的 external transport boundary，不 mock LuckyToken 内部
模块。Evidence 包含 Client request/result/SSE events、Pi→Provider request、完整 raw
Provider JSONL 和 physical EOF。Secret 值不得出现在 artifact；summary 只记录数量、
失败分类和 latency。

2026-08-14 Distribution certification 记录为 `online-passed`：Direct Pi IR 23/23、
Anthropic 60/60、OpenAI Responses 60/60、Codex CLI 60/60（20 场景 × 3）、Claude
Code 51/51（17 场景 × 3）。Codex CLI 版本为 `0.147.0`，Claude Code 为 `2.1.210`。
脱敏摘要保存在 `test/fixtures/certification/online-validation-2026-08-14.json`，详细
artifacts 位于被忽略的 `.online-artifacts/`。Direct probe 从 package factory 导入；
其余套件通过通用 loader 从 `node_modules` 加载，不回退到旧源码 import。

## 10.4 完成 gate

> **小白理解：** Gate 是发布前必须全部打勾的清单：功能测试、类型检查、代码规范、
> 构建、文本差异检查和真实在线测试。修改协议或装配身份时，还要更新认证证据；不能
> 只让某几个单元测试通过就宣布完成。

当前 serving composition 的固定 gate 是：

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run test:distribution
git diff --check
npx tsx test/online/pi-commandcode-ir-probe.ts
npm run test:online
npm run test:online-responses
npm run test:online-codex -- 3
npm run test:online-claude -- 3
```

涉及协议、Pi revision、Provider model/endpoint、request identity、credential authority、
lane eligibility 或 serving boundary 的修改，还必须更新对应 conformance record/hash，
不能只让普通 unit tests 变绿。

---

# 11. 对 AGENTS.md 设计原则的审计

## 11.0 小白导读：用建筑规范检查这座房子

`AGENTS.md` 像项目的建筑规范：不只要求今天能运行，还要求每个房间用途清楚、管线
不乱穿、以后增建时不会牵动整栋楼。本章把抽象原则对应到实际模块，并列出仍需长期
关注的结构压力。

```mermaid
flowchart LR
    RULE["AGENTS.md 原则"] --> OWN["每份信息有明确主人"]
    RULE --> BND["Client ↔ Pi ↔ Provider 边界"]
    RULE --> LIFE["半成品、密钥与配置及时死亡"]
    RULE --> TEST["边界有对应测试"]
    OWN --> AUDIT["架构审计"]
    BND --> AUDIT
    LIFE --> AUDIT
    TEST --> AUDIT
```

## 11.1 符合性矩阵

> **小白理解：** 这张表把“高内聚、低耦合”变成可以核查的证据，而不是口号。比如
> 两个协议目录是否互相 import、Runtime 接口是否足够小、半截工具调用是否会逃出
> owner，都是能从代码和测试中直接验证的事实。

| 原则 | 当前实现证据 | 结论 |
| --- | --- | --- |
| Pi 是 Semantic Conversion 的唯一共享语义边界 | Anthropic/Responses conversion 与 CommandCode package 零互相 import；native lanes bypass Pi IR 且不共享 credential/transport authority | 符合 |
| High cohesion / low coupling | Client Protocol、三条 Data Plane lane、Backend lifecycle、Desktop connection、Provider credential 各自有独立 owner/test | 符合 |
| Capability cohesion | InstanceAuthority、DiscoveryPublication、Provider credential、Codex Local credential、Provider JSONL state 分模块拥有 | 符合 |
| Small contracts | Runtime 只有 `handle(Request)`；InstanceAuthority 只有 `acquire()`；DesktopBackendConnection 只有 `start()/dispose()` | 符合 |
| Information lifecycle | request credential、Control Plane capability、Client Wire、Pi IR、Provider JSONL 都有明确死亡点；不把旧表示跨层保留 | 符合 |
| 模型单一权威来源 | CommandCode 33 个模型只存在于 `models.ts`（官方 1.9.0 数据）；无运行时端点拉取、无第二份模型清单 | 符合 |
| `pi-agent/` 不可变 | 整个 `pi-agent/` 树（源码/生成物/配置/依赖）零修改；只通过 public `Models/Provider/CredentialStore` 接入；上游更新整体替换 | 符合 |
| HTTP failure 信息边界 | Provider 在自己的 transport boundary 有界产生 neutral fact；conversion 只消费 Pi diagnostic，handler 不注入 custom fetch；native passthrough 另用窄 transport | 符合 |
| Streaming lifecycle | Pi/CommandCode/Anthropic 三种 lifecycle 分开；EOF 不等于 success；partial tool state 不 materialize | 符合 |
| Tool identity | 两侧转换都保留 call ID/name/correlation；不按位置猜测 | 符合 |
| Cancellation | socket→HTTP→Pi→Provider→fetch/reader/retry 全链传播；commit 前仍 authoritative | 符合 |
| Configuration ownership | deployment、InstanceAuthority、Discovery、models/public-models、Pi credential、diagnostics 各自分 owner | 符合 |
| No unnecessary Manager/IR | 没有 service locator、Provider registry wrapper、universal request DTO 或第二 IR | 符合 |

## 11.2 Composition root 为什么可以看见两侧

> **小白理解：** 装配工必须同时看见插头和插座，才能把它们接起来；这不等于装配工
> 可以替两边处理业务。`composition.ts` 可以创建 Client Protocol、Pi 和通用 package loader，
> 但不能写“看到某个 Anthropic 字段就生成某个 CommandCode 字段”的翻译规则。

`composition.ts` import 两个 Client Protocol handler、Pi catalog、Provider Package
Contract/loader，但不 import CommandCode 实现。它只做 construction、通用动态加载、
registration 和 provider-neutral certification，没有 message/content/usage/tool conversion。

判断它是否越界的标准是：

```text
允许：create A, create B, inject Pi Models/authorities, select narrow lane seams, certify facts
禁止：if Anthropic field X then emit CommandCode field Y
```

当前代码属于前者。

## 11.3 需要持续关注的边界压力

> **小白理解：** 这些项目不是偷偷欠下的 bug，而是已经明确选择的取舍。例如 Atomic
> SSE 更安全但不是实时吐字，package 动态加载也刻意不扩展为插件市场。未来改变取舍
> 时，应在真正拥有该功能的模块内演进，不能用跨层捷径绕过去。

这些不是被隐藏的功能，而是当前明确 trade-off：

1. **Atomic SSE 不是实时 token streaming。** 完整 Provider result 先 commit，再生成
   全部 Anthropic SSE bytes。优点是错误/取消可以原子 rollback；代价是首 token latency
   和完整 body buffering。若未来要求 progressive streaming，必须重新设计跨三层
   terminal/rollback contract，不能在 `server.ts` 里简单 pipe chunks。

2. **Provider Package loader 只支持显式配置的 npm 根包。** 不自动扫描、安装、热加载，
   也不提供插件市场。新增 Provider 应实现同一个 package seam，让通用 loader 返回
   标准 Pi Provider，而不是把 `composition.ts` 扩成 provider-specific switch。

3. **Backend singleton 使用 dedicated SQLite lock carrier。** `instance.sqlite` 永久存在且
   必须保持 InstanceAuthority 私有；它不是业务数据库、backup source 或 liveness marker。
   Windows 已做 real-process certification；macOS/Linux 在真实 host 上通过同一组 lock/crash
   invariants 前不得宣称平台认证。

4. **Provider factory 的程序化 seam 允许 global fetch fallback。** Certified CLI
   composition 总是 bound fetch 并认证 `globalFetchFallback=prohibited`。其他嵌入方如果
   直接构造 Provider，应显式绑定 fetch，避免 ambient transport。

5. **Client→Pi 可表达不等于当前 Provider 端到端可表达。** 例如 Anthropic
   `strict:true` 可转换为 Pi constrained sampling；CommandCode Provider 按冻结例外将其
   降为普通工具并产生 degradation notice，但不宣称 strict 生效。Image 是否可用仍取决于
   selected model capability；不能把字段到达 Pi 当成具体 Provider 已执行该能力的证据。

6. **Persistence locking 必须由 capability 的真实并发模型决定。** Pi CredentialStore 的
   file lock 解决 concurrent OAuth refresh/login/logout；InstanceAuthority 的 SQLite
   transaction lock 解决 process-lifetime singleton。两者都不能被机械复制到其他 JSON/
   SQLite 文件；Public Models 等其他 authority 按自己的 CAS/debounce/flush lifecycle 处理。

7. **Recognized 与 future-unknown 必须分开处理。** 已识别 Anthropic 字段按冻结方法
   direct map、omit+notice/degrade 或 fail；例如 `top_p` 与 thinking budget 进入 Pi，
   `tool_choice` 没有 Pi 表示时不得伪造控制。未来未知字段只按 owning Client Protocol
   的 unknown-family policy 处理，不能猜语义或借 Provider 行为反推。CommandCode
   响应侧同理：只有规范定义的 content 生命周期进入 content，no-op/未知事件按
   Provider-owned policy 处理。

8. **Provider HTTP 错误只通过 neutral fact 选择性保真。** Provider 在自己的
   transport boundary 有界采集并清洗 status、safe message/type/code、snapshot metadata
   与固定 allowlist headers；Client renderer 只消费 `ExecutionFailure.failure`，不读取
   原始 body。没有 trusted structured fact 时固定 generic 502，不能以 Pi
   `errorMessage` 猜测分类。Native passthrough 的 wire fidelity 属于独立 profile，不能
   用来放宽 conversion failure boundary。

## 11.4 用于代码评审的边界问题

> **小白理解：** 这八个问题是一张维护者检查表。哪怕不会读完整实现，也可以追问：
> 信息从哪里来、谁真正需要、什么时候销毁；某个新功能是否越过 Pi 直接把客户协议
> 接到 Provider。答不清楚时，通常说明模块职责还没有整理好。

修改任何模块时可以按顺序问：

1. 这个 fact 的 producer、carrier、semantic consumer、death point 分别是谁？
2. 新 import 是否跨过 Pi，直接连接一个 Client Protocol 与 concrete Provider？
3. 是否把完整 config/request/store 交给了只需要一个字段的模块？
4. 新 persistent state 是否放在真正拥有其 mutation/lifecycle 的 capability 中？
5. partial stream/tool state 是否可能在 terminal 前逃离 owner？
6. abort 后是否还可能写 response、重试或提交 partial result？
7. 新 abstraction 是否解决已证明的重复/变化，还是只为未来假设？
8. 对应 boundary 是否有 unit、integration 和必要的 real-wire evidence？

---

# 12. 正确扩展方式

## 12.0 小白导读：新增一条线路，不改坏旧线路

好的模块边界意味着增加新协议或 Provider 时，主要工作发生在一个新目录和启动接线
处，而不是到处加入 `if`。下面每节都列出“应该新增什么”和“绝对不该修改什么”，
相当于未来扩建施工图。

```mermaid
flowchart TB
    NEWCP["新增 Client Protocol"] --> CPI["实现 Client Wire ↔ Pi 或明确 native preservation eligibility"]
    CPI --> BIND["Composition 增加独立 handler/lane seam"]
    NEWPV["新增 Provider"] --> PVI["实现 Pi ↔ Provider Wire 或明确 Provider Native transport contract"]
    PVI --> REG["通过 Pi/Provider Runtime 注册"]
    BIND -. "不修改 Provider 翻译" .-> PVI
    REG -. "不修改 Client Protocol 翻译" .-> CPI
```

## 12.1 增加新的 Client Protocol

> **小白理解：** 新 Client Protocol 应当像新开一扇独立服务门：有自己的路由、解析、
> 返回格式和测试；如果需要 semantic conversion，只通过 Pi 这个共享语义插座。如果某些
> request 能 native preservation，也必须由明确 capability contract 决定，不能靠 payload 猜测。

现有 Anthropic / OpenAI Responses 实现是结构参考；新增协议应新增平行目录：

```text
src/protocols/<new-client-protocol>/
  profile/request/options/response/stream/handler...

composition binding:
  route/profile → handler
  optional explicit native eligibility → one lane-specific seam

tests:
  new Client wire ↔ Pi + route isolation + native/semantic boundary + SDK/TCP
```

不得修改：

```text
concrete Provider conversion merely to recognize the new Client Protocol
existing Client Protocol parser/renderer
Runtime into a universal protocol DTO
Pi public contracts merely to carry client-specific convenience fields
```

Runtime 只需多注册一个独立 method/path handler。

## 12.2 增加新的 Private Provider

> **小白理解：** 新 Provider 像增加一家供应商专员：实现 Pi 要求的模型、登录和执行
> 接口，再在启动时登记。Anthropic 或 OpenAI 模块不需要增加“如果是这家供应商”
> 的判断，因此所有已存在的 Client Protocol 都能自动通过 Pi 使用它。

应实现一个新的 Pi `Provider` capability：

```text
Pi Context/Options → concrete upstream request
concrete upstream lifecycle → Pi AssistantMessageEventStream
Provider.auth
Provider.getModels()
```

将它包装为根入口固定导出 `providerPackage` 的 workspace/npm 包，依赖
`@luckytoken/provider-contract/package`。若它属于产品内置能力，应加入 bundled Provider
metadata，由 Backend 自动装配；若它是用户外部扩展，才通过 `providerPackages` 以 npm 根
包名配置。通用 loader/runtime 会完成版本/Provider 验证、冲突预检和 Pi 注册；无需修改
Client Protocol 或增加 provider-specific routing 分支。静态 model config、credential
method、request/response conversion、retry/cancel/online conformance 仍由新包独立拥有和
测试。不得修改 Anthropic/OpenAI adapters 来识别该 Provider。

## 12.3 增加更多 CommandCode models

> **小白理解：** 多模型主要是“目录和选择”问题，不应重新发明 CommandCode 协议
> 翻译。先让 Pi 的模型目录、名称消歧、Provider catalog 和认证清单支持多项；实际
> 请求仍携带已经选定的那个 Pi `Model`。

当前 33 个 CommandCode models 的唯一权威来源是 Provider Package 的 `models.ts`。
增删模型只应修改 package-owned catalog、model resolution/certification 期望及对应
测试；不需要在 `models.json` 复制条目。CommandCode wire conversion 应继续只消费
invocation 中已 resolved 的 `Model`。

## 12.4 更新 Pi

> **小白理解：** Pi 是项目中间的标准接口，升级它像更换整座建筑的统一插座标准：
> 先更新正式依赖并审查上游参考源码，再核对两侧接口和全部测试。不要为了省事直接
> 修改仓库中的 Pi 参考副本，否则以后无法清楚同步上游。

1. 更新 npm dependency/审查对应 `pi-agent/packages/ai` upstream snapshot；
2. 不在 vendored package 中加入 LuckyToken patch；
3. 重新核对 `Models/Provider/CredentialStore/EventStream` public contracts；
4. 运行 Pi runtime fidelity 和所有两侧 conversion tests；
5. 更新 Pi protocol evidence、integrity 与 serving certification hash。

## 12.5 替换文件存储

> **小白理解：** 存储方式可以从 JSON 换成数据库或其他介质，但 authority 的小接口和
> 生命周期不能顺便改掉。Provider credential、Public Models、diagnostics、discovery 与
> singleton lock carrier 都是不同抽屉。

- 替换 Pi credential persistence：实现同等 `CredentialStore`/CAS 语义，不改 Provider login 或 Client Protocol；
- 替换 Public Model/settings/history storage：保持各 authority 的 revision/flush/ownership contract；
- 替换 Control Plane discovery storage：只改变 publication/read adapter，绝不能重新承担 singleton/liveness；
- 替换 `InstanceAuthority` primitive：必须重新通过 process contention、event-loop suspension、crash release、same-process multi-connection 与 real-platform certification；不能退回 stale timeout/PID probing；
- 替换 deployment config format：仍然在 composition 前结束完整 config lifecycle，下游只接收窄 constructor facts。

---

# 13. 阅读顺序

## 13.0 小白导读：三条阅读路线

不需要从第一行读到最后一行。根据目的选择一条路线：

```mermaid
flowchart TB
    Q{"你想了解什么？"}
    Q -->|"项目总体做什么"| A["先读 1、2、8、11 章"]
    Q -->|"一次请求怎么走"| B["读 3 → 4 → 5 → 6 → 7 章"]
    Q -->|"以后怎样扩展"| C["读 9、11、12 章"]
    B --> D["再按本节源码顺序核对"]
```

零编程经验的读者可以只读每章的 `X.0 小白导读`、所有“小白理解”旁注和 Mermaid
图；需要做技术判断时，再阅读紧随其后的原接口、表格和不变量。两条阅读层描述的是
同一套系统，不是两个不同设计。

如果要判断一个实际请求是否符合架构，建议按这条顺序阅读：

> **小白理解：** 下面顺序像沿着包裹追踪记录逐站检查：先看服务如何组装，再看请求
> 怎样进入和认证，然后看两次翻译与中间 Pi 接口，最后用规范和测试核对。不要只盯着
> 某个代码片段猜整条链路。

1. `src/application.ts` → `instance-authority.ts` / `control-plane-discovery.ts`：Backend 如何取得 authority、启动和关闭；
2. `packages/desktop-shell/src/main/desktop-backend-connection.ts`：Desktop 如何 discovery/attach/recover；
3. `src/server.ts` → `runtime.ts` → `http.ts`：Data Plane request 如何进入/取消；
4. `src/credentials/authority.ts` 与 `src/integrations/codex/local-auth.ts`：Provider credential 与 Local Native credential 如何保持隔离；
5. `src/protocols/anthropic/handler.ts`，再分别进入 request/options/response/SSE；
6. Pi `Models.streamSimple()` public contract；
7. `src/providers/package-loader.ts` → `@luckytoken/provider-commandcode-private` →
   `provider.ts` → project/attempts/assembler/semantic；
8. 对应 Protocol/Conversion Spec；
9. owning unit/integration test、serving conformance record，以及深度在线证据
   （`test/online/deep-online.ts`、`test/online/event-coverage.ts`）——后者证明
   真实上游上"Anthropic 只转换指定字段、CommandCode 只有指定 event 进 content"。

不要从 `composition.ts` 的同时 import 两侧推断存在“Anthropic→CommandCode
converter”；真正的数据转换必须分别在 Client Protocol 与 Provider boundary 中找到。
