# Handoff — LuckyToken Provider Activation (Phase 1-4 完成)

**Date:** 2026-08-17
**Next session purpose:** 继续完成 Provider Activation 剩余 tickets (06-15)

## 1. 权威文档(先读这些,不重复内容)

- Spec: [`doc/Spec/LuckyTokenProviderActivationSpec.md`](../Spec/LuckyTokenProviderActivationSpec.md)(ACCEPTED IMPLEMENTATION SPECIFICATION v1.0)
- Tickets: [`.tickets/ProviderActivation/`](../../.tickets/ProviderActivation/)(15 个 markdown)
- 架构边界: [`doc/Spec/LuckyTokenElectronArchitectureSpec.md`](../Spec/LuckyTokenElectronArchitectureSpec.md)(修改过,含 Provider Activation 相关内容)

## 2. 已完成工作(Phase 1-4,对应 tickets 01-04 + 05 + 07-08)

### Ticket 01 — bundled CommandCode ✅
- 新增 [`src/providers/bundled.ts`](../../src/providers/bundled.ts):不可变 bundled 包元数据(`@luckytoken/provider-commandcode-private` / `commandcode-private`),含 specifier/id 保留集合。
- `assertUserProviderPackages()`:用户配置 bundled specifier 直接拒绝。
- 测试:`test/integration/provider-runtime.test.ts` P2/P4。
- `test/integration/cli.test.ts` 新增 "rejects explicit configuration of the bundled CommandCode Provider Package" 测试。

### Ticket 02 — Provider Runtime ✅
- 新增 [`src/providers/runtime.ts`](../../src/providers/runtime.ts):`createProviderRuntime()` 返回 `{ models, credentialAuthority, catalog, externalProviderIds, providerSource }`。
- 组合顺序:Pi builtins → models.json → bundled packages → user packages(Spec §8.3)。
- 一个 Models 对象图(login + 请求共用),一个 credential store/auth.json。
- 测试:`test/integration/provider-runtime.test.ts` P1/P3/P3b。

### Ticket 03 — Gateway 生命周期独立 ✅
- `src/application.ts`:Provider Runtime 在 Data Plane Supervisor 之前创建;catalogController.bind 在 Backend 启动时完成(不在 startListener 内)。
- Auth/Credential handler 直接闭包 Backend-lifetime 的 runtime(不再等 Data Plane 填充 `authModels`/`credentialAuthority` 可选槽)。
- Data Plane startListener 通过 `providerRuntime` 注入 composition(不再自己创建 Provider 组合)。
- 测试:`test/integration/provider-activation-lifecycle.test.ts` B1/B2/B3/B4(stopped/failed 时 Auth/Catalog query、stopped 时登录、stop→login→start)。

### Ticket 04 — Catalog Backend-lifetime ✅
- catalogController.bind 移到 Backend 启动(application.ts),不再绑定 Data Plane shutdown signal。
- 测试:同 provider-activation-lifecycle B1/B2(stopped/failed 时 Catalog query)。

### Ticket 05 — Provider source 投影 ✅
- `packages/application-control-plane/src/contracts.ts`:新增 `ProviderSource` 类型 + `AuthProviderOption.source`。
- `src/credentials/auth-options.ts`:`projectAuthOptions` 接收 `sourceFor`;`src/credentials/login-control-plane.ts` 接收可选 `providerSource`。
- `src/application.ts`:Auth handler 传入 `providerRuntime.providerSource`。
- wire 严格校验 source(缺失/未知 fail-closed)。
- 测试:`test/unit/auth-source-wire.test.ts` CP1;provider-activation-lifecycle B1 加 CP2(pi_builtin IDs 精确等于 `builtinProviders()`)。

### Ticket 07 — Catalog-derived 默认 alias ✅
- [`src/aliases/domain.ts`](../../src/aliases/domain.ts) 重写:`computeEffectiveAliasRegistry` 接收 `catalogTargets`,生成 `provider/model` 默认;`computeConfiguredAliasMappings` 同步。
- `generatedDefaultAlias()`:model id 含 `/` 保留全文本。
- **删除** [`src/aliases/defaults.ts`](../../src/aliases/defaults.ts)(curatedAliasDefaults / CURATED_ALIAS_DEFAULTS_VERSION)。
- `AliasCatalogFacts` 增加 `targets`;`src/application.ts` catalogFacts 提供 targets。
- 语义修正(重要):
  - user alias 覆盖 target 时,其生成默认被抑制(**不是** duplicate 错误);
  - user alias 字符串等于**另一** target 的生成默认 → duplicate 拒绝(fail-closed)。
- 测试:`test/unit/alias-registry.test.ts` A1/A2/A3/A6;`test/unit/alias-registry-validation.test.ts` 重写;`test/unit/alias-authority.test.ts` 重写。

### Ticket 08 — model-scoped set/reset ✅
- `AliasRegistryAuthority` 增加 `setForModel` / `resetForModel`(authority.ts)。
- `AliasCommand` 增加 `set_for_model` / `reset_for_model`(contracts.ts + wire.ts decode)。
- `src/aliases/control-plane.ts` 路由新命令。
- 测试:`test/unit/alias-authority.test.ts` "target-scoped alias mutations" 组;`test/integration/alias-control-plane.test.ts` wire round-trip。

## 3. 未完成工作(Phase 5-9,按 tickets)

| Ticket | 内容 | 状态 |
|---|---|---|
| 06 | Provider readiness 从 catalog model availability 推导 + Home/Connect 测试 | **部分实现**:application.ts onSnapshot 已推导 `provider` 状态;但 HomePage 无需改(已用 status.provider);需补测试 |
| 09 | ProvidersPage 真 Provider 浏览器(分组/搜索/source 标签) | 未开始 |
| 10 | 完整泛化认证交互 UI(API-key/OAuth/device code 等) | 未开始(基础交互已存在) |
| 11 | 模型行 alias 编辑 UI(Add/Edit/Reset) | 未开始 |
| 12 | 有效 alias 全链路(/v1/models、Codex catalog、请求选择) | **核心已就绪**:domain/authority resolver 已含 generated defaults;alias-data-plane 测试已更新;需确认 Codex catalog 生成 |
| 13 | 并发隔离认证测试 | 未开始(现有 snapshot 机制已保证) |
| 14 | packaged Electron E2E 激活旅程 | 未开始 |
| 15 | release certification gate | 未开始 |

## 4. 关键技术决策/注意事项(给下一个 agent)

1. **`createConfiguredLuckyTokenComposition` 保留 legacy 路径**:测试和 online 脚本直接调用它(不传 `providerRuntime`),此时它内部自建 Provider 组合。Spec §22 说删除 legacy 路径,但**生产路径(application.ts)已经走 Provider Runtime 注入**;legacy 仅测试/CLI 用。如需严格满足 Spec,后续可迁移测试到 `createProviderRuntime` + 新 Data Plane composition。
2. **`src/providers/runtime.ts` 的 `externalProviderIds`** = bundled + user packages(models-discovery 用)。
3. **Alias resolver 现在包含 generated defaults**:`/v1/models` 和请求选择已能用默认 `provider/model` alias。alias-data-plane 测试已按此更新。
4. **application.ts 中 `provider` 状态**:由 catalogController.onSnapshot 推导(`lastPublishedStatus.provider`),初始 unconfigured;supervisor 创建时读取 `lastPublishedStatus.provider`。
5. **`modelsStore` 在 runtime 创建时传入 catalogCacheStore**;Data Plane composition 不再传 modelsStore(它通过 providerRuntime 拿到)。
6. 构建顺序:改 `packages/application-control-plane` 后必须 `npm run build --workspace @luckytoken/application-control-plane` 再跑根测试(workspace 链接到 dist)。
7. **wire 中 AliasStatusProjection decode**:现在若收到 `defaultsVersion` 字段会 fail-closed(旧客户端不兼容是有意的)。
8. `application.ts` 中 `credentialAuthority`/`providerRuntime` 是 `let`(闭包先于赋值创建),已加 eslint-disable 注释,勿改回 const。

## 5. 当前验证状态

- ✅ `npx tsc -p tsconfig.json --noEmit` 通过
- ✅ eslint(修改文件)通过
- ✅ `npx vitest run test/unit` — 105 files / 1547 tests 全通过
- ✅ `npx vitest run test/integration` — 91 files / 623 tests 全通过(含新增 provider-runtime、provider-activation-lifecycle、auth-source-wire)
- ⚠️ 未跑:`npm run test:certification`、`npm run test:distribution`、`npm run build`(desktop-shell)、desktop-shell 测试、release E2E
- ⚠️ 未跑完整 lint(`npm run lint` 含 desktop-shell)

## 6. 建议技能(next session)

- `implement`(C:/Users/huich/.agents/skills/implement/SKILL.md)— 继续按 tickets 实施
- `tdd`(C:/Users/huich/.agents/skills/tdd/SKILL.md)— Phase 0 RED 测试先行
- `code-review`(C:/Users/huich/.agents/skills/code-review/SKILL.md)— 完成后 review
- `to-tickets`(C:/Users/huich/.agents/skills/to-tickets/SKILL.md)— 若需细化 ticket 06/09-15

## 7. 敏感信息说明

- 无真实 API key/凭据写入本交接文档或新增代码。
- 测试使用 fake key(`sk-activation-test-key` 等),仅存在于测试临时目录。
- 仓库根目录存在 `CommandcodeAPIKey.txt` / `OpenCodeAPIkey.txt`(用户既有文件,未触碰)。
