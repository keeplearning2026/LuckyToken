# Responses → OpenAI Chat 比较工具

把 Token 和 `reference/opencodex` 当作两个输入/输出实现：发送相同 Responses
请求，捕获各自序列化后的 Chat Completions 请求，注入模拟的大模型响应，再比较
客户端收到的 Responses JSON/SSE。无需 Codex CLI、账号、API key 或真实模型。

```powershell
# 在仓库根目录；已有根目录依赖时无需重复安装。
npm ci
npm run build:packages

# reference 使用自己的 lockfile 和 Bun；不运行安装脚本。
Push-Location reference/opencodex
bun install --frozen-lockfile --ignore-scripts
Pop-Location

npm run compare:protocols
```

需要 Node（版本要求见根 package.json）、Bun 和本地 opencodex checkout。
工具不会自动下载或更新 reference。可用 `--reference DIR`、`--bun PATH` 指定位置。

输出目录默认为 `artifacts/protocol-compare/<时间>/`，完成后打开 `report.html`。
这是独立、离线可打开的报告，支持搜索场景、标签、字段和值，以及按 Chat 请求、
Responses 结果、响应配置字段、SSE 事件过滤。JSON 原始文件提供完整证据。

```powershell
npm run compare:protocols -- --list
npm run compare:protocols -- --tag reasoning
npm run compare:protocols -- --case replay.namespace
npm run compare:protocols -- --generated 500 --seed 42 --concurrency 4
npm run compare:protocols -- --case controls --write-corpus my-cases.json
npm run compare:protocols -- --input my-cases.json --out artifacts/my-comparison
```

`--out` 必须是尚不存在的目录，`--write-corpus` 不覆盖现有文件。
`--limit N` 用于缩小选择，`--timeout-ms N` 是每个实现每个场景的进程期限，默认 30 秒。
并发默认 2 个场景，每个场景启动两个进程。Ctrl+C 终止 worker、保留已完成报告并清理临时状态。

## 实际比较范围

Token 路径：真实 Responses handler → Client 转换 → Pi Context compatibility →
Pi Models（包含 Context normalization）→ 已安装的 upstream `openai-completions`
adapter → Chat Wire → Pi AssistantMessage → Responses renderer。

opencodex 路径：真实 `handleResponses` → 配置的 `openai-chat` Provider → Chat Wire →
真实 Responses renderer。运行所需 spend-ledger lease 只作用于新建临时目录。

工具在 `fetch` 接口捕获实际序列化请求，不调用双方的内部 request converter，也不
修改它们构建的 payload。内置模型统一为 `compare/model`，base URL 为
`https://protocol-compare.invalid/v1`，只有该地址的 Chat Completions POST 获得模拟响应。
其他 fetch 请求会记录并拒绝；不回落到真实网络。每个场景、每个实现都运行在独立进程，
使用新建的 `CODEX_HOME`、`OPENCODEX_HOME`、Pi 目录及空用户目录；不复制用户配置和凭据。
所有子进程退出后，runner 在 finally 中删除临时状态，只保留报告。

因此它比较 Semantic Conversion 的组合行为，范围不包括 TCP/HTTP listener、入口鉴权、
产品模型目录、Direct Mode 或 Native Preservation，也不衡量网络延迟或模型质量。
模型能力与双方有效配置写入每个 engine JSON。默认 Pi fixture 明确支持 strict function
schema、developer/mid-conversation system、reasoning effort 和 `max_tokens`；这是一组
受控模型能力，不代表所有 OpenAI-compatible Provider。`no-reasoning` 和
`no-mid-system` 场景分别呈现对应配置下的行为；后者只关闭 Token/Pi 的能力标志，
opencodex 保留其默认行为，这一配置差异会留在报告中。

## 语料与模拟返回

默认包括 150 个定向场景和 32 个固定 seed 的组合场景。定向场景覆盖文本/图片/文件、
角色与中途指令、function/custom/namespace、工具参数和结果、并行调用、reasoning 历史、
控制字段、无效请求、JSON/SSE、UTF-8 字节分片、交错工具参数、usage、截断、HTTP 错误、
完整历史及 previous_response_id 回放。报告中的 coverage 是标签计数，不是代码覆盖率。

可以导出语料后编辑，也可自行编写以下 JSON 数组。`request` 原样提交，省略字段不会
自动补默认值。这样 malformed request 也可以作为输入。

```json
[
  {
    "id": "my-tool-replay",
    "tags": ["tools", "replay"],
    "steps": [
      {
        "request": {
          "model": "compare/model",
          "stream": true,
          "store": false,
          "input": "Lookup a value",
          "tools": [{
            "type": "function",
            "name": "lookup",
            "strict": false,
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}
          }]
        },
        "reply": {
          "reasoning": "VISIBLE_REASONING",
          "calls": [{"name": "lookup", "arguments": {"query": "example"}}],
          "deltaSize": 2,
          "byteChunkSize": 7
        }
      },
      {
        "replay": "history",
        "toolOutput": "LOOKUP_RESULT",
        "request": {"model": "compare/model", "stream": true, "store": false, "input": "Continue"},
        "reply": {"text": "FINAL_ANSWER"}
      }
    ]
  }
]
```

`reply` 可指定 `text`、`reasoning`、`reasoningField`、`refusal`、`calls`、`finish`、
`usage`、`deltaSize`、`byteChunkSize`、`truncate`。`calls[].arguments` 接受对象或原始
字符串，因此可以模拟畸形 JSON 参数。可以用 `toolIndex` 代替 `name`，选择实际发出的
工具声明，适用于 namespace 展平名称不一致的场景；替换后的确切 Provider 响应保存在证据中。

默认 fixture 随该实现发出的 `stream` 选择 JSON 或 SSE，二者表达相同 message/usage。
这使 Token 总是使用上游流、opencodex 随客户端选择流的差异也能被直接看到。`truncate`
只作用于 SSE，因此客户端 JSON 场景可能出现一侧接收到截断流、另一侧收到完整 JSON；
实际注入的报文总会保留。要强制两侧收到相同字节，使用 raw：

```json
{"raw":{"status":429,"headers":{"content-type":"application/json","retry-after":"0"},"body":{"error":{"type":"rate_limit_error","message":"FIXTURE_RATE_LIMIT"}}}}
```

raw 的 body 也可为原始 SSE 字符串。每一步的 recipe 对该步的重试保持不变，最多
记录 8 次 Provider 请求。每次尝试独立保留，重试次数本身也是比较结果。

`replay: "history"` 使用**该实现自己**上一轮的实际 output 拼成完整历史；
`replay: "previous"` 使用它自己的 response ID。两种回放都会为返回的 function/custom
call 添加匹配 call_id 的工具结果，并保留原始 reasoning/continuity。双方第二轮输入
因此可以不同，实际请求仍完整保存；不会把一方的 opaque envelope 送给另一方。

## 报告与结果解释

- `corpus.json`：本次选定语料，可直接作为下次 `--input`。
- `report.html` / `report.md` / `report.json`：交互浏览、概览、完整逐字段差异。
- `cases/<id>/scenario.json`：场景原始定义。
- `cases/<id>/{token,opencodex}.json`：实际输入、所有 Chat 请求/模拟返回、Responses 原文、
  解析后的 JSON/SSE、配置和错误。
- `cases/<id>/{token,opencodex}.log`：进程日志，包括 Token 上游转换失败的详细原因。
- `preflight/`：每次运行先验证双方基础请求确实到达 Chat Wire，并正常返回标记。

报告只规范化 Responses 自动生成的 response/item ID 和 created_at/completed_at。
原始报文不修改。请求内容、call_id、工具参数、角色顺序、缺失与 null、reasoning、
opaque state、配置字段和 usage 都参与比较。文本字符串与 text-part 数组这种表达差异
也会报告；工具不宣称它们语义不等价。SSE 事件及 DONE framing 单独分组，避免事件数量
掩盖最终输出差异。HTML 单个场景最多显示前 500 个字段差异，JSON 保存全部。

报告记录双方 Git revision、工作区 dirty 状态和 tracked diff 摘要、工具文件摘要、
Pi/Node/Bun 版本及语料 SHA-256。比较进行时请勿编辑实现或工具源文件。

HTTP 400/429/500、对无效输入的拒绝等均是正常观察结果。若先前响应没有可供回放的
response ID，后续步骤会标为 `skipped` 并显示原因，而不会把语料依赖条件误报为进程错误。
异常退出、超时、损坏的结果文件或非预期 outbound fetch 记录为执行错误。退出码 0 表示运行完成（允许差异），1 表示
执行错误或中断，2 表示启动/参数/依赖错误。前置探针失败会保留报告并退出 2。
不把 opencodex 设为正确性 oracle，也不自动修改任何生产转换逻辑。

## 工具自身验证

```powershell
node --test tools/protocol-compare/tool.test.mjs
```

这些检查只验证纯报文生成、差异计算、规范化和回放组装，不导入应用或访问 Codex 状态。
工具实际运行时由 runner 自己创建并显式传递隔离目录。
