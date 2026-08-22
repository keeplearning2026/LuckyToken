# LuckyToken 项目分析 / Project Analysis

**文档性质：** 当前项目快速导览（current overview & map）

**源码基线：** Provider Credential Profiles v1.5 implementation（2026-08-22）

**权威架构：** [LuckyToken Core Architecture Specification](./Spec/LuckyTokenCoreSpec.md)

**Desktop 架构：** [LuckyToken Electron Product Architecture Specification](./Spec/LuckyTokenElectronArchitectureSpec.md)

**实现维护者地图：** [LuckyTokenArchitecture.md](./LuckyTokenArchitecture.md)

**设计约束：** [AGENTS.md](../AGENTS.md)

**Provider credential authority：** [Provider Credential Profiles PRD v1.5](./Spec/LuckyTokenProviderCredentialProfilesPRD.md)；旧 one-slot `pi/auth.json` 描述均为历史资料。

本文只提供快速上下文，不复制完整规范。若本文与 Spec 或当前源码冲突，以 owning Spec + 当前源码为准。

---

## 1. 一句话认识

**LuckyToken 是一个本地 AI 模型路由与协议边界产品。**

它当前包含：

- Node/TypeScript Backend Application；
- Electron + React Desktop Shell；
- Application Control Plane；
- Anthropic Messages 与 OpenAI Responses Client Protocol；
- Local Native、Provider Native、Semantic Conversion 三条独立 Data Plane lane；
- Pi AI runtime / Provider system；
- CommandCode Private Provider package；
- Provider credential、Catalog、Public Model、Diagnostics、History、Backup、Codex integration 等 Backend-lifetime authority。

Windows 当前已通过真实 packaged product E2E 与 SQLite singleton certification。macOS/Linux 的实现保持结构可移植，但尚未通过真实平台认证。

---

## 2. 第一原则：三条 Data Plane lane 互不耦合

当前不是“所有请求都先转 Pi”的单线路 Router。

```text
Client Request
      │
      ▼
route / model resolution
      │
      ├── Local Native Preservation
      │     └── local Codex/native credential + native wire transport
      │
      ├── Provider Native Preservation
      │     └── Provider credential + provider-native Responses transport
      │
      └── Semantic Conversion
            └── Client Protocol ↔ Pi AI IR ↔ Pi Provider
```

冻结约束：

- 三条 lane 不互相 fallback；
- 不允许 native → Pi → native re-entry；
- Local Native 不依赖 Pi Models / Provider Native / semantic conversion；
- Provider Native 不依赖 Local Native / Client Protocol conversion；
- Semantic Conversion 继续遵守 `Client Wire ↔ Pi` 与 `Pi ↔ Provider Wire` 两侧隔离；
- concrete Provider vocabulary 不进入 Client Protocol；Client Wire vocabulary 不进入 Provider。

---

## 3. 当前 Backend 多进程架构

LuckyToken 现在有两个主要生命周期域：

```text
Backend lifecycle
Desktop connection lifecycle
```

### 3.1 Backend lifecycle

```text
Backend Process
│
├── InstanceAuthority
│    └── InstanceLease
│         └── ~/.luckytoken/instance.sqlite
│             BEGIN IMMEDIATE
│
└── BackendApplication
     ├── management authorities
     ├── Control Plane
     ├── DiscoveryPublication
     ├── Provider Runtime / Catalog / Credentials
     ├── Persistence / Diagnostics / History / Backup
     └── Data Plane Supervisor
```

`InstanceAuthority` 是 Backend singleton 的最终 correctness authority。

核心语义：

- `instance.sqlite` 文件存在本身没有任何 liveness/ownership 含义；
- active SQLite transaction lock 才表示 singleton ownership；
- 不使用 stale timeout、heartbeat、PID probing、steal 或锁文件删除；
- `InstanceLease` 覆盖整个 Backend 生命周期，并在其他 Backend-lifetime resource 完成 teardown 后最后释放；
- owner 在 discovery publish 前死亡时，竞争进程会重新 acquire，而不是永久等待 stale descriptor。

### 3.2 Management Ready / Operational state

启动顺序：

```text
acquire InstanceLease
→ load/validate config
→ construct management authorities
→ start Control Plane
→ publish DiscoveryPublication
================ Management Ready
→ start Data Plane / background work
================ Running / Degraded
```

因此 Data Plane 启动失败不会杀死 Management Plane。Control Plane 仍可用于 diagnostics、settings、recovery 和 restart。

---

## 4. Control Plane Discovery 只负责“去哪里连接”

当前 discovery 默认路径：

```text
~/.luckytoken/control-plane.json
```

它只表示：

> “可以尝试在这个 endpoint 连接当前 Backend Control Plane。”

它**不表示**：

- Backend singleton ownership；
- Backend 一定活着；
- Backend 一定健康；
- Data Plane 一定 running。

`ControlPlaneDiscovery` 的语义是：

```ts
read(): Promise<ControlPlaneEndpoint | undefined>
publish(endpoint): Promise<DiscoveryPublication>
```

`DiscoveryPublication.close()` 只撤销自己发布的内容；stale publication 不得删除新 Backend publication。

生产 `serve` 不允许自定义 discovery descriptor。`--descriptor` 只属于 `control ...` 客户端导航参数，避免 singleton domain 与 discovery domain 被用户配置拆开。

---

## 5. Electron Desktop lifecycle

Electron Main 不拥有 Backend domain state。

```text
Electron Main
│
└── DesktopBackendConnection
     ├── ControlPlaneDiscovery
     ├── BackendLauncher
     ├── ControlPlaneSession
     └── DesktopOwnerLease
```

### DesktopBackendConnection

它拥有完整的 connection/recovery 算法：

```text
discover
→ connect + hello
→ build/owner policy
→ attach
→ bind DesktopOwnerLease
```

session loss 后：

```text
discard old endpoint assumption
→ fresh discovery
→ connect new/current endpoint
→ no usable publication only then launch candidate
```

不再对启动时捕获的旧 endpoint 重试固定次数。

### BackendLauncher

Launcher 只负责创建 bundled Backend process：

```ts
launch(): Promise<SpawnedBackend>
```

`SpawnedBackend` 只提供 startup diagnostics：

- `pid`；
- `exited`；
- `release()`。

Launcher 不知道 discovery、readiness、singleton、build replacement 或 Backend domain recovery。

### build handoff

- 初次启动发现 stale desktop-owned Backend build：通过 Control Plane graceful quit 后替换；
- CLI-owned Backend：保留并 attach，不抢 ownership；
- 已运行 shell recovery 时发现另一个 desktop build 已成为 authority：当前 shell 退化为 viewer，不回滚新 build、不 claim 新 lease、不 Product-Quit 新 Backend，也不在新 Backend 退出后再次 respawn 它。

---

## 6. Desktop owner lease

Desktop-owned Backend 的 retention authority 是 logical lease，不是 Electron PID。

```text
claim leaseId
→ periodic renew
→ Backend TTL expiry on lost owner
```

这允许 shell upgrade/handoff 而不依赖 parent PID。

Product Quit 的能力判断也不是仅看：

```text
status.ownership.owner.kind === "desktop"
```

而必须同时满足当前 shell 真正持有 active `DesktopOwnerLease`。viewer shell 或被新 shell supersede 的旧 lease 只能退出自己的 Electron，不得关闭别人的 Backend。

---

## 7. Request identity 与 credential ownership

当前 LuckyToken **没有 global/project client-token 系统，也没有 `client-token` CLI**。

四类事实必须分开：

```text
Request Identity
Local Native credential
Provider credential
Control Plane capability
```

### Request Identity

`src/request-identity.ts` 从已知 session headers 中选择合法 UUID；没有可用 client session 时生成 request-local UUID。

结果只包含：

```text
effectiveSessionId
clientSessionId?
```

Semantic Conversion 可将 `effectiveSessionId` 投影到 Pi `Options.sessionId`。

### Local Native credential

例如 Codex Local Native：request Bearer credential 只在该 native lane 的 credential authority 内验证和转发；不进入 Pi AI IR 或 Provider credential store。

### Provider credential

Provider Profile lifecycle、exact request binding 与 per-Provider record 由 Backend-lifetime Profile State Owner 拥有；Pi `Models` 只通过 composition-private bound `CredentialStore` adapter 看见当前 operation 的一个 Profile。

### Control Plane capability

Control Plane descriptor 中的 capability 只认证本地 management IPC，不是 Data Plane client credential。

---

## 8. CommandCode Private 当前项目语义

CommandCode Private 作为独立 Provider package：

```text
@luckytoken/provider-commandcode-private
```

Semantic Conversion lane 中：

```text
Client Protocol
↕
Pi Model + Context + Options
↕
CommandCode Private Provider
↕
/alpha/generate JSONL
```

当前 Provider：

- 使用 `Options.sessionId` 建立 `threadId` 与 `x-session-id`；
- 当前不从 Pi metadata 派生 project/workspace state；
- `config` 使用固定 empty `ServerConfig` compatibility representation；
- 不执行 project filesystem/Git scan；
- 不建立 `projectDir → x-project-slug` flow；
- Private Protocol 的 exact field/event conversion 继续由 Protocol/Conversion Spec 拥有。

---

## 9. Codex integration

Codex integration 现在是 Backend-owned integration authority，而不是要求用户手工创建 LuckyToken client-token/profile。

启用后 LuckyToken 管理 Codex root routing keys：

```text
model_provider = "openai"
openai_base_url = "http://127.0.0.1:<public-model-port>/v1"
model_catalog_json = "<LuckyToken-managed catalog>"
```

同时保留 preimage，因此 disable/shutdown 可以恢复原值。Public Model snapshot generation 用于判断是否需要重新同步 catalog。

---

## 10. 主要持久化 owner

```text
~/.luckytoken/
├── instance.sqlite               # InstanceAuthority lock carrier only
├── control-plane.json            # discovery publication only
├── config.json                   # deployment config
├── models.json                   # LuckyToken-owned models/provider config
├── public-models.json            # PublicModelAuthority
├── settings.json                 # registered settings
├── state/
│   ├── openai-responses.json     # bounded Responses session state
│   ├── diagnostics/              # Runtime Diagnostics SQLite
│   ├── request-ledger/           # Request Ledger SQLite
│   └── deep-diagnostics/         # Deep Diagnostics SQLite
├── integrations/codex/           # LuckyToken Codex integration state/catalog
└── pi/
    ├── credential-profiles/      # per-Provider credential Profile records
    └── models-catalog-cache.json # Provider model cache
```

`instance.sqlite` 是 InstanceAuthority 私有 lock carrier，不参与业务 backup、diagnostics、catalog 或通用文件扫描。

---

## 11. Windows 当前认证状态

当前 Windows release evidence 覆盖：

- SQLite `BEGIN IMMEDIATE` 跨进程 singleton；
- event-loop freeze 不失锁；
- process crash 后无 repair 自动释放；
- 20 process concurrency exactly one winner；
- same-process two SQLite connections exclusion；
- packaged Electron renderer destroy/recreate；
- Electron forced death → DesktopOwnerLease expiry → Backend retirement；
- legacy/new build handoff；
- same-build shell handoff；
- first successful product request；
- Provider activation journey。

macOS/Linux 目前只保留结构可移植性声明，不能写成“已认证”。

---

## 12. 阅读顺序

需要理解当前项目时，推荐：

1. `AGENTS.md` — 全局不可破坏原则；
2. `doc/Spec/LuckyTokenCoreSpec.md` — Core/Data Plane ownership 与三 lane；
3. `doc/Spec/LuckyTokenElectronArchitectureSpec.md` — Backend/Desktop lifecycle；
4. `doc/LuckyTokenArchitecture.md` — 当前源码维护者地图；
5. `src/application.ts` — Backend Application composition/lifecycle；
6. `src/instance-authority.ts` + `src/control-plane-discovery.ts` — singleton / discovery；
7. `packages/desktop-shell/src/main/desktop-backend-connection.ts` — Desktop recovery；
8. `src/composition.ts` + `src/protocols/` + Provider packages — Data Plane request paths；
9. owning unit/integration/certification/product-E2E tests。
