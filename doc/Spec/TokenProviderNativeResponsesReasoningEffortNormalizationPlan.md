# Provider Native Responses 推理强度归一化修改计划

Status: **提案（草案）— 未实施，等待所有者批准**
Scope: Provider Native Preservation，且仅 `operation === "responses"`（不含 compact）请求方向
对顶层 `reasoning.effort` 的窄字段归一化。
Authority: 无。本文只定义提案与证据；第 7 节列出需要修订的既有契约断言，实施前需所有者授权。

> **B2′ 基线更新（2026-09-29）：** 本文写作时假定 Provider Native Responses 最终 outbound
> body 维持文本级逐字节保真；该假定已被 `TokenProviderNativeEnvelopeParityPlan.md` 的
> B2′ 决策取代。若未来实施本提案，文中所有“逐字节”不变量只能用于 reasoning-effort
> 投影器内部的局部编辑证明；最终 wire 必须按 pinned SDK parse/serialize 归一化后的 JSON
> 语义等价 + 无未请求字段注入认证，不能恢复旧的 raw JSON byte contract。

## 0. 结论摘要

能拿到模型推理信息，且不需要新增能力表。

1. Provider Native lane 的执行入口已经持有 **resolved Pi Model**：
   `handler.ts` 用 `providerNativeLane.claims(model, "responses")` 判定后把同一个
   `model` 传入 `providerNativeBranch`，最终进入
   `ProviderResponsesLaneInput.model`（`contract.ts:30-31`）。该对象携带
   `reasoning: boolean` 与可选 `thinkingLevelMap`。
2. 事实来源是既有权威：`Model.thinkingLevelMap` 是 level-data authority；Pi 公共
   `getSupportedThinkingLevels()` 提供“有哪些推理强度”及其顺序（运行时
   `@earendil-works/pi-ai@0.87.0`；公开导出见 `dist/index.d.ts:21` +
   `dist/models.d.ts:195-196`，实现见 `dist/models.js:554-565`，类型见
   `dist/types.d.ts:24-26,811-816`）。
   本项不使用 `clampThinkingLevel`（最近档位插值）。Provider Native 只读 Pi Model
   facts，不进入 Pi IR、不调用 Pi Provider 执行。
3. 实测覆盖（`node_modules/@earendil-works/pi-ai/dist/providers/data/*.json` 与
   Token 自有 `commandcode-models.json`）：native lane 认证的 provider 集合中，
   OpenAI Responses 家族的推理模型普遍带 `reasoning` 与 `thinkingLevelMap`。
   例如 `openai/gpt-5.2` = `{off:"none", minimal:null, low, medium, high, xhigh, max:null}`，
   `openai/o3` = `{off:null, minimal:null, low, medium, high, xhigh:null, max:null}`，
   `azure-openai-responses/gpt-5` = `{off:null}`，`github-copilot/gpt-5.3-codex` =
   `{off:null, minimal:"low", low:"low", medium, high, xhigh, max:null}`，
   `commandcode-goat/deepseek-v4.1-flash` = `{off:null, minimal:null, low:null, medium:null,
   high:"high", xhigh:null, max:"max"}`。
4. 两个必须写进契约的缺口：部分 map 不完整（`azure gpt-5` 只声明 `off`），部分 map 非
   恒等（`github-copilot` 把 Pi `minimal` 映到 wire `"low"`）。因此 wire 值的唯一映射
   规则采用 pinned adapter 自身约定 `map[level] ?? level`，而不是另立一张表。
5. 归一化必须保持本 lane 既有的字节保真纪律：只做 span 级编辑，任何资格/复解析/字节
   校验失败即整份放弃（fail-open），不改错误映射、不重试、不动 compact、不动响应方向。
6. 三种结果即完整契约：不能推理 / 没有 enabled 档位 / 要求关闭而模型不能关闭 → 删除
   `effort`；请求值已在模型 wire 集合内 → 原样，命中已声明 level 名 → 归一化为该 level
   的 provider 值；其余 → 写入该模型**最高可用推理强度**。不存在“不可解释值”第四类，
   也不使用 `clampThinkingLevel` 的最近档位逻辑。

## 1. 问题与目标

### 1.1 症状

Provider Native 把客户端 body 原样转发。客户端（agent）常常并不掌握目标模型的推理
档位事实，于是发出上游不接受的 `reasoning.effort`：

- 模型不支持推理（`reasoning === false`），却带了 `reasoning.effort`；
- 模型支持推理但没有任何可设置的档位（map 全 `null`），却带了 `effort`；
- 模型支持推理，但请求的档位不在支持集合内（如只支持 `high/max` 却请求 `medium`，
  或只支持到 `high` 却请求 `max`）。

当前行为是原样透传，由上游裁决：多数上游返回 400，Token 把该 400 原样交给客户端，
不重试（`shouldRetryOpenAIResponse` 只认 `x-should-retry`/408/409/429/≥500）。

### 1.2 目标（所有者给出的三条规则）

| # | 条件 | 目标行为 |
|---|---|---|
| 1 | `model.reasoning === false`，或支持推理但没有任何可设置的 enabled 档位，或客户端显式要求关闭而模型声明 `off: null`（无法关闭） | 删除请求里的推理强度字段 |
| 2 | 请求可被模型表达：请求值已是 provider 词表的值，或请求值是该模型已声明可用的 level 名 | 保真；若是 level 名形式，写出该 level 的 provider 值作为归一化（值相同则不改字节） |
| 3 | 其余（不在 provider 词表，也不是已声明可用的 level 名） | 直接取该模型**最高可用推理强度**写入 wire 的 `reasoning.effort`，并记 “requested X mapped to supported Y” 警告 |

规则 3 的“写入 `options.reasoning`”是 Semantic Conversion 的说法；native lane 没有 Pi
options，等价动作是重写 wire 上的 `reasoning.effort` 字符串值。

五条实现约束，不改变三分支结构：

- 判定与写出都在 **wire 值**上进行：启用档位的集合是
  `{ map[level] ?? level | level ∈ enabled }`（另加可关闭时的 `offWire`，见下），
  最高档是其中梯子位置最高的那一项。
  不再把请求值解释回 Pi level，也不再使用 `clampThinkingLevel` 的“最近档位”逻辑。
- 集合与梯子顺序仍必须来自既有事实权威（`thinkingLevelMap` + Pi 公共
  `getSupportedThinkingLevels`）。纯看 map 里“已声明”的字符串会漏掉缺项语义：
  `azure-openai-responses/gpt-5` 只声明 `{off:null}`，会得到空集合并被误判为“不能设置档位”。
- 规则 3 对任何无法表达的值一视同仁（`ultra`、未来新增名、Provider 私有名），
  不存在“保持原样”的第四分支。
- 关闭（`off`）与启用档位共用“查表 + 恒等回退”思路，但 fallback 不同：关闭的 wire 值是
  `map.off ?? "none"`（Pi adapter 在“未请求推理”分支就是写 `"none"`，
  `dist/api/openai-responses.js:259-261`、`azure-openai-responses.js:249-251`、
  `openai-codex-responses.js:427-428`），启用档位是 `map[level] ?? level`。
  `off` 是否可用只看 `map.off !== null`，与 `getSupportedThinkingLevels` 一致。
- 命名归一化（所有者 2026-09-29 追加同意）：请求值命中已声明 level 名时写
  `map[level]`，不做任何强度插值。判定顺序固定为**先 wire 值、后 level 名**，
  以消除“某个 wire 值恰好等于另一个 level 名”时的歧义；实测当前全部 provider 目录中
  此类冲突为 0，真正出现的非恒等映射只有 `minimal → "low"`
  （github-copilot 的 12 个 `openai-responses` 模型、`github-copilot`/`opencode`
  的 Claude 模型、`openai-codex` 的 `gpt-5.3-codex-spark`），以及 native lane 之外的
  groq `high → "default"`。

### 1.3 非目标

- 不改响应方向（SSE lifecycle normalization / function-call namespace insertion /
  alias projection 均不动）；
- 不改 compact（`operation === "compact"` 恒不归一化）；
- 不改 Direct Mode、Semantic Conversion、Anthropic Provider Native；
- 不新增 Provider 特判、不按 provider/model 名硬编码档位；
- 不改上游错误到客户端的映射，不引入重试或 fallback 到另一条 lane；
- 不新增第四分支：任何无法表达的值一律走规则 3，没有“保持原样”的旁路；
  判定与写出规则见 3.2。

## 2. 证据：模型推理事实的来源与覆盖

### 2.1 lane 已持有的事实

```text
handler.resolvePublicModel → resolution.model（resolved Pi Model）
  → providerNativeLane.claims(model, "responses")        （handler.ts:676）
  → providerNativeBranch(..., model, ...)                 （handler.ts:695）
  → ProviderResponsesLaneInput.model                      （contract.ts:30-31）
  → createProviderResponsesSenderForTransport({ model })  （index.ts:342-354）
  → sender.send(operation, rawBody, signal, observation)  （openai.ts / codex.ts / azure.ts）
```

`model` 在三个 sender 内已用于：顶层 `model` 投影、`model.headers`、
`copilotDynamicHeaders(parsed)`、session affinity headers、endpoint/transport 选择。
新增推理事实读取不需要新的依赖注入，也不需要跨 lane 共享对象。

对 Codex 客户端还有一个同源证据：Token 注入的 `token-model-catalog.json` 里
`supported_reasoning_levels` 同样由 `getSupportedThinkingLevels(model)` 生成，再映射到
Codex 词表（`minimal`/`low` → `low`；`src/integrations/codex/catalog.ts:81-97`，
无交集的别名会显式告警 `catalog.ts:239-242`）。也就是说“agent 看到的档位”与
“native lane 要用的档位集合”在正常路径上出自同一权威；用错档位主要发生在未注入目录的
第三方客户端、目录过期、或客户端私有词表（如 `ultra`）。

注意两种词表的归属：注入给客户端配置的只有 **Pi level 名**（Pi Agent 的
`thinkingLevelMap` 键，`src/integrations/pi/adapter.ts:27-33,127-143`）与 **Codex 词表**
（`low/medium/high/xhigh/max`）。provider 值（`thinkingLevelMap` 的 value）不出现在任何
注入配置里，只存在于 Token 内部持有的 resolved Pi Model，并由 Provider 侧 adapter
在真正发请求时使用——这正是本项要复用的那份事实。

### 2.2 事实的权威来源与 wire 映射约定

- 支持集合：`getSupportedThinkingLevels(model)`。语义（运行时 0.87.0 与参考树一致）：
  `reasoning === false` → `["off"]`；否则按 `off,minimal,low,medium,high,xhigh,max` 过滤，
  `mapped === null` 视为不支持，`xhigh`/`max` 还要求 map 显式声明（`!== undefined`）。
- 梯子顺序：`off < minimal < low < medium < high < xhigh < max`。
  “最高可用推理强度”即该顺序中位置最靠后的 enabled 档位。顺序本身只用于排序，
  不再用于“最近档位”插值（`clampThinkingLevel` 不参与本项）。
- wire 值：`map[level] ?? level`。该约定来自 pinned adapter 自身
  （`dist/api/openai-responses.js:251`、`dist/api/azure-openai-responses.js:241`、
  `dist/api/openai-codex-responses.js`；参考树 `pi-agent/.../openai-responses.ts:347`）。
  它保证 map 缺项时使用 Pi level 名，而不是凭空取值。
- 关闭值单独一条约定：`map.off ?? "none"`；`off` 可用性为 `map.off !== null`
  （缺项算可用）。这条同样来自 pinned adapter（`dist/api/openai-responses.js:259-261`）。

### 2.3 覆盖矩阵（实测 2026-09-29）

Provider Native 认证集合见 `src/provider-native-responses/index.ts:285-324`
（`openai`、`xai`、`opencode`、`opencode-go`、`cloudflare-ai-gateway`、
`github-copilot`、`commandcode-goat`、`openai-codex`、`azure-openai-responses`）。
抽样结果：

| 模型 | `reasoning` | `thinkingLevelMap` | 真实支持的强度集合（wire 值） | 最高档 |
|---|---|---|---|---|
| `openai/gpt-5.2` | true | `off:"none", minimal:null, low, medium, high, xhigh, max:null` | `{none, low, medium, high, xhigh}` | `xhigh` |
| `openai/o3` | true | `off:null, minimal:null, low, medium, high, xhigh:null, max:null` | `{low, medium, high}` | `high` |
| `openai/gpt-4o` | false | 缺省 | —（规则 1） | — |
| `azure-openai-responses/gpt-5` | true | `off:null`（其余缺项） | `{minimal, low, medium, high}`（恒等 fallback） | `high` |
| `github-copilot/gpt-5.3-codex` | true | `minimal:"low", low, medium, high, xhigh, max:null` | `{low, medium, high, xhigh}` | `xhigh` |
| `xai/grok-4.5` | true | `off:null, low, medium, high` | `{low, medium, high}` | `high` |
| `opencode-go/gpt-5.6-luna` | true | `off:null, minimal:null, low, medium, high, xhigh, max` | `{low, medium, high, xhigh, max}` | `max` |
| `commandcode-goat/deepseek-v4.1-flash` | true | `off/minimal/low/medium/xhigh:null, high, max` | `{high, max}` | `max` |
| `commandcode-goat/moonshotai/Kimi-K3` | true | 七档全 `null` | —（规则 1） | — |

Token 自有目录在加载时已强制三态校验：非 reasoning 模型不得声明 map，reasoning 模型必须
声明完整 map（`packages/commandcode-model-catalog/src/models.ts:111-136`）。

### 2.4 两个缺口（必须写进契约）

**缺口 A：map 不完整。** `azure-openai-responses/gpt-5` 只声明 `{off:null}`，其余键缺项。
若只用“声明的映射值”构造词表会得到空集，从而把合法请求误判为“不可设置档位”。
本计划用 2.2 的 `map[level] ?? level` 约定消解：缺项即恒等映射。

**缺口 B：map 非恒等。** `github-copilot/gpt-5.3-codex` 声明 `minimal:"low"`。说明 wire
词表与 Pi level 名不是同一词表，任何“把客户端字符串直接当 wire 值”的假设都不成立。
因此判定必须落在 **wire 值**上（集合由 `map[level] ?? level` 生成）；请求值命中已声明
level 名时只做查表归一化，不解释强度、不做最近档位插值。

**缺口 C（用户层覆盖）。** `models.json` 的 `modelOverrides` 可覆盖 `reasoning` 与
`thinkingLevelMap`（`src/providers/effective-composition.ts:142-186`，schema 见
`src/providers/models-json-schema.ts:177-178,190-191`）。若用户覆盖只写了
`thinkingLevelMap` 而未写 `reasoning`，合并结果仍沿用基模的 `reasoning`；若用户新增
模型且未声明 `reasoning`，则 `reasoning` 默认 `false`（`effective-composition.ts:250`），
落入规则 1。所有者 2026-09-29 决定：这就是定义行为，不做特殊处理（见第 9 节风险 3）。

## 3. 冻结契约（提案）

### 3.1 适用范围

```text
Provider Native Preservation
且 operation === "responses"
且仅顶层 JSON 对象的 reasoning 属性
且仅其 effort 属性
```

compact、缺省 `reasoning`、`effort` 为 `null` 或缺失、`reasoning` 不是对象、以及任何
资格校验失败：输出与今天的 `projectProviderNativeBody` 结果逐字节相同。

### 3.2 判定算法（纯函数，输入只有 model facts 与请求里的 effort 字符串）

```text
supported = getSupportedThinkingLevels(model)        // 含 "off"（若被声明）
enabled   = supported.filter(level => level !== "off")
wire(l)   = thinkingLevelMap?.[l] ?? l               // 仅对 enabled 档位定义
offWire   = thinkingLevelMap?.off ?? "none"          // Pi 的关闭值约定
offUsable = thinkingLevelMap?.off !== null           // 缺项与字符串都算可用
accepted  = { wire(l) | l ∈ enabled } ∪ (offUsable ? { offWire } : {})
highest   = wire(enabled[enabled.length - 1])        // 梯子顺序中最后的 enabled 档

1. 删除（两类触发，结果都是 remove）：
   a) !model.reasoning 或 enabled.length === 0
   b) effort ∈ {"none", "off"} 且 !offUsable          // 客户端要求关闭，模型不能关闭
2. 否则若 effort ∈ accepted：
     kind = "keep"                                   // 原样
2b. 否则若 effort ∈ supported（请求值是已声明可用的 level 名）：
     wireValue = effort === "off" ? offWire : wire(effort)
     kind      = "replace"                           // 命名归一化，不做强度插值
3. 否则：
     wireValue = highest                             // 不在集合内 → 取最高档
     kind      = "replace"
```

六点说明：

- **三种结果覆盖全部字符串输入**（remove / keep / replace），不存在第四类旁路；
  删除有两种触发条件（1a 能力缺失、1b 无法关闭）。
- 判定与写出都在 wire 值上：不做“最近档位”插值，也不使用 `clampThinkingLevel`。
  这是所有者 2026-09-29 的裁定，替换了草案里的 coordinate + `clampThinkingLevel` 方案。
- 2b 是所有者 2026-09-29 追加同意的命名归一化：请求值本身是已声明 level 名时写
  `map[level]`（`off` 写 `offWire`）。它只查表，不判断强弱；命中时 `kind = replace`，
  但值相同则字节不变。
- **判定顺序固定为先 2 后 2b**，因为某个 wire 值可能恰好等于另一个 level 名。实测当前
  目录无此冲突，但顺序必须写死以保证确定性。
- `accepted` 含关闭值 `offWire`：模型能关闭时，客户端的 `none` 原样保留；模型声明了
  别名关闭值（`map.off` ≠ `"none"`）时，`none` 会归一化成该别名。`highest` 只从 enabled
  档位中取，绝不会写成关闭值。
- 1b 是所有者 2026-09-29 的追加裁定：不能关闭时删除 `effort`，而不是升到最高档——
  “关闭”是能力缺失，不是“更强”。
- 已知后果：其余集合外值（`ultra`、未来新增名、Provider 私有名）一律升到最高可用档。
  行为确定、可测，不做二次猜测。

### 3.3 决策表（用 2.3 的真实模型举例）

| model facts | 请求 `effort` | 结果 | 写出值 |
|---|---|---|---|
| `gpt-5.2` | `medium` | keep | `medium` |
| `gpt-5.2` | `none` | keep（`off` 的 wire 值） | `none` |
| `gpt-5.2` | `max`（map 标 `null`） | replace → 最高档 `xhigh` | `xhigh` |
| `gpt-5.2` | `minimal`（map 标 `null`） | replace → 最高档 `xhigh` | `xhigh` |
| `o3` | `xhigh`（map 标 `null`） | replace → 最高档 `high` | `high` |
| `o3` | `minimal`（map 标 `null`） | replace → 最高档 `high` | `high` |
| `azure gpt-5` | `medium` | keep（恒等 fallback） | `medium` |
| `azure gpt-5` | `xhigh` | replace → 最高档 `high` | `high` |
| `github-copilot gpt-5.3-codex` | `low` | keep | `low` |
| `github-copilot gpt-5.3-codex` | `minimal`（已声明 level，wire 值是 `low`） | replace → 归一化 | `low` |
| `openai-codex gpt-5.3-codex-spark` | `minimal`（已声明 level，wire 值是 `low`） | replace → 归一化 | `low` |
| `deepseek-v4.1-flash` | `medium` / `low` | replace → 最高档 `max` | `max` |
| `deepseek-v4.1-flash` | `xhigh`（map 标 `null`） | replace → 最高档 `max` | `max` |
| `Kimi-K3` / `gpt-4o` | 任意字符串 | 分支 1：remove | —（删除） |
| `gpt-5.2` | `off` / `ultra` / `adaptive` / 其它集合外值 | replace → 最高档 `xhigh` | `xhigh` |
| `o3` | `none`（`map.off === null`，模型不能关闭） | 分支 1b：remove（所有者 2026-09-29 裁定） | —（删除） |
| 任一 `map.off = "off"` 的模型（如 baseten 的 `moonshotai/Kimi-K2.7-Code`） | `none` | replace → 归一化为声明的关闭别名 | `off` |

### 3.4 边界情形

| 情形 | 行为 |
|---|---|
| `reasoning` 缺失 | 无操作（不新增、不删除） |
| `reasoning: null` 或非对象 | 无操作（fail-open；native lane 不做 schema 校验） |
| `effort` 缺失或 `null` | 无操作 |
| `effort` 非字符串（数字/对象/布尔） | 无操作（不猜测作者意图） |
| 顶层 `reasoning` 键重复 | 无操作（无唯一读法） |
| `reasoning` 内 `effort` 键重复 | 无操作 |
| `reasoning` 内其它键重复 | 不参与判定；仅在删除时决定是否连同空容器删除 |
| `effort` 只出现在 `input` 项或嵌套对象内 | 不属于本契约范围，字节不变 |
| 非法 JSON / 顶层不是对象 | 沿用既有失败路径，不进入本模块 |

第 9 行对应开放决策 1：若 `effort` 是 `reasoning` 对象中**唯一**的属性（按解码后键名
计数），建议连同该空容器一起删除；只要还有其它属性，只删除 `effort` 本身。

3.4 的九行全部是**结构性**不可判定（无法证明作者写了什么），不属于 3.2 的语义分支：
它们按 4.1/4.3 直接放弃，字节不变。

### 3.5 为什么这不是被禁止的 projector / repair 层

- 无 Provider-payload projector、无 target projector registry、无
  source-protocol × target-API 矩阵、无 supplement/candidate carrier；
- 不进入 Pi AI IR，不构造 Provider 请求，不创建 `onPayload`，不调用 Pi Provider 执行；
- 只读 lane 已经持有的 resolved Pi Model 事实，规则本身来自既有冻结决定
  （`doc/Spec/TokenReasoningEffortUnificationPlan.md` 保留项 1–3：
  `thinkingLevelMap` 是数据权威、Pi 公共 helper 是选择机制权威、可用性优先）；
- 与语义 lane 的对应实现完全独立，不 import 语义模块
  （对照物：`src/protocols/openai-responses/semantic/reasoning/levels.ts:20-45`、
  `semantic/reasoning/request.ts:220-270`）——两条 lane 各自消费同一 Pi 公共事实；
- 编辑是 span 级、可反向验证、失败即整份放弃，不改变任何未被点名的字节。

## 4. 字节保真算法

### 4.1 资格预检（任一失败 → 本项不生效，其余投影照常）

1. `operation === "responses"`。
2. 原文是单个顶层 JSON 对象；**按解码后键名**，顶层 `reasoning` 键唯一。
3. `reasoning` 的值是对象字面量（span 可以取出）。
4. `reasoning` 内 `effort` 键唯一；其值若是字符串则能取出值 span。
5. `model` 投影与邻接归一化的编辑区间与本项编辑区间互不重叠。
6. 编辑后文本可完整复解析，且满足 4.3 的全部采用条件。

### 4.2 编辑列表（与键序、空白、数字写法无关）

**区间定义**：`E` 为 `effort` 属性的完整区间 `[effortStart, effortEnd)`；`P` 为
`reasoning` 对象内**前一个**属性的值区间末位（若存在）；`N` 为**下一个**属性起始位
（若存在）；`V` 为 `effort` 字符串值的区间。

```text
remove   : 若存在前一个属性 → 删除 [P.end, E.end)
           否则若存在下一个属性 → 删除 [E.start, N.start)
           否则（effort 是唯一属性）→ 删除整个 reasoning 属性区间（开放决策 1）
replace  : V -> JSON.stringify(wireValue)
```

不变区间（必须逐字节保持）：顶层其它属性、`reasoning` 内其它属性、`{`/`}`、逗号、
空白、以及所有未点名字节。两处（或多处）编辑按偏移从右向左施加。

### 4.3 采用条件

1. 顶层与 `reasoning` 子树中，被编辑键按解码后键名唯一；
2. `remove` 后复解析结果 = 原解析结果去掉该属性（深相等），`replace` 后 =
   原解析结果且该值为目标 wire 值；
3. 输出 `parsed`（供 sender 使用，如 `copilotDynamicHeaders(parsed)`）与输出文本一致；
4. 除被编辑区间外，输出与输入逐字节相同；覆盖 `9007199254740993`、`-0`、`1e+30`、
   转义键名（如 `"\u0065ffort"`）、自定义空白、反向键序、CRLF；
5. 顶层键集合不变；`input` 顺序不变（与邻接归一化协同）。

任一失败：返回只含既有 `model` 投影（以及可能已采用的邻接归一化）的文本，并按第 6 节
记录 notice；绝不因为本项把一个可发送的请求变成失败。

## 5. 模块与接入位置

### 5.1 新增纯函数模块

`src/provider-native-responses/reasoning-effort.ts`

```ts
export type NativeReasoningEffortPlan =
  | { readonly kind: "keep" }
  | { readonly kind: "remove" }
  | { readonly kind: "replace"; readonly requested: string;
      readonly reason: "renamed" | "highest";  // 决定发哪条 notice
      readonly selected: string;   // 所选 level 名（renamed=命中项；highest=最高档）
      readonly wireValue: string } // 实际写入 reasoning.effort 的字符串
  | { readonly kind: "absent" };

export function resolveNativeReasoningEffortPlan(
  model: Pick<Model<string>, "reasoning" | "thinkingLevelMap">,
  effort: string | undefined,
): NativeReasoningEffortPlan;

export function applyNativeReasoningEffortEdit(
  rawBody: string,
  parsed: Record<string, unknown>,
  plan: NativeReasoningEffortPlan,
): { readonly parsed: Record<string, unknown>;
     readonly text: string;
     readonly applied: boolean };
```

选择逻辑（读 Pi 事实）与字节编辑（写原文字节）分离：前者可单测、不接触文本；后者不读
Pi 事实、只执行 4.2 的编辑列表。

### 5.2 接入现有投影入口

`projectProviderNativeBody`（`src/provider-native-responses/tool-call-adjacency.ts:478`）
扩展为同时接受 model 事实（或已解析的 plan）与 operation：

```ts
projectProviderNativeBody(rawBody, modelId, operation, effortPlan?)
  → { parsed, text, outcome, deferredMessages, reasoningOutcome }
```

- 未命中本项时行为必须与今天逐字节相同（既有断言不得削弱）；
- `src/provider-native-responses/common.ts:113` 的
  `topLevelModelStringSpans` 泛化为“顶层属性 span 扫描 + 值区间”，供 `model` 投影与
  `reasoning` 定位共用；`rewriteModelJson`（`common.ts:145`）保持现有行为；
- 三个 sender 同步接入：`openai.ts:126`、`codex.ts:108`、`azure.ts:118`；
- compact 恒传 `operation !== "responses"`，本项直接跳过。

### 5.3 保持的边界

- 不新增 Provider 特判；三个 transport 走同一入口；
- 不 import 语义 lane 模块；只 import Pi 公共 helper 与类型；
- 不读取 Client 私有状态、不写 diagnostics 以外的任何外部状态。

## 6. 观测

### 6.1 新增 notice code（沿用 `conversion_notice_observed`）

| code | severity | 触发 | 消息约束 |
|---|---|---|---|
| `provider_native_reasoning_effort_renamed` | info | 规则 2b：请求值命中已声明 level 名，写成了该 level 的 provider 值 | 两个值都来自模型目录（level 名 + `map[level]`），可安全回显 |
| `provider_native_reasoning_effort_removed` | warning | 规则 1 删除了 `effort`（1a 能力缺失，或 1b 客户端要求关闭而模型不能关闭） | 不含客户端文本 |
| `provider_native_reasoning_effort_mapped_to_highest` | warning | 规则 3 把无法表达的请求值重写为最高档 | `selected` 来自模型目录；`requested` 仅当它是 7 个 Pi level 名之一时才回显，否则写成 “an undeclared level”，**不得回显任意客户端字符串** |

规则 2 的 keep 分支、2b 中“值相同”的情形、以及结构未命中（缺省/非字符串/重复键/
校验失败）不发 notice。

### 6.2 与既有邻接 notice 的共存

`observation.ts:52` 现约定“每请求至多一条 notice”；本计划把它细化为
**每 subject 至多一条**：邻接项与推理项各自独立，同一请求最多两条（各一条）。
`observeProviderResponsesBodyProjection` 需要一个纯增量参数，不改既有三条 code 的
语义与优先级。

### 6.3 诊断非干扰

按 `doc/Spec/TokenRequestJourneyDiagnosticsSpec.md` 的五态要求：disabled / throwing /
saturated / slow / unavailable 下，出站文本与请求结局必须与本项关闭时逐字节一致；
notice 缺失不得改变任何行为。

## 7. 需要同步修订的契约断言

实施本提案意味着 Provider Native 请求方向从“`model` 投影 + 邻接归一化”变为三条封闭
例外。以下是逐条清单（行号为 2026-09-29 现状）：

| # | 文件 | 位置 | 现状要点 | 处理 |
|---:|---|---|---|---|
| 1 | `doc/TokenArchitecture.md` | 219 | native lane 只允许 preservation 必要变化 + 邻接归一化 | 增加本项为第二项窄请求侧归一化 |
| 2 | `doc/ProductLimitations.md` | 64–71 | “changes only boundary-required facts …” + 邻接例外 | 增加本项例外 |
| 3 | `doc/Protocols/OpenAI Responses Client Protocol.md` | 33、39 | “Raw Responses wire remains authoritative except …” | 增加本项 |
| 4 | `doc/Protocols/OpenAI Responses-Pi AI IR Conversion Method.md` | 608 | 只列 model 投影 + 邻接 | 增加本项 |
| 5 | `doc/Protocols/Protocol Conversion Architecture and Policy.md` | 47 | 仅列 boundary-required 变化 | 增加本项 |
| 6 | `doc/Spec/TokenRequestJourneyDiagnosticsSpec.md` | 142（及 notice 汇总处 350、679） | `project_native_body` 输出描述 | 增加本项与三条新 code |
| 7 | `doc/Spec/TokenProviderCredentialProfilesPRD.md` | 29、485、725、778、818、888、943 | “exactly two declared exceptions”类表述 | 改为三条封闭例外 |
| 8 | `doc/Spec/TokenProviderCredentialProfilesImplementationPlan.md` | 27、75、396、433、454、829、961 | 同上 | 改为三条封闭例外 |
| 9 | `AGENTS.md`（项目指令） | Independent lanes / Provider Native | 已允许“may use resolved Pi Model/auth facts”，请求侧例外仅提到响应三项重写 | 实施时核对是否需要登记本项；若需要则同批修订 |
| 10 | 两个基线测试文件 | `test/unit/provider-native-responses-contract.test.ts`、`test/unit/responses-native-provider-sender.test.ts` | “只改 model / 原文不变”断言 | **保留原断言**，新增命中用例（不得削弱基线） |

## 8. 测试与认证

### 8.1 纯函数结构夹具（合成，不提交真实捕获 body）

`test/unit/provider-native-reasoning-effort.test.ts`：

- 2.3 的真实目录事实（`gpt-5.2`、`o3`、`azure gpt-5`、`github-copilot gpt-5.3-codex`、
  `deepseek-v4.1-flash`、`Kimi-K3`、`gpt-4o`）逐条覆盖 3.3 决策表；
- `keep` / `remove` / `replace` / `absent` 四类计划各至少两例；另加：`none` 的三种
  `off` 形态（字符串 / 缺项 / `null`）、`off` 作为 level 名的归一化、已声明 level 名
  的命名归一化（`minimal → "low"`）、以及未知值落到“最高可用档”的用例；
- 判定顺序用例：构造“wire 值恰好等于另一个 level 名”的合成 map，固定“先 wire 值、
  后 level 名”的确定性；
- `effort` 排在 `reasoning` 对象首位 / 中间 / 末位；`effort` 是唯一属性；
- `reasoning` 在顶层首位 / 中间 / 末位；反向键序；
- 重复键（顶层 `reasoning`、内部 `effort`）、转义键名、非对象 `reasoning`、
  非字符串 `effort`、`effort: null`。

### 8.2 字节认证

- 未命中：输出与改前逐字节相同（含 `9007199254740993`、`-0`、`1e+30`、嵌套 `model`、
  自定义空白、CRLF）；
- 命中 `remove`：除被删属性外逐字节相同；输出可复解析且深相等；
- 命中 `replace`：仅值区间变化；`parsed` 与文本一致；
- 与邻接归一化同一 body 叠加：两处编辑互不重叠、同时生效、其余字节不变。

### 8.3 生产接缝 e2e（stub upstream）

新增 `test/integration/provider-native-reasoning-effort-stub-upstream.test.ts`：
本地 stub 按“wire 词表”判定，收到词表外的 `effort` 返回 400（复刻真实上游行为）。

| 场景 | stub 观察 | Token 返回客户端 |
|---|---|---|
| 同一 body 未归一化（对照组） | 400 | 502（既有映射） |
| 同一 body 经 Token（命名归一化命中，`minimal → "low"`） | 200，且 stub 记录的 `effort` = 声明的 provider 值 | 200 |
| 同一 body 经 Token（映射到最高档命中） | 200，且 stub 记录的 `effort` = 期望 wire 值 | 200 |
| 同一 body 经 Token（remove 命中） | 200，且请求中无 `reasoning.effort` | 200 |
| 结构不可判定（`effort` 为数字、重复键） | 与对照组逐字节相同 | 502（不掩盖） |

另断言：notice code/severity 正确；`provider_native_outbound_request_wire` 与期望一致。

### 8.4 负回归

Direct、Semantic、Anthropic Native、`operation === "compact"`、
三个 transport 的无 `reasoning` 请求：body 与结局与改前完全一致。

### 8.5 隔离 CLI（可选，第二期）

新建临时 `CODEX_HOME`（只复制 `config.toml`、`token-model-catalog.json`，`finally`
清理），真实 Codex CLI → 本地 Token → stub upstream：构造一次模型不支持档位的请求，
验证不再出现连续 400/502，且客户端线 history 与 Provider 线 body 的差异仅为本项。

### 8.6 在线门禁（可选，第二期）

`test/online/run-provider-native-reasoning-effort-online-gate.ts`：合成最小 body，
对真实上游发送一个声明外的 `effort`，证明 400 → 200；不得据此宣称“所有 agent 的
错误档位问题已消除”。

### 8.7 仓库门禁

`npm run typecheck`、`npm run lint`、guarded `npm test`；文档修订与代码同批提交。

## 9. 风险与已知边界

1. **目录即裁决。** 集合与最高档完全取决于 `thinkingLevelMap`。目录写错时仍可能被上游
   拒绝；Token 不追加第二次修正，也不重试。
2. **可能改写合法请求。** 若上游实际接受某档位而目录未声明（例如 `o3` 目录把 `xhigh`
   标为 `null`），本项会把请求改成该模型的最高档（`xhigh → high`）。这是“可用性优先”
   的既有取舍（`TokenReasoningEffortUnificationPlan` 保留项 3），但属于行为变化，
   需所有者确认。
3. **用户层模型未声明 `reasoning` 即视为没有推理能力。** 合成规则是
   `definition.reasoning ?? false`（`src/providers/effective-composition.ts:250`），
   Pi helper 随即返回 `["off"]`，于是规则 1 删除 `effort`。所有者 2026-09-29 决定：
   这是定义行为，不做特殊处理，也不新增启动警告。同一条覆盖“只声明
   `thinkingLevelMap` 而未声明 `reasoning`”的配置——helper 在 `!reasoning` 时短路。
4. **无法表达的值一律升到最高档。** 既不在 provider 词表、也不是已声明 level 名的值
   （`ultra`、未来新增名、Provider 私有名）都会写成该模型的最高可用推理强度；好处是
   绝不因请求偏差而降智，代价是客户端无法用外来值表达“更弱”。显式关闭（`none`）已单独
   处理为 1b，level 名形式已由 2b 归一化，二者都不再走这条。
5. **只处理顶层字段。** 嵌套或 `input` 项内的同名字段不动；这是与邻接契约一致的范围
   纪律：只处理“协议级位置”的字段。
6. **compact 不支持。** compact 路径不归一化；若上游对 compact 的 `effort` 报错，
   本计划不解决。
7. **notice 不再是每请求一条。** 观测契约从“每请求至多一条”扩为“每 subject 至多一条”，
   需要同步修订诊断规格，避免与既有断言冲突。

## 10. 开放决策（需所有者拍板）

| # | 议题 | 选项 | 建议 |
|---:|---|---|---|
| 1 | 规则 1 的删除粒度 | (a) 只删 `effort`（可能留下 `{}`）；(b) `effort` 为唯一属性时连同空容器一起删除 | **(b)**：避免向上游发送空 `reasoning` 对象；仍有其它属性时只删 `effort` |
| 2 | 是否引入开关 | (a) 不加开关（与邻接归一化一致）；(b) 加 `protocols.openai-responses.providerNative.reasoningEffort.enabled`（默认开，hot-apply） | **(b) 倾向**：本项会改写客户端请求语义，保留快速撤回手段；但需与“不引入配置开关”的既有偏好对齐后决定 |

## 11. 预期文件变更

```
新增  src/provider-native-responses/reasoning-effort.ts
修改  src/provider-native-responses/{common,tool-call-adjacency,observation,openai,codex,azure}.ts
新增  test/unit/provider-native-reasoning-effort.test.ts
修改  test/unit/provider-native-responses-contract.test.ts          （保留基线，新增用例）
修改  test/unit/responses-native-provider-sender.test.ts            （保留基线，新增用例）
修改  test/unit/provider-native-tool-call-adjacency.test.ts         （叠加编辑用例）
新增  test/integration/provider-native-reasoning-effort-stub-upstream.test.ts
修改  test/integration/request-journey-provider-native-openai.test.ts（notice 断言）
修改  doc/TokenArchitecture.md
修改  doc/ProductLimitations.md
修改  doc/Protocols/OpenAI Responses Client Protocol.md
修改  doc/Protocols/OpenAI Responses-Pi AI IR Conversion Method.md
修改  doc/Protocols/Protocol Conversion Architecture and Policy.md
修改  doc/Spec/TokenRequestJourneyDiagnosticsSpec.md
修改  doc/Spec/TokenProviderCredentialProfilesPRD.md
修改  doc/Spec/TokenProviderCredentialProfilesImplementationPlan.md
（按第 7 节第 9 行核对 AGENTS.md 是否需要同批登记）
```

## 12. 完成判据

- 3.3 决策表的每一行都有单测固定（含 1a / 1b / 2 / 2b / 3 各分支）；
- 规则 1b 单独固定：`map.off === null` 且请求 `none` → 删除；`map.off` 为字符串且
  ≠ `"none"` → 归一化为该字符串；`map.off` 缺项 → `none` 视为可用并原样保留；
- 规则 2b 单独固定：`github-copilot` / `openai-codex` 的 `minimal → "low"` 归一化，
  以及“先 wire 值、后 level 名”的判定顺序；
- 未命中、结构校验失败两种情况下 outbound body 与改前逐字节相同；
- 命中时的差异只可能落在 `reasoning.effort` 值区间或（开放决策 1 选 b 时）
  `reasoning` 空容器区间；
- 8.3 的 stub e2e 在“同一 body”上证明 400 → 200，且对照组行为不变；
- 8.4 的负回归证明 Direct / Semantic / compact / Anthropic Native 字节与结局不变；
- 6.3 的诊断五态非干扰通过；
- 第 7 节的契约修订与代码同批提交，两个基线测试的既有断言未被削弱；
- 未引入 Provider/model 特判，未引入第二张能力表，未 import 语义 lane 模块。

## 13. 配套改动（待确认）：Codex 目录注入的退化用例

所有者 2026-09-29 提出：对“没有推理能力”或“有推理但不能设置强度”的模型，Codex 目录
不再暴露 0 个档位，而是注入一个 `max` 档并作为默认。

**注入位置**（已核实）：

- `src/integrations/codex/catalog.ts:81-97` `supportedReasoningLevels()`：
  `!model.reasoning` 直接返回 `[]`；reasoning 模型逐档映射到 Codex 词表
  （`minimal`/`low` → `low`）并要求 native 目录里存在同名 description，缺 description
  的档位被丢弃。
- `src/integrations/codex/catalog.ts:238-254`：算出 `reasoningLevels` 与
  `default_reasoning_level`（取列表最后一项，即最高档），再交给 `codexEntry()`
  （`catalog.ts:129-172`）落成 `supported_reasoning_levels`。
- 产物写到 `CODEX_HOME/token-model-catalog.json`（`integration.ts:583`，由
  `application.ts:834-843` 组装），并由 `catalog-validator.ts` 用临时 `CODEX_HOME`
  跑真实 Codex CLI（`debug models` + `debug prompt-input`）验收。

**改动形态**（小、集中）：在 `supportedReasoningLevels()` 里加一条能力判定——
`!model.reasoning || enabledLevels.length === 0` 时返回
`[{ effort: "max", description: <fallback> }]`；`default_reasoning_level` 会自动成为
`"max"`（现有取最后一项的逻辑不变）。需要新增一个 fallback description 常量，因为
当前实现只接受 native 目录里已有的 description。

**三个必须一起定的事**：

1. **依赖本项先落地**：注入 `max` 之后 Codex 会对这些模型发出 `reasoning.effort`。
   native lane 今天原样转发 → 上游 400（正是本项要修的问题）。所以该注入必须与本项
   （规则 1 删除、规则 3 取最高档）同批发布；语义 lane 已经会安全降级（non-reasoning →
   丢弃并告警），不受影响。
2. **判定按能力、不按过滤结果**：注入条件应基于 `model.reasoning` 与
   `getSupportedThinkingLevels()`（去掉 `off`），而不是“过滤后为空”。否则
   “有真实档位但 native 目录缺 description”的第三种情形也会被塞进 `max`，掩盖
   现有 `do not overlap` 告警。
3. **description 文本**：需要一个固定文案（例如 “Maximum reasoning effort.”），
   并确认 Codex 接受它与 `default_reasoning_level: "max"` 的组合。

**测试影响**：`test/unit/codex-catalog.test.ts:328`（非 reasoning 模型当前断言 `[]`）与
`:350`（vocabulary 不重叠当前断言 `[]`）需按新契约调整，并补一条“注入 max 且
`default_reasoning_level = "max"`”的用例；`catalog-validator` 不需要改，但它在 CI/本机
会用真实 Codex CLI 校验目录可被接受，是这条改动的实际门禁。

**待确认**：Pi Agent 注入（`src/integrations/pi/adapter.ts` 的 `thinkingLevelMap`）是否
也要同样处理；它走的是 Anthropic endpoint 与 Pi level 词表，与 Codex 这条独立。
