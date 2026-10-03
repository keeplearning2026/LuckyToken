# Provider Native 重写清单与纯函数组合

日期：2026-10-03。状态：Responses 三项兼容性修复开关已实现；请求 model 与 adjacency 已拆成独立纯函数。本文描述现有实现；reasoning-effort repair 仍未实施。正确性依据为 [Native 标准](TokenProviderNativeCorrectnessSpec.md)。

## Responses 请求：现有行为

| 操作 | 触发与实际改动 | 入口与现有控制 |
|---|---|---|
| Provider model 投影 | 把顶层 client model 换成 resolved Provider model.id；Azure 使用 resolved deployment name | `provider-native-responses/common.ts::rewriteModelJson`，在三个 sender 的 `projectProviderNativeBody` 内执行；无独立开关 |
| 工具调用相邻性重排 | 仅普通 responses、完整可证明的 tool-call/output 组；把符合资格的 developer 消息移出该组，保持工具 call/result 身份与原消息内容；不符合条件保留该步骤输入 | `tool-call-adjacency.ts::reorderProviderNativeToolCallAdjacency`；`protocols.openai-responses.requestRepair.toolCallAdjacency.providerNative`，默认 true；compact 不重排 |
| Token1 compaction 回放展开 | 普通 responses 中，将可解码 Token1 compaction/compaction_summary item 展开为带摘要的 user message；外部 encrypted item 不猜测解码 | `responses-compaction.ts::expandTokenCompactionEnvelopes`，Native outbound preparation 调用；无开关 |
| Routed compaction 请求 | 结尾 compaction_trigger 且目标未认证 responses-compaction：先展开 Token1，flatten 已声明且可无歧义识别的 namespaced 历史 function call（移除 namespace），移除 trigger/additional_tools 与 callable tools/tool_choice/parallel_tool_calls/text，替换 instructions 并追加 summarizer prompt | `buildCodexRoutedCompactionRequest`；由能力判定触发，无独立开关；这是专门操作分支 |

`reasoning.effort` 当前 **没有 Native rewrite**。`TokenProviderNativeResponsesReasoningEffortNormalizationPlan.md` 仍标记草案/未实施；不能把 Semantic 的 reasoning 选择写成 Native 的已实现操作。普通 Native 的 reasoning/text/output-limit 等值继续来自原生 body。

## Responses 响应：现有行为

| 操作 | 触发与实际改动 | 入口与现有控制 |
|---|---|---|
| SSE lifecycle normalization | 成功 responses SSE、完整且能证明的 item chains：串行回放交错 added/delta，保持 chain 内顺序、item done 提交顺序与 global/done 关系，并按新顺序重写既有 sequence_number；cursor/background/不完整/无法归属等条件跳过保留原输入 | `native-sse-lifecycle-normalizer.ts::normalizeNativeResponsesSse`；`protocols.openai-responses.responseRepair.sseLifecycle.providerNative`，默认 true；不按 output_index 排序、不改文本/工具参数 |
| function_call namespace 插入 | 成功响应、请求声明唯一 function child、响应缺 namespace：仅插入 namespace。已有值、歧义、flat 同名、自定义 child、未知名字不改 | `function-call-namespace-repair.ts::repairFunctionCallNamespaces`；现有 `protocols.openai-responses.responseRepair.functionCallNamespace.providerNative`，默认 true |
| model alias 投影 | 配置了 public model source 并捕获 alias：将已批准响应位置的真实 model 换回该 alias；无法安全定位时返回协议错误，不泄漏上游 model 身份 | `native-response.ts::projectNativeResponsesBody`；受 alias 存在条件控制，无设置开关；compact 也用该投影 |
| alias 场景的安全错误重建 | upstream HTTP >=400 且 alias 存在：普通 responses 提取 bounded/redacted message、替换其中真实 model.id，保留上游 status 并构建 Token error envelope；compact 则返回固定 502 Upstream provider failed；均不转发 raw error body/headers。无 alias 时走原错误保留路径 | `handler.ts::providerNativeBranch`、`compact.ts::providerCompact`；无设置开关 |
| Routed compaction 响应 | summarizer 干净完成并得到摘要后，不透传 summarizer 输出，而是构造恰好一个 Token1 compaction item 及 JSON/SSE Responses envelope；不完整/空摘要走明确错误 | `responses-compaction.ts::renderRoutedCompactionClientResponse`，Native lane 调用；与 routed 请求分支成对 |

普通成功响应的固定执行顺序是 lifecycle → namespace → alias；安全错误路径先分支，不能对错误 body 执行成功响应修复。Routed compaction 的响应构造在 Native lane 内先完成，再交给协议侧 response processing。

另有响应 headers 安全过滤：hop-by-hop、credential/cookie、失效 Content-Length/Content-Encoding 等去除；这是 HTTP/security boundary，不应藏在 body rewrite 中。请求压缩解码、SDK JSON 重新序列化、Codex zstd 以及 Pi-derived auth/beta/session/URL 也属于编码或 envelope，不是改写客户端模型语义的可任意插拔步骤。

## Anthropic Native 的补充

请求侧有 model 投影，以及仅 first-party managed OAuth 分支的 Claude Code identity 前缀和已知 tool name 大小写规范化（同时处理声明、历史 tool_use/tool_reference）。`projectAnthropicNativeBody` 已是输入/输出明确的函数，但当前把 model 与 OAuth 差分放在一个入口；没有设置开关，credential branch 是 authority。

响应侧有 model alias、安全 headers 过滤与 alias 场景的错误安全流程；当前没有 OAuth tool-name 反向 rewrite。不得因请求侧改了名字就自行推定响应侧获准改回。Anthropic 继续有自己的 wire 函数与执行协调器，不和 Responses 共用语义流水线。

## 纯函数流水线与开关

每个局部纯函数接收原生 wire 和该步骤所需的最小 immutable facts，输出改后 wire 及明确结果。同输入同输出，不修改输入，不读取设置/clock/random，不执行 fetch/读流，也不调用 diagnostics。外层协调器读取设置、捕获本请求快照、派生 facts、执行固定顺序，观察结果并承担 commit/error handling。整个 HTTP 流程有副作用，不能称为纯函数。

请求侧 `projectProviderNativeBody` 先调用必需的 `rewriteModelJson`，再按开关调用独立的 adjacency 函数。响应侧保留既有独立纯函数，并在 handler 显式组合。错误安全处理仍由协调器承担。本次没有新增通用 rewrite registry、Provider payload projector、共享 Pi IR 或 metadata/context bag；用户可以启用/关闭已认证步骤，不能拖动顺序或配置任意函数。

三个开关均为 boolean、default true、hot-apply，位于 Settings → Advanced → Protocols 的 Responses 区域（Provider Native rewrites）。handler 在进入 Native 分支时同步读取一次；本请求的发送、重试和响应使用同一快照，新值影响随后进入 Native 分支的请求。设置 supplier 抛错时仅跳过对应可选修复，不能打断模型请求。Direct、Semantic、Anthropic、`/responses/compact` 不消费这些开关。

| 分类 | 设置原则 |
|---|---|
| 兼容性修复：Responses adjacency、SSE lifecycle、namespace | 三项独立开关均已实现；默认保持现有行为。关闭后该步骤输出等于输入，仅跳过该修复，不改变其它步骤 |
| 尚未实施的 reasoning-effort repair | 若另行采纳，作为明确的可选请求 rewrite，单独定义改变的值与负例；不因本清单而自动启用 |
| alias → Provider model、Provider model → alias | 路由身份契约，按已接受模式成对保持；不建议普通设置随意跳过一端 |
| auth/header 安全、alias 错误安全 | 必须边界，不作为兼容性修复开关 |
| Token1 replay、routed request、routed response | 保持既有成对协议处理，不新增开关，也不修改算法。检测压缩请求后使用共享请求纯函数，走原 Native transport；响应使用共享 compaction renderer；Token1 replay 始终按既有规则展开 |
| SDK/env/headers/compression | 按既有 Provider transport 契约与 Pi 实现，不纳入 Client wire repair 开关 |

纯函数不等于“失败全部忽略”：可选修复不能证明合法变化时回原输入；mandatory alias/security/compaction 必须保留既有安全失败，不被泛化的 catch-and-continue 吞掉。

## 组合与认证要求

普通 Responses 请求顺序保持：Token1 展开 / routed 请求准备 → model 与可选 adjacency 投影 → Pi-derived envelope/SDK/fetch。Routed compaction 的 plan 与 response 必须由同一 execution branch 连接，不是两个无状态的普通 filter 随意拼接。

普通成功响应顺序保持：raw Response ownership / buffer → 可选 lifecycle → 可选 namespace → alias → 安全提交；错误和 routed 操作按各自分支处理。namespace 所需声明事实在仍保有权威 request tools 的边界捕获，不从已经删 tools 的 summarizer body 反推。

测试标准：每一步 enabled 只改变获准字段/顺序，disabled 等于步骤输入，无法判断的兼容性修复保持输入，纯函数不修改输入；组合固定顺序满足最终 body/response 合法性与工具关系。对 optional 开关覆盖 on/off 与关键组合，特别是 lifecycle × namespace；重复调用应确定，但不把所有步骤强行要求幂等（如 identity prefix 与专门 compaction 转换不宜重复执行）。请求重试须从原始权威 body 和同一设置快照准备，避免重复注入 prefix/summary。

`test/integration/provider-native-rewrite-settings.test.ts` 经实际 production composition、settings registry 和 Native SDK transport 验证全部 8 种开关组合、mandatory model/alias 保留，以及请求期间改设置后本请求保持快照、下个请求使用新值。`provider-native-compaction` 在可选修复全开/全关两种情况下验证 SSE/JSON routed compaction 和 Token1 replay；Desktop product test 验证三个独立控件与保存键。本次没有扩展 reasoning、Direct、Semantic 或 Anthropic 的行为。
