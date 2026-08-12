# LuckyToken 项目交接说明

**交接基线：** `ac9fa9a`（`fix: record tool-call ids when appending to an existing assistant turn`）<br>
**记录日期：** 2026-08-12<br>
**用途：** 让新的维护者或 Agent 不依赖先前对话，也能从当前实现继续工作。

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

当前离线测试 **479 个全绿**（certification 6 + vitest 479）。

真实在线 gate（需授权 + 真实 key，产生真实调用与费用）：

```powershell
npm run test:online            # Anthropic 通道线上套件（既有）
npm run test:online-responses  # OpenAI Responses 通道线上套件（新增）
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
- **Codex 模型元数据**：`model_catalog_json` 是 Codex **根级**字段（`--strict-config`
  拒绝放在 `[model_providers]` 里），所以 catalog 通过独立 profile 提供；
  `env_key` 让 Codex 从环境变量读 LuckyToken token，不触碰 `auth.json` 的
  OpenAI key。
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

- 用真实 Codex CLI 指向 `http://127.0.0.1:3000` 做端到端验证（`/v1/models` 发现 +
  `/v1/responses` 增量续会话）；
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
