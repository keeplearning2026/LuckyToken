# LuckyToken 的 OpenAI Responses 转换 vs Pi AI 官方实现——完备性对照报告

> **历史对比，非当前规范。** 独立复核已证伪本文若干核心结论，尤其是“27 个样本每个字段都正确处理”、`top_p` 无 Pi 对应、system/developer 已进入 systemPrompt、encrypted reasoning/refusal 无 Pi 对应、namespace 完整、`text.format` 可直接映顶层 constrainedSampling、SSE 完整一致。本文关于 `HttpObserver` 和 HTTP/stream failure 丢失的描述也只代表 Ticket 27 前基线；当前 conversion 只消费 trusted neutral Pi diagnostics。当前权威结论见 [`ProtocolConversion-Completeness-Audit.md`](./ProtocolConversion-Completeness-Audit.md)、[`Protocol Conversion Architecture and Policy.md`](./Protocols/Protocol%20Conversion%20Architecture%20and%20Policy.md) 和 [`OpenAI Responses-Pi AI IR Conversion Method.md`](./Protocols/OpenAI%20Responses-Pi%20AI%20IR%20Conversion%20Method.md)。本文只保留为审计过程材料，不得作为实现合同。

**日期：** 2026-08-12
**性质：** 只读审计，未修改任何代码。

## 0. 这份报告是干什么的（先读这一段）

LuckyToken 是一台「翻译机」：真实 Codex 客户端（CLI 和桌面应用）用
**OpenAI Responses 协议**说话，LuckyToken 把它翻译成 **Pi AI IR**（一种
中间语言），交给后端模型（CommandCode），再把模型的回答翻译回
Responses 协议。

同一个 Pi AI IR，Pi AI 官方包自己也在用（它把 Pi IR 翻译成 Responses
发给 OpenAI 服务端，再翻译回来）。两边用的是**同一套中间语言、同一个
协议**，只是方向相反。所以把两个实现逐字段对照，就能发现我们的翻译机
有没有漏翻、错翻。

这份报告回答三个问题：

1. 我们漏了哪些真实客户端会用到的字段？（P1）
2. 哪些是暂时用不到、但未来会踩的坑？（P2）
3. 哪些差异其实是**我们故意做对的**，不是 bug？

本文原结论曾声称：**27 个真实 Codex 请求样本里出现的每个字段，我们都正确
处理了，没有 P0 问题。该结论已被独立复核撤销。** 报告正文按「先解释概念 → 再对照 → 再讲影响」
的顺序写，尽量让不熟悉这两个协议的人也能看懂。

一个重要视角贯穿全文：**转换层（Responses↔Pi IR）的每个决定，都要同时
看它对另一侧 CommandCode 的影响**。转换层不替 CommandCode 做决定，但
必须知道自己的转换结果会怎样落到 CommandCode——否则会出现「转换层
完整、落地层悄悄炸」的隐性故障（最典型的是 4.2.8 的 `strict:true`）。
每个对照表都带「CommandCode 落地影响」列，每个问题都带同名的说明段。

---

## 1. 背景知识（30 秒速成）

### 1.1 什么是 OpenAI Responses 协议

OpenAI 给客户端（Codex）用的一套 HTTP 接口。请求里主要有：

- `model`：用哪个模型；
- `input`：对话内容，是一串「条目」（item），比如用户消息、模型思考、
  工具调用、工具结果；
- `tools`：给模型用的工具定义；
- `instructions`：系统提示词；
- 一堆选项：`max_output_tokens`（最多输出多少 token）、`temperature`
  （随机性）、`reasoning`（思考强度）、`text`（输出格式）等。

响应里主要有：

- `output`：一串输出条目（模型消息、思考、工具调用）；
- `status`：completed / incomplete / failed；
- `usage`：用了多少 token（输入、输出、缓存命中、思考 token）。

### 1.2 什么是 Pi AI IR

Pi AI 包定义的一组 TypeScript 类型，是**和具体厂商无关的中间语言**：

- `Context`：一次请求的完整上下文（系统提示 + 消息列表 + 工具列表）；
- `Message`：一条消息，分三种：用户消息、助手消息、工具结果；
- `AssistantMessage`：助手消息，里面是一串内容块：`text`（文字）、
  `thinking`（思考）、`toolCall`（工具调用）；
- `Tool`：工具定义（名字、描述、参数 schema）；
- `Usage`：token 用量（输入、输出、缓存读、缓存写、思考、总计）。

> 简单类比：Responses 协议是「英语」，Pi IR 是「中间语言」，
> CommandCode 的协议是「德语」。LuckyToken 负责英语→中间语言→德语，
> Pi 官方包负责中间语言→英语。两边对照，就是检查翻译是否忠实。

### 1.3 两个实现的方向

```text
Pi 官方包（客户端视角）：  Pi IR  ──翻译──▶  Responses 请求  ──发送──▶  OpenAI 服务端
                           Pi IR  ◀─翻译──  Responses 响应流 ◀─接收──  OpenAI 服务端

LuckyToken（服务端视角）：  Responses 请求 ◀─接收──  Codex 客户端
                           Pi IR  ◀─翻译──  Responses 请求
                           CommandCode 请求 ──翻译──▶  Pi IR
                           CommandCode 响应 ◀─接收──  Pi IR
                           Responses 响应  ──翻译──▶  Pi IR
```

两个方向用同一套 Pi IR 类型，所以可以逐字段对照。

---

### 1.4 转换原则与两个层（本报告最重要的认知）

**转换原则（fail-open，保证转换永远可用）：**

> 转换 A → B 时：A 的字段在 B 里有对应 → **必须转**；没有对应 →
> **丢弃，不报错**。唯一例外：该字段对 B 是**不可缺少的**（缺了 B 就
> 无法工作）→ 才报错。

这条原则同时适用于两层：**Responses → Pi IR** 和 **Pi IR → CommandCode**。

- 「有对应」的判断标准：B 的类型/字段/语义能表达 A 的意图。
  - Responses 的 `max_output_tokens` → Pi IR 的 `maxTokens` → CommandCode
    的 `max_tokens`：有对应，必须转。
  - Responses 的 `text.format` → Pi IR 没有结构化输出字段 → CommandCode
    也没有：**没有对应，丢弃，不报错**（客户端拿到自由文本，语义降级，
    但请求可用）。
  - Responses 的 `model` → Pi IR / CommandCode 必须知道用哪个模型：
    **不可缺少，缺了报错**。
- 「丢弃」不是偷偷摸摸：要么在代码注释里写明「已知无对应，忽略」，要么
  在规范里记录。**丢弃 ≠ 静默丢失**——是显式的、有记录的丢弃。
- 报错只留给「缺了 B 就不可用」的字段：`model`、`input`、`tools` 数组
  形状、必填字段类型错误等。

**两个层：**

- **转换层**（Responses ↔ Pi IR）只对 Pi IR 契约负责：Pi IR 能表达的
  字段必须完整转换；表达不了的按上述原则丢弃（有记录）或报错（不可
  缺少）。
- **落地层**（Pi IR → CommandCode）同样适用该原则：Pi IR 字段在
  CommandCode 有对应 → 必须转；没有 → 丢弃不报错；不可缺少 → 报错。
- **但转换层必须知道自己的每个决定会怎样落到 CommandCode**——否则
  "完整转换"会变成"转换层完整、落地层悄悄炸掉"（最典型：`strict:true`
  转换层转对了，落地层 `convertCommandCodeTools` 却抛错，见 4.2.8）。

因此本报告的每个对照表和每个问题都标注两栏信息：**转换层职责**（按
上述原则该怎么做）和 **CommandCode 落地影响**（这样转换后 provider 会
怎样）。两侧都要看清，才算完备。

---

## 2. 27 个真实样本里到底有什么（我们验证的依据）

`test/fixtures/codex-cli-requests/` 里有 27 个文件，是真实 Codex CLI
（v0.147.0）发出的**真实请求体**（做了脱敏）。我们逐个统计了里面的字段：

| 字段 | 样本里有没有 | 说明 |
|---|---|---|
| `input` 里的 `message`（用户/开发/助手消息） | 有（95 条） | 开发者消息内容永远是 3 段文本，不是单个字符串 |
| `input` 里的 `reasoning`（思考条目） | 有（11 条） | 永远带 `summary`，且紧跟在同一批的 `function_call` / `custom_tool_call` / `message` 前面 |
| `input` 里的 `function_call`（函数调用） | 有（5 条） | `arguments` 是 JSON 字符串 |
| `input` 里的 `custom_tool_call`（自由格式工具调用） | 有（2 条） | 都是 `apply_patch`，`input` 是原始文本 |
| `input` 里的 `function_call_output` / `custom_tool_call_output`（工具结果） | 有（7 条） | `output` 是普通字符串 |
| 文本内容部件 `input_text` / `output_text` | 有（176 个） | 没有图片、拒答、加密内容部件 |
| `input_image`（图片） | 没有 | 解析器只支持 data URL 格式 |
| `tools` 里的 `function`（函数工具） | 有（297 个） | 全部带 `strict:false`；参数有的有、有的是 `null`（54 个） |
| `tools` 里的 `custom`（自由格式工具） | 有（27 个） | 都是 `apply_patch`，带 Lark 语法定义 |
| `tools` 里的 `tool_search` / `web_search`（服务端工具） | 有（27 个） | 每个请求都带 |
| `tools` 里的 `namespace`（命名空间工具） | 没有 | 解析器支持扁平化，但样本没覆盖 |
| `reasoning.effort`（思考强度） | 有（27 个） | 永远是 `"high"` |
| `tool_choice`（工具选择） | 有（27 个） | 永远是 `"auto"` |
| `parallel_tool_calls`（并行工具） | 有（27 个） | 永远是 `true` |
| `store`（是否存到服务端） | 有（27 个） | 永远是 `false` |
| `stream`（是否流式） | 有（27 个） | 永远是 `true` |
| `text`（输出选项） | 有（27 个） | 永远是 `{verbosity:"low"}`，**从没有 `text.format`** |
| `previous_response_id`（上一轮响应 id） | 没有 | 被脱敏删掉了；真实多轮会话在用（在线测试覆盖） |
| `instructions` / `include` / `prompt_cache_key` / `client_metadata` | 被脱敏删掉 | 按 README 说明 |

**三个关键结论：**

1. 样本里真实出现的字段，我们的转换全部接受、全部通过
   `test/integration/openai-responses-replay.test.ts` 的回归测试。
   **没有 P0。**
2. `text.format`、图片、`namespace`、`compaction`、`agent_message`、
   `web_search_call`、`tool_search_call`/`output`、`additional_tools`、
   `context_compaction` **都没出现在样本里**——它们是「未来/边缘」覆盖，
   不是今天的真实流量。
3. 样本里的 `reasoning` 都直接贴在它所属的调用/消息前面，没有出现
   「思考隔着一条工具结果」的情况。

---

## 3. 逐类对照

> 表格里「Pi 包」= Pi AI 官方实现，「我们」= LuckyToken。
> 「影响」列标注了严重度：P1 = 真实客户端会用到、P2 = 边缘/未来。

### 3.1 请求侧：input 条目类型覆盖

先解释什么是「条目」：`input` 是一个数组，每个元素是一条「条目」，用
`type` 字段区分。比如 `message`（消息）、`reasoning`（思考）、
`function_call`（函数调用）、`function_call_output`（函数结果）……

> 本表及后续所有对照表都新增两列：**转换层职责**（Responses→Pi IR 这段
> 我们该怎么做）和 **CommandCode 落地影响**（这样转换后 provider 会
> 怎样）。两侧都要看清，才算完备（见 1.4）。

| Pi 包做法 | 我们做法 | 差异 | 转换层职责 | CommandCode 落地影响 |
|---|---|---|---|---|
| 把 Pi 消息转成 `message` 条目，角色 user/assistant/developer（系统提示在开推理时用 developer 角色） | 接受 `message`：system/developer → 并进系统提示；user → Pi 用户消息；assistant → Pi 助手消息（打上「合成历史」标记） | 方向镜像；我们多容忍了 `system` 角色 | 完整 | 系统提示 → `params.system`，消息 → `params.messages`，CommandCode 原生支持（provider.ts `buildCommandCodeBody`） |
| 只把**带签名的** thinking 块转成 `reasoning` 条目；普通思考在跨模型时转成文本 | 读 `reasoning.summary` / `content` 成 thinking 块；**丢掉 `encrypted_content` 和条目 id** | Pi 把整个 reasoning 条目（含加密内容）原样保存，我们只留可见的摘要文字 | **无对应 → 丢弃**（`encrypted_content` 在 Pi IR 的 `ThinkingContent` 有 `thinkingSignature` 槽位但落地层不产生它；当前丢弃有记录即可） | 思考块 → `{type:"reasoning"}`，CommandCode 支持明文思考；加密内容落地层用不上（P2，见 4.2.1） |
| `function_call` 带 `id`、`call_id`、`arguments` | 接受 `function_call`，只留 `call_id`，丢条目 `id` | Pi 保留条目 id 用于重放配对；我们靠 `call_id` 关联工具结果 | 完整（我们自生成 id，不需要配对历史 id） | `toolCall` → `{type:"tool-call"}`，CommandCode 按 `toolCallId` 关联结果，天然支持 |
| `custom_tool_call` 带 `id`、`call_id`、`input` | 接受 `custom_tool_call`，转成 `arguments:{input}`；**不记住这是自由格式工具** | Pi 靠工具类型判断回放；我们必须靠请求里的 `tools[]` 声明才知道（见 4.2.2） | 转换本身完整；**跨请求的 freeform 集合不持久** | `arguments:{input}` → CommandCode `tool-call` 的 `input` 是对象，`{input:"补丁"}` 可落地；但出站时若判错类型会变 `function_call`，客户端拒绝（P2，见 4.2.2） |
| `function_call_output` / `custom_tool_call_output` 带 `call_id` | 接受两者，按 `call_id` 关联；**找不到调用时直接丢弃** | Pi 遇到缺失结果会**合成**一条「无结果」；我们选择丢弃 | **无对应 → 丢弃**（孤儿结果在 Pi IR 没有可挂靠的调用；丢弃符合 1.4 原则，且有记录） | CommandCode 的 `convertCommandCodeMessages` 对**缺失结果会抛错**——我们丢弃正是为了避免把孤儿传给落地层（provider.ts 的 `flushMissingResults` 会补「No result」） |
| —（服务端独有） | `compaction` / `compaction_summary` / `context_compaction` → 降级成一条用户文本 | Pi 的 IR 里没有这些类型 | **无对应 → 降级**（compaction 在 Pi IR 无对应条目，降级成用户文本是「有记录的丢弃」） | 降级成用户消息 → CommandCode 普通用户消息，安全落地 |
| —（服务端独有） | `agent_message`（子代理消息）→ 用户文本 | — | **无对应 → 降级**（compaction 在 Pi IR 无对应条目，降级成用户文本是「有记录的丢弃」） | 同上，安全落地 |
| —（服务端独有） | `web_search_call` / `tool_search_call` / `compaction_trigger` → 直接丢弃 | Pi 只在声明支持工具搜索时才输出 `tool_search_call`/`output` | 有意丢弃（文档化） | 落地层不涉及（IR 里没有这些条目） |
| —（服务端独有） | `additional_tools`（追加工具）→ 并进工具列表 | Pi 只在 `supportsAdditionalTools` 时输出 | 完整 | `context.tools` → `convertCommandCodeTools`，CommandCode 原生支持函数工具 |
| `tool_search_output`（工具搜索结果条目） | **不认识这个类型 → 返回 400** | Pi 会输出它 | **无对应 → 丢弃**（按 1.4 原则，Pi IR 表达不了就丢弃，不报错） | 落地层不涉及；当前 400 违反原则，应改为丢弃（P2，见 4.2.9） |

### 3.2 请求侧：内容部件和工具定义

先解释「内容部件」：一条 `message` 的 `content` 是一个数组，每个元素是
一个「部件」，用 `type` 区分：`input_text`（文本）、`input_image`
（图片）、`refusal`（拒答）、`encrypted_content`（加密内容）……

| 关注点 | Pi 包做法 | 我们做法 | 差异 | 转换层职责 | CommandCode 落地影响 |
|---|---|---|---|---|---|
| 文本部件 | `input_text` / `output_text` | 三种都认（多了 `text`） | 我们是超集 | 完整 | `text` → `{type:"text"}`，CommandCode 原生支持 |
| 图片部件 | `input_image`，data URL 格式 | **只认 data URL**；`file_id` 格式静默丢弃 | Pi 客户端侧也只发 data URL；但我们是服务端，桌面端可能发 `file_id`（只有服务端存过图才会） | **有对应 → 应转**：图片是 Pi IR 能表达的（`ImageContent`），`file_id` 只是我们解析器不认；当前静默丢弃违反「有对应必须转」，应解析或至少降级 | `ImageContent` → `{type:"image", image:dataURL}`，CommandCode 原生支持图片（模型声明 vision 时）；`file_id` 静默变空消息，落地层根本看不到图（P2，见 4.2.3） |
| `refusal` / `encrypted_content` 部件 | `refusal` 读回文本 | 静默忽略 | 我们丢内容不报错 | **无对应 → 丢弃**（Pi IR 表达不了 refusal；按 1.4 原则丢弃即可，最好降级成文本标记） | 落地层不涉及；内容消失（P2，见 4.2.4） |
| 工具参数缺失/非对象 | Pi 的工具参数永远是 TypeBox 对象 | `{...(是对象?原样:空), type:"object"}` 归一化 | 和 opencodex 一致；样本里 54 个 `null` 参数都处理了 | 完整 | `Tool.parameters` → `input_schema`，CommandCode 要求 `input_schema` 是对象——归一化正是为了让落地层不炸 |
| `strict:true`（严格 schema） | Pi 出站时当 schema 格式提示（软约束） | 我们转成 `constrainedSampling {strict:"require"}`（**硬约束**） | **方向性语义差异** | **有对应 → 必须转**（Pi IR 有 `constrainedSampling` 字段，转换正确）；**但落地层对 `require` 抛错违反 1.4 原则**（见 4.2.8） | **落地层会抛错**：`convertCommandCodeTools` 对 `strict:"require"` 直接 throw（provider.ts）。样本全是 `strict:false`，没触发。**这是「转换层做对了、落地层悄悄炸」的典型**（P2，见 4.2.8） |
| 自由格式 `custom` 工具 | Pi 出站时按语法工具原样发 `type:"custom"` | 我们转成函数工具 `{input:string}`，并记下名字 | **两边各自正确**：Pi 面对能处理语法的 OpenAI 服务端；我们面对只认函数工具的 CommandCode。Lark 语法定义故意丢弃（CommandCode 用不了） | 完整（自由格式语义保留在 `arguments:{input}`） | `{input:string}` 工具 → CommandCode 函数工具，可落地；Lark 语法丢失是落地层的取舍，不是转换层缺陷 |
| `namespace` 工具 | Pi 扁平化 | 我们扁平化 | 一致（opencodex 行为） | 完整 | 扁平后的函数工具 → CommandCode 函数工具，可落地 |
| `tool_search` / `web_search` 工具定义 | Pi 原样发出去 | **跳过**（不给模型看） | **设计取舍**：本地模型执行不了，列出来反而误导模型 | **无对应 → 丢弃**（web_search/tool_search 在 Pi IR 无对应工具类型；丢弃符合 1.4 原则且有记录） | 落地层不涉及（IR 里没有这些工具） |
| 未知条目类型 | 不适用（Pi 不解析入站） | 抛 `InvalidRequest` 400 | 与 opencodex 解析器一致 | **违反 1.4 原则**：未知类型无对应应丢弃不报错（见 4.2.9） | 落地层不涉及 |

### 3.3 请求侧：选项映射

先解释「选项」：请求体里 `model`、`input` 之外的顶层字段，用来控制模型
行为。

| 选项 | Pi 包做法 | 我们做法 | 差异 | 转换层职责 | CommandCode 落地影响 |
|---|---|---|---|---|---|
| `max_output_tokens` | `max(maxTokens, 16)`（OpenAI 服务端要求下限 16） | 直接透传，无下限 | 16 是 OpenAI 服务端的怪癖，CommandCode 有自己的边界校验 | 完整（→ `maxTokens`） | `max_tokens`，CommandCode 原生支持；无下限是因为落地层自己有校验 |
| `temperature` | 透传 | 透传 | 一致 | 完整 | `temperature`，CommandCode 原生支持 |
| `top_p` | 不建模（只在 samplingParams 透传） | 校验但**不转换** | 一致（Pi 的 `SimpleStreamOptions` 没有 top_p，CommandCode 也不收） | **无对应 → 丢弃**（Pi IR 无 top_p；按 1.4 原则丢弃，有记录） | 落地层不涉及；语义丢失是**协议层**的已知缺口，不是我们独有 |
| `stop`（停止词） | 不建模 | **完全不读** | 一致 | **无对应 → 丢弃**（Pi IR 无 stop；当前丢弃但没记录，补注释即可） | 落地层不涉及（P3/超范围） |
| `reasoning.effort`（思考强度） | 按模型映射；`"none"` → `off` | `ultra→max`；未知值 → 400；**`"none"` 静默丢弃** | Pi 会发出 `reasoning:{effort:"none"}`，我们直接丢掉「关闭思考」的请求 | **有对应 → 应转**（Pi IR 的 `reasoning` 能表达关闭思考；`"none"` 应透传而非丢弃） | `reasoning_effort`，CommandCode 支持；若转换层丢了 `"none"`，落地层收到 `undefined`，模型继续思考、浪费 token（P1，见 4.1.4） |
| `parallel_tool_calls`（并行工具） | codex 变体硬编码 `true` | **完全不读**（连校验都没有） | 样本恒为 `true`；将来客户端发 `false` 会被静默无视 | **无对应 → 丢弃**（Pi IR 无 parallel_tool_calls；当前丢弃但没记录，补注释即可） | CommandCode 无并行开关；即使转换了落地层也忽略（P1 文档性，见 4.1.3） |
| `tool_choice`（工具选择） | 映射（默认 `"auto"`） | 校验但**不转换** | 样本恒为 `auto`；`required`/`none`/指定函数会被静默无视 | **无对应 → 丢弃**（Pi IR 无 tool_choice；当前丢弃但没记录，补注释即可） | CommandCode 无 tool_choice 字段；转换了落地层也忽略（P1 文档性，见 4.1.5） |
| `text.format`（结构化输出） | codex 变体发 `text:{verbosity}`；`format` 只在 samplingParams 透传 | **完全不读** | 结构化输出请求会被静默无视 | **有对应 → 应转**：Pi IR 的 `constrainedSampling` 能表达结构化输出；但落地层对 `require` 抛错（见 4.2.8），**当前丢弃是「落地层不支持时的临时降级」，应有记录** | 若映射到 `constrainedSampling`，落地层 `convertCommandCodeTools` 对 `require` **抛错**；若降级为自由文本，客户端校验失败。**两侧都要设计**（P1，见 4.1.1） |
| `store` | 恒发 `false` | 校验布尔值，**忽略**（规范 D7：本地缓存语义） | 一致（我们本来就不存服务端） | 有意忽略（文档化） | 落地层不涉及 |
| `stream` | 恒 `true` | `true` → SSE，`false` → JSON | 一致 | 完整 | 落地层不涉及（HTTP 层决定） |
| `include`（请求额外返回字段） | 开推理时发 `["reasoning.encrypted_content"]` | **忽略** | 我们返回明文思考摘要，不需要加密内容 | 有意忽略（文档化） | 落地层不涉及（P2 加密信封见 4.2.1） |
| `prompt_cache_key` / `prompt_cache_retention`（提示词缓存） | 发 `clampOpenAIPromptCacheKey(sessionId)` + 保留期 | **忽略**（但 sessionId 已通过认证流入 Pi 选项） | 缓存键是客户端侧的提示；我们的 sessionId 已给到 provider | 有意忽略（文档化） | `sessionId` → `x-session-id` 头，CommandCode 用它做会话亲和/缓存 |

### 3.4 响应侧：输出条目

先解释「输出条目」：响应里的 `output` 数组，每条是一个输出条目：
`message`（模型消息）、`reasoning`（思考）、`function_call`（函数调用）、
`custom_tool_call`（自由格式调用）……

> 响应侧是**出站**方向（Pi IR → Responses），CommandCode 落地影响在
> **上一步**（CommandCode 结果 → Pi IR 时已经发生）。这里标注的是
> 「Pi IR 里带着什么」→「我们出站时怎么表达」。

| 关注点 | Pi 包做法 | 我们做法 | 差异 | 转换层职责 | Pi IR 来源（落地层已经做过什么） |
|---|---|---|---|---|---|
| `message` 条目 id | 保留原 id（存进 `textSignature`） | 合成 `msg_<响应id>_<序号>` | Pi 需要原 id 是因为它要把**同一个响应**原样重发给 OpenAI；我们每次都是全新响应 | 完整（我们自生成 id 即可） | Pi IR `TextContent` 无 id 字段；CommandCode 的 `text` 块 id 也没进 IR——所以出站只能合成 |
| `reasoning` 条目 | 整个条目（含加密内容）存进 `thinkingSignature` | 只发 `{summary:[...]}`，**没有 `content`、没有 `encrypted_content`** | 见 4.2.1 | **不完整**（Pi IR `ThinkingContent` 支持 `thinkingSignature`，我们没填） | CommandCode 的 `reasoning` 块只有明文文本；加密内容根本不会进 IR——**落地层不产生它，转换层无从表达**（P2，见 4.2.1） |
| `function_call` 条目 | `id`/`call_id`/`name`/`arguments` JSON | 同形状，id 合成 | 一致 | 完整 | Pi IR `ToolCall` 的 `arguments` 是对象 → 出站 JSON.stringify；CommandCode `tool-call` 的 `input` 对象原样进 IR |
| `custom_tool_call` 条目 | 工具是语法工具时输出，`input` 字符串 | `freeformToolNames` 里有名字时输出，`input` 字符串 | **判断依据不同**：我们靠「当前请求的 `tools[]` 声明」，若增量请求没带工具定义就判不出来 | 完整（Pi IR `ToolCall.arguments:{input}` → `input` 字符串） | CommandCode `tool-call` 的 `input` 是对象 `{input:"补丁"}` → IR 里也是对象 → 出站凭 freeform 集合还原成字符串（P2，见 4.2.2） |
| 条目顺序 | 思考 → 消息 → 工具调用 | 同顺序 | 一致 | 完整 | CommandCode 内容块顺序原样进 IR，出站原样出 |
| `message.phase`（阶段标记） | 捕获 `item.phase`（commentary/final_answer） | **不输出** | 桌面 Codex 用 `phase:"final_answer"` 区分「过程评论」和「最终答案」；CLI 忽略它 | **不完整**（Pi IR `TextContent.textSignature` 可携带，但落地层不产生它） | CommandCode 没有 phase 概念，IR 里没有 → 出站无法补发（P2，见 4.2.5） |
| `refusal`（拒答） | 读回文本 | 不适用（我们从不输出） | — | 不适用 | CommandCode 没有拒答概念 |

### 3.5 usage（token 用量）映射

先解释 `usage`：响应里报告这次请求用了多少 token。Responses 协议字段：

- `input_tokens`：输入 token（**含**缓存命中的部分）；
- `input_tokens_details.cached_tokens`：缓存命中多少；
- `output_tokens`：输出 token；
- `output_tokens_details.reasoning_tokens`：其中思考 token 多少；
- `total_tokens`：总计。

Pi IR 的 `Usage` 字段（`types.d.ts` 里查证过）：

```ts
input: number;        // 输入（不含缓存）
output: number;       // 输出
cacheRead: number;    // 缓存读
cacheWrite: number;   // 缓存写（注意：Pi IR 里有这个字段！）
totalTokens: number;
reasoning?: number;   // 思考 token（输出的子集）
```

| Pi 包（入站） | 我们（出站） | 差异 | 转换层职责 | 落地层来源（CommandCode 已做过什么） |
|---|---|---|---|---|
| `input = input_tokens − cached_tokens − cache_write_tokens`（OpenAI 的 input_tokens 含缓存） | `input_tokens = input + cacheRead + cacheWrite` | **精确互逆** | 完整 | CommandCode `semantic.ts` 的 `convertUsage` 已经把 `inputTokenDetails` 拆成 input/cacheRead/cacheWrite 进 IR——我们只是原样还原 |
| `cacheRead = cached_tokens`、`cacheWrite = cache_write_tokens` | `cached_tokens = cacheRead`；**cacheWrite 没有对应槽位，并进 input_tokens 总数** | Responses wire 的 `input_tokens_details` **只有** `cached_tokens` 一个字段（OpenAI SDK 类型已查证，没有 `cache_write_tokens`——那是 completions API 的字段） | **不完整但无解**：wire 没槽位，只能折叠；应文档化 | CommandCode 确实报告 `cacheWriteTokens`（`semantic.ts`），进 IR 是完整的；**丢在出站这层**（P1，见 4.1.2） |
| `reasoning = output_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens = usage.reasoning` | 精确互逆 | 完整 | CommandCode `outputTokenDetails.reasoningTokens` → IR `usage.reasoning`，原样还原 |
| `totalTokens` 透传 | `total_tokens = totalTokens` | 一致 | 完整 | CommandCode `totalUsage` → IR `totalTokens`，原样还原 |

### 3.6 停止原因 → 状态映射

先解释「停止原因」：Pi 的 `AssistantMessage.stopReason` 有
`stop`（正常结束）、`length`（输出到上限）、`toolUse`（要调工具）、
`error`（出错）、`aborted`（被取消）。

Responses 协议的状态：`completed`（完成）、`incomplete`（未完成，如输出
截断）、`failed`（失败）。

| Pi 包（入站） | 我们（出站） | 差异 | 转换层职责 | 落地层来源（CommandCode 已做过什么） |
|---|---|---|---|---|
| `completed→stop`；`incomplete.max_output_tokens→length`；其他 incomplete→error；`failed/cancelled→error`；`in_progress/queued→stop`（Pi 注释自嘲「wonky」） | `stop/toolUse→completed`；`length→incomplete{reason:"max_output_tokens"}`；error/aborted/其他→**直接报错不发响应**（handler 转成 HTTP 错误） | 我们更严格：绝不把未完成状态当完成发出去。Pi 必须给流一个终止理由，所以容忍了 `in_progress→stop` | 完整（我们的映射是 Pi 映射的子集+更严格） | CommandCode `semantic.ts` 的 `stopReason()`：`finishReason==="tool-calls"→toolUse`、`"length"→length`、否则 `stop`——落地层只产生这三种，出站映射全覆盖 |
| `stop` 但内容里有工具调用 → 改成 `toolUse` | provider 返回 `toolUse` → `completed` + function_call 条目 | 一致 | 完整 | CommandCode 的 `tool-calls` 已转成 `toolUse` 进 IR |

### 3.7 SSE 事件序列

先解释 SSE：`stream:true` 时，服务端用 SSE（Server-Sent Events）逐条推
事件。Codex 端接受的「标准序列」是：

```text
response.created            （状态 in_progress，output 空）
response.output_item.done   （每个输出条目一条）
response.completed          （完整响应对象）
data: [DONE]
```

| Pi 包 | 我们 | 差异 | 转换层职责 | 落地层影响 |
|---|---|---|---|---|
| 消费 OpenAI 真实流（created → 各种 delta → output_item.done → completed/incomplete/failed） | **合成**上面的标准原子序列（一次推完，无 delta） | 与 opencodex 的 `responses-json-events.ts` **逐帧一致**（同一算法） | 完整（原子序列是规范 §7 明确的设计） | 落地层不涉及 SSE（那是 HTTP 层）；CommandCode 的流式结果先被 `execute` 收成完整 `AssistantMessage`，再合成 SSE |
| 处理 `response.failed` / `error` 事件 → 转成 error 停止原因 | 不出失败帧；provider 出错直接 HTTP 502 JSON | opencodex 的标准序列支持 `response.failed`；Codex 客户端能容忍 HTTP 错误，但**截断的 SSE body 不行** | **不完整**（原子响应下可接受；per-delta 流式时必须发失败帧） | CommandCode 出错 → `AssistantMessage.stopReason="error"` → 我们转 HTTP 502。**落地层的错误信息（如 statusCode）没有传到 HTTP 层**（P2，见 4.2.6、4.2.7） |

### 3.8 错误形状

先解释错误形状：出错时返回 `{"error": {"type": "...", "message": "..."}}`，
客户端按 `type` 决定怎么处理（如 `rate_limit_error` 会重试）。

| Pi 包 | 我们 | 差异 | 转换层职责 | 落地层影响 |
|---|---|---|---|---|
| 把上游错误类型原样透传（`normalizeProviderError`） | 类型表：400 `invalid_request_error`、401 `authentication_error`、404 `not_found_error`、413 `request_too_large`、502/500 `api_error`，加上游映射 | 与 OpenAI 文档的错误分类对齐；上游 HTTP 失败还会转发 provider 自己的 `error.type`/`error.code` | 完整 | CommandCode 的 **HTTP 层**错误（如 429）能被 `HttpObserver` 观察并正确映射为 `rate_limit_error` |
| — | 所有「执行失败」一律 502 `api_error`，即使上游实际是 429 限流 | `HttpObserver` 只能观察到 **HTTP 层**的失败；CommandCode **流内**的 `error` 事件（带 statusCode）被拍平成 `ExecutionFailure` | **不完整**：落地层的 statusCode 没传到转换层 | CommandCode `assembler.ts` 的 `error` 事件 → `CommandCodeStreamError{statusCode}` → 被 `execute` 拍平成 `ExecutionFailure`，statusCode 丢失（P2，见 4.2.7） |

## 4. 按严重度分级的问题清单

### 4.0 P0：会导致真实请求失败/语义错误

**没有。** 27 个样本里真实出现的每个字段都被正确处理并有回归测试覆盖。
两个最接近的行为（丢弃孤儿工具结果、跳过服务端工具）都是**故意**的，
而且正是它们保住了真实对话不中断。

### 4.1 P1：真实客户端会用到（现在或下个版本）

#### 4.1.1 `text.format`（结构化输出）被静默忽略

**概念解释：** 普通请求 `text: {verbosity:"low"}` 只是让模型「回答简短
点」。`text.format` 则是**结构化输出**：要求模型输出严格符合一个 JSON
Schema。比如：

```json
{
  "model": "...",
  "input": "...",
  "text": {
    "format": {
      "type": "json_schema",
      "name": "weather",
      "schema": {"type": "object", "properties": {"temp": {"type": "number"}}},
      "strict": true
    }
  }
}
```

OpenAI 服务端会做**约束采样**（强制模型输出匹配 schema 的 token），保证
客户端拿到的就是合法 JSON。

**我们做了什么：** `validateResponsesRequest`（request.ts:257）只读
`max_output_tokens`、`temperature`、`top_p`、`reasoning`、`tools`、
`tool_choice`，**从没读过 `text`**。所以结构化输出请求被静默无视。

**为什么是 P1：** Codex 的结构化输出工作流会发这个字段。按 1.4 原则它
**有对应**（`constrainedSampling`），所以「应转」；但落地层目前对
`require` 抛错（4.2.8），所以「转了会 502、不转会静默降级」两头都
不对。**真正要修的是落地层**（降级不抛错），修完后转换层才能安全
完整映射。

**Pi 包为什么「没做」：** Pi 面对的是能原生支持 `text.format` 的 OpenAI
服务端，它只在 `samplingParams` 里透传（openai-responses.ts:338-340），
不需要自己实现。我们面对 CommandCode，必须自己决定。

**按转换原则（1.4）怎么算：** `text.format` 在 Pi IR **有对应**——
`constrainedSampling {type:"json_schema"}` 就是表达结构化输出的字段。
所以「有对应必须转」要求转换层把它映射过去。

**但落地层（Pi IR → CommandCode）目前不支持：** `convertCommandCodeTools`
对 `constrainedSampling {strict:"require"}` **直接抛错**（provider.ts），
请求 502。按 1.4 原则，落地层对「CommandCode 没有对应」的字段应该
**丢弃不报错**——所以落地层当前行为本身就违反原则。

**建议的最小修复（两条腿同步走）：**
1. 落地层（Pi IR → CommandCode）：对 `constrainedSampling` 没有 CommandCode
   对应时**降级丢弃**（不抛错，工具照常作为普通函数工具用），而不是 502。
2. 转换层（Responses → Pi IR）：既然落地层能降级，转换层就可以完整映射
   `text.format → constrainedSampling`，语义由落地层决定「支持或降级」。

这样符合 1.4 原则：**有对应必须转（转换层完整），落地层没有对应就降级
不报错（可用性优先）**。客户端拿到自由文本是降级，不是错误。

#### 4.1.2 `cacheWrite`（缓存写）在 usage 里被丢弃

**概念解释：** 一次请求的输入 token 分三部分：普通输入、缓存命中
（cacheRead）、缓存写入（cacheWrite）。Responses 协议的
`input_tokens_details` **只有** `cached_tokens` 一个字段（OpenAI SDK 类型
已查证；`cache_write_tokens` 是 completions API 的字段，Responses 没有）。
而 Pi IR 的 `Usage` **有** `cacheWrite` 字段。

**我们做了什么：** response.ts:110-113：

```ts
input_tokens: input + cacheRead + cacheWrite,   // 总数对
input_tokens_details: { cached_tokens: cacheRead },  // 明细只给 cacheRead
```

**影响：** 总数正确，但 cacheWrite 那部分在明细里消失了——客户端看到
`cached_tokens` 偏小、`input_tokens` 偏大，无法区分「普通输入」和
「缓存写」。

**为什么不是 bug：** wire 上没有这个字段，**两个方向字段集不对称**。Pi
包入站能读 `cache_write_tokens` 是因为它面对 OpenAI 服务端；我们面对
客户端，只能折叠。

**建议：** 在 `convertUsage` 里写注释说明这个有损折叠（当前没有）；不要
把 cacheWrite 塞进 `cached_tokens`（那会让 Pi 包的逆运算
`input_tokens − cached − cache_write` 错乱）。

**CommandCode 落地影响：** 这条的损失**不在落地层**——CommandCode 的
`semantic.ts` 已经正确报告 `cacheWriteTokens` 并完整写进 Pi IR 的
`usage.cacheWrite`。丢失发生在**出站转换层**（wire 没槽位）。所以这是
「落地层完整、转换层有损」的反例：修也只能在转换层修（折叠+注释），
不能去改 CommandCode。

#### 4.1.3 `parallel_tool_calls` 被忽略

样本恒为 `true`（默认），但这是合法选项，客户端可以发 `false`（禁止
并行工具）。我们完全不读它。CommandCode 目前没有并行工具开关。

**按转换原则（1.4）怎么算：** `parallel_tool_calls` 在 Pi IR **没有对应**
（`SimpleStreamOptions` 无此字段），在 CommandCode 也没有——**无对应 →
丢弃，不报错**。当前行为（忽略）**符合原则**，唯一缺口是没在代码注释/
规范里记录「已知无对应，忽略」。

**建议：** 在 `validateResponsesRequest` 附近加一行注释「parallel_tool_calls
在 Pi IR/CommandCode 无对应，按 1.4 原则忽略」，并把行为写进规范 §2.2。
将来 CommandCode 支持并行时再补映射。

#### 4.1.4 `reasoning.effort:"none"` 被静默丢弃

`convertReasoning`（request.ts:236）把 `effort:"none"` 当成「不传」——
但「不传」和「明确关闭思考」是两回事。Pi 包会发出
`reasoning:{effort:"none"}`。我们丢掉后，模型可能继续思考，浪费 token。

> 注：`effort:"minimal"` 在旧版报告里被列为问题，经复核后**移除**——
  那个行为（minimal 被 CommandCode 升级成 max）发生在 provider 层，不是
  Responses↔Pi IR 转换层。本报告只保留转换层的问题。

**按转换原则（1.4）怎么算：** `reasoning.effort:"none"` 在 Pi IR **有
对应**（`SimpleStreamOptions.reasoning` 能表达思考强度，Pi 包用
`clampThinkingLevel` 处理 `"none"` 为 `off`）。「有对应必须转」要求
转换层透传，而不是把 `"none"` 当成「没传」丢弃。

**CommandCode 落地影响：** CommandCode **支持** `reasoning_effort`（
`buildCommandCodeBody` 会写 `params.reasoning_effort`），且 `resolveReasoning`
对 `"none"` 的处理是「不写字段」——**所以透传后落地层行为正确**（不启用
思考）。当前转换层丢弃 `"none"` 是**违反「有对应必须转」**的：模型可能
继续思考浪费 token。

**建议：** 转换层保留 `"none"` 语义（透传，或映射成 Pi 能表达的
「关闭思考」形式）；落地层无需改动。

#### 4.1.5 `tool_choice` 校验后不转换（文档性）

样本恒为 `auto`。`required`/`none`/`{type:"function",name}` 会被静默
无视。CommandCode 没有这个字段。

**按转换原则（1.4）怎么算：** `tool_choice` 在 Pi IR **没有对应**
（`SimpleStreamOptions` 无此字段），在 CommandCode 也没有——**无对应 →
丢弃，不报错**。当前行为（校验类型后忽略）**符合原则**，唯一缺口是没在
规范里记录「已知无对应，忽略」。

**建议：** 把 `parallel_tool_calls`、`text`、`tool_choice` 的实际行为
（「无对应 → 丢弃」）写进规范 §2.2，与 top_p 的记录对齐。将来
CommandCode 支持工具选择时再补映射。

### 4.2 P2：边缘 / 未来 / 保真度

#### 4.2.1 思考的加密内容（`encrypted_content`）双向都不保真

**概念解释：** OpenAI 的 `reasoning` 条目带 `encrypted_content`（加密的
思考内容，模型跨轮续接的凭据）。Pi 包把整个条目（含加密内容）存进
`ThinkingContent.thinkingSignature`，同模型重放时原样发回
（shared.ts:220-224、683-688）。我们入站只留 `summary` 文本，出站只发
`summary`，加密内容和条目 id 都丢。

**为什么当前合理：** CommandCode 每轮重新推理，不需要签名续接。Pi IR
类型本身支持 `thinkingSignature`/`redacted`，所以**未来**若接需要签名
重放的 provider，这里就是缺口。规范 §7 已声明超范围。

**CommandCode 落地影响：** CommandCode 的 `reasoning` 块只有明文文本
（`assembler.ts`），**加密内容根本不会进 Pi IR**——落地层不产生它，
转换层无从表达。所以这条的「不完整」是**双向的**：入站时我们丢了
`encrypted_content`（但落地层本来也用不上），出站时我们发不出
`encrypted_content`（落地层也没给过）。要补只能等 CommandCode 支持
加密思考，或未来接 OpenAI 原生 provider。

#### 4.2.2 `custom_tool_call` 往返依赖「同一请求带工具定义」

**概念解释：** 我们靠 `renderState.freeformToolNames`（一个工具名集合，
在 request.ts:522-523 从**当前请求**的 `tools[]` 里收集）判断出站时把
调用渲染成 `custom_tool_call` 还是 `function_call`。真实 Codex 多轮会话
的增量请求**可能不带工具定义**（工具在服务端状态里）。这时名字不在集合
里 → 渲染成 `function_call` → 客户端拒绝 `apply_patch` 的自由格式载荷
（「incompatible payload」）。

27 个样本都重发了完整工具，所以今天不触发。**修复方向：** 把 freeform
集合随 session-state 持久化，或从历史 input 的 `custom_tool_call` 条目
反推。

**CommandCode 落地影响：** 入站方向落地层**没有影响**——`{input:"补丁"}`
→ `tool-call` 的 `input` 对象，CommandCode 正常执行。问题全在**出站**
方向：Pi IR 的 `ToolCall.arguments:{input:"补丁"}` 需要 freeform 集合
才能还原成 `custom_tool_call` 的 `input` 字符串。**落地层没问题，
转换层的状态缺失**——修在 session-state 持久化即可。

#### 4.2.3 `file_id` 图片引用被静默丢弃

`parseImageParts`（request.ts:112）只认 `data:` URL。桌面客户端若发
`file_id`（只有服务端存过图才会），会变成**空用户消息**，无报错。

**按转换原则（1.4）怎么算：** 图片在 Pi IR **有对应**（`ImageContent`），
落地层 `convertCommandCodeMessages` 也支持 `{type:"image", image:dataURL}`
（模型声明 vision 时）。所以 `file_id` 属于「有对应但格式解析不了」——
**按原则应尽量转**：要么支持 `file_id`（但需要服务端存过图，我们
`store:false` 不存，所以拿不到图内容），要么**降级成文本标记**
（「[图片：file_id=xxx，本地服务未存储]」）而不是静默变空消息。

**建议：** 解析 `file_id` 时降级成文本占位（不报错，符合 1.4「丢弃
不报错」），并在代码注释记录。落地层无需改动。

#### 4.2.4 `refusal` / `encrypted_content` 内容部件被忽略

Pi 包会把 `refusal` 读回文本（shared.ts:697）。我们静默忽略，内容丢失。

**按转换原则（1.4）怎么算：** `refusal` 在 Pi IR **没有对应**（Pi IR
无拒答概念），落地层也不认识——**无对应 → 丢弃，不报错**。当前行为
（忽略）符合原则。唯一改进：降级成文本标记（「模型拒绝回答」）比静默
消失更友好，但**不是必须**。

**建议：** 可选——降级成文本标记；不降级也符合原则，只需在代码注释
记录「refusal 无对应，忽略」。落地层无需改动。

#### 4.2.5 `message.phase`（commentary/final_answer）不输出

桌面 Codex 用 `phase:"final_answer"` 区分「过程评论」和「最终答案」；
CLI 忽略。Pi 包捕获并重发它。我们将来若 Pi 在 `TextContent.textSignature`
携带 phase，可以在 `convertOutput` 解析后补发。

**CommandCode 落地影响：** CommandCode 没有 phase 概念——**落地层不
产生它**。这条和 4.2.1 一样是「落地层不产生 → 转换层无从表达」的双向
缺口。要补：要么落地层给 Pi IR 的 `TextContent.textSignature` 塞 phase
（需要 CommandCode 支持区分过程/最终，或我们按「最后一块文本」启发式
补发），要么放弃。

#### 4.2.6 SSE 没有失败帧

`renderResponsesSse`（sse.ts）永远以 `response.completed` 结束。将来做
per-delta 流式时必须支持 `response.failed`（opencodex
`responses-json-events.ts` 会保留 failed/incomplete 状态）。

**CommandCode 落地影响：** SSE 是 HTTP 层的事，落地层不涉及。但「失败
怎么表达」依赖**落地层的错误如何传上来**（见 4.2.7）：如果
`CommandCodeStreamError` 的 statusCode 能传到 handler，出站时才能决定
发 `response.failed` 还是 HTTP 502。**这条是转换层+落地层联动的例子：
修 SSE 前先把错误通道打通。**

#### 4.2.7 流内限流被拍平成 502 `api_error`

`HttpObserver` 只能观察 HTTP 层。CommandCode **流内**的 `error` 事件
（`CommandCodeStreamError` 带 statusCode，如 429）被拍平成
`ExecutionFailure` → 502 `api_error`。客户端拿不到 `rate_limit_error`，
重试逻辑不生效。**建议：** 把 statusCode 通过诊断信息传到 handler，
429 → `rate_limit_error`。

**CommandCode 落地影响（这条本身就是落地层的）：** 信息在
`assembler.ts` 的 `error` 事件里是**完整**的（statusCode、isRetryable），
丢在 `execute` 拍平成 `ExecutionFailure` 那一步。**修在落地层与转换层的
接口**：让 `ExecutionFailure` 携带 statusCode（或通过 diagnostic），
转换层才能映射成正确的 `error.type`。

#### 4.2.8 `strict:true` 工具 → 硬约束 → provider 抛错

request.ts:174-176 把 `strict:true` 映射成 `constrainedSampling
{strict:"require"}`，而 `convertCommandCodeTools` 对 `require` 直接抛错。
Pi 的 `strict` 只是软提示。

**按转换原则（1.4）怎么算（最重要的联动案例）：**
- **转换层做对了**：`strict:true` → `constrainedSampling` 是 Pi IR 的
  **有对应 → 必须转**。
- **落地层违反原则**：`constrainedSampling` 在 CommandCode **没有对应**，
  按 1.4 应该**丢弃不报错**（降级成普通函数工具），但
  `convertCommandCodeTools` 对 `require` 直接抛错 → 客户端拿 502，完全
  看不出是 strict 工具导致的。这是「转换层完整、落地层悄悄炸」的典型，
  也是**唯一需要改落地层代码**的问题。

**建议的最小修复（改落地层，符合原则）：** `convertCommandCodeTools`
对 `constrainedSampling` 没有 CommandCode 对应时**降级丢弃**（工具照常
作为普通函数工具用），不抛错。转换层保持完整映射。

#### 4.2.9 `tool_search_output` 条目类型会 400

我们接受 `tool_search_call`（丢弃）但不接受 `tool_search_output`（未知
类型 → 400）。

**按转换原则（1.4）怎么算：** `tool_search_output` 在 Pi IR **没有对应**
（落地层也不认识）——**无对应 → 丢弃，不报错**。当前 400 **违反原则**：
未知条目类型不该报错（它不是 Pi IR 的不可缺少字段），应该像
`tool_search_call` 一样 `continue` 丢弃。

**建议：** 在 `convertMessages` 的 `default` 分支改为「未知类型 → 丢弃
+ 记录」，而不是抛 `InvalidRequest`（与 4.1.3/4.1.5 的「无对应丢弃」一致）。
落地层无需改动。

---

## 5. 哪些地方我们比 Pi 包更合适（服务端视角）

> 这一节同时评估「对 CommandCode 落地的影响」——我们的设计选择是否让
> 落地层更安全、更简单。

- **孤儿工具结果：容忍丢弃，而不是合成。** Pi 的 `transformMessages` 会
  为缺失的工具结果**合成**「No result provided」；我们选择丢弃。对无状态
  服务端回放增量请求，丢弃才是对的——合成会污染历史，拒绝会杀死对话
  （规范 D8 有记录）。
- **失败模式显式化。** 未知条目类型、畸形 `tool_choice`/`store`/
  `max_output_tokens`/`reasoning.effort` 都返回清晰的 400
  `invalid_request_error`，而不是静默默认值。
- **`input_tokens` 算术与 Pi 精确互逆。** `input+cacheRead+cacheWrite`
  ↔ `input_tokens−cached−cache_write`，逐 token 对上。
- **SSE 原子序列与 opencodex 逐帧一致。** 同一个 Codex 会提交的序列，
  被真实 CLI 在线测试验证过。
- **会话状态：持久、有界、fail-open。** Pi 的客户端适配器不需要这个
  （它总是发全量历史）；LuckyToken 自己拥有 `previous_response_id` 展开
  逻辑，且带防毒机制（D8）、原始 wire 条目单一事实源（D2）。
- **合成历史身份。** 回放的助手消息打上 `SYNTHETIC_CLIENT_HISTORY_API/
  PROVIDER` 标记，防止被当成「同目标连续性」——CommandCode provider 对
  同目标签名会拒绝，这个标记正是 Pi 不需要的 IR 边界防护。
- **工具参数归一化让落地层不炸。** `parameters` 缺失/非对象时强制
  `type:"object"`（request.ts:165-168）——CommandCode 的
  `validateWireTools` 要求 `input_schema` 是对象，归一化正是为了满足
  落地层的硬校验。样本里 54 个 `null` 参数都靠它活下来。
- **孤儿工具结果丢弃避免了落地层抛错。** CommandCode 的
  `convertCommandCodeMessages` 对孤儿 `toolResult` 直接 throw；我们入站
  丢弃孤儿，正是为了避免把落地层必炸的输入传下去。**转换层的有意
  「不完整」保护了落地层的完整性。**

## 6. 必须改什么（按转换原则 1.4 重新分级）

对**今天的真实流量**：什么都不必改（27 个样本全过）。值得排期的
（每条都标注了要动的层——转换层 / 落地层 / 两侧联动，以及违反原则的
类型）：

1. **落地层违反「无对应 → 丢弃」**：`convertCommandCodeTools` 对
   `constrainedSampling {strict:"require"}` 抛错（4.2.8）。改成降级丢弃
   （工具照常用），不抛错。这是**唯一需要改落地层代码**、且直接违反
   1.4 原则的问题。
2. **转换层违反「有对应 → 必须转」**：`reasoning.effort:"none"` 被丢弃
   （4.1.4）。改成透传（落地层支持 `reasoning_effort`，透传后行为正确）。
3. **转换层违反「无对应 → 丢弃不报错」**：未知条目类型（含
   `tool_search_output`）抛 400（4.2.9）。改成丢弃 + 记录。
4. **文档化「无对应 → 丢弃」**：把 `parallel_tool_calls`、`text`、
   `tool_choice`、`file_id`、`refusal` 的实际行为写进规范 §2.2 和代码
   注释（4.1.3、4.1.5、4.2.3、4.2.4）——**这些当前行为已经符合原则，
   只差记录**。
5. **保真度（不违反原则，纯质量）**：P1-2 `cacheWrite` 折叠注释（转换
   层，落地层已完整）；P2-7 流内 429 → `rate_limit_error`（落地层与转换
   层接口——让 `ExecutionFailure` 携带 statusCode）；P2-2 自由格式集合
   跨请求持久化（转换层 session-state）。
6. **可选**：`file_id` 降级成文本占位而非静默空消息（4.2.3）；`refusal`
   降级成文本标记（4.2.4）。

**结论：** 按 1.4 原则，「转换永远可用」优先于「语义完整」。真正要动
代码的只有 3 处（落地层降级 strict、转换层透传 none、未知类型改丢弃），
其余全是文档化与保真度改进。## 7. 方法 / 资料来源

- Pi 包：`pi-agent/packages/ai/src/api/openai-responses.ts`（参数+流）、
  `openai-responses-shared.ts`（消息/工具/流/usage）、
  `openai-codex-responses.ts`（Codex 请求体）、`transform-messages.ts`、
  `utils/deferred-tools.ts`；类型定义：
  `node_modules/@earendil-works/pi-ai/dist/types.d.ts`。
- LuckyToken：`src/protocols/openai-responses/request.ts`、`response.ts`、
  `sse.ts`、`session-state.ts`、`handler.ts`、`src/protocols/options.ts`、
  `src/execution.ts`、`packages/provider-commandcode-private/src/{provider,semantic,
  assembler}.ts`、`packages/provider-contract/src/diagnostics.ts`。
- 参考实现：`D:\project\opencodex\src\server\responses-json-events.ts`、
  `src/responses/reasoning-envelope.ts`。
- 样本：`test/fixtures/codex-cli-requests/*.json`（27 个文件，普查见第 2 节）。
- 测试：`test/unit/openai-responses-*.test.ts`、
  `test/integration/openai-responses-replay.test.ts`、
  `test/integration/openai-responses-serving.test.ts`、
  `test/online/run-codex-cli.ts`。
