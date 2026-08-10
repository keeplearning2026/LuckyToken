import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  createProvider,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type FetchFunction,
  type Model,
  type ModelThinkingLevel,
  type Provider,
  type SimpleStreamOptions,
  type StreamFunction,
  type Usage,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import slugify from "@sindresorhus/slugify";
import { randomUUID } from "node:crypto";

import {
  classifyProjectDir,
  createEmptyServerConfig,
  type ProjectSnapshot,
  type ServerConfig,
} from "./project.js";

const PROVIDER_ID = "commandcode-private";
const API_ID = "commandcode-private";
const MISSING_TOOL_RESULT =
  "No result — the tool call did not complete (interrupted or lost).";

interface CommandCodeTextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CommandCodePrivateProviderOptions {
  apiKey: string;
  fetch: FetchFunction;
  model: Model<typeof API_ID>;
  now: () => number;
  projectSnapshot: ProjectSnapshot;
  compatibility?: CommandCodeCompatibilityPolicy;
  createSessionId?: () => string;
}

export interface CommandCodeCompatibilityPolicy {
  cliEnvironment?: string;
  ossPrimaryProvider?: string;
  permissionMode?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

async function consumeTextResponse(response: Response): Promise<CommandCodeTextResult> {
  if (!response.ok) {
    throw new Error(`CommandCode returned HTTP ${response.status}`);
  }

  const lines = (await response.text())
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let textId: string | undefined;
  let text = "";
  let textClosed = false;
  let finish: Record<string, unknown> | undefined;

  for (const line of lines) {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event) || typeof event.type !== "string") {
      throw new Error("CommandCode emitted a malformed event");
    }

    switch (event.type) {
      case "text-start":
        if (typeof event.id !== "string" || textId !== undefined) {
          throw new Error("Invalid CommandCode text-start lifecycle");
        }
        textId = event.id;
        break;
      case "text-delta":
        if (event.id !== textId || textClosed || typeof event.text !== "string") {
          throw new Error("Invalid CommandCode text-delta lifecycle");
        }
        text += event.text;
        break;
      case "text-end":
        if (event.id !== textId || textClosed || text.trim().length === 0) {
          throw new Error("Invalid CommandCode text-end lifecycle");
        }
        textClosed = true;
        break;
      case "finish":
        finish = event;
        break;
      default:
        throw new Error(`Unsupported CommandCode event: ${event.type}`);
    }
  }

  if (!textClosed || finish === undefined) {
    throw new Error("CommandCode ended without a complete text block and finish");
  }
  if (finish.finishReason !== "stop") {
    throw new Error(`Unsupported CommandCode finish reason: ${String(finish.finishReason)}`);
  }

  const totalUsage = finish.totalUsage;
  if (!isRecord(totalUsage)) {
    throw new Error("CommandCode finish must include totalUsage");
  }

  return {
    text,
    inputTokens: requireNonNegativeInteger(totalUsage.inputTokens, "inputTokens"),
    outputTokens: requireNonNegativeInteger(totalUsage.outputTokens, "outputTokens"),
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createMessage(
  model: Model<typeof API_ID>,
  text: string,
  usage: Usage,
  stopReason: "pending" | "stop" | "error",
  now: () => number,
  errorMessage?: string,
): AssistantMessage {
  const message: AssistantMessage = {
    role: "assistant",
    content: text.length === 0 ? [] : [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: now(),
  };
  if (errorMessage !== undefined) message.errorMessage = errorMessage;
  return message;
}

function cloneLosslessJson(
  value: unknown,
  ancestors: Set<object> = new Set(),
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("ToolCall arguments contain a non-lossless JSON number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("ToolCall arguments contain a non-JSON value");
  }
  if (ancestors.has(value)) {
    throw new Error("ToolCall arguments contain a cycle");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index)) ||
        Object.getOwnPropertySymbols(value).length > 0
      ) {
        throw new Error("ToolCall argument arrays must be dense JSON arrays");
      }
      return value.map((item) => cloneLosslessJson(item, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("ToolCall arguments require plain JSON objects");
    }
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new Error("ToolCall arguments contain non-JSON object properties");
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("ToolCall arguments cannot use custom serialization");
      }
      result[key] = cloneLosslessJson(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

interface PendingToolCall {
  id: string;
  name: string;
}

function missingToolResult(call: PendingToolCall): Record<string, unknown> {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.id,
        toolName: "",
        output: { type: "text", value: MISSING_TOOL_RESULT },
      },
    ],
  };
}

export function convertCommandCodeMessages(
  model: Model<typeof API_ID>,
  context: Context,
): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  let pending = new Map<string, PendingToolCall>();

  const flushMissingResults = (): void => {
    for (const call of pending.values()) converted.push(missingToolResult(call));
    pending = new Map();
  };

  for (const message of context.messages) {
    if (message.role === "toolResult") {
      const call = pending.get(message.toolCallId);
      if (call === undefined) {
        throw new Error(`Orphan or duplicate Pi ToolResult: ${message.toolCallId}`);
      }
      if (message.toolName !== call.name) {
        throw new Error(`Pi ToolResult name does not match ToolCall: ${message.toolCallId}`);
      }
      const textParts = message.content.map((block) => {
        if (block.type !== "text") {
          throw new Error("CommandCode tool results do not support image content");
        }
        return block.text;
      });
      converted.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: "",
            output: {
              type: message.isError ? "error-text" : "text",
              value: textParts.join("\n"),
            },
          },
        ],
      });
      pending.delete(message.toolCallId);
      continue;
    }

    flushMissingResults();

    if (message.role === "user") {
      const content =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content.map((block) => {
              if (block.type === "text") {
                return { type: "text" as const, text: block.text };
              }
              if (!model.input.includes("image")) {
                throw new Error("Resolved model does not accept image input");
              }
              return {
                type: "image" as const,
                image: `data:${block.mimeType};base64,${block.data}`,
                mimeType: block.mimeType,
              };
            });
      converted.push({ role: "user", content });
      continue;
    }

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      continue;
    }
    if (
      message.stopReason !== "stop" &&
      message.stopReason !== "length" &&
      message.stopReason !== "toolUse"
    ) {
      throw new Error(`Unsupported historical stop state: ${message.stopReason}`);
    }
    const sameTarget =
      message.api === model.api &&
      message.provider === model.provider &&
      message.model === model.id;
    const calls: PendingToolCall[] = [];
    const seenCallIds = new Set<string>();
    const content = message.content.map((block) => {
      if (block.type === "text") {
        if (sameTarget && (block.textSignature?.length ?? 0) > 0) {
          throw new Error("CommandCode cannot preserve same-target text continuity");
        }
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "thinking") {
        if (sameTarget) {
          if (block.redacted === true) {
            throw new Error("CommandCode cannot replay same-target redacted thinking");
          }
          if ((block.thinkingSignature?.length ?? 0) > 0) {
            throw new Error(
              "CommandCode cannot preserve same-target thinking continuity",
            );
          }
        } else if (block.redacted === true) {
          return undefined;
        }
        return { type: "reasoning" as const, text: block.thinking };
      }
      const extended = block as typeof block & { namespace?: unknown };
      if (extended.namespace !== undefined) {
        throw new Error("CommandCode cannot map a ToolCall namespace");
      }
      if (sameTarget && (block.thoughtSignature?.length ?? 0) > 0) {
        throw new Error("CommandCode cannot preserve same-target ToolCall continuity");
      }
      if (seenCallIds.has(block.id)) {
        throw new Error(`Duplicate Pi ToolCall id in one turn: ${block.id}`);
      }
      seenCallIds.add(block.id);
      const input = cloneLosslessJson(block.arguments);
      if (!isRecord(input)) {
        throw new Error("ToolCall arguments must be a non-null, non-array object");
      }
      calls.push({ id: block.id, name: block.name });
      return {
        type: "tool-call" as const,
        toolCallId: block.id,
        toolName: block.name,
        input,
      };
    }).filter((block) => block !== undefined);
    converted.push({ role: "assistant", content });
    pending = new Map(calls.map((call) => [call.id, call]));
  }

  flushMissingResults();
  return converted;
}

export function convertCommandCodeTools(
  tools: Context["tools"],
): Array<Record<string, unknown>> {
  return (tools ?? []).map((tool) => {
    const constrained = tool.constrainedSampling;
    if (
      constrained !== undefined &&
      constrained !== false &&
      constrained.type === "json_schema" &&
      constrained.strict === "require"
    ) {
      throw new Error(
        "CommandCode cannot preserve required JSON-schema constrained sampling",
      );
    }
    const inputSchema = cloneLosslessJson(tool.parameters);
    if (!isRecord(inputSchema)) {
      throw new Error("Pi Tool parameters must be an object-shaped JSON schema");
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: inputSchema,
    };
  });
}

const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function mapReasoningLevel(
  model: Model<typeof API_ID>,
  level: Exclude<ModelThinkingLevel, "off">,
): string {
  const explicit = model.thinkingLevelMap?.[level];
  if (explicit === null) {
    throw new Error(`Model exposes an unsupported thinking level: ${level}`);
  }
  if (explicit !== undefined) {
    if (!REASONING_EFFORTS.has(explicit)) {
      throw new Error(`Model maps ${level} to an invalid CommandCode effort`);
    }
    return explicit;
  }
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium" || level === "high") return level;
  throw new Error(`Model must explicitly map CommandCode effort for ${level}`);
}

function resolveReasoning(
  model: Model<typeof API_ID>,
  options: SimpleStreamOptions | undefined,
): { effort?: string; supportedEfforts: ReadonlySet<string> } {
  const supportedEfforts = new Set<string>();
  for (const level of getSupportedThinkingLevels(model)) {
    if (level !== "off") supportedEfforts.add(mapReasoningLevel(model, level));
  }
  if (options?.reasoning === undefined) return { supportedEfforts };
  const effective = clampThinkingLevel(model, options.reasoning);
  if (effective === "off") return { supportedEfforts };
  return { effort: mapReasoningLevel(model, effective), supportedEfforts };
}

function resolvePermissionMode(value: string | undefined): string {
  if (value === "plan") return "plan";
  if (value === "bypass" || value === "auto-accept") return "auto-accept";
  return "standard";
}

export interface BuiltCommandCodeBody {
  body: Record<string, unknown>;
  supportedReasoningEfforts: ReadonlySet<string>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESERVED_HEADERS = new Set([
  "content-type",
  "accept",
  "user-agent",
  "x-command-code-version",
  "x-cli-environment",
  "x-project-slug",
  "x-taste-learning",
  "x-co-flag",
  "x-session-id",
  "x-cmd-zdr",
  "traceparent",
  "authorization",
  "x-oss-primary-provider",
  "x-oauth-token",
  "x-oauth-provider",
]);

function resolveProviderSessionId(
  value: string | undefined,
  createSessionId: () => string,
): string {
  if (value !== undefined && UUID_PATTERN.test(value)) return value;
  const generated = createSessionId();
  if (!UUID_PATTERN.test(generated)) {
    throw new Error("CommandCode session identity generator returned an invalid UUID");
  }
  return generated;
}

function buildCommandCodeHeaders(
  options: SimpleStreamOptions | undefined,
  sessionId: string,
  projectSlug: string | undefined,
  compatibility: CommandCodeCompatibilityPolicy,
): Record<string, string> {
  const headers = new Map<string, string>();
  for (const [rawName, value] of Object.entries(options?.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (RESERVED_HEADERS.has(name)) continue;
    if (value === null) headers.delete(name);
    else if (typeof value === "string") headers.set(name, value);
    else throw new Error(`Pi header ${rawName} must be a string or null`);
  }

  headers.set("accept", "*/*");
  headers.set("content-type", "application/json");
  headers.set("user-agent", "cli");
  headers.set("x-command-code-version", "1.9.0");
  headers.set("x-taste-learning", "false");
  headers.set("x-co-flag", "false");
  headers.set("x-cmd-zdr", "1");
  headers.set("x-session-id", sessionId);
  headers.set(
    "x-cli-environment",
    compatibility.cliEnvironment === undefined ||
      compatibility.cliEnvironment === "prod"
      ? "production"
      : compatibility.cliEnvironment,
  );
  if (projectSlug !== undefined) headers.set("x-project-slug", projectSlug);
  if ((options?.apiKey?.length ?? 0) > 0) {
    headers.set("authorization", `Bearer ${options?.apiKey ?? ""}`);
  }
  if ((compatibility.ossPrimaryProvider?.length ?? 0) > 0) {
    headers.set(
      "x-oss-primary-provider",
      compatibility.ossPrimaryProvider as string,
    );
  }
  return Object.fromEntries(headers);
}

export interface CommandCodeRequestAuthority {
  config: ServerConfig;
  modelId: string;
  modelAcceptsImages: boolean;
  permissionMode: string;
  sessionId: string;
  supportedReasoningEfforts: ReadonlySet<string>;
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new Error(`${field} contains an unknown field: ${unknown}`);
  }
}

function validateConfig(value: unknown, expected: ServerConfig): void {
  if (!isRecord(value)) throw new Error("CommandCode config must be an object");
  assertAllowedKeys(
    value,
    [
      "workingDir",
      "date",
      "environment",
      "structure",
      "isGitRepo",
      "currentBranch",
      "mainBranch",
      "gitStatus",
      "recentCommits",
    ],
    "CommandCode config",
  );
  const scalarKeys = [
    "workingDir",
    "date",
    "environment",
    "isGitRepo",
    "currentBranch",
    "mainBranch",
    "gitStatus",
  ] as const;
  for (const key of scalarKeys) {
    if (value[key] !== expected[key]) {
      throw new Error(`CommandCode config authority changed: ${key}`);
    }
  }
  if (!sameStringArray(value.structure, expected.structure)) {
    throw new Error("CommandCode config authority changed: structure");
  }
  if (!sameStringArray(value.recentCommits, expected.recentCommits)) {
    throw new Error("CommandCode config authority changed: recentCommits");
  }
}

function validateWireTools(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("CommandCode tools must be an array");
  for (const tool of value) {
    if (
      !isRecord(tool) ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      !isRecord(tool.input_schema)
    ) {
      throw new Error("CommandCode tool definition is malformed");
    }
    if (
      Object.keys(tool).some(
        (key) => !["name", "description", "input_schema"].includes(key),
      )
    ) {
      throw new Error("CommandCode tool definition contains an unknown field");
    }
  }
}

function validateWireMessages(
  value: unknown,
  modelAcceptsImages: boolean,
): void {
  if (!Array.isArray(value)) throw new Error("CommandCode messages must be an array");
  let pending = new Map<string, string>();
  for (const message of value) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      throw new Error("CommandCode message is malformed");
    }
    assertAllowedKeys(message, ["role", "content"], "CommandCode message");
    if (message.role === "tool") {
      if (pending.size === 0) throw new Error("CommandCode contains an orphan tool message");
      for (const block of message.content) {
        if (
          !isRecord(block) ||
          block.type !== "tool-result" ||
          typeof block.toolCallId !== "string" ||
          typeof block.toolName !== "string" ||
          !isRecord(block.output) ||
          (block.output.type !== "text" && block.output.type !== "error-text") ||
          typeof block.output.value !== "string" ||
          !pending.has(block.toolCallId)
        ) {
          throw new Error("CommandCode tool result is malformed, orphaned, or duplicate");
        }
        assertAllowedKeys(
          block,
          ["type", "toolCallId", "toolName", "output"],
          "CommandCode tool result",
        );
        assertAllowedKeys(block.output, ["type", "value"], "CommandCode output");
        pending.delete(block.toolCallId);
      }
      continue;
    }
    if (pending.size > 0) {
      throw new Error("CommandCode assistant tool turn has missing adjacent results");
    }

    if (message.role === "user") {
      for (const block of message.content) {
        if (!isRecord(block)) throw new Error("CommandCode user block is malformed");
        if (block.type === "text" && typeof block.text === "string") {
          assertAllowedKeys(block, ["type", "text"], "CommandCode text block");
          continue;
        }
        if (
          block.type === "image" &&
          typeof block.image === "string" &&
          typeof block.mimeType === "string"
        ) {
          if (!modelAcceptsImages) {
            throw new Error("CommandCode model does not accept image messages");
          }
          assertAllowedKeys(
            block,
            ["type", "image", "mimeType"],
            "CommandCode image block",
          );
          continue;
        }
        throw new Error("CommandCode user content kind is unsupported");
      }
      continue;
    }

    if (message.role !== "assistant") {
      throw new Error("CommandCode message role is unsupported");
    }
    const calls = new Map<string, string>();
    for (const block of message.content) {
      if (!isRecord(block)) throw new Error("CommandCode assistant block is malformed");
      if (
        (block.type === "text" || block.type === "reasoning") &&
        typeof block.text === "string"
      ) {
        assertAllowedKeys(block, ["type", "text"], "CommandCode text block");
        continue;
      }
      if (
        block.type !== "tool-call" ||
        typeof block.toolCallId !== "string" ||
        typeof block.toolName !== "string" ||
        !isRecord(block.input)
      ) {
        throw new Error("CommandCode assistant content kind is unsupported");
      }
      if (calls.has(block.toolCallId)) {
        throw new Error("CommandCode assistant turn contains duplicate ToolCall IDs");
      }
      assertAllowedKeys(
        block,
        ["type", "toolCallId", "toolName", "input"],
        "CommandCode tool call",
      );
      calls.set(block.toolCallId, block.toolName);
    }
    pending = calls;
  }
  if (pending.size > 0) {
    throw new Error("CommandCode final assistant tool turn has missing results");
  }
}

export function validateCommandCodeRequest(
  value: unknown,
  authority: CommandCodeRequestAuthority,
): void {
  if (!isRecord(value)) throw new Error("CommandCode request must be an object");
  assertAllowedKeys(
    value,
    ["config", "memory", "taste", "skills", "permissionMode", "threadId", "mode", "params"],
    "CommandCode request",
  );
  validateConfig(value.config, authority.config);
  if (value.memory !== null || value.taste !== null || value.skills !== null) {
    throw new Error("CommandCode compatibility fields must be null");
  }
  if (value.permissionMode !== authority.permissionMode) {
    throw new Error("CommandCode permission authority changed");
  }
  if (value.threadId !== authority.sessionId || !UUID_PATTERN.test(authority.sessionId)) {
    throw new Error("CommandCode session authority changed");
  }
  if (value.mode !== undefined && (typeof value.mode !== "string" || value.mode.length === 0)) {
    throw new Error("CommandCode mode must be omitted or non-empty");
  }
  if (!isRecord(value.params)) throw new Error("CommandCode params must be an object");
  const params = value.params;
  assertAllowedKeys(
    params,
    [
      "model",
      "system",
      "max_tokens",
      "stream",
      "temperature",
      "reasoning_effort",
      "messages",
      "tools",
    ],
    "CommandCode params",
  );
  if (params.model !== authority.modelId || typeof params.model !== "string") {
    throw new Error("CommandCode model authority changed");
  }
  if (
    !Number.isSafeInteger(params.max_tokens) ||
    (params.max_tokens as number) <= 0 ||
    params.stream !== true
  ) {
    throw new Error("CommandCode generation controls are malformed");
  }
  if (
    params.temperature !== undefined &&
    (typeof params.temperature !== "number" || !Number.isFinite(params.temperature))
  ) {
    throw new Error("CommandCode temperature is malformed");
  }
  if (
    params.reasoning_effort !== undefined &&
    (typeof params.reasoning_effort !== "string" ||
      !REASONING_EFFORTS.has(params.reasoning_effort) ||
      !authority.supportedReasoningEfforts.has(params.reasoning_effort))
  ) {
    throw new Error("CommandCode reasoning effort exceeds model capability");
  }
  if (params.system !== undefined && typeof params.system !== "string") {
    throw new Error("CommandCode system must be a string when present");
  }
  validateWireMessages(params.messages, authority.modelAcceptsImages);
  validateWireTools(params.tools);
}

export function buildCommandCodeBody(
  model: Model<typeof API_ID>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: ServerConfig,
  sessionId: string,
  compatibility: CommandCodeCompatibilityPolicy,
): BuiltCommandCodeBody {
  const messages = convertCommandCodeMessages(model, context);
  const maxTokensCandidate = options?.maxTokens ?? model.maxTokens;
  if (
    !Number.isSafeInteger(maxTokensCandidate) ||
    maxTokensCandidate <= 0
  ) {
    throw new Error("CommandCode maxTokens must be a positive safe integer");
  }
  const maxTokens = clampMaxTokensToContext(model, context, maxTokensCandidate);
  if (
    options?.temperature !== undefined &&
    (typeof options.temperature !== "number" ||
      !Number.isFinite(options.temperature))
  ) {
    throw new Error("CommandCode temperature must be finite when present");
  }
  if (options?.deferred !== undefined && options.deferred !== false) {
    throw new Error("CommandCode does not support Pi deferred execution");
  }
  const reasoning = resolveReasoning(model, options);

  const params: Record<string, unknown> = {
    model: model.id,
    messages,
    tools: convertCommandCodeTools(context.tools),
    max_tokens: maxTokens,
    stream: true,
  };
  if (context.systemPrompt !== undefined) params.system = context.systemPrompt;
  if (options?.temperature !== undefined) params.temperature = options.temperature;
  if (reasoning.effort !== undefined) params.reasoning_effort = reasoning.effort;

  return {
    supportedReasoningEfforts: reasoning.supportedEfforts,
    body: {
      config,
      memory: null,
      taste: null,
      skills: null,
      permissionMode: resolvePermissionMode(compatibility.permissionMode),
      threadId: sessionId,
      params,
    },
  };
}

function createCommandCodeStream(
  boundFetch: FetchFunction,
  now: () => number,
  projectSnapshot: ProjectSnapshot,
  compatibility: CommandCodeCompatibilityPolicy,
  createSessionId: () => string,
): StreamFunction<typeof API_ID, SimpleStreamOptions> {
  return (model, context, options): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    const run = async (): Promise<void> => {
      try {
        const sessionId = resolveProviderSessionId(
          options?.sessionId,
          createSessionId,
        );
        const signal = options?.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const endpoint = new URL("/alpha/generate", model.baseUrl);
        const projectDir = classifyProjectDir(options?.metadata);
        const projectConfig =
          projectDir === undefined
            ? createEmptyServerConfig()
            : await projectSnapshot.snapshot({ projectDir, signal });
        signal.throwIfAborted();
        const projectSlug =
          projectDir === undefined ? undefined : slugify(projectDir) || "root";
        const headers = buildCommandCodeHeaders(
          options,
          sessionId,
          projectSlug,
          compatibility,
        );
        const built = buildCommandCodeBody(
          model,
          context,
          options,
          projectConfig,
          sessionId,
          compatibility,
        );
        const bodyText = JSON.stringify(built.body);
        const validationValue: unknown = JSON.parse(bodyText);
        validateCommandCodeRequest(validationValue, {
          config: projectConfig,
          modelId: model.id,
          modelAcceptsImages: model.input.includes("image"),
          permissionMode: resolvePermissionMode(compatibility.permissionMode),
          sessionId,
          supportedReasoningEfforts: built.supportedReasoningEfforts,
        });
        const requestInit: RequestInit = {
          method: "POST",
          headers,
          body: bodyText,
        };
        if (options?.signal !== undefined) requestInit.signal = options.signal;
        const response = await (options?.fetch ?? boundFetch)(endpoint, requestInit);
        const result = await consumeTextResponse(response);
        const usage: Usage = {
          input: result.inputTokens,
          output: result.outputTokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: result.inputTokens + result.outputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const start = createMessage(model, "", emptyUsage(), "pending", now);
        const complete = createMessage(model, result.text, usage, "stop", now);
        stream.push({ type: "start", partial: start });
        stream.push({ type: "text_start", contentIndex: 0, partial: start });
        stream.push({ type: "text_delta", contentIndex: 0, delta: result.text, partial: complete });
        stream.push({ type: "text_end", contentIndex: 0, content: result.text, partial: complete });
        stream.push({ type: "done", reason: "stop", message: complete });
        stream.end(complete);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const failed = createMessage(model, "", emptyUsage(), "error", now, detail);
        stream.push({ type: "error", reason: "error", error: failed });
        stream.end(failed);
      }
    };

    void run();
    return stream;
  };
}

export function createCommandCodePrivateProvider(
  options: CommandCodePrivateProviderOptions,
): Provider<typeof API_ID> {
  const streams = createCommandCodeStream(
    options.fetch,
    options.now,
    options.projectSnapshot,
    options.compatibility ?? {},
    options.createSessionId ?? randomUUID,
  );
  return createProvider({
    id: PROVIDER_ID,
    name: "CommandCode Private",
    models: [options.model],
    auth: {
      apiKey: {
        name: "CommandCode API key",
        resolve: async () => ({
          auth: { apiKey: options.apiKey },
          source: "LuckyToken runtime",
        }),
      },
    },
    api: {
      stream: streams,
      streamSimple: streams,
    },
  });
}

export const commandCodePrivateProviderId = PROVIDER_ID;
export const commandCodePrivateApiId = API_ID;
