# Token × opencodex OpenAI Responses Adapter 对比报告

> **历史对比，非当前规范。** 本文记录的 Lucky HEAD、session-state 行为与部分 SSE/compaction 结论已经过期；其中 `HttpObserver`/fetch-observation 描述明确属于 Ticket 27 前的历史基线，当前 conversion 不再使用该 side channel。当前权威合同见 [`ProtocolConversion-Completeness-Audit.md`](./ProtocolConversion-Completeness-Audit.md)、[`Protocol Conversion Architecture and Policy.md`](./Protocols/Protocol%20Conversion%20Architecture%20and%20Policy.md) 与 [`OpenAI Responses-Pi AI IR Conversion Method.md`](./Protocols/OpenAI%20Responses-Pi%20AI%20IR%20Conversion%20Method.md)。opencodex 目录仅能由 package manifest 确认标称 `2.13.0`，因无 `.git` 不能证明源码 revision。

> 日期：2026-08-12
> 类型：只读对比分析（未修改任何代码）
> 基线：`codex/openai-responses-protocol` @ `ac9fa9a`（HEAD `01ff355` 与基线仅差 `doc/HANDOFF.md`，代码无差异）
> 对比对象：Token `src/protocols/openai-responses/` 五模块 + 共享 `options/upstream-failure/models-discovery` + 组合根；
> opencodex `src/responses/{state,parser,spill-store,…}`、`src/adapters/openai-responses.ts`、
> `src/server/responses/core.ts`、`src/server/responses-json-events.ts`、`src/bridge.ts`、
> `src/server/{relay,relay-eager,ws-bridge}.ts`
> 前序文档：[OpenAIResponsesAdapter-Research.md](./OpenAIResponsesAdapter-Research.md)（提炼/放弃决策）、
> [OpenAI Responses Client Protocol.md](./Protocols/OpenAI%20Responses%20Client%20Protocol.md)（v0.1.0，D1–D12）

## 总体结论

Token 的实现是 opencodex 机制的最小化、边界收紧的重写：保留「保存 input+output → 按 `previous_response_id` 展开拼接」语义，丢弃了 opencodex 因**多租户代理 + 多 Provider + 原生转发**才需要的全部设施。核心语义（fail-open、incomplete 仅 `max_output_tokens` 可存、2s debounce + tmp/rename 原子写、32MB 解析上限、corrupt 备份 + 空启动）与 opencodex 一致。

主要差异集中在：`store:false` 处理、replay 失败策略（fail-open vs 结构化 400）、磁盘/内存分层（无 spill/字节预算/TTL）、输入 item 覆盖度（少 6 类，多 1 个严格校验）、以及「不 import 具体 Provider」的 Pi IR 边界（opencodex 无此约束，其 parser 直接耦合 web-search/image 合成工具与 bridge）。

## 1. 会话状态

| 维度 | opencodex（`src/responses/state.ts`） | Token（`session-state.ts`） | 差异影响 |
|---|---|---|---|
| 保存条件 | `store===false` 且非 `force` 则跳过；其余 completed / incomplete(仅 max_output_tokens) 保存 | **忽略 `store`**：所有合法 completed/incomplete(max_output_tokens) 一律保存；同样拒绝其他 incomplete/failed | 决定性差异：Codex 每个 HTTP 请求都带 `store:false`。opencodex 靠 WS 通道传 `force` 才保住 WS 链；Token 统一无条件保存，保证 HTTP 与 WS 续接都可用（D7）。语义更简单，代价是本地缓存更满（有 1000 条封顶兜底） |
| 反污染 | 未展开成功时**不保存**（`passthroughRecordEligible = !_compactionRequest && (!prevId \|\| 已展开)`） | 同样不保存「自身 previous 未展开」的轮次（D8）；**额外**拒绝 compaction 轮次 | 一致（D8 对应 opencodex 的 passthrough 保护）；Token 把 compaction 排除也做进了 store 自身 |
| 内存/磁盘分层 | 三层：resident / spill（磁盘文件 + stub）/ spill-failed（墓碑）；64MB RAM 硬预算（按需 demote 到 spill）；单 spill 256MB 上限 | 单层：全部 resident Map；仅 1000 条 FIFO 上限 + 32MB 快照文件上限；**无字节预算、无 spill、无墓碑** | Token 单实例、单会话场景下内存可控；opencodex 的 spill 是为「多租户代理 + forced store:false 的 kiro/cursor 续接链」（每次存全量展开 input，字节近似二次方增长）设计的。Token 无此负载，spill 属过度设计 |
| TTL | 1h TTL（`sweepExpiredResponseStates` + prune） | 无 TTL | 差异：opencodex 用 TTL 防陈旧续接；Token 认为 entry cap 已界磁盘，TTL 增加复杂度且会误杀合法长会话（D4 有记录）。风险：Token 的 1000 条若全被长会话占满，新会话会被挤掉 |
| 快照格式/原子写 | version 1/2 兼容读；`responses-state.json`；2s debounce；atomicWriteFileAsync（tmp+rename）；单飞 gate；`pendingSpillUnlinks` 延迟 unlink 防 crash 悬空 stub | version 2；`openai-responses.json`（可配置 stateFile）；2s debounce + unref；`<name>.<pid>.<seq>.tmp` + rename；单飞 gate；tmp 0600 | 机制一致（D3 就是抄的 opencodex）。opencodex 快照写有 24MB 总量/2MB 单条上限、4 次 rewrite 尝试、目录 fsync；Token 无单条/总量裁剪，快照整体一次性写。Token 小体量下可接受，但长会话（单条 >2MB）会让快照文件显著膨胀 |
| 加载失败 | >32MB 拒绝解析（空启动）；corrupt → 空启动；符号链接/FIFO 防御；孤儿 tmp 双向清扫（含 symlink 解析后的真实目录） | >32MB 拒绝；corrupt → 备份 `.corrupt` + 空启动；孤儿 tmp 单向清扫（仅字面目录） | 核心一致（D10）。Token 缺少 symlink 解析后的双目录清扫与 FIFO 防御，属于边缘风险（本地单用户可接受） |
| 展开 fail-open | `expandPreviousResponseInput`：未知 id → 原样返回（fail-open）；**但** `previousResponseReplayFailure` 对「spill 读失败/墓碑」返回结构化错误，core.ts 用 `previous_response_not_found` 400 拒绝 | `expand`：未知 id → 原样返回；**无任何 400 路径** | 语义分歧：opencodex 对「本地知道有这条，但读不出来」**fail-closed 400**（明确提示重发全量）；对「根本没有这条」fail-open。Token 对所有 miss 一律 fail-open。Token 风险：墓碑/spill 场景不存在（无 spill），所以 miss 只能来自「真没有」或「快照损坏已空启动」，fail-open 合理；但缺了 opencodex 的**可观测性**（日志警告 + 结构化错误），排障时无法区分 miss 原因 |
| 快照恢复后 prune | 加载后按同样 admission 边界（超预算直接 spill） | 加载后仅 evictIfNeeded 按 count | 一致的小差异：Token 加载只按条数裁剪 |

## 2. Wire 映射（input items → 内部消息）

| 维度 | opencodex（`parser.ts`） | Token（`request.ts`） | 差异影响 |
|---|---|---|---|
| 校验策略 | **宽容**：zod schema（`schema.ts`）宽松 + catch-all 兜底；畸形 item 常被跳过/降级（注释明确「malformed message 落到 permissive catch-all」） | **严格**：`validateResponsesRequest` 手写校验，类型不符即 `InvalidRequest` 400；未知 item type、未知 reasoning.effort、孤儿 function_call_output 直接拒绝 | 关键差异。opencodex 为「多 Provider 原生转发」容忍畸形（避免污染历史 400 死锁）；Token 只有单条转换路径，严格校验更早暴露错误。但孤儿 `function_call_output` 拒绝存在 opencodex 已处理过的风险：重放历史里可能带孤儿输出，Token 会把整轮打成 400 |
| 内容 part | 支持 `input_text`/`text`/`input_image`(dataURL/file_id/detail)/`input_file`/`refusal`/`encrypted_content`；图片**结构化保留**（绝不内联为文本，防 token 爆炸）；file_id → `[file: …]` 标记 | 仅 `input_text`/`text`/`output_text` + `input_image`（仅 data: base64，无 file_id/detail）；其余静默丢弃 | Token 缺 `input_file` 与 `file_id` 图片引用（Codex 传 file_id 时会丢附件），缺 `refusal` 降级（refusal → `[refusal: …]`）。中风险：Codex 上传附件场景下历史会丢图/文件 |
| 图片 | 结构化 image part 转发 | base64 dataURL → Pi ImageContent（正确） | 方向一致；Token 缺 file_id 分支 |
| 工具定义 | `buildTools`：function/namespace(展平带 ns)/custom(自由格式 → input 字符串)/tool_search(**映射为可调函数**)/未知命名工具 **透传为函数**；仅 web_search、image_generation 两种 OpenAI 托管工具丢弃 | function/namespace(展平无 ns)/custom(→ input)；**tool_search 丢弃**；未知命名工具丢弃；同样丢弃 web_search/image_generation | Token 少两能力：tool_search（Codex 延迟工具/子代理网关）被丢，模型看不到可调工具；namespace 展平时丢失 namespace（Pi Tool 无 ns 字段，opencodex 在 bridge 层用 `namespacedToolName` 恢复）。对纯本地 provider 影响中低，但 Codex 多 MCP 工具下工具名可能冲突 |
| reasoning 附着 | 复杂：pending 缓冲 + `assistantHolderWithReasoning`（跨 call item 保持）+ `attachPendingReasoningToCallOwner`（补挂到 call owner，防 DeepSeek 400）+ ocxr1 信封签名回放 | 简化：pending 缓冲 + 附着到**下一个 assistant** 消息；`function_call` 后的 reasoning 会丢失 | Token 少了「reasoning 出现在 function_call 之后」的补挂（opencodex 因 DeepSeek thinking 模式 400 才加的）。若上游是 CommandCode(DeepSeek)，历史回放可能触发同样 400 |
| compaction | `compaction`/`compaction_summary` 解码 ocx1 信封还原摘要文本；`context_compaction` 无 payload 时**纯标记静默丢弃**（摘要随后单独作为 user 消息）；`compaction_trigger` → 服务端生成合成 compaction 输出 | 三类都降级为 user 文本（`[compacted conversation: N bytes…]`），`context_compaction` 无 payload 时丢弃；`compaction_trigger` 静默丢弃（不生成输出） | 功能级差异：opencodex 能真正还原压缩摘要（自有信封可解码），Token 只能降级为占位文本，模型丢失压缩历史细节；compaction_trigger 不回复合成 compaction item 时，Codex 可能在远程压缩协议下卡住 |
| 其他 | `agent_message`(含 content parts 保留)、`web_search_call`(丢弃)、`tool_search_call`(**转为 assistant toolCall 保留历史**)、`tool_search_output`(转为 toolResult + 注入 loaded tools)、`local_shell_call`(转为 toolCall 防孤儿)、`custom_tool_call(_output)`、`additional_tools`(合并) | `agent_message`(仅文本)、`web_search_call` 丢弃、`tool_search_call` **丢弃**、`tool_search_output` **不支持**、`local_shell_call` **不支持**、custom/additional_tools 支持 | Token 少 6 类：`tool_search_call/output`、`local_shell_call`、`web_search_tool_call`、未知类型直接 400（opencodex 有 catch-all 兜底）。Codex 默认不启用 tool_search，风险可控；但 WebSocket/桌面端可能带 `local_shell_call` 重放 |
| 选项 | top_p/stop/parallel_tool_calls/presence/frequency/service_tier/prompt_cache_key/**text.format 结构化输出**/tool_choice(含 allowed_tools) 全部转换 | top_p、tool_choice 仅**校验不转换**；无 stop/penalties/结构化输出；temperature/max_output_tokens/reasoning 转换 | Token 选项面窄是刻意取舍（Pi 闭集只有 maxTokens/temperature/reasoning/metadata，composeOptions 白名单强制），与 AGENTS 的「Pi 闭集」一致；缺 text.format 意味着 Codex 结构化输出请求会被静默忽略 |

## 3. 输出（Pi → wire）

| 维度 | opencodex（`bridge.ts` / `responses-json-events.ts`） | Token（`response.ts` / `sse.ts`） | 差异影响 |
|---|---|---|---|
| item 形状 | 流式增量：`output_item.added` + `output_text.delta`/`function_call.arguments.delta`，组装后 `output_item.done`；reasoning 单独 item + summary | **原子合成**：仅 `output_item.done`（无 added/delta）；reasoning → `summary_text` item | Token 首版刻意不做 per-delta（spec §7）。Codex 接受原子序列，但工具参数增量、文本流式渲染、首 token 延迟体验差；opencodex 流式路径已稳定 |
| usage | input_tokens 含 cache read/write；`input_tokens_details.cached_tokens` 恒存在（**严格客户端反序列化必填**，grok-build 实测硬失败）；output_tokens_details.reasoning_tokens 恒存在 | input_tokens = input+cacheRead+cacheWrite；`input_tokens_details` 恒存在；`output_tokens_details` **仅 reasoning>0 时存在** | 差异风险：Token 的 `output_tokens_details` 条件性缺失可能让严格 Responses 客户端（grok-build 风格）硬解析失败。建议无条件输出零值（opencodex 因实测踩坑才改的） |
| stopReason/status | completed/failed/incomplete 三态；流中 `response.failed` 携带 error；`[DONE]` 尾帧 | completed / incomplete(max_output_tokens)；无 failed 态（ExecutionFailure → 400/502 HTTP）；同样 `[DONE]` | Token 把失败映射为 HTTP 错误而非 `response.failed` SSE 帧——对已开始流式消费的客户端，中途错误会表现为「流断了」而非语义化 failed；opencodex 在流中发 `response.failed` 并带 error（`buildFailedTailPayload`） |
| SSE 序列 | `response.created`(in_progress, output:[]) → `output_item.done`(按序) → `response.completed`/`failed`/`incomplete` → `[DONE]`；10000 item 上限 | 完全相同的序列（created → done → completed → [DONE]）；无上限 | 序列一致（Token 就是抄的这段，spec §2.4）。缺 10000 上限（理论上超长输出可 OOM 内存，本地低风险） |

## 4. 错误与失败

| 维度 | opencodex | Token | 差异影响 |
|---|---|---|---|
| 校验失败 | 宽松 + 日志；畸形 item 降级 | 严格 400 | 见 §2（Token 严格但缺兜底，孤儿输出可死锁历史） |
| 上游 HTTP 失败 | passthrough 转发原 body + 原 headers；空 body 才包 `upstream_error`；Retry-After 校验/修复；TLS 证书错误专门诊断文案；429 pool 轮换 | `HttpObserver` 捕获真实 HTTP Response → `mapUpstreamHttpFailure`（映射表 status→type，透传 `error.type/code`，message 取上游 body）→ 同 status HTTP 错误 | 方向相反但都合理：opencodex 面向「原样转发给原生后端」，Token 面向「转译为 Pi provider」。Token 缺 Retry-After 透传（429 时客户端无法退避）与 TLS 诊断文案；opencodex 的 body 透传不适用 Token（provider 转译后 error type 未必匹配 Responses 客户端） |
| 取消 | relay/relay-eager：客户端断开 → abort 上游（`relayWithAbort` cancel → upstream.abort）；流中 `response.failed`(client_cancelled, 499)；stall timeout | request.signal → `ExecutionAbortedError` → raceWithRequestSignal 传播；`HttpRequestAbortedError`；不保存状态 | 一致（都传播取消、不落盘）。Token 的 499/`client_cancelled` 只在服务端日志可见，客户端拿到的是连接中断 |

## 5. 认证与隔离

| 维度 | opencodex | Token | 差异影响 |
|---|---|---|---|
| 客户端认证 | 无自带鉴权（代理模型）；依赖 CORS/loopback 校验 + 可选 forward 凭证校验（`validateForwardAdmissionCredential`，直连 Codex 账号时）；OAuth 账号池 | 独立 `Auth` + 独立 token 文件（`createAuth` + `loadFileClientTokenAuthority`），anthropic/responses 各自实例 | Token 更贴合 AGENTS「per-client-protocol-token-file」；opencodex 代理模型天然不需要。两者各自成立 |
| 会话身份 | `sessionId`/`projectDir` 由 auth 解析后**仅**进续接 state（providers 续接）；无跨协议共享 | `sessionId` + `projectDir` → composeOptions → Pi metadata；跨协议同构 | Token 明确「auth 后仅 sessionId/projectDir 可继续进入 Pi 组合」（AGENTS），比 opencodex 的 OAuth 账户池更简单 |
| /v1/models | 无统一 discovery（有 management API） | 无认证跨协议 discovery（`models-discovery.ts`，仅列 commandcode-private） | Token 独有；Codex 可据此发现 selector。opencodex 走 catalog 不暴露此端点 |

## 6. 架构边界

| 维度 | opencodex | Token | 差异影响 |
|---|---|---|---|
| 模块划分 | 巨型单体：`core.ts` 3670 行（路由+编排+重试+OAuth+搜索/图像桥+认证+组合+流控）；parser 直接 import 搜索/图像合成工具、reasoning 信封、state；adapter `openai-responses.ts` 1299 行（清洗+转发） | 5 个 ~300 行模块按能力内聚：request/response/sse/session-state/handler + 独立 models.ts；共享 `options.ts`（Pi 选项白名单）、`upstream-failure.ts`（中立映射） | Token 明显更符合 AGENTS「capability cohesion + 最小架构」；opencodex 是历史演化的代理产品，规模差异有合理性（多 Provider/多通道/组合调度） |
| Provider 隔离 | 无 IR 边界：parser 直接 import `web-search/synthetic-tool`、`images/synthetic-tool`、`tool-groups`；adapter 直接 import `reasoning-envelope`（Anthropic 签名） | Pi IR 第一边界：adapter 目录零 Provider import（HANDOFF 已验证）；所有转换经 Pi `Context`/`AssistantMessage`；composeOptions 白名单强制选项边界 | Token 的硬约束恰好是 opencodex 没有的——opencodex 的「原生 passthrough」与「本地合成工具」耦合是它自己的架构选择；Token 若未来加 Provider 无须动 Client Protocol（已符合 AGENTS） |
| 第二 IR | 有（OcxMessage/OcxContext 作为中间类型，再转各 adapter wire） | 无（直接 Pi IR） | Token 依 AGENTS 明确「不引入第二 IR」；opencodex 的 OcxMessage 是历史产物 |

## 7. 持久化取舍（我们为何不做）

| opencodex 设施 | 我们不做 | 依据（调研报告 §2.3 / spec §7） |
|---|---|---|
| 磁盘 spill store | 不做 | 单实例 + 单会话 + 1000 条内存封顶；无多租户内存压力；报告明确「内存即可」 |
| TTL 1h | 不做 | entry cap 已界磁盘；TTL 会误杀长会话（D4） |
| 64MB 字节预算 | 不做 | 无 forced store:false 的 kiro/cursor 二次方链 |
| 加密 payload（ocxr1/encrypted） | 不做 | 不依赖 Anthropic 签名回放（无 Anthropic thinking 上游）；报告「否」 |
| compaction 缓存/合成输出 | 首版不做 | Codex 远程压缩未启用（spec §7）；若启用需补（见改进点） |
| reasoning-replay-cache | 不做 | 无 CCA/签名回放需求 |
| metrics/system routes | 不做 | 无运维面（report §2.3） |

## 8. 测试覆盖

| 维度 | opencodex | Token | 差异影响 |
|---|---|---|---|
| 测试组织 | 单一 `tests/` 目录、每设施一组：`responses-state.test.ts`、`responses-parser.test.ts`、`responses-json-events.test.ts`、`bridge.test.ts`、`relay-eager.test.ts`、`responses-{item-id,terminal,snapshot,custom-tool,image-gen}-repair.test.ts` 等；大量 IO 注入 seam（`setSpillIoForTest`、`setResponseStateByteCapForTests`、`clearResponseStateMemoryForTests`） | 分层：unit（session-state/request/response/sse/models）、integration（serving，注入 fetch 验证展开/重启/取消/429/认证）、online（真实 CommandCode，36 JSON+14 SSE+5 取消+链+重启恢复） | Token 测试更贴合「语义保护」：integration 验证完整链路（上游收到的 roles = user/assistant/user），online 是真金白银的 Codex 兼容验证。opencodex 测试以单元+IO seam 为主，靠面广取胜；Token 缺 IO seam（快照竞态、字节预算边界无法测），但单实例下够用 |
| 覆盖盲区 | 无线上真实客户端；靠 bun 测试 | 无 per-delta 流式、无 tool_search/local_shell/refusal/file 附件、无 output_tokens_details 缺失客户端硬解析 | 两侧各有盲区；Token 的盲区集中在「严格客户端反序列化」与「Codex 高级 item 类型」 |

## Token 可以借鉴 opencodex 的 6 个改进点

1. **`output_tokens_details` 恒输出（含 reasoning_tokens:0）**。opencodex 因 grok-build 严格客户端「missing field」硬失败（bridge.ts 注释，实测 2026-07-23）才改为恒输出。Token 目前 reasoning=0 时缺该字段，Codex 系客户端存在同类风险。改动一行 + 测试。
2. **流式失败语义化：`response.failed` 帧而非仅 HTTP 错误**。opencodex 在流中断时发 `response.failed` + error（`buildFailedTailPayload`），Token 中途 provider 错误会把已完成部分作废为 HTTP 502。至少对已开始 `response.created` 的请求，应发 failed 帧。
3. **replay 失败的可观测性**：opencodex 对「已知但读不出」的 id 发结构化 `previous_response_not_found` 400（提示重发全量），并对 fail-open 打日志警告。Token 全 miss 静默 fail-open，无法区分「真没有」与「快照损坏」。建议：加日志（含 miss 原因），并评估对「本地曾存在但已被逐出」的 id 回结构化 400。
4. **reasoning 附着补挂（`attachPendingReasoningToCallOwner`）**。opencodex 因 DeepSeek thinking 模式要求 thinking 先于 tool_use（issue #950）而补挂。Token 主上游正是 DeepSeek 系（CommandCode），历史回放中「reasoning 在 function_call 之后」可能触发同样 400。
5. **`tool_search` 工具与 `tool_search_call/output` item 支持**（opencodex 已有完整回路：工具暴露 + call 保留 + output 转 toolResult + loaded tools 注入）。Codex 默认未启用，但启用后当前 Token 会丢工具且历史断裂。
6. **Replay 边界标记**（`_replayPrefixLen`/`_previousResponseInputExpanded`）。opencodex 用 WeakMap 区分「重放前缀」与「新增增量」，从而正确决定 compaction 边界与「该不该保存」。Token 的「自身 previous 未展开则不保存」已实现等价保护，但 compaction 轮次边界（`context_compaction` 在新增量 vs 重放前缀中的不同处理）缺失——接入远程压缩前需要它。

## opencodex 可以借鉴 Token 的 4 个点

1. **严格请求校验 + 显式错误类型**。opencodex 的宽松 catch-all 会让畸形请求静默降级（污染历史）；Token 的 `InvalidRequest`/`OutboundResponseFidelityFailure` 判别式错误让「客户端畸形 vs 上游失败 vs 内部错误」在 handler 层清晰分流，opencodex 可借鉴错误分类。
2. **无第二 IR 的边界**。opencodex 的 parser 直接 import 搜索/图像合成工具、reasoning 信封，Adapter 与 Client Protocol 耦合 Provider 语义；Token 的「Client Protocol 只见 Pi IR、不 import Provider」约束让新增 Provider 零改动。opencodex 若想长期演进，可把合成工具从 parser 解耦。
3. **按能力内聚的小模块**（request/response/sse/session-state 分置 + 组合根注入）。opencodex 的 `core.ts` 3670 行单体是最大维护风险；Token 的分层（wire 校验/转换/渲染/状态/编排分离）可直接照搬为 core.ts 拆分方向。
4. **线上真实客户端套件**。opencodex 测试面广但无真实 Codex 客户端端到端验证；Token 的 `test:online-responses`（真实 CommandCode + 链式展开 + 重启恢复 + 取消）验证了「规范宣称的兼容性」确实成立，opencodex 可加一条真实 client 冒烟路径。

## 风险清单（按影响排序）

1. **`output_tokens_details` 条件性缺失** → 严格客户端可能硬解析失败（低成本修复）。
2. **孤儿 `function_call_output` 400** → 重放历史含孤儿输出时整轮失败；opencodex 的宽容策略值得部分借鉴（降级为 toolResult 而非拒绝）。
3. **流中失败无 `response.failed`** → Codex 在已开始消费后收到连接中断，诊断困难。
4. **无 TTL + 1000 条封顶** → 长会话占满后新会话被逐出（低概率，但无 opencodex 的 TTL 兜底）。
5. **file_id 图片 / input_file / refusal / local_shell_call / tool_search 缺失** → Codex 高级功能（附件、shell 回放、延迟工具）下历史不完整。
6. **快照无单条/总量裁剪** → 长会话使快照文件膨胀（32MB 上限前）；opencodex 的 2MB 单条裁剪可作远期参考。
7. **compaction 轮次边界缺失** → 接入 Codex 远程压缩前必须补（改进点 6）。
