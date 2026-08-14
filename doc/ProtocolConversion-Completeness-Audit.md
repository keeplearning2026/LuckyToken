# 协议转换完备性审计报告（独立复核版）

> 审计对象：LuckyToken `2863af2` 工作树中的实现与测试。
>
> 审计日期：2026-08-13。
>
> **历史快照，非当前实现合同。** 本文关于 shared `HttpObserver`、fetch observation
> 与缺失 neutral failure producer 的代码事实仅描述 `2863af2` 基线；当前实现已删除
> observer side channel，权威合同见 Protocol Conversion Architecture and Policy 及各
> Conversion Method。以下旧证据保留用于解释 contraction 起因，不得当作当前行为。
>
> 本文严格区分两件事：**该审计基线的代码事实**与**当时已冻结、尚待实现的转换方法**。基线代码事实优先于更早的报告、规划文档和参考对比文档，但不代表当前 HEAD。本文不把测试通过等同于语义完整。

## 0. 结论

原报告不能作为协议冻结依据。它正确识别了若干局部问题，但存在三类根本缺陷：

1. 把 Pi 已有承载能力误判为“无对应”，包括 `samplingParams`、`thinkingBudgets`、`cacheRetention`、`metadata` 和 redacted thinking。
2. 只检查局部函数，没有沿完整调用链验证，因此把 `xhigh/max`、CommandCode `abort`、HTTP 错误恢复等行为写错。
3. 用“27 个真实样本全过”和“全部测试通过”推导 P0 为零；实际 replay 仅证明请求被接受，27/27 样本中的 developer 指令都被静默丢失。

修正后的等级为：**P0 2 项、P1 12 项、P2 12 项**。另有一组经审查冻结的显式降级，不再作为违反项。

## 1. 审计标准

### 1.1 分层转换原则

从 A 转换到 B 时：

1. A 的语义在 B 有对应，必须转换。
2. B 无对应时，通常丢弃 A 的辅助信息，不因此拒绝主要请求。
3. A 未给而 B 有默认时，采用 B 默认。
4. 所有例外和确定性降级必须明确记录。
5. `messages`、`systemPrompt`、`tools`、ToolCall/ToolResult 的 ID、名称、参数、顺序和生命周期属于核心语义；不能用“宽容”掩盖损坏。
6. 可以删除或降级 A 已有信息，但不能编造 A 中不存在的模型可见事实。唯一已批准的合成是缺失 ToolResult 修复，且必须产生非模型可见 notice。
7. 未知 discriminator、已知但无对应的辅助字段、已知 malformed 生命周期是三类不同情况，不能共用一个全局策略。

### 1.2 架构硬边界

凡是发生协议转换，Client Protocol 与 Provider 只能通过 Pi IR 交互。转换策略、配置、状态和术语分别由所属 adapter 管理；Runtime 只组合能力，不执行跨协议语义转换。`pi-agent/` 为只读参考。

同一 wire protocol 的 native passthrough 是明确批准的例外：它属于非转换路径，不进入 Pi。passthrough 只能根据 source/target protocol compatibility 选择，不能根据具体 Provider 名称或 Provider 私有字段制定 Client 语义。conversion 与 passthrough 必须有独立的规范、测试和可观测标记；passthrough 成功不能作为 Pi 转换完整性的证据。

## 2. 审查方法和证据范围

本次逐条打开以下路径并沿调用链复核：

- `src/protocols/anthropic/`
- `src/protocols/openai-responses/`
- `src/providers/commandcode-private/`
- `src/execution.ts`、`src/http-observer.ts`、`src/composition.ts`
- 安装版 `node_modules/@earendil-works/pi-ai/dist/types.d.ts`
- vendored `pi-agent/packages/ai/src/api/`，仅作参考
- `D:\project\opencodex`，其 `package.json` 标称 `2.13.0`；目录没有 `.git`，无法证明源码未被修改

离线验证结果：

| 命令/范围 | 结果 | 能证明什么 |
|---|---:|---|
| `npm test` | certification 6/6；Vitest 73 files、516/516；合计 522 | 当前离线断言全部通过 |
| 指定协议测试聚合 | 23 files、246/246 | 指定单元与 replay 用例通过 |
| Provider/error 专项 | 7 files、92/92 | 当前错误与 assembler 行为被现有测试锁定 |
| Responses replay | 27 fixtures + 2 专项 | sanitized 样本被接受并走通 mock Provider |
| 在线测试 | 未运行 | 不证明真实 Provider 行为、费用路径或线上 pause/deferred |

## 3. 主张核查总表

“报告写 X”指旧版 `doc/ProtocolConversion-Completeness-Audit.md` 的相应章节。行号以本次审计时工作树为准；以后代码变化应重新生成证据。

### 3.1 Client Protocol：Anthropic

| ID | 报告主张 | 判定 | 代码实际与依据 |
|---|---|---|---|
| A-01 | Anthropic 顶层 `thinking` 在 Pi 无对应，可丢 | **证伪** | Pi 有 `reasoning` 与 `thinkingBudgets`：`types.d.ts:211-218`。当前 `request.ts:68-78` 只验 shape 后丢；属于漏转。 |
| A-02 | `output_config.effort` 与 opencodex 的 budget→effort 行为一致 | **证伪** | Lucky 只读取 `output_config.effort`；opencodex `src/claude/inbound.ts:518-536` 还转换 `thinking.enabled.budget_tokens` 和 disabled。 |
| A-03 | `top_p`/`top_k` 在 Pi 无对应，丢弃正确 | **证伪** | Pi `samplingParams` 注释明确列 `top_p`、`top_k`：`types.d.ts:109-117`。Lucky `request.ts:61-103` 验证后丢弃。 |
| A-04 | metadata.user_id 转换 | **证实** | `request.ts:266-277,716-718` 转入 Pi metadata；但 SDK-valid `null` 当前会报错，旧报告漏报。 |
| A-05 | 连续同 role 消息不主动合并 | **证伪** | `request.ts:335-346,578-594` 实际合并；Anthropic SDK 也允许服务端合并。旧转换文档与代码冲突。 |
| A-06 | `text A → tool_result X → text B` 会按顺序拆成三条 Pi message | **证伪** | `request.ts:378-390` 会拒绝 result 前已有普通内容；转换又在 `:671-699` 把普通内容放到 ToolResult 后。 |
| A-07 | orphan/duplicate/unresolved tools 可统一视为无对应 | **证伪** | 这是源生命周期有效性，不是字段对应问题。当前 `request.ts:350-408` 强制关联；冻结策略已拆分处理。 |
| A-08 | redacted inbound thinking 保存 | **证实** | `request.ts:508-522` 构造 redacted ThinkingContent 和 opaque signature。 |
| A-09 | Pi redacted thinking 出站无充分证据、可待议 | **证伪** | Anthropic 有精确 `redacted_thinking`；Pi 参考 `anthropic-messages.ts:1178-1185` 也恢复。Lucky `response.ts:303-305` 丢弃，redacted-only 又在 `:424-429` 报错。 |
| A-10 | 普通 Pi thinking 缺 signature 填空串 | **证实（现状）** | `response.ts:279-311` 合成 `""`。这不是目标默认；冻结为兼容降级并要求 notice。 |
| A-11 | ToolCall 与 stopReason 有一致性检查 | **证伪** | `response.ts:333-374,431-440` 独立转换内容和终态，没有交叉检查。 |
| A-12 | Anthropic atomic SSE 的 message_start 使用初始 usage | **证伪** | `sse.ts:311-323` 直接放最终 usage；`message_delta` 又发送最终累计值。目标契约要求 start 的 output 为 0。 |
| A-13 | Anthropic 同协议路径仍经 Pi IR | **证伪，但现状为批准的 passthrough profile** | `handler.ts:173-182` 对 `model.api === "anthropic-messages"` 走 native passthrough，`handler.ts:292-345` 直接转发 wire。它不是 conversion，必须从 Pi 转换审计中单列。 |
| A-14 | passthrough 原样且安全 | **部分证伪** | 请求固定 `/v1/messages` 且固定部分 headers；响应盲复制全部 headers，server 又重缓冲 body。功能应保留，但 base URL path prefix、beta/version headers、hop-by-hop、cookie、body-read failure 尚无完整安全契约。 |

### 3.2 Client Protocol：OpenAI Responses

| ID | 报告主张 | 判定 | 代码实际与依据 |
|---|---|---|---|
| R-01 | input 中 system/developer 文本追加到 Pi systemPrompt | **证伪** | `request.ts:335,372-375` 只 push 到局部 `systemPromptParts`；返回值不含它，`context.systemPrompt` 在 `:531-534` 只取顶层 instructions。 |
| R-02 | `effort:none` 被错误丢弃，应该透传 none | **证伪** | Pi request `ThinkingLevel` 不含 none/off：`types.d.ts:23-25`。`request.ts:236-254` 把 none 转 omission；是否等价于关闭取决于目标默认，证据不足，不能叫“透传 none”。 |
| R-03 | Responses effort 路径完整 | **证伪** | 合法 `minimal` 在 converter 被接受，但 `src/protocols/options.ts:68-75` 拒绝，最终 500。`null` 也被误拒。 |
| R-04 | `top_p` 无 Pi 对应，验证后丢弃正确 | **证伪** | Pi `samplingParams.top_p` 是直接承载；Lucky `request.ts:299-303` 注释“No Pi option”错误。 |
| R-05 | `text.format` 应映射顶层 constrainedSampling | **证伪** | 安装版 Pi 的 `constrainedSampling` 只属于 Tool：`types.d.ts:347-369`；不存在顶层 response-format 字段。若用 synthetic tool 是 xrepair，不是直接映射。 |
| R-06 | unknown input item 全部丢弃以保证兼容 | **证伪** | `request.ts:328-515` 对多数 default 分支抛 Unsupported；仅部分显式 skip。已知官方 family 与未来 unknown 也没有分开。 |
| R-07 | tool_search 无对应，可忽略 | **证伪** | Pi 有 Tool、ToolCall、ToolResult 与 `addedToolNames`。当前工具定义在 `request.ts:228-232` 被丢，call 在 `:498-502` 被丢，output 则 default 400；这是生命周期族，不是普通 unknown。Core v1 已冻结为 unsupported/error。 |
| R-08 | function arguments 的 `{}` fallback 是无害宽容 | **证伪** | `request.ts:129-138` 对非法 JSON/非 object 都改为 `{}`，会改变实际调用。仅 missing/blank→`{}` 被批准。 |
| R-09 | orphan tool output 当前报错 | **证伪** | `request.ts:443-453` 当前 drop；本地 Client Protocol 文档写 error。冻结为 `ignore|error`、默认 error。 |
| R-10 | `file_id` 是解析格式问题 | **证伪** | 它是远端 opaque handle；Pi ImageContent 只有 data+MIME。当前 `request.ts:112-126` 静默跳过。缺 resolver/authority 才是根因。 |
| R-11 | compaction 可用字节长度文本代替 | **证伪** | `request.ts:478-488` 伪造用户文本，不能恢复 encrypted state 的模型语义。Core v1 对 foreign opaque compaction 固定 error。 |
| R-12 | reasoning encrypted content 在 Pi 无对应 | **证伪** | Pi ThinkingContent 的 `thinkingSignature` 可承载 versioned opaque continuity；Pi 参考 `openai-responses-shared.ts:220-224,683-688` 这样回放。 |
| R-13 | refusal 无 Pi 对应 | **证伪** | refusal 有可见文本语义，可降级成 Pi text；当前丢弃。 |
| R-14 | Responses response envelope 完整 | **证伪** | `response.ts:58-68,255-269` 缺 `error`、`incomplete_details`、instructions、metadata、parallel_tool_calls、temperature、tool_choice、tools、top_p 等目标字段。 |
| R-15 | usage 的 output_tokens_details 完整 | **证伪** | 目标类型要求始终存在；当前 `response.ts:96-119` 仅 reasoning>0 时发送。 |
| R-16 | SSE 与 opencodex 逐帧完全一致 | **部分证实** | completed 成功样本的最小顺序相近；Lucky `sse.ts:34-37` 无条件发 completed，opencodex 会按 status 发 incomplete/failed。两者都不能替代官方 sequence_number 契约。 |
| R-17 | `response.completed` 可覆盖 length | **证伪** | `response.ts:223-228` 已将 length 设 incomplete；SSE 却仍发 completed，内部自相矛盾。 |
| R-18 | previous_response_id 路径被 27 fixtures 验证 | **证伪** | fixtures 中 0/27 含 previous_response_id；replay 没覆盖 session expansion。 |
| R-19 | store:false 与本地持久化无关，可始终保存 | **证伪/设计冲突** | 27/27 fixtures 都是 store:false；当前仍写 session state。冻结为 `honor|memory|persist`，默认 honor。 |
| R-20 | session store 有 compaction 拒绝逻辑 | **证伪** | 当前 `session-state.ts`/handler 无该判断；引用的 opencodex 对比已过期。 |

### 3.3 Provider：Pi IR ↔ CommandCode private

| ID | 报告主张 | 判定 | 代码实际与依据 |
|---|---|---|---|
| C-01 | historical error/aborted 整条跳过符合“无对应即丢” | **证伪** | `provider.ts:158-160` 连同有明确目标对应的 content 一并丢；`pending/deferred` 在 `:161-166` 抛错。冻结为忽略所有 historical stopReason、仅转换 content。 |
| C-02 | ToolResult text 转换完整 | **证伪** | `provider.ts:79-90,117-127` 把 required `toolName` 硬编码空串；Pi 与 CommandCode 都有同名字段。 |
| C-03 | ToolResult image 抛错是必要的 | **证伪（按冻结方法）** | target 无 image 字段；应丢图片、保留文字，image-only 发空字符串保持配对。线上认证 artifact 已证明空值被接受。 |
| C-04 | constrainedSampling require 抛错违反通用原则 | **证伪（按最终决策）** | Pi 自身把 require 定义为硬能力；但项目最终选择辅助控制优先可用性：所有 constrainedSampling 在 CommandCode 无对应时丢弃，require 降级需 notice。旧报告不能称其“天然必须报错”。 |
| C-05 | 无 thinkingLevelMap 时 xhigh/max 会在 provider 抛错 | **证伪** | 完整调用链先 clamp；`provider.ts:293-299` 与 Pi models clamp 使 unsupported xhigh/max 降为 high。运行探针复现。 |
| C-06 | CommandCode wire abort→Pi aborted | **证伪** | `assembler.ts:415-417` 抛 CommandCodeAbortError；`provider.ts:909-917` 只在 caller signal aborted 时产 Pi aborted。wire abort 正常变 Pi error。 |
| C-07 | pause_turn 发生时 staged content 结构仍未完成 | **证伪/证据不足** | `assembler.ts:215-234` 在 EOF、finish 和 modeled slots 闭合后才判断 pause；当前随后 rollback。结构闭合已证实，但逻辑是否完整缺真实样本。 |
| C-08 | finish-step 没有可映射信息 | **证伪** | 17/17 样本含 `response.id/modelId`，Pi AssistantMessage 有 `responseId/responseModel`；`assembler.ts:418-423` 当前整体 no-op。 |
| C-09 | response reasoning 与 model.reasoning=false 冲突时拒绝正确 | **证伪** | 已到达的 Pi ThinkingContent 可表达；`semantic.ts:159-165` 的额外能力拒绝会把成功响应变 502。 |
| C-10 | CommandCode 没有 totalTokens | **证伪** | 样本 finish/finish-step 有 total/aliases；`semantic.ts:73-150` 当前忽略并重算。 |
| C-11 | ToolCall 与 finishReason 会做一致性归一化 | **证伪** | `semantic.ts:179-183` 只看 finishReason，可产生 ToolCall+stop 或无 ToolCall+toolUse。 |
| C-12 | onPayload replacement 不会重新校验 | **证伪** | `provider.ts:835-848,417-649` stringify→parse 后执行 closed-world authority/shape revalidation。旧详细文档反写。 |
| C-13 | projectDir 缺失/空/非字符串都变 root slug | **证伪** | `project.ts:60-67` 对这些返回 undefined，省略 x-project-slug；仅非空值 slugify 后为空才 root。 |
| C-14 | max_tokens 固定 64000 | **证伪（已由 Ticket 20 修正）** | request conversion 使用 `options.maxTokens ?? model.maxTokens`。安装版 Pi 的 `Model.maxTokens` 必填；CommandCode catalog 优先采用模型明确的 `maxOutputTokens`，否则采用官方 CLI request default 64000。因此 wire `max_tokens` 必填，但并非对所有模型无条件固定 64000。 |
| C-15 | installed Pi ToolCall 有 namespace | **证伪** | 权威安装版 0.84.1 `types.d.ts:246-252` 无 namespace；vendored 较新源码有，但不可当运行时合同。 |

### 3.4 错误、连锁影响与架构

| ID | 报告主张 | 判定 | 代码实际与依据 |
|---|---|---|---|
| E-01 | 两侧共享一个安全的 upstream-failure mapper | **证伪** | 实际有两个副本；二者都取 `error.type ?? error.code`，完整 body 变 message，无 target allowlist、截断或脱敏。 |
| E-02 | HTTP non-2xx 在 provider→Pi 后完全丢失 | **部分证伪** | Provider/Pi 确实拍平；但 HttpObserver 旁路在 fetch 边界恢复 status/body，handler 再映射。该旁路本身不安全。 |
| E-03 | HTTP 200 流内 statusCode 只在 execute 层丢失 | **证伪（定位不准）** | assembler 先丢 type/code/body；semantic 又只保 error.message，丢 status/retryable；execution 再只传 string。需跨 Provider diagnostic、execution、Client renderer 修。 |
| E-04 | HttpObserver 是 invocation-local | **证伪** | `composition.ts:137` 只创建一个实例并传给两 handler 与 provider；`http-observer.ts:53-79` 只有 mutable latest slot。 |
| E-05 | observer 不改变 fetch 语义 | **证伪** | `http-observer.ts:62-68,92-100` 对非 2xx clone 后无界 `arrayBuffer()`；读取失败会让 observed fetch 自身 reject，latest 留 pending/undefined。 |
| E-06 | Responses 对所有 provider 注入 custom fetch 安全 | **证伪** | `openai-responses/handler.ts:184-197` 无条件注入；Pi Google adapters 明确拒绝 custom fetch。Anthropic handler 有 capability guard。 |
| E-07 | non-2xx body 原样透传 | **证伪** | body 被 decode 为字符串并嵌入新 JSON `error.message`；status 保留，statusText、request-id、retry-after 和其他 headers 丢失。 |
| E-08 | 报告第 5 章 redacted 链路成立 | **证伪** | Anthropic redacted 入站在 CommandCode `provider.ts:182-183` 先抛，实测 HTTP 502、fetch 0 次，不会到 Anthropic 出站。修复位置不是只改 renderer。 |
| E-09 | strict tool 失败只需改 Client | **证伪** | 该拒绝发生在 Provider tool conversion；且 shared observer stale 时甚至可能返回前一请求错误。层级判断错误。 |
| E-10 | 同一请求错误一定关联本次 upstream observation | **证伪** | 实测先 429，再在下一请求 fetch 前触发 redacted conversion error，第二请求返回第一请求的 429 和敏感 body；fetch 次数仍 1。 |

## 4. 原报告需要修正的清单

### 4.1 必须删除或反转的结论

1. 删除“P0 无问题”。
2. 删除 P1-5“xhigh/max 会抛”；完整调用链会 clamp。
3. 将 P1-2 从“none 必须透传”改为“Pi request 无 none；显式关闭降级为 omission，目标默认效果证据不足；另有 minimal→500 实际 bug”。
4. 将 P2-9 从“text.format 应映 constrainedSampling”改为“Pi 无顶层 response-format；固定丢弃，不构造 synthetic tool”。
5. 将 `top_p/top_k`、Anthropic thinking、redacted output 从“Pi 无对应”改为“Pi 有承载但当前漏转”。
6. 将 CommandCode abort→aborted 改为 wire abort→provider failure；仅 caller cancellation→aborted。
7. 将“HTTP 错误比 Pi 更细且安全”改为“非 2xx 暂由不安全旁路恢复；流内错误仍拍平；存在 P0 归属泄漏”。
8. 将“27 个真实样本全过”改为“27 份 sanitized fixtures 的 acceptance smoke 通过；不证明字段保真”。
9. 将“Responses SSE 与 opencodex 逐帧一致”限定为 completed 最小序列；incomplete/failed/sequence_number 不完整。
10. 将“Anthropic passthrough 原样”限定为部分请求/正常 body；明确它是批准的非转换 profile，而不是 Pi conversion，并补齐 transport 安全边界。

### 4.2 旧报告漏报

- Responses developer/system prompt 真实丢失。
- 全局 HttpObserver 跨请求、跨协议错误归属与敏感数据泄漏。
- Responses→Google custom fetch 兼容性失败。
- Responses session store 无 scope、store:false 被忽略、unknown previous id fail-open、写盘上限不闭合。
- Responses 目标 envelope、usage details、SSE sequence/terminal event 缺失。
- Anthropic mixed content/tool_result 顺序错误。
- Anthropic message `role=system` 非标准扩展和 assistant prefill 的实际策略。
- CommandCode ToolResult.toolName 丢失、real isError 没映成 error-text。
- CommandCode finish-step identity、usage aliases、stop/content mismatch。
- OpenAI Responses 尚缺与 Anthropic 对称的 native passthrough profile 与独立验证。
- 错误 body 无界读取、无脱敏、safe headers 丢失。
- 每个失败 request 缺少独立、受限、可调试的 failure journal。

### 4.3 建议替换措辞

| 旧措辞 | 修正措辞 |
|---|---|
| “真实样本全部通过” | “27 份 sanitized fixtures 均被接受；字段级语义未被 replay 断言验证” |
| “Pi 无对应” | 只有在检查安装版公共类型、options composition 和参考 adapter 后才能使用；注明具体缺失的 target slot |
| “原样透传错误” | “保留 HTTP status；body 被重新包装为字符串；headers 和安全边界不完整” |
| “宽容处理” | 写明具体字段、具体 action、是否 model-visible、notice、默认值和不可变约束 |
| “unknown 丢弃” | 区分 unknown discriminator、known unsupported、known malformed lifecycle |
| “修 Client/Provider 层” | 写出完整 `source converter → Pi → execution → target renderer` 链路和最小修复 owner |

## 5. 修正后的违反清单

### P0

| ID | 问题 | 证据 | 必须修改的 owner |
|---|---|---|---|
| P0-1 | 全局 HttpObserver 单槽跨请求/跨协议串线，可泄漏前一请求 status/body | `composition.ts:137,218-222,254-259`；`http-observer.ts:53-79`；专项运行复现 | Runtime/execution error contract；删除 shared side-channel |
| P0-2 | Responses input 中 system/developer 文本静默丢失；27/27 fixtures 受影响 | `request.ts:335,372-375,515,531-534` | Responses request converter |

### P1

| ID | 问题 | Owner / 修复方向 |
|---|---|---|
| P1-1 | Anthropic mixed ordinary/tool_result 内容被拒绝或重排 | 按 block 顺序拆 Pi messages |
| P1-2 | historical AssistantMessage 因 stopReason 跳过 content 或报错 | CommandCode request：忽略 reason，只转 content |
| P1-3 | CommandCode ToolResult 丢 toolName/isError；图片导致整请求失败 | 映真实字段；图片 drop，image-only 空 string |
| P1-4 | Anthropic thinking/top_p/top_k 与 Responses top_p 有 Pi 承载却漏转 | Client request converters + options composition |
| P1-5 | Pi redacted thinking 没有输出 Anthropic redacted_thinking | Anthropic response converter |
| P1-6 | Responses合法 minimal 经 options composition 变 500 | shared Pi option composition 接受完整 ThinkingLevel |
| P1-7 | Responses 已知 tool_search/deferred 生命周期被不一致地 drop/400 | Core v1 统一 conversion error；不得假装普通 unknown |
| P1-8 | Responses function arguments 非法时被改写为 `{}` | 仅 missing/blank 修复；invalid/nonobject error |
| P1-9 | CommandCode response reasoning 被 model.reasoning=false 拒绝 | Provider semantic 仅按已到达 content 可表达性转换 |
| P1-10 | CommandCode finish-step response identity 全丢 | assembler/semantic 映 responseId/responseModel |
| P1-11 | Responses 对拒绝 custom fetch 的 Pi adapters 无条件注入 fetch | 删除 observer 注入；按 Q18 的 Pi 中立错误事实重构 |
| P1-12 | Anthropic native passthrough 的 URL/header/body-failure 安全合同不完整 | 保留 passthrough 功能；按独立 profile 修正 base path、版本/beta、safe headers、重缓冲字段与流失败 |

### P2

| ID | 问题 | 修复方向 |
|---|---|---|
| P2-1 | Responses response envelope 缺 required/default fields | 使用 request-local render state 构造 effective response |
| P2-2 | Responses SSE 缺 sequence_number，length 仍发 completed | 按 completed/incomplete/failed 终态输出 |
| P2-3 | Anthropic atomic SSE message_start 重复最终 usage | start output=0；final delta 放最终 usage |
| P2-4 | HTTP 200 流内 error 的 status/type/code/retryable/body 被逐层拍平 | Provider neutral diagnostic→ExecutionFailure→Client error |
| P2-5 | HTTP non-2xx 丢 request-id/retry-after，body 无界且未脱敏 | request-local bounded capture + safe header allowlist |
| P2-6 | Responses error 丢 code/param；Anthropic error 缺 request_id | 各 Client renderer 输出本协议合法 envelope |
| P2-7 | Responses store:false 被忽略 | `honor|memory|persist`，默认 honor |
| P2-8 | unknown previous_response_id fail-open | 固定 conversion error |
| P2-9 | CommandCode stopReason 与实际 ToolCall content 可矛盾 | length 优先；否则 content-authoritative normalize |
| P2-10 | CommandCode total/alias usage 未消费 | final finish 权威，映直接对应并校验 |
| P2-11 | Anthropic thinking 缺 signature 合成空串未标降级 | 保持空串，但生成 request-local notice |
| P2-12 | 失败请求没有每-request 日志 | 新增独立、安全、原子写入的 failure journal |

## 6. 已冻结的显式降级与策略

以下不是“遗漏后再猜”的建议，而是后续实现和规范必须采用的决定。

### 6.1 工具生命周期

- Anthropic orphan ToolResult 与 duplicate ToolResult：固定 error。
- Responses orphan tool output：`ignore|error` 可配置；默认 error。duplicate 固定 error。
- unresolved ToolCall：Client adapter 可配置 `error|xrepair`，默认 xrepair。
- xrepair 合成 ToolResult：保留 call ID/name，`isError=true`，固定文本 `No result — the tool call did not complete (interrupted or lost).`
- CommandCode Provider 独立修复合法 Pi history 的 missing result；不读取 Client 策略。
- CommandCode synthetic output type：`text|error-text`，默认 text。真实 ToolResult 固定按 `isError` 转 text/error-text。
- ToolResult image→CommandCode：丢图片、保留文字；image-only 保留配对并使用空字符串。
- mixed content/tool result 必须按源 block 顺序拆分，不能重排。

### 6.2 Unknown 与辅助字段

- Anthropic unknown content、Responses unknown input item、CommandCode unknown response event：各自 `error|ignore`，默认 error。
- Pi→Anthropic/Responses unknown content：各自 `error|ignore`，默认 error；unknown stop reason 不能 ignore 后伪造成成功。
- known object 新增普通字段：ignore。
- known、无 target 对应的辅助字段：固定丢弃并文档化。
- `top_p/top_k`、cacheRetention、thinkingBudgets、metadata 等有 Pi 对应者必须转换。
- `text.format`、verbosity、stop_sequences、parallel_tool_calls、无统一 target 的 tool-choice 强控制等固定丢弃；不构造 synthetic tool。
- CommandCode 不支持 constrainedSampling，连 `require` 也丢弃；这是明确偏向可用性的例外，必须生成 notice。

### 6.3 Reasoning、deferred 与 pause

- Responses effort：absence/null/none→omission；minimal..xhigh 直映；ultra/max→Pi max；未来值 `max|omit|error`，默认 max。
- Anthropic thinking budget：effort 存在时决定 reasoning，否则预算阶梯决定；预算写入归一化后的 minimal/low/medium/high 槽。
- Core v1 不支持完整 deferred 生命周期。Responses `background:true` 固定 error；直接 Pi deferred 到 CommandCode 则忽略并同步执行；unexpected Pi deferred result 在 execution 边界拒绝。
- CommandCode pause_turn：Provider response 配置 `stop|error`，默认 stop。stop 保留闭合 content、usage、raw reason/diagnostic；length 优先，否则 ToolCall content 决定 toolUse/stop。

### 6.4 Responses state 与 handles

- unknown previous_response_id：error。
- state 不绑定 auth/project scope；response_id 作为 bearer capability，必须高熵、不可枚举、受 TTL/容量限制。
- 首次 response 不等待内存 commit；文档明确紧随续接可能有竞态。
- store:false：`honor|memory|persist`，默认 honor；persist 必须 notice。
- conversation、prompt、外部 item_reference、foreign encrypted compaction：Core v1 error。
- Lucky 能证明并物化的 item reference/envelope 可 resolve/decode 后转换。
- Anthropic 与 Responses 都允许 same-protocol native passthrough。它是独立非转换 profile，不进入 Pi；必须按 protocol compatibility 而非具体 Provider identity 选择，并接受独立的 transport/security 审计。
- file_id/remote image 仅由 Responses-owned trusted resolver 获取 bytes/MIME；无 resolver error。generic input_file 无 Pi FileContent，固定 drop+record。

### 6.5 Prompt、工具目录和历史项

- Responses system/developer 三模式：`full|first|user`，默认 first；段之间换行。first 只提升第一个 user 之前的 privileged messages，之后降为 user。
- Anthropic 非标准 message system：只提升按顺序第一个 role=system，其余降为 user。
- Anthropic final assistant prefill：作为普通历史 assistant 接受，产生语义降级 notice。
- `Context.tools` 始终是当前 request 可由 adapter 使用的完整 Client/BYOT tool catalog；tool_reference→addedToolNames 仅保留加载事件，不隐藏 catalog。
- provider/server-hosted execution 不伪造为 Pi tool；真实可表示结果按原顺序降为 Pi 内容或 deterministic transcript，纯 lifecycle metadata 丢弃。
- Client/BYOT execution 保留结构化 ToolCall+ToolResult；任何 partial、incomplete、orphan 生命周期按已冻结规则处理。

### 6.6 Response 与错误

- Responses 输出 effective normalized fields；SSE 带单调 sequence_number，终态区分 completed/incomplete/failed。
- 当前 atomic 模式在发送 SSE 前失败时返回非 2xx JSON；只有形成 failed Response/未来提前 commit 后才发送 response.failed。
- Anthropic message_start output tokens=0，最终 usage 仅在 message_delta。
- responseId 有则使用、无则生成；client model 始终回显 selector，不暴露 concrete Provider model。
- Pi thinking 缺 Anthropic signature 时合成空串、生成 notice；redacted 必须直映。
- shared HttpObserver side-channel 必须删除；错误只通过 Pi public diagnostics/ExecutionFailure 的协议中立事实传递。
- 错误 capture 有界、request-local、safe-header allowlist；禁止配置放开 Authorization、Cookie、Set-Cookie、hop-by-hop headers。

### 6.7 Client Protocol 完全解耦

- Anthropic Messages 与 OpenAI Responses 只共同依赖 Pi public contract 和窄的协议中立 Runtime 能力。
- 两者不得共享 conversion policy/config type、converter、tool correlation/xrepair helper、render state、session/resource authority、passthrough classifier 或协议错误 mapper。
- 即使默认值、枚举值或 synthetic 文本相同，也由各 adapter 独立定义、验证、notice 和测试；相同结果不构成共享语义模块。
- 一侧增加、删除或修改字段/策略，不要求另一侧修改代码或配置。

## 7. 配置与可观测性冻结

禁止全局 `error|ignore|xrepair` 开关。每个 adapter 在自己的 request/response conversion 分组定义精确策略；启动时验证、冻结，未知 key 失败。Client 配置不能读取 Provider 配置，反之亦然。

建议形状：

```json
{
  "clientProtocols": {
    "anthropic-messages": {
      "conversion": { "request": {}, "response": {} }
    },
    "openai-responses": {
      "conversion": { "request": {}, "response": {} }
    }
  },
  "providerAdapters": {
    "commandcode-private": {
      "conversion": { "request": {}, "response": {} },
      "request": { "transport": {} },
      "response": { "errorCapture": {} }
    }
  },
  "failureLogging": {}
}
```

时间、重试、错误读取上限由实际执行操作的 adapter 拥有，并按 request/response 分组；不是转换语义开关。

可配置 ignore、xrepair、强约束降级必须产生 request-local structured notice，只含 adapter、direction、code、jsonPath、action，不含模型正文或凭据。固定的普通无对应字段丢弃只写规范，不逐请求记录。

每个最终失败的入站 request 写一个独立 JSON failure log：内部高熵 requestId 命名；一个请求多次 retry 仍只有一文件；默认 safe detail；完整请求仅在显式 full 模式且仍永久排除凭据、cookie、文件/图片二进制；原子写入；日志失败不得覆盖原协议错误。

## 8. 最终协议转换方法决策摘要

### 必须修改

1. 删除共享 HttpObserver 和 latest side-channel，建立 request-local neutral failure contract。
2. 修复 Responses privileged prompt 丢失，加入 full/first/user 模式。
3. 完整转换 Pi 已有 request options：samplingParams、thinkingBudgets、cacheRetention、metadata、minimal reasoning。
4. 重构两侧工具 lifecycle，保持 ID/name/arguments/order/result；实现独立 xrepair 与 notice。
5. 修复 redacted thinking、mixed block ordering、response identity、stop/content normalization。
6. 补齐 Responses/Anthropic response envelope、usage、SSE terminal/sequence 契约。
7. 重构 session store 的 previous/store.false 语义和 failure logging。
8. 保留并认证 Anthropic native passthrough，同时为 Responses 增加对称的 same-protocol passthrough；两者均与 conversion 测试分离。

### 保持或明确降级

- B 无对应的辅助控制字段丢弃，不阻断主对话。
- CommandCode 忽略 historical stopReason，只转 content。
- ToolResult image→CommandCode 丢图片；空结果保留配对。
- thinking 缺 Anthropic signature 继续用空串，但标记降级。
- pause_turn 默认 stop，允许 provider-local error。
- Core v1 不实现 deferred job lifecycle 和外部 Responses handle authority。

### 必须文档化而非假称支持

- `none`→omission 不等于已证明“显式关闭”。
- assistant prefill 当 history 是轻微语义降级。
- provider-hosted history transcript 不是可执行 Pi tool。
- state 不绑定主体，response_id 是 bearer capability，且首次 commit 存在竞态。
- fixtures/replay 只证明 acceptance，不证明转换完整。

## 9. 参考文档可信度

- `doc/OpenAIResponses-vs-opencodex-Comparison.md` 的 Lucky baseline/HEAD 已过期；其中 compaction、SSE identical 等结论不能无保留引用。
- `doc/PiAiVsOpenAIResponsesAdapter-Comparison.md` 的“27 样本每字段都正确”被 developer prompt、grammar、store:false 等事实证伪；parameters null 统计也不正确。
- 参考实现只能证明一种设计可行，不能覆盖当前安装版 Pi contract；安装版 `node_modules` 是运行时类型权威，vendored `pi-agent/` 仅为上游参考。

## 10. 验证缺口

后续实现至少补以下语义测试：

- 27 fixtures 的 developer/system 文本实际到达 Provider，而非只断言 HTTP 200。
- previous_response_id 命中、未知、store:false 三态和首次 commit 竞态。
- unknown discriminator 与 known malformed 的独立策略。
- mixed text/tool_result 顺序、orphan/duplicate/unresolved/xrepair。
- CommandCode ToolResult toolName/isError/image-only。
- pause_turn stop/error、finish-step identity、stop/content mismatch。
- HTTP200 stream error 的 status/type/code/retryable；non2xx safe headers/body caps。
- failure observer 跨请求隔离；Google adapters 不接收 custom fetch。
- Responses completed/incomplete/failed SSE 和 sequence_number。
- Anthropic message_start/final usage、redacted-only、empty content、missing signature notice。
- 每失败 request 单日志、脱敏、截断、原子写、日志写失败不改协议结果。
