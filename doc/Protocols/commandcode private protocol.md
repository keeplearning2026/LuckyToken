# CommandCode Private Protocol v1.3

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
immutable content[] A + finish + final usage + response identity/notices
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
| `zod@4.1.5` | 验证并统一 body `threadId` 与 header `x-session-id` | yes |
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

Router SHOULD 把 `baseUrl` 作为显式 deployment config，并固定 absolute path `/alpha/generate`。URL resolution 保留 `baseUrl` 的 scheme/authority，但替换任何 base path，并丢弃 query/fragment；例如 `https://host/prefix` 必须解析为 `https://host/alpha/generate`，不是 `https://host/prefix/alpha/generate`。不要根据 model name 改 path。

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
  cwd?: string;
  identity: CommandCodeSessionIdentity;
  traceparent?: string;
  tasteLearning?: boolean;
  coFlag?: boolean;
  ossPrimaryProvider?: string;
}
~~~

| Header | 计算规则 |
|---|---|
| `Content-Type` | fixed `application/json` |
| `Accept` | explicit `*/*` |
| `User-Agent` | fixed `cli` |
| `x-command-code-version` | fixed `1.9.0` |
| `x-cli-environment` | `prod` 转成 `production`；其他 string 原样使用；默认 `production` |
| `x-project-slug` | 非空 string 工作目录使用 `slugify(cwd) || "root"`；缺失、空或非 string 时 omission |
| `x-taste-learning` | boolean 转 lowercase string；默认 `false` |
| `x-co-flag` | boolean 转 lowercase string；默认 `false` |
| `x-session-id` | 与 body `threadId` 相同的 authoritative logical UUID；缺失或无效 caller value 被随机 UUID 替换 |
| `Authorization` | 有 CommandCode API key 时为 `Bearer <key>`，否则 omission |
| `traceparent` | valid chat span 时发送；否则 omission |
| `x-oss-primary-provider` | 有 selected OSS provider 时发送，否则 omission |
| `x-cmd-zdr` | fixed string `1`；当前 profile 总是发送 |

`Host`、`Connection`、`Content-Length`、`Accept-Encoding` 等 transport headers 由 HTTP runtime 计算，application code MUST NOT 手工计算 `Content-Length`。

当前 profile MUST NOT 发送 `x-oauth-token` 或 `x-oauth-provider`。OAuth credential 不属于这个 wire contract。

### 3.3.1 `x-project-slug`

~~~ts
import slugify from "@sindresorhus/slugify";

export function buildProjectSlug(cwd?: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd === "") return undefined;
  return slugify(cwd) || "root";
}
~~~

只有已经存在的非空 project fact 才能产生 header；`root` 只是该非空值经 `slugify` 后为空的 fallback，不能用来臆造缺失的项目身份。不要先自行替换 path separator；直接把 runtime cwd 传给 `slugify`。为了不同机器和时间得到一致行为，必须 pin `2.2.1`，不要只写 caret range。

### 3.3.2 `x-session-id` 与 `threadId`

两者来自同一个 authoritative logical identity：

- `x-session-id` 是 header representation。
- `threadId` 是 request body representation。
- caller 提供 valid UUID 时原样使用。
- caller 未提供或提供 invalid UUID 时生成一个 random UUID。
- 两个 wire field MUST 使用同一个 UUID，不能分别生成或覆盖。

~~~ts
import { randomUUID } from "node:crypto";
import { z } from "zod";

export function createSessionIdentity(
  threadId?: string,
): CommandCodeSessionIdentity {
  const id = z.uuid().safeParse(threadId).success
    ? threadId!
    : randomUUID();
  return { sessionId: id, threadId: id };
}

export interface CommandCodeSessionIdentity {
  sessionId: string;
  threadId: string;
}

export function assertSessionIdentity(
  identity: CommandCodeSessionIdentity,
): void {
  if (
    identity.sessionId !== identity.threadId
    || !z.uuid().safeParse(identity.sessionId).success
  ) {
    throw new TypeError(
      "sessionId and threadId must be the same valid UUID",
    );
  }
}
~~~

Application 必须调用一次 `createSessionIdentity()`，把同一个 result 交给 header builder 和 request builder。Builder 对已 resolved identity 再执行 defensive assertion，防止 application 在两个阶段分别改值。

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
  assertSessionIdentity(input.identity);
  const headers = new Headers({
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": "cli",
    "x-command-code-version": "1.9.0",
    "x-cli-environment": normalizeCliEnvironment(
      input.cliEnvironment,
    ),
    "x-taste-learning": String(input.tasteLearning ?? false),
    "x-co-flag": String(input.coFlag ?? false),
    "x-session-id": input.identity.sessionId,
    "x-cmd-zdr": "1",
  });

  const projectSlug = buildProjectSlug(input.cwd);
  if (projectSlug !== undefined) {
    headers.set("x-project-slug", projectSlug);
  }

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

export type ReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

// WireMessage and its block types are defined authoritatively
// in section 5.2 and are not duplicated here.

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
  reasoning_effort?: ReasoningEffort;
}

export interface GenerateRequest {
  config: ServerConfig;
  memory: null;
  taste: null;
  skills: null;
  permissionMode: PermissionMode;
  threadId: string;
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
| `permissionMode` | caller 提供可用 mapping 时计算，否则默认 `standard` |
| `threadId` | 与 `x-session-id` 相同；caller value 缺失或无效时使用同一个随机 UUID |
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

`config` 只有在 caller 提供 non-empty cwd 时才读取 filesystem/Git。未知 cwd 时返回类型稳定的 empty config，不使用 `process.cwd()` 作为隐式替代，也不执行任何 filesystem/Git command。

~~~json
{
  "workingDir": "",
  "date": "",
  "environment": "",
  "structure": [],
  "isGitRepo": false,
  "currentBranch": "",
  "mainBranch": "",
  "gitStatus": "",
  "recentCommits": []
}
~~~

## 4.1 `workingDir`、`date`、`environment`

~~~text
workingDir  = caller 提供的 cwd，保留原始 path string
date        = new Date().toISOString().split("T")[0]
environment = process.platform，例如 win32、linux、darwin
~~~

`date` 使用 UTC date，不是 local date。只有 project-bound config 计算 date；empty config 的 `date` 固定为 `""`。

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

每条 Git command 必须区分 successful empty output 与 failure。Failure、non-zero exit 或 exception 使用 `{ok:false}` 表示，不能与 `{ok:true, output:""}` 合并。

`mainBranch`：

1. remote HEAD command 成功且 output non-empty：删除开头 `origin/`。
2. 否则执行 remote branches command；成功且包含 `origin/main`：使用 `main`。
3. 成功且包含 `origin/master`：使用 `master`。
4. remote branches command 成功但没有已知 branch：使用 `main`。
5. remote HEAD 与 remote branches 都失败：使用 empty string。

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

只有 `git status --porcelain` 成功且 stdout empty 时，`gitStatus` 才是 fixed string `Working tree clean`。Command failure 时 `gitStatus` 为 empty string。

## 4.4 TypeScript implementation

~~~ts
import os from "node:os";
import process from "node:process";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type GitOutput =
  | { ok: true; output: string }
  | { ok: false };

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
): Promise<GitOutput> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    return { ok: true, output: stdout.trim() };
  } catch {
    return { ok: false };
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
  if (remoteHead.ok && remoteHead.output) {
    return remoteHead.output.replace(/^origin\//, "");
  }

  const remoteBranches = await gitOutput(cwd, [
    "branch",
    "-r",
  ]);
  if (!remoteBranches.ok) return "";
  if (remoteBranches.output.includes("origin/main")) {
    return "main";
  }
  if (remoteBranches.output.includes("origin/master")) {
    return "master";
  }
  return "main";
}

function createEmptyServerConfig(): ServerConfig {
  return {
    workingDir: "",
    date: "",
    environment: "",
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

export async function buildServerConfig(input: {
  cwd?: string;
  home?: string;
  platform?: string;
  workspaceRoots?: string[];
} = {}): Promise<ServerConfig> {
  if (!input.cwd) return createEmptyServerConfig();

  const cwd = input.cwd;
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

  if (!gitDir.ok) {
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

  const currentBranchResult = await gitOutput(cwd, [
    "branch",
    "--show-current",
  ]);
  const mainBranch = await resolveMainBranch(cwd);
  const gitStatusResult = await gitOutput(cwd, [
    "status",
    "--porcelain",
  ]);
  const recentCommitsResult = await gitOutput(cwd, [
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
    currentBranch: currentBranchResult.ok
      ? currentBranchResult.output
      : "",
    mainBranch,
    gitStatus: gitStatusResult.ok
      ? gitStatusResult.output || "Working tree clean"
      : "",
    recentCommits:
      recentCommitsResult.ok && recentCommitsResult.output
        ? recentCommitsResult.output.split("\n")
        : [],
  };
}
~~~

Additional workspace roots 必须与 cwd/home 使用一致的 path representation。上述 `formatScopeDir` 用 literal `/` 做 prefix comparison；普通单-root router 直接使用 `workspaceRoots:[cwd]` 即可。

推荐每个 logical completion 计算一次 `config`。是否跨多个用户 turn cache 是 client policy，不改变 wire schema。

---

# 5. `params`、messages 与 tools

## 5.1 `params` fields

| Field | 计算规则 |
|---|---|
| `model` | caller 选择的 CommandCode provider/model identifier；required |
| `messages` | 已转换的 CommandCode wire messages；required，可为空但不推荐 |
| `tools` | 当前可用 tool definitions；required；没有 tool 时为 `[]` |
| `system` | caller 提供 string 时发送；`undefined` 时 omission |
| `max_tokens` | required；LuckyToken 使用 `options.maxTokens ?? model.maxTokens`，model catalog 对明确的 `maxOutputTokens` 使用该值，否则使用官方 CLI default 64000 |
| `stream` | literal `true`，不可设置为 false |
| `temperature` | number 时发送，包括 `0`；`undefined` 时 omission |
| `reasoning_effort` | caller 指定时先 normalize；未知 non-empty value 使用 `max`；normalized value 只有在 selected model capability 支持时才发送 |

`reasoning_effort` 的已知值为 `low`、`medium`、`high`、`xhigh`、`max`，但每个 model 只支持 subset。Router MUST 用 model capability table 决定是否发送，不能对所有 model 强加同一 value。Caller omission 始终保持 omission；只有 caller 提供 non-empty unknown value 时才 normalize 为 `max`。

~~~ts
export function buildGenerateParams(input: {
  model: string;
  messages: WireMessage[];
  tools?: WireTool[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  supportedReasoningEfforts?: readonly ReasoningEffort[];
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
  if (input.reasoningEffort) {
    const known = new Set<ReasoningEffort>([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    const normalized: ReasoningEffort = known.has(
      input.reasoningEffort as ReasoningEffort,
    )
      ? input.reasoningEffort as ReasoningEffort
      : "max";

    if (input.supportedReasoningEfforts?.includes(normalized)) {
      params.reasoning_effort = normalized;
    }
  }

  return params;
}
~~~

## 5.2 Message Spec

### 1. 总览

`params.messages` 是发送给 `/alpha/generate` 的消息数组。每个元素是一个 wire message，只有三种 role：

| role        | 含义                                    | content 里允许的 block           |
| ----------- | --------------------------------------- | -------------------------------- |
| `user`      | 用户内容                                | `text`、`image`                  |
| `assistant` | 模型回复                                | `text`、`reasoning`、`tool-call` |
| `tool`      | 工具结果（回应 assistant 的 tool-call） | `tool-result`                    |

### 2. Wire 类型定义

```ts
export type WireMessage =
  | UserMessage
  | AssistantMessage
  | ToolMessage;

// ── role: "user" ─────────────────────────────────────────────
export type UserMessage = {
  role: "user";
  content: (
    | { type: "text";  text: string }
    | { type: "image"; image: string; mimeType: string }
  )[];
};

// ── role: "assistant" ────────────────────────────────────────
export type AssistantMessage = {
  role: "assistant";
  content: (
    | { type: "text";      text: string }
    | { type: "reasoning"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
  )[];
};

// ── role: "tool" ─────────────────────────────────────────────
export type ToolMessage = {
  role: "tool";
  content: {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text" | "error-text"; value: string };
  }[];
};
```

### 3. 字段格式与语义

#### 3.1 `user` 消息

**`text` block**

```json
{ "type": "text", "text": "hello" }
```

- `text: string`：消息文本。空字符串、纯空白（`"   "`、`"\n"`）、空 `content` 数组服务端均接受（线上实测）；CLI 规范会在发送前清理空 text block，但服务端不强制。

**`image` block**

```json
{ "type": "image", "image": "data:image/png;base64,iVBORw0KGgo...", "mimeType": "image/png" }
```

- `image: string`：完整 data URL，形态 `data:<mime>;base64,<base64 数据>`。不是裸 base64、不是文件路径、不是 http URL。
- `mimeType: string`：图片 MIME 类型，与 data URL 里的 MIME 段一致。

#### 3.2 `assistant` 消息

**`text` block**

```json
{ "type": "text", "text": "我来看一下" }
```

- `text: string`：模型回复文本。

**`reasoning` block**

```json
{ "type": "reasoning", "text": "用户要读文件，我调用 read_file。" }
```

- `text: string`：模型的思考/推理内容。不要用 `thinking` / `redacted_thinking`（服务端拒绝）。

**`tool-call` block**

```json
{ "type": "tool-call", "toolCallId": "call_1", "toolName": "read_file", "input": { "file_path": "/tmp/a.txt" } }
```

- `toolCallId: string`：本次调用的唯一 ID，后续 `tool-result` 用它配对。
- `toolName: string`：工具名。Historical `tool-call` 只保留原始名称，不要求该名称仍存在于当前请求的 `tools` 数组。
- `input: Record<string, unknown>`：传给工具的 JSON object，可以有多个键值对（键=参数名，值=参数值）。本协议层不根据工具的 `input_schema` 校验键名、值类型或必填字段；空对象 `{}` 合法。
- **字段名必须是 `input`**。用 `arguments` 或缺少该字段会被服务端拒绝（`missing field 'input'`）。

多参数示例：

```json
{
  "type": "tool-call",
  "toolCallId": "call_1",
  "toolName": "read_file",
  "input": { "file_path": "/tmp/a.txt", "offset": 100, "limit": 50 }
}
```

#### 3.3 `tool` 消息

**`tool-result` block**

```json
{ "type": "tool-result", "toolCallId": "call_1", "toolName": "", "output": { "type": "text", "value": "1: hello world" } }
```

- `toolCallId: string`：必须与配对的 `tool-call.toolCallId` 相同。
- `toolName: string`：wire 接受空或非空；LuckyToken Pi conversion 对真实结果保留非空 Pi toolName。
- `output.type: "text"`：工具成功输出；`"error-text"`：工具失败/被拒/中断。
- `output.value: string`：工具输出纯文本。多行以 `\n` 连接（多行/长文本均接受）。结构化数据（JSON）应转成字符串。
- `output` 必须是单个对象 `{type, value}`。数组、裸字符串、缺失均被拒绝。
- "多个输出"在 wire 层体现为**多个 `tool-result` block**：一个 `tool` 消息的 `content` 可含多个 `tool-result`（各自配对不同的 `toolCallId`）。

**synthetic `tool-result`（占位结果）**

当 `tool-call` 没有对应的真实结果时（工具被中断/丢失），补一个占位 `tool-result`。wire 形态与普通 `tool-result` 相同，仅 `output.value` 固定：

```json
{
  "type": "tool-result",
  "toolCallId": "call_1",
  "toolName": "read_file",
  "output": {
    "type": "text",
    "value": "No result — the tool call did not complete (interrupted or lost)."
  }
}
```

- `toolCallId`：与被补的 `tool-call.toolCallId` 相同（保证配对）。
- `toolName`：使用 pending tool call 的原始名称。
- `output.type`：由 Provider-local `syntheticMissingToolResultOutputType` 决定，默认 `"text"`，也可为 `"error-text"`。

### 4. 禁止类型（服务端拒绝）

| 类型                            | 位置              | 结果                  |
| ------------------------------- | ----------------- | --------------------- |
| `thinking`                      | assistant content | 拒绝（schema 不匹配） |
| `redacted_thinking`             | assistant content | 拒绝（schema 不匹配） |
| `tool_use`（Anthropic 风格）    | assistant content | 拒绝（schema 不匹配） |
| `tool_result`（Anthropic 风格） | user content      | 拒绝（schema 不匹配） |

### 5. 硬规则（服务端强制，违反即拒绝）

| #    | 规则                                                         | 违反时的表现                                                 |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 1    | `role` 只能是 `user` / `assistant` / `tool`                  | HTTP 400 `BAD_REQUEST`（`system`）                           |
| 2    | 每个 `tool-call` 必须有配对的 `tool-result`（同 `toolCallId`，且紧跟其 assistant，见 §6） | 流内 `error`：`Tool result is missing for tool call <id>.`   |
| 3    | 每个 `tool-result` 必须有配对的 `tool-call`（即 `tool` 消息必须回应某个 assistant 的 tool-call） | 流内 `error`：`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` |
| 4    | 每个含 `tool-call` 的 `assistant` 后面必须紧跟 `tool` 消息（见 §6） | 流内 `error`：`An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'` |
| 5    | `tool-call` 的参数字段名必须是 `input`（对象）               | 流内 `error`：`missing field 'input'`（用 `arguments` 或缺字段时） |
| 6    | `tool-result.output` 必须是对象 `{ type: "text"\|"error-text", value: string }` | 流内 `error`：schema 不匹配（数组/裸字符串/缺失时）          |
| 7    | content block 必须用 wire 命名（`tool-call`/`tool-result`/`text`/`image`/`reasoning`） | 流内 `error`：schema 不匹配（`tool_use`/`tool_result` 等内部命名） |

#### 5.1 空 block 与空 content（router 不过滤）

**决策：router 不做 CLI 的过滤清理，空 block / 空 content 原样发送。** 服务端全部接受（线上实测）：

| 场景                                              | 线上实测 |
| ------------------------------------------------- | -------- |
| 空 text block（`""`、`"   "`、`"\n"`）            | ✅ 接受   |
| 空 reasoning block（`""`、`"   "`）               | ✅ 接受   |
| 空 `content: []`（user 或 assistant，含夹在中间） | ✅ 接受   |

CLI 源码（`prepareForSend` / `cleanContent` / `isEmptyText`）会在发送前过滤空 text、删除空 content 消息，但那是 CLI 的规范行为，**不是服务端要求**。router 可以直接发送，无需实现过滤。

唯一仍需遵守的是 §5 的配对规则（服务端强制）：每个含 `tool-call` 的 assistant 后必须紧跟覆盖其全部 call 的 tool 消息（见 §6）。

### 6. 消息顺序约束

| 规则                                                         | 结果                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| 首条可以是 `user` 或 `assistant`（text）                     | ✅ 接受                                                       |
| 首条不能是 `tool`                                            | ❌ 拒绝                                                       |
| **每个含 `tool-call` 的 `assistant`，其后面必须紧跟 `tool` 消息，且这些 tool 消息的 `toolCallId` 必须覆盖该 assistant 的所有 `tool-call`** | 强制。`assistant(call) → user` 报 `Tool result is missing for tool call <id>.`；`assistant(call) → assistant(...)` 报 `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`；无前置 assistant 的 `tool` 报 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` |
| 相邻同 role：`user,user`                                     | ✅ 接受                                                       |
| 相邻同 role：`assistant,assistant`                           | ✅ 接受（仅当 assistant 不含 tool-call；含 tool-call 的 assistant 后紧跟 assistant 必拒） |
| 相邻同 role：`tool,tool`                                     | ✅ 接受（前提：这些 tool 消息都紧跟覆盖其 tool-call 的 assistant，如 `asst(c1+c2), tool(c1), tool(c2)`） |
| `tool` 后跟 `user` 或 `assistant`（text）                    | ✅ 接受                                                       |
| `tool` 后跟 `assistant`（tool-call）                         | ✅ 接受（但该 assistant 后仍须紧跟其自己的 tool 消息）        |
| 多轮 `assistant → tool → assistant → tool ...` 交替          | ✅ 接受                                                       |

#### 6.1 一个 assistant 带多个 tool-call 的两种合法写法

一个 assistant 含多个 `tool-call` 时，其后的 `tool` 结果**可以拆成多个 `tool` 消息，也可以合并成一个 `tool` 消息**（均线上实测接受）：

**写法 A：拆成多个 tool 消息（每个含一个 tool-result）**

```json
{
  "role": "assistant",
  "content": [
    { "type": "tool-call", "toolCallId": "call_00", "toolName": "shell_command", "input": { "command": "Get-Content README.md" } },
    { "type": "tool-call", "toolCallId": "call_01", "toolName": "shell_command", "input": { "command": "Get-ChildItem" } }
  ]
},
{
  "role": "tool",
  "content": [
    { "type": "tool-result", "toolCallId": "call_00", "toolName": "", "output": { "type": "text", "value": "..." } }
  ]
},
{
  "role": "tool",
  "content": [
    { "type": "tool-result", "toolCallId": "call_01", "toolName": "", "output": { "type": "text", "value": "..." } }
  ]
}
```

**写法 B：合并成一个 tool 消息（含多个 tool-result block）**

```json
{
  "role": "assistant",
  "content": [
    { "type": "tool-call", "toolCallId": "call_00", "toolName": "shell_command", "input": { "command": "Get-Content README.md" } },
    { "type": "tool-call", "toolCallId": "call_01", "toolName": "shell_command", "input": { "command": "Get-ChildItem" } }
  ]
},
{
  "role": "tool",
  "content": [
    { "type": "tool-result", "toolCallId": "call_00", "toolName": "", "output": { "type": "text", "value": "..." } },
    { "type": "tool-result", "toolCallId": "call_01", "toolName": "", "output": { "type": "text", "value": "..." } }
  ]
}
```

两种写法都必须满足 §6 核心规则：tool 消息紧跟该 assistant，且 toolCallId 集合恰好覆盖其所有 tool-call。`toolName` 用非空值（如 `"shell_command"`）也可接受（见 §7）。

### 7. 服务端宽容项（接受，但 CLI 规范会避免）

| 项                                                           | 说明                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| 带 `meta` 字段                                               | 接受（忽略）                                                 |
| `tool-result.toolName` 非空                                  | 接受                                                         |
| 相邻同 role（`user,user`、`assistant,assistant`、`tool,tool`） | 接受（前提是每个含 tool-call 的 assistant 后仍紧跟覆盖其 call 的 tool 消息，见 §6） |
| assistant 混合 `text` + `tool-call`                          | 接受                                                         |
| 空 `input`（`{}`）                                           | 接受                                                         |

### 8. 错误返回的两种形态

| 形态                                  | 触发                                 | 处理建议                                                     |
| ------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| HTTP 400 JSON（`code:"BAD_REQUEST"`） | role 枚举错、schema 反序列化失败     | 修复请求后重发                                               |
| HTTP 200 + 流内 `error` 事件          | 配对错误、ModelMessage schema 不匹配 | 读 `error.error.message`；`statusCode=400`、`isRetryable=false`，不要重试 |

### 9. 完整示例（一轮工具调用）

```json
{
  "params": {
    "model": "commandcode-private/deepseek/deepseek-v4-flash",
    "messages": [
      {
        "role": "user",
        "content": [{ "type": "text", "text": "读取 /tmp/a.txt" }]
      },
      {
        "role": "assistant",
        "content": [
          { "type": "reasoning", "text": "用户要读文件，我调用 read_file。" },
          {
            "type": "tool-call",
            "toolCallId": "call_1",
            "toolName": "read_file",
            "input": { "file_path": "/tmp/a.txt", "offset": 1, "limit": 100 }
          }
        ]
      },
      {
        "role": "tool",
        "content": [
          {
            "type": "tool-result",
            "toolCallId": "call_1",
            "toolName": "",
            "output": { "type": "text", "value": "1: hello world" }
          }
        ]
      },
      {
        "role": "user",
        "content": [{ "type": "text", "text": "继续" }]
      }
    ],
    "tools": [
      {
        "name": "read_file",
        "description": "Read a file with optional offset and limit.",
        "input_schema": {
          "type": "object",
          "properties": {
            "file_path": { "type": "string" },
            "offset": { "type": "integer" },
            "limit": { "type": "integer" }
          },
          "required": ["file_path"]
        }
      }
    ],
    "max_tokens": 64000,
    "stream": true
  }
}
```

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
  identity: CommandCodeSessionIdentity;
  mode?: string;
  params: GenerateParams;
}

export function buildGenerateRequest(
  input: BuildGenerateRequestInput,
): GenerateRequest {
  assertSessionIdentity(input.identity);
  const body: GenerateRequest = {
    config: input.config,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: toWirePermissionMode(
      input.permissionMode,
    ),
    threadId: input.identity.threadId,
    params: input.params,
  };

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

Non-2xx response：按 immutable Provider policy 与 shared neutral cap 有界读取 body，
生成 neutral HTTP fact；禁止完整读取、保留 raw body 或让 capture/cleanup failure 覆盖
已经确认的 HTTP status。Retry classification：

| Failure | retryable |
|---|---:|
| network exception | true |
| HTTP 429 | true |
| HTTP 500–599 | true |
| other non-2xx | false |
| 2xx but response body missing | true |
| physical EOF with neither `finish` nor `abort` | true（neutral `transport/unexpected_eof`；不虚构 status） |
| stream `error` event | 使用 event.isRetryable；缺失时 false |
| unknown/malformed/lifecycle error | false |
| `abort` / final `pause_turn` | false |

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
- final `tool-call.toolName` 是 authoritative value，无条件覆盖 matching `tool-input-start.toolName`。
- authoritative final input 按 own-property precedence 选择：存在 `input` 就使用 `input`；否则存在 `args` 就使用 `args`；两者都缺失才使用 `{}`。已存在但非法的 `input` 不得回退到 `args` 修复。
- Response consumer 必须 clone lossless JSON object。Explicit null、array、string、number、boolean 或任何非 lossless JSON tree 都是 malformed known event；preview delta 永不参与 materialization。

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
| `start` | validate known shape，semantic drop |
| `start-step` | validate request/warnings shape，semantic drop |
| `provider-metadata` | validate object，semantic drop |
| `finish-step` | validate response；stage last non-empty response id/modelId；usage 不是 final usage source |
| response-side `tool-result` | validate known shape，semantic drop |
| unknown event | Provider policy `error|ignore`（default `error`）；ignore 只记录 bounded notice，不能代替 finish |

Final usage 只取自最后一个 `finish` event。若最后一个 finish 缺少 `totalUsage`，raw usage 为 missing、normalized usage 为四个零；不能沿用更早 finish 的 usage。`finish-step.usage` 可以有更多 provider metadata，但不能取代 final `finish.totalUsage`。

---

# 7. 推荐的 Atomic ID-indexed Ordered Block Assembler

我们的主要目的就是通过event组装得到有特定顺序内容的content数组，还有finish.

## 7.1 Invariants

每个 HTTP response 创建独立 staging area：

~~~text
textById       Map<string, TextSlot>
reasoningById  Map<string, ReasoningSlot>
toolById       Map<string, ToolSlot>
slots[]        start-event arrival order
responseIdentity?  last valid finish-step id/modelId pair
responseNotices[]  bounded unknown/pause policy facts
~~~

必须满足：

1. Map key 直接使用 event `id`；三个 content type 使用三个 Map，不需要复合 key。
2. 只有 `text-start`、`reasoning-start`、`tool-input-start` 可以 push slot；此后永不移动。
3. 最终 `content[] A` 的 order 等于各 block start event 的到达 sequence；不使用 wall-clock timestamp。
4. Delta/end/final tool-call 找不到对应 open start 时是 protocol error，不能创建 placeholder 或修改 order。
5. `tool-input-start` 创建 invisible placeholder；只有 matching final `tool-call` 才填充并关闭。
6. `text-end` / `reasoning-end` 关闭的 block 若 trim 后为空，抛 `EMPTY_CONTENT_BLOCK` protocol error；不能 omission 或伪造内容。
7. response-side `tool-result` 不进入 content。
8. 每个 `finish` 完整覆盖之前的 finish/usage/systemPromptTokens；仍需等 physical EOF。
9. `abort` 立即 rollback，构造 neutral upstream-stream abort failure 并取消 body；不返回 result。
10. `error` 立即构造 neutral upstream-stream failure，不返回 result。
11. malformed known event 抛 neutral non-retryable protocol failure；unknown event 使用 `error|ignore` policy，ignore 不保留原 event body。
12. EOF 时若没有 `finish`（也没有已经触发异常的 `abort`），先 rollback 并抛 `CommandCodeTransportError`；即使存在 unfinished block 也以该 transport error 为准。
13. EOF 时已有 `finish` 但仍存在 unfinished block 是 protocol error；不能猜测 completion、自动 close 或 materialize incomplete tool。
14. EOF 时所有 block 已关闭后，仅 exact `finish.rawFinishReason === "pause_turn"` 触发 `pauseTurn` policy：`stop`（default）保留内容并添加 notice；`error` rollback 并抛 neutral non-retryable protocol failure。
15. 只有 closed blocks + valid final `finish` + physical EOF，并通过 pause policy，才返回 successful `CommandCodeResult`。

Buffered router MUST 在 assembler commit 前不向 Protocol B client 发送任何 semantic bytes。这是 abort 能真正 rollback 的前提。

## 7.2 Result model参考

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
  input: Readonly<Record<string, LosslessJsonValue>>;
}

export type ContentBlockA =
  | TextContentBlock
  | ReasoningContentBlock
  | ToolUseContentBlock;

export interface CommandCodeResult {
  readonly content: readonly ContentBlockA[];
  readonly finish: Readonly<FinishEvent>;
  readonly rawUsage?: Readonly<CommandCodeUsage>;
  readonly usage: Readonly<NormalizedUsage>;
  readonly systemPromptTokens?: number;
  readonly responseIdentity?: Readonly<{
    responseId: string;
    responseModel: string;
  }>;
  readonly notices: readonly ConversionNotice[];
}
~~~

`content[]` 只保存 model semantic blocks。Successful result 只保留 closed-world finish、final usage、最后一个 finish-step identity 和 bounded policy notices；provider metadata、response headers、raw event bodies 全部销毁。所有嵌套对象递归冻结。abort/protocol/transport failure 与 pause-error 只存在于 neutral typed error path，不进入 `CommandCodeResult`。

## 7.3 Reducer table

| Event | Action |
|---|---|
| `text-start(id)` | reserve text slot |
| `text-delta(id)` | require open text start；append text |
| `text-end(id)` | require non-empty text；close text slot |
| `reasoning-start(id)` | reserve reasoning slot |
| `reasoning-delta(id)` | require open reasoning start；append text |
| `reasoning-end(id)` | require non-empty reasoning；close reasoning slot |
| `tool-input-start(id)` | reserve tool placeholder；保存 toolName |
| `tool-input-delta(id)` | require open tool start；append raw input preview |
| `tool-input-end(id)` | require open tool start；set `inputStreamEnded=true` |
| `tool-call(toolCallId)` | require open, input-ended tool start；用 final toolName 无条件覆盖 start toolName；clone lossless JSON object input；close |
| `tool-result` | validate then drop |
| `finish-step` | validate response object；stage last id/modelId pair；drop headers/provider metadata/step usage |
| `finish` | replace finish/usage/systemPromptTokens；continue reading |
| `abort` | rollback；neutral upstream-stream abort failure；no result |
| `error` | neutral upstream-stream failure；no commit |
| unknown | `error|ignore` policy；ignore adds bounded notice and still requires finish |
| malformed known event | neutral protocol failure |
| EOF without `finish`/`abort` | rollback；throw neutral `CommandCodeTransportError`（`transport/unexpected_eof`、retryable true、无 synthetic status）；即使有 open block 也相同 |
| EOF after final `finish` | require all blocks closed；apply exact-raw pause policy；otherwise return success |

Duplicate start、closed id 后又来的 start/delta/end、以及 end without open block 都是 protocol error。实现不能为 malformed stream 引入 occurrence key、自动修复 lifecycle 或重排 slot。

## 7.4 Historical TypeScript sketch（non-normative）

下面的长代码块是冻结 Tickets 20–26 前的历史草图，保留作来源对照，不是当前实现合同。它关于 `rawEvents` retention、finish-step no-op、fixed pause error、unknown-event fixed error、primitive tool input 和 local-only failures 的行为均已被本节 7.1–7.3 与冻结 conversion method 取代；实现必须以当前 `src/providers/commandcode-private/assembler.ts` 的公开 seam 和对应测试为准。

~~~ts
type UnknownRecord = Record<string, unknown>;

export interface CommandCodeEvent extends UnknownRecord {
  type: string;
}

type CloseReason =
  | "text-end"
  | "reasoning-end"
  | "tool-call";

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

const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export type CommandCodeProtocolErrorCode =
  | "NON_JSON_LINE"
  | "INVALID_EVENT"
  | "UNKNOWN_EVENT"
  | "INVALID_EVENT_FIELD"
  | "INVALID_BLOCK_LIFECYCLE"
  | "EMPTY_CONTENT_BLOCK";

export class CommandCodeProtocolError extends Error {
  constructor(
    readonly code: CommandCodeProtocolErrorCode,
    message: string,
    readonly rawEvents: RawEventRecord[],
    readonly warnings: ProtocolWarning[],
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CommandCodeProtocolError";
  }
}

export class CommandCodeTransportError extends Error {
  readonly status = 502;
  readonly retryable = true;
  readonly midStream = true;

  constructor(
    readonly rawEvents: RawEventRecord[],
    readonly warnings: ProtocolWarning[],
  ) {
    super("CommandCode transport ended without finish or abort");
    this.name = "CommandCodeTransportError";
  }
}

export class CommandCodeAbortError extends Error {
  readonly retryable = false;

  constructor(
    readonly rawEvents: RawEventRecord[],
    readonly warnings: ProtocolWarning[],
  ) {
    super("CommandCode response emitted abort");
    this.name = "CommandCodeAbortError";
  }
}

export class CommandCodePauseTurnError extends Error {
  readonly retryable = false;

  constructor(
    readonly finish: FinishEvent,
    readonly rawEvents: RawEventRecord[],
    readonly warnings: ProtocolWarning[],
  ) {
    super("CommandCode pause_turn is unsupported");
    this.name = "CommandCodePauseTurnError";
  }
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
  private normalizedUsage: NormalizedUsage = { ...ZERO_USAGE };
  private systemPromptTokenCount: number | undefined;
  private finalized = false;

  readonly rawEvents: RawEventRecord[] = [];
  readonly warnings: ProtocolWarning[] = [];

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
      this.failProtocol(
        sequence,
        "NON_JSON_LINE",
        parseError,
      );
    }

    if (
      !isRecord(parsed)
      || typeof parsed.type !== "string"
      || parsed.type.length === 0
    ) {
      const message = "JSON value is not an event object";
      this.rawEvents.push({
        sequence,
        rawLine,
        parseError: message,
      });
      this.failProtocol(
        sequence,
        "INVALID_EVENT",
        message,
      );
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

    const finalFinish = this.finishEvent;
    if (!finalFinish) {
      this.rollbackStagedSemanticState();
      throw new CommandCodeTransportError(
        [...this.rawEvents],
        [...this.warnings],
      );
    }

    const incomplete = this.slots.find(
      (slot) => slot.state === "open",
    );
    if (incomplete) {
      this.failProtocol(
        incomplete.lastSequence,
        "INVALID_BLOCK_LIFECYCLE",
        `Block ${incomplete.id} was still open at EOF`,
        incomplete.kind,
        incomplete.id,
      );
    }

    const effectiveRawReason =
      finalFinish.rawFinishReason
      ?? finalFinish.finishReason;
    if (effectiveRawReason === "pause_turn") {
      this.rollbackStagedSemanticState();
      throw new CommandCodePauseTurnError(
        finalFinish,
        [...this.rawEvents],
        [...this.warnings],
      );
    }

    const content: ContentBlockA[] = [];
    for (const slot of this.slots) {
      if (slot.kind === "text") {
        content.push({
          type: "text",
          id: slot.id,
          text: slot.text,
        });
        continue;
      }
      if (slot.kind === "reasoning") {
        content.push({
          type: "reasoning",
          id: slot.id,
          text: slot.text,
        });
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
      finish: finalFinish,
      rawUsage: this.rawUsageValue,
      usage: this.normalizedUsage,
      systemPromptTokens: this.systemPromptTokenCount,
      rawEvents: [...this.rawEvents],
      warnings: [...this.warnings],
    };
  }

  private consumeEvent(
    event: CommandCodeEvent,
    sequence: number,
  ): void {
    switch (event.type) {
      case "text-start": {
        const id = this.requireId(event, "id", sequence);
        this.reserveText(id, sequence, event.type);
        return;
      }
      case "text-delta": {
        const id = this.requireId(event, "id", sequence);
        const text = this.requireString(
          event,
          "text",
          sequence,
        );
        const slot = this.requireOpen(
          this.textById,
          id,
          sequence,
          event.type,
        );
        slot.text += text;
        slot.lastSequence = sequence;
        return;
      }
      case "text-end": {
        const id = this.requireId(event, "id", sequence);
        this.close(
          this.textById,
          id,
          sequence,
          "text-end",
          event.type,
        );
        return;
      }
      case "reasoning-start": {
        const id = this.requireId(event, "id", sequence);
        this.reserveReasoning(id, sequence, event.type);
        return;
      }
      case "reasoning-delta": {
        const id = this.requireId(event, "id", sequence);
        const text = this.requireString(
          event,
          "text",
          sequence,
        );
        const slot = this.requireOpen(
          this.reasoningById,
          id,
          sequence,
          event.type,
        );
        slot.text += text;
        slot.lastSequence = sequence;
        return;
      }
      case "reasoning-end": {
        const id = this.requireId(event, "id", sequence);
        this.close(
          this.reasoningById,
          id,
          sequence,
          "reasoning-end",
          event.type,
        );
        return;
      }
      case "tool-input-start": {
        const id = this.requireId(event, "id", sequence);
        const toolName = this.requireString(
          event,
          "toolName",
          sequence,
          true,
        );
        const slot = this.reserveTool(id, sequence, event.type);
        slot.toolName = toolName;
        return;
      }
      case "tool-input-delta": {
        const id = this.requireId(event, "id", sequence);
        const delta = this.requireString(
          event,
          "delta",
          sequence,
        );
        const slot = this.requireOpen(
          this.toolById,
          id,
          sequence,
          event.type,
        );
        if (slot.inputStreamEnded) {
          this.failProtocol(
            sequence,
            "INVALID_BLOCK_LIFECYCLE",
            "tool-input-delta arrived after tool-input-end",
            event.type,
            id,
          );
        }
        slot.rawInput += delta;
        slot.lastSequence = sequence;
        return;
      }
      case "tool-input-end": {
        const id = this.requireId(event, "id", sequence);
        const slot = this.requireOpen(
          this.toolById,
          id,
          sequence,
          event.type,
        );
        if (slot.inputStreamEnded) {
          this.failProtocol(
            sequence,
            "INVALID_BLOCK_LIFECYCLE",
            "tool-input-end was repeated",
            event.type,
            id,
          );
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
        const toolName = this.requireString(
          event,
          "toolName",
          sequence,
          true,
        );
        const slot = this.requireOpen(
          this.toolById,
          id,
          sequence,
          event.type,
        );
        if (!slot.inputStreamEnded) {
          this.failProtocol(
            sequence,
            "INVALID_BLOCK_LIFECYCLE",
            "tool-call arrived before tool-input-end",
            event.type,
            id,
          );
        }
        slot.toolName = toolName;
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
        this.validateFinishEvent(event, sequence);
        const finish = event as FinishEvent;
        this.finishEvent = finish;
        if (finish.totalUsage !== undefined) {
          this.rawUsageValue = finish.totalUsage;
          this.normalizedUsage = normalizeUsage(
            finish.totalUsage,
          );
        } else {
          this.rawUsageValue = undefined;
          this.normalizedUsage = { ...ZERO_USAGE };
        }
        this.systemPromptTokenCount =
          finish.systemPromptTokens;
        return;
      }
      case "abort": {
        this.rollbackStagedSemanticState();
        throw new CommandCodeAbortError(
          [...this.rawEvents],
          [...this.warnings],
        );
      }
      case "error": {
        const detail = event.error;
        if (!isRecord(detail) && typeof detail !== "string") {
          this.failProtocol(
            sequence,
            "INVALID_EVENT_FIELD",
            "error event requires string or object error",
            event.type,
          );
        }
        const objectDetail = isRecord(detail) ? detail : undefined;
        if (objectDetail) {
          if (
            objectDetail.message !== undefined
            && typeof objectDetail.message !== "string"
          ) {
            this.failProtocol(
              sequence,
              "INVALID_EVENT_FIELD",
              "error.message must be a string when present",
              event.type,
            );
          }
          if (
            objectDetail.statusCode !== undefined
            && typeof objectDetail.statusCode !== "number"
          ) {
            this.failProtocol(
              sequence,
              "INVALID_EVENT_FIELD",
              "error.statusCode must be a number when present",
              event.type,
            );
          }
          if (
            objectDetail.isRetryable !== undefined
            && typeof objectDetail.isRetryable !== "boolean"
          ) {
            this.failProtocol(
              sequence,
              "INVALID_EVENT_FIELD",
              "error.isRetryable must be boolean when present",
              event.type,
            );
          }
        }
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
      case "start":
      case "start-step":
      case "provider-metadata":
      case "finish-step":
        return;
      default:
        this.failProtocol(
          sequence,
          "UNKNOWN_EVENT",
          `Unknown CommandCode event: ${event.type}`,
          event.type,
        );
    }
  }

  private reserveText(
    id: string,
    sequence: number,
    eventType: string,
  ): TextSlot {
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
  ): ReasoningSlot {
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
  ): ToolSlot {
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
  ): T {
    const existing = map.get(id);
    if (existing) {
      this.failProtocol(
        sequence,
        "INVALID_BLOCK_LIFECYCLE",
        "Duplicate start event for block",
        eventType,
        id,
      );
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
    const slot = this.requireOpen(
      map,
      id,
      sequence,
      eventType,
    );
    if (
      (slot.kind === "text" || slot.kind === "reasoning")
      && slot.text.trim() === ""
    ) {
      this.failProtocol(
        sequence,
        "EMPTY_CONTENT_BLOCK",
        `${slot.kind} block must contain non-whitespace text`,
        eventType,
        id,
      );
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
    this.normalizedUsage = { ...ZERO_USAGE };
    this.systemPromptTokenCount = undefined;
  }

  private requireId(
    event: CommandCodeEvent,
    field: "id" | "toolCallId",
    sequence: number,
  ): string {
    const id = asString(event[field]);
    if (id) return id;
    this.failProtocol(
      sequence,
      "INVALID_EVENT_FIELD",
      `Event is missing ${field}`,
      event.type,
    );
  }

  private requireString(
    event: CommandCodeEvent,
    field: string,
    sequence: number,
    nonEmpty = false,
  ): string {
    const value = asString(event[field]);
    if (value !== undefined && (!nonEmpty || value.length > 0)) {
      return value;
    }
    this.failProtocol(
      sequence,
      "INVALID_EVENT_FIELD",
      `Event has invalid ${field}`,
      event.type,
      asString(event.id) ?? asString(event.toolCallId),
    );
  }

  private requireOpen<T extends InternalSlot>(
    map: Map<string, T>,
    id: string,
    sequence: number,
    eventType: string,
  ): T {
    const slot = map.get(id);
    if (!slot || slot.state !== "open") {
      this.failProtocol(
        sequence,
        "INVALID_BLOCK_LIFECYCLE",
        "Event has no matching open start",
        eventType,
        id,
      );
    }
    return slot;
  }

  private validateFinishEvent(
    event: CommandCodeEvent,
    sequence: number,
  ): void {
    if (
      event.finishReason !== undefined
      && typeof event.finishReason !== "string"
    ) {
      this.failProtocol(
        sequence,
        "INVALID_EVENT_FIELD",
        "finishReason must be a string when present",
        event.type,
      );
    }
    if (
      event.rawFinishReason !== undefined
      && typeof event.rawFinishReason !== "string"
    ) {
      this.failProtocol(
        sequence,
        "INVALID_EVENT_FIELD",
        "rawFinishReason must be a string when present",
        event.type,
      );
    }
    if (
      event.totalUsage !== undefined
      && !isRecord(event.totalUsage)
    ) {
      this.failProtocol(
        sequence,
        "INVALID_EVENT_FIELD",
        "totalUsage must be an object when present",
        event.type,
      );
    }
    if (isRecord(event.totalUsage)) {
      this.validateUsage(event.totalUsage, sequence);
    }
    if (
      event.systemPromptTokens !== undefined
      && (
        typeof event.systemPromptTokens !== "number"
        || !Number.isFinite(event.systemPromptTokens)
      )
    ) {
      this.failProtocol(
        sequence,
        "INVALID_EVENT_FIELD",
        "systemPromptTokens must be a number when present",
        event.type,
      );
    }
  }

  private validateUsage(
    usage: UnknownRecord,
    sequence: number,
  ): void {
    for (const field of [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "reasoningTokens",
      "cachedInputTokens",
    ]) {
      this.validateOptionalFiniteNumber(
        usage,
        field,
        sequence,
        "finish",
      );
    }

    for (const [field, numericFields] of [
      [
        "inputTokenDetails",
        ["noCacheTokens", "cacheReadTokens", "cacheWriteTokens"],
      ],
      [
        "outputTokenDetails",
        ["textTokens", "reasoningTokens"],
      ],
    ] as const) {
      const details = usage[field];
      if (details === undefined) continue;
      if (!isRecord(details)) {
        this.failProtocol(
          sequence,
          "INVALID_EVENT_FIELD",
          `${field} must be an object when present`,
          "finish",
        );
      }
      for (const numericField of numericFields) {
        this.validateOptionalFiniteNumber(
          details,
          numericField,
          sequence,
          "finish",
        );
      }
    }
  }

  private validateOptionalFiniteNumber(
    record: UnknownRecord,
    field: string,
    sequence: number,
    eventType: string,
  ): void {
    const value = record[field];
    if (
      value !== undefined
      && (typeof value !== "number" || !Number.isFinite(value))
    ) {
      this.failProtocol(
        sequence,
        "INVALID_EVENT_FIELD",
        `${field} must be a finite number when present`,
        eventType,
      );
    }
  }

  private failProtocol(
    sequence: number,
    code: CommandCodeProtocolErrorCode,
    message: string,
    eventType?: string,
    id?: string,
    retryable = false,
  ): never {
    this.warn(sequence, code, message, eventType, id);
    throw new CommandCodeProtocolError(
      code,
      message,
      [...this.rawEvents],
      [...this.warnings],
      retryable,
    );
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

## 7.5 Historical HTTP body consumer（non-normative）

下列 `response.text()` / `CommandCodeHttpError.body` 草图属于冻结前实现，不得用于当前
Provider。当前实现以 bounded `failure-capture.ts`、neutral diagnostic 和 attempt journal
合同为准；raw body 不跨出 physical attempt。

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
  return (
    status === 429
    || (status >= 500 && status <= 599)
  );
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

收到 `abort` 时 assembler 先 rollback 并抛 `CommandCodeAbortError`。Consumer 的 catch path 随即取消 reader；error 中的 rawEvents 保存到 `abort` 为止。若 debug recorder 必须保留 server 在 `abort` 后仍发送的 bytes，必须在独立 recording layer drain，不能改变 semantic failure 结果。

Physical EOF 时若既没有 `finish` 也没有 `abort`，assembler 先 rollback，再抛 neutral `CommandCodeTransportError`。该 failure 固定为 `kind:"transport"`、`phase:"unexpected_eof"`、`retryable:true`，不虚构 upstream status；缺少 terminal event 的判断先于 open-block 检查，因此存在 unfinished block 时仍抛该 transport error。若已经收到 `finish`，EOF 时的 unfinished block 才按 `INVALID_BLOCK_LIFECYCLE` 处理。

## 7.6 参考代码

如果 application 只需要调用 CommandCode：

~~~ts
const response = await sendGenerateRequest({
  baseUrl,
  headers,
  body,
  signal,
});

const resultA = await consumeCommandCodeResponse(response);

// 最终结果。到这里结束，不需要 adapter 或额外 representation。
const contentA: ContentBlockA[] = resultA.content;
~~~

Application 同时保留 `resultA.finish`、`resultA.usage`、`resultA.rawUsage`、`resultA.rawEvents` 即可。它们是 response metadata/debug data，不是另一种 content representation。

---

# 8. Finish、usage 与 failure

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
| `finishReason` | CommandCode/gateway 层的 finish category | 用 exact string comparison 计算 derived stop reason；协议转换时交给 B-specific mapping |
| `rawFinishReason` | provider/service 保留的 raw reason | 保留为 diagnostic reason；exact `pause_turn` 触发 Provider `stop|error` policy（default stop） |
| `totalUsage` | final token usage | 计算 normalized usage；不是 reason field |
| `systemPromptTokens` | system prompt token count | 单独保存；不是 reason field |

`finish-step` event 也可能出现 `finishReason`、`rawFinishReason`、`usage`、`providerMetadata` 和 `response`。Consumer 验证这些已知字段，只保留最后一个合法 `response.id/modelId` pair；timestamp、headers、provider metadata 与 step usage 在校验后丢弃。只有 `type:"finish"` 决定 completion、最终 reason 和 final usage。

### 8.1.2 Defined values 与 open raw values

`finishReason` 来自统一后的 provider finish category。Defined producer values 为：

| `finishReason` | Unified meaning |
|---|---|
| `stop` | normal stop / stop sequence |
| `length` | maximum output tokens reached |
| `content-filter` | generation stopped by content filter |
| `tool-calls` | model emitted tool calls |
| `error` | provider represented termination as finish error |
| `other` | provider-specific reason not covered above |
| missing or future unknown string | tolerant fallback |

Receiver 应接受任意 string 和 missing value，因为 CommandCode client 没有对 wire event 做 closed-enum validation。对 LuckyToken 的 Pi boundary，只有 exact `length` 直接决定 normalized result；其他值由已提交的实际 ToolCall content 决定 `toolUse` / `stop`。Exact `tool-calls` 只参与 wire/content consistency diagnostic，不能替代实际内容。

`finishReason:"error"` 仍然是一个正常 `type:"finish"` event，source client 不会仅因该 value throw。只有独立的 `type:"error"` event 才进入 stream error path。

`rawFinishReason` 的 producer type 是 `string | undefined`，没有可穷举的 enum。它保留原 provider/service reason。

其他 raw value 只被保留和用于 diagnostics/telemetry，不改变 normalized `stopReason`。如果 `rawFinishReason` 缺失，client 使用 `finishReason` 作为 returned raw reason：

~~~ts
const returnedRawFinishReason =
  event.rawFinishReason ?? event.finishReason;
~~~

当前 Pi mapping：

~~~text
condition                               Pi stopReason
──────────────────────────────────────  ─────────────
finishReason === "length"               "length"
otherwise + committed ToolCall exists   "toolUse"
otherwise                               "stop"
~~~

### 8.1.3 收到后的处理，参考处理

收到 `finish` 后按以下顺序使用：

1. 保存完整 event 作为 current final candidate。
2. 用该 event 的 `totalUsage`、`systemPromptTokens` 完整替换 current extracted metadata；字段 missing 时分别重置为 missing/zero view。
3. 不停止 physical read；继续处理后续 lines，直到 EOF。
4. 同一 HTTP response 出现多个 `finish` 时，后一个 event 完整覆盖前一个，不能混合不同 finish 的字段。
5. EOF 既没有 `finish` 也没有 `abort` 时，rollback 并抛 neutral `CommandCodeTransportError`（`kind:"transport"`、`phase:"unexpected_eof"`、`retryable:true`，不虚构 upstream HTTP status）；即使存在 open block 也相同。
6. EOF 已有 `finish` 但仍有 open block 时，抛 `INVALID_BLOCK_LIFECYCLE` protocol error。
7. 所有 block 已关闭，且 EOF 时最后一个 finish 的 exact `rawFinishReason` 等于 `pause_turn`，应用 Provider `pauseTurn` policy：`stop` 保留 staged result 并添加 degradation notice；`error` rollback 并抛 neutral non-retryable `CommandCodePauseTurnError`。

按 `rawFinishReason` 展开：

| Received `rawFinishReason` | 当前 profile behavior |
|---|---|
| `pause_turn` | `pauseTurn=stop`（default）提交普通结果并添加 notice；`pauseTurn=error` rollback 后抛 non-retryable `CommandCodePauseTurnError`；均不发送 continuation |
| other non-empty string | 保存到 final `FinishEvent`，交给 diagnostics/B-specific conversion；不改变 derived stop reason |
| missing | 使用 `finishReason` 作为 returned raw reason |

### 8.1.4 Current profile boundary

本文只保留实现当前 wire consumer 所需的 source-compatible behavior；明确列出的 current-profile policy 可以与 Source client 不同，也不复制 CommandCode agent runtime。

保留的 source-compatible behavior：

| Behavior | Why |
|---|---|
| 保存完整 final `FinishEvent` | 后续仍需原始 `finishReason`、`rawFinishReason`、usage |
| `rawFinishReason = rawFinishReason ?? finishReason` | 与 source result 一致 |
| exact `length` + actual ToolCall content normalization | 产生内部一致的 Pi `stopReason`；wire/content mismatch 只进入 diagnostic |
| finish 后读到 physical EOF | 防止漏掉 trailing events，并确认 response 有 semantic terminal event |
| final finish usage normalization | 同时提供 raw object 与 normalized view |

Current-profile policy 与不属于本层的 behavior：

| Behavior | Why |
|---|---|
| 自动执行 client tools | 属于 agent/application layer；router 只返回 tool blocks |
| `max_tokens` 后自动插入 recovery prompt | 会改变原 response；不属于 response decoder |
| stop hooks、follow-up queue、steering | 属于 CommandCode agent runtime |
| `max_turns`、run-level stop reason | 属于多轮 agent loop，不是单次 model response |
| CommandCode telemetry/UI event | 不属于 wire protocol output |
| `pause_turn` continuation | 不实现 continuation；Provider policy 选择 ordinary stop degradation（default）或 non-retryable error |
| multiple finish 的 field-by-field carry-forward | 当前 profile 使用 complete last-event replacement，避免混合 metadata |

推荐 result usage：

~~~ts
export async function decodeOneCommandCodeResponse(
  response: Response,
) {
  const resultA = await consumeCommandCodeResponse(response);

  // Do not execute tools here. Return content[] A to the caller.
  return {
    content: resultA.content,
    finish: resultA.finish,
    usage: resultA.usage,
    rawUsage: resultA.rawUsage,
    systemPromptTokens: resultA.systemPromptTokens,
  };
}
~~~

当前 profile 不设置通用 finish-acceptance helper。Application/B-specific adapter 直接读取并保留 `resultA.finish.finishReason` 与 `resultA.finish.rawFinishReason`；derived stop reason 只能在对应 boundary 按实际 target contract 计算，不能覆盖原始字段。LuckyToken 的 Pi mapping 使用本节 content-derived 规则。

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

注意不同协议以上相同字段名意义不同，不能认为我们的协议的意思就是别的协议的意思。

Normalized missing field 使用 `0`；raw object 中的 missing 仍应保持 missing。Raw object 还可能包含：

- `inputTokenDetails.noCacheTokens`
- `outputTokenDetails.textTokens`
- `outputTokenDetails.reasoningTokens`
- `totalTokens`
- `reasoningTokens`
- `cachedInputTokens`
- future provider fields

`systemPromptTokens` 位于 finish 顶层，不在 `totalUsage` 内。

进入 Pi boundary 时，`cachedInputTokens` 与 `inputTokenDetails.cacheReadTokens`、顶层 `reasoningTokens` 与 `outputTokenDetails.reasoningTokens` 分别是已知 aliases：任一可单独供值，同时存在必须相等。显式 `noCacheTokens` 与 `inputTokens` 同时存在时，必须满足 `inputTokens = noCache + cacheRead + cacheWrite`；source `totalTokens` 同样必须与全部 Pi token components 一致。所有分量与派生和都必须是 non-negative safe integer。当前 schema 没有 one-hour cache retention split，因此 Pi `cacheWrite1h` 保持 absent，不能从普通 `cacheWriteTokens` 猜测。

同一个 HTTP response 多次出现 `finish` 时，最后一个 finish event 完整决定 final metadata。最后一个 event 缺少 `totalUsage` 时 `rawUsage` 为 `undefined`、normalized usage 为四个零；缺少 `systemPromptTokens` 时 extracted value 为 `undefined`。

## 8.3 `abort`

`{"type":"abort"}` 是 server → client response event：

- 不是 request body field。
- 不是 CommandCode client 发给 upstream 的取消 HTTP request。
- 表示本 response 被有意终止。
- Atomic implementation 必须丢弃当前 response 的 staged content、pending tool、finish、identity、usage 与 notices，然后产生 neutral `kind:"upstream_stream"` / `providerType:"abort"` failure。
- Router 不应把 partial content 转成 Protocol B content。

Consumer 不返回 `{committed:false, aborted:true}` result。`CommandCodeResult` 只表示已经成功提交的 response。

`AbortController`/`AbortSignal` 是 local HTTP cancellation mechanism，和 wire `abort` event 是不同概念。

Downstream client disconnect 或 timeout 时，router SHOULD 通过 signal 取消 upstream fetch. 但不需要向 CommandCode 发送额外 JSON request field。

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

当前 profile 不实现 continuation。Assembler 仍读到 physical EOF，以最后一个 finish 为准；只有 exact `finish.rawFinishReason === "pause_turn"` 才触发 Provider `pauseTurn` policy。`stop`（default）保留已闭合 content、last finish-step identity 与 final finish usage，添加 non-model-visible degrade notice，再走普通 semantic validation；`error` rollback 全部 staged state 并产生 neutral non-retryable protocol failure。`finishReason:"pause_turn"` 但 raw field 缺失时不得猜测为 pause。

---

# 9. 协议转换protocol conversion

本部分不属于协议内容，但是可以给你提供协议转换的优雅参考。

`finish + EOF` 之后，才有资格转换，确认没有问题才开始，否则会污染其他协议接收方。

## 9.1 以content为主的转换方法

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

转换参考规则：

- 直接遍历 `content[] A`，每个 A block 映射成零个、一个或多个 B blocks。
- 保持 array order，不按 type、ID 或 completion time 重排。
- A text → B 的 text block。
- A reasoning → B 的 reasoning/thinking block，或执行明确的 omission/summary policy。
- A tool_use → B 的 tool_use/function_call/tool_call block。
- Tool call ID 默认原样保留。
- `finishReason A`、`rawFinishReason A` 与 `usage A` 必须进入 B-specific finish/usage converter，不能作为 A event 原样转发。
- 本文不定义它们在 B 中的 field name、value、nesting、event type 或 event position；这些只能由确定版本的 Protocol B schema 决定。
- `finish` 和 `usage` 都是 response-level metadata，不放入 `content[] B`。
- Raw JSONL/event bodies 不进入 committed result。若 deployment 需要 debug capture，必须由独立、bounded、redacted recorder 拥有，不能借 Provider semantic state 透传。

如果 Protocol B 对 tool-call ID 有 prefix、length 或 character set 限制，必须维护 stable bidirectional mapping，并至少保存到下一次 B request-side tool result 转回 A tool result 完成。不能在 response 和下一次 request 中分别随机生成 ID。

### 备注

`content[] B` 是协议B中的content，`content[] A`是协议A中的content。先转换content 在使用centent[ ] B发送SSE B, 这种atomic避免了处理 SSE A 转换成SSE B，因为SSE级别可能不是对应的，很难实现转换.。所以转换要选对信息级别，content比sse合适。

B conversion MUST preserve semantic order：

~~~text
content[] A order
  → content[] B order
  → B content block start/index order
~~~

一个 source block 映射成多个 target blocks 时，在 source position 原地连续展开。不要把 reasoning 全部移到最前、tool 全部移到最后。若 B schema 强制不同顺序，B adapter 应明确记录 warning 或直接 reject，不能静默重排。

## 9.2 `finishReason`、`rawFinishReason` 与 usage 的 SSE 转换

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

1. `consumeCommandCodeResponse()` 只返回成功的 final A result；abort、pause-error、unknown-error、malformed、stream error 和 terminal-missing transport error 已经产生 neutral failure，不进入 B conversion。pause-stop 与 unknown-ignore 通过 bounded notices 随成功 result 进入普通 conversion。

2. 把原始 `finishA.finishReason`、`finishA.rawFinishReason`、raw/normalized usage 和 `systemPromptTokens` 一起传入 `convertFinish()`。

3. `convertFinish()` 必须由具体 Protocol B adapter 实现。

4. 本文不为未知 B 规定任何 reason mapping、token-field mapping、event name、event order 或 unsupported-field policy。

5. 不得把 CommandCode raw `{"type":"finish",...}` JSON line直接当作 B event；“转换”与“原样转发”是两种不同操作。

   LuckyToken 的具体 Pi mapping 由 `PI AI IR-Commandcode Private Conversion.md` 冻结，并采用 §8.1.2 的 content-derived normalization；未知 Protocol B 不能复用该 target-specific 规则。


## 9.3 Reasoning policy

Protocol B 可能：

- 支持 equivalent reasoning block：direct map。
- 只支持 summary：map 为 summary，并在 B adapter 的 debug metadata/warning 中声明 approximation。
- 不支持 reasoning：omission，并明确记录 warning；strict mode 可以 reject。
- 要求 signature：只有 source 有 valid signature 时才能提供；不得伪造。
- 只支持 opaque/encrypted reasoning：不能把 plain source reasoning 冒充 native opaque item。

不要无条件把 reasoning 拼进 visible assistant text，这会改变 response semantics。

LuckyToken 当前 target 是 Pi AI IR，具有独立 `ThinkingContent`，因此 CommandCode reasoning 直接映射为 Thinking；已经收到的 representable content 不受 model catalog `reasoning:false` 请求能力标记限制。

## 9.4 真正 SSE framing

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
  codec.validateResult(result);
  const encodedFrames = Array.from(
    codec.events(result),
    (event) => {
      codec.validateEvent(event);
      return encodeSseFrame(codec.frame(event));
    },
  );
  const body = new TextEncoder().encode(
    encodedFrames.join(""),
  );

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

## 9.5 End-to-end adapter参考

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

`adaptCommandCodeToProtocolB()` 只接收一个 physical upstream response。`pause_turn` 不产生 continuation parts；pause-stop 仍作为一个 committed A result 走普通转换，pause-error 作为 neutral non-retryable failure 交给 `errorResponse()`。

## 9.6 其他

`content[] B` 不是协议B完整 response。B-specific adapter 可能还必须构造：

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

可能接口：

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

  /** Validate the complete B result before event generation. */
  validateResult(result: BResult): void;

  /** Validate every generated B event before HTTP 200. */
  validateEvent(event: BEvent): void;

  /** B-specific non-stream HTTP error response. */
  errorResponse(error: unknown): Response;
}
~~~

`events(result)` 必须遵守 Protocol B 自己的 lifecycle。本文只要求 `finishReason`、`rawFinishReason` 与 usage 在需要 A → B conversion 时经过 `convertFinish()`；不规定转换结果的字段、取值或发送位置。

这里只是一些例子，一切以你实际的协议B为准。

---

# 10. Error、retry 与 cancellation policy

## 10.1 Buffered adapter

| Failure point | Protocol B behavior |
|---|---|
| A network/HTTP failure，B headers 未发送 | 用 B-specific non-2xx status + JSON error body |
| A stream `error`，B headers 未发送 | B-specific non-2xx error |
| A `CommandCodeTransportError`（EOF 既无 finish 也无 abort） | retry A；exhausted 后 B-specific non-2xx error |
| A unknown/malformed/lifecycle error | non-retryable B-specific non-2xx error |
| A `abort` | rollback A；neutral upstream-stream abort failure；不要发送 content B |
| A final `pause_turn` | `stop` policy 提交并普通转换；`error` policy rollback + neutral non-retryable protocol failure |
| `content[] A` → `content[] B` conversion failure | B-specific non-2xx error |
| B result validation/serialization failure | B-specific non-2xx error |
| downstream disconnect | cancel A fetch signal when possible |

Retry MUST 发生在 B 200 response 开始之前。每次 retry 使用新的 response-local assembler；不能把 failed attempt 的 slots、usage 或 raw terminal state合并到 next attempt。

## 10.2 Live adapter 的限制

如果未来实现 live A → B transform，一旦 B bytes 已经发送：

- 上游 abort 无法撤回已发送 text/reasoning/tool block。
- conversion error 只能发送 B-defined in-stream error 或直接 EOF。
- retry 可能产生 duplicate content。
- tool placeholder、partial JSON、backpressure、block index 和 lifecycle 都要 incremental 管理。

因此 v1.0 推荐且规范化的实现是 buffered semantic adapter。Live adapter 是独立 profile，不能声称具备 atomic rollback。

---

# 11. Protocol examples

## 11.1 Minimal text request

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

## 11.2 Interleaved response and final `content[] A`

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

Result order 由三个 start event 的 arrival sequence 决定，不由 end time 或 wall-clock timestamp 决定：

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

## 11.3 Next request with tool result

下一次请求的 `params.messages` 必须保留产生该调用的 assistant 消息，再紧跟匹配的 tool result；不能以 `tool` 开头：

~~~json
[
  {
    "role": "assistant",
    "content": [
      {
        "type": "tool-call",
        "toolCallId": "call_1",
        "toolName": "read_file",
        "input": { "path": "a.ts" }
      }
    ]
  },
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
]
~~~

## 11.4 Abort

~~~jsonl
{"type":"text-start","id":"t1"}
{"type":"text-delta","id":"t1","text":"partial"}
{"type":"abort"}
~~~

Neutral failure：

~~~json
{
  "kind": "upstream_stream",
  "providerType": "abort",
  "message": "CommandCode response emitted abort",
  "retryable": false
}
~~~

Assembler 在产生 failure 前 rollback；不存在 successful `CommandCodeResult`，`partial` 不进入 `content[] A`、`content[] B` 或 Protocol B SSE。Raw events/provider metadata 不跨 public failure seam。

---

# 12. AI implementation checklist

AI 在生成实现前必须逐项确认：

## Request

- [ ] 固定 absolute path `POST /alpha/generate`；替换 base path 并丢弃 query/fragment。
- [ ] `Content-Type: application/json`。
- [ ] 非空 string `cwd` 使用 `x-project-slug = slugify(cwd) || "root"`；其他输入 omission；package pin `2.2.1`。
- [ ] caller `threadId` 缺失或无效时生成 random UUID。
- [ ] `x-session-id` 与 body `threadId` 必须使用同一个 resolved UUID。
- [ ] `x-cmd-zdr` 固定发送 string `1`。
- [ ] 不发送 `x-oauth-token` 或 `x-oauth-provider`。
- [ ] `traceparent` 满足 W3C length/non-zero rules。
- [ ] unknown cwd 使用 typed empty config，不执行 filesystem/Git scan。
- [ ] `config.structure` 只读取 immediate entries。
- [ ] Git command result 区分 successful empty 与 failure；只有 successful empty status 表示 clean。
- [ ] `memory/taste/skills` 明确发送 `null`。
- [ ] permission mapping 默认 `standard`。
- [ ] request-side `tool-call.input` 必须是 JSON object，但不按工具 `input_schema` 校验键名、值类型或必填字段。
- [ ] request-side wire 接受空或非空 `tool-result.toolName`；LuckyToken conversion 对真实结果保留非空 Pi name、synthetic 使用 pending call name。成功使用 `text`、真实失败使用 `error-text`、synthetic 使用 Provider-local `text|error-text` policy（默认 `text`）。
- [ ] `max_tokens` 必填；caller/options 优先，model catalog 对明确 `maxOutputTokens` 使用模型值，否则使用官方 CLI 默认 64000。
- [ ] `stream` 是 literal `true`。
- [ ] Pi reasoning 先按 selected model 的 thinking-level map/capability clamp；只发送 model 支持的 CommandCode effort，off/absence omission。

## Response A

- [ ] 按 UTF-8 byte stream 解码，不按 HTTP chunk 解析 event。
- [ ] 按 LF 分割 bare JSON Lines，不解析 `data:` SSE。
- [ ] final unterminated line 在 EOF 时也解析。
- [ ] 每个 HTTP response 使用新的 assembler。
- [ ] 三个 Map + 一个 ordered `slots[]`。
- [ ] 只有 start event 创建 slot；slot order 是 start-event arrival sequence。
- [ ] delta/end/tool-call missing start 与 duplicate/closed lifecycle 抛 protocol error；已有 finish 时的 unfinished EOF 也抛 protocol error。
- [ ] response text/reasoning block trim 后为空时抛 `EMPTY_CONTENT_BLOCK`，不能静默 omission。
- [ ] non-JSON、invalid known event/field 产生 neutral non-retryable protocol failure；unknown type 使用 `error|ignore` policy，ignore 不保留 event body且不能代替 finish。
- [ ] tool start 占位；final tool-call materialize，并用 final toolName 无条件覆盖 start toolName。
- [ ] response-side tool-result validate then drop。
- [ ] finish-step 验证 response object，最后一个合法 id/modelId pair last-wins；step usage 不覆盖 final finish usage。
- [ ] finish 后继续读取到 EOF。
- [ ] multiple finish 以最后一个完整 event 覆盖 finish/usage/systemPromptTokens。
- [ ] final finish.totalUsage raw preserve并 normalized。
- [ ] abort rollback、产生 neutral upstream-stream abort failure 并取消 body。
- [ ] final exact-raw `pause_turn` 在 EOF/closed-slots 后应用 `stop|error` policy（default stop）。
- [ ] stream error 不返回 result；EOF 既无 finish 也无 abort 时 rollback 并产生 retryable neutral transport/unexpected_eof failure，即使有 open block也相同；没有 verified upstream status 时 Client 层只可使用 generic fallback。

## Conversion and response B

- [ ] 不需要转换时，返回 `content[] A` 后结束。
- [ ] 需要转换时，直接把 `content[] A` 转成 `content[] B`。
- [ ] 不以 source JSON Lines 作为 A → B conversion unit。
- [ ] 保持 block semantic order。
- [ ] tool-call ID 跨 response/request stable。
- [ ] reasoning 使用 explicit target policy。
- [ ] 正确读取 A wire `finishReason` 与 `rawFinishReason`；不把内部 `stopReason` 误写成 wire field。
- [ ] pause-stop 走普通 A→B conversion；pause-error 不进入 B conversion。
- [ ] Final `finishReason A`、`rawFinishReason A`、usage 与 `systemPromptTokens` 全部交给 B-specific `convertFinish()`。
- [ ] 不在通用 adapter 中假定 B 的 reason value、token field、nesting 或 event position。
- [ ] 不把 CommandCode raw finish JSON line直接当作 B event。
- [ ] B result 与每个 B event 在返回 HTTP 200 前完整 validation。
- [ ] 所有 SSE frames 在 HTTP 200 前完成 framing 与 UTF-8 encoding。
- [ ] B codec 生成 B-specific semantic events。
- [ ] 真 SSE 每个 frame 使用 `data:` 等 field，并以 blank line 结束。
- [ ] `[DONE]` 只在指定 B endpoint/version 要求时发送。
- [ ] upstream error/abort 发生时，buffered profile 尚未发送任何 B semantic bytes。

---

# 13. 最终推荐

v1.0 推荐唯一主路径：

~~~text
1. Build exact CommandCode request.
2. Send params.stream=true.
3. Decode bare JSON Lines.
4. Create slots only from content start events.
5. Preserve start-event arrival order in slots[].
6. Reject malformed, unknown, or invalid block lifecycles.
7. Replace finish metadata atomically on every finish event.
8. Return success only on final non-pause finish + physical EOF.
9. Roll back and emit neutral failure on abort/error, pause-error, malformed protocol, or terminal-missing transport failure.
10. Produce an immutable content[] A plus final finish/usage, last finish-step identity, and bounded notices; retain no raw event bodies.
11. If no conversion is required, return content[] A and stop.
12. If conversion is required, convert content[] A directly to content[] B.
13. Pass finishReason/rawFinishReason/usage A through B-specific conversion.
14. Build B events exactly as the selected B protocol defines.
15. Validate the B result and every B event before HTTP 200.
16. Frame and UTF-8 encode every B SSE event before HTTP 200.
~~~

这套设计把 source wire、最终 `content[] A`、可选的 `content[] B` 和 target wire 分离，但不增加中间 conversion layer。只使用 CommandCode 时，`content[] A` 就是终点；只有 router 需要模拟 Protocol B 时才继续转换。Buffered conversion 的代价是等待完整 upstream response 后再 replay B stream；换来的结果是 start-order 明确、tool association 稳定、usage/finish 可验证，并且 abort、pause、protocol/stream/transport error 不会污染 downstream client。
