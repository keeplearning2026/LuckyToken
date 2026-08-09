# CommandCode Private Protocol v1.0

> 兼容目标：`command-code@1.9.0` 的 gateway generate protocol  
> 实现语言：TypeScript / Node.js 22+  
> 读者：负责实现 request sender、response decoder 与 protocol router 的 AI

本文只定义实现协议所需的 contract 和推荐实现。

本文中的 `MUST`、`MUST NOT`、`SHOULD`、`MAY` 表示实现约束。未指定 Protocol B 时，本文只定义 `content[] A` → `content[] B` 的直接 adapter 接口和真正 SSE framing；Protocol B 的 event schema 必须由 B-specific adapter 提供，不能凭空假定。

---

# 1. 实现目标

实现分为五层：

~~~text
Protocol A client request
        ↓
CommandCode request encoder
        ↓
POST /alpha/generate
        ↓
CommandCode bare JSON Lines response
        ↓
Atomic ID-indexed Ordered Block Assembler
        ↓
content[] A + finish + usage + rawEvents
        ├── no conversion → return content[] A，结束
        │
        └── conversion required
                ↓
        Protocol B direct adapter
                ↓
        content[] B + finish/usage B
                ↓
        Protocol B event encoder + SSE framing
~~~

如果 caller 只需要 CommandCode protocol，第一版在得到 committed `content[] A`、finish 和 usage 后就结束，不需要任何 conversion layer。

只有在模拟另一种 Protocol B server 时，才启用 buffered direct adapter：先完整消费并验证 CommandCode response，再把 `content[] A` 直接转换成 `content[] B`，最后生成 Protocol B events 和 SSE response。它不是 live transform，但能保证 upstream `abort`、stream error 或 conversion error 不会把 partial content 发送给 downstream client。

## 1.1 明确不做的事情

- 不复制 official CommandCode consumer 的 current-text/current-reasoning folding 逻辑。
- 不把 CommandCode JSON Lines 直接改名后当成 Protocol B events。
- 不把 network chunk 当成 event boundary。
- 不实现或推测 `params.stream:false`。
- 不把 response-side `tool-result` 混入推荐 `content[] A`。
- 不在 Protocol B 未确定时伪造其 event name、usage schema 或 stop reason。

---

# 2. Runtime 与 dependency

推荐 runtime：

~~~text
Node.js >= 22
TypeScript >= 5
native fetch / Request / Response / ReadableStream
~~~

安装与 official 1.9.0 producer 对齐的 package version：

~~~bash
npm install @sindresorhus/slugify@2.2.1 zod@4.1.5
~~~

仅在项目已经使用 OpenTelemetry 时再安装：

~~~bash
npm install @opentelemetry/api@1.9.0
~~~

用途：

| Package/API | 用途 | 是否必需 |
|---|---|---:|
| `@sindresorhus/slugify@2.2.1` | 计算 `x-project-slug` | yes |
| `zod@4.1.5` | 验证 body `threadId` 是否为 UUID | recommended |
| `node:crypto` | `x-session-id`、trace ID、span ID | built-in |
| `node:fs/promises` | `config.structure` | built-in |
| `node:child_process` | Git fields | built-in |
| `@opentelemetry/api@1.9.0` | 从 active span 取得 trace context | optional |

只安装 `@opentelemetry/api` 不会自动创建 span。若没有完整 OTel SDK/provider，使用本文的 `node:crypto` implementation 或 omission `traceparent`。

---

# 3. HTTP request contract

## 3.1 Endpoint

Production：

~~~text
POST https://api.commandcode.ai/alpha/generate
~~~

其他已知 environment：

~~~text
staging: https://staging-api.commandcode.ai
local:   http://localhost:<9090 + portOffset>
~~~

Router SHOULD 把 `baseUrl` 作为显式 deployment config，并固定 path `/alpha/generate`。不要根据 model name 改 path。

## 3.2 Serialization

- request body 使用 `JSON.stringify`。
- `undefined` property 被 omission。
- `null` 必须保留。
- request 不是 multipart。
- `params.stream` 必须是 literal `true`。

## 3.3 Request headers

推荐发送一个干净的 `Content-Type: application/json`。不需要复现某些 runtime 产生的重复 `application/json, application/json`。

~~~ts
export interface CommandCodeHeaderInput {
  apiKey?: string;
  cliEnvironment?: string;
  cwd: string;
  sessionId: string;
  traceparent?: string;
  tasteLearning?: boolean;
  coFlag?: boolean;
  ossPrimaryProvider?: string;
  zeroDataRetention?: boolean;
  oauthToken?: string;
  oauthProvider?: string;
}
~~~

| Header | 计算规则 |
|---|---|
| `Content-Type` | fixed `application/json` |
| `Accept` | explicit `*/*`，或 omission 让 Node Fetch/Undici 自动添加 |
| `User-Agent` | fixed `cli` |
| `x-command-code-version` | fixed `1.9.0` |
| `x-cli-environment` | `prod` 转成 `production`；其他 string 原样使用；默认 `production` |
| `x-project-slug` | `slugify(cwd) || "root"` |
| `x-taste-learning` | boolean 转 lowercase string；默认 `false` |
| `x-co-flag` | boolean 转 lowercase string；默认 `false` |
| `x-session-id` | logical session UUID；默认 `crypto.randomUUID()` |
| `Authorization` | 有 CommandCode API key 时为 `Bearer <key>`，否则 omission |
| `traceparent` | valid chat span 时发送；否则 omission |
| `x-oss-primary-provider` | 有 selected OSS provider 时发送 |
| `x-cmd-zdr` | zero-data-retention 启用时发送 string `1` |
| `x-oauth-token` | 有 provider OAuth token 时发送 |
| `x-oauth-provider` | 与 provider OAuth token 配套的 provider identifier |

`Host`、`Connection`、`Content-Length`、`Accept-Encoding` 等 transport headers 由 HTTP runtime 计算，application code MUST NOT 手工计算 `Content-Length`。

### 3.3.1 `x-project-slug`

~~~ts
import slugify from "@sindresorhus/slugify";

export function buildProjectSlug(cwd: string): string {
  if (typeof cwd !== "string") {
    throw new TypeError("cwd must be a string");
  }
  return slugify(cwd) || "root";
}
~~~

不要先自行替换 path separator；直接把 runtime cwd 传给 `slugify`。为了不同机器和时间得到一致行为，必须 pin `2.2.1`，不要只写 caret range。

### 3.3.2 `x-session-id` 与 `threadId`

两者是独立字段：

- `x-session-id` 是 transport/session identity。
- `threadId` 是 request body identity，只在 valid UUID 时发送。
- 普通 session 可以让二者使用同一个 UUID，这是推荐的简单实现。
- child/custom-agent flow 可以让二者不同。
- receiver 不应要求二者相等。
- `pause_turn` continuation 必须复用二者。

~~~ts
import { randomUUID } from "node:crypto";
import { z } from "zod";

export function createSessionIdentity(
  threadId?: string,
): { sessionId: string; threadId?: string } {
  const sessionId = randomUUID();
  const candidate = threadId ?? sessionId;

  return {
    sessionId,
    threadId: z.uuid().safeParse(candidate).success
      ? candidate
      : undefined,
  };
}
~~~

如果 caller 显式提供已有 `sessionId`，必须验证它是 non-empty string；协议兼容实现最好使用 UUID v4。

### 3.3.3 `traceparent`

Wire format：

~~~text
00-<32 lowercase hex traceId>-<16 lowercase hex spanId>-01
~~~

约束：

- trace ID 为 16 bytes，不能全 0。
- span ID 为 8 bytes，不能全 0。
- flags 固定 `01`。
- 一个 logical turn 可以复用 trace ID。
- 每次新的 complete attempt 使用新的 span ID。
- 同一次 complete 内的 `pause_turn` continuation 复用完整 `traceparent`。
- outer retry SHOULD 创建新 span ID；若仍在同一 logical turn，可保留 trace ID。
- 没有 valid context 时 omission，不能发送 malformed value。

不使用 OTel：

~~~ts
import { randomBytes } from "node:crypto";

function randomNonZeroHex(bytes: number): string {
  for (;;) {
    const value = randomBytes(bytes).toString("hex");
    if (!/^0+$/.test(value)) return value;
  }
}

export interface TurnTrace {
  traceId: string;
}

export interface CompleteTrace extends TurnTrace {
  spanId: string;
  traceparent: string;
}

export function createTurnTrace(): TurnTrace {
  return { traceId: randomNonZeroHex(16) };
}

export function createCompleteTrace(
  turn: TurnTrace,
): CompleteTrace {
  const spanId = randomNonZeroHex(8);
  return {
    traceId: turn.traceId,
    spanId,
    traceparent: `00-${turn.traceId}-${spanId}-01`,
  };
}
~~~

使用已有 OTel：

~~~ts
import { isSpanContextValid, trace } from "@opentelemetry/api";

export function traceparentFromActiveSpan():
  | string
  | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;

  const context = span.spanContext();
  if (!isSpanContextValid(context)) return undefined;

  return `00-${context.traceId}-${context.spanId}-01`;
}
~~~

### 3.3.4 Header builder

~~~ts
const TRACEPARENT_RE =
  /^00-(?!0{32})([0-9a-f]{32})-(?!0{16})([0-9a-f]{16})-01$/;

export function normalizeCliEnvironment(
  value = "production",
): string {
  return value === "prod" ? "production" : value;
}

export function buildCommandCodeHeaders(
  input: CommandCodeHeaderInput,
): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": "cli",
    "x-command-code-version": "1.9.0",
    "x-cli-environment": normalizeCliEnvironment(
      input.cliEnvironment,
    ),
    "x-project-slug": buildProjectSlug(input.cwd),
    "x-taste-learning": String(input.tasteLearning ?? false),
    "x-co-flag": String(input.coFlag ?? false),
    "x-session-id": input.sessionId,
  });

  if (input.apiKey) {
    headers.set("authorization", `Bearer ${input.apiKey}`);
  }
  if (
    input.traceparent
    && TRACEPARENT_RE.test(input.traceparent)
  ) {
    headers.set("traceparent", input.traceparent);
  }
  if (input.ossPrimaryProvider) {
    headers.set(
      "x-oss-primary-provider",
      input.ossPrimaryProvider,
    );
  }
  if (input.zeroDataRetention) {
    headers.set("x-cmd-zdr", "1");
  }
  if (input.oauthToken) {
    headers.set("x-oauth-token", input.oauthToken);
  }
  if (input.oauthProvider) {
    headers.set("x-oauth-provider", input.oauthProvider);
  }

  return headers;
}
~~~

## 3.4 Request body type

~~~ts
export interface ServerConfig {
  workingDir: string;
  date: string;
  environment: string;
  structure: string[];
  isGitRepo: boolean;
  currentBranch: string;
  mainBranch: string;
  gitStatus: string;
  recentCommits: string[];
}

export type PermissionMode =
  | "standard"
  | "plan"
  | "auto-accept";

export interface WireTextBlock {
  type: "text";
  text: string;
}

export interface WireReasoningBlock {
  type: "reasoning";
  text: string;
}

export interface WireImageBlock {
  type: "image";
  image: string;
  mimeType: string;
}

export interface WireToolCallBlock {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface WireToolResultBlock {
  type: "tool-result";
  toolCallId: string;
  toolName: "";
  output: {
    type: "text";
    value: string;
  };
}

export type WireMessage =
  | {
      role: "user";
      content: Array<WireTextBlock | WireImageBlock>;
    }
  | {
      role: "assistant";
      content: Array<
        | WireTextBlock
        | WireReasoningBlock
        | WireToolCallBlock
      >;
    }
  | {
      role: "tool";
      content: WireToolResultBlock[];
    };

export interface WireTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface GenerateParams {
  model: string;
  messages: WireMessage[];
  tools: WireTool[];
  system?: string;
  max_tokens: number;
  stream: true;
  temperature?: number;
  reasoning_effort?: string;
}

export interface GenerateRequest {
  config: ServerConfig;
  memory: null;
  taste: null;
  skills: null;
  permissionMode: PermissionMode;
  threadId?: string;
  mode?: string;
  params: GenerateParams;
}
~~~

## 3.5 Top-level body fields

| Field | 计算规则 |
|---|---|
| `config` | 按第 4 章构造；一个 logical completion 内固定 |
| `memory` | fixed `null` |
| `taste` | fixed `null` |
| `skills` | fixed `null` |
| `permissionMode` | 用下方 mapping 计算 |
| `threadId` | valid UUID 时发送，否则 omission |
| `mode` | caller 提供 non-empty string 时发送，否则 omission |
| `params` | 按第 5 章构造 |

`memory:null`、`taste:null`、`skills:null` 不表示 system prompt 没有这些 context；它们可以已经被 application 编译进 `params.system`。

Permission mapping：

~~~ts
export function toWirePermissionMode(
  mode?: string,
): PermissionMode {
  if (mode === "bypass" || mode === "auto-accept") {
    return "auto-accept";
  }
  if (mode === "plan") return "plan";
  return "standard";
}
~~~

已知 `mode` 包括 `compact`、`vision`、`tool-desc`、`learning`、`title-gen`、`agent`、`custom-agent`。普通 main request 通常 omission；它不是 `permissionMode`。

---

# 4. `config` 的完整计算方法

## 4.1 `workingDir`、`date`、`environment`

~~~text
workingDir  = process.cwd()，保留原始 path string
date        = new Date().toISOString().split("T")[0]
environment = process.platform，例如 win32、linux、darwin
~~~

`date` 使用 UTC date，不是 local date。

## 4.2 `structure`

算法：

1. 只执行一次 `readdir(cwd)`。
2. 只读取 cwd immediate names，不 recurse，不 stat。
3. 删除所有 `.` 开头的 name。
4. 删除 fixed case-sensitive exclusion set。
5. 使用 JavaScript default `.sort()`。
6. 把额外 workspace root 格式化为 `scope:<path>`，append 到 sorted names 后面。
7. scope entries 不参与 sort。
8. `readdir` 失败时仍返回 scope entries。

Exclusion set：

~~~text
node_modules dist build .git .svn .hg coverage .nyc_output
.cache tmp temp .next .nuxt out
~~~

没有 recursive tree，也没有 500-entry cap。

## 4.3 Git fields

按以下顺序和 fallback 执行：

~~~text
git rev-parse --git-dir
git branch --show-current
git symbolic-ref --short refs/remotes/origin/HEAD
git branch -r
git status --porcelain
git log --oneline -3
~~~

任何 Git command failure、non-zero exit 或 exception 都转成 empty string。

`mainBranch`：

1. remote HEAD non-empty：删除开头 `origin/`。
2. 否则 remote branches string 包含 `origin/main`：使用 `main`。
3. 否则包含 `origin/master`：使用 `master`。
4. 否则使用 `main`。

Non-Git repository：

~~~json
{
  "isGitRepo": false,
  "currentBranch": "",
  "mainBranch": "",
  "gitStatus": "",
  "recentCommits": []
}
~~~

Git working tree clean 时 `gitStatus` 为 fixed string `Working tree clean`。

## 4.4 TypeScript implementation

~~~ts
import os from "node:os";
import process from "node:process";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STRUCTURE_EXCLUSIONS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".svn",
  ".hg",
  "coverage",
  ".nyc_output",
  ".cache",
  "tmp",
  "temp",
  ".next",
  ".nuxt",
  "out",
]);

function formatScopeDir(input: {
  dir: string;
  cwd: string;
  home: string;
}): string {
  const { dir, cwd, home } = input;
  if (dir === cwd) return ".";
  if (dir.startsWith(cwd + "/")) {
    return "./" + dir.slice(cwd.length + 1);
  }
  if (dir === home) return "~";
  if (dir.startsWith(home + "/")) {
    return "~/" + dir.slice(home.length + 1);
  }
  return dir;
}

async function readStructure(input: {
  cwd: string;
  home: string;
  workspaceRoots: string[];
}): Promise<string[]> {
  const scopes = input.workspaceRoots
    .filter((dir) => dir !== input.cwd)
    .map((dir) =>
      "scope:" + formatScopeDir({
        dir,
        cwd: input.cwd,
        home: input.home,
      }),
    );

  try {
    const entries = await readdir(input.cwd);
    return [
      ...entries
        .filter(
          (name) =>
            !name.startsWith(".")
            && !STRUCTURE_EXCLUSIONS.has(name),
        )
        .sort(),
      ...scopes,
    ];
  } catch {
    return scopes;
  }
}

async function gitOutput(
  cwd: string,
  args: string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function resolveMainBranch(
  cwd: string,
): Promise<string> {
  const remoteHead = await gitOutput(cwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead) {
    return remoteHead.replace(/^origin\//, "");
  }

  const remoteBranches = await gitOutput(cwd, [
    "branch",
    "-r",
  ]);
  if (remoteBranches.includes("origin/main")) return "main";
  if (remoteBranches.includes("origin/master")) return "master";
  return "main";
}

export async function buildServerConfig(input: {
  cwd?: string;
  home?: string;
  platform?: string;
  workspaceRoots?: string[];
} = {}): Promise<ServerConfig> {
  const cwd = input.cwd ?? process.cwd();
  const home = input.home
    ?? process.env.HOME
    ?? process.env.USERPROFILE
    ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const workspaceRoots = input.workspaceRoots ?? [cwd];

  const structure = await readStructure({
    cwd,
    home,
    workspaceRoots,
  });
  const date = new Date().toISOString().split("T")[0] ?? "";
  const gitDir = await gitOutput(cwd, [
    "rev-parse",
    "--git-dir",
  ]);

  if (!gitDir) {
    return {
      workingDir: cwd,
      date,
      environment: platform,
      structure,
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    };
  }

  const currentBranch = await gitOutput(cwd, [
    "branch",
    "--show-current",
  ]);
  const mainBranch = await resolveMainBranch(cwd);
  const rawGitStatus = await gitOutput(cwd, [
    "status",
    "--porcelain",
  ]);
  const rawRecentCommits = await gitOutput(cwd, [
    "log",
    "--oneline",
    "-3",
  ]);

  return {
    workingDir: cwd,
    date,
    environment: platform,
    structure,
    isGitRepo: true,
    currentBranch,
    mainBranch,
    gitStatus: rawGitStatus || "Working tree clean",
    recentCommits: rawRecentCommits
      ? rawRecentCommits.split("\n")
      : [],
  };
}
~~~

Additional workspace roots 必须与 cwd/home 使用一致的 path representation。上述 `formatScopeDir` 用 literal `/` 做 prefix comparison；普通单-root router 直接使用 `workspaceRoots:[cwd]` 即可。

推荐每个 logical completion 计算一次 `config`，并在所有 `pause_turn` continuation 中复用。是否跨多个用户 turn cache 是 client policy，不改变 wire schema。

---

# 5. `params`、messages 与 tools

## 5.1 `params` fields

| Field | 计算规则 |
|---|---|
| `model` | caller 选择的 CommandCode provider/model identifier；required |
| `messages` | 已转换的 CommandCode wire messages；required，可为空但不推荐 |
| `tools` | 当前可用 tool definitions；required；没有 tool 时为 `[]` |
| `system` | caller 提供 string 时发送；`undefined` 时 omission |
| `max_tokens` | caller override，否则 fixed default `64000` |
| `stream` | literal `true`，不可设置为 false |
| `temperature` | number 时发送，包括 `0`；`undefined` 时 omission |
| `reasoning_effort` | selected model 支持且 caller 指定时发送，否则 omission |

`reasoning_effort` 已知值至少有 `low`、`medium`、`high`、`xhigh`、`max`，但每个 model 只支持 subset。Router MUST 用 model capability table 决定是否发送，不能对所有 model 强加同一 value。

~~~ts
export function buildGenerateParams(input: {
  model: string;
  messages: WireMessage[];
  tools?: WireTool[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  modelSupportsReasoningEffort?: boolean;
}): GenerateParams {
  const params: GenerateParams = {
    model: input.model,
    messages: input.messages,
    tools: input.tools ?? [],
    max_tokens: input.maxTokens ?? 64_000,
    stream: true,
  };

  if (input.system !== undefined) {
    params.system = input.system;
  }
  if (input.temperature !== undefined) {
    params.temperature = input.temperature;
  }
  if (
    input.modelSupportsReasoningEffort
    && input.reasoningEffort
  ) {
    params.reasoning_effort = input.reasoningEffort;
  }

  return params;
}
~~~

## 5.2 Message block rules

Assistant：

~~~text
text       → {type:"text", text}
reasoning  → {type:"reasoning", text}
tool call  → {type:"tool-call", toolCallId, toolName, input}
~~~

User：

~~~text
text  → {type:"text", text}
image → {
          type:"image",
          image:"data:<mime>;base64,<base64-data>",
          mimeType:"<mime>"
        }
~~~

Tool result request：

~~~ts
export function createToolResultMessage(input: {
  toolCallId: string;
  textParts: string[];
}): WireMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: input.toolCallId,
        toolName: "",
        output: {
          type: "text",
          value: input.textParts.join("\n"),
        },
      },
    ],
  };
}
~~~

`toolName:""` 只属于下一次 request 中的 request-side `tool-result`。它不表示 response SSE 的 `tool-call.toolName` 为空。Response tool name 来自 `tool-input-start.toolName` 或 final `tool-call.toolName`。

一个 prepared internal user message 同时包含 tool results 和普通 user content 时，应拆成两个 wire message，顺序为 `role:"tool"` 后 `role:"user"`。

空 text block、orphan tool result、provider-executed replay 和 internal metadata 应在进入 wire encoder 前清理。它们属于 application history preparation，不属于 HTTP framing。

## 5.3 Tool definition

只发送三个 field：

~~~json
{
  "name": "read_file",
  "description": "...",
  "input_schema": {
    "type": "object",
    "properties": {}
  }
}
~~~

不要把 runtime callback、permission state、MCP connection object 或 application metadata 放进 request。

## 5.4 Complete request builder

~~~ts
export interface BuildGenerateRequestInput {
  config: ServerConfig;
  permissionMode?: string;
  threadId?: string;
  mode?: string;
  params: GenerateParams;
}

export function buildGenerateRequest(
  input: BuildGenerateRequestInput,
): GenerateRequest {
  const body: GenerateRequest = {
    config: input.config,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: toWirePermissionMode(
      input.permissionMode,
    ),
    params: input.params,
  };

  if (
    input.threadId
    && z.uuid().safeParse(input.threadId).success
  ) {
    body.threadId = input.threadId;
  }
  if (input.mode) body.mode = input.mode;
  return body;
}

export async function sendGenerateRequest(input: {
  baseUrl: string;
  headers: Headers;
  body: GenerateRequest;
  signal?: AbortSignal;
}): Promise<Response> {
  const url = new URL("/alpha/generate", input.baseUrl);
  return fetch(url, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify(input.body),
    signal: input.signal,
  });
}
~~~

---

# 6. CommandCode response transport

## 6.1 HTTP layer

Success response 通常为：

~~~http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache

{"type":"text-start","id":"0"}
{"type":"text-delta","id":"0","text":"hello"}
{"type":"text-end","id":"0"}
{"type":"finish","finishReason":"stop","totalUsage":{}}
~~~

尽管 media type 是 `text/event-stream`，body framing 是 bare JSON Lines，不是 conventional SSE：

~~~text
JSON.stringify(event) + "\n"
~~~

CommandCode decoder MUST NOT 要求 `data:`、`event:`、blank-line delimiter 或 `[DONE]`。同时 MUST NOT 假定一个 HTTP chunk 等于一行或一个 event。

Success parser 不应使用 Content-Type 作为 gate；只要 body 是有效 bare JSON Lines 就可以解析。

Non-2xx response：读取完整 body 并作为 HTTP error 处理。Retry classification 建议：

| Failure | retryable |
|---|---:|
| network exception | true |
| HTTP 429 | true，除非 application 识别为不可重试的 plan-window limit |
| HTTP 500–599 | true |
| other non-2xx | false |
| 2xx but response body missing | true |
| EOF without `finish` or `abort` | true |
| stream `error` event | 使用 event.isRetryable；缺失时 false |

## 6.2 Physical line decoder

正确算法：

~~~text
response.body bytes
  → TextDecoder.decode(chunk, {stream:true})
  → buffer
  → split LF
  → trim each line
  → skip empty line
  → JSON.parse(whole line)
  → event reducer
  → flush TextDecoder at physical EOF
  → parse final unterminated line
~~~

`TextDecoder` 的 `{stream:true}` 只表示保留跨 network chunk 的 UTF-8 partial code point；它与 request `params.stream:true` 不是同一个概念。

## 6.3 Event catalog

### Content lifecycle

~~~ts
export type ContentEvent =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; text: string }
  | { type: "text-end"; id: string }
  | {
      type: "reasoning-start";
      id: string;
      providerMetadata?: unknown;
    }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "reasoning-end"; id: string }
  | {
      type: "tool-input-start";
      id: string;
      toolName: string;
      providerExecuted?: boolean;
      dynamic?: boolean;
    }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      args?: unknown;
      providerExecuted?: boolean;
    };
~~~

Rules：

- `text-delta.text` 按 `id` append。
- `reasoning-delta.text` 按 `id` append。
- `tool-input-start.id` 预留 tool block 的顺序位置。
- `tool-input-delta.delta` 只保存为 raw input preview。
- `tool-input-end` 只结束 input delta lifecycle，不 materialize tool block。
- final `tool-call.toolCallId` 应与前述 `id` 相同。
- `tool-call.input ?? tool-call.args ?? {}` 是 authoritative final input。

### Metadata and terminal events

~~~ts
export interface CommandCodeUsage
  extends Record<string, unknown> {
  inputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    [key: string]: unknown;
  };
  outputTokens?: number;
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
    [key: string]: unknown;
  };
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export type CommandCodeDefinedFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other";

export interface FinishEvent
  extends Record<string, unknown> {
  type: "finish";
  finishReason?:
    | CommandCodeDefinedFinishReason
    | (string & {});
  rawFinishReason?: string;
  totalUsage?: CommandCodeUsage;
  systemPromptTokens?: number;
}

export type TerminalEvent =
  | FinishEvent
  | { type: "abort" }
  | {
      type: "error";
      error:
        | string
        | {
            message?: string;
            statusCode?: number;
            isRetryable?: boolean;
            [key: string]: unknown;
          };
    };
~~~

Other events：

| Event | Semantic action |
|---|---|
| `start` | raw preserve，semantic ignore |
| `start-step` | raw preserve，semantic ignore |
| `provider-metadata` | raw preserve，semantic ignore |
| `finish-step` | raw preserve，semantic ignore；不是 final usage source |
| response-side `tool-result` | raw preserve，推荐 content ignore |
| unknown event | raw preserve，semantic ignore |

Final usage 以最后一个实际出现的 `finish.totalUsage` 为准。`finish-step.usage` 可以有更多 provider metadata，但不能取代 final `finish.totalUsage`。

---

# 7. 推荐的 Atomic ID-indexed Ordered Block Assembler

## 7.1 Invariants

每个 HTTP response 创建独立 staging area：

~~~text
rawEvents[]

textById       Map<string, TextSlot>
reasoningById  Map<string, ReasoningSlot>
toolById       Map<string, ToolSlot>
slots[]        first-appearance order
~~~

必须满足：

1. Map key 直接使用 event `id`；三个 content type 使用三个 Map，不需要复合 key。
2. block 第一次出现时 push 一个 slot，此后永不移动。
3. 最终 `content[] A` 的 order 等于各 block 第一个相关 wire event 的到达顺序。
4. `tool-input-start` 创建 invisible placeholder；只有 final `tool-call` 才填充并关闭。
5. response-side `tool-result` 不进入 content。
6. `finish` 只记录 terminal metadata；仍需等 physical EOF。
7. `finish + EOF` 才 commit。
8. `abort` 立即 rollback 当前 response 的 semantic slots、finish 和 usage，然后 cancel/drain body；返回 `content:[]`、`committed:false`、`aborted:true`。
9. `error` 立即失败，不 commit。
10. malformed/unknown line 保存在 `rawEvents`/warnings，不得修改 semantic state。

Buffered router MUST 在 assembler commit 前不向 Protocol B client 发送任何 semantic bytes。这是 abort 能真正 rollback 的前提。

## 7.2 Result model

~~~ts
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TextContentBlock {
  type: "text";
  id: string;
  text: string;
}

export interface ReasoningContentBlock {
  type: "reasoning";
  id: string;
  text: string;
}

export interface ToolUseContentBlock {
  type: "tool_use";
  id: string;
  toolName: string;
  input: unknown;
}

export type ContentBlockA =
  | TextContentBlock
  | ReasoningContentBlock
  | ToolUseContentBlock;

export interface RawEventRecord {
  sequence: number;
  rawLine: string;
  event?: Record<string, unknown> & { type: string };
  parseError?: string;
}

export interface ProtocolWarning {
  sequence: number;
  code: string;
  message: string;
  eventType?: string;
  id?: string;
}

export interface CommandCodeResult {
  content: ContentBlockA[];
  finish?: FinishEvent;
  rawUsage?: CommandCodeUsage;
  usage: NormalizedUsage;
  systemPromptTokens?: number;
  committed: boolean;
  aborted: boolean;
  rawEvents: RawEventRecord[];
  warnings: ProtocolWarning[];
}
~~~

`content[]` 只保存 model semantic blocks。Finish、usage、abort、provider metadata、warnings 均为 response-level state。

## 7.3 Reducer table

| Event | Action |
|---|---|
| `text-start(id)` | reserve text slot |
| `text-delta(id)` | missing 时 reserve；append text |
| `text-end(id)` | close text slot |
| `reasoning-start(id)` | reserve reasoning slot |
| `reasoning-delta(id)` | missing 时 reserve；append text |
| `reasoning-end(id)` | close reasoning slot |
| `tool-input-start(id)` | reserve tool placeholder；保存 toolName |
| `tool-input-delta(id)` | append raw input preview |
| `tool-input-end(id)` | set `inputStreamEnded=true` |
| `tool-call(toolCallId)` | find/create placeholder；写 authoritative input；close |
| `tool-result` | raw only |
| `finish` | update finish/usage；continue reading |
| `abort` | rollback；cancel/drain；no commit |
| `error` | throw；no commit |
| EOF | close unfinished text/reasoning with warning；omit unfinished tool；要求已有 finish |

Closed id 后又来的 start/delta SHOULD 被 ignore 并记录 `EVENT_AFTER_END`，不要为 malformed stream 引入 occurrence key 或重排已有 slot。

## 7.4 TypeScript reference implementation

~~~ts
type UnknownRecord = Record<string, unknown>;

export interface CommandCodeEvent extends UnknownRecord {
  type: string;
}

type CloseReason =
  | "text-end"
  | "reasoning-end"
  | "tool-call"
  | "eof";

interface BaseSlot {
  id: string;
  order: number;
  firstSequence: number;
  lastSequence: number;
  state: "open" | "closed";
  closedBy?: CloseReason;
}

interface TextSlot extends BaseSlot {
  kind: "text";
  text: string;
}

interface ReasoningSlot extends BaseSlot {
  kind: "reasoning";
  text: string;
}

interface ToolSlot extends BaseSlot {
  kind: "tool";
  toolName: string;
  rawInput: string;
  input?: unknown;
  inputStreamEnded: boolean;
}

type InternalSlot = TextSlot | ReasoningSlot | ToolSlot;

function isRecord(value: unknown): value is UnknownRecord {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeUsage(
  raw: CommandCodeUsage,
): NormalizedUsage {
  return {
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    cacheReadTokens:
      raw.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens:
      raw.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

export class CommandCodeStreamError extends Error {
  constructor(
    message: string,
    readonly event: CommandCodeEvent,
    readonly rawEvents: RawEventRecord[],
    readonly warnings: ProtocolWarning[],
    readonly retryable: boolean,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "CommandCodeStreamError";
  }
}

export class CommandCodeContentAssembler {
  private nextSequence = 0;
  private readonly slots: InternalSlot[] = [];
  private readonly textById = new Map<string, TextSlot>();
  private readonly reasoningById =
    new Map<string, ReasoningSlot>();
  private readonly toolById = new Map<string, ToolSlot>();

  private finishEvent: FinishEvent | undefined;
  private rawUsageValue: CommandCodeUsage | undefined;
  private normalizedUsage: NormalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  private systemPromptTokenCount: number | undefined;
  private sawAbort = false;
  private finalized = false;

  readonly rawEvents: RawEventRecord[] = [];
  readonly warnings: ProtocolWarning[] = [];

  get aborted(): boolean {
    return this.sawAbort;
  }

  consumeRawLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    const sequence = this.nextSequence++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      const parseError = cause instanceof Error
        ? cause.message
        : String(cause);
      this.rawEvents.push({ sequence, rawLine, parseError });
      this.warn(sequence, "NON_JSON_LINE", parseError);
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.rawEvents.push({
        sequence,
        rawLine,
        parseError: "JSON value is not an event object",
      });
      this.warn(
        sequence,
        "INVALID_EVENT",
        "JSON value is not an event object",
      );
      return;
    }

    const event = parsed as CommandCodeEvent;
    this.rawEvents.push({ sequence, rawLine, event });
    this.consumeEvent(event, sequence);
  }

  finalizeAfterTransportEnd(): CommandCodeResult {
    if (this.finalized) {
      throw new Error("Assembler was already finalized");
    }
    this.finalized = true;

    if (this.sawAbort) {
      return {
        content: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        committed: false,
        aborted: true,
        rawEvents: [...this.rawEvents],
        warnings: [...this.warnings],
      };
    }

    for (const slot of this.slots) {
      if (slot.state === "closed") continue;
      if (slot.kind === "tool") {
        this.warn(
          slot.lastSequence,
          "INCOMPLETE_TOOL_CALL",
          "tool input ended without final tool-call",
          "tool-call",
          slot.id,
        );
        continue;
      }
      slot.state = "closed";
      slot.closedBy = "eof";
      this.warn(
        slot.lastSequence,
        "BLOCK_CLOSED_BY_EOF",
        "Block had no matching end event",
        slot.kind,
        slot.id,
      );
    }

    if (!this.finishEvent) {
      throw new Error("Stream ended without finish or abort");
    }

    const content: ContentBlockA[] = [];
    for (const slot of this.slots) {
      if (slot.kind === "text") {
        if (slot.text) {
          content.push({
            type: "text",
            id: slot.id,
            text: slot.text,
          });
        }
        continue;
      }
      if (slot.kind === "reasoning") {
        if (slot.text) {
          content.push({
            type: "reasoning",
            id: slot.id,
            text: slot.text,
          });
        }
        continue;
      }
      if (slot.state === "closed") {
        content.push({
          type: "tool_use",
          id: slot.id,
          toolName: slot.toolName,
          input: slot.input ?? {},
        });
      }
    }

    return {
      content,
      finish: this.finishEvent,
      rawUsage: this.rawUsageValue,
      usage: this.normalizedUsage,
      systemPromptTokens: this.systemPromptTokenCount,
      committed: true,
      aborted: false,
      rawEvents: [...this.rawEvents],
      warnings: [...this.warnings],
    };
  }

  private consumeEvent(
    event: CommandCodeEvent,
    sequence: number,
  ): void {
    if (this.sawAbort) {
      this.warn(
        sequence,
        "EVENT_AFTER_ABORT",
        "Semantic event ignored after abort rollback",
        event.type,
      );
      return;
    }

    switch (event.type) {
      case "text-start": {
        const id = this.requireId(event, "id", sequence);
        if (id) this.reserveText(id, sequence, event.type);
        return;
      }
      case "text-delta": {
        const id = this.requireId(event, "id", sequence);
        if (!id) return;
        const slot = this.reserveText(id, sequence, event.type);
        if (!slot) return;
        slot.text += asString(event.text) ?? "";
        slot.lastSequence = sequence;
        return;
      }
      case "text-end": {
        const id = this.requireId(event, "id", sequence);
        if (id) {
          this.close(
            this.textById,
            id,
            sequence,
            "text-end",
            event.type,
          );
        }
        return;
      }
      case "reasoning-start": {
        const id = this.requireId(event, "id", sequence);
        if (id) this.reserveReasoning(id, sequence, event.type);
        return;
      }
      case "reasoning-delta": {
        const id = this.requireId(event, "id", sequence);
        if (!id) return;
        const slot = this.reserveReasoning(
          id,
          sequence,
          event.type,
        );
        if (!slot) return;
        slot.text += asString(event.text) ?? "";
        slot.lastSequence = sequence;
        return;
      }
      case "reasoning-end": {
        const id = this.requireId(event, "id", sequence);
        if (id) {
          this.close(
            this.reasoningById,
            id,
            sequence,
            "reasoning-end",
            event.type,
          );
        }
        return;
      }
      case "tool-input-start": {
        const id = this.requireId(event, "id", sequence);
        if (!id) return;
        const slot = this.reserveTool(id, sequence, event.type);
        if (!slot) return;
        slot.toolName = asString(event.toolName)
          ?? slot.toolName;
        return;
      }
      case "tool-input-delta": {
        const id = this.requireId(event, "id", sequence);
        if (!id) return;
        const slot = this.reserveTool(id, sequence, event.type);
        if (!slot) return;
        slot.rawInput += asString(event.delta) ?? "";
        slot.lastSequence = sequence;
        return;
      }
      case "tool-input-end": {
        const id = this.requireId(event, "id", sequence);
        if (!id) return;
        const slot = this.toolById.get(id);
        if (!slot || slot.state === "closed") {
          this.warn(
            sequence,
            "END_WITHOUT_OPEN_BLOCK",
            "tool-input-end has no open placeholder",
            event.type,
            id,
          );
          return;
        }
        slot.inputStreamEnded = true;
        slot.lastSequence = sequence;
        return;
      }
      case "tool-call": {
        const id = this.requireId(
          event,
          "toolCallId",
          sequence,
        );
        if (!id) return;
        const slot = this.reserveTool(id, sequence, event.type);
        if (!slot) return;
        slot.toolName = asString(event.toolName)
          ?? slot.toolName;
        slot.input = event.input ?? event.args ?? {};
        slot.state = "closed";
        slot.closedBy = "tool-call";
        slot.lastSequence = sequence;
        return;
      }
      case "tool-result":
        this.warn(
          sequence,
          "IGNORED_SERVER_TOOL_RESULT",
          "response-side tool-result kept only in rawEvents",
          event.type,
          asString(event.toolCallId),
        );
        return;
      case "finish": {
        const finish = event as FinishEvent;
        this.finishEvent = finish;
        if (isRecord(finish.totalUsage)) {
          this.rawUsageValue = finish.totalUsage;
          this.normalizedUsage = normalizeUsage(
            finish.totalUsage,
          );
        }
        if (typeof finish.systemPromptTokens === "number") {
          this.systemPromptTokenCount =
            finish.systemPromptTokens;
        }
        return;
      }
      case "abort":
        this.sawAbort = true;
        this.rollbackStagedSemanticState();
        this.warn(
          sequence,
          "ATOMIC_RESPONSE_ABORT",
          "Response-local semantic state was rolled back",
          event.type,
        );
        return;
      case "error": {
        const detail = event.error;
        const objectDetail = isRecord(detail) ? detail : undefined;
        const message = objectDetail
          ? asString(objectDetail.message) ?? "Stream error"
          : asString(detail) ?? "Stream error";
        throw new CommandCodeStreamError(
          message,
          event,
          [...this.rawEvents],
          [...this.warnings],
          objectDetail?.isRetryable === true,
          typeof objectDetail?.statusCode === "number"
            ? objectDetail.statusCode
            : 500,
        );
      }
      default:
        return;
    }
  }

  private reserveText(
    id: string,
    sequence: number,
    eventType: string,
  ): TextSlot | undefined {
    return this.reserve(
      this.textById,
      id,
      sequence,
      eventType,
      (order) => ({
        kind: "text",
        id,
        order,
        firstSequence: sequence,
        lastSequence: sequence,
        state: "open",
        text: "",
      }),
    );
  }

  private reserveReasoning(
    id: string,
    sequence: number,
    eventType: string,
  ): ReasoningSlot | undefined {
    return this.reserve(
      this.reasoningById,
      id,
      sequence,
      eventType,
      (order) => ({
        kind: "reasoning",
        id,
        order,
        firstSequence: sequence,
        lastSequence: sequence,
        state: "open",
        text: "",
      }),
    );
  }

  private reserveTool(
    id: string,
    sequence: number,
    eventType: string,
  ): ToolSlot | undefined {
    return this.reserve(
      this.toolById,
      id,
      sequence,
      eventType,
      (order) => ({
        kind: "tool",
        id,
        order,
        firstSequence: sequence,
        lastSequence: sequence,
        state: "open",
        toolName: "",
        rawInput: "",
        inputStreamEnded: false,
      }),
    );
  }

  private reserve<T extends InternalSlot>(
    map: Map<string, T>,
    id: string,
    sequence: number,
    eventType: string,
    create: (order: number) => T,
  ): T | undefined {
    const existing = map.get(id);
    if (existing) {
      if (existing.state === "closed") {
        this.warn(
          sequence,
          "EVENT_AFTER_END",
          "Event arrived after block was closed",
          eventType,
          id,
        );
        return undefined;
      }
      existing.lastSequence = sequence;
      return existing;
    }

    const slot = create(this.slots.length);
    map.set(id, slot);
    this.slots.push(slot);
    return slot;
  }

  private close<T extends InternalSlot>(
    map: Map<string, T>,
    id: string,
    sequence: number,
    closedBy: CloseReason,
    eventType: string,
  ): void {
    const slot = map.get(id);
    if (!slot || slot.state === "closed") {
      this.warn(
        sequence,
        "END_WITHOUT_OPEN_BLOCK",
        "End event has no open block",
        eventType,
        id,
      );
      return;
    }
    slot.state = "closed";
    slot.closedBy = closedBy;
    slot.lastSequence = sequence;
  }

  private rollbackStagedSemanticState(): void {
    this.slots.length = 0;
    this.textById.clear();
    this.reasoningById.clear();
    this.toolById.clear();
    this.finishEvent = undefined;
    this.rawUsageValue = undefined;
    this.normalizedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    this.systemPromptTokenCount = undefined;
  }

  private requireId(
    event: CommandCodeEvent,
    field: "id" | "toolCallId",
    sequence: number,
  ): string | undefined {
    const id = asString(event[field]);
    if (id) return id;
    this.warn(
      sequence,
      "MISSING_ID",
      `Event is missing ${field}`,
      event.type,
    );
    return undefined;
  }

  private warn(
    sequence: number,
    code: string,
    message: string,
    eventType?: string,
    id?: string,
  ): void {
    this.warnings.push({
      sequence,
      code,
      message,
      eventType,
      id,
    });
  }
}
~~~

## 7.5 HTTP body consumer

~~~ts
export class CommandCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryable: boolean,
  ) {
    super(
      `CommandCode HTTP ${status}`
      + (body ? `: ${body}` : ""),
    );
    this.name = "CommandCodeHttpError";
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function consumeCommandCodeResponse(
  response: Response,
): Promise<CommandCodeResult> {
  if (!response.ok) {
    const body = (await response.text()).trim();
    throw new CommandCodeHttpError(
      response.status,
      body,
      isRetryableHttpStatus(response.status),
    );
  }

  const stream = response.body;
  if (!stream) {
    throw new CommandCodeHttpError(
      response.status,
      "CommandCode returned an empty stream",
      true,
    );
  }

  const assembler = new CommandCodeContentAssembler();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const lf = buffer.indexOf("\n");
        if (lf < 0) break;

        assembler.consumeRawLine(buffer.slice(0, lf));
        buffer = buffer.slice(lf + 1);

        if (assembler.aborted) {
          try {
            await reader.cancel(
              "CommandCode response emitted abort",
            );
          } catch {
            // Semantic state has already been rolled back.
          }
          return assembler.finalizeAfterTransportEnd();
        }
      }
    }

    buffer += decoder.decode();
    assembler.consumeRawLine(buffer);
    return assembler.finalizeAfterTransportEnd();
  } catch (cause) {
    try {
      await reader.cancel(cause);
    } catch {
      // Preserve the original failure.
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }
}
~~~

收到 `abort` 后取消 reader，rawEvents 会保存到 `abort` 为止。若 debug recorder 必须保留 server 在 `abort` 后仍发送的所有 bytes，必须在独立 recording layer 继续 drain；不能让 recorder 的需求改变 semantic rollback 结果。

---

# 8. Finish、usage、abort 与 continuation

## 8.1 Finish reason

### 8.1.1 Wire fields

`type:"finish"` event 中的 completion-reason wire fields 只有两个：

~~~ts
export type CommandCodeDefinedFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other";

export interface FinishEvent
  extends Record<string, unknown> {
  type: "finish";
  /** Defined producer values plus future/unknown strings. */
  finishReason?:
    | CommandCodeDefinedFinishReason
    | (string & {});
  rawFinishReason?: string;
  totalUsage?: CommandCodeUsage;
  systemPromptTokens?: number;
}
~~~

| Field | Source-side meaning | 收到后的用途 |
|---|---|---|
| `finishReason` | CommandCode/gateway 层的 finish category | 用 exact string comparison 计算内部 `stopReason` |
| `rawFinishReason` | provider/service 保留的 raw reason | 优先作为 diagnostic reason；控制 `pause_turn` continuation |
| `totalUsage` | final token usage | 计算 normalized usage；不是 reason field |
| `systemPromptTokens` | system prompt token count | 单独保存；不是 reason field |

Wire `finish` event **没有** `stopReason` field。`stopReason` 是 CommandCode client 接收 event 后计算出来的内部 field。

`finish-step` event 也可能出现 `finishReason`、`rawFinishReason` 和 `usage`，但 source consumer 完全忽略 `finish-step`。只有 `type:"finish"` 决定 completion、最终 reason 和 final usage。

### 8.1.2 Defined values 与 open raw values

`finishReason` 来自统一后的 provider finish category。Defined producer values 为：

| `finishReason` | Unified meaning | CommandCode final internal `stopReason` |
|---|---|---|
| `stop` | normal stop / stop sequence | `end_turn` |
| `length` | maximum output tokens reached | `max_tokens` |
| `content-filter` | generation stopped by content filter | `end_turn` |
| `tool-calls` | model emitted tool calls | `tool_use` |
| `error` | provider represented termination as finish error | `end_turn` |
| `other` | provider-specific reason not covered above | `end_turn` |
| missing or future unknown string | tolerant fallback | `end_turn` |

Receiver 应接受任意 string 和 missing value，因为 CommandCode client 没有对 wire event 做 closed-enum validation。只有 exact `tool-calls` 和 exact `length` 得到 special normalized result；其余全部 fallback 到 `end_turn`。

`finishReason:"error"` 仍然是一个正常 `type:"finish"` event，source client 不会仅因该 value throw。只有独立的 `type:"error"` event 才进入 stream error path。

`rawFinishReason` 的 producer type 是 `string | undefined`，没有可穷举的 enum。它保留原 provider/service reason。CommandCode client 唯一用于 control flow 的 special value是：

~~~text
"pause_turn" → send another /alpha/generate request
~~~

其他 raw value 只被保留和用于 diagnostics/telemetry，不改变 normalized `stopReason`。如果 `rawFinishReason` 缺失，client 使用 `finishReason` 作为 returned raw reason：

~~~ts
const returnedRawFinishReason =
  event.rawFinishReason ?? event.finishReason;
~~~

### 8.1.3 两阶段归一化

Gateway response 的 source implementation 分两步处理 reason：

~~~ts
export type StreamStopReason =
  | "tool_calls"
  | "max_tokens"
  | "end_turn";

export type ModelStopReason =
  | "tool_use"
  | "max_tokens"
  | "end_turn";

export interface AcceptedFinishReason {
  /** rawFinishReason ?? finishReason */
  rawFinishReason?: string;
  /** consumeStream() intermediate value */
  streamStopReason: StreamStopReason;
  /** createModelClient.complete() return value */
  stopReason: ModelStopReason;
  pauseTurn: boolean;
}

function normalizeStopReason(
  raw?: string,
): ModelStopReason {
  const value = (raw ?? "").toLowerCase();

  if (
    value === "tool_use"
    || value === "tool-calls"
    || value === "tool_calls"
  ) {
    return "tool_use";
  }
  if (value === "length" || value === "max_tokens") {
    return "max_tokens";
  }
  return "end_turn";
}

export function acceptFinishReason(
  event: FinishEvent,
): AcceptedFinishReason {
  const rawFinishReason =
    event.rawFinishReason ?? event.finishReason;

  const streamStopReason: StreamStopReason =
    event.finishReason === "tool-calls"
      ? "tool_calls"
      : event.finishReason === "length"
        ? "max_tokens"
        : "end_turn";

  return {
    rawFinishReason,
    streamStopReason,
    stopReason: normalizeStopReason(streamStopReason),
    pauseTurn: rawFinishReason === "pause_turn",
  };
}
~~~

Exact gateway mapping：

~~~text
wire finishReason       consumeStream stopReason   complete() stopReason
──────────────────────  ─────────────────────────  ─────────────────────
"tool-calls"           "tool_calls"               "tool_use"
"length"               "max_tokens"               "max_tokens"
other / missing         "end_turn"                 "end_turn"
~~~

这里的第一阶段是 exact comparison。虽然通用 `normalizeStopReason()` 能识别 `tool_use`、`tool_calls`、`tool-calls`、`length`、`max_tokens`，但 `/alpha/generate` gateway path 会先把 wire `finishReason` 严格压缩为三种 intermediate value。因此 wire 应使用：

~~~text
client tool turn: finishReason = "tool-calls"
length stop:      finishReason = "length"
~~~

Wire `finishReason:"tool_calls"` 或 `finishReason:"tool_use"` 不会在第一阶段被当成 tool finish；它们会落到 `end_turn`。同理，wire `finishReason:"max_tokens"` 不会通过第一阶段的 exact `"length"` check。

`rawFinishReason` 不覆盖 normalized `stopReason`。例如：

~~~json
{
  "type": "finish",
  "finishReason": "stop",
  "rawFinishReason": "pause_turn"
}
~~~

结果是：

~~~text
rawFinishReason = "pause_turn"
stopReason      = "end_turn"
pauseTurn       = true
~~~

因此 router 必须分别保存 raw reason 和 normalized stop reason，不能用一个 field 代替另一个。

### 8.1.4 Source client 收到后的处理

CommandCode 收到 `finish` 后按以下顺序使用：

1. `consumeStream()` 设置 `sawFinish=true`。
2. 保存 `rawFinishReason = event.rawFinishReason ?? event.finishReason`。
3. 只用 `event.finishReason` 计算 intermediate `tool_calls` / `max_tokens` / `end_turn`。
4. 读取 `totalUsage` 和 `systemPromptTokens`。
5. 不停止 physical read；继续处理后续 lines，直到 EOF。
6. 同一 HTTP response 出现多个 `finish` 时，后一个 reason 覆盖前一个；有新 `totalUsage` 时才替换 usage。
7. EOF 没有 `finish` 或 `abort` 时，作为 truncated response 失败。

`createModelClient.complete()` 随后：

1. 使用 `rawFinishReason === "pause_turn"` 判断是否发送 continuation request。
2. Continuation 复用相同 request state；content 按 response order concatenate，usage 跨 responses sum。
3. 最后保存最后一个 response 的 raw reason 与 stop reason。
4. 对 stop reason 再执行 `normalizeStopReason()`，最终只返回 `tool_use`、`max_tokens` 或 `end_turn`。
5. Telemetry 的 finish reason 使用 `rawFinishReason ?? stopReason`。

Agent loop 收到 complete result 后：

1. `model_request_end.stopReason` 优先报告 `rawFinishReason`，缺失时才使用 normalized `stopReason`。
2. Tool 是否执行不是只看 `stopReason`；source 会检查 `content` 中是否存在 non-provider-executed client `tool_use` block，然后执行这些 tools。
3. 没有 client tool call 时，`stopReason:"max_tokens"` 作为 length recovery/follow-up input；default continuation provider 在已有 visible content 时最多生成 3 次 length-recovery follow-up。其他 normalized reason 按 `end_turn` 处理。
4. Agent 最终 run-level stop reason 还可能是 `interrupted`、`run_error`、`stop_hook`、`max_turns` 等，它与单次 model response 的 `stopReason` 不是同一层字段。

所以 `finishReason:"tool-calls"` 与 `content` 中的 tool blocks 正常情况下应一致，但 router 仍必须从 `content[] A` 生成 tool events，而不能仅凭 finish reason 伪造 tool call。

按 defined `finishReason` 展开后，source client 的实际行为是：

| Received `finishReason` | Model-client result | Agent-layer behavior |
|---|---|---|
| `stop` | `stopReason:"end_turn"` | 有 client tool blocks 就执行 tools；没有则 normal end/stop-hook flow |
| `length` | `stopReason:"max_tokens"` | 有 client tool blocks 仍先执行 tools；没有时可进入 length-recovery/follow-up |
| `tool-calls` | `stopReason:"tool_use"` | 只有 `content` 中确实存在 client tool blocks 才执行 tools；reason 本身不创建 tool call |
| `content-filter` | `stopReason:"end_turn"` | 没有专用 content-filter error path |
| `error` | `stopReason:"end_turn"` | 不 throw；独立 `type:"error"` event 才 throw |
| `other` | `stopReason:"end_turn"` | 没有专用分支 |
| missing/unknown | `stopReason:"end_turn"` | tolerant fallback |

按 `rawFinishReason` 展开：

| Received `rawFinishReason` | Source client behavior |
|---|---|
| `pause_turn` | 发送下一次相同 `/alpha/generate` request；不把 previous content append 到 messages |
| other non-empty string | 保存到 result，优先用于 telemetry 和 `model_request_end.stopReason` display；不改变 normalized stop reason |
| missing | 使用 `finishReason` 作为 returned raw reason |

### 8.1.5 本文实现是否同步 Source client

本文实现只同步到 CommandCode model-client response layer，不复制整个 CommandCode agent runtime。

必须同步：

| Behavior | Why |
|---|---|
| 保存完整 final `FinishEvent` | 后续仍需原始 `finishReason`、`rawFinishReason`、usage |
| `rawFinishReason = rawFinishReason ?? finishReason` | 与 source result 一致 |
| exact `tool-calls` / `length` / fallback normalization | 提供 source-compatible derived `stopReason` |
| `rawFinishReason:"pause_turn"` continuation | 它属于 model-client logical completion |
| multiple finish 的 last-value behavior | 与 stream reducer 一致 |
| finish 后读到 physical EOF | 防止漏掉 trailing events 和 truncated response |
| usage normalization 与 cross-continuation sum | 得到完整 logical usage |

不应同步：

| Behavior | Why |
|---|---|
| 自动执行 client tools | 属于 agent/application layer；router 只返回 tool blocks |
| `max_tokens` 后自动插入 recovery prompt | 会改变原 response；不属于 response decoder |
| stop hooks、follow-up queue、steering | 属于 CommandCode agent runtime |
| `max_turns`、run-level stop reason | 属于多轮 agent loop，不是单次 model response |
| CommandCode telemetry/UI event | 不属于 wire protocol output |

推荐 result usage：

~~~ts
export async function decodeOneCommandCodeResponse(
  response: Response,
) {
  const resultA = await consumeCommandCodeResponse(response);

  if (!resultA.committed || resultA.aborted || !resultA.finish) {
    throw new Error("CommandCode response was not committed");
  }

  const acceptedFinish = acceptFinishReason(resultA.finish);

  if (acceptedFinish.pauseTurn) {
    throw new Error(
      "Use completeWithPauseTurn() for pause_turn",
    );
  }

  // Do not execute tools here. Return content[] A to the caller.
  return {
    content: resultA.content,
    finish: resultA.finish,
    acceptedFinish,
    usage: resultA.usage,
    rawUsage: resultA.rawUsage,
  };
}
~~~

`acceptedFinish.stopReason` 是方便 application 模拟 Source client 的 derived view，不应覆盖或删除原始 `resultA.finish.finishReason` 与 `resultA.finish.rawFinishReason`。

## 8.2 Usage

Final source 是 `finish.totalUsage`。必须同时保存 raw object 和 normalized view：

~~~text
totalUsage.inputTokens
  → usage.inputTokens

totalUsage.outputTokens
  → usage.outputTokens

totalUsage.inputTokenDetails.cacheReadTokens
  → usage.cacheReadTokens

totalUsage.inputTokenDetails.cacheWriteTokens
  → usage.cacheWriteTokens
~~~

Normalized missing field 使用 `0`；raw object 中的 missing 仍应保持 missing。Raw object 还可能包含：

- `inputTokenDetails.noCacheTokens`
- `outputTokenDetails.textTokens`
- `outputTokenDetails.reasoningTokens`
- `totalTokens`
- `reasoningTokens`
- `cachedInputTokens`
- future provider fields

`systemPromptTokens` 位于 finish 顶层，不在 `totalUsage` 内。

同一个 HTTP response 多次出现 `finish` 时：最后一个 finish event 决定 final finish metadata；只有出现新的 `totalUsage` 时才替换 current raw/normalized usage。

## 8.3 `abort`

`{"type":"abort"}` 是 server → client response event：

- 不是 request body field。
- 不是 CommandCode client 发给 upstream 的取消 HTTP request。
- 表示本 response 被有意终止。
- Atomic implementation 必须丢弃当前 response 的 staged content、pending tool、finish 与 usage。
- Router 不应把 partial content 转成 Protocol B content。

`AbortController`/`AbortSignal` 是 local HTTP cancellation mechanism，和 wire `abort` event 是不同概念。Downstream client disconnect 或 timeout 时，router SHOULD 通过 signal 取消 upstream fetch，但不需要向 CommandCode 发送额外 JSON request field。

## 8.4 `pause_turn`

Trigger：

~~~json
{
  "type": "finish",
  "finishReason": "stop",
  "rawFinishReason": "pause_turn",
  "totalUsage": {}
}
~~~

这表示 logical completion 还没有结束。发送下一次 `/alpha/generate` request 时：

- 复用相同 prepared messages。
- 不把 previous response content append 到 `params.messages`。
- 复用 tools、system、config、permissionMode、threadId、mode。
- 复用 resolved auth headers、`x-session-id` 和完整 chat-span `traceparent`。
- 不需要 continuation backoff。
- 最多建议 1 initial + 5 continuation = 6 HTTP responses。

推荐 logical atomic wrapper：

~~~ts
export interface LogicalCommandCodeResult {
  content: ContentBlockA[];
  finish: FinishEvent;
  usage: NormalizedUsage;
  parts: CommandCodeResult[];
}

export async function completeWithPauseTurn(
  sendSamePreparedRequest: () => Promise<Response>,
  maxResponses = 6,
): Promise<LogicalCommandCodeResult> {
  const parts: CommandCodeResult[] = [];

  for (let index = 0; index < maxResponses; index++) {
    const response = await sendSamePreparedRequest();
    const part = await consumeCommandCodeResponse(response);

    if (!part.committed || part.aborted || !part.finish) {
      throw new Error("CommandCode response was not committed");
    }
    parts.push(part);

    const rawReason =
      part.finish.rawFinishReason
      ?? part.finish.finishReason;

    if (rawReason !== "pause_turn") {
      return {
        content: parts.flatMap((item) => item.content),
        finish: part.finish,
        usage: parts.reduce<NormalizedUsage>(
          (sum, item) => ({
            inputTokens:
              sum.inputTokens + item.usage.inputTokens,
            outputTokens:
              sum.outputTokens + item.usage.outputTokens,
            cacheReadTokens:
              sum.cacheReadTokens
              + item.usage.cacheReadTokens,
            cacheWriteTokens:
              sum.cacheWriteTokens
              + item.usage.cacheWriteTokens,
          }),
          {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ),
        parts,
      };
    }
  }

  throw new Error("pause_turn continuation limit exceeded");
}
~~~

即使每个 part 已在 response-local level commit，router 也必须等最后一个 non-`pause_turn` part 后才向 Protocol B 开始 response。任何 part abort/error 时，整个 logical completion 不发布。

---

# 9. 两种结束方式

## 9.1 不需要 protocol conversion

如果 application 只需要调用 CommandCode：

~~~ts
const response = await sendGenerateRequest({
  baseUrl,
  headers,
  body,
  signal,
});

const resultA = await consumeCommandCodeResponse(response);
if (!resultA.committed || resultA.aborted) {
  throw new Error("CommandCode response was not committed");
}

// 最终结果。到这里结束，不需要 adapter 或额外 representation。
const contentA: ContentBlockA[] = resultA.content;
~~~

Application 同时保留 `resultA.finish`、`resultA.usage`、`resultA.rawUsage`、`resultA.rawEvents` 即可。它们是 response metadata/debug data，不是另一种 content representation。

## 9.2 需要 protocol conversion

只有在 router 要模拟 Protocol B server 时才执行：

~~~text
content[] A
    → B-specific direct block mapping
    → content[] B

finish/usage A
    → B-specific direct finish/usage mapping
    → finish/usage B

content[] B + finish/usage B
    → B events
    → SSE B
~~~

转换规则：

- 直接遍历 `content[] A`，每个 A block 映射成零个、一个或多个 B blocks。
- 保持 array order，不按 type、ID 或 completion time 重排。
- A text → B 的 text block。
- A reasoning → B 的 reasoning/thinking block，或执行明确的 omission/summary policy。
- A tool_use → B 的 tool_use/function_call/tool_call block。
- Tool call ID 默认原样保留。
- `finishReason A`、`rawFinishReason A` 与 `usage A` 必须进入 B-specific finish/usage converter，不能作为 A event 原样转发。
- 本文不定义它们在 B 中的 field name、value、nesting、event type 或 event position；这些只能由确定版本的 Protocol B schema 决定。
- `finish` 和 `usage` 都是 response-level metadata，不放入 `content[] B`。
- `rawEvents` 只用于 debug，不参加 A → B conversion。

如果 Protocol B 对 tool-call ID 有 prefix、length 或 character set 限制，必须维护 stable bidirectional mapping，并至少保存到下一次 B request-side tool result 转回 A tool result 完成。不能在 response 和下一次 request 中分别随机生成 ID。

---

# 10. `content[] A` → `content[] B` → SSE B

## 10.1 Protocol B 必须提供的能力

`content[] B` 不是完整 response。B-specific adapter 还必须构造：

- response/message ID
- model、role、object fields
- block index
- target terminal/completion reason
- usage
- provider metadata
- error schema
- event lifecycle
- terminal event
- HTTP status/headers

推荐接口：

~~~ts
export interface SseFrame {
  event?: string;
  id?: string;
  retry?: number;
  data: string;
}

export interface ProtocolBCodec<
  BContent,
  BFinish,
  BResult,
  BEvent,
> {
  /** Direct content[] A -> content[] B conversion. */
  convertContent(
    contentA: readonly ContentBlockA[],
  ): BContent[];

  /** Direct finish/usage A -> finish/usage B conversion. */
  convertFinish(input: {
    finishA: FinishEvent;
    usageA: NormalizedUsage;
    rawUsageA?: CommandCodeUsage;
    systemPromptTokensA?: number;
    sourceModel?: string;
  }): BFinish;

  /** Combine content[] B and finish/usage B into a B response. */
  buildResult(input: {
    content: BContent[];
    finish: BFinish;
  }): BResult;

  /** Must return events in exact Protocol B order. */
  events(result: BResult): Iterable<BEvent>;

  /** Convert one semantic B event to one SSE frame. */
  frame(event: BEvent): SseFrame;

  /** Validate before HTTP 200 headers are returned. */
  validate(result: BResult): void;

  /** B-specific non-stream HTTP error response. */
  errorResponse(error: unknown): Response;
}
~~~

`events(result)` 必须遵守 Protocol B 自己的 lifecycle。本文只要求 `finishReason`、`rawFinishReason` 与 usage 在需要 A → B conversion 时经过 `convertFinish()`；不规定转换结果的字段、取值或发送位置。

B conversion MUST preserve semantic order：

~~~text
content[] A order
  → content[] B order
  → B content block start/index order
~~~

一个 source block 映射成多个 target blocks 时，在 source position 原地连续展开。不要把 reasoning 全部移到最前、tool 全部移到最后。若 B schema 强制不同顺序，B adapter 应明确记录 warning 或直接 reject，不能静默重排。

## 10.2 `finishReason`、`rawFinishReason` 与 usage 的直接转换

输入来自 CommandCode final `finish` event：

~~~text
finishA.finishReason
finishA.rawFinishReason
finishA.totalUsage
finishA.systemPromptTokens
resultA.usage                 # normalized four-field view
resultA.rawUsage              # original totalUsage object
~~~

Conversion boundary：

1. 先使用 `acceptFinishReason(finishA)` 完成 CommandCode A 自己的 client-side processing。
2. `accepted.pauseTurn === true` 时继续请求 A；logical completion 尚未结束，不进入 final B conversion。
3. Final non-pause response 把原始 `finishA.finishReason`、`finishA.rawFinishReason`、raw/normalized usage 和 `systemPromptTokens` 一起传入 `convertFinish()`。
4. `convertFinish()` 必须由具体 Protocol B adapter 实现。
5. 本文不为未知 B 规定任何 reason mapping、token-field mapping、event name、event order 或 unsupported-field policy。
6. 不得把 CommandCode raw `{"type":"finish",...}` JSON line直接当作 B event；“转换”与“原样转发”是两种不同操作。

## 10.3 Reasoning policy

Protocol B 可能：

- 支持 equivalent reasoning block：direct map。
- 只支持 summary：map 为 summary，并在 B adapter 的 debug metadata/warning 中声明 approximation。
- 不支持 reasoning：omission，并明确记录 warning；strict mode 可以 reject。
- 要求 signature：只有 source 有 valid signature 时才能提供；不得伪造。
- 只支持 opaque/encrypted reasoning：不能把 plain source reasoning 冒充 native opaque item。

不要无条件把 reasoning 拼进 visible assistant text，这会改变 response semantics。

## 10.4 真正 SSE framing

Protocol B 若使用 conventional SSE，每个 event frame 是：

~~~text
event: <optional event name>\n
id: <optional id>\n
retry: <optional milliseconds>\n
data: <line 1>\n
data: <line 2>\n
\n
~~~

一条 blank line 结束一个 SSE frame。JSON payload 通常放在 `data:` 后，但 event name 和 JSON schema 由 Protocol B 决定。

这和 CommandCode 的 bare JSON Lines 不同：

~~~text
CommandCode A: JSON.stringify(event) + "\n"
Protocol B SSE: data/event fields + blank line
~~~

### SSE frame encoder

~~~ts
function assertSingleLine(
  name: string,
  value: string,
): void {
  if (/[\r\n]/.test(value)) {
    throw new TypeError(`${name} must not contain CR or LF`);
  }
}

export function encodeSseFrame(frame: SseFrame): string {
  let output = "";

  if (frame.event !== undefined) {
    assertSingleLine("event", frame.event);
    output += `event: ${frame.event}\n`;
  }
  if (frame.id !== undefined) {
    assertSingleLine("id", frame.id);
    output += `id: ${frame.id}\n`;
  }
  if (frame.retry !== undefined) {
    if (!Number.isInteger(frame.retry) || frame.retry < 0) {
      throw new TypeError("retry must be a non-negative integer");
    }
    output += `retry: ${frame.retry}\n`;
  }

  const normalizedData = frame.data.replace(/\r\n?/g, "\n");
  for (const line of normalizedData.split("\n")) {
    output += `data: ${line}\n`;
  }
  return output + "\n";
}
~~~

### Buffered SSE response

~~~ts
export function createProtocolBSseResponse<
  BContent,
  BFinish,
  BResult,
  BEvent,
>(
  result: BResult,
  codec: ProtocolBCodec<
    BContent,
    BFinish,
    BResult,
    BEvent
  >,
): Response {
  // All conversion and serialization errors must happen here,
  // before returning a 200 Response.
  codec.validate(result);
  const encoded = Array.from(codec.events(result), (event) =>
    encodeSseFrame(codec.frame(event)),
  );

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        for (const frame of encoded) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      } catch (cause) {
        controller.error(cause);
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
~~~

Application code 不设置 `Content-Length` 或 `Transfer-Encoding`。某些 serverless runtime 不允许 application 设置 `Connection`；此时 omission 并交给 platform。

`data:[DONE]` 不是 universal SSE rule。只有 Protocol B 的指定 endpoint/version 要求时，B codec 才能发送它。

## 10.5 End-to-end adapter

~~~ts
export async function adaptCommandCodeToProtocolB<
  BContent,
  BFinish,
  BResult,
  BEvent,
>(input: {
  upstreamResponse: Response;
  sourceModel?: string;
  codec: ProtocolBCodec<
    BContent,
    BFinish,
    BResult,
    BEvent
  >;
}): Promise<Response> {
  try {
    const resultA = await consumeCommandCodeResponse(
      input.upstreamResponse,
    );

    if (!resultA.committed || resultA.aborted) {
      return input.codec.errorResponse(
        new Error("CommandCode generation aborted"),
      );
    }

    if (!resultA.finish) {
      return input.codec.errorResponse(
        new Error("CommandCode finish event is missing"),
      );
    }

    const contentB = input.codec.convertContent(
      resultA.content,
    );
    const finishB = input.codec.convertFinish({
      finishA: resultA.finish,
      usageA: resultA.usage,
      rawUsageA: resultA.rawUsage,
      systemPromptTokensA: resultA.systemPromptTokens,
      sourceModel: input.sourceModel,
    });
    const resultB = input.codec.buildResult({
      content: contentB,
      finish: finishB,
    });
    return createProtocolBSseResponse(resultB, input.codec);
  } catch (cause) {
    return input.codec.errorResponse(cause);
  }
}
~~~

若使用 `completeWithPauseTurn`，直接把 logical result 的最终 `content`、`finish` 和 aggregated `usage` 交给同一 B adapter；不能逐 part 开始 B response。

---

# 11. Error、retry 与 cancellation policy

## 11.1 Buffered adapter

| Failure point | Protocol B behavior |
|---|---|
| A network/HTTP failure，B headers 未发送 | 用 B-specific non-2xx status + JSON error body |
| A stream `error`，B headers 未发送 | B-specific non-2xx error |
| A truncated EOF | retry A；exhausted 后 B-specific non-2xx error |
| A `abort` | rollback A；不要发送 content B；返回 B-specific abort/error |
| `content[] A` → `content[] B` conversion failure | B-specific non-2xx error |
| B result validation/serialization failure | B-specific non-2xx error |
| downstream disconnect | cancel A fetch signal when possible |

Retry MUST 发生在 B 200 response 开始之前。每次 retry 使用新的 response-local assembler；不能把 failed attempt 的 slots、usage 或 raw terminal state合并到 next attempt。

## 11.2 Live adapter 的限制

如果未来实现 live A → B transform，一旦 B bytes 已经发送：

- 上游 abort 无法撤回已发送 text/reasoning/tool block。
- conversion error 只能发送 B-defined in-stream error 或直接 EOF。
- retry 可能产生 duplicate content。
- tool placeholder、partial JSON、backpressure、block index 和 lifecycle 都要 incremental 管理。

因此 v1.0 推荐且规范化的实现是 buffered semantic adapter。Live adapter 是独立 profile，不能声称具备 atomic rollback。

---

# 12. Protocol examples

## 12.1 Minimal text request

~~~json
{
  "config": {
    "workingDir": "C:\\work\\repo",
    "date": "2026-08-09",
    "environment": "win32",
    "structure": ["package.json", "src"],
    "isGitRepo": true,
    "currentBranch": "main",
    "mainBranch": "main",
    "gitStatus": "Working tree clean",
    "recentCommits": ["abc1234 Initial commit"]
  },
  "memory": null,
  "taste": null,
  "skills": null,
  "permissionMode": "standard",
  "threadId": "2b722f90-c48c-46b4-bef5-b21a4d080277",
  "params": {
    "model": "provider/model",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "hello"}
        ]
      }
    ],
    "tools": [],
    "system": "You are a coding agent.",
    "max_tokens": 64000,
    "stream": true
  }
}
~~~

## 12.2 Interleaved response and final `content[] A`

~~~jsonl
{"type":"reasoning-start","id":"r1"}
{"type":"reasoning-delta","id":"r1","text":"check"}
{"type":"text-start","id":"t1"}
{"type":"text-delta","id":"t1","text":"answer"}
{"type":"tool-input-start","id":"call_1","toolName":"read_file"}
{"type":"tool-input-delta","id":"call_1","delta":"{\"path\":\"a.ts\"}"}
{"type":"text-end","id":"t1"}
{"type":"reasoning-end","id":"r1"}
{"type":"tool-input-end","id":"call_1"}
{"type":"tool-call","toolCallId":"call_1","toolName":"read_file","input":{"path":"a.ts"}}
{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":100,"inputTokenDetails":{"cacheReadTokens":40},"outputTokens":20,"totalTokens":120}}
~~~

Result order 由 first appearance 决定，不由 end time 决定：

~~~json
[
  {"type":"reasoning","id":"r1","text":"check"},
  {"type":"text","id":"t1","text":"answer"},
  {"type":"tool_use","id":"call_1","toolName":"read_file","input":{"path":"a.ts"}}
]
~~~

Normalized usage：

~~~json
{
  "inputTokens": 100,
  "outputTokens": 20,
  "cacheReadTokens": 40,
  "cacheWriteTokens": 0
}
~~~

## 12.3 Next request with tool result

~~~json
{
  "role": "tool",
  "content": [
    {
      "type": "tool-result",
      "toolCallId": "call_1",
      "toolName": "",
      "output": {
        "type": "text",
        "value": "file contents"
      }
    }
  ]
}
~~~

## 12.4 Abort

~~~jsonl
{"type":"text-start","id":"t1"}
{"type":"text-delta","id":"t1","text":"partial"}
{"type":"abort"}
~~~

Atomic result：

~~~json
{
  "content": [],
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0
  },
  "committed": false,
  "aborted": true
}
~~~

`partial` 不进入最终 `content[] A`。因此需要转换时，它也不会进入 `content[] B` 或 Protocol B SSE。

---

# 13. AI implementation checklist

AI 在生成实现前必须逐项确认：

## Request

- [ ] 固定 `POST /alpha/generate`。
- [ ] `Content-Type: application/json`。
- [ ] `x-project-slug = slugify(cwd) || "root"`，package pin `2.2.1`。
- [ ] `x-session-id` 与 `threadId` 独立，但普通 flow 可相同。
- [ ] `threadId` 无效时 omission，不发送 empty string/null。
- [ ] `traceparent` 满足 W3C length/non-zero rules；pause continuation 复用。
- [ ] `config.structure` 只读取 immediate entries。
- [ ] Git failures 转 empty values。
- [ ] `memory/taste/skills` 明确发送 `null`。
- [ ] permission mapping 正确。
- [ ] request-side tool result 固定 `toolName:""`、`output.type:"text"`。
- [ ] `max_tokens` 默认 64000。
- [ ] `stream` 是 literal `true`。

## Response A

- [ ] 按 UTF-8 byte stream 解码，不按 HTTP chunk 解析 event。
- [ ] 按 LF 分割 bare JSON Lines，不解析 `data:` SSE。
- [ ] final unterminated line 在 EOF 时也解析。
- [ ] 每个 HTTP response 使用新的 assembler。
- [ ] 三个 Map + 一个 ordered `slots[]`。
- [ ] slot order 是 first event appearance order。
- [ ] tool start 占位，final tool-call materialize。
- [ ] response-side tool-result raw preserve、semantic ignore。
- [ ] finish 后继续读取到 EOF。
- [ ] finish.totalUsage raw preserve并 normalized。
- [ ] abort rollback并取消/drain，不 commit partial content。
- [ ] error/truncated EOF 不 commit。
- [ ] pause_turn 在 logical level继续请求并最后一次性 publish。

## Conversion and response B

- [ ] 不需要转换时，返回 `content[] A` 后结束。
- [ ] 需要转换时，直接把 `content[] A` 转成 `content[] B`。
- [ ] 不以 source JSON Lines 作为 A → B conversion unit。
- [ ] 保持 block semantic order。
- [ ] tool-call ID 跨 response/request stable。
- [ ] reasoning 使用 explicit target policy。
- [ ] 正确读取 A wire `finishReason` 与 `rawFinishReason`；不把内部 `stopReason` 误写成 wire field。
- [ ] `rawFinishReason A` 先完成 `pause_turn` control flow；pause response 不进入 final B conversion。
- [ ] Final `finishReason A`、`rawFinishReason A`、usage 与 `systemPromptTokens` 全部交给 B-specific `convertFinish()`。
- [ ] 不在通用 adapter 中假定 B 的 reason value、token field、nesting 或 event position。
- [ ] 不把 CommandCode raw finish JSON line直接当作 B event。
- [ ] B result 在返回 HTTP 200 前完整 validation/serialization。
- [ ] B codec 生成 B-specific semantic events。
- [ ] 真 SSE 每个 frame 使用 `data:` 等 field，并以 blank line 结束。
- [ ] `[DONE]` 只在指定 B endpoint/version 要求时发送。
- [ ] upstream error/abort 发生时，buffered profile 尚未发送任何 B semantic bytes。

---

# 14. 最终推荐

v1.0 推荐唯一主路径：

~~~text
1. Build exact CommandCode request.
2. Send params.stream=true.
3. Decode bare JSON Lines.
4. Assemble response-local blocks by event id.
5. Preserve first-appearance order in slots[].
6. Commit only on finish + physical EOF.
7. Roll back the whole response on abort/error.
8. Produce content[] A plus finish/usage/rawEvents.
9. If no conversion is required, return content[] A and stop.
10. If conversion is required, convert content[] A directly to content[] B.
11. Pass finishReason/rawFinishReason/usage A through B-specific conversion.
12. Build B events exactly as the selected B protocol defines.
13. Validate every B event before starting HTTP 200.
14. Encode Protocol B events with Protocol B's exact SSE framing.
~~~

这套设计把 source wire、最终 `content[] A`、可选的 `content[] B` 和 target wire 分离，但不增加中间 conversion layer。只使用 CommandCode 时，`content[] A` 就是终点；只有 router 需要模拟 Protocol B 时才继续转换。Buffered conversion 的代价是等待完整 upstream response 后再 replay B stream；换来的结果是顺序明确、tool association 稳定、usage/finish 可验证，并且 abort/error 不会污染 downstream client。
