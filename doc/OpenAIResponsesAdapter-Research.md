# OpenAI Responses Client Protocol Adapter — 调研报告

> 日期：2026-08-12
> 调研对象：`D:\project\opencodex`（v2.13.0，MIT，@bitkyc08/opencodex）
> 目的：为 LuckyToken 增加 OpenAI Responses Client Protocol（适配 opencodex 的「增量请求 + 历史拼接」机制），并严格保持 Pi IR 边界。

## 1. 需求背景

OpenAI Responses 客户端（Codex CLI / Codex App / SDK）的请求特点是：

- **不发送完整历史对话**：每次请求只带「增量」（本次新增的 input items）。
- 用 **`previous_response_id`** 引用之前的响应，表示「继续这个会话」。
- 服务端（OpenAI）本应保存会话状态；但 LuckyToken 作为桥接层，上游可能是 CommandCode 等**无状态** Provider，不认 `previous_response_id`。
- 因此 **LuckyToken 必须在 Client Protocol adapter 层保存历史，把增量展开成完整输入**，再转成 Pi IR 交给 Provider。

opencodex 正是这样做的，其核心机制是「本地保存 response → 展开 previous_response_id」。

## 2. opencodex 核心机制（要移植的部分）

### 2.1 文件位置

- `src/responses/state.ts`（1039 行）—— 会话状态存储 + 展开
- `src/responses/parser.ts`（约 700 行）—— Responses 请求解析成内部消息
- `src/adapters/openai-responses.ts`（1404 行）—— Responses 适配（清洗、规范化、转发）
- `src/server/responses/core.ts`（数千行）—— 服务器端编排（**不要移植**）

### 2.2 核心：历史保存 + 增量展开

**保存**（`state.ts:950` `rememberResponseState(requestBody, response)`）：

```ts
// 关键逻辑（简化）：
if (request.store === false && !opts?.force) return;  // store:false 默认跳过
if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
if (response.status === "incomplete") {
  // 仅 max_output_tokens 的 incomplete 才保存；其余（content_filter 等）不保存
  if (details?.reason !== "max_output_tokens") return;
} else if (response.status !== undefined && response.status !== "completed") return;

setResidentEntry(response.id, {
  createdAt: now(),
  items: [...inputItems(request.input), ...response.output],  // 本次输入 + 输出
});
```

**展开**（`state.ts:843` `expandPreviousResponseInput(body)`）：

```ts
const previousId = request.previous_response_id;
if (!previousId) return body;
const previous = states.get(previousId);
if (!previous) return body;  // 找不到：退回裸增量（fail-open）
return {
  ...request,
  input: [...previous.items, ...inputItems(request.input)],  // 历史 + 增量
};
```

**inputItems**（`state.ts:720`）：

```ts
function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}
```

### 2.3 opencodex 的重量级设施（LuckyToken 不需要）

| 设施 | opencodex 用途 | LuckyToken 是否需要 |
|---|---|---|
| 磁盘 spill store | 大响应降级到磁盘 | 否（内存即可） |
| 快照持久化（debounce + 原子写） | 进程重启恢复会话 | **待决策** |
| TTL 1h + 1000 条上限 + 64MB 预算 | 多租户代理内存保护 | 简化（或按会话数上限） |
| 加密 payload（encrypted-payload.ts） | Codex 加密内容 | 否 |
| metrics / system-routes | 运维观测 | 否 |
| reasoning-replay-cache、compaction、tool bridge | Codex 特定高级功能 | 否（首版） |

### 2.4 关键语义决策点（opencodex 的选择）

1. **找不到 previous_response_id**：opencodex **fail-open**（退回裸增量），并在日志警告。它不 400，因为 Codex 会自己重发完整历史。
2. **store:false**：opencodex 默认**不保存**（`request.store === false` 跳过），除非 `force`（WS 通道 force）。LuckyToken 需要决定是否尊重 `store` 字段。
3. **incomplete 响应**：只有 `reason: "max_output_tokens"` 才保存（部分输出可续），content_filter 等不保存。
4. **保存内容**：`inputItems(request.input) + response.output`（原始 Responses items，不转消息）。

## 3. Responses 请求结构（parser.ts 解析的 input items）

`input` 可以是：
- **string** → 单个 user 消息
- **数组**，每个 item 有 `type`（或 `role` 隐式）：
  - `message`（role: user/assistant/system，content 为 string 或 content part 数组）
  - `function_call`（call_id + name + arguments）
  - `function_call_output`（call_id + output）
  - `custom_tool_call` / `custom_tool_call_output`
  - `local_shell_call`（codex-rs 特有）
  - `reasoning`（推理内容，需附着到后续 assistant）
  - `web_search_call` / `web_search_tool_call`
  - `agent_message`（子代理消息 → 转 user 角色）
  - `compaction` / `compaction_summary` / `context_compaction`（压缩历史）
  - `additional_tools`（内嵌工具定义）
  - `compaction_trigger`

`instructions` 字段（顶层）→ system prompt。

**→ 转 Pi IR 时，核心是把这些 items 映射成 Pi `Context.messages`（role: user/assistant/toolResult，含 text/thinking/toolCall 块）。** opencodex 的 `parseRequest`（parser.ts:296 起）就是干这个的，但其目标类型是它自己的 `OcxMessage`，不是 Pi `Message` —— **必须重写映射到 Pi 类型**，不能直接搬。

## 4. Pi IR 边界（AGENTS.md 硬约束）

```
OpenAI Responses Wire（增量 + previous_response_id）
    ↕
OpenAI Responses Client Protocol adapter（新模块，LuckyToken-owned）
  ├─ 会话状态：保存 response → response_id → items（adapter 自己的能力）
  ├─ 展开 previous_response_id → 完整 input
  └─ 完整 input → Pi Context / Models
    ↕
Provider adapter → Upstream Wire
```

- **会话历史拼接是 Client Protocol adapter 的职责**（Client Wire ↔ Pi 转换的一部分），不跨 Pi 边界。
- adapter 不得 import/inspect 任何具体 Provider 或上游协议。
- 会话状态（内存 Map）属于 adapter 能力内聚：行为 + 数据 + 状态 + 代码 + 测试同属一个模块。
- Provider 侧完全无感知（它只看到完整历史）。

## 5. LuckyToken 现有参照结构

### 5.1 ClientProtocolHandler 契约（`src/http.ts:1`）

```ts
export interface ClientProtocolHandler {
  readonly method: string;   // "POST"
  readonly pathname: string; // "/v1/responses"
  handle(request: Request): Promise<Response>;
}
```

运行时按 `method + pathname` 路由（`src/http.ts:104-106`），LuckyToken 现在只有 `POST /v1/messages`（Anthropic）。加 OpenAI Responses 就是加一个 `POST /v1/responses` 的 handler。

### 5.2 Anthropic handler 的转换流程（`src/protocols/anthropic/handler.ts:181-223`）

参照它的骨架：

```ts
const validatedRequest = validateAnthropicSourceRequest(body);   // 校验 wire
const invocation = convertValidatedAnthropicRequest(...);        // wire → Pi Context
const piOptions = composeOptions(invocation.options, { sessionId, signal, ... }, routerDefaults);
freezePiInvocation(model, invocation.context, piOptions);        // 冻结不可变
const message = await execute(dependencies.models, model, invocation.context, piOptions); // Pi Models
const target = renderAnthropicTextMessage(message, ...);         // Pi 结果 → wire
const prepared = renderAnthropicAtomicSse(target);               // 渲染 SSE/JSON
```

Pi `Context`（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:370`）：

```ts
export interface Context {
  systemPrompt?: string;
  messages: Message[];   // role: user | assistant | toolResult，content 为块数组
  tools?: Tool[];
}
```

### 5.3 Pi Message 结构（转 IR 目标）

- `role: "user" | "assistant" | "toolResult"`
- `content`：块数组，块类型含 `text`、`thinking`、`toolCall`（id/name/arguments）
- `toolResult` 消息：`toolCallId` + `isError` + content（text 块）
- assistant 消息：`stopReason`（stop/length/toolUse/error/aborted）+ api/provider/model 身份

CommandCode provider 的 `convertCommandCodeMessages`（`src/providers/commandcode-private/provider.ts`）展示了 Pi Message → 上游的完整处理，反过来就是 Responses items → Pi Message 的映射参照。

## 6. 移植方案（最小架构）

### 6.1 新增模块（LuckyToken-owned）

```
src/protocols/openai-responses/
├── session-state.ts    // 内存 Map + remember + expand（~60 行，无 spill/持久化）
├── request.ts          // Responses wire 校验 + items → Pi Context 转换
├── response.ts         // Pi AssistantMessage → Responses wire 输出（SSE/JSON）
├── handler.ts          // createOpenAIResponsesHandler：ClientProtocolHandler
└── index.ts
```

### 6.2 session-state.ts 最小实现（从 opencodex 提炼）

```ts
const states = new Map<string, { createdAt: number; items: unknown[] }>();

export function rememberResponseState(request, response): void {
  if (request.store === false) return;              // 尊重 store:false
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete" && response.incomplete_details?.reason !== "max_output_tokens") return;
  if (response.status !== undefined && response.status !== "completed" && response.status !== "incomplete") return;
  states.set(response.id, {
    createdAt: Date.now(),
    items: [...inputItems(request.input), ...response.output],
  });
}

export function expandPreviousResponseInput(body): unknown {
  const previousId = body.previous_response_id;
  if (typeof previousId !== "string") return body;
  const previous = states.get(previousId);
  if (!previous) return body;                       // fail-open（与 opencodex 一致）
  return { ...body, input: [...previous.items, ...inputItems(body.input)] };
}
```

（TTL / 上限按需加，默认可先不 TTL，但建议至少加 MAX_ENTRIES 防泄漏。）

### 6.3 handler.ts 骨架（参照 Anthropic handler）

```ts
export function createOpenAIResponsesHandler(options): ClientProtocolHandler {
  return {
    method: "POST",
    pathname: "/v1/responses",
    handle: async (request) => {
      // 1. 解析 + 校验 Responses wire（含 previous_response_id）
      // 2. expandPreviousResponseInput(body) → 完整 input
      // 3. items → Pi Context（request.ts）
      // 4. resolveModel(selector)（复用 src/model-resolution.ts）
      // 5. execute(models, model, context, piOptions)
      // 6. rememberResponseState(body, result) ← 保存本次会话
      // 7. Pi result → Responses wire（SSE 或 JSON）
    },
  };
}
```

### 6.4 组合根接入（`src/composition.ts` + `src/http.ts` 路由）

- `createConfiguredLuckyTokenComposition` 增加 OpenAI Responses handler（若配置启用）。
- `src/http.ts` 路由已支持多 handler（按 method+pathname），无需改。
- 认证：**每个 Client Protocol 有独立 Auth**（AGENTS.md 硬约束）——OpenAI Responses 需要自己的 auth 文件/通道，不能复用 Anthropic 的。

## 7. 待决策事项（新对话开工前需明确）

| # | 决策 | opencodex 做法 | 建议 |
|---|---|---|---|
| 1 | 会话状态持久化？ | 磁盘快照 + spill | 首版内存即可；若需重启恢复再加 |
| 2 | previous_response_id 找不到 | fail-open（退回增量） | **默认 fail-open**，与 opencodex 一致；可加日志 |
| 3 | store:false 尊重？ | 跳过保存 | 尊重（Codex 默认 store:false，但 WS force） |
| 4 | 会话上限 | 1000 条 + TTL 1h + 64MB | MAX_ENTRIES（如 1000）+ 可选 TTL |
| 5 | 认证方式 | 独立 | OpenAI Responses 独立 auth 文件（如 `client-auth/openai-responses.json`） |
| 6 | SSE 输出格式 | Responses SSE（response.created / output_item.added / output_text.delta / response.completed） | 按 OpenAI Responses 官方 SSE 规范 |
| 7 | 是否支持流式 `stream: true` | 支持 | 首版支持（参照 Anthropic handler 的 SSE） |
| 8 | tool calls 双向 | 支持 | 需映射 Responses function_call ↔ Pi toolCall |
| 9 | model selector | `provider/model_id` | 复用 `src/model-resolution.ts` 的 selectorTool + resolveModel |

## 8. 测试策略（对齐 AGENTS.md 测试原则）

- **单元**：session-state（remember/expand/找不到/TTL）、items→Pi 映射（message/function_call/function_call_output/reasoning/toolResult）、Pi→Responses 渲染。
- **集成**：`test/support/` 加 `openai-responses-serving.ts`（仿 commandcode-serving.ts），注入 fetch + fixture Responses 上游，验证：增量请求展开、历史拼接、SSE 输出、认证、错误、取消。
- **组合**：`configured-composition` 加 OpenAI Responses handler 注册测试。
- **契约**：`certification` 若扩展需同步（可先不加）。

## 9. 移植红线（AGENTS.md）

- **`pi-agent/` 整棵树不可修改**（opencodex 与 pi-agent 无关，但同样只读）。
- **不复制 opencodex 的 core.ts / bridge.ts / adapter 单体** —— 只提炼 session-state 的最小子集 + 重写 wire↔Pi 映射。
- **不把 Responses 语义泄漏到 Provider 侧**：Provider 只看到展开后的完整 Pi Context。
- **不引入第二 IR**：直接用 Pi `Context` / `AssistantMessage`。
- 认证隔离：OpenAI Responses handler 用自己的 Auth 实例和 token 文件。

## 10. 参考文件清单

| opencodex 文件 | 用途 | 移植方式 |
|---|---|---|
| `src/responses/state.ts` | 会话状态（remember/expand） | 提炼 ~60 行最小子集 |
| `src/responses/parser.ts` | Responses input → 内部消息 | 重写为 → Pi Message |
| `src/adapters/openai-responses.ts` | wire 清洗/规范化 | 参考，不移植 |
| `src/server/responses/core.ts` | 服务端编排 | 不移植 |
| `src/types.ts`（OcxMessage 等） | 内部类型 | 不移植（用 Pi 类型） |

## 11. 一句话总结

**要移植的核心**：`rememberResponseState` + `expandPreviousResponseInput` 的「保存 input+output → 按 response_id 展开拼接」语义（约 60 行）。
**要重写的**：Responses wire ↔ Pi IR 双向映射（opencodex 的映射目标是它自己的类型，必须重写为 Pi 类型）。
**不要移植的**：opencodex 的磁盘持久化、spill、加密、compaction、reasoning-replay、metrics、core.ts 编排。
