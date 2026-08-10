import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type FetchFunction,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamFunction,
  type Usage,
} from "@earendil-works/pi-ai";
import slugify from "@sindresorhus/slugify";

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
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "thinking") {
        throw new Error("CommandCode assistant thinking is not supported yet");
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
    });
    converted.push({ role: "assistant", content });
    pending = new Map(calls.map((call) => [call.id, call]));
  }

  flushMissingResults();
  return converted;
}

function buildCommandCodeBody(
  model: Model<typeof API_ID>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: ServerConfig,
): Record<string, unknown> {
  const messages = convertCommandCodeMessages(model, context);

  const params: Record<string, unknown> = {
    model: model.id,
    messages,
    tools: [],
    max_tokens: options?.maxTokens ?? model.maxTokens,
    stream: true,
  };
  if (context.systemPrompt !== undefined) params.system = context.systemPrompt;

  return {
    config,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    threadId: options?.sessionId,
    params,
  };
}

function createCommandCodeStream(
  boundFetch: FetchFunction,
  now: () => number,
  projectSnapshot: ProjectSnapshot,
): StreamFunction<typeof API_ID, SimpleStreamOptions> {
  return (model, context, options): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    const run = async (): Promise<void> => {
      try {
        const sessionId = options?.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          throw new Error("CommandCode requires one resolved sessionId");
        }
        const signal = options?.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const projectDir = classifyProjectDir(options?.metadata);
        const projectConfig =
          projectDir === undefined
            ? createEmptyServerConfig()
            : await projectSnapshot.snapshot({ projectDir, signal });
        signal.throwIfAborted();
        const projectSlug =
          projectDir === undefined ? undefined : slugify(projectDir) || "root";
        const endpoint = new URL("/alpha/generate", model.baseUrl);
        const headers: Record<string, string> = {
          accept: "*/*",
          authorization: `Bearer ${options?.apiKey ?? ""}`,
          "content-type": "application/json",
          "user-agent": "cli",
          "x-cli-environment": "production",
          "x-cmd-zdr": "1",
          "x-co-flag": "false",
          "x-command-code-version": "1.9.0",
          "x-session-id": sessionId,
          "x-taste-learning": "false",
        };
        // Core v5.5 makes project-less identity explicit by omitting this wire fact.
        if (projectSlug !== undefined) headers["x-project-slug"] = projectSlug;
        const requestInit: RequestInit = {
          method: "POST",
          headers,
          body: JSON.stringify(
            buildCommandCodeBody(model, context, options, projectConfig),
          ),
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
