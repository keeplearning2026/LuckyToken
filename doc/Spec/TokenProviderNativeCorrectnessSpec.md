# Provider Native 正确性与认证标准

状态：2026-10-03 定义验收标准。汇总既有 Native 契约，不宣称当前实现已覆盖本文全部认证条件；不扩大允许的 rewrite、认证方式或 Provider 范围。

已实现操作及现有开关见 [Native 重写清单](TokenProviderNativeRewriteInventory.md)。请求/响应保真均扣除该清单所指向的已接受有限变换；设计建议不自动扩大允许的改动。

## 定义与信息所有权

Provider Native 正确，当且仅当：在已认证的 Provider/API/operation/auth/transport 范围内，客户端原生请求经**已列明的有限变换**后保留其协议与模型可见含义；发送的 Provider HTTP envelope 与实际安装 Pi 在等价信封事实下的行为一致（显式差异单独认证）；原始上游 Response 交给 Native 自己的响应处理；取消、超时、重试、提交和隔离满足 Token 的契约。

三个 authority 不混用：

| 对象 | Authority / 判断方式 |
|---|---|
| 请求 body | 客户端原生协议值，加上独立规范明确允许的变换；不能拿 Pi semantic body 作标准 |
| Provider request envelope | 实际安装 Pi 的所选 adapter 实现、同版本 vendor SDK 及已认证操作契约 |
| Response 与生命周期 | 实际上游 HTTP Response，加上 Token Native 明确允许的响应变换、header 策略和生命周期 |

复制了 Pi 函数、使用相同 SDK、编译通过、某次请求返回 200，都不是正确性的充分证据。也不承诺任意请求都与 Pi 的完整网络交互不可区分：Native body 来自客户端，Pi semantic body 来自 Context；执行与响应消费的所有权不同。

## N1：请求 body 保真与有效性

对原请求 B、对应操作已批准的变换 R，以及最终发出的解压 body U，必须满足：

```text
Parse(U) = SDK JSON 值归一化(R(B))
```

按 JSON 值比较，保持数组顺序、缺省与显式 null 的区别、字符串内容、嵌套未知字段，以及调用/结果的 ID、身份和关联。既有 B2′ 契约允许 SDK parse/serialize 的表示归一化，不承诺 JSON 空白、对象格式、数字词法拼写或 -0。不能把删字段、补默认语义或重排数组称作“归一化”。

R 必须指向已有的独立契约与正反测试，不能用“必要 repair”作为无限授权：

- 顶层 model / Azure deployment 投影；其余模型可见字段继续来自客户端。
- Responses 已认证的 tool-call adjacency 调整，见 [对应规范](TokenProviderNativeResponsesToolCallAdjacencyNormalizationPlan.md)；开关关闭或不满足条件时保留 model-only 行为。
- Anthropic managed OAuth 的已认证 identity/tool-name 差分，见 [Anthropic Native Contract](TokenProviderNativeAnthropicContract.md)。
- Anthropic SDK 的 betas → header 资源层转换属于已声明 envelope 事实，不允许据此任意注入 body 字段。
- Routed compaction 与 Token1 replay 是独立且窄的语义例外，必须遵守 [remote compaction 契约](TokenResponsesRemoteCompactionHandlingSpec.md)，不能以普通 body 等价测试替代认证。

不得让 Token 的处理制造原本不存在的 Client Protocol 无效性或工具关系错误。未知 Provider 字段不因 Token 不认识而被丢弃或额外 shape-validation。对不满足 rewrite 条件的请求，按其规范保留或拒绝，不能猜测修复。

## N2：请求信封与实际 Pi 对等

在相同的 resolved Model、认证结果及 credential branch、session、effective timeout、配置 headers、运行环境和信封相关 body facts 下，对最终发出的每次物理请求比较：

- method、完整 URL/path/query、Azure deployment/api-version；
- 完整 header 集合，包括 auth/account、merge precedence、User-Agent、Provider/SDK identity、session/affinity、beta/features、Copilot dynamic headers、retry-count/timeout；不能只比较“稳定 headers”子集；
- transport 的已认证部分：Codex content-encoding、zstd 参数/能力与失败回退。压缩后的不同 body 不要求字节相等，解压后的值必须符合 N1。

允许 HTTP header 名大小写与集合顺序的协议等价处理。测试应固定可固定的 request/session IDs；确实生成的值须验证生成规则和关联，不能直接忽略该字段。实际 HTTP 栈按最终 Native body 计算的 Content-Length 等传输派生值，以对应发送内容为准，不与不同 Pi body 的长度机械相等。

body facts 影响 envelope 的用例必须分别建立真实 Pi Context 与原生 body，使两边的角色、图片、工具和 thinking 事实等价。空 Context 加 onPayload 替换 body 不能认证 Context 派生的 headers。生产 Native 不进入 Pi Context 或 Provider execution；测试里的 Pi Context 只用来驱动 oracle。

当 Pi 没有暴露相同 operation（如部分 compact 路径）的公开执行入口时，须明确区分：可由实际 Pi 对照的共用 client/header 行为，以及由同版本 SDK/已接受 operation 契约认证的目的 URL/资源方法。不能把后一项写成“Pi 对同一 operation 的完整请求对照通过”。

## N3：认证边界与差异管理

绑定的 credential kind、Provider、account 和 endpoint 是 authority。不得根据 token 文本重新选择 managed auth branch；不得让客户端 transport headers 覆盖 Provider-owned auth/identity；Profile 切换后必须重新解析并构建新绑定的信封，不能复用旧认证头。

Pi 与 Token 的差异必须单独记录：触发条件、字段/行为、理由、对应测试、保留或移除条件。差异不是一般 parity 通过，不得扩大成“允许忽略这些 headers”。当前已知边界：

- Anthropic managed credential-kind 判定不同于 Pi token 文本启发式；普通凭据可对等，非典型 token 分支按 Token 的认证契约测试。
- Anthropic mid-conversation tool-change beta 不由 Native 重建，原因是它依赖 Native 不拥有的 Context 历史事实。
- Cloudflare 仅 cf-aig-authorization 时，Pi 在 SDK 发前拒绝，Native 使用明确的 absent-auth omission；测试锁定该差异，Pi 能发送同一绑定时重新审查并移除 workaround。
- Codex WebSocket、未认证 federation 等不在当前 Native 声明范围，不能计为 SSE/HTTP parity 通过。

未列明的差异就是失败或待审查项，不能为通过升级临时扩大测试忽略列表。

## N4：响应所有权与有限修改

sender/transport 必须把真实上游 Response 交回 Native 响应 owner，在该边界不读取/消费真实 body。成功、非 2xx、SSE、未知事件和错误 body 均不得被 SDK 的解析或异常包装替代。fetch shield 的合成 Response 只供 SDK 内部读取。

Native 响应处理仍遵循既有 buffering、重试分类、安全 header 过滤与 commit 契约；最终客户端响应不承诺是同一个 Response 对象，也不承诺保留被安全过滤的全部 headers。对于已提交的结果，只有以下已有规范允许改变可见内容：

- Responses 成功响应依次执行可选 SSE lifecycle normalization、可选 [function-call namespace insertion](TokenProviderNativeFunctionCallNamespaceRepair.md)、必需的 model alias projection（当请求使用 alias）。可选步骤关闭时该步骤输入必须原样保留；alias、安全处理和 compaction 不能被一起跳过。
- Anthropic 的已声明 model alias projection；不能据请求侧 OAuth 差分自行推定响应侧也获准重写 tool names。
- Routed compaction 的单一 Token-owned compaction item。
- 配置 public alias 时的既有错误安全流程：摘要/脱敏并替换真实 model 身份，构造协议错误；这不是原始错误 body 保真，必须作为明确的有条件差分认证。无 alias 时的原始错误保留路径单独测试。

每项变换都必须证明触发范围、只改变被授权的事实、未知事件/字段保留，以及无匹配条件时不改变内容。错误 body 不进行成功响应修复。可见文本、工具名/参数/ID、usage、finish/error 含义不得被未经批准的改写改变。

三个兼容性修复开关默认 true，在进入 Native 分支时捕获一次；请求发送、重试与响应处理使用同一快照。必须覆盖独立 on/off、全部关键组合、请求期间变更后的快照一致性，以及读取一个开关失败不影响其它步骤和 mandatory 处理。Token1 replay、routed compaction 请求与响应保持既有规则，不新增开关。

## N5：生命周期、提交与 lane 隔离

取消、有效超时、物理重试、429 Profile 切换、body-read failure 与 commit 遵循 Token Native 的独立契约，不要求复制 Pi semantic retry/stream parser：

- caller cancellation 到达实际 fetch/读取；SDK 的内部信号不能在 shield 返回后误杀 Native 仍拥有的连接；
- SDK retries 关闭，Token 物理尝试有明确 owner；Profile 切换时重建认证/account/session/SDK 事实；
- 按既有原子缓冲契约，在失败仍可重试时不得向客户端提交部分成功响应；commit 后不得追加第二个终局；
- diagnostics 关闭、throwing、饱和、慢或不可用时，核心请求结果不变。

Native 可以使用 resolved Pi Model/auth，但不得进入 Pi IR、Context normalization、Pi Provider execution、semantic body builder 或 AssistantMessage parser。Direct、两套 Client Protocol Semantic Conversion 与 Native 保持现有独立依赖方向。

## 认证与发布判定

覆盖单位是 `(provider, api, operation, auth branch, transport)` 加影响 envelope 的事实分支，不是每个 Provider 发一个空请求。以两份 Native certification 数据声明支持范围；数据表列出元组只代表声明，不自行证明认证完备。

| 证据层 | 最少要证明什么 | 不能推导什么 |
|---|---|---|
| 离线请求认证 | N1 body 保真与负例；N2 完整 envelope；N3 差异/安全分支；事实分支有/无及 header 冲突优先级 | 不证明真实 Provider 接受或底层实际 HTTP 栈完全一致 |
| 离线组合与 transport 认证 | N4/N5；原始 Response、未知 SSE/错误、取消/超时/重试/切换/commit；本地 HTTP server 可检查真实到达请求与压缩 | 不证明线上 account、beta、限流或 Provider 行为 |
| 发布在线认证 | 按既有 gate，对目标发布版本/环境执行真实上游最小请求，记录所覆盖元组和行为 | 不证明未运行的元组或所有后续请求都被接受 |

至少覆盖适用的 session 有/无、image 有/无、tools 有/无、thinking/compat/beta 选择、header-owned auth、model/auth header 冲突、baseURL/Azure 配置、compression 可用/失败，以及 raw response/lifecycle。不相关维度不强造组合，但要说明不相关的理由。测试应使用实际 Pi 及同版本 SDK 作 oracle，不能只比较 Token 常量与另一份 Token 常量。

离线通过可称“对应范围离线正确性认证通过”。只有既有在线发布 gate 也通过，才可称“该版本/范围达到发布条件”。没有跑在线测试时，必须写“线上未认证”。对 Pi 升级：public API 编译、依赖/SDK 一致性、局部 patch fail-closed、N1–N5 回归与在线发布 gate 各自提供独立证据；自动生成成功不替代行为认证。

所有可触达 Codex 状态的测试使用仓库临时 CODEX_HOME 守卫；不读取/复制用户 auth.json 来完成离线认证。

统一离线入口：

```powershell
npm run test:provider-native
```

入口先完成 workspace 构建，再通过仓库 CODEX_HOME 守卫串行执行 Pi upgrade 同步认证、Native claim/auth 范围认证、lane 隔离认证，随后以 Vitest 的文件名过滤 `native` 执行全部现有 Native unit/integration 文件（每个实际文件必须匹配项目测试 include）。失败返回非零退出码，具体测试列出字段/行为差异；升级/构建阶段不与测试并行。这个入口复用现有 runners，没有另建正确性判断框架。

退出码 0 只表示“该命令实际执行的有限离线检查通过”。未补齐的事实分支、没有匹配 native 文件名的组合用例、typecheck/lint 全项目检查与在线发布 gate 不因这个入口通过而自动完成。最终认证结论仍按本文的证据范围逐项记录。

## 当前证据范围

- `responses-native-provider-pi-parity`、`anthropic-native-provider-pi-parity` 已进行完整 fetch-boundary method/URL/header 比较，含认证、session、Azure、SDK identity 与部分例外。
- 很多 parity fixture 使用空 Pi Context；这些用例不能据此声称图片、工具、thinking、末条角色等动态 facts 已完成最终请求对照。需逐项审查其他测试的真实覆盖，再补缺口，不能以测试数量代替矩阵。
- compact 的部分用例用 Pi Responses 请求作为共用 headers oracle，再独立检查 compact URL；属于拆分证据，不是同 operation 的 Pi 执行对照。
- `pi-native-envelope-copy` 证明四条 sender 的未知 body 字段及 unread 原始非 2xx Response 保留；其余 projection/lifecycle/namespace/compaction/retry/profile/diagnostics 测试分别证明对应模块与组合。
- `provider-native-rewrite-settings` 经 production composition 与 registry 验证三个开关的 8 种组合、下一请求 hot-apply、当前请求快照，以及单个开关读取失败的隔离；`pi-native-envelope-copy` 对 OpenAI/Azure/Codex 分别验证 adjacency 开关；`provider-native-compaction` 验证可选修复全开/全关时既有 SSE/JSON compaction 和 Token1 replay 行为。它们提供局部离线证据，不证明线上 Provider 接受。
- `pi-upgrade-sync` 证明依赖同步、提取、有限 patch 拒绝/允许及生成一致性，不证明全部 Provider wire 正确。
- 本次 Pi 1.0 升级未执行在线 Provider gate。当前不能称全链路不可区分或全部发布条件已满足。
- 2026-10-03 实测统一 `test:provider-native` 入口：26 项同步/范围/隔离认证及 23 个 Native 文件的 314 项 unit/integration 全部通过；新增入口的 CODEX_HOME 守卫认证另行运行，14 项通过。这是该批有限离线检查的记录，不改变上述动态事实矩阵和线上证据缺口。
