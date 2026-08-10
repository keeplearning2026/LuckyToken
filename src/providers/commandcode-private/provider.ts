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

function buildCommandCodeBody(
  model: Model<typeof API_ID>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: ServerConfig,
): Record<string, unknown> {
  const messages = context.messages.map((message) => {
    if (message.role !== "user") {
      throw new Error("The walking skeleton supports only user messages");
    }
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content.map((block) => {
            if (block.type !== "text") {
              throw new Error("The walking skeleton supports only text content");
            }
            return { type: "text" as const, text: block.text };
          });
    return {
      role: "user",
      content,
    };
  });

  return {
    config,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    threadId: options?.sessionId,
    params: {
      model: model.id,
      messages,
      tools: [],
      max_tokens: options?.maxTokens ?? model.maxTokens,
      stream: true,
    },
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
