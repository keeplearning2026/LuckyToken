# Pi AI 1.0.0 升级与架构收敛审计

日期：2026-10-03。基线 commit：`3556847ce38b48b9c0b5d40466219abab71cbbe6`。
运行时：`@earendil-works/pi-ai` 0.87.0 → 1.0.0；以实际 npm 发布包为证据，参考包为 `reference/pi-ai-1.0.0/`。`pi-agent/` 的 coding-agent 0.84.2 配置兼容基线保持独立。

## 结论

升级困难的主要原因有两个：Token 对整个 Pi `Models` 做了不完整的实现/类型断言；Semantic 的配置 facade 自己执行认证应用、normalization 和 Provider dispatch。第三个长期约束是 Native 复制了 Pi 没有公开的信封逻辑。固定公开接口能够消除前两类重复实现；无法保证私有 wire 行为在公开类型未变时保持不变。

本次已完成的生产架构变化：

- `src/chat-models.ts` 直接 `Pick` Pi 公开 `Models`，明确 Token 消费的聊天/控制面能力；没有新增共享语义执行器。catalog snapshot 和配置 facade 用此类型声明实际实现，删除完整 `Models` 断言。新增 image/classifier 操作不扩大 Token 能力。
- `request-composition.ts` 的执行操作直接调用实际 Pi Models。模型级配置 header 通过公开 `transformHeaders` 合成；Provider 级认证配置通过公开 Provider auth 合成。删除自行执行的 normalization、lazy stream、认证应用和 Provider dispatch。Pi 的新实现随依赖原地更新。
- header transform 的公开参数只有 headers，没有 auth env。配置 auth 将公开解析结果的 env 传入请求局部 `AsyncLocalStorage` 回调；每次执行独立，认证只解析一次。该基础设施状态不进入 Context、语义 options 或 Client 状态。Native `getAuth` 仍提供完整配置 header。
- `ModelsStoreEntry.models` 按 `AnyModel` 校验并完整持久化。聊天 serving 使用 Pi 的 `getModels()`；动态归属的 id 集合也只取 `isModelType(model, "chat")`，避免 image 与 chat 同 id 时误标动态模型。
- 内部有效模型事实类型派生自公开 `Model`，基础模型按完整事实合成，保留 `promptCache` 等新增字段；公开 Control Plane projection 仍只暴露自己的契约字段。
- 两个 DeepSeek Provider 直接读取公开 `deepseekProvider().getModels()`，不再维护价格、reasoning、limits、input 等数据快照。Token 只选择已支持的两个 id 并设置目标 API compat。
- Native 使用局部自动 vendoring：OpenAI client/认证头检查、Azure client/config/deployment、Codex URL/headers/zstd、Anthropic client/compat/beta/身份直接从发布包选取有限依赖。Native 只保留 body/header 事实适配及自身 transport/Response ownership。公共 User-Agent/env lookup 仍直接调用 Pi。
- 认证的运行时身份读取安装包与 lockfile；模型数据测试比较公开 catalog。Desktop 图标认证使用既有首字母 fallback 验证新增 Provider 的渲染，不再强制每次 Pi 新增/删除品牌都修改本地 SVG 表。

## 每次升级的机械操作

```powershell
npm run pi:upgrade -- <精确版本>
npm run pi:upgrade -- --check
npm run typecheck
npm run test:certification
npm run test:unit
npm run test:integration
```

`scripts/upgrade-pi-runtime.mjs` 统一根和 workspace 的已有 Pi pin，读取发布 manifest 同步 Native SDK，安装并更新 lockfile，再调用 `scripts/sync-pi-native.mjs` 生成四份 Native 信封代码。私有入口、参数名称/顺序、修改点、自由名称/依赖和许可检查失败时拒绝生成；保留源码 hash、Pi 版本和 MIT 许可。认证运行时身份读取安装包和 lockfile，历史在线记录保留原始版本。Builtin catalog 测试验证公开数据投影。

本次实际依赖图：Pi 1.0.0、OpenAI SDK 7.19.0、Anthropic SDK 0.124.0；根与六个 Pi workspace 引用均 `deduped`，无两份 Pi runtime。

## 边界判定

| 边界 | 判定与证据 |
|---|---|
| 公开 Models/Store | 必须修改。`Models` 增加按模型类型查询与 image/classifier 操作；Store 改为 `AnyModel[]`。用最小公开 capability 和完整持久化修复，无新 feature adapter。 |
| Semantic 两协议 | 架构必须修改。生产协议仍只输出公开 Context/options；真正 Pi Models 完成归一化与 dispatch。reasoning、tools、continuity 的现有认证保持。 |
| 自定义 Provider | 保持公开 Provider/TranscriptContext 契约。DeepSeek catalog 快照删除。CommandCode 请求 wire 与 Provider 注册规则不扩展。 |
| Responses 工具正确性 | 直接采用 upstream 实现。实际 Models → OpenAI adapter 测试验证 `fc_*`/`ctc_*` 类型改变时丢弃错误 item id，保持 call/result 配对；未完成工具 stream 通过 Token execution 返回失败。 |
| Native OpenAI/Azure/Codex/Anthropic | SDK 与局部信封代码自动同步，实际 request parity 继续。私有 URL、session、beta 规则不再手抄；少量 body-fact/credential-kind 适配保留。Cloudflare header-only Anthropic 的已认证 SDK 显式省略例外保留，Pi 1.0 未修复该 adapter gap。 |
| Direct Mode | 无 wire 改造。继续不进入 Pi Models/IR 或 Native transport；独立 lane certification 验证。 |
| 产品/观察面 | catalog 姓名/Provider 列表来自新 Pi，测试按实际 authority 判断。`onProviderStreamEvent` 暂不接入，拒绝 Client-owned callback；Meta usage 单独集成及认证。 |

## Native 的剩余耦合

Pi 的 OpenAI/Azure/Anthropic API 公开入口只返回归一化 AssistantMessage stream，Codex 额外公开 WebSocket 管理方法。`createClient`、beta、Azure config、Codex URL/compression/header preparation 没有独立 raw-request 公开接口。Copilot 的公开动态 header helper 要求 `Message[]`；Native 不伪造 Pi IR 来调用它。

用户进一步明确允许局部复制后，本次已自动提取所需声明及有限依赖，删除对应手写规则及独立 `pi-identity.ts`。OpenAI Copilot 输入改为 Native dynamicHeaders；Anthropic tools 输入改为 hasTools，OAuth 使用 managed credential kind，federation 分支省略。Azure/Codex 所选实现不修改。完整 Provider、Pi IR、响应解析、执行重试和 WebSocket session 不复制，安装包不修改。SDK shield 保留真实 Response，Native 原始 body 不经过 Pi 的语义转换。详见 [Native vendoring 契约](Spec/TokenPiNativeEnvelopeVendoringSpec.md)。

耦合现在集中在同步 recipe 与少量事实适配：选定函数内部实现改变时直接重新生成；私有输入、依赖或修改点改变时审查这一处。每次升级仍需 wire parity。未来 upstream 的 raw-body/raw-Response 公共接口可替换生成代码，保持 Native sender 的稳定输入/输出；不能声称此后所有升级必定零代码改动。

后续审查保留 OpenAI/Azure/Anthropic 的 `createClient` 同步粒度；它们拥有真实的认证、路由、header 优先级及 SDK 配置，拆成手写小函数会增加同步点。强化的是本地 patch：被替换/删除区域与已接受片段做完整 AST 结构对照，包括 const/let/using 标志、条件、语句及调用参数；新增 Context 消费、输入名冲突、默认/rest/async/generator 签名和非法语法也拒绝同步。未修改区域实现可自动复制。解析与诊断使用现有 TypeScript 6.0.3 compiler API，不是手写解析器；没有为有限 patch 增加通用 codemod 依赖。

## 新能力与未验证事实

没有采用 image/classifier、Anthropic federation、Meta raw-event usage。Pi 1.0 新 OpenAI ChatGPT OAuth 与 legacy Codex OAuth 属于不同授权流程；新增 login options 已被 capability facade 转发。Pi 自动暴露的新 OpenAI OAuth 选项还需要 Token 提供稳定 installation device ID：当前 Control Plane login 未提供 `getDeviceId`，因此该新登录会在发送网络请求前失败，不能算本次已支持或认证的功能。其产品集成作为独立变更处理；现有 OpenAI API key 与 `openai-codex` local OAuth 保留。

用户另行要求的 Codex token → 新 OpenAI Provider 在线探针保存在 `scripts/probe-codex-token-openai.mjs`。它只读明确来源，用空的内存 credential store 和显式 access-token override，限制目的地/重定向，隐藏凭据，使用临时 CODEX_HOME。假凭据 + 本地 fake fetch 已认证；真实请求被自动审批审核以 `blocked by policy` 拒绝，未执行，未读取或复制用户 auth.json。用户已暂缓此调查，不能据此宣称两种 token 可互换。

## 验证记录

所有 Backend/CLI/Desktop 测试均走仓库临时 CODEX_HOME 守卫。原始在线 auth 文件不复制。未运行打包后的 Electron 产品 E2E。

- 基线：旧版本 typecheck、针对性的 101 项回归通过。
- 新版本：upgrade 同步命令与只读检查通过；`npm ls` 全部 Pi/Native SDK 去重。
- 首轮完整 Vitest：2820 通过、1 项 CLI 超时；该 CLI 文件单独重跑 18/18 通过。不会通过放宽预算掩盖失败。
- 后一次完整 Vitest 与 `typecheck` 同时运行导致 CLI 读取被重建的 workspace `dist`，报 `ERR_MODULE_NOT_FOUND`，两个 CLI 文件共 12 项失败。该轮不是有效的发布入口验证；停止构建后分开重跑，没有修改测试预算。
- 最终根目录回归：守卫下 `vitest run --maxWorkers=2 --exclude test/integration/cli.test.ts --exclude test/integration/cli-ownership.test.ts`，312 文件 / 2799 项通过；两个 CLI 文件以 `--maxWorkers=1` 单独运行，2 文件 / 27 项通过。合计全部 314 文件 / 2826 项通过，包括两协议、Native parity/stub、工具、reasoning、continuity、认证、catalog、Direct lane 等现有离线覆盖。
- 最终 Desktop：`npm test --workspace @token/desktop-shell`，23 文件 / 152 项通过。首次图标 coverage 失败于新增 `typesafe`；源组件已支持未来内置 Provider 的 fallback，认证改为检查实际渲染而非强制手工 SVG 列表与 Pi Provider 列表相等。
- 最终门禁：`npm run typecheck`、`npm run lint`、`npm run test:certification`（81 项）、`npm run pi:upgrade -- --check`、依赖图去重检查通过。收尾简化模型事实复制后，`effective-catalog` 与两个 DeepSeek package 文件又单独回归通过。
- 上述完整回归为依赖升级阶段的记录。后续 Native vendoring 回归：根目录排除两个 CLI 文件后 313 文件 / 2802 项，其中 2801 项通过、`catalog-serve-cli` 1 项启动超时；停止并行负载后，两个 CLI 文件、catalog CLI 和最新 raw-Response/body 保留测试单独运行，4 文件 / 32 项通过，没有放宽测试预算。最新四份 Native parity/Anthropic integration/raw-Response 文件又单独运行，4 文件 / 66 项通过。typecheck/lint 的 Native 收尾日志无错误；Desktop 152 项来自前述升级阶段，本阶段未重跑。
- patch 强化后的门禁：完整守卫 certification 98 项通过（含 14 类 patch 变化拒绝及格式/未修改区域变化允许用例）；只读 Native 生成一致性检查通过。该检查拒绝生成时不写任何 generated 文件，但升级入口此前的 manifests/安装/lockfile 更新不会自动回滚。
- 真实 Provider 接受度、限流、在线响应差异：本次未认证。没有运行其他 `test:online*`。
