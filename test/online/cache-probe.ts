#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { createConfiguredLuckyTokenDataPlane } from "../../src/composition.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";

const MODEL = "commandcode-private/deepseek/deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 180_000;

function words(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(
    " ",
  );
}

function usageRow(label: string, usage: Anthropic.Messages.Usage): string {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const input = usage.input_tokens ?? 0;
  const cacheRate = input === 0 ? 0 : Math.round((cacheRead / input) * 1000) / 10;
  return `${label}: input=${input} cache_read=${cacheRead} cache_write=${cacheWrite} cacheRate=${cacheRate}% output=${usage.output_tokens}`;
}

function createCapturingFetch(upstream: FetchFunction): {
  readonly fetch: FetchFunction;
  readonly rawJsonlByRequest: string[][];
} {
  const rawJsonlByRequest: string[][] = [];
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    const response = await upstream(request);
    const responseText = await response.text();
    rawJsonlByRequest.push(
      responseText.split(/\r?\n/u).filter((line) => line.length > 0),
    );
    return new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { fetch, rawJsonlByRequest };
}

async function main(): Promise<void> {
  const commandCodeApiKey = (await readFile("CommandcodeAPIKey.txt", "utf8")).trim();
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-cache-probe-"));
  let server: Awaited<ReturnType<typeof startLuckyTokenHttpServer>> | undefined;
  try {
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    const clientAuthFile = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await mkdir(piDirectory, { recursive: true });
    const localGlobalClientKey = randomUUID();
    const clientTokenStore = createFileClientTokenStore({ path: clientAuthFile });
    await clientTokenStore.create({ type: "global" }, localGlobalClientKey);
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
          maxRequestBytes: 32_000_000,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
        },
      }),
      "utf8",
    );
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(
      "commandcode-private",
      async () => ({ type: "api_key", key: commandCodeApiKey }),
    );
    const capture = createCapturingFetch(globalThis.fetch);
    const config = await loadLuckyTokenCliConfig(configPath);
    const composition = await createConfiguredLuckyTokenDataPlane({
      config,
      credentials,
      fetch: capture.fetch,
    });
    server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: config.server.host,
      port: config.server.port,
    });
    const client = new Anthropic({
      apiKey: localGlobalClientKey,
      baseURL: server.origin,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });

    const systemBase = words(1000, "sysword");
    const userContent = words(1000, "userword");
    const sessionId = randomUUID();
    const sharedHeaders = { "x-session-id": sessionId };

    const request = (system: string) =>
      client.messages.create(
        {
          model: MODEL,
          max_tokens: 64,
          system,
          messages: [{ role: "user", content: userContent }],
        },
        { headers: sharedHeaders },
      );

    const before = await request(systemBase);
    console.log(usageRow("request-1 identical system", before.usage));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));

    const mid = await request(systemBase);
    console.log(usageRow("request-2 identical system", mid.usage));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));

    const changed = await request(`${systemBase}!`);
    console.log(usageRow("request-3 system+1 char", changed.usage));

    for (let index = 0; index < capture.rawJsonlByRequest.length; index += 1) {
      console.log(`\n=== upstream raw JSONL request ${index + 1} ===`);
      for (const line of capture.rawJsonlByRequest[index] ?? []) {
        console.log(line);
      }
    }
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
