/**
 * Direct Pi Provider online smoke for the bundled `deepseek-anthropic`
 * Provider (DeepSeek's Anthropic-Messages-compatible endpoint).
 *
 * It drives the Provider in memory with the real Pi Anthropic adapter and
 * never goes through Token's HTTP endpoint. The git-ignored API key file is
 * read into memory only and never printed.
 */
import {
  normalizeContext,
  type AssistantMessage,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { providerPackage } from "../../packages/provider-deepseek-anthropic/src/index.js";

const DEFAULT_API_KEY_FILE = "deepseekAPIkey.txt";
const DEFAULT_MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;
const REQUEST_TIMEOUT_MS = 120_000;

interface OnlineArguments {
  readonly apiKeyFile: string;
  readonly models: readonly string[];
  readonly reasoning: ThinkingLevel | undefined;
}

function parseArguments(argv: readonly string[]): OnlineArguments {
  let apiKeyFile = DEFAULT_API_KEY_FILE;
  let models: readonly string[] = DEFAULT_MODELS;
  let reasoning: ThinkingLevel | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--api-key-file") {
      apiKeyFile = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--model") {
      const model = argv[index + 1];
      if (model === undefined) throw new Error("--model requires a value");
      models = [model];
      index += 1;
      continue;
    }
    if (argument === "--reasoning") {
      reasoning = (argv[index + 1] ?? "") as ThinkingLevel;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (apiKeyFile.length === 0) throw new Error("--api-key-file must be non-empty");
  return Object.freeze({ apiKeyFile, models, reasoning });
}

function resultLine(
  modelId: string,
  stopReason: string,
  text: string,
  thinkingChars: number,
  usage: AssistantMessage["usage"],
): string {
  return JSON.stringify(
    {
      model: modelId,
      stopReason,
      text,
      thinkingChars,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      },
    },
    null,
    2,
  );
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const apiKey = (
    await readFile(resolve(arguments_.apiKeyFile), "utf8")
  ).trim();
  if (apiKey.length === 0) {
    throw new Error(`API key file is empty: ${arguments_.apiKeyFile}`);
  }

  const provider = providerPackage.createProvider({
    configuration: Object.freeze({}),
    configurationPath: "online-smoke",
    host: Object.freeze({
      registerLocalOAuth: () => undefined,
      fetch: globalThis.fetch,
      now: Date.now,
      createUuid: () => crypto.randomUUID(),
    }),
  });

  for (const modelId of arguments_.models) {
    const model = provider.getModels().find((entry) => entry.id === modelId);
    if (model === undefined) {
      throw new Error(`Provider ${provider.id} has no model ${modelId}`);
    }
    const stream = provider.streamSimple(
      model,
      normalizeContext({
        systemPrompt: "You are a terse assistant.",
        messages: [
          {
            role: "user",
            content: "Reply with exactly: pong",
            timestamp: Date.now(),
          },
        ],
      }),
      {
        apiKey,
        maxTokens: 128,
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...(arguments_.reasoning === undefined
          ? {}
          : { reasoning: arguments_.reasoning }),
      },
    );

    let text = "";
    let thinkingChars = 0;
    let stopReason: string | undefined;
    let usage: AssistantMessage["usage"] | undefined;
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "thinking_delta") thinkingChars += event.delta.length;
      if (event.type === "error") {
        throw new Error(
          `${modelId}: ${event.error.errorMessage ?? "unknown stream error"}`,
        );
      }
      if (event.type === "done") {
        stopReason = event.reason;
        usage = event.message.usage;
        break;
      }
    }
    if (stopReason === undefined || usage === undefined) {
      throw new Error(`${modelId}: stream ended without a done event`);
    }
    process.stdout.write(
      `${resultLine(modelId, stopReason, text, thinkingChars, usage)}\n`,
    );
    if (text.trim().length === 0) {
      throw new Error(`${modelId}: empty response text`);
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `deepseek-anthropic smoke failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
