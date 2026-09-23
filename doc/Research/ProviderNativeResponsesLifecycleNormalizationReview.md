# Provider Native Responses 生命周期规范化：commit `27d5838` 审阅记录

状态：**审阅完成；follow-up 已实施并完成再认证** — 本文前半部分保留对 commit
`27d5838` 的只读复核结论；后续修复与验证状态记录在 §8。发现的裸 CR 字节损坏缺陷、
证据强度缺口与认证记录缺口均已关闭；audio 事件归类保留为明确的未认证边界。本记录不替代
[修改计划](../Spec/TokenProviderNativeResponsesLifecycleNormalizationPlan.md)，而是其 §9 之后的独立复核与 follow-up 证据。

日期：2026-09-23

## 1. 审阅对象与证据基础

| 项 | 值 |
|---|---|
| 被审 commit | `27d5838846f3dfa0a24cafe5f153d15c52c2144c`（评审时 `HEAD` / `origin/main`） |
| 固定点 | 父提交 `4388c22dde4957ec909df359e58f2883b9fea923` |
| 规模 | 13 文件，+2994 / −16 |
| 权威规范 | `doc/Spec/TokenProviderNativeResponsesLifecycleNormalizationPlan.md` |
| Codex 参照源码 | `D:\project\codex` @ `30fc6864cc1318121eca1843c217fe00ce1212f1`（与计划 §1 引用一致） |
| 事件形状参照 | 仓库已安装的 `node_modules/openai`（只用于事件字段事实，不作为运行时依赖） |

复核命令（均在仓库根执行）：

```powershell
git diff 27d5838846f3dfa0a24cafe5f153d15c52c2144c^...27d5838846f3dfa0a24cafe5f153d15c52c2144c
npx eslint src/protocols/openai-responses/native-sse-lifecycle-normalizer.ts src/protocols/openai-responses/handler.ts test/unit/provider-native-responses-lifecycle-normalizer.test.ts test/unit/provider-native-responses-contract.test.ts test/integration/request-journey-provider-native-openai.test.ts test/integration/request-journey-non-interference.test.ts test/online/run-provider-native-item-chain-replay.ts test/online/run-codex-cli.ts
node scripts/run-with-codex-test-sandbox.mjs -- npx vitest run test/unit/provider-native-responses-lifecycle-normalizer.test.ts
```

方法：Standards 轴与 Spec 轴分开审查，另加一条独立轴核对 Codex 消费行为。每条结论标注证据
等级——**已复现**（本次实跑得到输出）、**源码确认**（引用行号）、**报告未复核**。

## 2. 结论摘要

本次 commit 的架构判断正确，冻结契约的单一算法（global 与 `response.output_item.done` 共同
构成原序骨架，每条完整 chain 在其原始 done 位置展开，`output_index` 只做身份与一致性校验）
在 Codex 源码层面成立，且没有 scope creep。所有新增文件都落在计划 §4/§6/§7 的预期清单内。

需要在后续独立提交中处理的问题：

1. **P1 已复现**：帧内出现裸 CR 行结束符时，重编号会写到错误偏移，输出仍是 `normalized`，
   实际却损坏了 payload 字节。
2. **P2 待决**：`response.audio.delta` / `response.audio.transcript.delta` 没有 item 身份，
   当前被当作 global，可被移动到所属 item 的 `added` 之前。计划 §2.2(6) 与 §3.1 对这类帧的
   归类存在张力，需要择一并写进规范。
3. **P3 证据缺口**：在线回放的工具/历史断言强度、诊断非干扰故障模式、Direct/Semantic/compact
   回归、audit 文档状态说明、serving conformance record/hash。
4. **P4 清理项**：`Frame.type` 与 `Chain.id` 是不可达状态；handler 对同一请求体存在两个解析权威。

## 3. Codex 消费行为核对

计划 §1 与 §2.2 的行为断言逐条对照 `D:\project\codex`（commit `30fc6864`）：

| 断言 | 结论 | 证据 |
|---|---|---|
| 四类 `without active item` 诊断存在 | 源码确认 | `core/src/session/turn.rs:2928`、`2970`、`2988`、`3043`；条件均为对应 delta 到达时 `active_item` 为 `None` |
| 诊断的失败模式 | 源码确认 | `core/src/util.rs:81` `error_or_panic`：debug 构型 panic，release 构型只写 `error!` 日志后静默降级 |
| 单 active item 约束 | 源码确认，措辞需收窄 | `active_item` 单槽（`turn.rs:2527`）；`output_item.added` 无条件覆盖（`2790`）；`done` 无条件 `take()` 且不校验 id（`2627`）。实际约束是「add 不得覆盖仍会收 delta 的项」加「任意 done 清空 active」 |
| 单 tool-argument consumer 约束 | 源码确认，作用域需收窄 | `active_tool_argument_diff_consumer` 单槽（`turn.rs:2528`、`2622`、`2726`–`2730`、`2936`）。注意 `function_call_arguments.delta` 在 Codex 侧没有映射，只有 `custom_tool_call_input.delta`（`codex-api/src/sse/responses.rs:370`、`535`），因此该冲突主要落在 custom tool 路径 |
| `done` 顺序决定历史、工具启动、最终消息 | 源码确认 | 工具分支 `core/src/stream_events_utils.rs:309`、`333`；历史追加 `stream_events_utils.rs:101`、`377` 与 `context_manager/history.rs:453`；`last_agent_message` 覆盖 `turn.rs:2704` |
| `output_index` 不作为排序键 | 源码确认（比计划更强） | `output_index` 不是 `ResponsesStreamEvent` 的字段（`codex-api/src/sse/responses.rs:169`–`190`），解析层即丢弃；全仓库未发现按 index 排序的消费逻辑 |
| `sequence_number` 的消费 | 未在源码找到 | `ResponseCompleted` 只取 id / usage / usage_metadata / end_turn（`codex-api/src/sse/responses.rs:118`–`125`），结构体无该字段 |
| SSE `id` / `Last-Event-ID` 的消费 | 未在源码找到 | 解析只用 `sse.data`（`sse/responses.rs:596`–`680`），`codex-rs` 内无 `Last-Event-ID` 引用 |

由此得到两点对本次实现的支持性结论：

- 计划 §2.2 的顺序权威判断成立。按 `output_index` 排序会改变历史追加顺序、工具启动顺序与
  `last_agent_message` 覆盖结果，属于可观察行为变化；当前实现在原文 done 位置展开，与 Codex
  的 done 序一致，不冲突。
- 顶层 `sequence_number` 的重编号对当前唯一认证客户端没有可观察风险；「非空 SSE `id` 即跳过」
  对本客户端是纯保守策略，不是缺陷。

## 4. Standards 轴

**硬违规：无。**

已核实的合规项：

- 模块边界：`native-sse-lifecycle-normalizer.ts` 零 `import`；生产侧只有 `handler.ts` 引用它
  （`rg` 全仓确认），没有跨 lane 耦合、projector、registry 或中间 bag；输入是字节加一个布尔
  事实，输出是判别联合，符合 AGENTS.md「小稳定契约」与计划 §3.3「不向纯 normalizer 传入
  Request、凭据、诊断对象或整个请求体」。
- 测试隔离：`test/online/run-provider-native-item-chain-replay.ts` 在 `tmpdir()` 下 `mkdtemp`
  建立全新 `CODEX_HOME`，显式传给 CLI 子进程，`finally` 中先校验路径落在 `tmpdir()` 内再递归
  删除；只读取用户 home 以定位 CLI 可执行文件。
- 门禁：`npx eslint` 对 8 个改动 TS 文件 exit 0；normalizer 单测 23/23 通过（已复现）。

判断题（baseline smell）：

| 类别 | 位置 | 说明 |
|---|---|---|
| Duplicated Code | `test/unit/provider-native-responses-contract.test.ts`、`test/integration/request-journey-provider-native-openai.test.ts`、`test/integration/request-journey-non-interference.test.ts`、`test/online/run-provider-native-item-chain-replay.ts` | 同一组 `msg_a` / `msg_b` SSE fixture 字面量重复十余处；四类 forbidden 诊断串在 `test/online/run-codex-cli.ts` 与回放脚本中各写一份。测试侧局部重复，代价可接受，但后续修改需同步多处 |
| Duplicated Code（解析权威） | `src/protocols/openai-responses/handler.ts:931` 相对 `:482` | `handleOpenAIResponses` 已把请求体解析为 `decodedBody.json`，`hasProviderNativeUpstreamCursorSemantics` 又对 `rawBody` 做一次 `JSON.parse`。建议把 eligibility 事实在调用点算好，只向 `providerNativeBranch` 传窄布尔值并移除 `rawBody` 形参 |
| 不可达状态 | `native-sse-lifecycle-normalizer.ts:375`、`:490` | `Frame.type` 与 `Chain.id` 均只写不读（`rg` 确认），属 `Speculative Generality` 与死状态，建议删除 |

Middle Man、Shotgun Surgery、Refused Bequest 一类问题未发现。`movedFrameCount` 一度被怀疑是
死字段，实际被 `doc/Research/provider-native-goat-corpus-certify.ts` 与
`provider-native-goat-capture-next-request-ab.ts` 消费，不作为发现。

## 5. Spec 轴

已满足：§2.1、§2.2、§2.3、§3、§3.1、§3.4、§4.1、§4.2；§5 的三个 notice code、六个 skip
reason（无 `midstream_global_barrier`）、三个 artifact 的采集关系与 no-throw 形状；§6 的四类
forbidden 诊断门禁与临时 `CODEX_HOME` 隔离。

### 5.1 缺口

1. **§6 步骤 5 的断言强度不足。** `test/online/run-provider-native-item-chain-replay.ts` 的工具
   历史用例只断言第二次请求含两个 call_id 与一个 `function_call_output`，而 call_id 也出现在
   回显的 `function_call` 项中，无法证明两个工具结果都存在且顺序正确；reasoning 用例只检查最终
   消息，未核对 reasoning 归属。
2. **§6 步骤 4 的故障模式不全。** 新 Provider Native 路径只比较了「diagnostics disabled」与
   「throwing」；saturated / slow / unavailable 未在这条路径上比较。skipped 分支只在内存单测
   验证，点名文件未覆盖持久化 notice。
3. **§6 步骤 3 的部分边界缺回归。** 非 SSE JSON 与上游 HTTP 错误有测试；Direct、Semantic、
   compact 没有新增证据（代码路径确实未被触碰，但计划要求测试）。
4. **§7 的文档状态说明不完整。** `ProviderNativeResponsesCodexSseCompatibilityReport.md` 已加
   指向本计划的状态行，`ProviderNativeResponsesItemChainToolOrderAudit.md` 尚未添加。
5. **serving conformance record/hash 未更新。** `doc/TokenArchitecture.md` 第 2452–2454 行要求
   涉及协议或 serving boundary 的修改必须更新对应 conformance record/hash。
   `test/fixtures/certification/serving-conformance-v2.json` 的 `responses-provider-native`
   profile 证据清单正好包含本次改动的
   `test/unit/provider-native-responses-contract.test.ts` 与
   `test/integration/request-journey-provider-native-openai.test.ts`，而
   `test/support/commandcode-serving-certification.ts` 的 `SERVING_CONFORMANCE_REVISION` 仍是
   旧值。`test/certification/serving-composition-sync.test.mjs` 只校验「绑定值 == 记录内容
   hash」，因此该测试不会因行为变化而变红——这正是文档所说「不能只让普通 unit tests 变绿」
   的情形。

### 5.2 待决：无身份音频帧的归类

计划把「global 相对 added/delta 的位置」列为允许改变的内容（§2.2 第 6 条），同时要求
「明确是 item-local 的结构却缺失归属信息，返回 `skipped`，不得伪装成 global」（§3.1）。当前
实现按事件名前缀白名单判定 item-local，音频族不在其中，于是被判为 global。

事实（已复现 + SDK 形状确认）：`response.audio.delta` 与 `response.audio.transcript.delta` 携带
`delta` / `sequence_number` / `type`，**既无 `item_id` 也无 `output_index`，也没有
`content_index`**；在已安装 SDK 的 54 个事件接口中，只有这两个是「有 `delta` 但无 item 身份」
的接口。实测输入 `added → audio.delta → done` 时输出为
`audio.delta → added → done`，即内容级事件被移到了所属 item 的 `added` 之前，且返回
`kind: normalized`。

两种可选定性，必须择一：

- **按 §3.1 保守归类**（建议）：把音频族纳入 item-local 判定，无身份时返回
  `skipped/unsupported_event_attribution`，原始 body 不变。对 Codex 无可观察影响（该客户端
  不映射音频事件），但避免把内容级事件搬离其 item。
- **明确写成 global**：若判定为 global，则应在计划 §2.3/§3.1 显式记录音频族属于允许重排的
  独立帧，并说明其与 `added`/`delta` 的相对位置变化已由 §2.2 第 6 条授权。

现状是两者都没写明，属于规范空洞而不是实现偏离；在补齐之前，本条目记为待决而非缺陷。

### 5.3 待明确

`item_commit_order_differs_from_output_index` 按 §5 定义为「规范化结果的 index 顺序差异」，
因此已串行但 done 与 index 逆序的流返回 `unchanged` 且不发 notice。按 §5 字面成立，但 §6
步骤 2 表格中「逆序 index、done B→A …给出诊断事实」读起来更强。建议在计划中写死：该 notice
只在 `normalized` 分支产生，`unchanged` 分支不产生。

## 6. 已复现缺陷与建议修复

### 6.1 P1：帧内裸 CR 行结束符导致字节损坏（已复现）

根因：`native-sse-lifecycle-normalizer.ts:190` 的行扫描正则只识别 `\r\n` 与 `\n`，而
`:222` 用「行长 + 行尾长」累加 `rawOffset`。裸 CR 行既不进入扫描、又不计入偏移，使后续
`sequenceSpan`（`:358`）整体前移；`renumber`（`:391`）随后就按错误区间改写字节。

复现（帧内首行为 `: bare-cr comment\r`，其余帧为常规 LF）：

```text
输入 帧 1: ": bare-cr comment\revent: response.output_item.added\ndata: {...sequence_number:10}"
结果: kind = normalized
损坏: ..."type":"message"},3equence_number":10}
```

`sequence_number` 的键名首字母被新序号覆盖，值反而保持原样。CR 是 SSE 合法行结束符
（CR、LF、CRLF 三者等价），计划 §3.2 的意图是「帧边界不完整等，不重构，返回原始 body」，
因此正确结果是 `skipped/invalid_sse_structure` 并返回原始字节。

建议修复：用 `match.index` 推导每行的真实偏移，取代长度累加；或显式检测裸 CR 并直接跳过整份
body。验收测试：帧内含裸 CR 且需要重排时返回 `skipped/invalid_sse_structure`，且返回字节与
输入完全相同；同时补一条裸 CR 的合法单帧用例，确认不会因此走到重建路径。

影响面：只在「该帧需要重编号」且「帧内有裸 CR 行」时触发，实际 Provider 很少发送裸 CR，因此
是低频的硬化问题；但它是 preservation lane 内的静默内容改写，方向为 fail-open，严重度高于
其他发现。计划 §9 记录的那轮 review 修掉的三条边界问题属于同一类，这条是漏项。

### 6.2 P2：无身份音频帧被当作 global（已复现）

见 §5.2。建议按 §3.1 保守归类，并加一条结构测试：音频帧夹在 `added` 与 `done` 之间时，
不得出现 `audio.delta` 先于其 `added`。

### 6.3 P3：证据强度与记录

按 §5.1 条目逐项补齐。其中建议优先做两件：

- 回放脚本按 call_id 逐对断言 `function_call` 与 `function_call_output` 的存在与相对顺序，
  并核对 reasoning 项归属，而不是只看最终文本。
- 在 `request-journey-non-interference.test.ts` 为规范化路径补 saturated / slow / unavailable
  三种故障模式，与现有 throwing 用例共用同一份 exchange 快照比较。

### 6.4 P4：清理

删除 `Frame.type` 与 `Chain.id`；把 provider-native eligibility 事实在调用点算好，移除
`providerNativeBranch` 的 `rawBody` 形参与重复的 `JSON.parse`。

## 7. 未完成与边界说明

- 本次未运行完整 `npm test`、`npm run typecheck`、`npm run build` 与
  `npm run test:online-codex:private|goat`。计划 §9 声明的完整回归与双 Provider 在线认证是原
  提交的结果，本次审阅未复现，也不对在线结论背书。
- 本次未修改任何文件；§6 的修复建议均为提案。
- 审阅期间多 agent 通道一度不可用，Standards 轴报告晚于其他两轴到达；其「音频事件缺失身份」
  条目经本次独立复核后确认为事实，但定性从「硬违规」调整为「规范空洞 + 待决」（理由见 §5.2：
  计划 §2.2 第 6 条已授权 global 相对 delta 的位置变化）。
- 计划 §9 的「最终 code-review 已完成」记录在本次审阅后应补充指向本文件，并注明 P1 与 P2
  为新增发现。

## 8. Follow-up 实施状态

后续 worktree 保留原有「在原始 done 位置展开完整 chain」算法，只修复 preservation 与认证缺口。

已完成并经定向验证：

- **P1 已修复**：任何裸 CR 在 frame/span 分析前触发
  `skipped/invalid_sse_structure`，原始 body 字节保持不变；LF/CRLF 既有路径不变。
- **P3 回放断言已加强**：第二轮请求按结构核对 function call 名称、arguments、call_id 对应的
  output 与顺序，并核对 reasoning item 的 identity/summary。
- **真实 custom-tool consumer 已覆盖**：使用 Codex app-server 的
  `item/fileChange/patchUpdated` 观察真实 `custom_tool_call_input.delta` consumer。
  raw 交错控制只保留后一个 patch attribution；经过 production Provider Native normalizer 后，
  两个 call_id 的 patch diff 均正确归属。该结果直接覆盖
  `active_tool_argument_diff_consumer` 单槽冲突，而不是此前 Codex 不消费的
  `function_call_arguments.delta`。
- **diagnostics 非干扰补齐**：Provider Native normalization exchange 已比较 disabled baseline、
  throwing、slow、saturated、unavailable；skipped 分支补齐持久化 notice、artifact 关系与成功 outcome。
- **P4 已清理**：删除未消费的 `Frame.type` / `Chain.id`；background 事实从已解析 body
  提取，`rawBody` 仍仅作为 Provider Native 原样转发权威。
- **serving conformance 记录已同步**：`responses-provider-native` profile 纳入 lifecycle
  normalizer 与 diagnostics non-interference 证据，并重新绑定 record hash。

P2 audio 仍按原实现保留为已知边界，不在本 follow-up 改变事件归属。更准确的事实是：
`response.audio.delta` / `response.audio.transcript.delta` 是无 item identity 的
content-bearing response events；当前 normalizer 将其视为 global，因此其相对 output-item
lifecycle 位置可能改变。当前认证客户端 Codex 不消费这两个事件，本次认证不外推到 audio-capable
downstream。

最终再认证已完成，权威汇总见修改计划 §10：

- Codex CLI 0.156.1 隔离 production replay 全部通过，包括真实
  `custom_tool_call_input.delta` patch diff consumer；
- Private / Goat 在线 Codex 均 22/22 PASS、0 failure；
- typecheck、ESLint、serving conformance sync、`git diff --check` 全部通过；
- `npm test`：Certification 70/70、主仓库 269 files / 2346 tests、
  Desktop 20 files / 112 tests 全部通过；
- `npm run test:distribution`：完整 build、tarball 安装、Desktop tests 与
  packaged product E2E 7/7 全部通过。

因此 P1、P3、P4 已关闭。P2 audio 仍只作为已知边界记录，不外推为 Codex certification。
