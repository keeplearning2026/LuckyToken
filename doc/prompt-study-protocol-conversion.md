# 提示词：研究 OpenAI Responses ↔ Pi AI IR 协议转换完备性

用途：发给一个新对话（agent），让它对照 Pi AI 包的官方转换实现，审计
LuckyToken 的 openai-responses adapter 转换是否完备。只读分析，不改代码。

背景：LuckyToken 是 OpenAI Responses Client Protocol 的服务端适配。
真实 Codex 客户端（CLI + 桌面应用）每次请求发送完整历史（全量 Responses
请求），LuckyToken 把 Responses wire 转成 Pi AI IR（Context /
AssistantMessage），交给 Provider，再把 Provider 的 Pi 结果转回 Responses
wire。因此 Responses wire ↔ Pi IR 双向转换是核心正确性所在。

Pi AI 包里有 OpenAI 官方的同一对转换（Provider 侧）：它把 Pi IR 转成
OpenAI Responses wire（出站），并把 Responses wire 转回 Pi IR（入站）。
方向与 LuckyToken 相反（LuckyToken 是服务端收 Responses、Pi 包是客户端发
Responses），但同一份 Pi IR 契约，正好可以逐字段对照。

## 请研究以下内容

### 1. 对照双方

A. Pi AI 包（官方实现，参考）：
- `pi-agent/packages/ai/src/api/openai-responses.ts`
- `pi-agent/packages/ai/src/api/openai-responses-shared.ts`
- `pi-agent/packages/ai/src/api/openai-codex-responses.ts`（Codex 变体）
- （必要时）`pi-agent/packages/ai/src/api/azure-openai-responses.ts`
- Pi IR 类型定义：`node_modules/@earendil-works/pi-ai/dist/types.d.ts`
  （`Context`、`Message`、`AssistantMessage`、`Tool`、`ToolCall`、`Usage` 等）

B. LuckyToken（我方实现，被审计）：
- `src/protocols/openai-responses/request.ts`（Responses 请求 → Pi Context）
- `src/protocols/openai-responses/response.ts`（Pi AssistantMessage → Responses 响应）
- `src/protocols/openai-responses/sse.ts`（SSE 渲染）
- `src/protocols/openai-responses/session-state.ts`（previous_response_id 历史）
- 规范：`doc/Protocols/OpenAI Responses Client Protocol.md`（v0.1.0，D1–D12）
- 测试：`test/unit/openai-responses-*.test.ts`、
  `test/integration/openai-responses-replay.test.ts`、
  `test/fixtures/codex-cli-requests/`（27 个真实 Codex 请求样本）

### 2. 具体任务（逐项对照）

对以下每一类，逐字段对比「Pi 包怎么转 vs LuckyToken 怎么转」，找出
LuckyToken 缺失、错误、或与官方语义不一致的地方：

1. 请求侧（Responses wire → Pi IR）：
   - input item 类型覆盖：`message`（user/assistant/developer/system）、
     `reasoning`、`function_call`、`function_call_output`、`custom_tool_call`、
     `custom_tool_call_output`、`compaction`/`compaction_summary`、
     `context_compaction`、`agent_message`、`web_search_call`、
     `tool_search_call`/`tool_search_output`、`local_shell_call`、
     `additional_tools`、`compaction_trigger`
   - content part 类型：`input_text`/`text`/`output_text`/`input_image`/
     `input_file`/`refusal`/`encrypted_content`；图片的 data URL vs file_id
   - 工具定义归一化：function/custom/namespace/tool_search/web_search；
     parameters 缺失/非对象；strict；freeform
   - reasoning 附着规则（顺序、跨 call item、encrypted envelope）
   - 选项映射：`max_output_tokens`/`temperature`/`top_p`/`stop`/
     `reasoning.effort`/`parallel_tool_calls`/`tool_choice`/`text.format`
     （结构化输出）/`store`/`stream`/`include`/`prompt_cache_key`

2. 响应侧（Pi IR → Responses wire）：
   - output item 形状：`message`/`reasoning`/`function_call`/`custom_tool_call`
     （对比 Pi 包出站时怎么生成这些 item 的 id、字段、顺序）
   - usage 映射：`input_tokens`/`output_tokens`/`total_tokens`/
     `input_tokens_details.cached_tokens`/`output_tokens_details.reasoning_tokens`
     —— 特别核对 Pi 包对 cache read/write、reasoning tokens 的拆分规则
   - stopReason → status 映射（completed/incomplete/failed、max_output_tokens）
   - SSE 事件序列（created → output_item.done → completed/failed → [DONE]）
   - 错误响应形状（error.type 语义）

3. IR 边界正确性：两侧是否都严格走 Pi `Context`/`AssistantMessage`，
   有没有把 Responses 特有的语义泄漏到 Provider 侧、或反之。

### 3. 输出格式

给出一份结构化对比报告：

- 逐类对照表：`Pi 包做法 | LuckyToken 做法 | 差异 | 影响/风险`
- 按严重度分级的问题清单：
  - P0：会导致真实 Codex 请求失败/语义错误（对照 27 个真实样本验证）
  - P1：缺失但真实客户端会用到（如 tool_search、text.format）
  - P2：边缘/未来（如 compaction、encrypted envelope）
- 对每个问题：指出具体文件/行号、为什么 Pi 包是对的（或为什么我们的
  取舍合理）、建议的最小修复
- 结论：我们的转换在哪些方面比 Pi 包更合适（服务端视角）、哪些必须改

### 4. 约束

- 只读分析：不修改任何代码、不提交。
- 遵守 Pi IR 第一边界（AGENTS.md）：LuckyToken adapter 不得 import
  具体 Provider；Pi 包是参考实现，不是要照搬的架构。
- `pi-agent/` 整棵树不可修改，只读。
- 对照以实际代码为准（行号/字段），不要凭印象；有疑问先读源码再下结论。
- 若发现「我们故意不做而 Pi 包做了」的差异（如 text.format、per-delta
  流式），区分「设计取舍」和「真正缺口」，不要一概列为 bug。
- 参考 27 个真实 Codex 请求样本（`test/fixtures/codex-cli-requests/`）验证
  结论：样本里实际出现的字段，我们的转换是否都正确处理。

### 5. 交付物

把对比报告写入 `doc/PiAiVsOpenAIResponsesAdapter-Comparison.md`（或建议的
文件名），并在回复里给出摘要 + 最重要的 3-5 个发现。
