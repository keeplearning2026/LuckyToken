import Anthropic from "@anthropic-ai/sdk";
import { InMemoryCredentialStore, type FetchFunction } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { createConfiguredLuckyTokenDataPlane } from "../../src/composition.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";

/**
 * Online verification that every CommandCode normal-lifecycle SSE event type
 * appears in real traffic and is accepted without protocol error.
 *
 * Normal lifecycle events (must all appear):
 *   start, start-step, finish-step, provider-metadata,
 *   text-start/delta/end, reasoning-start/delta/end,
 *   tool-input-start/delta/end, tool-call, finish
 *
 * abort/error/tool-result are failure/edge events; their absence is fine.
 */

const MODEL = "commandcode-private/deepseek/deepseek-v4-flash";

const REQUIRED_EVENTS = new Set([
  "start",
  "start-step",
  "finish-step",
  "provider-metadata",
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-call",
  "finish",
]);

type EventCounts = Record<string, number>;

function createCapturingFetch(upstream: FetchFunction): {
  readonly fetch: FetchFunction;
  readonly events: EventCounts;
} {
  const events: EventCounts = {};
  const fetch: FetchFunction = async (input, init) => {
    const response = await upstream(input, init);
    if (!response.body) return response;
    const text = await response.clone().text();
    for (const line of text.split(/\r?\n/u)) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`non-JSON upstream line: ${line.slice(0, 80)}`);
      }
      const event = parsed as { type?: unknown };
      if (typeof event.type !== "string") {
        throw new Error(`upstream event missing type: ${line.slice(0, 80)}`);
      }
      events[event.type] = (events[event.type] ?? 0) + 1;
    }
    return response;
  };
  return { fetch, events };
}

async function main(): Promise<void> {
  const apiKey = (await readFile("CommandcodeAPIKey.txt", "utf8")).trim();
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-events-"));
  const stateDirectory = join(directory, ".luckytoken");
  const piDirectory = join(stateDirectory, "pi");
  const clientAuthFile = join(
    stateDirectory,
    "client-auth",
    "anthropic-messages.json",
  );
  await mkdir(piDirectory, { recursive: true });
  const clientToken = randomUUID();
  const clientTokenStore = createFileClientTokenStore({ path: clientAuthFile });
  await clientTokenStore.create({ type: "global" }, clientToken);
  const configPath = join(stateDirectory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "luckytoken-config-v1",
      server: { host: "127.0.0.1", port: 0 },
      clientProtocols: {
        "anthropic-messages": {
          authFile: "client-auth/anthropic-messages.json",
        },
      },
      pi: { directory: "pi" },
      limits: {
        maxRequestBytes: 1_048_576,
        requestTimeoutMs: 120_000,
      },
    }),
    "utf8",
  );
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(
    "commandcode-private",
    async () => ({ type: "api_key", key: apiKey }),
  );
  const config = await loadLuckyTokenCliConfig(configPath);
  const capturing = createCapturingFetch(globalThis.fetch);
  const composition = await createConfiguredLuckyTokenDataPlane({
    config,
    credentials,
    fetch: capturing.fetch,
  });
  const server = await startLuckyTokenHttpServer({
    runtime: composition.runtime,
    host: config.server.host,
    port: config.server.port,
  });
  const client = new Anthropic({
    apiKey: clientToken,
    baseURL: server.origin,
    maxRetries: 0,
    timeout: 120_000,
  });

  try {
    // Text-only turn (exercises start, text-*, finish).
    await client.messages.create({
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: "写一句关于春天的诗" }],
    });

    // Reasoning-heavy turn (exercises reasoning-*).
    await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "详细解释什么是递归" }],
    });

    // Tool turn (exercises tool-input-*, tool-call).
    await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [
        {
          name: "add",
          description: "加法",
          input_schema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: "调用 add 工具计算 123+456",
        },
      ],
    });

    const seen = Object.keys(capturing.events).sort();
    console.log("Observed events:", JSON.stringify(capturing.events, null, 2));
    const missing = [...REQUIRED_EVENTS].filter(
      (event) => capturing.events[event] === undefined,
    );
    if (missing.length > 0) {
      console.error(`Missing required events: ${missing.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log(`All ${REQUIRED_EVENTS.size} normal-lifecycle events observed.`);
    }
    console.log(`Total upstream events: ${seen.length} types.`);
  } finally {
    await server.close();
  }
}

void main();
