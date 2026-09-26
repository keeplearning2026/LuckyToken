# Provider Native Responses 工具调用邻接规范化修改计划

Status: implemented v5.1（PRD 层授权已给出；离线实现与认证见下）
Authority: 第 2 节的契约已按第 12 节授权落入仓库文档与实现。
Scope: Provider Native Preservation，且仅 `operation === "responses"`（不含 compact）请求方向的窄结构归一化。

实施状态（2026-09-26）：

| 计划步骤 | 状态 |
|---|---|
| 代码（3.1–3.6、4.1–4.3） | 已完成：`src/provider-native-responses/tool-call-adjacency.ts` + 三个 transport 接入 + 三条 notice code |
| 5.1–5.3 结构与字节认证 | 已完成：`test/unit/provider-native-tool-call-adjacency.test.ts`（17 例），并在两个基线测试中保留原断言、新增命中用例 |
| 5.6/5.7 负回归与诊断五态 | 由现有单测与集成套件覆盖并通过 |
| 5.9 仓库门禁 | 单测 1790/1790、typecheck、eslint 通过。集成 588 例中 586 通过：`test/integration/backend-application.test.ts` 的 quit/projection 用例在并行全量运行中偶发失败（单独运行 13/13 通过，且不引用 provider-native 任何模块），与本改动无因果关系 |
| 5.4 生产接缝 stub-upstream e2e | 已完成：`test/integration/provider-native-adjacency-stub-upstream.test.ts`（本地 HTTP stub 用独立 oracle；① 改前同体被 oracle 判 400，② 同一 body 经 Token 后 stub 200 且逐字节等于预期排列、客户端 200、记 info notice，③ 非合格形状 stub 400、客户端 502、记 warning notice） |
| 5.5 隔离 CLI 多轮消费 | **未实施**。harness `test/online/run-provider-native-item-chain-replay.ts` 与本机 CLI（`%APPDATA%/npm/node_modules/@openai/codex/bin/codex.js`）均可用，但尚未解决如何让真实 CLI 自然产出 `view_image` 并行形状；按计划须与注入式回放区分记录 |
| 5.8 在线门禁 | **未完成**（按计划只能声明离线认证） |
| 4.4 的 28 条契约断言修订 | 已落盘（27 处文档 + 2 个测试文件新增用例） |

## 0. 本轮修订摘要（对第三轮复审的回应）

第三轮结论：**有条件批准**，P0 无，3 条 P1 + 1 条 P2 须在实施前写入契约。逐条落实：

| 第三轮条目 | v5 处理 |
|---|---|
| P1 重建公式未覆盖所有允许布局（`model` 在 `input` 之后、数组开闭符与边缘空白未定义） | 3.5 改为**与键序无关的编辑列表**定义（两处替换：model 值区间、数组内部区间），数组框架 `[`/`]`、`lead`/`tail` 与分隔符全部列为不变区间；输出完整复解析与 `parsed.input` 顺序写入采用条件；5.1/5.3 增加反向键序与边缘空白用例 |
| P1 重复键检查未说明按解码后键名 | 3.1 第 2/9 条与 3.5 明确：顶层键与元素的 `type`/`call_id`/`role`/`id` 均按 **JSON 解码后键名**判重；5.2 增加转义重复键用例 |
| P1 §4.4 仍漏列、且测试项归类有误 | 4.4 扩到 **28 条 / 9 个文件**：新增 PRD 445、PRD 725、实施计划 75；PRD 945 增加指向两条封闭例外的交叉引用；两个测试条目改为"**保留既有基线断言，新增命中用例**" |
| P2 reasoning 的 warning 条件与 3.7 不一致 | 3.7 定义第三条 code `provider_native_tool_call_group_unsupported_item`（warning），显式覆盖非 message 穿插（含 reasoning），并给出每请求上限与优先级；3.8 同步 |
| 建议：预检第 3 条写成"受支持两族" | 3.1 第 3 条已改写，避免与按 `id` 关联族产生歧义 |
| §2.8 替换文本仍需补三处 | 2.8 已补：仅限"原本有效且可作 model 投影"的 body（非法 JSON 保持既有失败）、"其它元素相对顺序"、message 必须位于本组至少一个结果之后且组闭合之前 |

## 1. 问题与证据

### 1.1 症状

Codex Desktop 会话在 Provider Native Preservation 车道连续收到 HTTP 502，客户端可见 body：

```json
{"error":{"message":"Upstream provider failed","type":"api_error","code":null,"param":null}}
```

| 会话 | 车道/模型 | 首次失败 | 之前 success | 502 次数 | 结束 |
|---|---|---|---:|---:|---|
| `01a0deed-5c96-76e0-9b8b-f9e622270f1c` | provider_native / `commandcode-goat` `deepseek/deepseek-v4.1-flash` | 19:33:47Z | 284 | 11 | 19:36:52Z 用户中断 |
| `01a0df26-3e27-75d2-9b0c-d28559278669` | 同上 | 19:39:15Z | 68 | 27 | 19:40:58Z 用户中断 |

事件链（`88f2c2a8-4a1a-4333-b8a9-bcf424a9242e`）：`read_provider_native_response`
status=400 → `failure_detected` `provider_http_400` origin=provider retryable=false →
`prepare_provider_native_error_response` 502。上游 400 原文：

```
An assistant message with 'tool_calls' must be followed by tool messages responding
to each 'tool_call_id'. (insufficient tool messages following tool_calls message)
```

### 1.2 归属：不是 Token 的改写

`6bd358a3-e20b-4da8-8d80-1b7be6e7767a` 出入站对比（第一轮审阅独立复核）：6,022,794 /
6,022,786 B，269 项 `input` 逐项相等，唯一顶层差异是 `model`，无 `previous_response_id`。
`src/provider-native-responses/*` 无 `previous_response_id`、`stateFile`、`replay` 引用。

### 1.3 触发形状

```
264  function_call         view_image    call_00_923TTZOVfeFShOLBlYkD5994
265  function_call         exec_command  call_01_dDjaCk4R1Znks3wVJKT45680
266  function_call_output  call_00_923TTZOVfeFShOLBlYkD5994
267  message  role=developer                                    ← <image_resize_notice>
268  function_call_output  call_01_dDjaCk4R1Znks3wVJKT45680
```

| 会话 | 图片输出 | 提示写入 | 同组另一工具输出 |
|---|---|---|---|
| `01a0deed` | 19:33:33.268Z | 19:33:33.274Z（+6 ms） | 19:33:34.090Z（+822 ms） |
| `01a0df26` | 19:39:11.742Z | 19:39:11.750Z（+8 ms） | 19:39:12.335Z（+585 ms） |

### 1.4 形状普查（口径与复现方法）

已捕获且可解析的 `client_request_wire` 共 **314** 份 / **552,914,877 B**；其中 `input` 为数组
**310** 份 / **551,736,567 B**，字符串 4 份。失败偏置成立：314 份中成功 outcome 为 **0**。

| 观测项 | 结果（310 份数组 input） |
|---|---|
| 项类型 | `message` 5679、`reasoning` 7469、`function_call` 10355、`function_call_output` 10355、`custom_tool_call` 351、`custom_tool_call_output` 351、`agent_message` 228、`additional_tools` 80 |
| 未配对 call / 孤立 output / 重复 call_id | 0 / 0 / 0 |
| 组内穿插 `message` | 28 份（全属 `01a0df26`，下标 267，27 failed + 1 aborted） |
| 组内穿插加密 `reasoning` | 49 份（全属 `01a0d40e`，下标 60，48 failed + 1 aborted） |

Rollout 普查（所有者侧）：09-25/09-26 的 15 个 rollout 中含"组内非 tool 项"的并行组仅 2 组；
09-14 至 09-26 的 143 个 rollout 中未配对 call/output 为 0。复现：只读
`C:\Users\huich\.codex\sessions\2026\09\**\rollout-*.jsonl` 的 `response_item.payload.type` 与 `call_id`。
方法学更正：第一版脚本组闭合后未重置相位曾误报 1814 例，修正后为 0。

### 1.5 第二类穿插：`reasoning` 落在组内（归因未定）

`01a0d40e`（`gpt-6-luna`）下标 57–63：三个 `function_call` → `reasoning`（含
`encrypted_content`）→ 三个 `function_call_output`；上游返回网关层
`{"error":{"message":"Invalid input","type":"invalid_request_error","param":"input"}}`。
该会话 50 份请求体全部含加密 reasoning（49 组内 + 1 组外 aborted），failure 落在未分类的
`request_failed_without_specific_cause`。**归因限制**：无法区分位置与内容，v1 不改变该形状（3.8）。

## 2. 冻结的产品契约（提案内容）

### 2.1 适用范围

仅 Provider Native Preservation `operation === "responses"`；compact 恒不重排。
统一适用于该边界：不识别 Codex User-Agent，不按 Provider/model/transport 名特判。
不改动 Provider transport、Pi、Direct Mode、Semantic Conversion、Anthropic Provider Native。

### 2.2 规则

```text
在同一 tool_calls 组内，若 role=developer 的 message 出现在
"该组已产生至少一个 tool 结果之后、该组闭合之前"，
则把它延后到该组最后一个 tool 结果之后；只重排，不新增、不删除、不改内容。
```

位置范围与证据一致（1.3 实测形状）；首个结果之前不在范围内。

### 2.3 "只重排"的边界

不增删/合并/拆分 input 项；不改 tool 名称/参数/结果/call_id；不合成缺失结果；
不移 `reasoning`、`agent_message`、`additional_tools` 或未知类型；
message 之间、tool 结果之间各自保持原有相对顺序；**其它元素的相对顺序也不变**。

### 2.4 保留与回退

未命中：输出与今天的 `rewriteModelJson` 逐字节相同。命中：除被移动的 developer message
与顶层 `model` 外，其余字节原样。**整份请求放弃原则**：任一资格或一致性检查失败，
整份请求不重排，原样透传，只按 3.7 发只读观测。

### 2.5 非目标

不处理真悬空调用；不处理 `agent_message` / `encrypted_content` 限制；不改变上游错误到
客户端 502 的映射（第 10 节）。

### 2.6 为什么不是被禁止的 projector / repair 层

无 source-protocol × target-API 矩阵、无 registry、无补充载体、无 Provider payload 构造；
不进入 Pi AI IR；规则是协议级结构不变式；不按上游名开关。
等价先例：`doc/ProtocolCompareCauses.md:61`（及第 20 行）记录 Pi `transformMessages`
会把未闭合工具交换之间的中途 system/developer 暂存到交换闭合后再写。

### 2.7 所有者决定

必须留在 native 车道（不引入请求级资格判定、不跨 lane 回退）；允许放宽契约；
不引入配置开关。PRD 层授权见第 12 节。

### 2.8 第二条例外的封闭表述（候选替换文本）

`TokenProviderCredentialProfilesPRD.md:29` 写 "The sole declared exception is first-party
Anthropic OAuth"，第 945 行（第 38 条）写 "the sole Provider Native body-projection exception"，
实施计划 396 行写 "does not ... normalize model-visible content"。本提案确实改变 model-visible
的**项顺序**（不改内容），因此必须写成两条**各自封闭**的例外。建议替换文本（已按第三轮意见补三处）：

> For each send, the lane keeps the client's JSON text authoritative and projects the top-level
> `model` string span. Only for an otherwise valid, model-projectable Provider Native Responses
> request (`operation === "responses"`, not compact), it may additionally defer original
> `role=developer` message item slices that appear after at least one result of a fully validated,
> closed tool-call group and before that group closes, to immediately after that group's final
> output, under the qualified adjacency contract. If any qualification, span, or reconstruction
> check fails, the request receives only the model projection. Malformed JSON still fails under the
> existing rules. The lane does not parse and re-serialize the body, change item content, change
> the relative order of any other item, insert Pi defaults, remove extensions, or perform any other
> model-visible normalization.

必须保留的限定词：`operation === "responses"`（排除 compact）、"otherwise valid and
model-projectable"（非法 JSON 走既有失败）、"after at least one result ... before that group
closes"、"original ... message item slices"、"relative order of any other item"。

## 3. 算法

### 3.1 资格预检（整份请求；任一失败即不重排）

1. `operation === "responses"`。
2. 原文是单个顶层 JSON 对象；**按解码后键名**，顶层键无重复；`model` 唯一且为字符串；
   `input` 唯一且为数组。
3. **受支持两族**（`function_call`/`function_call_output`、`custom_tool_call`/
   `custom_tool_call_output`）的每个 call 与每个 output，其 `call_id` 必须是**非空原始字符串**；
   禁止 `String()`、数字、`null`、缺失值；以原值比较。按 `id` 关联的族不属此列（见第 5 条）。
4. 请求内 call_id **全局唯一**（跨组重复也拒绝）；无未配对 call、无孤立结果。
5. call/output **同族**；按 `id` 关联的族（如 `local_shell_call_output`，见
   `src/protocols/openai-responses/request.ts:2070`）不纳入，出现在受支持组内即放弃。
6. 每组 call 段连续：组内出现第一个非 call 项后不得再出现 call。
7. 组内只允许 `role=developer` 的 message，且必须出现在该组**已产生至少一个结果之后**、
   组闭合之前；其它类型、其它角色、或出现在首个结果之前 → 放弃。
8. 所有组均闭合。
9. **按解码后键名**，任一元素的 `type`、`call_id`、`role`、`id` 不得重复。
10. 3.5 的 span、编辑列表与字节检查可完成。

任一失败且"确实识别出候选形状或非 message 穿插"时按 3.7 发一条 notice；否则静默。

### 3.2 分组状态机

```ts
type Move = { readonly from: number; readonly to: number };

function planMoves(input: readonly unknown[]): Move[] | "abstain" {
  const moves: Move[] = [];
  let pending = new Map<string, string>();   // callId(原始字符串) -> family
  let candidates: number[] = [];
  let inCallSegment = true;
  let seenOutput = false;

  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!isRecord(item)) return "abstain";
    const type = item.type;

    if (isCallType(type)) {
      if (typeof item.call_id !== "string" || item.call_id.length === 0) return "abstain";
      if (pending.size > 0 && !inCallSegment) return "abstain";
      pending.set(item.call_id, familyOf(type));
      continue;
    }
    if (isOutputType(type)) {
      if (typeof item.call_id !== "string" || item.call_id.length === 0) return "abstain";
      if (pending.size === 0) return "abstain";
      if (pending.get(item.call_id) !== familyOf(type)) return "abstain";
      pending.delete(item.call_id);
      inCallSegment = false;
      seenOutput = true;
      if (pending.size === 0) {
        for (const from of candidates) moves.push({ from, to: i });
        candidates = []; inCallSegment = true; seenOutput = false;
      }
      continue;
    }
    if (pending.size === 0) continue;
    if (type === "message" && item.role === "developer" && seenOutput) {
      candidates.push(i); inCallSegment = false; continue;
    }
    return "abstain";     // 含 reasoning / agent_message / additional_tools / 未知 / 按 id 关联族
  }
  return pending.size === 0 ? moves : "abstain";
}
```

要点：`seenOutput` 强制 2.2 的位置范围；`call_id` 全程原值；候选与任何非 call 项都会关闭
call 段。

### 3.3 重建规则

```text
源下标排列 P：未移动元素按原下标升序，被延后的 developer message 插到其所在组闭合元素之后。
```

### 3.4 字节保留重建（说明）

**为什么必须字节保留**：这是本车道已认证的契约。
`test/unit/responses-native-provider-sender.test.ts:91` 断言"模型已匹配时原始字节完全不变"，
`:105` 断言"只替换顶层 model 字面量、不归一化其它 JSON token"，夹具含 `9007199254740993`、
`-0`、`1e+30`、自定义空白与嵌套 `model`；`test/unit/provider-native-responses-contract.test.ts:133`
同样以此为基线。全量 `JSON.stringify` 会改写这些写法并击穿入站/出站字节对比能力。
（"缓存按 JSON 字节命中"曾被当作理由，第一轮审阅已否定；v5 不引用。）

做法：在原文里搬文本切片，不重新生成 JSON。

### 3.5 排列与字节不变量（与键序无关的编辑列表；采用条件）

**原文区间定义**：`E_k = [e_k.start, e_k.end)` 为第 k 个元素切片；`arrayOpen`/`arrayClose` 为
顶层 `input` 值的 `[` 与 `]`；`lead` = `[` 与 `E_0` 之间的字节；`sep_k` = `E_k` 与
`E_{k+1}` 之间的字节；`tail` = `E_{n-1}` 与 `]` 之间的字节；`modelValue` = 顶层 `model`
字符串字面量区间。

**输出 = 对原文施加两个互不重叠的替换（与两字段在文中的先后无关）**：

```text
R_model   : modelValue -> JSON.stringify(resolvedModelId)          （仅当不同）
R_interior: (arrayOpen, arrayClose) -> lead + E_{P[0]} + sep_0 + E_{P[1]} + ... + E_{P[n-1]} + tail
```

`[`、`]`、`lead`、`tail`、每个 `sep_k` 都是**不变区间**，因此数组框架与首尾空白原样保留；
两处替换按偏移从右往左应用，并先校验两者不重叠。

**采用条件**（任一失败 → 不采用重建，返回原始 body，按 3.7 记 notice）：

1. 顶层 `input`（解码键名）唯一，其值区间恰为 `[arrayOpen, arrayClose]`；顶层 `model` 唯一。
2. 元素 span 数 = `parsed.input.length`；每个 span 切片重解析后与 `parsed.input[i]` 深相等。
3. **按解码后键名**，顶层无重复键；每个元素的 `type`/`call_id`/`role`/`id` 无重复键。
4. 输出可完整复解析；`input` 长度不变，且**逐位置**等于 `parsed.input[P[k]]`；
   顶层键集合不变；除 `input` 与 `model` 外所有值深相等。
5. `parsed.input` 的顺序与输出文本顺序一致（供 3.6 使用）。
6. 字节相等：输出 `input` 第 k 项切片逐字节等于原文 `E_{P[k]}`；`[`、`]`、`lead`、
   每个 `sep_k`、`tail` 在输出中原位且逐字节相同；`modelValue` 与数组内部区间之外的
   所有字节逐字节保持不变（覆盖 `1e+30`、`-0`、大整数、转义、嵌套 `model` 等原文写法）。

### 3.6 与 model 投影、parsed 一致性

```ts
projectProviderNativeBody(rawBody, modelId, operation): {
  parsed: Record<string, unknown>;   // 命中时 input 顺序与发送文本一致
  text: string;
  outcome: "model-only" | "deferred" | "abandoned" | "unsupported-item";
}
```

未命中走既有 model-only 路径。命中时 `parsed.input` 必须按 P 重排，避免 `openai.ts:163` 的
`copilotDynamicHeaders(parsed)` 与实际 wire 描述不同顺序。

### 3.7 观测规则（统一，每请求至多一条）

| code | severity | 触发条件 |
|---|---|---|
| `provider_native_tool_call_adjacency_deferred` | info | 至少一个 move 被采用 |
| `provider_native_tool_call_group_abandoned` | warning | 识别出 developer message 候选形状，但请求未被重排 |
| `provider_native_tool_call_group_unsupported_item` | warning | 受支持组内出现非 call/output 项（`reasoning`、`agent_message`、`additional_tools`、未知类型、非 developer 角色的 message、按 `id` 关联族，以及出现在**首个结果之前**的 developer message），请求未被重排 |

优先级（同时命中时只发一条）：`unsupported_item` > `group_abandoned` > `deferred`。
整份放弃使 `deferred` 与另两条互斥。

**不产生 notice 的正常空操作**：compact；`input` 为字符串/缺失；请求内不存在候选形状或
非 message 穿插；非法 JSON（走既有失败路径）；结构扫描无法完成（无法断言形状存在，记入第 8 节）。
notice 只读、有界、不含客户端文本或 body，且**不得声称 reasoning 的失败原因已确定**。
三个 sender 都发同样的通知并各有测试。

### 3.8 范围决定与非 message 穿插

v1 只移动 developer message。`reasoning` 组内穿插不改行为，但按 3.7 发
`provider_native_tool_call_group_unsupported_item`（warning）。消歧实验（后续）：
四格对照——① 原样、② 仅移出组、③ 仅去 `encrypted_content`、④ 移出组且去加密——
外加相同目标条件与连续性关系；当前约束下不得执行真实上游消歧。

## 4. 模块与接入位置

### 4.1 新增纯函数模块

`src/provider-native-responses/tool-call-adjacency.ts`：`qualifyToolCallAdjacency(parsed)`（3.1）、
`planToolCallAdjacencyMoves(parsed)`（3.2）、`projectProviderNativeBody(rawBody, modelId, operation)`
（3.6）。族别判定只认两族，**不使用** `_call` 后缀假设。

### 4.2 三个 transport 与 compact

`openai.ts` / `codex.ts` / `azure.ts` 的 `project_native_body` 调用新入口并传 `operation`；
compact 恒走 model-only。三者的 `send()` 都接受并使用 `observation`
（`codex.ts:78`、`azure.ts:88` 目前未接收）。

### 4.3 诊断接入

复用 `conversion_notice_observed`（`src/diagnostics/contract.ts:140`），不新增 kind/步骤；
按 3.7 的三条 code、优先级与"正常空操作"清单执行；诊断五态下输出与结局必须一致。

### 4.4 必须同时修订的契约断言（28 条 / 9 个文件）

| # | 文件 | 位置 | 现状要点 | 处理 |
|---:|---|---|---|---|
| 1 | `doc/TokenArchitecture.md` | 219 | native lane 只允许 endpoint/auth/header/identity + 响应侧 normalization | 增加本项 |
| 2 | `doc/Spec/TokenRequestJourneyDiagnosticsSpec.md` | 142 | `project_native_body` 输出为 "model-only projection or explicit Anthropic OAuth projection" | 增加本项与三条 code |
| 3 | `doc/ProductLimitations.md` | 64–65 | "changes only boundary-required facts such as the top-level model selector" | 增加本项 |
| 4 | `doc/Protocols/OpenAI Responses Client Protocol.md` | 33 | "Raw Responses wire remains authoritative except for boundary-required model identity projection ..." | 增加本项 |
| 5 | 同上 | 39 | "The body is not semantically reconstructed: only the top-level `model` string is projected." | 增加本项（保留数字写法/空白仍由客户端负责的句子） |
| 6 | `doc/Protocols/OpenAI Responses-Pi AI IR Conversion Method.md` | 608 | "applying only boundary-required model identity projection, Provider auth/header rules, ..." | 增加本项 |
| 7 | `doc/Spec/TokenProviderCredentialProfilesPRD.md` | 29 | "normally changes only ... The sole declared exception is first-party Anthropic OAuth" | 改为两条封闭例外 |
| 8 | 同上 | 129 | §5.6 "applies only the explicit managed-OAuth Anthropic body exception" | 增加本项 |
| 9 | 同上 | 445 | "It preserves the body semantics while rebuilding the Pi-owned transport envelope." | 明确"语义不变但项顺序有一次已认证位移" |
| 10 | 同上 | 447–448 | "The one exception to literal body preservation is `(providerId=anthropic, ...)`" | 改为两条例外 |
| 11 | 同上 | 485–486 | 第 5 条 "leaves every other body field, value, relationship, and model-visible semantic unchanged, except ... Anthropic" | 增加本项例外 |
| 12 | 同上 | 690 | "Provider Native body preservation with boundary-required `model` projection and only the closed Anthropic OAuth body exception" | 增加本项 |
| 13 | 同上 | 725 | 非目标："changing a Provider Native body field other than ... `model` projection or ... Anthropic differential" | 增加"已认证的 developer message 切片重排" |
| 14 | 同上 | 778 | "preserve each Provider Native body except for model identity projection and the closed Anthropic OAuth differential" | 增加本项 |
| 15 | 同上 | 818–819 | 反目标："changes any decoded request-body semantic other than ... model projection or ... Anthropic differential" | 增加本项 |
| 16 | 同上 | 888（第 40 条） | "differs only in the top-level `model` projection; no other field, value, relationship ... changed" | 增加本项 |
| 17 | 同上 | 891（第 43 条） | "only the permitted default `model` projection or ... Anthropic OAuth differential" | 增加本项 |
| 18 | 同上 | 945（第 38 条） | "is the sole Provider Native body-projection exception" | 增加指向两条封闭例外的交叉引用 |
| 19 | `doc/Spec/TokenProviderCredentialProfilesImplementationPlan.md` | 27 | "normally replaces only its top-level `model` identity. The sole exception is ... Anthropic" | 改为两条例外 |
| 20 | 同上 | 75 | 第 16 条 "its model rewriter preserves the original JSON text outside top-level `model` string spans" | 增加本项 |
| 21 | 同上 | 95 | 表格行 "preserves body except model and keeps its own transport/retry lifecycle" | 增加本项 |
| 22 | 同上 | 396 | "replaces only the top-level `model` string span ... does not ... normalize model-visible content" | 用 2.8 的文本替换 |
| 23 | 同上 | 403 | "Compression is permitted only when decoding produces the preserved body with the projected model." | 增加本项 |
| 24 | 同上 | 454 | 认证项 "decoded upstream body equals the client body except for ... model projection and, only for Anthropic OAuth, ..." | 增加本项 |
| 25 | 同上 | 829（第 2 项） | "prove the raw compatible body ... changes only the top-level `model`; ... text outside the model span remains byte-identical" | 增加本项 |
| 26 | 同上 | 961（第 13 项） | "each Provider Native body follows the default top-level `model`-only rule or the sole managed Anthropic OAuth ... exception" | 增加本项 |
| 27 | `test/unit/provider-native-responses-contract.test.ts` | 133 | 以"只改 model"为基线 | **保留原断言**，新增命中用例 |
| 28 | `test/unit/responses-native-provider-sender.test.ts` | 91、105 | 原始字节完全不变 / 只替换 model 字面量 | **保留原断言**，新增命中用例 |

**明确不改**：`ImplementationPlan.md` 433、850 与 `test/unit/anthropic-native-body-projection.test.ts:9`
仅约束 Anthropic 内部投影。

## 5. 测试与认证

### 5.1 结构夹具（合成）

夹具全部合成，真实捕获 body 不提交进仓库。覆盖：1.3 实测形状；`CALL A, OUT A, CALL A, message,
OUT A`；`CALL A, CALL B, OUT B, message, OUT A`（乱序同族，应可闭组且结果顺序不变）；
`CALL A, CALL B, OUT A, CALL C, message, OUT C, OUT B`（并发交叠，放弃）；族别错配（放弃）；
`local_shell_call_output` 组内（放弃）；call 段中间插入 message（放弃）；missing/数字/空字符串
`call_id`（各自放弃）；message 在首个结果之前（放弃）；**反向键序** `{"input":[…],"model":"…"}`；
**数组边缘空白**（`[ \n {…}, {…} \n ]`）；**转义重复键**（`"input"` 与 `"\u0069nput"`、
`"type"` 与 `"\u0074ype"`）。

### 5.2 纯函数结构认证

5.1 的全部形状；另含无穿插字节不变、同组多个穿插、两组只命中一组、未闭合组、孤立结果、
重复 ID（组内与跨组）、非 developer 角色、`input` 为字符串/缺失、非法 JSON、30 MB 级合成
body 的时间与内存边界。

### 5.3 排列与字节认证（对应 3.5 的采用条件）

逐位置断言输出 `input` 第 k 项逐字节等于原文第 P[k] 项切片；`[`/`]`/`lead`/`sep_k`/`tail`
原位且逐字节相同；数组内部区间与 `modelValue` 之外的字节逐字节不变（覆盖 `1e+30`、`-0`、
`9007199254740993`、转义、嵌套 `model`）；反向键序下同一断言成立；输出完整复解析；
`parsed.input` 顺序与文本一致。

### 5.4 生产接缝 e2e（stub upstream，两层状态分别断言）

Token 指向本地 stub upstream；stub 用**独立实现**的邻接 oracle 判断并返回 1.1 的 400。
"改前"控制组取**同一原始 body**，不经任何产品配置开关，也不以另一份不合格请求冒充同体对照。

| 场景 | stub 观察到的上游状态 | Token 返回客户端 |
|---|---|---|
| 基线（同一 body，未重排；含放弃路径） | 400 | **502**（alias 映射，`handler.ts:1082`） |
| 合格移动 | 200 | 200 |

另断言：命中时 `provider_native_outbound_request_wire` 组内无穿插且产生对应 notice；
放弃路径与基线完全一致，不承诺 stub 不收 400。

### 5.5 隔离 CLI 多轮消费

新建临时 `CODEX_HOME`（只复制 `config.toml`、`token-model-catalog.json`，`finally` 清理），
真实 Codex CLI 指向本地 Token + stub upstream，至少两轮含一次工具调用：下一轮历史仍含该
developer message 与全部 tool 结果、call/result 关联完整、不再进入连续 502 循环。
形状无法自然触发时用注入历史并明确标注。

### 5.6 负回归

Direct、Semantic、Anthropic Native、`operation === "compact"`、codex/azure compact 路径、
无穿插请求：body 与结局与改前完全一致。

### 5.7 诊断五态非干扰

disabled / throwing / saturated / slow / unavailable：outbound 文本、notice 缺失、请求结局与基准一致。

### 5.8 在线门禁（当前未完成）

真实上游 400→200 不属于 v1 完成判据；另设显式门禁。完成前只能声明"离线认证通过"，
不得声明"真实连续 502 已修复"。

### 5.9 仓库门禁

guarded npm test；文档修订与代码同批提交。

## 6. 预期文件变更

```
新增  src/provider-native-responses/tool-call-adjacency.ts
修改  src/provider-native-responses/{common,openai,codex,azure}.ts
新增  test/unit/provider-native-tool-call-adjacency.test.ts
修改  test/unit/provider-native-responses-contract.test.ts        （保留基线，新增用例）
修改  test/unit/responses-native-provider-sender.test.ts          （保留基线，新增用例）
修改  test/integration/request-journey-provider-native-openai.test.ts
新增  test/integration/provider-native-adjacency-stub-upstream.test.ts
修改  doc/TokenArchitecture.md
修改  doc/ProductLimitations.md
修改  doc/Protocols/OpenAI Responses Client Protocol.md
修改  doc/Protocols/OpenAI Responses-Pi AI IR Conversion Method.md
修改  doc/Spec/TokenRequestJourneyDiagnosticsSpec.md
修改  doc/Spec/TokenProviderCredentialProfilesPRD.md
修改  doc/Spec/TokenProviderCredentialProfilesImplementationPlan.md
```

## 7. 完成判据

- 无穿插时 outbound 与改前逐字节相同；
- 有穿插时只有 developer message 位移，call/result 配对、数量、各自相对顺序不变；
- 3.5 的编辑列表与全部采用条件通过（含反向键序、数组框架与边缘空白）；
- 5.4 的两层状态断言与 5.5 的隔离 CLI 多轮通过；
- 5.7 五态非干扰通过；
- 3.7 的三条 code、优先级与"每请求至多一条"一致；
- 4.4 的 28 条修订完成，且两处测试基线**未被削弱**；
- 未引入配置开关；
- 5.8 未完成前，任何文档/release 不得写"已修复"。

## 8. 已知边界

- 只覆盖 developer message 且必须位于结果之后、组闭合之前；其它角色与位置、`reasoning` 等
  组内穿插不修，仅按 3.7 观测；
- 结构扫描无法完成时无法断言形状，故不发 notice（观测缺口）；
- 不修复真悬空调用，也不覆盖 `agent_message` / `encrypted_content` 限制；
- 对原生 OpenAI / Azure Responses 目标同样生效（避免 Provider 特判）；
- 若 Codex 改为在工具组闭合后写入提示，本机制在实际流量中退化为空操作。

## 9. 移除条件

1. Codex 不再在并行工具组的结果之间写入 message 项；或
2. 上游接受穿插形态。

删除时同步撤销 4.4 的 28 条修订，恢复"仅 model 投影"表述。

## 10. 审阅问题答复状态

| # | 问题 | 状态 |
|---|---|---|
| 1 | native 还是请求级资格判定 | 所有者：必须 native（关闭） |
| 2 | 语义让步与 projector 论证 | 所有者判定合规；审阅要求 Native 自证安全，已落实为 3.1/3.5（关闭） |
| 3 | 未覆盖形状与误伤 | 第一轮 ①–⑤、第二轮 `String(call_id)`、第三轮键序/解码键名均已修复（待复审） |
| 4 | 字节保留 | 审阅：保留，理由是 wire 保真与既有断言（关闭） |
| 5 | span/排列/字节证明 | 已三次迭代；v5 用编辑列表 + 采用条件（待复审） |
| 6 | 502 映射 | 审阅：本次保留 502；错误呈现另立决定（关闭） |
| 7 | 认证强度 | 已按三轮意见收敛为 5.4/5.5/5.8（待复审） |

## 11. 已关闭的悬置问题

1. 整份放弃 vs 按组放弃：第二轮判定整份放弃为 v1 原则（已写入 2.4）。
2. 实施计划 396 行的替换句式：采用 2.8 的文本（已按第三轮意见补齐三处限定）。
3. §3.7 与 §3.8 的 notice 冲突：第三轮指出；v5 以第三条 code 与优先级/上限统一。

## 12. 唯一的未决项：PRD 层授权

契约清单现为 **28 条 / 9 个文件**，其中
`doc/Spec/TokenProviderCredentialProfilesPRD.md:818–819` 把"改变 `model` 投影以外的
decoded request-body semantic"列为**反目标**，PRD 结尾写明"任何对这些决定的更改需要新的
产品证据与显式 PRD 修订"。因此实施本提案需要所有者对 **PRD 修订**的显式授权：

- 授权 → 按 v5 实施，含 4.4 的 28 条修订；
- 不授权 → A 方案降级为 C（只记限制、不改行为），本文件改写为限制条目。
