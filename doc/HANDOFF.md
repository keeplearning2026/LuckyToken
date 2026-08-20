# LuckyToken 项目交接说明

> **历史交接快照（非当前权威）**：本文固定在 2026-08-12 的 `ac9fa9a`，其中测试
> 数量、`store:false`、certification v1 和待办描述不代表 Ticket 20–28 完成后的合同。
> 当前事实以 `doc/Protocols/` 的冻结规范、`doc/LuckyTokenArchitecture.md`、
> `serving-conformance-v2.json` 与当前 ticket completion evidence 为准。
>
> **2026-08-14 current pointer:** `main` baseline `41007a5` delivers CommandCode
> through `@luckytoken/provider-contract` and
> `@luckytoken/provider-commandcode-private`, loaded generically from
> `node_modules`. Distribution evidence is `online-passed` (Direct 23/23,
> Anthropic 60/60, Responses 60/60, Codex 60/60, Claude 51/51). All old source
> paths, discovery constants, session policies, and evidence-status statements
> below remain part of this historical snapshot only.

**交接基线：** `ac9fa9a`（`fix: record tool-call ids when appending to an existing assistant turn`）<br>
**记录日期：** 2026-08-12<br>
**用途：** 保存当时的交接背景；不得作为当前实现状态或验收 authority。

## 1. 当前状态

- 生产组合现在提供 **两个 Client Protocol** + 一个共享模型发现端点：
  - `POST /v1/messages`（Anthropic Messages，既有）
  - `POST /v1/responses`（OpenAI Responses，新增，Codex 客户端）
  - `GET /v1/models`（无认证的跨协议模型发现，新增，只暴露 LuckyToken 自有 provider）
- OpenAI Responses adapter 支持 Codex 的「增量请求 + `previous_response_id` 历史拼接」：
  会话历史**持久化到磁盘**（`stateFile`，默认 `<config-dir>/state/openai-responses.json`），
  重启后 Codex 续会话不丢。Provider 只看到展开后的完整 Pi 历史。
- 会话状态语义（grilling 已确认）：无条件保存（忽略 `store:false`）、fail-open 展开、
  展开失败的那一轮不保存（反污染）、1000 条 FIFO 上限、32MB 快照解析上限、无 TTL、
  2s 防抖原子写（tmp+rename）、损坏快照备份 `.corrupt` 后空启动、孤儿 tmp 清理、
  shutdown flush。
- 新增真实 Provider 线上套件 `npm run test:online-responses`（`test/online/run-openai-responses.ts`），
  覆盖：36 JSON + 14 SSE + 5 取消（并发 5）+ 链式展开 + 重启恢复 + 工具轮次 +
  store:false + 认证隔离 + 模型发现。真实 CommandCode 上游，全绿。
- 新增 **Codex CLI 真实客户端线上套件** `npm run test:online-codex`
  （`test/online/run-codex-cli.ts`）：自托管当前代码的服务（随机端口 + 干净
  stateFile），spawn 真实 `codex -p luckytoken exec`，覆盖一次性对话、多轮
  `resume`、工具往返、重启恢复、取消、随机组合；17 场景覆盖矩阵，服务端快照
  健康检查（无孤儿、usage 形状）。
- 新增 **Codex 请求样本回放测试**（`test/integration/openai-responses-replay.test.ts` +
  `test/fixtures/codex-cli-requests/`）：固化 27 个真实 Codex CLI 请求（清洗后），
  离线回放验证「官方客户端真实形状」的协议转换，不依赖网络/Codex CLI。
- 本次线上测试暴露并 TDD 修复的真实 bug：
  1. 孤儿 `function_call_output` 曾致整轮 400 → 转换层宽容丢弃 + 存储层清洗 +
     加载时自愈（磁盘遗留孤儿自动清洗写回）；
  2. apply_patch 等 freeform 工具曾输出 `function_call` 致 Codex
     "incompatible payload" → 输出 `custom_tool_call`（`input` 字段），
     `freeformToolNames` 从 request 传到 response；
  3. 多轮 `previous_response_id` 链曾丢历史（remember 存未展开增量）→
     remember 存展开后完整历史（真实 Codex 3 轮 resume 跨轮记忆已验证）；
  4. 重启后 resume 曾连旧端口 → restart 回调返回新 baseUrl；
  5. Codex 退出码 -1 偶发崩溃（MCP shutdown 竞态）→ 断言以协议结果为准。
- 新增共享 `src/protocols/options.ts`（中立 composeOptions，两个协议共用）与
  `src/protocols/upstream-failure.ts`（中立上游 HTTP 失败映射），消除跨协议 import。
- 当前分支 `codex/openai-responses-protocol`，提交历史：
  - `2ade5f0` feat: OpenAI Responses Client Protocol adapter（+ spec + tickets）
  - `ca2c009` test: 真实 Provider 线上套件
  - `8cb1bd5` feat: GET /v1/models 模型发现
  - `d25e3c8` feat: /v1/models 只暴露 LuckyToken 自有 provider
  - `9ee6f26` docs: 交接文档
  - `b657378` fix: 启动打印全部注册路由（runtime 暴露 `routes`）
  - `4949e51` fix: 兼容 Codex 客户端工具形状（parameters 归一化、跳过
    OpenAI 托管工具、custom/namespace 展平）
  - `e1e9d78` docs: README 增加 Codex CLI 接入章节
  - `ac9fa9a` fix: 追加到已有 assistant 的 function_call 也记录 call_id 索引
- 工作树未跟踪文件（用户所有，勿动）：`codex 配置方法.md`、`,temp/`。
- **Codex CLI 已真实接入并验证**：`codex -p luckytoken` 通过本地
  `/v1/responses` 用 `commandcode-private/deepseek/deepseek-v4-flash` 完成真实
  对话。Codex 侧配置在 `~/.codex/`（config.toml 的 `[model_providers.luckytoken]`、
  `luckytoken.config.toml` profile、`luckytoken-catalog.json` 模型元数据），
  详见 README「Using the OpenAI Responses endpoint from the Codex CLI」。

## 2. 首先阅读的权威资料

按以下顺序建立上下文：

1. [仓库工作原则](../AGENTS.md)；
2. [OpenAI Responses Client Protocol Spec](./Protocols/OpenAI Responses Client Protocol.md)
   （v0.1.0，含决策记录 D1–D12）；
3. [opencodex 调研报告](./OpenAIResponsesAdapter-Research.md)（参考语义来源）；
4. [LuckyToken × opencodex 对比报告](./OpenAIResponses-vs-opencodex-Comparison.md)
   （8 维度逐项对比 + 双向借鉴点 + 风险清单）；
5. [LuckyToken Core Spec](./Spec/LuckyTokenCoreSpec.md)（architecture/ownership）；
6. [OpenAI Responses tickets](../.tickets/openai-responses-2026-08/INDEX.md)（01–05，
   均已实现）；
7. [README](../README.md)（安装、配置、登录、运行、在线测试命令）。

不要用本交接文件替代上述规范。若文档与代码冲突，先定位冲突属于 Protocol、Conversion
还是 Architecture，再在 owning authority 修复。

## 3. 不可破坏的核心边界

```text
Client Wire ↔ Client Protocol ↔ Pi public contracts ↔ Provider ↔ Provider Wire
```

- OpenAI Responses Client Protocol 只拥有 Responses Wire ↔ Pi 转换 + 自己的会话状态；
  绝不 import 任何具体 Provider（adapter 目录内无 commandcode/anthropic 引用，已用
  rg 验证）。
- 历史拼接（`previous_response_id` 展开）是 **Client Protocol adapter 的职责**，
  Provider 只看到完整历史；不引入第二 IR。
- `GET /v1/models` 是**无认证**的跨协议元数据端点（`src/models-discovery.ts`），不绑定
  任何 Client Protocol 的 Auth；wire 格式（Responses list shape）由
  `src/protocols/openai-responses/models.ts` 拥有，`models-discovery.ts` 持有
  暴露策略（`DISCOVERED_PROVIDERS = {"commandcode-private"}`）。
- 每个 Client Protocol 有独立 Auth 实例 + 独立 token 文件（AGENTS.md 硬约束）；
  只有 `sessionId`/`projectDir` 能进入 Pi option composition。
- `pi-agent/` 整棵树不可修改；`@earendil-works/pi-ai@0.84.1` 是生产依赖。
- 认证隔离已被测试锁定：anthropic token 打 `/v1/responses` → 401，反之亦然。

## 4. 工作区与敏感资料

- `.luckytoken/`、所有 `auth.json`、`CommandcodeAPIKey.txt`、`.online-artifacts/` 均被
  `.gitignore` 排除。
- 不要读取、复制、打印或提交真实 API key（包括 `.luckytoken/pi/auth.json` 与
  `CommandcodeAPIKey.txt` 里的值）。线上 runner 只在内存中读 key。
- 本地 `.luckytoken/config.json` 已手动加入 `openai-responses` 条目（authFile +
  stateFile）并创建了 global token；这些是本地运行状态，不提交。仓库只保留
  `luckytoken.config.example.json` 占位符。
- 开始修改前运行 `git status --short`。用户已有改动（`codex 配置方法.md`、`,temp/`）
  属于用户，不要重置、覆盖或清理。

## 5. 验证与完成标准

普通离线 gate：

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

当前离线测试 **516 个全绿**（certification 6 + vitest 510，含 29 个 Codex
样本回放测试）。

真实在线 gate（需授权 + 真实 key，产生真实调用与费用）：

```powershell
npm run test:online            # Anthropic 通道线上套件（既有）
npm run test:online-responses  # OpenAI Responses 通道线上套件（新增）
npm run test:online-codex      # Codex CLI 真实客户端套件（新增，自托管服务）
```

`npm test` 不访问真实 CommandCode。涉及协议、Pi revision 或 serving boundary 变化时，
还要更新 certification record 与 immutable hash（`src/commandcode-serving-certification.ts`
与 `test/fixtures/certification/serving-conformance-v1.json` 目前未包含 OpenAI Responses
——openai-responses 不在 certified 范围内，若未来纳入需同步）。

## 6. 已知设计取舍与未决事项

不要把已记录取舍误判为可顺手修复的问题：

- **Anthropic SSE 与 Responses SSE 都是 Atomic**：Pi 结果完整 commit 后生成
  事件序列，不是实时 token forwarding。Responses SSE 序列为
  `response.created → output_item.done ×N → response.completed → data: [DONE]`。
- **`/v1/models` 只暴露 `commandcode-private` provider**（用户已确认方案 B）。
  若未来需要暴露其他已配置 provider，修改 `models-discovery.ts` 的
  `DISCOVERED_PROVIDERS` 即可；若要"只暴露已配置凭据的 provider"（方案 C），需要
  在 discovery handler 中查询 `CredentialStore`，当前未实现。
- `store:false` 被无条件忽略（本地代理缓存语义，与 OpenAI 服务器存储无关）。
- **Codex 客户端工具形状兼容**（真实 Codex CLI 暴露，已修复）：`tools[].parameters`
  缺失/非对象时归一化为 JSON Schema 对象；OpenAI 托管工具（`web_search`、
  `image_generation`）跳过（本地 Provider 无法执行）；`custom` freeform 工具转成
  单 `input` 参数的 function；`namespace` 组展平；追加到已有 assistant 的
  `function_call` 必须同步记录 call_id → tool_name 索引（否则后续
  `function_call_output` 报 unknown tool call id）。
- **Codex 模型元数据**：LuckyToken 仅管理用户级 `$CODEX_HOME/config.toml` 的三个
  根级字段：`model_provider = "openai"`、`openai_base_url = <LuckyToken /v1>`、
  `model_catalog_json = <LuckyToken-owned catalog>`。Codex 原生 row 来自当前 Codex
  bundled catalog（失败时只读 `models_cache.json`）；LuckyToken 注入 row 统一以 alias
  作为 `slug`/`display_name`。`auth.json` 不参与 Integration Enable，只在请求实际命中
  Local Native 时作为 read-only credential authority。
- **CommandCode 4 个模型对外可发现 + Codex 可选**（用户已确认）：`deepseek-v4-flash`、
  `deepseek-v4-pro`、`gpt-5.6-luna`、`Qwen/Qwen3.7-Flash`，selector 契约
  `provider/model_id`（首个斜杠分割，model_id 可含斜杠）。`/v1/models` 已暴露
  （`DISCOVERED_PROVIDERS` 含 provider 全部模型）；Codex 侧
  `~/.codex/luckytoken-catalog.json` 含 4 个条目（用户主目录，非仓库）。
  注意：`gpt-5.6-luna` 当前上游返回 "not available in your region"（502，
  稳定地区限制），保留在 catalog。
- **Codex 配置与对话历史的 provider 隔离**（已实证）：桌面应用与 CLI 共享
  `~/.codex/config.toml`；对话历史存 `state_5.sqlite` 的 `threads` 表，
  **按 `model_provider` 列区分**（有 `idx_threads_provider` 索引），内容在
  `~/.codex/sessions/.../rollout-*.jsonl`（按会话 id 匹配，全在）。
  opencodex 时代的会话标签是 `openai`（它借用 openai 身份注入 base_url）；
  改用 luckytoken 后 UI 按 provider 过滤，旧记录不丢但被隐藏。
- **Codex Integration 生命周期**：Enable/Startup/Sync/Disable/Application Exit 全部
  经一个 `CodexIntegrationAuthority` 收敛。Active 时 Authority 同步发布 LuckyToken
  catalog 与同一 native snapshot 派生的内存 Local Native set；Disable/正常退出恢复
  本次 Active 前第一次观察到的三个 root key 状态并清空 native set。退出不会改写
  durable Enable 意图，因此下次启动会重新观察新的 preimage 后再次注入。
- 单实例假设：快照不做跨进程锁；多实例共享历史是后续分布式问题。
- SSE 为原子合成序列，首版不做逐 delta 流式。
- opencodex 的重量级设施（spill、加密 payload、compaction 缓存、metrics）未移植，
  有意为之。

## 7. 下一项工作的推荐流程

1. 先确认用户目标是否已有 ticket/spec authority；没有时先形成窄 ticket。
2. 沿上文阅读顺序读取完整调用链和 owning tests。
3. 明确新信息的 producer、carrier、semantic consumer 和 death point。
4. 用最小垂直切片执行 red → green → refactor；协议故障覆盖 malformed、unsupported、
   abort 和 terminal consistency。
5. 只在对应 owner 内修改，用 import-boundary 测试防止 Client Protocol 与 Provider
   越过 Pi 耦合。
6. 运行与风险相称的验证；按 ticket 单独提交并更新 ticket 状态/认证证据。

**候选下一步**：

- Codex Integration 若与其他仍在运行的配置管理器同时控制同一 `config.toml`，应由用户
  明确选择唯一运行中的配置 owner；LuckyToken Enable 本身的契约是对三个 root key
  做确定目标收敛，而不是与另一个 manager 争抢写入。
- 若需要，把 OpenAI Responses 纳入 serving certification 范围（当前不在）；
- 方案 C（按已配置凭据过滤模型）若用户提出再实现。
- **与 opencodex 的全面对比已完成**（交付物
  `doc/OpenAIResponses-vs-opencodex-Comparison.md`）：8 维度逐项对比，结论是
  LuckyToken 为最小化、边界收紧的重写；报告末尾列出 LuckyToken 可借鉴
  opencodex 的 6 个改进点与风险清单（如快照单条/总量裁剪、miss 可观测性、
  symlink 目录清扫等），可作为后续迭代的输入。

## 8. Suggested skills

- `$tdd`：实现或修复协议、生命周期、取消、配置与集成行为时使用，一次一个 red→green
  垂直切片。
- `$code-review`：提交前按仓库规范与 ticket/spec 两条轴审查变更，尤其检查边界 import
  和信息生命周期。
- `$implement`：处理新的明确 ticket 时使用；先读 spec 和当前 ticket，再按依赖顺序
  实施与独立提交。
- `$grilling` / `$grill-me`：对未决设计点先质询需求再动手，不要盲从既有默认。
- `$handoff`：下一次跨会话转交时更新此文件中的基线、工作树、验证结果和未完成事项；
  不复制已经写入 spec、ticket、架构文档或 commit 的内容。

## 9. 本次交接的立即动作

新维护者接手后先执行：

```powershell
git status --short
git diff --check
git log --oneline -5
```

然后确认：分支 `codex/openai-responses-protocol` 上的四个提交（adapter / 线上套件 /
模型发现 / 模型范围过滤）与本文基线一致；本地 `.luckytoken/` 的运行配置与 token
不属于仓库内容；`/v1/models` 范围已定（方案 B），若用户后续要求方案 C 再扩展。
