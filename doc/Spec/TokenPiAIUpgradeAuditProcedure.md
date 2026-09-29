# Pi AI 升级审计流程

状态：**当前流程**。适用于每次更改运行时依赖 `@earendil-works/pi-ai`，无论版本号变化大小。本文规定如何判断 Token 哪些地方需要修改；具体协议边界仍以各自的架构规范为准。

## 结论与判定原则

Provider Native 与 Pi 当前通过 npm 去重共用已安装的 `openai` / `@anthropic-ai/sdk`。Token 直接导入这些 SDK，因此仍需在根 `package.json` 直接声明与新 Pi manifest 相同的版本。`test/unit/provider-native-sdk-identity-gate.test.ts` 检查版本一致性；`npm ls` 再确认本次安装是否实际去重。共用 SDK **不等于**共用 Pi 的请求构造或响应解析；Native 的信封、例外和响应处理仍须做行为审计。

每个结论分为四类，并记录证据：**必须修改**（公共契约、行为或 Token 镜像已变化）、**只改版本/证据**（实现仍正确）、**无需修改**（相关 Pi 行为未变且回归通过）、**无法离线确认**（需要真实上游才能证明的事实）。编译通过只能证明类型仍匹配；测试通过也不能代替对新 Pi 运行时代码的差异审查。

## 1. 升级前保存基线

1. 在独立分支记录基线 commit、根及 workspace 中的 Pi/SDK 版本、`npm ls @earendil-works/pi-ai openai @anthropic-ai/sdk --all` 结果和离线测试结果。不要覆盖无关的未提交改动。
2. 在安装新版本**之前**保存当前 `node_modules/@earendil-works/pi-ai/package.json` 与 `dist/` 到临时审计目录。升级后保存新版本的相同文件，按文件名和内容比较 `.d.ts` 与 `.js`。比较的是实际发布包；`pi-agent/` 快照可能与运行时版本不同，只能辅助阅读。
3. 记录旧、新 Pi 的 `dependencies`、`exports`、公开 `Context` / `TranscriptContext` / `Model` / `AssistantMessage` / options / Provider 接口及变更说明。即使类型未变化，也要检查下表中的运行时行为。

## 2. 安装与依赖一致性

1. 更新根 `@earendil-works/pi-ai` 精确版本、引用 Pi 的 workspace 依赖或 peer dependency、lockfile。不要自动改动独立的 `pi-coding-agent` 模型配置兼容基线：只有其 schema 或组成契约确实变化时才改。
2. 读取**新安装**的 `node_modules/@earendil-works/pi-ai/package.json`。若 Pi 的 `openai` / `@anthropic-ai/sdk` 依赖变动，同步根直接依赖到相同精确版本并重装。运行 `npm ls @earendil-works/pi-ai openai @anthropic-ai/sdk --all`，记录是否 `deduped`；嵌套副本或不同版本必须解释和修正。
3. 搜索硬编码版本和来源证据：`rg -n '0\.87\.0|Pi 0\.87|pi-ai@|@earendil-works/pi-ai' src packages test doc/Spec --glob '!*.map'`。按语义逐条更新，不对历史审计文档做盲目替换。当前 `test/unit/pi-ai-boundary-architecture.test.ts` 有精确版本断言，升级时必须审查。

## 3. 按边界审查变更

| 边界 | 与新 Pi 对照的重点 | Token 位置和离线证据 |
|---|---|---|
| 依赖与公开 API | `exports`、类型、SDK 版本、Node 要求、Provider 注册入口 | 根/workspace manifests、lockfile；typecheck、T7 SDK gate |
| 模型与认证控制面 | 内置 Provider/model、`Models`、配置合成、`models.json` schema、凭据解析、catalog refresh | `src/providers/`、`src/credentials/`、`packages/commandcode-model-catalog/`；catalog、credential 测试 |
| Semantic Conversion：公共语义 | `Context`/options、normalization、reasoning levels、工具/媒体/连续性、`AssistantMessage` | `src/protocols/openai-responses/`、`src/protocols/anthropic/`、`src/pi-context-compatibility*`；两协议转换与 continuity 测试 |
| Semantic Conversion：Provider 执行 | 各 Pi `dist/api/*.js` 的 request builder、校验、transport、response parser；自定义 Provider 的 `TranscriptContext`/event 契约 | `src/execution.ts`、`packages/provider-*/src/`；Pi payload/fidelity、CommandCode 测试及本地 capture fetch |
| Provider Native Preservation | OpenAI/Azure/Codex/Anthropic 的 URL、method、完整 headers、SDK 序列化、beta/session/timeout/auth、重试与响应侧有界重写 | `src/provider-native-responses/`、`src/provider-native-anthropic/`；Pi parity、header matrix、lifecycle、response tests；详见 `TokenProviderNativeEnvelopeParityPlan.md` §9 |
| Direct Mode | 确认仍不依赖 Pi 或 Native 的构造/transport；只有共享外层路由或类型契约变化才需要改 | Direct Mode 自身契约与 lane 隔离 certification；Pi 升级本身不触发其 wire 改造 |
| 产品及观察面 | model discovery、错误/usage、diagnostics callbacks、Desktop 展示是否依赖变更的 Pi 字段 | serving/diagnostics/desktop 相关测试；只在实际依赖变化时修改 |

先对差异建立“Pi 变更 → Token 消费者/镜像 → 预期影响”的对应关系，再修改代码。Semantic 只映射 Pi 公开中性语义，不在 Client Protocol 补写 Provider 字段；Provider Native 不进入 Pi IR；Direct Mode 保持独立。若 Pi 新增能力，只有当前 Client 契约要求消费它时才实现，不能仅因类型出现就扩展行为。

## 4. 离线验证顺序

所有可能触及 Codex 状态的测试使用仓库守卫命令，它会创建并清理临时 `CODEX_HOME`。以下命令不调用真实 Provider；**不要运行任何 `test:online*`**。

1. `npm run typecheck`；定位公开 API 和 workspace 类型破坏。
2. `npm run test:certification`；验证 lane、依赖、认证边界。
3. `npm run test:unit`；包括 SDK T7、Native Pi parity、Semantic 请求/响应/continuity、模型与认证回归。
4. `npm run test:integration`；包括 Pi payload/fidelity、Semantic 完整请求、Native 本地 stub 上游、catalog/凭据/serving。
5. 变更涉及打包或 Desktop 时，再运行对应发行/产品检查。上述测试的 capture fetch 或本地 stub 只能证明它们覆盖的请求与响应；真实上游接受度、限流及在线响应差异记为“无法离线确认”，不得写成“已通过”。

若测试失败，先判断是 Pi 合同变化、SDK 版本漂移、Token 镜像变化，还是旧测试的版本/fixture 断言。修复后重跑受影响范围及上述门禁。若全部通过，仍需逐项审阅第 3 节的运行时差异，尤其 Native 信封和 Pi Provider 的静默行为变化。

## 5. 每次升级的审计记录

在 `doc/` 新建一份按版本命名的 upgrade audit，至少写明：

```text
旧版 → 新版；审计 commit；实际安装的 Pi/SDK 版本及 npm ls 去重结果
Pi 发布包差异：公开类型、运行时适配器、Provider/model/auth、依赖
边界判定：依赖/API、控制面、Semantic 两协议、自定义 Provider、
          Provider Native 各 API、Direct Mode、产品/观察面
每项：Pi 变化证据 → Token 受影响文件/测试 → 四类结论 → 改动或无需改动的理由
离线命令与结果；未验证的真实上游行为；文档/版本常量更新
```

完成标准：所有第 3 节边界都有明确结论，必要代码与契约文档已修改，依赖图与 SDK 版本一致，离线门禁通过；在线事实如未测试，明确保留为未验证。历史审计 `doc/PiAI-0.84.2-Upgrade-Audit.md` 可参考记录形态，但它的结论不适用于当前运行时。
