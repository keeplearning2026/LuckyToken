# Provider Native Responses 生命周期规范化修改计划

状态：**PLANNED — 设计已确定，生产实现尚未开始**
日期：2026-09-23

## 1. 目标与证据

在完整缓冲的 Provider Native Responses SSE 中，将交错的 output-item chains 串行回放，消除已认证场景下 Codex 的单 active-item / 单 tool-argument-consumer 冲突，同时保留原始 item 提交顺序。

依据：

- [原始兼容性调查](../Research/ProviderNativeResponsesCodexSseCompatibilityReport.md)。
- [Codex 提交顺序审计及真实 CLI 回放](../Research/ProviderNativeResponsesItemChainToolOrderAudit.md)。
- [可重复运行的隔离回放脚本](../Research/provider-native-item-chain-replay.mjs)。
- 本地 Codex 源码提交 `30fc6864cc1318121eca1843c217fe00ce1212f1`，回放运行时 `codex-cli 0.149.0`。

已确认：串行化完整 chain 可以消除已知生命周期冲突；改变 item done 顺序会改变 Codex 最终消息，源码还表明它影响历史记录与工具任务启动。

本计划采用最终讨论确定的契约，取代早期的 opening-only 修复、output_index 排序、global 硬屏障，以及 normalizer 不支持就返回 502 的方案。历史研究文档仍作为证据保存，实施时添加指向本计划的状态说明。

## 2. 冻结的产品契约

### 2.1 适用范围

- 仅 `POST /v1/responses` 的 Provider Native Preservation 分支。
- 上游为成功 HTTP 响应，响应媒体类型为 `text/event-stream`，body 已完整缓冲。
- 统一适用于该边界，不识别 Codex User-Agent，不按 Provider/model 名称特判。
- 不接入 Direct Mode、Semantic Conversion、Anthropic、Responses compact 或非 SSE JSON。
- 上游 HTTP 错误继续走现有错误保留/alias 安全流程。

### 2.2 顺序权威

1. 每条 item chain 内所有事件保持原始顺序。
2. 不同 item 的 `response.output_item.done` 保持原始相对顺序。
3. 独立 global 帧之间保持原始相对顺序。
4. global 与所有 item done 之间保持原始相对顺序。
5. `output_index` 仅用于归属和一致性校验，不是排序键，也不是备用排序键。
6. 允许改变不同 item 的 added/delta 交错，以及 global 相对 added/delta 的位置。

`output_item.done` 在此是 commit-order marker。不要称 item chain 为事务，也不要承诺工具实际执行/完成顺序、UI 每一时刻、异步取消或 mailbox 时点完全等价。

### 2.3 global 统一处理

- 独立 global 帧按原序加入输出，不增加按事件名称决定能否移动的白名单，不再设置中途 global 硬屏障。
- 未知事件只要归属明确，按相同结构规则处理；不因为事件名称未知就跳过。
- item 帧中附带的 metadata / safety_buffering 等字段随整个原帧移动，不拆成新事件，不修改字段。
- 上述契约保证的是独立 global 帧与 item done 的顺序，不承诺附带字段在 Codex 内部派生通知的全局顺序。
- 识别 added/done、明确 item-local 事件缺失身份、response 终止位置等，属于结构完整性检查，不是 global 可移动性规则表。

### 2.4 保留和回退

- 已经串行：返回原始 body 字节。
- 成功规范化：只移动完整原帧，以及调整允许的顶层 `sequence_number`。
- 无法建立可信完整 chains：返回 `skipped`，原始 body 不变。
- normalizer 不新增 HTTP 失败、不改变终止结果、不重试上游。
- `skipped` 后仍执行现有 alias projection；既有 alias safety 失败规则不放宽。
- 不合并 delta、不生成 added/done、不重建最终 Response、不改变 item 身份。

## 3. 算法：在 done 位置展开 chain

先解析与验证完整缓冲 body，再按原帧顺序构建候选结果；所有检查通过才采用候选结果。

```text
item-local frame → 加入对应 chain
global frame     → 加入候选输出
item done        → 加入 chain，然后将该完整 chain 加入候选输出
```

示例：

```text
输入                            输出
A.added                         GLOBAL_1
GLOBAL_1                        GLOBAL_2
B.added                         B.added
B.delta                         B.delta
GLOBAL_2                        B.done
B.done                          A.added
A.delta                         A.delta
A.done                          A.done
```

无需全局排序器、拓扑排序框架、规则注册表或 item 类型组合矩阵。用原始帧索引引用建立 chain，避免复制每个 payload。目标复杂度为 O(输入字节数 + 帧数)，使用请求局部状态，不跨请求缓存。

### 3.1 事件归属和结构校验

- added/done 的 `item.id` 与对应事件的 `item_id` 建立同一身份；`output_index` 与身份保持一致。
- 某帧缺少 index，但 `item_id` 能解析到已知 chain，可以归属；仅 index 可通过已验证绑定解析时同理。
- 一条 chain 完全缺少可验证的必要身份信息时，不从首次出现位置猜测或生成身份/index。
- `content_index` 只标识 item 内部内容，不能单独作为 item 身份。
- index 可以稀疏；其大小关系不限制 done 回放顺序。
- 同一身份对应冲突 index、同一 index 绑定不相容身份、重复或前后矛盾的生命周期、done 后又出现该 item 的内容，均返回 `skipped`。
- 明确是 item-local 的结构却缺失归属信息，返回 `skipped`，不得伪装成 global。
- 没有 item 归属、也没有明确损坏 item 结构的未知帧，作为 global 保留。
- done-only 或不完整 item 流不补造事件；若不能验证本次转换所需的完整 chain，则跳过。
- response 终止事件的位置需合法；不把待输出 chain 追加在终止事件后，不通过搬动终止事件修复破损输入。

### 3.2 SSE 字节保留

- 内部保留原始帧及其字节/文本区间，支持 LF、CRLF、合法多行 data、注释、空行和原始非 data 字段。
- JSON 解码只服务于结构分析；输出不得全量 JSON.stringify。
- `event:` 与 data 内的类型等判定信息矛盾、JSON/UTF-8 无法可靠解析、关键属性重复且歧义、帧边界不完整等，不重构，返回原始 body。
- 不产生新 SSE 事件，不丢弃未知字段；注释/非数据记录不凭空附着到另一 item，按原始记录边界保留。
- 无需修改时直接返回输入 body，分析不等于重建 wire。
- 候选输出失败后整份回退，不输出部分规范化、部分原流的混合结果。

### 3.3 sequence_number 与游标

- 只有真实发生帧重排时，才处理顶层 `sequence_number`。
- 按最终帧顺序，对原来具有合法顶层 sequence_number 的数据事件连续编号；从 0 开始，只替换该数值 token。原来没有该字段的事件不添加字段。
- 不改嵌套同名字段；不因 sequence_number 大小决定帧顺序。
- 无法无歧义定位/替换数值、重复关键属性或非法数值时，整份跳过。
- 序号变化是 payload 保留的唯一 normalizer 例外；后续 alias projection 的既有例外单独计算。
- 请求/响应涉及 background 或 upstream cursor resume 时跳过：检查相关请求字段、URL 的 starting_after、Last-Event-ID，以及响应的 background/resume 事实；非空 SSE id 作为潜在重连游标保守跳过。
- 只提取禁用规范化所需的最小事实，不向纯 normalizer 传入 Request、凭据、诊断对象或整个请求体。
- 不把 `previous_response_id` 或 `codex exec resume` 自动视为 SSE 游标续传；它们与 upstream sequence cursor 是不同概念。
- 不引入 upstream/client sequence 映射，也不借本任务增加续传端点。

### 3.4 合法失败和终止

- `response.failed` / `response.incomplete` 到来时若存在未闭合 item，直接 `skipped` 并原样返回。
- 如果此前 chains 已全部闭合，终止帧作为 global 保留，处理前后失败/未完成的含义不变。
- `[DONE]` 若存在，保留为原始终止记录，不补造，也不作为缺失 item done 的替代品。
- 缺失证明此次重排所需的终止/完整性证据时，返回原始响应。
- 请求取消仍由现有 AbortSignal 路径处理，不能被 normalizer 回退逻辑吞掉。

## 4. 模块和接入位置

### 4.1 新增纯函数模块

新增 `src/protocols/openai-responses/native-sse-lifecycle-normalizer.ts`。

建议入口 `normalizeNativeResponsesSse`，返回明确的联合结果：

```ts
type NativeResponsesNormalizationResult =
  | { kind: "unchanged"; body: Uint8Array }
  | {
      kind: "normalized";
      body: Uint8Array;
      movedFrameCount: number;
      commitOrderDiffersFromOutputIndex: boolean;
    }
  | { kind: "skipped"; body: Uint8Array; reason: NormalizationSkipReason };
```

实际 ArrayBuffer 类型与 `NativeResponsesResult` / `Response` 构造器对齐。解析、归属、验证、原帧拼接均封装在模块内；只返回有限计数和枚举原因，不返回 payload 诊断袋。未知输入造成的可恢复分析失败返回 skipped。

### 4.2 接入 handler

修改 `src/protocols/openai-responses/handler.ts` 的 `providerNativeBranch`：

```text
执行上游请求
→ 完整缓冲
→ 捕获原始 upstream artifact
→ 从原始响应观察 usage
→ lifecycle normalization
→ 若 normalized，捕获中间 artifact
→ 现有 alias projection
→ 捕获最终 preserved artifact
→ 返回响应
```

`native-response.ts` 继续拥有缓冲和 alias projection。原则上不为此任务修改 alias 算法；只有明确必要的接缝调整才涉及该文件，不借机抽取通用解析框架。

normalizer 的可恢复错误不逃逸成 502；真正的上游读取失败、现有 alias 安全失败、请求取消继续遵守原契约。不得改动 Provider transport、Pi 或另外两条 lane。

## 5. 诊断与证据

使用现有 Request Journey 的 no-throw 观察边界。在 `lane_response_processing / provider_native` 下增加 `normalize_provider_native_lifecycle` 步骤。

复用现有有界 notice 观察形状（目前为 `conversion_notice_observed`），通过位置明确归属 Provider Native；这不调用 Semantic Conversion，不新建持久化渠道，不为命名另加一套事件 schema。notice 只承载已完成分析的事实。

建议固定代码：

- `provider_native_lifecycle_normalized`：每响应至多一次。
- `provider_native_lifecycle_normalization_skipped`：每响应至多一次，附有界固定原因文本。
- `item_commit_order_differs_from_output_index`：规范化结果的 index 顺序差异，至多一次 warning，不阻断。

skip 原因至少包括：`item_identity_conflict`、`incomplete_item_chain`、`unsupported_event_attribution`、`invalid_sse_structure`、`invalid_sequence_number`、`upstream_cursor_semantics`。不再使用 `midstream_global_barrier`。

保留三个自然证据点：

1. `provider_native_upstream_response_wire`：原始缓冲响应。
2. `provider_native_lifecycle_normalized_wire`：仅 normalized 时采集。
3. `provider_native_preserved_response_wire`：经过现有 alias projection 的最终 wire。

正文只能进入现有有界、脱敏的 artifact 管道；notice 不含内容、工具参数、身份字符串或凭据。计数有界，诊断关闭/抛错/饱和/慢/不可用不影响返回 body、status、headers、路由或 outcome。skipped 不记为请求失败。

## 6. 实施顺序和测试

### 步骤 1：保存基线和最小复现

- 开始实施时重新查看工作区差异，保留现有未提交的 alias、handler、online runner 和测试修改。
- 记录四组现有 CLI 回放结果，以逆序 done 案例防止误用 index 排序。
- 添加紧贴生产 pure seam 的失败测试，再实现 normalizer；避免只测试测试代码自己的排序函数。

### 步骤 2：完成纯函数与结构认证

新增 `test/unit/provider-native-responses-lifecycle-normalizer.test.ts`，至少覆盖：

| 场景 | 断言 |
|---|---|
| 单 message、串行 reasoning/message、串行 tools | 输入输出逐字节相同 |
| reasoning/message opening 交错 | 完整 chain 串行、done 顺序不变 |
| 真正内容交错 | 保留 per-item 顺序，允许跨 item 内容顺序改变 |
| 逆序 index、done B→A | 输出 B chain→A chain，保留 index 并给出诊断事实 |
| 三个以上交错 items | 所有 chain 与 done 顺序正确 |
| added 自带正文 | 不特殊删除/搬运正文，原帧完整保留 |
| 多个 custom/function tool chains | 参数/调用身份不变，无 singleton 交错 |
| reasoning.delta 与 reasoning_text.delta | 均保留，认证中明确 Codex 消费差异 |
| global 在开头、中途、末尾 | global+done 子序列与原流完全相同 |
| 未知 global、未知但有明确归属的事件 | 按结构统一处理，无白名单 |
| item 帧附带全局字段 | 不拆帧、不丢字段，随 chain 保留 |
| LF/CRLF、多行 data、注释、数字 wire 表示 | 除序号 token 外保留原始字节 |
| 身份矛盾、缺失归属、重复生命周期 | skipped，原始字节相同 |
| failed/incomplete 时仍有未闭合 item | skipped，原终止保留 |
| 游标/background | skipped，不重编号 |
| 非法或歧义序号 | skipped，无部分输出 |

独立结构断言：frame 数量/身份不变；每个 item 的原始帧序列不变（序号除外）；所有 done 的原序列不变；所有 global+done 的原序列不变；terminal/final output 内容不变。增加有限、确定性的交错排列枚举，覆盖多 chain 组合，避免只测试单个样例。

### 步骤 3：接入 HTTP 与 alias 契约

扩展 `test/unit/provider-native-responses-contract.test.ts`，按需复用/扩展 `provider-native-responses-projection.test.ts`：

- 上游 200 + 可规范化 SSE → 下游 200 + 规范化 wire。
- skipped + 无 alias → 原始响应 body、status、headers；没有新增重试。
- normalized/skipped 两分支都继续执行 alias projection。
- alias 失败仍按原契约拒绝；JSON Schema 中名为 model 的既有回归继续覆盖。
- Direct、Semantic、compact、非 SSE JSON、上游 HTTP 错误不受影响。
- request/response cursor 事实正确禁用，普通 Codex 多轮 resume 不误禁用。

### 步骤 4：诊断非干扰测试

扩展 `test/integration/request-journey-provider-native-openai.test.ts`，按需扩展 `request-journey-non-interference.test.ts`，复用现有 diagnostics worker 故障测试设施。

验证成功规范化、skipped、index 顺序差异的有界 notice 和三个 artifact 的关系；分别比较关闭、抛错、饱和、慢、不可用时的响应等价性。不要在 serving path 等待诊断落盘。

### 步骤 5：真实 CLI 回放认证

- 扩展研究回放脚本或将可复用的隔离部分移至正式测试支持目录。
- 回放链必须调用实际生产 normalizer/HTTP 接入，不能继续只手工拼三种顺序。
- 保留原始交错、index 错误排序对照、done 排序三组结果，证明最终 assistant message 保持原 done 行为。
- 新增 global+done 排序、reasoning、工具参数消费者、多工具、下一轮请求历史验证；工具仅使用隔离目录中的合成无外部副作用操作。
- 除最终文本外，检查 item/reasoning 归属、工具调用和参数、结果与下一轮历史顺序。
- 不把工具完成时刻或并发完成顺序当作不变性断言；比较调用提交/结果收集等明确契约。

### 步骤 6：在线认证和仓库门禁

修改 `test/online/run-codex-cli.ts` 的结果断言，识别以下四类 forbidden lifecycle diagnostics：

```text
OutputTextDelta without active item
ReasoningSummaryDelta without active item
ReasoningSummaryPartAdded without active item
ReasoningRawContentDelta without active item
```

认证成功要求 turn.completed、预期最终内容/工具/多轮历史均通过，并且没有上述诊断。skipped 在生产中允许透传，但在线认证若仍出现这些诊断，必须报告失败/未认证及 skipped 原因，不能以“本来会透传”掩盖。

所有能够触及 Codex 状态的测试使用新建临时 CODEX_HOME。标准 guard 只允许复制 config.toml、token-model-catalog.json；每个 Backend/CLI/helper 显式继承该路径；不得读取或复制用户 auth/cache/sessions；finally 清理。

执行顺序：

1. 用 `scripts/run-with-codex-test-sandbox.mjs` 包装新增 normalizer、Provider Native contract/projection、journey 定向测试。
2. 运行真实本地 CLI 隔离回放。
3. `npm run typecheck`、`npm run lint`、`git diff --check`。
4. `npm run test:online-codex:private`、`npm run test:online-codex:goat`。
5. `npm test`。
6. 审查最终 diff；修复审查发现后只重跑受影响门禁。

在线 API/环境不可用时明确记录未完成认证，不以本地合成回放替代在线结论。不得提交或推送，除非另行要求。

## 7. 预期文件变更

| 文件 | 变更 |
|---|---|
| `src/protocols/openai-responses/native-sse-lifecycle-normalizer.ts` | 新增纯规范化模块 |
| `src/protocols/openai-responses/handler.ts` | Native 分支接入、最小 eligibility 事实和 Journey 观察 |
| `test/unit/provider-native-responses-lifecycle-normalizer.test.ts` | 新增算法/字节/不变性测试 |
| `test/unit/provider-native-responses-contract.test.ts` | HTTP、跳过透传、alias、边界回归 |
| `test/unit/provider-native-responses-projection.test.ts` | 需要时补充与规范化组合的 alias 回归 |
| `test/integration/request-journey-provider-native-openai.test.ts` | 中间 artifact、notice、outcome |
| `test/integration/request-journey-non-interference.test.ts` | 规范化路径诊断故障等价性 |
| `test/online/run-codex-cli.ts` | 四类诊断门禁及认证结果 |
| `doc/Research/provider-native-item-chain-replay.mjs` 或正式测试位置 | 调用生产实现的真实 CLI 回放 |
| 本计划、原调查/审计、`doc/TokenArchitecture.md`、online README | 标明最终契约、历史方案替代关系和验证方法 |

不预设需要更改 package.json 或诊断持久化 schema；优先使用已有 guarded commands 与观察契约。

## 8. 完成判据

- 生产路径使用 global/done 原序、done 处展开 chain 的单一算法。
- 没有 index 排序、首次出现排序、Codex/provider 名称特判或 global 可移动白名单。
- identity、per-item 顺序、done 顺序、独立 global+done 顺序及非序号 payload 保留得到结构测试证明。
- unchanged/skipped 完整返回原始字节；normalizer 不扩大失败面，alias safety 保持原规则。
- 真实 CLI 回放验证已认证场景的最终消息、reasoning、工具、后续历史以及零 lifecycle diagnostics。
- Private/Goat 在线认证与仓库门禁完成；任何未完成部分明确列出。
- 诊断非干扰得到验证；未改 Pi/Codex，也未触碰用户 Codex 状态。
