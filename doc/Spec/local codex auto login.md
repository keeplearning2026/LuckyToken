# 统一 profile actions，共享本地 Codex 自动登录模块

## 1. 核心规则

所有 profile 使用同一个数据模型、列表、选择字段和 action 接口。凭证获取方式只在 Backend 内部决定具体实现，不向用户暴露“本地”“external”“只读”等 profile 类别。

本地 Codex 自动登录封装成一个完整操作，**内部固定执行：**

```text
清除已有的本地自动登录 profile
→ 读取本次本地 Codex 凭证
→ 创建一份新的普通 profile
→ 发布更新后的 profile 列表
```

启动和本地 profile 的 Reconnect 调用同一个模块，不拆成两套登录语义。每次都使用新 ID、默认名称、空备注和默认启用状态；不比较账号、不保留旧项的身份或凭证。

其他 profile 独立保留。原来选中旧本地项时，选择转到本次新项；原来选中其他项时，保持选择。首次创建 Provider 记录时选中新项，已有记录处于未选中状态时保持未选中。

## 2. 模块与存储实现

### 共享自动登录模块

在凭证基础设施内新增本地 Codex 自动登录模块，由它拥有清除、读取、创建和发布的完整流程：

- 使用私有 `acquisition?: "codex_local"` 标记定位自动登录项，不按名称、账号或 token 内容识别。
- 清除所有匹配旧项后，使用受限文件读取和现有 Codex ChatGPT 解析器获取当前凭证。
- 创建普通随机 `credentialId` 和新的 `credentialGeneration`；名称使用最小未占用的 `Profile N`，排序追加到列表末尾。
- 有效凭证写入 Token 管理的 incarnation 文件。后续请求和刷新使用该文件，不继续引用原 `.codex/auth.json`。
- 本地缺失、不可读或无法解析时，仍创建这一份 profile，但没有可用凭证，绝不保留旧 token。
- 可解析的过期 OAuth 凭证按原值导入，后续由普通 Pi OAuth 流程处理刷新；启动读取阶段不执行网络登录或刷新。

清除、读取和创建通过 Provider 锁串行处理，最终以一次记录提交发布，避免对外暴露中间空状态。record store 提供窄的重建事务入口，复用内部锁和写入原语，不嵌套调用公开的带锁方法。存储失败不提交半成品或第二份 profile。

### 普通 profile 契约

- 私有 acquisition 标记只留在持久化记录和 Backend，不进入公开 profile DTO、Renderer、日志或 Pi 语义状态。
- 同一 Provider 记录最多有一个 `codex_local` acquisition 项。
- 通用 `CredentialProfileCarrier` 增加 `{ kind: "unavailable" }`，凭证发布允许 `Credential | null`。不可用项不携带假 token、旧凭证或虚构文件引用。
- unavailable 项显示普通的“需要重新连接”状态，并在认证、公开模型可用性、usage 和自动切换判断中判定为不可用。
- 保持 schemaVersion 为 2，以一个当前校验器支持新增的可选字段和 carrier 分支；已有普通 profile 记录继续有效，不增加迁移或双读。
- 旧 incarnation 按现有 GC 宽限规则收集。

## 3. 统一 action 与启动设置

### Action 接入

沿用当前统一 profile 命令接口：

- Rename / note、Recheck、Disable / Enable、Remove、排序和选中共用普通 profile 实现。
- Reconnect 在 Backend 查找目标 profile 的凭证获取方式：本地获取调用完整自动登录模块；手动获取执行现有 Provider 登录流程。
- 本地 Reconnect 必须先校验目标 ID 和记录 revision，再执行模块，防止旧命令清除当前项。
- 本地 Reconnect 返回实际新建的 profile ID 和凭证代次，供 Backend 后续认证、目录检查和状态发布使用；不再按已删除的旧 ID安排后续任务。
- 公开 action 结果继续返回统一的 profile 状态，不增加来源专用字段或 UI 分支。
- Recheck 使用现有凭证检查认证和可用模型，不重新读取本地登录。没有可用凭证时返回需要重新连接。
- 排序、手动切换和同 Provider／同 auth branch 的 429 切换不检查来源；disabled 和 unavailable 项不可成为自动候选。

### 启动设置

Settings → `.codex agent` 增加：

- 键：`integrations.codex.autoLoginOnStartup`
- 名称：“启动时自动登录本地 Codex”
- 类型：boolean，默认 true，`restart-required`

开启时，在 Provider 注册后、首次认证和目录检查前调用共享模块。关闭时不调用模块，因此不清除已有项、不读取本地 auth。Reconnect 是显式 action，不受启动开关限制。

打开设置页、重新挂载 Renderer 或重启 Data Plane 不触发自动登录。运行期间删除后不立即重建；开启开关时，下次 Backend Application 启动重新创建。

### UI 和旧方案清理

自动创建的项进入普通 `profiles` 数组，使用相同卡片、计数、单选和完整 PROFILE ACTIONS。

清理之前未完成的 external selector 修改，移除特殊选择值和 Codex external 卡片；保留无关工作区修改。默认 Codex 不再使用 external binding。生产引用消失的旧文件删除，并同步修订 profile PRD、Codex plan、外部凭证来源规格和发布说明。

## 4. 测试与验收

- **共享模块：** 启动和 Reconnect 均覆盖清除旧项→读取→创建；不存在第二套本地登录实现。
- **唯一性：** 连续调用、重复启动和并发启动后最多一份自动登录项；旧 ID 消失、新 ID产生，其他 profile 保留。
- **强制重建：** 相同账号、相同凭证和 A→B 都执行同一流程；名称、备注和 enabled 状态使用新项默认值。
- **失败输入：** 缺失、不可读、空文件、无效 JSON、不支持 auth mode 时仍创建 unavailable profile，不使用旧 token。
- **选择：** 旧本地项被选中时转到新项；其他选择保持；已有未选中状态保持。
- **Actions：** 两种创建方式均可使用完整菜单；本地 Reconnect 调用共享模块，Recheck 不读取本地源，启动开关不阻止显式 Reconnect。
- **实际请求：** 双向切换后 Provider Native、Semantic Conversion 和 usage 使用选中项；不可用项不回落到其他账号；429 候选规则不区别来源。
- **事务与刷新：** revision 冲突、写入失败、旧结果发布和 GC 不产生半成品、重复项或错误状态；刷新只更新 Token 管理的文件。
- **设置与 UI：** 默认值、持久化、下次启动生效、关闭时不调用模块；公开 DTO 和菜单不暴露 acquisition 标记或来源类别。

所有 Codex 测试使用新临时 `CODEX_HOME`、合成凭证和显式路径，不读取或复制用户真实 auth。验收运行 `npm run typecheck`、`npm run lint` 和 guarded `npm test`。