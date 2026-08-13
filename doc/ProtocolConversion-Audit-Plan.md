# 协议转换完备性审计——执行记录

Status: **Completed and superseded**  
Date: **2026-08-13**

本文件最初是审计写作计划。计划中的若干预设后来被代码事实证伪，因此不再保留为待执行规范。最终证据、主张判定、错误与遗漏、修正后的 P0/P1/P2 清单、运行验证、待议决策和实施摘要见：

- [`ProtocolConversion-Completeness-Audit.md`](./ProtocolConversion-Completeness-Audit.md)
- [`Protocols/Protocol Conversion Architecture and Policy.md`](./Protocols/Protocol%20Conversion%20Architecture%20and%20Policy.md)
- [`Protocols/Anthropic-Pi AI IR Conversion Method.md`](./Protocols/Anthropic-Pi%20AI%20IR%20Conversion%20Method.md)
- [`Protocols/OpenAI Responses-Pi AI IR Conversion Method.md`](./Protocols/OpenAI%20Responses-Pi%20AI%20IR%20Conversion%20Method.md)
- [`Protocols/PI AI IR-Commandcode Private Conversion.md`](./Protocols/PI%20AI%20IR-Commandcode%20Private%20Conversion.md)

## 已执行范围

1. 逐行核查 Anthropic Messages request/response/SSE/passthrough。
2. 逐行核查 OpenAI Responses request/response/SSE/session-state/error。
3. 逐行核查 Pi IR→CommandCode request 与 CommandCode JSONL→Pi response。
4. 沿 converter→options→Models→Provider→execution→Client renderer 复核跨侧影响。
5. 对比安装版 Pi public types、vendored Pi adapter 和标称 opencodex 2.13.0 的参考实现。
6. 运行完整离线测试、指定协议测试和错误专项探针。
7. 对所有未决项逐项 grilling，冻结配置 owner、默认值、notice、不可变约束和降级边界。

## 计划预设中被纠正的事项

- `top_p/top_k` 不是“Pi 无对应”；Pi 有 `samplingParams`。
- Anthropic thinking budget 不是“Pi 无对应”；Pi 有 `reasoning/thinkingBudgets`。
- Responses `text.format` 不能直接映到顶层 constrainedSampling；该字段属于 Tool。
- `xhigh/max` 不会按旧计划所述必然在 CommandCode 抛错；完整链会 clamp。
- `effort:none` 不能“透传 none”，因为 Pi request ThinkingLevel 没有 none/off。
- 27 个 sanitized fixtures 仅是 acceptance smoke，不证明字段保真，也不能支持“P0 为零”。
- HTTP non-2xx 并非只在 execution 拍平；旧 shared observer 可恢复 status/body，但产生更严重的跨请求泄漏。
- Native same-protocol passthrough 是批准的独立非转换 profile，不是 Pi conversion，也不是架构违规；它仍需独立 transport/security 认证。

## 测试记录

- `npm test`: certification 6/6 + Vitest 516/516 = 522，全部通过。
- 指定协议测试：23 files、246/246，通过。
- Provider/error 专项：7 files、92/92，通过。
- 在线测试：本轮未运行；真实 Provider 特定行为保持证据不足。

## 完成条件

本计划已完成。后续实现必须以冻结 conversion documents 为规范，以审计报告中的“current implementation gap”作为工作清单。若代码或依赖版本改变，应重新运行事实审计，而不是恢复本文件旧预设。

