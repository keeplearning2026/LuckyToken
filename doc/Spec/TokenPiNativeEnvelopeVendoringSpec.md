# Pi Native 请求信封自动同步契约

状态：2026-10-03 实现。用户明确允许复制 Pi 发布包的文件并作少量修改，将 Native 的升级耦合集中在同步模块。Semantic 继续使用未修改的 upstream Pi 公共接口。

实现正确性的统一验收依据为 [Provider Native 正确性与认证标准](TokenProviderNativeCorrectnessSpec.md)。本文件定义同步机制；生成成功不等于 Native 正确性认证通过。

## 请求路径

```text
Native resolved Model/auth + 保留的 Provider body + session/timeout
  → Native 提取少量 body/header 事实
  → 自动复制的 Pi client/config/header/beta/压缩函数
  → 同版本 vendor SDK 或 Codex fetch
  → 原始 HTTP Response
  → 原有 Native response handling
```

不构造 Context/TranscriptContext，不调用 Pi Provider stream，不用 onPayload 替换 payload，不解析 Pi AssistantMessage。已安装的 Pi 包不修改。Direct Mode 不使用这些模块。

既有每个 Native lane 的 sender/transport 是稳定接口，仍接收原始 body 并返回 Response。SDK fetch shield 保留真实 Response，让 SDK 只读取合成响应；因此 SDK 不吞掉错误 body 或 SSE，调用方取消仍由 Native 的 signal 控制。

## 唯一同步入口

`scripts/sync-pi-native.mjs` 通过 TypeScript AST 读取实际安装的 npm 发布包，选择下表的声明及其有限依赖，生成 `.generated.ts`。不是维护一个完整 Pi Provider fork，也不复制 Pi 语义转换、响应解析、重试或 WebSocket session machinery。

| 输出文件 | Pi 来源及范围 |
|---|---|
| `provider-native-responses/pi-openai.generated.ts` | openai-responses：createClient、compat/session 默认规则 |
| `provider-native-responses/pi-azure.generated.ts` | azure-openai-responses：createClient、baseURL/config/deployment 解析 |
| `provider-native-responses/pi-codex.generated.ts` | openai-codex-responses：URL、base/SSE headers、zstd 压缩 |
| `provider-native-anthropic/pi-envelope.generated.ts` | anthropic-messages：SDK subclass/client、compat、身份常量、beta 选择 |

生成文件附 Pi 版本、完整来源文件 SHA256、MIT 许可和本地修改说明。文件不手工编辑。复制的是发布包已编译 JavaScript，因此生成文件的 TS/style 检查关闭；Token 调用面保留 SDK/Native 类型。生成器额外检查自由名称/缺失依赖，行为由最终 fetch 请求对照认证，而不是声称复制代码已经通过严格 TS 类型验证。

固定提取和修改的局部契约：

- OpenAI：将内部 Copilot `context.messages` 读取替换为 Native 提供的 `dynamicHeaders`，其余 client/header/session 实现复制 upstream。
- Azure、Codex：所选函数的实现不修改。Native 独立处理 compact operation；不复制 Codex WebSocket 执行。
- Anthropic：把 tools Context 读取换成 `hasTools`；OAuth 分支接受已解析的 credential kind，保留现有“不能根据 token 文本决定认证方式”的安全契约；移除尚未认证的 federation 分支。Native 不重建 mid-conversation tool-change beta（D2）。
- Cloudflare header-only Anthropic 的已认证 SDK null-omission 例外仍在 Native 调用面，独立于复制的 Pi 构造函数。

Native 只负责派生有明确消费者的 Provider body 事实。这里没有新的共享语义模型、扩展 bag 或 Client × Provider payload projector。未知 body 字段继续保留。

## 升级

```powershell
npm run pi:upgrade -- <精确版本>
npm run pi:upgrade -- --check
npm run typecheck
npm run lint
npm run test:provider-native
npm run test:certification
npm run test:unit
npm run test:integration
```

升级命令同时同步 manifests/SDK/lockfile 与四份请求信封代码。`--check` 只读对照生成结果，包括换行规范化。生成前验证所有 recipe，验证失败时不发布任何一份生成代码。

缺少函数、参数名称/顺序改变、修改点改变、引入未复制的私有依赖、引入 Context/Transcript/响应解析依赖、许可变化均明确失败。新增依赖不会自动拉入更大的 Pi 代码树；审查后修改这一处同步模块及相应认证。

本地 patch 使用 AST 节点位置替换，不对整个函数做字符串重命名。被替换/删除的 OpenAI Copilot 分支、Anthropic federation 分支、OAuth 条件和 tools 判定按完整 AST 结构与已接受的上游片段对照；新增语句、条件、else、参数、改变取值或 const/let/using 声明标志都拒绝生成。beta tools 调用只允许既有的参数位置，新增 Context 消费或新输入名与上游冲突也拒绝。默认参数、rest、async/generator 变化及非法源码/生成语法均拒绝。空白、注释、字符串引号样式不影响结构比较。

没有被 patch 的 client/header/beta 实现继续自动复制，不冻结整个函数或来源文件 hash。因此未修改区域新增 header 可以同步，但被整段替换的分支中新增 header 必须人工审查。这里只证明同步没有越过已接受的变换边界；最终 wire parity 仍是独立门禁。

解析与语法/自由名称检查使用项目已有的 TypeScript 官方 compiler API，没有手写 JavaScript 解析器。少量项目代码只定义允许的提取/变换区域及节点替换规则，不发展为通用 codemod 框架。HTTP envelope 保持同版本 OpenAI/Anthropic SDK，Codex 压缩调用 Node zlib；通用解析、认证应用、semantic dispatch 不另造实现。缓存校验是 Token-owned 的持久化边界规则，增加 schema 库本身不能消除它对 Pi model 契约的依赖。

这把耦合从多个手写 transport 集中到了提取规则及事实适配。上游只改变所选函数内部实现时，可以直接重新生成；改变这些私有输入或新增依赖时，仍需审查。同步成功不等于行为已认证。

未来 Pi 若公开 raw-body/raw-Response 接口，可用直接 import 替换这些复制模块，保持既有 Native sender 接口和 response ownership。

## 证据

- `responses-native-provider-pi-parity`、`anthropic-native-provider-pi-parity`：完整 method/URL/headers 与实际安装 Pi 对照。
- `anthropic-provider-native`：认证分支来自 managed binding，不因 token 文本改变。
- `pi-native-envelope-copy`：SDK 路径保留未知 body 字段，真实非 2xx Response 保持同一对象、body 未读。
- `pi-upgrade-sync`：实际生成结果一致；私有入口移动、签名变化、新自由名称，以及 14 类 patch 区域变化/输入冲突均拒绝同步；格式变化和未修改区域新增 header 可以同步。

在线上游接受度未在此认证。该实现不采用新 ChatGPT OAuth、Meta raw-event usage 或 Anthropic federation。
