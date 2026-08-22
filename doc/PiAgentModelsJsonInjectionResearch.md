# Pi Agent `models.json` 注入研究

**日期：** 2026-08-21  
**范围：** 本机 npm 安装、仓库内 Pi Agent 0.84.2 源码/文档、LuckyToken 当前模型状态代码。未修改产品代码，未读取或输出任何凭据值。

## 结论

1. 本机安装的是 `@earendil-works/pi-coding-agent@0.84.2`，入口为 `C:\Users\huich\AppData\Roaming\npm\pi.cmd`，包目录为 `C:\Users\huich\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent`。`pi --version` 实测返回 `0.84.2`；包元数据与仓库内版本相同（`pi-agent/packages/coding-agent/package.json:2-10`）。
2. Pi Agent 的用户模型文件是 `~/.pi/agent/models.json`；Windows 本机实际路径为 `C:\Users\huich\.pi\agent\models.json`。包配置决定 `.pi` 目录名，代码允许用 `PI_CODING_AGENT_DIR` 覆盖 Agent 目录（`pi-agent/packages/coding-agent/src/config.ts:487-520`），`models.json` 固定放在该目录下（`pi-agent/packages/coding-agent/src/config.ts:528-531`）。
3. LuckyToken 的 Provider 配置 `models.json` 与 Pi 0.84.2 **schema 兼容**，但不是同一个文件，也不是同一种产品状态。LuckyToken 明确把自己的文件放在配置文件旁，绝不放进 Pi Agent 的 `~/.pi/agent/models.json`（`README.md:225-230`）；兼容基线固定为 Pi 0.84.2（`src/providers/pi-baseline.ts:3-19`）。复制 LuckyToken 的 Provider 配置到外部 Pi 会让 Pi 直接配置上游 Provider，绕过 LuckyToken，且可能跨越凭据边界。
4. `favorite` **不属于 Pi 的 `models.json` 契约**。当前 0.84.2 的宽松 TypeBox 校验会接受未知字段，并把它保留在原始配置快照中；但组成有效 `Model` 时只复制显式支持字段，因此 `favorite` 被忽略。这个偶然宽松行为不能作为集成协议，未来 Pi 收紧 schema 时可能直接拒绝。
5. 全局 `favorite` 应只保存在 LuckyToken 自有状态（最合适的现有所有者是 `public-models.json` / `PublicModelAuthority`），同步到 Pi 时生成一个只包含收藏模型、且只使用 Pi 文档字段的干净投影。Pi 文件中不应出现 `favorite`。
6. Pi 的 `models.json` 是用户共享配置文件，本机现有文件已包含 4 个 Provider、43 个模型，并由已安装 0.84.2 的 `ModelConfig` 只读验证通过。因此实现不能覆盖整份文件；必须只管理一个专用 Provider 子树，检测外部修改，原子写入，并在关闭集成时只恢复该子树。

## 已安装包与本机验证

本机包元数据：

- 包名/版本：`@earendil-works/pi-coding-agent@0.84.2`；包的 `bin.pi` 指向 `dist/cli.js`（`C:\Users\huich\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\package.json:2-10`）。
- 依赖的 Pi AI/Core/Client/Protocol/TUI 也都是 `^0.84.2`（同一文件 `:45-50`）。仓库中的对应包元数据相同（`pi-agent/packages/coding-agent/package.json:45-50`）。

进行了两项隔离验证：

1. 只读加载本机真实 `C:\Users\huich\.pi\agent\models.json`：`configError = null`，4 个 Provider、43 个模型；未输出文件内容或凭据。
2. 在系统临时目录创建最小 Provider，模型记录为 `{ "id": "favorite-model", "favorite": true }`，直接调用已安装包的 `ModelConfig` 和 `ModelRuntime`；结果为：

```json
{
  "configError": null,
  "rawConfigPreservesFavorite": true,
  "effectiveModelExists": true,
  "effectiveModelHasFavorite": false
}
```

这验证了“当前接受”与“契约支持”是两回事：Pi 接受并暂存未知字段，但不会让它进入有效模型语义。

## Pi `models.json` 的正式契约

### 文件与最小结构

官方包内文档指定文件为 `~/.pi/agent/models.json`，根结构是 `providers` 记录；自定义模型最少只需要 `id`（`pi-agent/packages/coding-agent/docs/models.md:1-35`）。非内建 Provider 若定义模型，还需要 Provider 或模型级 `api` 与 `baseUrl`；未配置认证时模型会被加载，但不会出现在可用模型列表（同文件 `:132-145`）。

当前文档支持的 API 是：

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google-generative-ai`

证据：`pi-agent/packages/coding-agent/docs/models.md:121-130`。

模型的文档字段包括 `id`、`name`、`api`、`reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens`、`samplingParams`、`cost`、`compat`（`pi-agent/packages/coding-agent/docs/models.md:197-211`）。源码 schema 还允许模型级 `baseUrl`、`headers`，但没有 `favorite`（`pi-agent/packages/coding-agent/src/core/model-config.ts:157-171`）；Provider 字段定义在同文件 `:194-205`，根 schema 在 `:207-210`。

### 加载、合并与错误行为

`ModelConfig.load()` 读取 JSONC 风格文件（支持 `//` 注释和尾逗号），解析或 schema 校验失败时返回空 Provider 集与错误；成功后深拷贝并冻结 Provider 配置（`pi-agent/packages/coding-agent/src/core/model-config.ts:236-284`）。

`ModelRuntime.create()` 默认从 Agent 目录加载 `models.json`，再与 Pi 内建 Provider 组合（`pi-agent/packages/coding-agent/src/core/model-runtime.ts:172-199`）。同名 Provider 的组合规则是：保留内建模型，自定义模型按 `id` upsert；相同 `id` 替换，不同 `id` 追加（文档：`pi-agent/packages/coding-agent/docs/models.md:300-335`；实现：`pi-agent/packages/coding-agent/src/core/provider-composer.ts:168-205`）。

对于完全自定义的 Provider，模型转换要求存在 `api` 和 `baseUrl`，并为缺省能力填入 Pi 的默认值（`reasoning=false`、`input=["text"]`、`contextWindow=128000`、`maxTokens=16384` 等）；转换明确逐字段构造 `Model`（`pi-agent/packages/coding-agent/src/core/provider-composer.ts:130-165`）。因此不能只注入 `id` 后假定 Pi 会自动知道真实模型能力。

### 重载不是文件监视

Pi 不需要重启，但也不是持续监听文件：每次 `ModelRuntime.refresh()` 都重新加载并重组 `models.json`（`pi-agent/packages/coding-agent/src/core/model-runtime.ts:690-710`）；打开 `/model` 时模型选择器会在后台触发该刷新（`pi-agent/packages/coding-agent/src/modes/interactive/components/model-selector.ts:132-171`），对应回归测试证明运行中替换文件后打开 `/model` 会看到新模型并移除旧模型（`pi-agent/packages/coding-agent/test/suite/regressions/6999-models-json-hot-reload.test.ts:60-82`）。

产品状态因此应区分：

- “已同步”：目标文件已安全写入并验证；
- “当前 Pi 会话已刷新”：LuckyToken 没有 Pi 的运行时管理通道，不能从文件写入本身保证。

面向用户可说明“无需重启；下次打开 `/model` 或触发模型刷新时生效”。

## `favorite` 的契约边界

Pi 的模型 schema 没有 `favorite`（`pi-agent/packages/coding-agent/src/core/model-config.ts:157-171`）。0.84.2 没有设置严格的 `additionalProperties: false`，LuckyToken 的固定基线测试也记录了未知字段会通过校验、组合时忽略的宽松行为（`test/unit/models-json-schema.test.ts:153-178`）。加载器还会深拷贝整个 Provider 对象，因此未知嵌套字段暂时留在内存配置快照（`pi-agent/packages/coding-agent/src/core/model-config.ts:279-284`）；但有效模型构造器只返回已知字段（`pi-agent/packages/coding-agent/src/core/provider-composer.ts:150-165`）。

因此当前行为应表述为：

| 阶段 | `favorite` 行为 |
| --- | --- |
| schema 校验 | 当前 0.84.2 接受 |
| 原始 `ModelConfig` 快照 | 当前保留 |
| 有效 Pi `Model` | 忽略/丢弃 |
| 模型选择、请求、公开 API | 无作用 |
| 未来兼容性 | 无保证，可能被拒绝或赋予别的含义 |

结论：不要把 LuckyToken 的领域字段塞进一个外部产品的宽松 JSON schema。

## LuckyToken 自有状态是否适合保存 `favorite`

适合，但当前代码不能只在文件里手工加一个布尔值。

LuckyToken 有两份完全不同的文件：

- `models.json`：LuckyToken 自己的 Provider/模型运行配置；schema 对齐 Pi。
- `public-models.json`：Public Model 的 endpoint、Provider 开关、模型别名/target/开关。README 明确区分二者（`README.md:65-77`），应用把 `public-models.json` 放在 LuckyToken `models.json` 同目录（`src/application.ts:575-592`）。

当前 `public-models.json` 的模型记录只有 `{ target, enabled }`，schema 版本固定为 1（`src/public-models/authority.ts:35-54`）。解析器只取这两个字段（同文件 `:190-241`），序列化也只写内存文档（同文件 `:396-405`）。所以手工加入未知 `favorite` 虽然不会在读取时立即报错，但会被解析器丢弃，并在下一次持久化时消失。

正式实现必须让 `favorite` 成为 `PublicModelAuthority` 自有事实：

- 存储模型显式包含 `favorite: boolean`；
- 控制面提供收藏/取消收藏命令，并在 Authority 内原子执行“最多 10 个”约束；
- Public Model 投影暴露 `favorite` 或独立的 `favoriteModels()`；
- 新发现模型的默认值由产品契约明确指定；当前 materialize 只生成 `{ target, enabled: true }`（`src/public-models/authority.ts:340-373`）；
- 所有更新模型记录的写路径都必须保留 `favorite`。当前 `setModelOn` 会重新构造 `{ target, enabled }`（`src/public-models/authority.ts:573-608`），若不修改会把收藏状态抹掉。

`favorite` 不应参与现有发布与调用判定。`/v1/models` 只使用 `publishedModels()`（`src/models-discovery.ts:26-55`）；直接请求解析明确不使用 publication 的 on/off 状态（`src/public-model-seam.ts:37-55`）。新增收藏筛选应只供 Agent Integration Authority 读取，保持 `/v1/models`、别名解析和请求接受范围不变。

## 推荐的 Pi 注入投影

不要复制 LuckyToken 自己的 `models.json`。应从“收藏的 Public Model + 有效运行时模型事实 + LuckyToken 接入端点”生成一个专用 Provider，例如：

```json
{
  "providers": {
    "luckytoken": {
      "name": "LuckyToken",
      "baseUrl": "http://127.0.0.1:3000/v1",
      "api": "openai-responses",
      "apiKey": "<LuckyToken 的 OpenAI Responses 客户端令牌>",
      "models": [
        {
          "id": "provider/alias",
          "name": "Display name",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 64000
        }
      ]
    }
  }
}
```

这里只展示投影形状，不决定最终 Provider ID、协议或凭据保存策略。实现时应遵守：

1. `models[].id` 使用 LuckyToken 对外接受的 alias，因为 Pi 文档明确 `id` 会原样传给 API（`pi-agent/packages/coding-agent/docs/models.md:197-202`）。
2. 只投影全局收藏且当前可注入的模型；不存在 `full/all` 模式。
3. `reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens` 等模型能力来自 LuckyToken 的有效目标模型；否则 Pi 的默认值可能错误。
4. `baseUrl`、`api`、认证和 `compat` 描述的是 **Pi Agent → LuckyToken** 这一条客户端协议边界，不能复制目标上游 Provider 的 endpoint、credential 或 compat。
5. 不写 `favorite`，也不写任何仅属于 LuckyToken UI/控制面的字段。

## 安全合并与恢复

Pi 的 `models.json` 是用户所有、且本机已经有内容。最小安全合同应是“管理一个 Provider 子树”，而不是“管理一份文件”：

1. **独占一个明确 Provider ID。** 若第一次启用时 `providers.luckytoken` 已存在且不是 LuckyToken 已知的上次写入，返回冲突，不覆盖。
2. **每次操作重新读取。** 解析当前 JSONC，保留所有非 LuckyToken Provider、未知字段和用户内容。Pi 支持注释和尾逗号，整份 `JSON.stringify` 会破坏注释；实现应使用定点 JSONC 编辑，或至少把格式/注释损失作为显式产品限制。
3. **比较并交换。** 保存读取时的字节摘要；获得文件锁后再次读取，若内容不同则返回冲突。LuckyToken 现有 `ModelsJsonAuthority` 已实现“重读、锁、字节比较、临时文件原子替换”的成熟模式（`src/models-config/authority.ts:19-31`、`:539-608`），Pi 集成应复用原则而不是共享内部 Provider 运行状态。
4. **写前完整验证。** 合并后用固定的 Pi 0.84.2 schema 验证整份文档；写到同目录临时文件、落盘后 rename，再重读验证。
5. **子树级 preimage/期望值。** LuckyToken 集成状态记录该 Provider 原先“不存在/存在及其值”和上次注入子树的摘要。关闭集成时，只在当前子树仍等于上次注入值时删除或恢复该子树；若用户改过它，返回 drift/conflict，绝不回滚整份文件或覆盖其他 Provider 的后续修改。
6. **凭据边界独立。** 注入的是 LuckyToken 客户端令牌，不是任何上游 Provider 凭据。令牌落入 `models.json`、Pi `auth.json` 或环境变量的选择必须作为单独的安全/生命周期合同；Pi 文档支持 literal、环境插值、命令和 `/login`/`auth.json`（`pi-agent/packages/coding-agent/docs/models.md:134-176`）。
7. **原子同步多个收藏。** 一次同步在内存生成完整的收藏模型数组并一次提交；不要逐模型多次改写，以免 Pi 刷新时看到半完成集合。

## 实现决策摘要

```text
LuckyToken public-models.json
  └─ favorite（全局用户偏好，最多 10 个；LuckyToken Authority 所有）
       └─ Pi Integration 读取收藏 + 有效模型事实
            └─ 生成仅含 Pi 已知字段的 providers.luckytoken
                 └─ CAS/锁/原子合并到 ~/.pi/agent/models.json
```

这条信息流保持三个边界清楚：收藏不改变 LuckyToken 发布/请求语义；外部 Pi 不认识 LuckyToken 私有字段；同步只修改用户明确授权的一个集成子树。
