# Token Provider Native 上行信封 Pi 对等计划

Status: **离线信封认证通过且完整 integration 串行通过；“上游无法区分 Token 与 Pi”尚未证明**（2026-09-29：D1 通过、D5=B2′、D6 已执行；在线金丝雀按用户要求不运行）
Owner: Provider Native lanes（`src/provider-native-responses/`、`src/provider-native-anthropic/`）

阅读说明：§1 的“当前”差距与 §4.2–§4.5 的手工补头步骤是立项时的基线和路线 A 备选，不描述 D5 采纳 B2′ 后的当前实现；当前契约以 §3.4、§5 的已决定项、§7 和对应 Native Contract 为准。

“上游无法区分”比本计划的信封认证更强：Provider 还能看到客户端 JSON 经 SDK 序列化后的 body、实际 HTTP 栈产生的头与编码、连接读取/取消时序和重试。Native 的 body 以 Client JSON 为权威，而 Pi 适配器从 `Context` 构造 body；两者对任意请求不保证相等。当前离线测试主要在注入的 `fetch` 边界比较请求，响应由 Native lane 自行缓冲而非交给 Pi 消费。因此本计划完成不能被表述为全链路不可区分。

关联契约：

- `doc/Spec/TokenProviderCredentialProfilesPRD.md` §29、§435、§476、§487、§507、§515、§890、§891
- `doc/Protocols/OpenAI Responses Client Protocol.md` §1.2
- `doc/Spec/TokenProviderNativeAnthropicContract.md`
- `AGENTS.md`：Independent lanes / Semantic Conversion boundary

> 本文档区分**已确认事实**（源码与实测 capture）与**推断**（标注为推断）。所有 header 结论来自本机探针，方法见附录 B。

---

## 1. 问题

### 1.1 契约要求

Provider Native 只允许替换 body 中已认证的最小差异（顶层 `model` 投影、Responses 的 tool-call adjacency、Anthropic OAuth 差分），其余一切"看起来必须是 pinned Pi Agent 发出来的"：

- PRD §487：重建 method、URL、auth、account identity、Provider/version/beta/session/**User-Agent** 头与内容编码。
- PRD §507：客户端注入的同名头不得覆盖这些重建值。
- PRD §890/§891：Anthropic 侧必须发出 pinned Pi Agent 的 **SDK identity**；Responses 侧 SDK/版本/beta 头同样归重建方所有。
- PRD §515：发布认证需要覆盖 `(providerId, provider api, operation, authType)` 的 **request-envelope parity** 测试矩阵。

### 1.2 实测差距（已确认事实）

方法：同一个 capture fetch 分别驱动 pinned Pi 适配器与 Token sender，对比完整 header 集合（附录 B）。

| transport | 结果 | 差异 |
|---|---|---|
| `openai-codex-responses`（SSE） | **完全一致** | URL、`accept`、`openai-beta`、`originator: pi`、`user-agent: pi (...)`、`chatgpt-account-id`、`session-id`、`x-client-request-id`、`content-encoding: zstd`、body 压缩级别均相同。WebSocket 属于文档显式排除项 |
| `openai-responses`（api_key） | 不一致 | 缺 `user-agent: pi (<platform> <release>; <arch>)`；缺 7 个 `x-stainless-*`（`package-version: 6.40.0`、`lang`、`os`、`arch`、`runtime`、`runtime-version`、`retry-count`）；生产路径还缺 `x-stainless-timeout` |
| `azure-openai-responses` | 不一致 | 同 `openai-responses`（Azure SDK 由 `openai` 包派生，版本同源）。URL/`api-version`/`api-key` 已一致 |
| `anthropic-messages` | 不一致（差异最大） | `user-agent` 为 `Anthropic/JS 0.91.1` 而非 `pi (...)`；`x-stainless-package-version` 为 `0.91.1` 而非 `0.124.0`；缺 `x-stainless-timeout`；URL 缺 `beta=true`；`anthropic-beta` 计算规则与 Pi 不同 |

由此产生的**线上可见差异**（推断，但机制明确）：`openai-responses` / `azure` 用裸 fetch 且未设 `User-Agent`，undici 会补默认 `user-agent: node`（本地 HTTP server 实测确认），即当前发出的是"Node 身份"而非"Pi 身份"。

### 1.3 根因

1. **SDK identity 常量取自错误的依赖树。** `src/provider-native-anthropic/transport.ts` 的 `ANTHROPIC_SDK_VERSION = "0.91.1"` 对应 Token 自己的 `package.json` 依赖（`@anthropic-ai/sdk@0.91.1`），而 pinned Pi 运行时解析到的是 `@earendil-works/pi-ai` 自带的 `0.124.0`（npm 未提升，仍是嵌套安装）。`openai` 恰好被提升且两边都是 `6.40.0`，属于巧合而非机制保证。
2. **手抄遗漏。** `openai`/`azure` sender 只重建了稳定头，没有重建 SDK identity 头，也没有与 Pi 行为比对的机制。
3. **Anthropic 未复刻 SDK 调用形态。** Pi 走 `client.beta.messages.create(...)`（恒带 `?beta=true`）并使用 SDK 默认 `x-stainless-timeout`；Token 手工拼固定头集合，且 `anthropic-beta` 只按 `piBetaFeatures`（tools/thinking 两条）计算，漏掉 `allowedFallbackModels`、`supportsMidConvoEffort`、mid-convo tool changes 等分支。
4. **认证测试只覆盖子集。** `test/unit/responses-native-provider-pi-parity.test.ts` 只断言 `stableHeaders` 子集，显式排除了 `x-stainless-*` 与 `user-agent`；Anthropic 侧没有任何 Pi parity 测试，只有断言 Token 自己头集合的 certification 测试。

### 1.4 影响

- **契约层面**：当前实现不满足 PRD §487/§507/§890 与 §515 的认证要求，Anthropic lane 的 drift 不会被任何现有测试发现。
- **上游行为层面**：`x-stainless-*` 是 SDK 身份头，通常不改变上游行为（推断，缺少上游文档证据）；`anthropic-beta` 会被上游当作语义开关，属于真实行为差异；`User-Agent`/`originator` 是否参与上游风控与计费归属未验证。
- **可维护性层面**：每次升级 `@earendil-works/pi-ai` 都可能静默改变 Pi 实际发出的信封，而 Token 的手抄值不会随之更新。

---

## 2. 目标与非目标

### 2.1 目标

- **G1**：对每个已认证的 `(providerId, api, operation, authType)` 元组及可由 Client JSON 重建的请求事实，Provider Native 上行信封与 pinned Pi 运行时逐字段一致：method、URL（含 query）、全部 header、内容编码。§5 D2 的 Context 专属 beta 与 Cloudflare 仅有 `cf-aig-authorization` 时的 SDK 发前拒绝是两项显式例外；不能把它们记录为 Pi parity 通过。
- **G2**：该一致性由自动化 parity 认证保证——Pi 运行时升级导致漂移时测试失败，而不是线上静默漂移。
- **G3**：客户端 JSON 的模型可见语义仍是权威。D5 已选择 B2′，因此保真定义为**经过 pinned SDK 的 parse/serialize 表示归一化后 JSON 值等价**，并额外禁止 SDK/Token 注入未请求字段；不再承诺 whitespace、property formatting、numeric lexical spelling 或 `-0` 之类表示细节。
- **G4**：不引入 lane 之间的耦合，也不让 Provider Native 进入 Pi Provider 执行或 Pi IR。

### 2.2 非目标

- WebSocket transport（Pi Codex 默认 `transport: "auto"`）；协议文档已声明 parity 不含 WebSocket。
- 复用 Pi 的 Provider 执行、Pi IR 或 Pi 语义构造器（`onPayload` 方案，见 §3.3）。
- 在本地 patch/fork Pi 加宽公共契约（§3.5 的上游 seam 只能由上游发布）。
- 改动 Semantic Conversion、Direct Mode 或任何 response 路径。
- 上游行为/风控影响的产品决策（见 §5 决策点）。

---

## 3. 解决思路

### 3.1 路线 A（默认）：在 lane 内重建信封，用认证测试锁住 Pi 行为

Provider Native 自己构造 header 并调用与 Pi 相同的 `fetch`（生产环境都是 `globalThis.fetch`，见 `src/application.ts`）。差异补齐到"逐字段等价"，由 parity 认证测试作为唯一的行为真相来源。

关键设计：**版本事实不在运行时与 Pi 共享代码，而在测试中与 Pi 对齐。** 每个 lane 保留自己的常量（避免 lane 耦合），由一个测试同时驱动 Pi 适配器与 Token sender 并 diff 全量 header；常量写错或 Pi 升级都会立刻失败。

路线 B（§3.4 的 B2′）是同一目标下的另一条实现路径，由决策 D5 选择；两者共用 §7 的认证矩阵。

### 3.2 否决：让厂商 SDK 同时负责请求与响应（方案 B 的原始形态）

把 body 交给 SDK 序列化本身已由决策 D5 处理（用户接受放弃逐字节保真）。方案 B 在此之外仍然不可用，因为响应侧无人接管：SDK 在非 2xx 时 `makeStatusError` 抛错并消费 raw error body，成功路径的 `withResponse()` 也会解析并消费 body，而 native lane 必须原样转发上游状态、错误体与 SSE 字节。因此请求侧可以交给 SDK，响应侧必须由 lane 接管——即 §3.4 的 B2′。完整评估见 §3.4。

### 3.3 否决：调用 Pi API adapter + `onPayload` 替换 body（方案 C）

需要构造 Pi `Context` 并进入 Pi Provider 执行，违反 `AGENTS.md` 的 lane 独立与 "Client Protocol production modules do not create or depend on `onPayload`" 约束，也是最典型的 payload projector 反模式。

### 3.4 评估：Provider Native 直接用厂商 SDK（方案 B/B1/B2）

问题："让 SDK 自己生成信封，是否比手抄更好？" 结论：**若接受放弃 body 逐字节保真（决策 D5），则 B2′ 是最接近 Pi 的可行形态，推荐采纳**；否则只能维持 §4 的手抄方案。

**四种可能的形态**

| 形态 | 做法 | 结果 |
|---|---|---|
| B | 构造与 Pi 相同的 SDK client，把 body 作为 params 传入，由 SDK 发送 | 信封天然一致；**body 被 SDK 重新序列化** |
| B1 | 只借用 SDK 生成信封（`client.buildRequest()` 在 `openai` 与 `@anthropic-ai/sdk` 的 `.d.ts` 中是公开方法，`buildHeaders` 是 private），自己 `fetch` 发送 | 信封一致；**URL 的 `?beta=true` 与 `betas` → `anthropic-beta` 转换发生在资源层，不在 `buildRequest`**，需要自行补齐 |
| B2 | 调用 SDK 资源方法（如 `client.beta.messages.create`），在传给 SDK 的 `fetch` 里替换 `init.body` 为客户端原文，并向 SDK 屏蔽真实 Response（避免它解析/消费 SSE） | 信封与 URL 完全由 SDK 生成；代价是**双向拦截**，必须主动对抗 SDK 的响应解析、重试与超时 |
| B2′ | 同 B2，但**不替换 body**（接受 SDK 序列化）：`fetch` 包装器只做一件事——把真实 Response 交给 lane、返回合成响应给 SDK | 信封、URL、body 序列化全部由 SDK 负责，拦截只剩响应一侧 |

**支持 SDK 的事实**

- 两个 SDK 都不自行写 `content-length`（实测与源码确认），替换 body 后由 undici 按实际字节计算，B2 的 body 替换在这一点上安全。
- `Accept` / `Content-Type` 不随 params 内容变化（Responses/Messages 端点均为 `application/json`，实测一致），B2 不需要镜像 body 特征来维持头正确。
- SDK 升级带来的信封变化会自动跟随，消除"手抄版本常量"这一整类漂移。

**成本与风险清单**

1. **body 保真被破坏（仅当 D5 = 否时是决定性反对项）**：B/B2′ 必须把 body 交给 `JSON.stringify`。协议文档明确要求保留客户端空白与 JSON 数字拼写（`doc/Protocols/OpenAI Responses Client Protocol.md` §1.2），Anthropic lane 也刻意用带 offset 的 JSON 树做 splice（`src/provider-native-anthropic/body-projection.ts`）。这是已冻结的契约，改变它需要 D5 与契约文本同步更新。
2. **省不掉工作量的主体**：`anthropic-beta` 列表规则、session affinity 默认、`claude-cli` 身份、fine-grained tool streaming 判定全部位于 **pi-ai 适配器层**，不在 SDK 内。用 SDK 只省掉 8 个常量与平台映射。
3. **版本解析不可靠**：Token 无法可靠 import `@earendil-works/pi-ai` 的嵌套依赖。`@anthropic-ai/sdk@0.91.1` 正是 Pi 0.84.2 时代的对齐遗留（见 `doc/PiAI-0.84.2-Upgrade-Audit.md`），Pi 升到 0.86.1/0.87.0 后已变成 `0.124.0`。走 SDK 路线必须把该依赖重新钉到 Pi 的声明版本并加门禁，否则"用 SDK"会发出比手抄更错的信封。
4. **Token 源码当前不 import 任何厂商 SDK**（`@anthropic-ai/sdk` 仅被测试与文档引用），引入它是新的依赖方向，需要 spec owner 明确它是否触碰 §476 的 lane 独立性边界。

**路线分叉**：手抄方案（§4）的负担是"永远可能跟着 Pi 升级改常量"；B2′ 的负担是"钉版依赖 + 响应截取包装 + 边界确认"，换来"信封不再由我们抄"。两者的共同前提都是 §7 T2 的全量 parity 认证——它无论走哪条路都必须先有。

**若采纳 B2′（决策 D5：放弃逐字节保真）**

B2′ 之所以"最像 Pi"，是因为请求侧完整走 Pi 的代码路径：同一个 client 构造、同一个资源方法、同一份 params 派生逻辑，因此**信封与 URL 不再取决于"我们抄全了没有"**。手抄只能证明"我抄到的字段是对的"，无法证明"我没漏掉 SDK 新增的行为"；B2′ 自动继承全部行为，包括难以手抄的分支——例如 Anthropic beta 资源层会依据 `body.tools` / `body.messages` 追加 helper 头，并把 `betas` 移出 body 转成 `anthropic-beta` 头，同时把路径固定为 `/v1/messages?beta=true`（见 `@anthropic-ai/sdk/resources/beta/messages/messages.mjs`）。

必须同时满足以下不变量，否则 B2′ 会退化成"发错信封且无人察觉"：

1. **依赖版本钉到 Pi 的声明值**（`openai@6.40.0`、`@anthropic-ai/sdk@0.124.0`），并加门禁测试；现有 `@anthropic-ai/sdk@0.91.1` 必须改。
2. **复刻 Pi 的 client 构造**：baseURL 归一化、`defaultHeaders` 合并顺序（`User-Agent` → `model.headers` → copilot 动态头 → session affinity → options 头）、`dangerouslyAllowBrowser`、`fetch` 注入、OAuth 分支的 `claude-cli` 身份。
3. **复刻 params 派生决策**（`betas` 列表、thinking、模型投影、Anthropic OAuth 差分）——这部分工作量与手抄方案相同，用 SDK 只省掉"格式化成头/URL"和 8 个常量与平台映射。
4. **响应必须截取**：真实 `Response` 交给 lane，合成响应返回给 SDK。原因（已确认）：两个 SDK 在非 2xx 时都会 `makeStatusError` 抛错并消费 raw error body（`openai/client.mjs`、`@anthropic-ai/sdk/client.mjs`），而 native lane 必须原样转发上游状态与错误体；成功路径上 `withResponse()` 也会解析并消费 body。
5. **信号隔离**：不得把 SDK 的超时 `AbortSignal` 透传给真实 `fetch`，否则 SDK 超时会在流式读取中途 abort 我们的连接。
6. **断言 SDK 不给 body 注入未请求字段**（`betas` 被移出 body 是期望行为，其它注入必须被测试捕获）。

**若采纳 B2′，需要同步修改的契约文本**：`doc/Protocols/OpenAI Responses Client Protocol.md` §1.2 的 "whitespace / JSON numeric spellings" 措辞、PRD §891（"decoding the bytes yields the preserved client body" 改为 JSON 语义等价）、PRD §476/§515（认证方式从"逐字段重建"改为"必现差异清单 + 信封 parity 认证"）。Anthropic lane 的 offset 树 splice（`src/provider-native-anthropic/body-projection.ts`）在此路线下可以简化。

**若最终选择手抄方案的触发条件回顾**：当 Pi 适配器层的动态头继续增长（例如每个模型/兼容位都引入新头），或 SDK 提供官方 raw-body 入口时，重新评估 B2′。

### 3.5 备选：上游 Pi native passthrough seam（不在本次范围）

能真正把"Pi 升级 → native lane 不用改"变成事实的，只有一种形态：Pi 公开一个 native passthrough 的 adapter 契约——

```text
输入：resolved Model、auth、不透明且已校验的 body、少量 envelope 事实
输出：完整 wire request（URL、header、编码），envelope 规则由 Pi 拥有
```

现状为什么做不到（已确认事实）：

- Pi 的 API adapter 是 IR→wire。`Models.streamSimple(model, context, options)` 必须拿到 Pi `Context`，而 native lane 手里只有 raw body。
- 部分 header 由 `Context` 而非 body 派生：例如 `github-copilot` 的 `X-Initiator`/`Openai-Intent` 取 `context.messages`，Anthropic 的 `fine-grained-tool-streaming` beta 取 `getCurrentTools(context.messages)`。喂占位 `Context` 会静默发错头。
- 唯一现成的 payload 替换口 `onPayload` 在 `createClient` 之后执行，改不了上述头；且属于 payload projector，`AGENTS.md` 禁止 protocol 生产模块创建或依赖它，`src/execution.ts` 也会主动拒绝带 `onPayload`/`onResponse` 的语义执行选项。
- 绕过方式都不是"复用 Pi"：造忠实 `Context` 等于把 Semantic Conversion 再做一遍，且对客户端未知字段不可行。

因此该 seam 必须由上游加宽公共契约，`AGENTS.md` 已规定 Token 不 patch/fork Pi 来加宽边界。若未来上游发布该能力，`transports/<provider-api>.ts` 的内部实现可直接替换为委托调用，lane 核心、契约、观测、重试均不变——这也是 §4.7 模块化的长期收益。

代价（即便上游提供）：Token 的发布节奏与 Pi 绑定；PRD §515 的认证负担从"逐字段重建"转为"验证上游 seam 符合契约"。

---

## 4. 具体实现

### 4.1 共同部分

1. 每个 transport 一个"上行信封"职责（现有 `buildUpstreamHeaders` / sender 内联块收敛到此），输入为：resolved `Model`、`AuthResult`、请求生命周期事实（session、retry/attempt、effective timeout）、**body 中已被认证可用于头推导的事实**（如 tools 是否存在、thinking 是否声明、oauth 模式）。
2. 引入 effective request timeout 事实：Semantic lane 目前把 `timeoutMs` 传给 Pi（`src/protocols/anthropic/handler.ts`、`src/protocols/openai-responses/semantic.ts`），SDK 据此发出 `x-stainless-timeout: <trunc(timeoutMs/1000)>`。Native lane 必须拿到同一个值（见 §5 决策 D3）。
3. 客户端注入的冲突头继续一律丢弃（现有行为已正确）：`user-agent`、`x-stainless-*`、`anthropic-beta`、`x-session-affinity`、`session_id`、`x-client-request-id` 等必须由 lane 重建。

### 4.2 `openai-responses`（`src/provider-native-responses/openai.ts`）

新增（值来自 pinned Pi 运行时，`openai@6.40.0`）：

- `user-agent: pi (<process.platform()> <os.release()>; <process.arch()>)`
- `x-stainless-package-version: 6.40.0`
- `x-stainless-lang: js`、`x-stainless-os: <Windows|MacOS|Linux|...>`、`x-stainless-arch: <x64|arm64|...>`
- `x-stainless-runtime: node`、`x-stainless-runtime-version: <process.version>`
- `x-stainless-retry-count: 0`（见下）
- `x-stainless-timeout: <trunc(effectiveTimeoutMs/1000)>`，仅当 Pi 那侧实际会带（生产路径会带）

注意：`x-stainless-retry-count` 在 Pi 当前 wire 下恒为 `0`——SDK 内建重试关闭（`maxRetries: 0`），Pi 用自己的 retry helper 重新调用 SDK，因此每次物理尝试都是新的 SDK 请求（已确认事实，来自 Pi 源码）。Token 的物理重试循环同样发送 `0`，不要自行递增。

平台映射必须与 Stainless 一致（`Windows`/`MacOS`/`Linux`、`x64`/`arm64`/`x32`/`arm`），可与 Anthropic lane 现有 `normalizedPlatform()`/`normalizedArchitecture()` 对齐——**不共享模块，各自持有**（lane 独立）。

### 4.3 `azure-openai-responses`（`src/provider-native-responses/azure.ts`）

同 §4.2（AzureOpenAI 由 `openai` 包派生，SDK 版本同源）。`api-key` 与 session 差异保持现状。

### 4.4 `openai-codex-responses`（`src/provider-native-responses/codex.ts`）

无需改动。补一条回归断言，防止未来"统一信封"重构把它改回 SDK 形态。

### 4.5 `anthropic-messages`（`src/provider-native-anthropic/transport.ts`）

1. **SDK identity**：`user-agent` 由 `Anthropic/JS 0.91.1` 改为 `pi (<platform> <release>; <arch>)`；`x-stainless-package-version` 由 `0.91.1` 改为 `0.124.0`（pinned Pi 运行时自带版本）。`ANTHROPIC_SDK_VERSION` 常量重命名/改义，避免继续暗示"Token 依赖版本"。
2. **URL**：追加 `beta=true`（Pi 恒走 `client.beta.messages.create`）。
3. **`x-stainless-timeout`**：Pi 侧恒有（SDK 默认 600s，或 Pi 传入 `timeoutMs` 时的截断秒数）。Native lane 取同一 effective timeout。
4. **`anthropic-beta` 复刻 `getBetaFeatures`**（顺序与去重语义一致）：
   - 配置覆盖优先：`model.headers`/auth headers 中的 `anthropic-beta` 若存在则**完全取代**计算结果；显式 `null` 表示空列表（Token 当前会忽略 `null` 并继续用计算值 —— 差异）。
   - OAuth 分支：`claude-code-20250219`、`oauth-2025-04-20`。
   - `fine-grained-tool-streaming-2025-05-14`：body 有 tools 且 `compat.supportsEagerToolInputStreaming !== true`（现有实现已对）。
   - `interleaved-thinking-2025-05-14`：`model.reasoning && thinkingEnabled === true && interleavedThinking !== false && compat.forceAdaptiveThinking !== true`（现有实现**无条件**加，需按 body 中的 thinking 事实收敛）。
   - `server-side-fallback-2026-07-01`：`compat.allowedFallbackModels?.length > 0`（当前**缺失**）。
   - `mid-conversation-output-config-2026-07-01`、`thinking-binding-controls-2026-08-01`：`compat.supportsMidConvoEffort === true`（当前**缺失**）。
   - `mid-conversation-tool-changes-2026-07-01`：Pi 的 `nativeToolChanges` 条件（需要 initial tools + mid-convo tool changes 支持 + 无 tool 重定义）——native lane 不持有 Pi `Context`，建议明确声明为"不重建"并记录理由，或降级为按 body 近似（见 §5 决策 D2）。
5. **session affinity**：Pi 规则为 `compat.sendSessionAffinityHeaders ?? (provider === "openrouter" || baseUrl 含 openrouter.ai)`，头名 `x-session-id`（openrouter）/`x-session-affinity`（其他）；Token 当前只认显式 compat 标志，缺少 openrouter 默认（差异）。
6. **OAuth 分支**：`claude-cli/<version>` + `x-app: cli` 保持（与 Pi 参考实现一致）。

### 4.6 事实来源

- 行为真相：根 `package.json` 精确 pin 的实际安装 `@earendil-works/pi-ai`（`node_modules/@earendil-works/pi-ai/dist/api/*.js`）。
- 可读镜像：checked-in `pi-agent/packages/ai/src/api/*.ts`（0.86.1 快照，SDK 依赖声明与运行时一致：`openai@6.40.0`、`@anthropic-ai/sdk@0.124.0`）。
- 参考快照的 SDK 声明属于快照自身，不能用来 pin 当前 Native SDK。当前版本自动从已安装 Pi manifest 对齐；公共 User-Agent 直接调用 Pi，Claude OAuth 身份值由升级命令提取。**运行时为准**，快照仅作审阅参考；剩余私有信封规则须在每次升级时行为对照。详见 `TokenPiAIUpgradeAuditProcedure.md`。

### 4.7 模块化目标布局（与信封补齐分开做）

现状不对称：Responses lane 已是"每 transport 一个模块 + `contract.ts` 接缝"（`openai.ts` 304 行、`codex.ts` 166、`azure.ts` 159），响应缓冲留在协议侧；Anthropic lane 把信封、派发、响应缓冲与头过滤都塞进 `transport.ts`（852 行），响应被缓冲后才返回 lane。同一职责在两处形态不同。

目标布局（每个 lane 内部）：

| 模块 | 职责 |
|---|---|
| `index.ts` | lane 核心：`claims()`、凭证绑定、重试、profile 切换、观测 |
| `contract.ts` | transport 接缝：输入 resolved Model/auth/body/session/timeout，输出原始 `Response` |
| transport 模块 | 一个 provider API 一个模块（`openai-responses`、`openai-codex-responses`、`azure-openai-responses`、`anthropic-messages`），只负责请求投影、SDK/信封与派发，并返回原始 `Response` |
| response-processing 模块 | 原子缓冲、安全响应头过滤、响应 alias 投影与使用量观察；不得回流到 transport 信封构造 |
| `certification.ts`（数据） | `(providerId, api, operation, authType) → transport` 的封闭数据；routing 与 certification 测试都从它派生 |

边界要求：

1. **封闭表，不做运行时注册口**。Pi 需要开放注册表是因为它服务任意第三方 Provider Package；Token 的 Provider Native 是已认证封闭集合，开放注册会绕过认证与凭证绑定。对应的禁止项写入文档：Provider Package 不得声明进入 native lane。
2. 响应缓冲/头过滤统一归位到 response-processing 所有者：transport 返回原始 `Response`，不得读取 Provider response body。
3. 不抽跨 lane 共享的"通用 transport"。两条 preservation lane 各自持有实现，允许受控的局部重复（`AGENTS.md` 的 lane 独立约束）。
4. 先做纯结构调整（行为不变，用现有测试证明等价），再做信封补齐或 B2′，避免 parity diff 无法区分重构差异与新补差异。

---

## 5. 需要拍板的决策点

| 编号 | 问题 | 建议 |
|---|---|---|
| D1 | 是否接受"把 SDK identity 改成 Pi 身份"（含 `user-agent: pi (...)`、`originator`、`x-stainless-*`）的上游与合规影响 | **已决定：接受**，按 PRD §487/§890 执行 |
| D2 | `mid-conversation-tool-changes` 这类需要 Pi `Context` 才能判定的 beta | **已决定：不重建**。Native 无 Pi `Context`，不得推测或引入 Pi IR；这是 G1 的显式例外，未来若公共契约提供可验证的事实再重审 |
| D3 | effective timeout 的传递方式：新增 lane 输入事实，还是复用协议 handler 的 `requestTimeoutMs` | **已决定：显式传递 `requestTimeoutMs`**，由 handler 传入，lane 不读全局配置 |
| D4 | 版本常量与 Pi 升级的同步方式 | **已决定：B2′ 使用与 pinned Pi 声明一致的厂商 SDK 依赖**，T7 校验版本；不引入跨 lane 运行时共享模块 |
| D5 | **是否放弃 body 逐字节保真以换取 B2′（SDK 生成信封）** | **已决定：采纳 B2′**，按 §3.4 的 6 条不变量实现，并同步修改契约文本。body 保真定义为 pinned SDK parse/serialize 归一化后的 JSON 值等价 + 无未请求字段注入 |
| D6 | 是否执行 §4.7 的模块化重构（每 API 一 transport、统一响应缓冲归位、封闭认证表） | **已决定：执行，且先于 B2′ 落地**；纯结构调整，用现有测试证明行为等价 |
| D7 | 是否向 pi-ai 上游提出 native passthrough seam 提案（§3.5） | 建议提出（RFC/issue），但不得在本地 patch/fork Pi 加宽边界；上游接受前 §4 或 B2′ 是唯一实现路径 |

---

## 6. 可能遇到的问题

1. **依赖解析不稳定**：`openai` 被 npm 提升而 `@anthropic-ai/sdk` 未提升，任何"从 Token 自己的 node_modules 读版本"的做法都可能读到错版本。解决：常量显式声明 + parity 测试兜底；不要在运行时 `import` 厂商 SDK 只为取版本。
2. **平台映射差异**（`Windows` vs `win32`、`MacOS` vs `darwin`）会静默产生不一致，需专门用例覆盖三个平台字符串。
3. **超时语义**：`x-stainless-timeout` 表达的是 SDK 客户端超时，不是 Token 的服务端上限；若两者不一致会把上游可见语义和实际行为分离（例如声明 600s 但 Token 30s 就取消）——需要 D3 明确后统一。
4. **重试语义**：不要"改进"为递增 retry-count，Pi 当前 wire 恒为 0。
5. **credential profile 切换**：429 切换 profile 后重发的物理请求必须重新构造整套头（含 account identity 与 SDK identity），现有 `profile_attributed` 观测路径已具备重建点，需补测试。
6. **既有测试/fixture 依赖旧值**：`test/unit/anthropic-passthrough-certification.test.ts`、`test/integration/anthropic-provider-native.test.ts`（断言 `claude-cli/2.1.75`）等需同步更新；`test/unit/responses-native-provider-pi-parity.test.ts` 需从子集断言升级为全量断言。
7. **在线行为变化**：`anthropic-beta` 组合变化可能改变上游响应形态（例如多出 `server-side-fallback`），需要在线金丝雀，不能只看单测。
8. **不引入功能开关**：信封对齐是契约，不做灰度开关；如需回滚，按 transport 维度回滚提交。

---

## 7. 测试与认证

1. **T1 信封单元断言**：每个 sender 断言**完整** `Headers` 集合（既不多也不少），按 `(provider, api, authType, 平台, timeout 是否设置)` 参数化。
2. **T2 信封认证（核心）**：普通 Responses 与 Anthropic Messages 用同一 capture fetch 驱动 Pi 适配器与 Token sender，diff method/URL/全量 header。Pi 无 compact 资源方法；OpenAI/Azure compact 用 Pi 普通 Responses 比对 SDK 拥有的头，并独立锁定 compact endpoint/body；Codex compact 用 Pi SSE 身份头与独立 compact 契约。managed/ambient 若产出相同 `AuthResult`，sender 信封相同，绑定路径另由 integration 认证。Cloudflare header-only 和 D2 beta 必须作为显式例外测试，不能计入全量 Pi parity。
3. **T3 负向注入**：客户端提供冲突的 `user-agent`、`x-stainless-*`、`anthropic-beta`、`x-session-affinity`、`session_id`，断言出站值等于重建值。
4. **T4 body 保真**：B2′ 下，把客户端 JSON 先经过与 pinned SDK 相同的 parse/serialize 表示归一化，再与出站 JSON deep-equal，并额外断言 SDK/Token 未注入未请求字段；允许 whitespace、property formatting、numeric lexical spelling 和 `-0 → 0` 等表示归一化。method、URL、全量 header 集合与上游响应转发方式由独立 parity 断言锁定。
5. **T5 生命周期**：物理重试与 429 profile 切换后，头集合按同一规则重建（retry-count 保持 0，timeout/身份正确）。
6. **T6 lane 隔离**：沿用现有 certification（`test/certification/semantic-conversion-isolation.test.mjs`、`provider-native-auth-coverage`），确认没有新增跨 lane import。
7. **T7 升级门禁**：新增断言——pinned `@earendil-works/pi-ai` 声明的 `openai` / `@anthropic-ai/sdk` 版本与各 lane 常量一致，失败信息给出两侧版本。
8. **测试安全**：任何能触达 Codex 状态的测试必须使用新建临时 `CODEX_HOME`（AGENTS.md 规则），只复制 `config.toml` 与 `token-model-catalog.json`，`finally` 清理。

### 7.1 认证矩阵（当前 tuple，来源为源码 allowlist）

PRD §515 要求的矩阵必须逐 tuple 有认证用例；同一信封的 managed/ambient 分支分别记录，compact 按上文的可用参考源认证。当前集合：

| api | providerId 集合 | operation | authType |
|---|---|---|---|
| `openai-responses` | `openai`、`xai`、`opencode`、`opencode-go`、`cloudflare-ai-gateway`、`github-copilot`、`commandcode-goat` | `responses` | managed / ambient |
| `openai-responses`（compact） | `openai`、`xai`、`opencode`、`opencode-go`、`cloudflare-ai-gateway`、`github-copilot` | `compact` | managed / ambient |
| `openai-codex-responses` | `openai-codex` | `responses`、`compact`（SSE） | managed（OAuth） |
| `azure-openai-responses` | `azure-openai-responses` | `responses`、`compact` | managed / ambient |
| `anthropic-messages` | `anthropic`、`github-copilot`、`cloudflare-ai-gateway` | `messages` | `api_key` / `oauth` / `github_copilot` / `ambient` |

注意两点：`commandcode-goat` 只被认证 Responses、未认证 compact；Anthropic 的四种 authType 对应不同的身份与 beta 分支，不能只取一条代表。

---

## 8. 实施顺序

1. 先写失败测试：全量 parity（T2）+ 升级门禁（T7），锁定当前 4 条 lane 的差距。
2. 纯结构调整（§4.7）：拆分 Anthropic transport、统一响应缓冲归位、把 allowlist 收敛成认证表；行为不变，用现有测试证明等价。
3. 修 `openai` / `azure`：SDK identity 头 + timeout 事实（§4.1/§4.2/§4.3）；若 D5 = 是，改为实现 B2′ 并保留同一契约与测试。
4. 修 `anthropic`：identity、`?beta=true`、timeout、beta 规则、session affinity（§4.5）；同样受 D5 影响。
5. 补负向注入与生命周期测试（T3/T5）。
6. 更新文档：PRD §515 的认证矩阵条目、`doc/Protocols/OpenAI Responses Client Protocol.md` §1.2 措辞（明确"含 SDK identity 与 User-Agent"）、Anthropic 侧协议文档、以及 §9 的镜像面表。

---

## 9. Pi 镜像面与升级流程

跨模块的统一升级审计流程见 [`TokenPiAIUpgradeAuditProcedure.md`](./TokenPiAIUpgradeAuditProcedure.md)。下表是其中 Provider Native 边界的专项检查；运行时发布包仍是行为真相。

Native lane 对 Pi 的**类型耦合**只有 5 个公开类型（`FetchFunction`、`ProviderHeaders`、`Model`、`Models`、`AuthResult`，全部为 `import type`），因此升级几乎不会触发编译错误；真正的成本在**镜像的 wire 行为**，它漂移时是静默的。下表是升级时必须逐条重验的清单。

| 镜像点 | Token 位置 | Pi 参考源（0.86.1 快照路径） | 重验时机 |
|---|---|---|---|
| OpenAI Responses envelope、URL、session affinity、copilot 动态头 | `src/provider-native-responses/openai.ts` | `pi-agent/packages/ai/src/api/openai-responses.ts`（`createClient` / `buildParams` / session affinity） | 每次 pi-ai 升级 |
| Codex SSE envelope、account id 提取、zstd | `src/provider-native-responses/codex.ts` | `pi-agent/packages/ai/src/api/openai-codex-responses.ts`（`buildSSEHeaders` / `resolveCodexUrl` / `extractAccountId` / 压缩） | 每次 |
| Azure endpoint、deployment、api-version | `src/provider-native-responses/azure.ts` | `pi-agent/packages/ai/src/api/azure-openai-responses.ts`（`resolveAzureConfig`） | 每次 |
| Anthropic envelope、beta 列表、OAuth 身份、session affinity | `src/provider-native-anthropic/envelope.ts` + `transport.ts` | `pi-agent/packages/ai/src/api/anthropic-messages.ts`（`mergeClientHeaders` / `getBetaFeatures` / `getAnthropicCompat`） | 每次 |
| SDK identity 版本号 | 两个 lane 的常量 | `pi-agent/packages/ai/package.json` 的 `openai` / `@anthropic-ai/sdk` 声明 | 每次（由 T7 门禁自动发现） |
| 模型投影与 Responses adjacency | `tool-call-adjacency.ts` / `body-projection.ts` | Token 自有契约（`doc/Spec/TokenProviderNativeResponsesToolCallAdjacencyNormalizationPlan.md`）；仅当 Pi 语义变化影响该契约时重验 | 按需 |
| 响应侧三处有界重写（SSE 生命周期、function-call namespace、alias 投影） | `src/protocols/openai-responses/*` | Token 自有契约 + Pi Provider 行为参考 | 按需 |

升级 checklist（沿用 `doc/PiAI-0.84.2-Upgrade-Audit.md` 的形态）：

1. 提升运行时 pi-ai 依赖；checked-in 快照仅在另有维护需求时更新，行为以新安装的发布包为准。按 B2′ 同步厂商 SDK 直接依赖。
2. 跑 certification + parity（T2/T7），记录红点。
3. 逐条 diff 上表的"Pi 参考源"，对照运行时 `node_modules/@earendil-works/pi-ai/dist/api/*.js`（运行时为准）。
4. 更新常量/规则、fixture 与本文档。
5. 在线金丝雀属于另行授权的发布验证；未运行时记录为未验证，不得算入离线认证结果。
6. 按统一流程新增 upgrade audit，逐项记录各边界及 native lane 的影响（包括"无影响"的结论）。

---

## 10. Definition of Done

在本计划范围内，满足以下全部条件才算完成：

1. §7.1 矩阵中的每个 tuple 都有与 §7 T2 的参考源相符的信封认证用例并通过；Cloudflare header-only 与 D2 beta 例外单独断言并记录，不计作全量 Pi parity。
2. T3 负向注入用例通过：客户端提供的 `user-agent`、`x-stainless-*`、`anthropic-beta`、`x-session-affinity`、`session_id` 一律不能覆盖重建值。
3. T4 按 D5/B2′ 的结论通过：pinned SDK parse/serialize 归一化后的 JSON 值等价，且无未请求字段注入；表示级 JSON 差异不作为失败。
4. T7 升级门禁存在，且失败信息能直接指出两边的版本值。
5. T5 生命周期用例通过：物理重试与 429 profile 切换后的头重建正确。
6. §5 的 D1–D5 全部有明确结论并落到文档（未决项不得留在实现里）。
7. §9 的镜像面表更新完毕，且下一次升级可以只依赖该表 + 测试红点完成。
8. 相关契约文档已同步：PRD §515 矩阵、`doc/Protocols/OpenAI Responses Client Protocol.md` §1.2、`TokenProviderNativeAnthropicContract.md`；B2′ 的 JSON 语义保真/SDK 序列化契约已替代旧逐字节措辞。
9. 在线金丝雀通过：每个认证 provider 至少一条最小请求。**这是发布门禁；离线实现完成不等于该项已通过。**
10. 若执行了 §4.7 结构调整，行为等价由现有测试证明，且未引入跨 lane import（T6）。

---

## 附录 A：逐 header 期望矩阵（目标状态）

`R` = 重建（Pi 拥有的值，客户端不可覆盖）；`M` = 来自 resolved Model/auth 头；`—` = 不发。

| header | openai-responses | azure | codex (SSE) | anthropic |
|---|---|---|---|---|
| `authorization` | R `Bearer <apiKey>` | — | R `Bearer <token>` | R `<x-api-key>` 或 OAuth `Bearer` |
| `api-key` | — | R | — | — |
| `user-agent` | R `pi (...)` | R `pi (...)` | R `pi (...)` | R `pi (...)`（OAuth 分支 `claude-cli/<ver>`） |
| `accept` | `application/json` | `application/json` | `text/event-stream` | `application/json` |
| `content-type` | `application/json` | `application/json` | `application/json` | `application/json` |
| `content-encoding` | — | — | `zstd`（可压缩时） | — |
| `openai-beta` | — | — | `responses=experimental` | — |
| `originator` | — | — | `pi` | — |
| `chatgpt-account-id` | — | — | R（JWT claim） | — |
| `session_id` / `session-id` | `session_id`（openai 格式） | — | `session-id` | — |
| `x-client-request-id` | 有 | — | 有 | — |
| `x-stainless-package-version` | `6.40.0` | `6.40.0` | — | `0.124.0` |
| `x-stainless-lang/os/arch/runtime/runtime-version` | 有 | 有 | — | 有 |
| `x-stainless-retry-count` | `0` | `0` | — | `0` |
| `x-stainless-timeout` | 有（effective timeout） | 有 | — | 有（SDK 默认 600s 或 effective timeout） |
| `anthropic-version` | — | — | — | `2023-06-01` |
| `anthropic-dangerous-direct-browser-access` | — | — | — | `true` |
| `anthropic-beta` | — | — | — | 按 `getBetaFeatures`（配置覆盖优先） |
| `x-app` | — | — | — | OAuth 分支 `cli` |
| URL query | — | `api-version=<v>` | — | `beta=true` |
| Model/auth 头 | M | M | M | M |

---

## 附录 B：证据方法

探针（临时目录 `.codex-tmp-probe/`，不进入提交）：

1. `azure-headers-probe.ts`：以同一 capture fetch 分别调用 `@earendil-works/pi-ai/api/azure-openai-responses` 的 `stream()` 与 `src/provider-native-responses` 的 Azure sender，打印完整 header 集合（`openai` 与 `openai-codex` 用同一形态的探针验证后已删除）。
2. `anthropic-headers-probe.ts`：同上，对比 `anthropic-messages` 与 `src/provider-native-anthropic/transport.ts` 的 `passthroughAnthropicRequest()`。
3. `undici-wire-probe.mjs`：本地 `node:http` server 记录真实到达的头，用于确认裸 fetch 未设 `User-Agent` 时 undici 补 `user-agent: node`。

如需把这些证据固化为回归测试，按 §7 的 T2 形态重写（探针本身不进入仓库）。
