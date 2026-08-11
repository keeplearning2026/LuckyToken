import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  createProvider,
  getSupportedThinkingLevels,
  type AssistantMessageEventStream,
  type Context,
  type FetchFunction,
  type Model,
  type ModelThinkingLevel,
  type Provider,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import slugify from "@sindresorhus/slugify";
import { randomUUID } from "node:crypto";

import {
  classifyProjectDir,
  createEmptyServerConfig,
  type ProjectSnapshot,
  type ServerConfig,
} from "./project.js";
import {
  executeCommandCodeAttempts,
  resolveCommandCodeExecutionControls,
  resolveLogicalTraceId,
  type CommandCodeTraceContextCapability,
  type PreparedCommandCodeRequest,
} from "./attempts.js";
import {
  captureCommandCodeResponseAuthority,
  convertCommittedCommandCodeResult,
  createCommandCodeFailureMessage,
  replayCommandCodeAssistantMessage,
} from "./semantic.js";
import { cloneLosslessJsonObject } from "./json.js";

const PROVIDER_ID = "commandcode-private";
const API_ID = "commandcode-private";
const MISSING_TOOL_RESULT =
  "No result — the tool call did not complete (interrupted or lost).";

export interface CommandCodePrivateProviderOptions {
  apiKey: string;
  fetch?: FetchFunction;
  model: Model<typeof API_ID>;
  now: () => number;
  projectSnapshot: ProjectSnapshot;
  compatibility?: CommandCodeCompatibilityPolicy;
  createSessionId?: () => string;
  traceContext?: CommandCodeTraceContextCapability;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface CommandCodeCompatibilityPolicy {
  cliEnvironment?: string;
  ossPrimaryProvider?: string;
  permissionMode?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      const input = cloneLosslessJsonObject(
        block.arguments,
        "ToolCall arguments",
      );
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
    const inputSchema = cloneLosslessJsonObject(
      tool.parameters,
      "Pi Tool parameters",
    );
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
    max_tokens: maxTokensCandidate,
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

function cloneServerConfig(config: ServerConfig): ServerConfig {
  return {
    workingDir: config.workingDir,
    date: config.date,
    environment: config.environment,
    structure: [...config.structure],
    isGitRepo: config.isGitRepo,
    currentBranch: config.currentBranch,
    mainBranch: config.mainBranch,
    gitStatus: config.gitStatus,
    recentCommits: [...config.recentCommits],
  };
}

function snapshotRequestModel(
  model: Model<typeof API_ID>,
): Model<typeof API_ID> {
  return {
    ...model,
    input: [...model.input],
    cost: {
      ...model.cost,
      ...(model.cost.tiers === undefined
        ? {}
        : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }),
    },
    ...(model.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
  };
}

async function racePayloadCallback<T>(
  callbackPromise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void callbackPromise.catch(() => undefined);
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("CommandCode payload preparation was aborted");
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("CommandCode payload preparation was aborted"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([callbackPromise, aborted]);
  } catch (error) {
    if (signal.aborted) void callbackPromise.catch(() => undefined);
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

export interface CommandCodePreparationDependencies {
  boundFetch?: FetchFunction;
  projectSnapshot: ProjectSnapshot;
  compatibility: CommandCodeCompatibilityPolicy;
  createSessionId: () => string;
  traceContext?: CommandCodeTraceContextCapability;
}

export async function prepareCommandCodeRequest(
  model: Model<typeof API_ID>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  dependencies: CommandCodePreparationDependencies,
): Promise<PreparedCommandCodeRequest> {
  const signal = options?.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  const requestModel = snapshotRequestModel(model);
  const invokedModelId = requestModel.id;
  const modelAcceptsImages = requestModel.input.includes("image");
  const endpoint = new URL("/alpha/generate", requestModel.baseUrl).toString();
  const logicalTraceId = resolveLogicalTraceId(
    dependencies.traceContext,
    options?.telemetryContext,
  );
  const sessionId = resolveProviderSessionId(
    options?.sessionId,
    dependencies.createSessionId,
  );
  const permissionMode = resolvePermissionMode(
    dependencies.compatibility.permissionMode,
  );
  const projectDir = classifyProjectDir(options?.metadata);
  const snapshot =
    projectDir === undefined
      ? createEmptyServerConfig()
      : await dependencies.projectSnapshot.snapshot({ projectDir, signal });
  signal.throwIfAborted();

  const authoritativeConfig = cloneServerConfig(snapshot);
  const callbackConfig = cloneServerConfig(authoritativeConfig);
  const projectSlug =
    projectDir === undefined ? undefined : slugify(projectDir) || "root";
  const headers = buildCommandCodeHeaders(
    options,
    sessionId,
    projectSlug,
    dependencies.compatibility,
  );
  const built = buildCommandCodeBody(
    requestModel,
    context,
    options,
    callbackConfig,
    sessionId,
    dependencies.compatibility,
  );

  let effectivePayload: unknown = built.body;
  if (options?.onPayload !== undefined) {
    const callbackPromise = Promise.resolve().then(() =>
      options.onPayload?.(built.body, model),
    );
    const replacement = await racePayloadCallback(callbackPromise, signal);
    if (replacement !== undefined) effectivePayload = replacement;
  }
  signal.throwIfAborted();

  const serialized = JSON.stringify(effectivePayload);
  if (serialized === undefined) {
    throw new Error("CommandCode payload serialization produced no request body");
  }
  signal.throwIfAborted();
  const validationValue: unknown = JSON.parse(serialized);
  validateCommandCodeRequest(validationValue, {
    config: authoritativeConfig,
    modelId: invokedModelId,
    modelAcceptsImages,
    permissionMode,
    sessionId,
    supportedReasoningEfforts: built.supportedReasoningEfforts,
  });
  return Object.freeze({
    endpoint,
    headers: Object.freeze({ ...headers }),
    bodyText: serialized,
    signal,
    fetchImpl: options?.fetch ?? dependencies.boundFetch ?? globalThis.fetch,
    ...(logicalTraceId === undefined
      ? {}
      : { logicalTraceId }),
  });
}

function createCommandCodeStream(
  boundFetch: FetchFunction | undefined,
  now: () => number,
  projectSnapshot: ProjectSnapshot,
  compatibility: CommandCodeCompatibilityPolicy,
  createSessionId: () => string,
  traceContext: CommandCodeTraceContextCapability | undefined,
  sleep: ((delayMs: number, signal: AbortSignal) => Promise<void>) | undefined,
): StreamFunction<typeof API_ID, SimpleStreamOptions> {
  return (model, context, options): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const responseAuthority = captureCommandCodeResponseAuthority(model, now);

    const run = async (): Promise<void> => {
      try {
        options?.signal?.throwIfAborted();
        const controls = resolveCommandCodeExecutionControls(options);
        const prepared = await prepareCommandCodeRequest(
          model,
          context,
          options,
          {
            ...(boundFetch === undefined ? {} : { boundFetch }),
            projectSnapshot,
            compatibility,
            createSessionId,
            ...(traceContext === undefined ? {} : { traceContext }),
          },
        );
        const result = await executeCommandCodeAttempts(
          prepared,
          model,
          controls,
          {
            now,
            ...(traceContext === undefined ? {} : { traceContext }),
            ...(sleep === undefined ? {} : { sleep }),
          },
        );
        const finalMessage = convertCommittedCommandCodeResult(
          result,
          responseAuthority,
        );
        replayCommandCodeAssistantMessage(
          stream,
          finalMessage,
          prepared.signal,
        );
      } catch (error) {
        const aborted = options?.signal?.aborted === true;
        const failed = createCommandCodeFailureMessage(
          responseAuthority,
          error,
          undefined,
          aborted,
        );
        replayCommandCodeAssistantMessage(stream, failed, options?.signal);
      }
    };

    void run();
    return stream;
  };
}

function snapshotCompatibilityPolicy(
  source: CommandCodeCompatibilityPolicy,
): CommandCodeCompatibilityPolicy {
  return Object.freeze({
    ...(source.cliEnvironment === undefined
      ? {}
      : { cliEnvironment: source.cliEnvironment }),
    ...(source.ossPrimaryProvider === undefined
      ? {}
      : { ossPrimaryProvider: source.ossPrimaryProvider }),
    ...(source.permissionMode === undefined
      ? {}
      : { permissionMode: source.permissionMode }),
  });
}

function snapshotProjectCapability(source: ProjectSnapshot): ProjectSnapshot {
  const snapshot = source.snapshot;
  return Object.freeze({
    snapshot: (input: Parameters<ProjectSnapshot["snapshot"]>[0]) =>
      snapshot.call(source, input),
  });
}

function snapshotTraceContextCapability(
  source: CommandCodeTraceContextCapability | undefined,
): CommandCodeTraceContextCapability | undefined {
  if (source === undefined) return undefined;
  const resolveLogicalTraceId = source.resolveLogicalTraceId;
  const createSpanId = source.createSpanId;
  return Object.freeze({
    resolveLogicalTraceId: (telemetryContext: unknown) =>
      resolveLogicalTraceId.call(source, telemetryContext),
    createSpanId: () => createSpanId.call(source),
  });
}

function deepFreezeProviderData<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreezeProviderData(nested, seen);
  }
  return Object.freeze(value);
}

export function createCommandCodePrivateProvider(
  options: CommandCodePrivateProviderOptions,
): Provider<typeof API_ID> {
  const apiKey = options.apiKey;
  const model = deepFreezeProviderData(
    structuredClone(options.model) as Model<typeof API_ID>,
  );
  const compatibility = snapshotCompatibilityPolicy(options.compatibility ?? {});
  const projectSnapshot = snapshotProjectCapability(options.projectSnapshot);
  const traceContext = snapshotTraceContextCapability(options.traceContext);
  const streams = createCommandCodeStream(
    options.fetch,
    options.now,
    projectSnapshot,
    compatibility,
    options.createSessionId ?? randomUUID,
    traceContext,
    options.sleep,
  );
  return createProvider({
    id: PROVIDER_ID,
    name: "CommandCode Private",
    models: [model],
    auth: {
      apiKey: {
        name: "CommandCode API key",
        resolve: async () => ({
          auth: { apiKey },
          source: "CommandCode Private provider",
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
