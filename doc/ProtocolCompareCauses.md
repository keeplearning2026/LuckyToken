# Responses → OpenAI Chat 差异归因（Token / opencodex）

本文件解释 [`final/report.md`](../artifacts/protocol-compare/final/report.md) 的 **182 个场景、7,108 个字段差异**（上游请求 1,148、客户端响应 716、响应外壳 1,410、SSE 数据/帧 3,834）。结论是“为何这两个锁定版本在这个夹具中产生不同值”，不是哪一方必然符合规范。下文的逐字段索引给每个差异一个归因编号；原值与完整 JSON 仍以各场景的 `diff.md` 为准。

## 证据边界

- 比较快照：Token `ae7d119`（运行时有未提交的比较工具改动）、opencodex `2f82167` / 2.61.0、Pi 0.87.0；以报告 [`manifest`](../artifacts/protocol-compare/final/report.json) 为准。当前工作树可能已前进，本文分析的是报告快照及同一逻辑的源文件，不声称未来版本不变。
- 夹具直接调用双方 Responses handler，在各自隔离的子进程中拦截 OpenAI Chat `fetch`，记录**序列化后的上游 body**，再送入脚本化 Chat JSON/SSE 返回。没有启动 Codex CLI，也没有请求真实模型。见 [`worker.mjs`](../tools/protocol-compare/worker.mjs)、[`wire.mjs`](../tools/protocol-compare/wire.mjs)、[`cli.mjs`](../tools/protocol-compare/cli.mjs)。
- Token 夹具模型是人工 `compare/model`，`reasoning` 通常为 `true`、`supportsDeveloperRole: true`，`supportsMidConvoSystemMessages` 除 `no-mid-system` profile 外为 `true`。这**不是生产模型默认能力**。opencodex 使用人工 OpenAI Chat provider；其真实 URL/授权不在本次结论内。
- 比较器只归一化生成的 Responses response/item ID 与时间；不归一化 Provider 请求、输出字段是否存在、SSE 拓扑。数组按下标逐项比较，因此一次消息前插或 SSE 事件多发会产生一串下标差异；这些是**同一结构根因的连带差异**，不是几十条独立转换规则。见 [`report.mjs`](../tools/protocol-compare/report.mjs)。报告的覆盖率是语料标签计数，不是源码覆盖率。
- 脚本回复按**各实现发出的 `body.stream`**选 JSON 或 SSE。尤其非流式 Responses 场景下，Token 仍以 SSE 向 Pi/上游取结果，opencodex 以 JSON 取结果；对于截断、非法工具参数、content filter 等，双方收到的模拟上游字节也可能不同。这样的结论标作“夹具交互”，不能只用输出差异推断两个响应解析器对**同一上游字节**的行为。
- `replay.*` 的后续请求使用各自前一步的响应组装，不保证第二步客户端输入逐字相同。因此回放差异包括首轮结果与状态存储路径的影响。

## 两条实际数据链

Token：Responses 请求 → [`request.ts`](../src/protocols/openai-responses/request.ts) 的按需求解析与 Pi `Context`/options → [`pi-context-compatibility.ts`](../src/pi-context-compatibility.ts) 的模型能力处理 → Pi `normalizeContext` / `transformMessages` → Pi [`openai-completions.js`](../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js) 构建 Chat 请求 → Pi 解析 Chat 流为 `AssistantMessage` → Token [`response.ts`](../src/protocols/openai-responses/response.ts) 与 SSE 渲染。

opencodex：Responses 请求 → [`parser.ts`](../reference/opencodex/src/responses/parser.ts) 的 `OcxContext`/options → [`openai-chat/messages.ts`](../reference/opencodex/src/adapters/openai-chat/messages.ts) 与 [`openai-chat.ts`](../reference/opencodex/src/adapters/openai-chat.ts) 构建 Chat 请求 → Chat adapter 解析 JSON/SSE 为事件 → [`response-json.ts`](../reference/opencodex/src/bridge/response-json.ts) 或 [`sse.ts`](../reference/opencodex/src/bridge/sse.ts) 渲染 Responses。

尤其要更正“支持 mid system 就保留原位置”这种过简说法：Token 将输入中的 `system` **和** `developer` 都放成 Pi `SystemMessage`，原始 role 身份在 Pi Context 中已丢失（`request.ts:1450-1464`）。夹具模型支持中途 system 时，Token 的兼容层不改位置；Pi Chat adapter 仅在 `model.reasoning && compat.supportsDeveloperRole` 时将这种 SystemMessage 写成 Chat `developer`，否则写成 `system`（Pi `openai-completions.js:896-920`）。即使兼容能力为 true，Pi `transform-messages.js:180-186` 在未完成的工具调用/结果间也会暂存中途 system，待工具交换闭合后再写；所以不是“任何位置都无条件原样”。能力为 false 时，Token 兼容层把可安全降级的中途纯文本 system 改成 user，必要时推迟到工具结果后（`pi-context-compatibility.ts:34-131`）。

opencodex 则在**入站解析**时把任何 `role=system` 的文字收集到 `systemPrompt`，之后由 Chat adapter 放在最前面；`role=developer` 保留在 `messages` 的原时间槽位（`parser.ts:245-258`、`messages.ts:133-167`）。它的槽位与最终 Chat role 是两件事：非原生 OpenAI 目标的 `developerWireRole` 仍可选 `system`。因此 `roles.mid-system` 中 opencodex 的 MID 位于首条 Chat system，而 Token 的 MID 在历史中段、按本夹具变成 Chat developer。这是两条 IR 路径的可证实差异，不是 report 把顺序看错。

## 根因目录

编号是字段差异的**主要直接来源**；一项差异可能有上游连锁原因。对数组错位，索引标的是首要结构原因，具体值由链接的 `diff.md` 核查。

| 编号 | 原因及责任边界 |
|---|---|
| `Q-ADMISSION` | 一方在 Responses 入站阶段拒绝或接受，故一方根本没有上游请求。Token 使用自己的转换政策/校验（`request.ts:1000-1081,2250-2276`）；opencodex 使用 Zod schema 与 parser（`schema.ts:163-189`）。后续响应/事件差异均为“是否派发”的结果。 |
| `Q-STREAM` | Pi Chat adapter 固定 `stream: true` 并通常加 `stream_options.include_usage`（Pi `openai-completions.js:565-583`），Token 外层 `stream:false` 只控制客户端渲染；opencodex Chat adapter 用 `parsed.stream`，仅流式时加 usage 选项（`openai-chat.ts:107-110,223-227`）。 |
| `Q-MESSAGE` | 消息文本、role、数组位置的 IR 路径差异：Token 的 Pi SystemMessage/文字 part，opencodex 的 systemPrompt 前置、developer 时间槽位、用户文字扁平化及可能的工具目录 system 提示。查 `request.ts:1450-1517,2622-2627`、Pi `openai-completions.js:866-1000`、opencodex `parser.ts:245-269`、`messages.ts:133-210`。同一下标的两侧内容不同常是**错位**，需对照整条 messages 数组。 |
| `Q-MEDIA` | 图片/文件 content 表示与可解析性差异。Token 只把可信可物化图片送入 Pi，非图片文件有明确降级（`request.ts:1435-1449,1475-1517`）；opencodex 经 `input-media.ts`、`messages.ts:183-210` 转 Chat parts。`image.reference` 双方均 400 且无上游 body，只剩错误格式差异。 |
| `Q-TOOL-HISTORY` | 历史 function_call/result、工具 gap、并行调用及 reasoning 附件由 Token 转成 Pi assistant/toolResult，再经 Pi `transformMessages` 重排/补齐和 Chat tool-call ID 归一化（`request.ts:1323-1353,1760-2010`；Pi `transform-messages.js:150-199`、`openai-completions.js:869-920`）；opencodex 的 parser 与 `messages.ts` 走自己的历史转换。 |
| `Q-TOOL-SCHEMA` | 函数 strict、description、参数 schema、custom grammar 与 namespace 扁平化不同。报告快照中的 Token 将未声明的 function strict 当成 `true` 并转 Pi constrainedSampling；Pi 再生成 strict/schema（当时的 `request.ts:509-656`，Pi `openai-completions.js:1126-1156`）。1.0.5 已改为 Pi `prefer`：可规范化时严格，否则回退非严格；显式 `true` 先验证严格 schema。opencodex 按自己的工具格式和 schema 策略生成，未声明 strict 时不强制写（`openai-chat/tool-schema.ts:430-465`）。 |
| `Q-HOSTED` | opencodex 对工具搜索构造内部 `tool_search` 和目录提示；Token 当前语义转换不实现动态 `tool_search` 生命周期，但此场景保留普通 `lookup`。这不是同名工具一一映射（`request.ts:680-746`；opencodex `parser.ts:490-515`、`messages.ts:133-145`）。 |
| `Q-CHOICE` | Token 只把 Pi 公共选项能表达的 choice 映射；`required`、具名、部分 allowed 模式失去精确语义并告警，`none` 仍可传 Pi；opencodex 保有自己的 options 并在有工具时写相应 Chat choice（`request.ts:2532-2608`、`openai-chat.ts:104-136`）。 |
| `Q-PARALLEL` | Token 消费 `parallel_tool_calls` 但 Pi simple options 无中性等价，省略并告警；opencodex 在有工具时按自己的策略写显式 false（`request.ts:2660-2668`、`openai-chat.ts:223-225`）。 |
| `Q-REASONING` | Token 对客户端 reasoning 做 Pi public level 选择/夹取，Pi adapter 再决定 `reasoning_effort`；opencodex 保留自己的 effort 映射，可直接写 `max`/`none`。`minimal→low`、`max→xhigh`、未知 level 等需看目标模型的 `thinkingLevelMap`/支持级别，不能直接称其中一方错误（Token `request.ts:1084-1135`、Pi `openai-completions.js:617-720`；opencodex `parser.ts:536-545`、`openai-chat.ts:146-187`）。 |
| `Q-REASONING-HISTORY` | 历史 reasoning item 在 Token 入站变成 Pi thinking block，和后续 assistant 内容关联；Pi `transformMessages` 根据历史消息是否来自当前 provider/API/model 决定保留 thinking、转为普通 text 或丢弃 redacted block，再由 Chat adapter 选择原生 reasoning 字段或文本（Token `request.ts:1635-1695`；Pi `transform-messages.js:65-90`、`openai-completions.js:960-1005`）。opencodex 保持自己的 reasoning 附件与回放规则（`parser.ts:261-269`、`openai-chat/messages.ts:224-258`）。`nonreasoning-target` 的 Token `VISIBLE_REASONINGTWO` 正是降成普通 assistant 文本的可观察结果，不是入站 reasoning 被无声删除。 |
| `Q-CONTROL` | `top_p`、stop、penalty、JSON response_format 等在 opencodex 的独立 options/adapter 中有直达序列化；Token 按其 Responses 正向消费者只映射 Pi 中立项（这里主要是 `maxTokens`、temperature/cache/toolChoice），不把未认领控制藏到采样参数或事后修补 Provider body（`request.ts:1000-1081,2647-2668`；opencodex `parser.ts:517-549`、`openai-chat.ts:138-221`）。部分目标控制本就不属于 Pi 当前公共表面；JSON 格式差异不是“Pi 自动丢掉”，而是 Token 此路径未送入对应 options。 |
| `Q-CACHE` | Token `prompt_cache_retention:24h` → Pi `cacheRetention:long`，由 Pi adapter 生成 `prompt_cache_retention:24h` 与从会话 ID 形成的 `prompt_cache_key`；opencodex 此夹具 provider 未开启相同 key 策略。具体 UUID 值是每次运行生成的，不是稳定协议常量（`request.ts:1046-1075,2654-2655`、Pi `openai-completions.js:570-579`；opencodex `openai-chat.ts:195-197`）。 |
| `P-PHASE` | opencodex 在正常结束的 assistant 文本上写 `phase:"final_answer"`；Token 的 Pi text → Responses message 不写 phase（`response-json.ts:553`；`response.ts:534-555`）。若没有文本项（纯工具调用），不会出现此项。 |
| `P-REASONING` | Token 的 Pi thinking 默认呈可见 `summary_text` 并附 `token_continuity` 来源/selector；opencodex 默认隐藏 summary，把原始 reasoning 放 `ocxr1` encrypted_content，或按字段类型走可见/不可见分支（`response.ts:479-530`；`response-json.ts:244-289`；`parser.ts:540-545`）。`reasoning_text` 场景还可能只有 Token 认出 reasoning，导致 output 数组整体错位。 |
| `P-TOOL` | 工具调用 output 的 `arguments`、`status`、类型/顺序由 Pi 的工具块与 Token 响应转换或 opencodex 的工具事件验证/修复而不同；特别是非法 JSON 参数、custom/namespace 回放（`response.ts:557-663`；opencodex `response-json.ts:291-330`、`openai-chat/tool-call-validation.ts:110-187`）。 |
| `P-TERMINAL` | 终止原因映射不同，或上游字节因 `Q-STREAM` 已不同。Token Pi `length→incomplete`、`error→failed`，`content_filter→error` 后常表现 502；opencodex 把 `content_filter`/max token 视为 incomplete（Pi `openai-completions.js:1188-1208`、Token `response.ts:666-703`；opencodex `response-json.ts:533-609`）。必须结合具体案例的夹具交互，不把 status 差异都归咎于渲染。 |
| `P-ERROR` | 入站校验、上游 HTTP、截断及工具参数错误的错误类型/消息/code/param 表达不同。Token 对 Provider `error` 走 Pi/应用错误再成 Responses HTTP error；opencodex 经过自己的 adapter/bridge 错误映射（Token `response.ts:801-820`；opencodex `openai-chat/errors.ts`、`response-json.ts:598-636`）。 |
| `P-USAGE` | 一方没有终端 usage，或不同事件阶段的 usage 快照不同。Token 从 Pi `Usage` 计算 Responses usage（`response.ts:302-400`），Pi 自 Chat usage chunk 解析（Pi `openai-completions.js:1158-1186`）；opencodex bridge 用自己的 `responsesUsage`。夹具常给固定 20/8/4/3，不代表真实计费。 |
| `P-SHAPE` | Token 完成响应显式含 `error:null`、`incomplete_details:null`；opencodex 对正常完成省略两键。两者的 JSON 对象形状不同，不能把缺键当作错误发生（`response.ts:770-798`、`response-json.ts:611-637`）。 |
| `E-DEFAULT` | Token 响应外壳固定回显/填充 `instructions:null`、`metadata:{}`、`parallel_tool_calls:true`、`temperature:null`、`tool_choice`、`tools`、`top_p:null`；opencodex bridge 仅写其简化快照字段，其他无值则省略。`parallel_tool_calls:true` 是 Token 当前**响应渲染默认**，不能据此推断上游 Chat 请求真的传了 true（`response.ts:774-794`；`response-json.ts:611-637`、`sse.ts:331-335`）。 |
| `E-MODEL` | Token 外壳回显客户端 selector `compare/model`，opencodex 写解析后的物理 model ID `model`；Provider 请求本身都用 `model`。这是两侧响应外壳的 model 命名边界，不是模型实际选择不同（`response.ts:783`；`openai-chat.ts:108`；`response-json.ts:615`）。 |
| `E-ERROR` | 一方成功一方 HTTP 错误时，成功方有 id/object/time 外壳，失败方无；失败状态下 `last_error` 等扩展键由各自渲染器决定。跟随 `Q-ADMISSION`/`P-ERROR`/`P-TERMINAL` 的首要原因，不应再解释为独立请求转换。 |
| `E-CONTINUITY` | `previous_response_id` 的回放/存储边界不同；`store:false` 时 opencodex 的本地状态可用性和 Token 的本地状态策略各自独立，且第二步输入由各自前一步输出组装。见 `replayRequest`（`wire.mjs:35-49`）、Token Responses 状态模块、opencodex `responses/state.ts:1235-1271`。 |
| `V-SNAPSHOT` | SSE 首个 response 快照重复外壳差异；Token 先构造完整终端 Response，再复制成 `in_progress` 快照，因此首快照可带完整 usage；opencodex 增量快照的 usage 为 null（Token [`sse.ts:24-45`](../src/protocols/openai-responses/sse.ts)；opencodex `sse.ts:331-335`）。 |
| `V-TOPOLOGY` | Token 采用**原子 SSE**：`response.created` → 每个 output 一条 `response.output_item.done` → 终端事件 → `[DONE]`，不发 added/delta；opencodex 随 AdapterEvent 增量发 `response.in_progress`、added、内容 delta/done 等。数组下标比较会放大一次拓扑差异，`data[n]` 的两个值不一定是同一语义事件（Token [`sse.ts:4-80`](../src/protocols/openai-responses/sse.ts)；opencodex `sse.ts:274-335,850-1245`；夹具 `wire.mjs:52-120`）。 |
| `V-FRAMING` | SSE 帧层面 `event:`、`data:`、`[DONE]` 及帧数不同：Token schema 事件只有 `data:`，opencodex `sseEvent()` 写 `event: ...` 加 `data:`；两方末尾都可有 `[DONE]`，但位置下标因帧数不同而变（Token [`sse.ts:24-80`](../src/protocols/openai-responses/sse.ts)；opencodex `sse.ts:53-54,300-318`）。这些帧不是 Responses output 语义差异。 |

## 关键场景的端到端追踪

1. [`roles.mid-system.json`](../artifacts/protocol-compare/final/cases/roles.mid-system.json/diff.md) 的输入是 user `ONE` → assistant `TWO` → system `MID_INSTRUCTION` → user `THREE`。Token 入站得 Pi user → assistant → **SystemMessage** → user；夹具模型 reasoning=true 且 mid-system/developer 能力为 true，因此 Pi 在 Chat 中写 user → assistant → **developer** → user。opencodex 入站把 `MID_INSTRUCTION` 放入 `systemPrompt`，Chat 中是 **system MID** → user → assistant → user。七项 `messages[i]` 差异出自一次位置/role 决策及用户文字形状，不是七次独立改写；其余两项是 `Q-STREAM`。
2. [`roles.tool-gap-system.json`](../artifacts/protocol-compare/final/cases/roles.tool-gap-system.json/diff.md) 把 system 放在 function_call 和对应 result 之间。Token 请求解析保留 Pi system，但 Pi `transformMessages` 的第二遍在未闭合调用时暂存它，实际 Chat 顺序为 user → assistant tool_calls → tool result → developer MID → user。opencodex 先把 MID 放入 `systemPrompt`（并合并工具目录提示），实际 Chat 是 system → user → assistant tool_calls → tool result → user。这里“保留位置”的注释只适用于 Token 入站 Pi Context 阶段，**不能推论最终 Chat 数组原位置不动**。
3. [`tools.function.json`](../artifacts/protocol-compare/final/cases/tools.function.json/diff.md) 中，Token 把未显式指定 strict 的函数当 strict=true，变成 Pi `constrainedSampling`，Pi 在 Chat function 里写 `strict:true`；opencodex 不替该声明补相同 strict，同时因夹具 provider 不是原生 OpenAI 而在消息最前面增加工具目录 system 提示。两种差异的责任边界不同：前者是工具 schema 策略，后者是 opencodex prompt 策略。
4. [`reasoning.minimal.json`](../artifacts/protocol-compare/final/cases/reasoning.minimal.json/diff.md) 的 `reasoning.effort=minimal` 在 Token/Pi Chat body 为 `minimal`，opencodex 目标映射为 `low`；[`reasoning.max.json`](../artifacts/protocol-compare/final/cases/reasoning.max.json/diff.md) 为 Token/Pi `xhigh`、opencodex `max`。这是两个公开/本地 effort 集合的映射差异；要讨论质量或合法性，还必须指定真实目标模型，不可用人工模型推断。
5. [`response.reasoning.json`](../artifacts/protocol-compare/final/cases/response.reasoning.json/diff.md) 的模拟 Chat reply 带 `reasoning_content=THINKING_CONTENT`。Pi 解析成 thinking block，Token Responses output 写可见 `summary_text`，并在 `token_continuity` 附原 Provider/API/model 和 reasoning 字段 selector；opencodex 的当前策略默认隐藏可见 summary，以 `ocxr1` `encrypted_content` 承载回放文字。后续 `phase`、`error:null`/缺键、外壳 model 又是各自渲染规则，不能算作 reasoning 内容丢失。
6. [`response.filter.json`](../artifacts/protocol-compare/final/cases/response.filter.json/diff.md) 中 Token 最终 HTTP 502，opencodex 返回 200 + `status:"incomplete"`、`incomplete_details.reason:"content_filter"`。Pi 将 Chat `content_filter` 映射为内部 error，而 opencodex 当作截断类完成；但本工具因 `Q-STREAM` 会给双方选择不同的模拟上游编码，所以这是本夹具端到端观测，不证明同字节输入下的所有错误路径都如此。[`response.truncated-stream.json`](../artifacts/protocol-compare/final/cases/response.truncated-stream.json/diff.md) 更明显：Token 消费被截断的 SSE，opencodex 的非流式上游消费完整 JSON；不能直接用它判定哪方“错误处理”更好。
7. [`replay.previous.store-false.json`](../artifacts/protocol-compare/final/cases/replay.previous.store-false.json/diff.md) 第二步的 `previous_response_id` 走双方独立本地状态：Token 报“不是已知本地 response”，opencodex 报 continuation state 不可用/损坏，错误码也不同。第二步还依各自第一步 output 构造，所以要把首轮 reasoning/tool-call 表示与状态存储一起分析，不能只比第二步的 request body。

## 场景判读要点

- `text.*`、`image.inline`、`file.inline`：基础差异是 Pi 用户文本 part 数组 vs opencodex 扁平字符串、`Q-STREAM`、完成对象的 `P-SHAPE`/`E-DEFAULT`；图片相同场景可能没有 Provider body 差异。`file.inline` 还要看文件是否能被 Pi 表示。
- `roles.*`：先看完整 messages 顺序。`mid-system` 是 opencodex 的 systemPrompt 前置 vs Token 中途 Pi SystemMessage；`mid-developer` 是 opencodex 保留时间槽位，但此人工非原生目标可写 Chat system；`tool-gap-*` 另有 Pi 工具交换完整性重排；`unsupported-mid-system` 是 Token 模型能力 false 后降级到 user。**不能**只按某个 `messages[2].role` 判断“支持/不支持”。
- `tools.*`：常叠加 opencodex 非 OpenAI 目标注入的工具目录提示、Token/Pi strict 默认和工具历史格式。`tools.custom` 的 Token 400 来自其不接受该夹具的 `format.type:"text"` grammar；opencodex 把 custom 包成 `{input:string}` 的 function。`tools.hosted` 的 `tool_search` 是 opencodex 内部动态发现策略，不能当普通 lookup 参数差异。
- `reasoning.*`：请求级 effort 差异只在一些 level 出现，不能用本报告证明所有 level 相同；`reasoning.history`/`after-call` 还有历史 thinking 与工具调用位置。`nonreasoning-target` 改变 Pi Chat instructionRole，见上面的条件式。
- `controls.*`：`tool_choice`/parallel/sampling/JSON 格式分别对应 `Q-CHOICE`、`Q-PARALLEL`、`Q-CONTROL`；`metadata-cache` 的 key 是运行时派生，不应把 UUID 字面值写成规范；`unconsumed-shape` 是 Token 按需忽略未知形状、opencodex Zod 对所消费的 `top_p` 校验而拒绝。
- `validation.*`：`unknown-item`、`orphan-output`、`bad-arguments`、`bad-limit` 是 Token 默认策略/校验拒绝、opencodex 接受；`bad-input` 双方拒绝但错误格式不同；`unresolved-call` 双方可执行但 Token 的 xrepair 与 opencodex 历史规则不同。
- `response.*`：同一简单成功回复主要是 `P-PHASE`/`P-SHAPE`。reasoning 与工具场景看 `P-REASONING`/`P-TOOL`；`filter`、`truncated-stream`、`invalid-arguments`、HTTP 错误必须先看各侧实际收到的模拟上游格式/错误，属于“夹具交互+解析”而非单纯外壳格式差别。
- `replay.*`：每一步单独看 Provider 请求及终端响应；第 2 步差异可能继承第 1 步的可见 output、opaque continuity 和本地状态。`previous.store-false` 的本地 continuation 错误不能从单步首轮请求推断。
- `generated.*`：32 个种子固定的组合场景不是 32 种新协议规则。逐字段索引将它们映射到上述根因，原始组合见每个 `scenario.json`。

## 历史报告与复查建议

仓库中另有六份比较工具开发期的报告；它们的语料、worker 或比较器版本不全相同，不能与 `final` 的 7,108 条合并当作独立协议证据。特别是 `initial-full` 的普通 `text.string.json` 中 Token 为 502 且 **没有捕获到任何 Chat Provider 请求**，这是夹具/执行路径异常，不能归因为 Chat 协议转换；`verified` 还有两条 `replay.custom` 工具执行错误。本文逐字段覆盖的是 `final/report.json`（182 场景、执行错误 0）。

| 报告 | 场景 | 差异 | 执行错误 | 用途 |
|---|---:|---:|---:|---|
| [`smoke-1`](../artifacts/protocol-compare/smoke-1/report.md) | 2 | 32 | 0 | 早期冒烟，不是完整语料。 |
| [`smoke-2`](../artifacts/protocol-compare/smoke-2/report.md) | 2 | 54 | 0 | 早期冒烟。 |
| [`smoke-tools`](../artifacts/protocol-compare/smoke-tools/report.md) | 2 | 32 | 0 | 工具场景冒烟。 |
| [`smoke-replay`](../artifacts/protocol-compare/smoke-replay/report.md) | 8 | 529 | 0 | 回放场景冒烟。 |
| [`initial-full`](../artifacts/protocol-compare/initial-full/report.md) | 178 | 3,474 | 8 | Token 常未走到 Chat fetch；不适合当真实转换差异。 |
| [`verified`](../artifacts/protocol-compare/verified/report.md) | 182 | 6,978 | 2 | 绝大多数最终路径已出现，但 custom 回放仍有工具错误。 |
| [`final`](../artifacts/protocol-compare/final/report.md) | 182 | 7,108 | 0 | 本文归因基准。 |

复查一条索引时：打开该场景 `diff.md` 看两侧实际值 → `scenario.json` 看输入/模拟回复 → `token.json`、`opencodex.json` 看捕获的完整 Provider 请求与客户端结果 → 对照对应根因的源文件行。尤其先判断该字段是同一语义事件的值不同，还是数组错位。

## 逐字段归因索引

以下内容由 `tools/protocol-compare/explain-report.mjs` 从固定的 `final/report.json` 机械生成。每一行恰好对应报告的一个 `differences[]` 条目；路径采用报告原文，原值见链接。生成器会在出现未分类路径时失败，避免静默漏项。

<!-- GENERATED-CAUSE-INDEX-START -->
覆盖校验：**182 / 182 个场景，7108 / 7108 个差异，未分类 0**。

归因计数：`E-CONTINUITY` 2；`E-DEFAULT` 1176；`E-ERROR` 50；`E-MODEL` 182；`P-ERROR` 60；`P-PHASE` 146；`P-REASONING` 99；`P-SHAPE` 329；`P-TERMINAL` 47；`P-TOOL` 6；`P-USAGE` 17；`Q-ADMISSION` 24；`Q-CACHE` 4；`Q-CHOICE` 16；`Q-CONTROL` 12；`Q-HOSTED` 12；`Q-MEDIA` 2；`Q-MESSAGE` 339；`Q-PARALLEL` 6；`Q-REASONING` 6；`Q-REASONING-HISTORY` 62；`Q-STREAM` 170；`Q-TOOL-HISTORY` 388；`Q-TOOL-SCHEMA` 119；`V-FRAMING` 1223；`V-SNAPSHOT` 947；`V-TOPOLOGY` 1664。

### text.string.json

[原始差异](../artifacts/protocol-compare/final/cases/text.string.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/text.string.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### text.string.sse

[原始差异](../artifacts/protocol-compare/final/cases/text.string.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/text.string.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### text.parts.json

[原始差异](../artifacts/protocol-compare/final/cases/text.parts.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/text.parts.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：1 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### text.parts.sse

[原始差异](../artifacts/protocol-compare/final/cases/text.parts.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/text.parts.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：1 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### text.history.json

[原始差异](../artifacts/protocol-compare/final/cases/text.history.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/text.history.json/scenario.json) · 15 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×2，`Q-STREAM`×2。

场景提示：3 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### text.history.sse

[原始差异](../artifacts/protocol-compare/final/cases/text.history.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/text.history.sse/scenario.json) · 55 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×2，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：3 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### text.instructions.json

[原始差异](../artifacts/protocol-compare/final/cases/text.instructions.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/text.instructions.json/scenario.json) · 20 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×7，`Q-STREAM`×2。

场景提示：3 个输入 item；顶层 instructions

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### text.instructions.sse

[原始差异](../artifacts/protocol-compare/final/cases/text.instructions.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/text.instructions.sse/scenario.json) · 60 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×7，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：3 个输入 item；顶层 instructions

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### roles.mid-system.json

[原始差异](../artifacts/protocol-compare/final/cases/roles.mid-system.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.mid-system.json/scenario.json) · 20 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×7，`Q-STREAM`×2。

场景提示：system 入站被 opencodex 前置；Token 中途 Pi SystemMessage 在本夹具写成 Chat developer。 4 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### roles.mid-system.sse

[原始差异](../artifacts/protocol-compare/final/cases/roles.mid-system.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.mid-system.sse/scenario.json) · 60 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×7，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：system 入站被 opencodex 前置；Token 中途 Pi SystemMessage 在本夹具写成 Chat developer。 4 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### roles.tool-gap-system.json

[原始差异](../artifacts/protocol-compare/final/cases/roles.tool-gap-system.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.tool-gap-system.json/scenario.json) · 27 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1。

场景提示：同时包含 system 前置差异与未闭合工具交换中的 Pi 延迟/修复。 5 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### roles.tool-gap-system.sse

[原始差异](../artifacts/protocol-compare/final/cases/roles.tool-gap-system.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.tool-gap-system.sse/scenario.json) · 67 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：同时包含 system 前置差异与未闭合工具交换中的 Pi 延迟/修复。 5 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### roles.mid-developer.json

[原始差异](../artifacts/protocol-compare/final/cases/roles.mid-developer.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.mid-developer.json/scenario.json) · 16 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2。

场景提示：developer 入站两方都可留在时间线；Token 已丢失 source role，opencodex 保留后按目的地选择 Chat role。 4 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### roles.mid-developer.sse

[原始差异](../artifacts/protocol-compare/final/cases/roles.mid-developer.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.mid-developer.sse/scenario.json) · 56 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：developer 入站两方都可留在时间线；Token 已丢失 source role，opencodex 保留后按目的地选择 Chat role。 4 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### roles.tool-gap-developer.json

[原始差异](../artifacts/protocol-compare/final/cases/roles.tool-gap-developer.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.tool-gap-developer.json/scenario.json) · 29 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2，`Q-TOOL-HISTORY`×15，`Q-TOOL-SCHEMA`×1。

场景提示：同时包含 developer role 边界与未闭合工具交换中的 Pi 延迟/修复。 5 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[5]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### roles.tool-gap-developer.sse

[原始差异](../artifacts/protocol-compare/final/cases/roles.tool-gap-developer.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.tool-gap-developer.sse/scenario.json) · 69 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-TOOL-HISTORY`×15，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：同时包含 developer role 边界与未闭合工具交换中的 Pi 延迟/修复。 5 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[5]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### roles.unsupported-mid-system.json

[原始差异](../artifacts/protocol-compare/final/cases/roles.unsupported-mid-system.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.unsupported-mid-system.json/scenario.json) · 17 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×4，`Q-STREAM`×2。

场景提示：夹具明确禁用 mid-system；Token 把可降级中途指令变成 user，opencodex 仍先抽入 systemPrompt。 3 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### roles.unsupported-mid-system.sse

[原始差异](../artifacts/protocol-compare/final/cases/roles.unsupported-mid-system.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/roles.unsupported-mid-system.sse/scenario.json) · 57 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×4，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：夹具明确禁用 mid-system；Token 把可降级中途指令变成 user，opencodex 仍先抽入 systemPrompt。 3 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### image.inline.json

[原始差异](../artifacts/protocol-compare/final/cases/image.inline.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/image.inline.json/scenario.json) · 13 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2。

场景提示：1 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### image.inline.sse

[原始差异](../artifacts/protocol-compare/final/cases/image.inline.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/image.inline.sse/scenario.json) · 53 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：1 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### image.reference.json

[原始差异](../artifacts/protocol-compare/final/cases/image.reference.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/image.reference.json/scenario.json) · 3 项；`P-ERROR`×3。

场景提示：1 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### image.reference.sse

[原始差异](../artifacts/protocol-compare/final/cases/image.reference.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/image.reference.sse/scenario.json) · 3 项；`P-ERROR`×3。

场景提示：1 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### file.inline.json

[原始差异](../artifacts/protocol-compare/final/cases/file.inline.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/file.inline.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MEDIA`×1，`Q-STREAM`×2。

场景提示：1 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0]` | `Q-MEDIA` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### file.inline.sse

[原始差异](../artifacts/protocol-compare/final/cases/file.inline.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/file.inline.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MEDIA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：1 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0]` | `Q-MEDIA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.function.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.function.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.function.json/scenario.json) · 17 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.function.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.function.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.function.sse/scenario.json) · 57 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.strict.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.strict.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.strict.json/scenario.json) · 16 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.strict.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.strict.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.strict.sse/scenario.json) · 56 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.custom.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.custom.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.custom.json/scenario.json) · 10 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2。

场景提示：Token 不接受该 custom format.type=text；opencodex 可包装成函数并继续。 字符串输入；1 个声明工具；模拟工具调用

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |

</details>

### tools.custom.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.custom.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.custom.sse/scenario.json) · 18 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2，`V-FRAMING`×1，`V-TOPOLOGY`×7。

场景提示：Token 不接受该 custom format.type=text；opencodex 可包装成函数并继续。 字符串输入；1 个声明工具；模拟工具调用

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| events · `$[0].events.data[0]` | `V-TOPOLOGY` |
| events · `$[0].events.data[1]` | `V-TOPOLOGY` |
| events · `$[0].events.data[2]` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.framing` | `V-FRAMING` |

</details>

### tools.grammar.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.grammar.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.grammar.json/scenario.json) · 19 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×3。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.description` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.properties.input.description` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.grammar.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.grammar.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.grammar.sse/scenario.json) · 59 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×3，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.description` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.properties.input.description` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.namespace.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.namespace.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.namespace.json/scenario.json) · 18 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×2。

场景提示：字符串输入；2 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[1].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.namespace.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.namespace.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.namespace.sse/scenario.json) · 58 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×2，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；2 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[1].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.hosted.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.hosted.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.hosted.json/scenario.json) · 23 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-HOSTED`×6，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：opencodex 注入 tool_search 动态发现；Token 的普通 lookup/Pi 工具不是同一列表。 字符串输入；3 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.name` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.description` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.properties.query.description` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.properties.limit` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.additionalProperties` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[1]` | `Q-HOSTED` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.hosted.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.hosted.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.hosted.sse/scenario.json) · 63 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-HOSTED`×6，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：opencodex 注入 tool_search 动态发现；Token 的普通 lookup/Pi 工具不是同一列表。 字符串输入；3 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.name` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.description` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.properties.query.description` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.properties.limit` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.additionalProperties` | `Q-HOSTED` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[1]` | `Q-HOSTED` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.history.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.history.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.history.json/scenario.json) · 27 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.history.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.history.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.history.sse/scenario.json) · 67 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.parallel-history.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.parallel-history.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.parallel-history.json/scenario.json) · 29 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2，`Q-TOOL-HISTORY`×15，`Q-TOOL-SCHEMA`×1。

场景提示：6 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[5]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.parallel-history.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.parallel-history.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.parallel-history.sse/scenario.json) · 69 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-TOOL-HISTORY`×15，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：6 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[5]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.result-empty.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.result-empty.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.result-empty.json/scenario.json) · 27 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.result-empty.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.result-empty.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.result-empty.sse/scenario.json) · 67 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.result-unicode.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.result-unicode.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.result-unicode.json/scenario.json) · 27 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.result-unicode.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.result-unicode.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.result-unicode.sse/scenario.json) · 67 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### tools.result-parts.json

[原始差异](../artifacts/protocol-compare/final/cases/tools.result-parts.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.result-parts.json/scenario.json) · 27 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### tools.result-parts.sse

[原始差异](../artifacts/protocol-compare/final/cases/tools.result-parts.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/tools.result-parts.sse/scenario.json) · 67 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.none.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.none.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.none.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.none.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.none.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.none.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.minimal.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.minimal.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.minimal.json/scenario.json) · 15 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-REASONING`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.reasoning_effort` | `Q-REASONING` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.minimal.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.minimal.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.minimal.sse/scenario.json) · 55 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-REASONING`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.reasoning_effort` | `Q-REASONING` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.low.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.low.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.low.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.low.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.low.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.low.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.medium.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.medium.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.medium.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.medium.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.medium.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.medium.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.high.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.high.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.high.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.high.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.high.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.high.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.xhigh.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.xhigh.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.xhigh.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.xhigh.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.xhigh.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.xhigh.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.max.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.max.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.max.json/scenario.json) · 15 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-REASONING`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.reasoning_effort` | `Q-REASONING` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.max.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.max.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.max.sse/scenario.json) · 55 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-REASONING`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.reasoning_effort` | `Q-REASONING` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.future-level.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.future-level.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.future-level.json/scenario.json) · 15 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-REASONING`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.reasoning_effort` | `Q-REASONING` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.future-level.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.future-level.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.future-level.sse/scenario.json) · 55 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-REASONING`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.reasoning_effort` | `Q-REASONING` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.summary.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.summary.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.summary.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.summary.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.summary.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.summary.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.history.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.history.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.history.json/scenario.json) · 28 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-REASONING-HISTORY`×14，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：5 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].reasoning_content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.history.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.history.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.history.sse/scenario.json) · 68 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-REASONING-HISTORY`×14，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：5 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].reasoning_content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.after-call.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.after-call.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.after-call.json/scenario.json) · 28 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-REASONING-HISTORY`×14，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：5 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].reasoning_content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.after-call.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.after-call.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.after-call.sse/scenario.json) · 68 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-REASONING-HISTORY`×14，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：5 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].reasoning_content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### reasoning.nonreasoning-target.json

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.nonreasoning-target.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.nonreasoning-target.json/scenario.json) · 16 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-REASONING-HISTORY`×3，`Q-STREAM`×2。

场景提示：4 个输入 item；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### reasoning.nonreasoning-target.sse

[原始差异](../artifacts/protocol-compare/final/cases/reasoning.nonreasoning-target.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/reasoning.nonreasoning-target.sse/scenario.json) · 56 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-REASONING-HISTORY`×3，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：4 个输入 item；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-REASONING-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-REASONING-HISTORY` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.tool-choice-auto.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-auto.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-auto.json/scenario.json) · 17 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.tool-choice-auto.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-auto.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-auto.sse/scenario.json) · 57 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.tool-choice-none.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-none.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-none.json/scenario.json) · 16 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools` | `Q-CHOICE` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.tool-choice-none.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-none.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-none.sse/scenario.json) · 56 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools` | `Q-CHOICE` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.tool-choice-required.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-required.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-required.json/scenario.json) · 18 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.tool-choice-required.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-required.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-required.sse/scenario.json) · 58 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.tool-choice-named.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-named.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-named.json/scenario.json) · 18 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.tool-choice-named.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-named.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-named.sse/scenario.json) · 58 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.tool-choice-allowed.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-allowed.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-allowed.json/scenario.json) · 17 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.tool-choice-allowed.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.tool-choice-allowed.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.tool-choice-allowed.sse/scenario.json) · 57 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具；tool_choice

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.parallel-true.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.parallel-true.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.parallel-true.json/scenario.json) · 17 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.parallel-true.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.parallel-true.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.parallel-true.sse/scenario.json) · 57 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.parallel-false.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.parallel-false.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.parallel-false.json/scenario.json) · 18 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-PARALLEL`×1，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.parallel_tool_calls` | `Q-PARALLEL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.parallel-false.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.parallel-false.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.parallel-false.sse/scenario.json) · 58 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-PARALLEL`×1，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.parallel_tool_calls` | `Q-PARALLEL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.sampling.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.sampling.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.sampling.json/scenario.json) · 18 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CONTROL`×4，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.top_p` | `Q-CONTROL` |
| request · `$[0].providerRequests[0].body.stop` | `Q-CONTROL` |
| request · `$[0].providerRequests[0].body.presence_penalty` | `Q-CONTROL` |
| request · `$[0].providerRequests[0].body.frequency_penalty` | `Q-CONTROL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.sampling.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.sampling.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.sampling.sse/scenario.json) · 58 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CONTROL`×4，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.top_p` | `Q-CONTROL` |
| request · `$[0].providerRequests[0].body.stop` | `Q-CONTROL` |
| request · `$[0].providerRequests[0].body.presence_penalty` | `Q-CONTROL` |
| request · `$[0].providerRequests[0].body.frequency_penalty` | `Q-CONTROL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.max-one.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.max-one.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.max-one.json/scenario.json) · 14 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.max-one.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.max-one.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.max-one.sse/scenario.json) · 54 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.json-schema.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.json-schema.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.json-schema.json/scenario.json) · 15 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CONTROL`×1，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.response_format` | `Q-CONTROL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.json-schema.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.json-schema.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.json-schema.sse/scenario.json) · 53 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CONTROL`×1，`Q-MESSAGE`×1，`V-FRAMING`×13，`V-SNAPSHOT`×11，`V-TOPOLOGY`×16。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.response_format` | `Q-CONTROL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |

</details>

### controls.json-object.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.json-object.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.json-object.json/scenario.json) · 15 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CONTROL`×1，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.response_format` | `Q-CONTROL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.json-object.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.json-object.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.json-object.sse/scenario.json) · 55 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CONTROL`×1，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.response_format` | `Q-CONTROL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.metadata-cache.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.metadata-cache.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.metadata-cache.json/scenario.json) · 16 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CACHE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.prompt_cache_key` | `Q-CACHE` |
| request · `$[0].providerRequests[0].body.prompt_cache_retention` | `Q-CACHE` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.metadata-cache.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.metadata-cache.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.metadata-cache.sse/scenario.json) · 56 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CACHE`×2，`Q-MESSAGE`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.prompt_cache_key` | `Q-CACHE` |
| request · `$[0].providerRequests[0].body.prompt_cache_retention` | `Q-CACHE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### controls.unconsumed-shape.json

[原始差异](../artifacts/protocol-compare/final/cases/controls.unconsumed-shape.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.unconsumed-shape.json/scenario.json) · 18 项；`E-DEFAULT`×7，`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-SHAPE`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2。

场景提示：Token 未消费 top_p 形状；opencodex 入站 schema 校验该字段并拒绝。 字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### controls.unconsumed-shape.sse

[原始差异](../artifacts/protocol-compare/final/cases/controls.unconsumed-shape.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/controls.unconsumed-shape.sse/scenario.json) · 22 项；`E-DEFAULT`×7，`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-SHAPE`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2，`V-FRAMING`×1，`V-TOPOLOGY`×3。

场景提示：Token 未消费 top_p 形状；opencodex 入站 schema 校验该字段并拒绝。 字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0]` | `V-TOPOLOGY` |
| events · `$[0].events.data[1]` | `V-TOPOLOGY` |
| events · `$[0].events.data[2]` | `V-TOPOLOGY` |
| events · `$[0].events.framing` | `V-FRAMING` |

</details>

### validation.unknown-item.json

[原始差异](../artifacts/protocol-compare/final/cases/validation.unknown-item.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.unknown-item.json/scenario.json) · 10 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2。

场景提示：2 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |

</details>

### validation.unknown-item.sse

[原始差异](../artifacts/protocol-compare/final/cases/validation.unknown-item.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.unknown-item.sse/scenario.json) · 23 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2，`V-FRAMING`×1，`V-TOPOLOGY`×12。

场景提示：2 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| events · `$[0].events.data[0]` | `V-TOPOLOGY` |
| events · `$[0].events.data[1]` | `V-TOPOLOGY` |
| events · `$[0].events.data[2]` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing` | `V-FRAMING` |

</details>

### validation.orphan-output.json

[原始差异](../artifacts/protocol-compare/final/cases/validation.orphan-output.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.orphan-output.json/scenario.json) · 10 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2。

场景提示：2 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |

</details>

### validation.orphan-output.sse

[原始差异](../artifacts/protocol-compare/final/cases/validation.orphan-output.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.orphan-output.sse/scenario.json) · 23 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2，`V-FRAMING`×1，`V-TOPOLOGY`×12。

场景提示：2 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| events · `$[0].events.data[0]` | `V-TOPOLOGY` |
| events · `$[0].events.data[1]` | `V-TOPOLOGY` |
| events · `$[0].events.data[2]` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing` | `V-FRAMING` |

</details>

### validation.unresolved-call.json

[原始差异](../artifacts/protocol-compare/final/cases/validation.unresolved-call.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.unresolved-call.json/scenario.json) · 27 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1。

场景提示：Token 默认 xrepair 未解析工具调用；opencodex 使用自己的工具历史规则。 3 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### validation.unresolved-call.sse

[原始差异](../artifacts/protocol-compare/final/cases/validation.unresolved-call.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.unresolved-call.sse/scenario.json) · 67 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-TOOL-HISTORY`×13，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：Token 默认 xrepair 未解析工具调用；opencodex 使用自己的工具历史规则。 3 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### validation.bad-arguments.json

[原始差异](../artifacts/protocol-compare/final/cases/validation.bad-arguments.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.bad-arguments.json/scenario.json) · 10 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |

</details>

### validation.bad-arguments.sse

[原始差异](../artifacts/protocol-compare/final/cases/validation.bad-arguments.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.bad-arguments.sse/scenario.json) · 23 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2，`V-FRAMING`×1，`V-TOPOLOGY`×12。

场景提示：4 个输入 item；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| events · `$[0].events.data[0]` | `V-TOPOLOGY` |
| events · `$[0].events.data[1]` | `V-TOPOLOGY` |
| events · `$[0].events.data[2]` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing` | `V-FRAMING` |

</details>

### validation.empty-input.json

[原始差异](../artifacts/protocol-compare/final/cases/validation.empty-input.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.empty-input.json/scenario.json) · 13 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-STREAM`×2。

场景提示：0 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### validation.empty-input.sse

[原始差异](../artifacts/protocol-compare/final/cases/validation.empty-input.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.empty-input.sse/scenario.json) · 53 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`V-FRAMING`×14，`V-SNAPSHOT`×11，`V-TOPOLOGY`×17。

场景提示：0 个输入 item

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |

</details>

### validation.bad-input.json

[原始差异](../artifacts/protocol-compare/final/cases/validation.bad-input.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.bad-input.json/scenario.json) · 3 项；`P-ERROR`×3。

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### validation.bad-input.sse

[原始差异](../artifacts/protocol-compare/final/cases/validation.bad-input.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.bad-input.sse/scenario.json) · 3 项；`P-ERROR`×3。

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### validation.bad-limit.json

[原始差异](../artifacts/protocol-compare/final/cases/validation.bad-limit.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.bad-limit.json/scenario.json) · 10 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |

</details>

### validation.bad-limit.sse

[原始差异](../artifacts/protocol-compare/final/cases/validation.bad-limit.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/validation.bad-limit.sse/scenario.json) · 23 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-USAGE`×1，`Q-ADMISSION`×2，`V-FRAMING`×1，`V-TOPOLOGY`×12。

场景提示：字符串输入

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0]` | `Q-ADMISSION` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `Q-ADMISSION` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| events · `$[0].events.data[0]` | `V-TOPOLOGY` |
| events · `$[0].events.data[1]` | `V-TOPOLOGY` |
| events · `$[0].events.data[2]` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.framing` | `V-FRAMING` |

</details>

### response.unicode-fragments.json

[原始差异](../artifacts/protocol-compare/final/cases/response.unicode-fragments.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.unicode-fragments.json/scenario.json) · 17 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### response.unicode-fragments.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.unicode-fragments.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.unicode-fragments.sse/scenario.json) · 81 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×26，`V-SNAPSHOT`×11，`V-TOPOLOGY`×29。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.data[14]` | `V-TOPOLOGY` |
| events · `$[0].events.data[15]` | `V-TOPOLOGY` |
| events · `$[0].events.data[16]` | `V-TOPOLOGY` |
| events · `$[0].events.data[17]` | `V-TOPOLOGY` |
| events · `$[0].events.data[18]` | `V-TOPOLOGY` |
| events · `$[0].events.data[19]` | `V-TOPOLOGY` |
| events · `$[0].events.data[20]` | `V-TOPOLOGY` |
| events · `$[0].events.data[21]` | `V-TOPOLOGY` |
| events · `$[0].events.data[22]` | `V-TOPOLOGY` |
| events · `$[0].events.data[23]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |
| events · `$[0].events.framing[15]` | `V-FRAMING` |
| events · `$[0].events.framing[16]` | `V-FRAMING` |
| events · `$[0].events.framing[17]` | `V-FRAMING` |
| events · `$[0].events.framing[18]` | `V-FRAMING` |
| events · `$[0].events.framing[19]` | `V-FRAMING` |
| events · `$[0].events.framing[20]` | `V-FRAMING` |
| events · `$[0].events.framing[21]` | `V-FRAMING` |
| events · `$[0].events.framing[22]` | `V-FRAMING` |
| events · `$[0].events.framing[23]` | `V-FRAMING` |
| events · `$[0].events.framing[24]` | `V-FRAMING` |

</details>

### response.reasoning.json

[原始差异](../artifacts/protocol-compare/final/cases/response.reasoning.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.reasoning.json/scenario.json) · 20 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### response.reasoning.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.reasoning.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.reasoning.sse/scenario.json) · 66 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×13，`V-SNAPSHOT`×11，`V-TOPOLOGY`×24。

场景提示：字符串输入；1 个声明工具；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.role` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |

</details>

### response.reasoning-field.json

[原始差异](../artifacts/protocol-compare/final/cases/response.reasoning-field.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.reasoning-field.json/scenario.json) · 20 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### response.reasoning-field.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.reasoning-field.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.reasoning-field.sse/scenario.json) · 66 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×13，`V-SNAPSHOT`×11，`V-TOPOLOGY`×24。

场景提示：字符串输入；1 个声明工具；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.role` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |

</details>

### response.reasoning-text-field.json

[原始差异](../artifacts/protocol-compare/final/cases/response.reasoning-text-field.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.reasoning-text-field.json/scenario.json) · 24 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×6，`P-SHAPE`×2，`P-TOOL`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].type` | `P-REASONING` |
| response · `$[0].terminal.output[0].summary` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].role` | `P-REASONING` |
| response · `$[0].terminal.output[0].status` | `P-TOOL` |
| response · `$[0].terminal.output[0].content` | `P-REASONING` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.output[1]` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### response.reasoning-text-field.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.reasoning-text-field.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.reasoning-text-field.sse/scenario.json) · 64 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×6，`P-SHAPE`×2，`P-TOOL`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×20。

场景提示：字符串输入；1 个声明工具；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].type` | `P-REASONING` |
| response · `$[0].terminal.output[0].summary` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].status` | `P-TOOL` |
| response · `$[0].terminal.output[0].role` | `P-REASONING` |
| response · `$[0].terminal.output[0].content` | `P-REASONING` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.output[1]` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content[0]` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item_id` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].content_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].part` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |

</details>

### response.tool.json

[原始差异](../artifacts/protocol-compare/final/cases/response.tool.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.tool.json/scenario.json) · 16 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；模拟工具调用

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### response.tool.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.tool.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.tool.sse/scenario.json) · 46 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×9，`V-SNAPSHOT`×11，`V-TOPOLOGY`×12。

场景提示：字符串输入；1 个声明工具；模拟工具调用

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |

</details>

### response.parallel-tools.json

[原始差异](../artifacts/protocol-compare/final/cases/response.parallel-tools.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.parallel-tools.json/scenario.json) · 16 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；模拟工具调用

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### response.parallel-tools.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.parallel-tools.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.parallel-tools.sse/scenario.json) · 60 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×13，`V-SNAPSHOT`×11，`V-TOPOLOGY`×22。

场景提示：字符串输入；1 个声明工具；模拟工具调用

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.call_id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.arguments` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item_id` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].delta` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |

</details>

### response.length.json

[原始差异](../artifacts/protocol-compare/final/cases/response.length.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.length.json/scenario.json) · 15 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-SHAPE`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### response.length.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.length.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.length.sse/scenario.json) · 51 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-SHAPE`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×12，`V-SNAPSHOT`×11，`V-TOPOLOGY`×15。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |

</details>

### response.filter.json

[原始差异](../artifacts/protocol-compare/final/cases/response.filter.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.filter.json/scenario.json) · 16 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×4，`P-USAGE`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：先检查双方实际模拟上游格式；content_filter 在 Pi 与 opencodex 的终止映射不同。 字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `P-TERMINAL` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| response · `$[0].terminal.incomplete_details` | `P-TERMINAL` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |

</details>

### response.filter.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.filter.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.filter.sse/scenario.json) · 18 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×4，`P-USAGE`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×1，`V-TOPOLOGY`×3。

场景提示：先检查双方实际模拟上游格式；content_filter 在 Pi 与 opencodex 的终止映射不同。 字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `P-TERMINAL` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| response · `$[0].terminal.incomplete_details` | `P-TERMINAL` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| events · `$[0].events.data[0]` | `V-TOPOLOGY` |
| events · `$[0].events.data[1]` | `V-TOPOLOGY` |
| events · `$[0].events.data[2]` | `V-TOPOLOGY` |
| events · `$[0].events.framing` | `V-FRAMING` |

</details>

### response.zero-usage.json

[原始差异](../artifacts/protocol-compare/final/cases/response.zero-usage.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.zero-usage.json/scenario.json) · 17 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### response.zero-usage.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.zero-usage.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.zero-usage.sse/scenario.json) · 51 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×14。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |

</details>

### response.truncated-stream.json

[原始差异](../artifacts/protocol-compare/final/cases/response.truncated-stream.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.truncated-stream.json/scenario.json) · 15 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×3，`P-USAGE`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：夹具按双方上游 stream 选不同模拟字节；不可当同字节解析器对比。 字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `P-TERMINAL` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |

</details>

### response.truncated-stream.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.truncated-stream.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.truncated-stream.sse/scenario.json) · 24 项；`E-ERROR`×3，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×3，`P-USAGE`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×1，`V-TOPOLOGY`×10。

场景提示：夹具按双方上游 stream 选不同模拟字节；不可当同字节解析器对比。 字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.output` | `P-TERMINAL` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| envelope · `$[0].envelope.id` | `E-ERROR` |
| envelope · `$[0].envelope.object` | `E-ERROR` |
| envelope · `$[0].envelope.created_at` | `E-ERROR` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| events · `$[0].events.data[0]` | `V-TOPOLOGY` |
| events · `$[0].events.data[1]` | `V-TOPOLOGY` |
| events · `$[0].events.data[2]` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.framing` | `V-FRAMING` |

</details>

### response.invalid-arguments.json

[原始差异](../artifacts/protocol-compare/final/cases/response.invalid-arguments.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.invalid-arguments.json/scenario.json) · 20 项；`E-DEFAULT`×7，`E-ERROR`×1，`E-MODEL`×1，`P-ERROR`×1，`P-TERMINAL`×2，`P-TOOL`×2，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：非法工具参数经过 Pi/Token 与 opencodex 各自验证/修复；夹具上游格式也可能不同。 字符串输入；1 个声明工具；模拟工具调用

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].arguments` | `P-TOOL` |
| response · `$[0].terminal.output[0].status` | `P-TOOL` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.error` | `P-ERROR` |
| response · `$[0].terminal.incomplete_details` | `P-TERMINAL` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| envelope · `$[0].envelope.last_error` | `E-ERROR` |

</details>

### response.invalid-arguments.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.invalid-arguments.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.invalid-arguments.sse/scenario.json) · 49 项；`E-DEFAULT`×7，`E-ERROR`×1，`E-MODEL`×1，`P-ERROR`×1，`P-SHAPE`×1，`P-TERMINAL`×1，`P-TOOL`×2，`P-USAGE`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×8，`V-SNAPSHOT`×11，`V-TOPOLOGY`×11。

场景提示：非法工具参数经过 Pi/Token 与 opencodex 各自验证/修复；夹具上游格式也可能不同。 字符串输入；1 个声明工具；模拟工具调用

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].arguments` | `P-TOOL` |
| response · `$[0].terminal.output[0].status` | `P-TOOL` |
| response · `$[0].terminal.status` | `P-TERMINAL` |
| response · `$[0].terminal.usage` | `P-USAGE` |
| response · `$[0].terminal.error` | `P-ERROR` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| envelope · `$[0].envelope.last_error` | `E-ERROR` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |

</details>

### response.http-400.json

[原始差异](../artifacts/protocol-compare/final/cases/response.http-400.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.http-400.json/scenario.json) · 11 项；`P-ERROR`×4，`P-TERMINAL`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.type` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### response.http-400.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.http-400.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.http-400.sse/scenario.json) · 9 项；`P-ERROR`×4，`P-TERMINAL`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.type` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### response.http-429.json

[原始差异](../artifacts/protocol-compare/final/cases/response.http-429.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.http-429.json/scenario.json) · 11 项；`P-ERROR`×4，`P-TERMINAL`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.type` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### response.http-429.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.http-429.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.http-429.sse/scenario.json) · 9 项；`P-ERROR`×4，`P-TERMINAL`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.type` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### response.http-500.json

[原始差异](../artifacts/protocol-compare/final/cases/response.http-500.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.http-500.json/scenario.json) · 11 项；`P-ERROR`×4，`P-TERMINAL`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.type` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### response.http-500.sse

[原始差异](../artifacts/protocol-compare/final/cases/response.http-500.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/response.http-500.sse/scenario.json) · 9 项；`P-ERROR`×4，`P-TERMINAL`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].status` | `P-TERMINAL` |
| response · `$[0].terminal.error.message` | `P-ERROR` |
| response · `$[0].terminal.error.type` | `P-ERROR` |
| response · `$[0].terminal.error.code` | `P-ERROR` |
| response · `$[0].terminal.error.param` | `P-ERROR` |

</details>

### replay.history.store-true.sse

[原始差异](../artifacts/protocol-compare/final/cases/replay.history.store-true.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.history.store-true.sse/scenario.json) · 126 项；`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×4，`Q-TOOL-HISTORY`×17，`Q-TOOL-SCHEMA`×2，`V-FRAMING`×23，`V-SNAPSHOT`×22，`V-TOPOLOGY`×38。

场景提示：字符串输入；1 个声明工具；模拟 reasoning；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.call_id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.name` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.arguments` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].reasoning_content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |
| events · `$[1].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[1].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[3]` | `V-TOPOLOGY` |
| events · `$[1].events.data[4]` | `V-TOPOLOGY` |
| events · `$[1].events.data[5]` | `V-TOPOLOGY` |
| events · `$[1].events.data[6]` | `V-TOPOLOGY` |
| events · `$[1].events.data[7]` | `V-TOPOLOGY` |
| events · `$[1].events.data[8]` | `V-TOPOLOGY` |
| events · `$[1].events.data[9]` | `V-TOPOLOGY` |
| events · `$[1].events.framing[0].event` | `V-FRAMING` |
| events · `$[1].events.framing[1].event` | `V-FRAMING` |
| events · `$[1].events.framing[2].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].done` | `V-FRAMING` |
| events · `$[1].events.framing[4]` | `V-FRAMING` |
| events · `$[1].events.framing[5]` | `V-FRAMING` |
| events · `$[1].events.framing[6]` | `V-FRAMING` |
| events · `$[1].events.framing[7]` | `V-FRAMING` |
| events · `$[1].events.framing[8]` | `V-FRAMING` |
| events · `$[1].events.framing[9]` | `V-FRAMING` |
| events · `$[1].events.framing[10]` | `V-FRAMING` |

</details>

### replay.history.store-true.json

[原始差异](../artifacts/protocol-compare/final/cases/replay.history.store-true.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.history.store-true.json/scenario.json) · 47 项；`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×4，`Q-STREAM`×4，`Q-TOOL-HISTORY`×17，`Q-TOOL-SCHEMA`×2。

场景提示：字符串输入；1 个声明工具；模拟 reasoning；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].reasoning_content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |

</details>

### replay.history.store-false.sse

[原始差异](../artifacts/protocol-compare/final/cases/replay.history.store-false.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.history.store-false.sse/scenario.json) · 126 项；`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×4，`Q-TOOL-HISTORY`×17，`Q-TOOL-SCHEMA`×2，`V-FRAMING`×23，`V-SNAPSHOT`×22，`V-TOPOLOGY`×38。

场景提示：字符串输入；1 个声明工具；模拟 reasoning；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.call_id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.name` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.arguments` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].reasoning_content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |
| events · `$[1].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[1].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[3]` | `V-TOPOLOGY` |
| events · `$[1].events.data[4]` | `V-TOPOLOGY` |
| events · `$[1].events.data[5]` | `V-TOPOLOGY` |
| events · `$[1].events.data[6]` | `V-TOPOLOGY` |
| events · `$[1].events.data[7]` | `V-TOPOLOGY` |
| events · `$[1].events.data[8]` | `V-TOPOLOGY` |
| events · `$[1].events.data[9]` | `V-TOPOLOGY` |
| events · `$[1].events.framing[0].event` | `V-FRAMING` |
| events · `$[1].events.framing[1].event` | `V-FRAMING` |
| events · `$[1].events.framing[2].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].done` | `V-FRAMING` |
| events · `$[1].events.framing[4]` | `V-FRAMING` |
| events · `$[1].events.framing[5]` | `V-FRAMING` |
| events · `$[1].events.framing[6]` | `V-FRAMING` |
| events · `$[1].events.framing[7]` | `V-FRAMING` |
| events · `$[1].events.framing[8]` | `V-FRAMING` |
| events · `$[1].events.framing[9]` | `V-FRAMING` |
| events · `$[1].events.framing[10]` | `V-FRAMING` |

</details>

### replay.history.store-false.json

[原始差异](../artifacts/protocol-compare/final/cases/replay.history.store-false.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.history.store-false.json/scenario.json) · 47 项；`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×4，`Q-STREAM`×4，`Q-TOOL-HISTORY`×17，`Q-TOOL-SCHEMA`×2。

场景提示：字符串输入；1 个声明工具；模拟 reasoning；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].reasoning_content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |

</details>

### replay.previous.store-true.sse

[原始差异](../artifacts/protocol-compare/final/cases/replay.previous.store-true.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.previous.store-true.sse/scenario.json) · 128 项；`E-CONTINUITY`×1，`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×4，`Q-TOOL-HISTORY`×17，`Q-TOOL-SCHEMA`×2，`V-FRAMING`×23，`V-SNAPSHOT`×23，`V-TOPOLOGY`×38。

场景提示：字符串输入；1 个声明工具；模拟 reasoning；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.call_id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.name` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.arguments` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].reasoning_content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |
| envelope · `$[1].envelope.previous_response_id` | `E-CONTINUITY` |
| events · `$[1].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.previous_response_id` | `V-SNAPSHOT` |
| events · `$[1].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[3]` | `V-TOPOLOGY` |
| events · `$[1].events.data[4]` | `V-TOPOLOGY` |
| events · `$[1].events.data[5]` | `V-TOPOLOGY` |
| events · `$[1].events.data[6]` | `V-TOPOLOGY` |
| events · `$[1].events.data[7]` | `V-TOPOLOGY` |
| events · `$[1].events.data[8]` | `V-TOPOLOGY` |
| events · `$[1].events.data[9]` | `V-TOPOLOGY` |
| events · `$[1].events.framing[0].event` | `V-FRAMING` |
| events · `$[1].events.framing[1].event` | `V-FRAMING` |
| events · `$[1].events.framing[2].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].done` | `V-FRAMING` |
| events · `$[1].events.framing[4]` | `V-FRAMING` |
| events · `$[1].events.framing[5]` | `V-FRAMING` |
| events · `$[1].events.framing[6]` | `V-FRAMING` |
| events · `$[1].events.framing[7]` | `V-FRAMING` |
| events · `$[1].events.framing[8]` | `V-FRAMING` |
| events · `$[1].events.framing[9]` | `V-FRAMING` |
| events · `$[1].events.framing[10]` | `V-FRAMING` |

</details>

### replay.previous.store-true.json

[原始差异](../artifacts/protocol-compare/final/cases/replay.previous.store-true.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.previous.store-true.json/scenario.json) · 48 项；`E-CONTINUITY`×1，`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×4，`Q-STREAM`×4，`Q-TOOL-HISTORY`×17，`Q-TOOL-SCHEMA`×2。

场景提示：字符串输入；1 个声明工具；模拟 reasoning；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].reasoning_content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |
| envelope · `$[1].envelope.previous_response_id` | `E-CONTINUITY` |

</details>

### replay.previous.store-false.sse

[原始差异](../artifacts/protocol-compare/final/cases/replay.previous.store-false.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.previous.store-false.sse/scenario.json) · 65 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-ERROR`×3，`P-REASONING`×3，`P-SHAPE`×2，`Q-TOOL-HISTORY`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×23。

场景提示：第二步继续状态分别从各自首轮结果/本地状态构造；重点看 previous_response_id 是否可用。 字符串输入；1 个声明工具；模拟 reasoning；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.call_id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.name` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.arguments` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| response · `$[1].terminal.error.message` | `P-ERROR` |
| response · `$[1].terminal.error.code` | `P-ERROR` |
| response · `$[1].terminal.error.param` | `P-ERROR` |

</details>

### replay.previous.store-false.json

[原始差异](../artifacts/protocol-compare/final/cases/replay.previous.store-false.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.previous.store-false.json/scenario.json) · 22 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-ERROR`×3，`P-REASONING`×3，`P-SHAPE`×2，`Q-STREAM`×2，`Q-TOOL-HISTORY`×3，`Q-TOOL-SCHEMA`×1。

场景提示：第二步继续状态分别从各自首轮结果/本地状态构造；重点看 previous_response_id 是否可用。 字符串输入；1 个声明工具；模拟 reasoning；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| response · `$[1].terminal.error.message` | `P-ERROR` |
| response · `$[1].terminal.error.code` | `P-ERROR` |
| response · `$[1].terminal.error.param` | `P-ERROR` |

</details>

### replay.namespace.sse

[原始差异](../artifacts/protocol-compare/final/cases/replay.namespace.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.namespace.sse/scenario.json) · 109 项；`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-SHAPE`×4，`Q-TOOL-HISTORY`×16，`Q-TOOL-SCHEMA`×2，`V-FRAMING`×21，`V-SNAPSHOT`×22，`V-TOPOLOGY`×27。

场景提示：字符串输入；1 个声明工具；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |
| events · `$[1].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[1].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[3]` | `V-TOPOLOGY` |
| events · `$[1].events.data[4]` | `V-TOPOLOGY` |
| events · `$[1].events.data[5]` | `V-TOPOLOGY` |
| events · `$[1].events.data[6]` | `V-TOPOLOGY` |
| events · `$[1].events.data[7]` | `V-TOPOLOGY` |
| events · `$[1].events.data[8]` | `V-TOPOLOGY` |
| events · `$[1].events.data[9]` | `V-TOPOLOGY` |
| events · `$[1].events.framing[0].event` | `V-FRAMING` |
| events · `$[1].events.framing[1].event` | `V-FRAMING` |
| events · `$[1].events.framing[2].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].done` | `V-FRAMING` |
| events · `$[1].events.framing[4]` | `V-FRAMING` |
| events · `$[1].events.framing[5]` | `V-FRAMING` |
| events · `$[1].events.framing[6]` | `V-FRAMING` |
| events · `$[1].events.framing[7]` | `V-FRAMING` |
| events · `$[1].events.framing[8]` | `V-FRAMING` |
| events · `$[1].events.framing[9]` | `V-FRAMING` |
| events · `$[1].events.framing[10]` | `V-FRAMING` |

</details>

### replay.namespace.json

[原始差异](../artifacts/protocol-compare/final/cases/replay.namespace.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.namespace.json/scenario.json) · 43 项；`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-SHAPE`×4，`Q-STREAM`×4，`Q-TOOL-HISTORY`×16，`Q-TOOL-SCHEMA`×2。

场景提示：字符串输入；1 个声明工具；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |

</details>

### replay.custom.sse

[原始差异](../artifacts/protocol-compare/final/cases/replay.custom.sse/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.custom.sse/scenario.json) · 113 项；`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-SHAPE`×4，`Q-TOOL-HISTORY`×16，`Q-TOOL-SCHEMA`×6，`V-FRAMING`×21，`V-SNAPSHOT`×22，`V-TOPOLOGY`×27。

场景提示：字符串输入；1 个声明工具；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.tools[0].function.description` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.properties.input.description` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.tools[0].function.description` | `Q-TOOL-SCHEMA` |
| request · `$[1].providerRequests[0].body.tools[0].function.parameters.properties.input.description` | `Q-TOOL-SCHEMA` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |
| events · `$[1].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[1].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[1].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[1].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[1].events.data[3]` | `V-TOPOLOGY` |
| events · `$[1].events.data[4]` | `V-TOPOLOGY` |
| events · `$[1].events.data[5]` | `V-TOPOLOGY` |
| events · `$[1].events.data[6]` | `V-TOPOLOGY` |
| events · `$[1].events.data[7]` | `V-TOPOLOGY` |
| events · `$[1].events.data[8]` | `V-TOPOLOGY` |
| events · `$[1].events.data[9]` | `V-TOPOLOGY` |
| events · `$[1].events.framing[0].event` | `V-FRAMING` |
| events · `$[1].events.framing[1].event` | `V-FRAMING` |
| events · `$[1].events.framing[2].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].event` | `V-FRAMING` |
| events · `$[1].events.framing[3].done` | `V-FRAMING` |
| events · `$[1].events.framing[4]` | `V-FRAMING` |
| events · `$[1].events.framing[5]` | `V-FRAMING` |
| events · `$[1].events.framing[6]` | `V-FRAMING` |
| events · `$[1].events.framing[7]` | `V-FRAMING` |
| events · `$[1].events.framing[8]` | `V-FRAMING` |
| events · `$[1].events.framing[9]` | `V-FRAMING` |
| events · `$[1].events.framing[10]` | `V-FRAMING` |

</details>

### replay.custom.json

[原始差异](../artifacts/protocol-compare/final/cases/replay.custom.json/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/replay.custom.json/scenario.json) · 47 项；`E-DEFAULT`×14，`E-MODEL`×2，`P-PHASE`×1，`P-SHAPE`×4，`Q-STREAM`×4，`Q-TOOL-HISTORY`×16，`Q-TOOL-SCHEMA`×6。

场景提示：字符串输入；1 个声明工具；模拟工具调用；2 步回放

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-TOOL-HISTORY` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.description` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[0].function.parameters.properties.input.description` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| request · `$[1].providerRequests[0].body.messages[0].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[0].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[1].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[2].tool_calls` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].role` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].content` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[3].tool_call_id` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.messages[4]` | `Q-TOOL-HISTORY` |
| request · `$[1].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[1].providerRequests[0].body.tools[0].function.description` | `Q-TOOL-SCHEMA` |
| request · `$[1].providerRequests[0].body.tools[0].function.parameters.properties.input.description` | `Q-TOOL-SCHEMA` |
| request · `$[1].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[1].terminal.output[0].phase` | `P-PHASE` |
| response · `$[1].terminal.error` | `P-SHAPE` |
| response · `$[1].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[1].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[1].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[1].envelope.model` | `E-MODEL` |
| envelope · `$[1].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[1].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[1].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[1].envelope.tools` | `E-DEFAULT` |
| envelope · `$[1].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0000

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0000/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0000/scenario.json) · 98 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×7，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×27，`V-SNAPSHOT`×11，`V-TOPOLOGY`×38。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.role` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.data[14]` | `V-TOPOLOGY` |
| events · `$[0].events.data[15]` | `V-TOPOLOGY` |
| events · `$[0].events.data[16]` | `V-TOPOLOGY` |
| events · `$[0].events.data[17]` | `V-TOPOLOGY` |
| events · `$[0].events.data[18]` | `V-TOPOLOGY` |
| events · `$[0].events.data[19]` | `V-TOPOLOGY` |
| events · `$[0].events.data[20]` | `V-TOPOLOGY` |
| events · `$[0].events.data[21]` | `V-TOPOLOGY` |
| events · `$[0].events.data[22]` | `V-TOPOLOGY` |
| events · `$[0].events.data[23]` | `V-TOPOLOGY` |
| events · `$[0].events.data[24]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |
| events · `$[0].events.framing[15]` | `V-FRAMING` |
| events · `$[0].events.framing[16]` | `V-FRAMING` |
| events · `$[0].events.framing[17]` | `V-FRAMING` |
| events · `$[0].events.framing[18]` | `V-FRAMING` |
| events · `$[0].events.framing[19]` | `V-FRAMING` |
| events · `$[0].events.framing[20]` | `V-FRAMING` |
| events · `$[0].events.framing[21]` | `V-FRAMING` |
| events · `$[0].events.framing[22]` | `V-FRAMING` |
| events · `$[0].events.framing[23]` | `V-FRAMING` |
| events · `$[0].events.framing[24]` | `V-FRAMING` |
| events · `$[0].events.framing[25]` | `V-FRAMING` |

</details>

### generated.20260922.0001

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0001/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0001/scenario.json) · 19 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2。

场景提示：3 个输入 item；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0002

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0002/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0002/scenario.json) · 17 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×1，`Q-STREAM`×2。

场景提示：字符串输入；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0003

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0003/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0003/scenario.json) · 72 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×2，`V-FRAMING`×17，`V-SNAPSHOT`×11，`V-TOPOLOGY`×28。

场景提示：3 个输入 item；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.role` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.data[14]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |
| events · `$[0].events.framing[15]` | `V-FRAMING` |

</details>

### generated.20260922.0004

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0004/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0004/scenario.json) · 57 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×7，`Q-PARALLEL`×1，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×14。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| request · `$[0].providerRequests[0].body.parallel_tool_calls` | `Q-PARALLEL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |

</details>

### generated.20260922.0005

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0005/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0005/scenario.json) · 80 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×7，`Q-PARALLEL`×1，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×17，`V-SNAPSHOT`×11，`V-TOPOLOGY`×28。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| request · `$[0].providerRequests[0].body.parallel_tool_calls` | `Q-PARALLEL` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.role` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.data[14]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |
| events · `$[0].events.framing[15]` | `V-FRAMING` |

</details>

### generated.20260922.0006

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0006/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0006/scenario.json) · 49 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×2，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×14。

场景提示：3 个输入 item；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |

</details>

### generated.20260922.0007

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0007/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0007/scenario.json) · 15 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×2，`Q-STREAM`×2。

场景提示：3 个输入 item；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0008

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0008/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0008/scenario.json) · 21 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×3，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0009

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0009/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0009/scenario.json) · 18 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×2，`Q-STREAM`×2。

场景提示：3 个输入 item；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0010

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0010/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0010/scenario.json) · 20 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×2，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0011

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0011/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0011/scenario.json) · 48 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×14。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |

</details>

### generated.20260922.0012

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0012/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0012/scenario.json) · 75 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×3，`V-FRAMING`×18，`V-SNAPSHOT`×11，`V-TOPOLOGY`×29。

场景提示：3 个输入 item；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.role` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.data[14]` | `V-TOPOLOGY` |
| events · `$[0].events.data[15]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |
| events · `$[0].events.framing[15]` | `V-FRAMING` |
| events · `$[0].events.framing[16]` | `V-FRAMING` |

</details>

### generated.20260922.0013

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0013/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0013/scenario.json) · 100 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×7，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×28，`V-SNAPSHOT`×11，`V-TOPOLOGY`×39。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.role` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.data[14]` | `V-TOPOLOGY` |
| events · `$[0].events.data[15]` | `V-TOPOLOGY` |
| events · `$[0].events.data[16]` | `V-TOPOLOGY` |
| events · `$[0].events.data[17]` | `V-TOPOLOGY` |
| events · `$[0].events.data[18]` | `V-TOPOLOGY` |
| events · `$[0].events.data[19]` | `V-TOPOLOGY` |
| events · `$[0].events.data[20]` | `V-TOPOLOGY` |
| events · `$[0].events.data[21]` | `V-TOPOLOGY` |
| events · `$[0].events.data[22]` | `V-TOPOLOGY` |
| events · `$[0].events.data[23]` | `V-TOPOLOGY` |
| events · `$[0].events.data[24]` | `V-TOPOLOGY` |
| events · `$[0].events.data[25]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |
| events · `$[0].events.framing[15]` | `V-FRAMING` |
| events · `$[0].events.framing[16]` | `V-FRAMING` |
| events · `$[0].events.framing[17]` | `V-FRAMING` |
| events · `$[0].events.framing[18]` | `V-FRAMING` |
| events · `$[0].events.framing[19]` | `V-FRAMING` |
| events · `$[0].events.framing[20]` | `V-FRAMING` |
| events · `$[0].events.framing[21]` | `V-FRAMING` |
| events · `$[0].events.framing[22]` | `V-FRAMING` |
| events · `$[0].events.framing[23]` | `V-FRAMING` |
| events · `$[0].events.framing[24]` | `V-FRAMING` |
| events · `$[0].events.framing[25]` | `V-FRAMING` |
| events · `$[0].events.framing[26]` | `V-FRAMING` |

</details>

### generated.20260922.0014

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0014/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0014/scenario.json) · 64 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×2，`V-FRAMING`×13，`V-SNAPSHOT`×11，`V-TOPOLOGY`×24。

场景提示：3 个输入 item；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.role` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |

</details>

### generated.20260922.0015

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0015/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0015/scenario.json) · 24 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×7，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0016

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0016/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0016/scenario.json) · 62 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×16，`V-SNAPSHOT`×11，`V-TOPOLOGY`×19。

场景提示：字符串输入；1 个声明工具；tool_choice；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |

</details>

### generated.20260922.0017

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0017/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0017/scenario.json) · 86 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×7，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×26，`V-SNAPSHOT`×11，`V-TOPOLOGY`×29。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.data[14]` | `V-TOPOLOGY` |
| events · `$[0].events.data[15]` | `V-TOPOLOGY` |
| events · `$[0].events.data[16]` | `V-TOPOLOGY` |
| events · `$[0].events.data[17]` | `V-TOPOLOGY` |
| events · `$[0].events.data[18]` | `V-TOPOLOGY` |
| events · `$[0].events.data[19]` | `V-TOPOLOGY` |
| events · `$[0].events.data[20]` | `V-TOPOLOGY` |
| events · `$[0].events.data[21]` | `V-TOPOLOGY` |
| events · `$[0].events.data[22]` | `V-TOPOLOGY` |
| events · `$[0].events.data[23]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |
| events · `$[0].events.framing[15]` | `V-FRAMING` |
| events · `$[0].events.framing[16]` | `V-FRAMING` |
| events · `$[0].events.framing[17]` | `V-FRAMING` |
| events · `$[0].events.framing[18]` | `V-FRAMING` |
| events · `$[0].events.framing[19]` | `V-FRAMING` |
| events · `$[0].events.framing[20]` | `V-FRAMING` |
| events · `$[0].events.framing[21]` | `V-FRAMING` |
| events · `$[0].events.framing[22]` | `V-FRAMING` |
| events · `$[0].events.framing[23]` | `V-FRAMING` |
| events · `$[0].events.framing[24]` | `V-FRAMING` |

</details>

### generated.20260922.0018

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0018/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0018/scenario.json) · 22 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×7，`Q-PARALLEL`×1，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.parallel_tool_calls` | `Q-PARALLEL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0019

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0019/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0019/scenario.json) · 18 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×2，`Q-STREAM`×2。

场景提示：3 个输入 item；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0020

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0020/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0020/scenario.json) · 19 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-STREAM`×2。

场景提示：3 个输入 item；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0021

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0021/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0021/scenario.json) · 56 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×7，`Q-PARALLEL`×1，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×14。

场景提示：3 个输入 item；1 个声明工具；tool_choice；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[3]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.parallel_tool_calls` | `Q-PARALLEL` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |

</details>

### generated.20260922.0022

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0022/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0022/scenario.json) · 18 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×2，`Q-STREAM`×2。

场景提示：3 个输入 item；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0023

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0023/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0023/scenario.json) · 64 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-MESSAGE`×2，`V-FRAMING`×13，`V-SNAPSHOT`×11，`V-TOPOLOGY`×24。

场景提示：3 个输入 item；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.id` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.role` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.status` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.content` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.summary` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item.encrypted_content` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[3].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].event` | `V-FRAMING` |
| events · `$[0].events.framing[4].done` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |

</details>

### generated.20260922.0024

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0024/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0024/scenario.json) · 81 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×26，`V-SNAPSHOT`×11，`V-TOPOLOGY`×29。

场景提示：字符串输入；1 个声明工具；tool_choice；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.data[14]` | `V-TOPOLOGY` |
| events · `$[0].events.data[15]` | `V-TOPOLOGY` |
| events · `$[0].events.data[16]` | `V-TOPOLOGY` |
| events · `$[0].events.data[17]` | `V-TOPOLOGY` |
| events · `$[0].events.data[18]` | `V-TOPOLOGY` |
| events · `$[0].events.data[19]` | `V-TOPOLOGY` |
| events · `$[0].events.data[20]` | `V-TOPOLOGY` |
| events · `$[0].events.data[21]` | `V-TOPOLOGY` |
| events · `$[0].events.data[22]` | `V-TOPOLOGY` |
| events · `$[0].events.data[23]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |
| events · `$[0].events.framing[15]` | `V-FRAMING` |
| events · `$[0].events.framing[16]` | `V-FRAMING` |
| events · `$[0].events.framing[17]` | `V-FRAMING` |
| events · `$[0].events.framing[18]` | `V-FRAMING` |
| events · `$[0].events.framing[19]` | `V-FRAMING` |
| events · `$[0].events.framing[20]` | `V-FRAMING` |
| events · `$[0].events.framing[21]` | `V-FRAMING` |
| events · `$[0].events.framing[22]` | `V-FRAMING` |
| events · `$[0].events.framing[23]` | `V-FRAMING` |
| events · `$[0].events.framing[24]` | `V-FRAMING` |

</details>

### generated.20260922.0025

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0025/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0025/scenario.json) · 51 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×14。

场景提示：字符串输入；1 个声明工具；tool_choice；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |

</details>

### generated.20260922.0026

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0026/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0026/scenario.json) · 52 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×3，`Q-TOOL-SCHEMA`×1，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×14。

场景提示：字符串输入；1 个声明工具；tool_choice；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1]` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.tools[0].function.strict` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |

</details>

### generated.20260922.0027

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0027/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0027/scenario.json) · 59 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×2，`V-FRAMING`×16，`V-SNAPSHOT`×11，`V-TOPOLOGY`×19。

场景提示：3 个输入 item；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |

</details>

### generated.20260922.0028

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0028/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0028/scenario.json) · 15 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×2，`Q-STREAM`×2。

场景提示：3 个输入 item；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0029

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0029/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0029/scenario.json) · 50 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×3，`V-FRAMING`×11，`V-SNAPSHOT`×11，`V-TOPOLOGY`×14。

场景提示：3 个输入 item；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[1].role` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.messages[2].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |

</details>

### generated.20260922.0030

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0030/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0030/scenario.json) · 19 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-REASONING`×3，`P-SHAPE`×2，`Q-CHOICE`×1，`Q-MESSAGE`×1，`Q-STREAM`×2，`Q-TOOL-SCHEMA`×1。

场景提示：字符串输入；1 个声明工具；tool_choice；reasoning；模拟 reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| request · `$[0].providerRequests[0].body.stream` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.stream_options` | `Q-STREAM` |
| request · `$[0].providerRequests[0].body.tools` | `Q-TOOL-SCHEMA` |
| request · `$[0].providerRequests[0].body.tool_choice` | `Q-CHOICE` |
| response · `$[0].terminal.output[0].summary[0]` | `P-REASONING` |
| response · `$[0].terminal.output[0].token_continuity` | `P-REASONING` |
| response · `$[0].terminal.output[0].encrypted_content` | `P-REASONING` |
| response · `$[0].terminal.output[1].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |

</details>

### generated.20260922.0031

[原始差异](../artifacts/protocol-compare/final/cases/generated.20260922.0031/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/generated.20260922.0031/scenario.json) · 78 项；`E-DEFAULT`×7，`E-MODEL`×1，`P-PHASE`×1，`P-SHAPE`×2，`Q-MESSAGE`×1，`V-FRAMING`×26，`V-SNAPSHOT`×11，`V-TOPOLOGY`×29。

场景提示：字符串输入；reasoning

<details><summary>逐字段路径与归因</summary>

| 分组与报告路径 | 根因 |
|---|---|
| request · `$[0].providerRequests[0].body.messages[0].content` | `Q-MESSAGE` |
| response · `$[0].terminal.output[0].phase` | `P-PHASE` |
| response · `$[0].terminal.error` | `P-SHAPE` |
| response · `$[0].terminal.incomplete_details` | `P-SHAPE` |
| envelope · `$[0].envelope.instructions` | `E-DEFAULT` |
| envelope · `$[0].envelope.metadata` | `E-DEFAULT` |
| envelope · `$[0].envelope.model` | `E-MODEL` |
| envelope · `$[0].envelope.parallel_tool_calls` | `E-DEFAULT` |
| envelope · `$[0].envelope.temperature` | `E-DEFAULT` |
| envelope · `$[0].envelope.tool_choice` | `E-DEFAULT` |
| envelope · `$[0].envelope.tools` | `E-DEFAULT` |
| envelope · `$[0].envelope.top_p` | `E-DEFAULT` |
| events · `$[0].events.data[0].response.error` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.incomplete_details` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.instructions` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.metadata` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.model` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.parallel_tool_calls` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.temperature` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tool_choice` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.tools` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.top_p` | `V-SNAPSHOT` |
| events · `$[0].events.data[0].response.usage` | `V-SNAPSHOT` |
| events · `$[0].events.data[1].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[1].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].type` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].response` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].output_index` | `V-TOPOLOGY` |
| events · `$[0].events.data[2].item` | `V-TOPOLOGY` |
| events · `$[0].events.data[3]` | `V-TOPOLOGY` |
| events · `$[0].events.data[4]` | `V-TOPOLOGY` |
| events · `$[0].events.data[5]` | `V-TOPOLOGY` |
| events · `$[0].events.data[6]` | `V-TOPOLOGY` |
| events · `$[0].events.data[7]` | `V-TOPOLOGY` |
| events · `$[0].events.data[8]` | `V-TOPOLOGY` |
| events · `$[0].events.data[9]` | `V-TOPOLOGY` |
| events · `$[0].events.data[10]` | `V-TOPOLOGY` |
| events · `$[0].events.data[11]` | `V-TOPOLOGY` |
| events · `$[0].events.data[12]` | `V-TOPOLOGY` |
| events · `$[0].events.data[13]` | `V-TOPOLOGY` |
| events · `$[0].events.data[14]` | `V-TOPOLOGY` |
| events · `$[0].events.data[15]` | `V-TOPOLOGY` |
| events · `$[0].events.data[16]` | `V-TOPOLOGY` |
| events · `$[0].events.data[17]` | `V-TOPOLOGY` |
| events · `$[0].events.data[18]` | `V-TOPOLOGY` |
| events · `$[0].events.data[19]` | `V-TOPOLOGY` |
| events · `$[0].events.data[20]` | `V-TOPOLOGY` |
| events · `$[0].events.data[21]` | `V-TOPOLOGY` |
| events · `$[0].events.data[22]` | `V-TOPOLOGY` |
| events · `$[0].events.data[23]` | `V-TOPOLOGY` |
| events · `$[0].events.framing[0].event` | `V-FRAMING` |
| events · `$[0].events.framing[1].event` | `V-FRAMING` |
| events · `$[0].events.framing[2].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].event` | `V-FRAMING` |
| events · `$[0].events.framing[3].done` | `V-FRAMING` |
| events · `$[0].events.framing[4]` | `V-FRAMING` |
| events · `$[0].events.framing[5]` | `V-FRAMING` |
| events · `$[0].events.framing[6]` | `V-FRAMING` |
| events · `$[0].events.framing[7]` | `V-FRAMING` |
| events · `$[0].events.framing[8]` | `V-FRAMING` |
| events · `$[0].events.framing[9]` | `V-FRAMING` |
| events · `$[0].events.framing[10]` | `V-FRAMING` |
| events · `$[0].events.framing[11]` | `V-FRAMING` |
| events · `$[0].events.framing[12]` | `V-FRAMING` |
| events · `$[0].events.framing[13]` | `V-FRAMING` |
| events · `$[0].events.framing[14]` | `V-FRAMING` |
| events · `$[0].events.framing[15]` | `V-FRAMING` |
| events · `$[0].events.framing[16]` | `V-FRAMING` |
| events · `$[0].events.framing[17]` | `V-FRAMING` |
| events · `$[0].events.framing[18]` | `V-FRAMING` |
| events · `$[0].events.framing[19]` | `V-FRAMING` |
| events · `$[0].events.framing[20]` | `V-FRAMING` |
| events · `$[0].events.framing[21]` | `V-FRAMING` |
| events · `$[0].events.framing[22]` | `V-FRAMING` |
| events · `$[0].events.framing[23]` | `V-FRAMING` |
| events · `$[0].events.framing[24]` | `V-FRAMING` |

</details>

<!-- GENERATED-CAUSE-INDEX-END -->
