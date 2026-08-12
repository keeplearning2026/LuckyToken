# LuckyToken 项目交接说明

**交接基线：** `46db639`（`feat: isolate client tokens by protocol`）<br>
**记录日期：** 2026-08-11<br>
**用途：** 让新的维护者或 Agent 不依赖先前对话，也能从当前实现继续工作。

## 1. 当前状态

- `.tickets/` 中 Ticket 01–28 的 acceptance criteria 均已勾选完成；提交历史按 ticket
  保留，当前 HEAD 是 Ticket 28。
- 当前生产组合提供本地 Anthropic Messages HTTP endpoint，经 Pi 公共接口调用
  CommandCode Private Provider；Provider 与 Client Protocol 不直接依赖。
- Client Protocol 本地认证已经按协议文件隔离，并支持 protocol-global token 与
  project-bound token；Provider 凭证继续由 Pi `CredentialStore` 独立管理。
- 本轮新增的 [实现架构说明](./LuckyTokenArchitecture.md) 是源码基线 `46db639` 的维护者
  地图，包含开发者层和零编程经验阅读层。模块、接口、数据生命周期、文件归属、测试
  与扩展边界请直接查该文档，本交接文件不重复抄写。
- 当前工作树中的文档尚未提交。交接时预期未跟踪文件为：

  ```text
  doc/LuckyTokenArchitecture.md
  doc/HANDOFF.md
  ```

## 2. 首先阅读的权威资料

按以下顺序建立上下文：

1. [仓库工作原则](../AGENTS.md)；
2. [实现架构说明](./LuckyTokenArchitecture.md)，先看各章 `X.0 小白导读`，再按任务深入；
3. [LuckyToken Core Spec](./Spec/LuckyTokenCoreSpec.md)，它拥有 architecture/ownership；
4. [Ticket 实施指南](../.tickets/IMPLEMENTATION.md) 与当前任务对应的 ticket；
5. 涉及协议时才读取 [Protocols 目录](./Protocols/) 中对应的 Protocol Spec 和相邻
   Conversion Method；
6. [README](../README.md) 获取当前安装、配置、登录和运行命令。

不要用本交接文件替代上述规范。若文档与代码出现冲突，先定位冲突属于 Protocol、
Conversion 还是 Architecture，再在 owning authority 修复，不能在不相关模块加补丁。

## 3. 不可破坏的核心边界

```text
Client Wire ↔ Client Protocol ↔ Pi public contracts ↔ Provider ↔ Provider Wire
```

- Client Protocol 只拥有 Client Wire ↔ Pi；Provider 只拥有 Pi ↔ 自己的 upstream wire。
- Runtime/HTTP 只拥有 route、WHATWG `Request`/`Response` 和取消生命周期。
- `composition.ts` 可以同时看见具体两侧以便构造、注入和认证，但不能承担转换语义。
- Pi 生产依赖是 `@earendil-works/pi-ai@0.84.1`；整个 `pi-agent/` 树是不可修改的
  参考/审查源（AGENTS.md 硬约束），LuckyToken 只通过 Pi 公共接口消费，上游更新
  整体替换。
- Deployment config、Client Protocol token、Pi model catalog、Pi Provider credential
  分属不同 owner 和生命周期，不应重新合并成一个大配置或通用 Auth store。
- 半成品 stream/tool state、raw token、wire-specific representation 都必须在 owner
  边界内死亡；EOF 不是 semantic success。

详尽证据和例外见[架构审计章节](./LuckyTokenArchitecture.md#11-对-agentsmd-设计原则的审计)。

## 4. 工作区与敏感资料

- `.luckytoken/`、所有 `auth.json`、`CommandcodeAPIKey.txt`、`.online-artifacts/` 均被
  `.gitignore` 排除。
- 不要读取、复制、打印或提交真实 API key。在线 runner 只应在内存中读取 key；任何
  evidence artifact 必须继续拒绝或替换认证值。
- 不要把本地 `.luckytoken/` 内容当作仓库默认配置；只提交现有 example 中的占位符。
- 开始修改前运行 `git status --short`。用户已有改动属于用户，不要重置、覆盖或顺手
  清理无关文件。

## 5. 验证与完成标准

普通离线 gate：

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

真实在线 gate 只在任务明确需要且已获授权时运行：

```powershell
npm run test:online
```

它会产生真实外部调用与费用，且依赖被忽略的本地 key。普通 `npm test` 不访问真实
CommandCode。协议、模型/endpoint、认证政策、Pi revision 或 serving boundary 变化时，
还必须更新对应 certification record 与 immutable hash；具体 ownership 见
[测试与证据章节](./LuckyTokenArchitecture.md#10-测试certification-与真实证据)。

本轮只改 Markdown。已对架构文档执行相对链接、章节导读、代码围栏、Mermaid 围栏和
`git diff --check` 检查；没有因为纯文档增补重新运行 TypeScript 测试套件。

## 6. 已知设计取舍

不要把以下已记录取舍误判为可在任意层顺手修复的问题：

- Anthropic SSE 当前是完整 Pi 结果 commit 后生成的 Atomic SSE，不是实时 token
  forwarding。
- 当前 concrete composition 只安装 `anthropic-messages` 和一个 certified
  `commandcode-private` model。
- Client token 管理是非并发 CLI 操作，Runtime 使用启动时不可变 snapshot；修改后
  需要重启。
- CommandCode 当前不能无损保证某些 Pi 语义，例如 required strict constrained
  sampling；无法认证的路径必须 fail closed。
- Certified composition 显式绑定 fetch；程序化 Provider seam 的 ambient fallback
  不应成为新 production path 的默认依赖。

完整说明见[边界压力章节](./LuckyTokenArchitecture.md#113-需要持续关注的边界压力)。

## 7. 下一项工作的推荐流程

1. 先确认用户目标是否已有 ticket/spec authority；没有时先形成窄 ticket，不直接扩大
   Core 或某个协议的职责。
2. 沿[推荐阅读顺序](./LuckyTokenArchitecture.md#13-阅读顺序)读取完整调用链和 owning tests。
3. 明确新信息的 producer、carrier、semantic consumer 和 death point。
4. 用最小垂直切片执行 red → green → refactor；协议故障要分别覆盖 malformed、
   unsupported、abort 和 terminal consistency。
5. 只在对应 owner 内修改，并用 import-boundary 测试防止 Client Protocol 与 Provider
   越过 Pi 耦合。
6. 运行与风险相称的验证；若改动属于 ticket，单独提交并更新 ticket 状态/认证证据。

## 8. Suggested skills

- `$tdd`：实现或修复协议、生命周期、取消、配置与集成行为时使用，保持一次一个
  red→green 垂直切片。
- `$code-review`：提交前按仓库规范与 ticket/spec 两条轴审查变更，尤其检查边界 import
  和信息生命周期。
- `$implement`：处理新的明确 ticket 时使用；先读 `.tickets/IMPLEMENTATION.md`、Core
  Spec 和当前 ticket，再按依赖顺序持续实施与独立提交。
- `$handoff`：下一次跨会话转交时更新此文件中的基线、工作树、验证结果和未完成事项；
  不复制已经写入 spec、ticket、架构文档或 commit 的内容。

## 9. 本次交接的立即动作

新维护者接手后先执行：

```powershell
git status --short
git diff --check
```

然后阅读两份未提交文档，确认它们与当前 HEAD 一致。若任务只是接收本轮文档，可将
`doc/LuckyTokenArchitecture.md` 与 `doc/HANDOFF.md` 作为一个 documentation commit；
若源码已经前进，应先重新核对文档中的 commit 基线、模块表和验证陈述再提交。
