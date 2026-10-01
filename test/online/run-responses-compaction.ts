/**
 * Online certification: Codex remote compaction v2 across the two Responses
 * serving lanes.
 *
 * `commandcode-goat` is Provider Native for `openai-responses` (certified for
 * `responses`, not for `responses-compaction`), so its compaction turn stays
 * on the native lane and Token summarizes in-lane. `commandcode-private` is
 * not provider-native certified and reaches Semantic Conversion. Both must
 * answer with exactly one Token-owned `Token1:` compaction item, and both
 * must decode that envelope on the replay turn.
 *
 * API key files are git-ignored and read into memory only.
 */
import {
  type AuthInteraction,
  type AuthPrompt,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { DEFAULT_MAX_REQUEST_BYTES } from "../../src/data-plane-limits.js";
import {
  TOKEN_COMPACTION_PREFIX,
} from "../../src/responses-compaction.js";
import { supportsProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { startTokenHttpServer } from "../../src/server.js";
import {
  createConfiguredPiModels,
  createConfiguredTokenDataPlane,
  type ConfiguredTokenDataPlane,
} from "../support/configured-data-plane.js";
import { loginOnlineProvider } from "./provider-login.js";

const MODEL_ID = "deepseek/deepseek-v4.1-flash";
const API_KEY_FILE = "CommandcodeAPIKey.txt";
const REQUEST_TIMEOUT_MS = 180_000;
const CASES = [
  {
    providerId: "commandcode-goat",
    expectation: "provider-native in-lane summarize",
  },
  {
    providerId: "commandcode-private",
    expectation: "semantic conversion",
  },
] as const;

function keyFileLoginInteraction(apiKey: string): AuthInteraction {
  return Object.freeze({
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type !== "secret" && prompt.type !== "text") {
        throw new Error(`Online login does not support ${prompt.type} prompts`);
      }
      return apiKey;
    },
    notify: () => undefined,
  });
}

interface CapturedExchange {
  readonly url: string;
  readonly body: string;
}

function decodeBody(
  request: Request,
  bytes: Uint8Array<ArrayBuffer>,
): string {
  const encoding = request.headers.get("content-encoding");
  if (encoding === "zstd") return zstdDecompressSync(bytes).toString("utf8");
  if (encoding === "gzip") return gunzipSync(bytes).toString("utf8");
  return new TextDecoder().decode(bytes);
}

function createCapturingFetch(): {
  readonly fetch: FetchFunction;
  readonly exchanges: CapturedExchange[];
} {
  const exchanges: CapturedExchange[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      // A Request input must be cloned, never reconstructed: constructing a
      // new Request from it can disturb the body the real fetch still needs.
      const captured =
        input instanceof Request ? input.clone() : new Request(input, init);
      const bytes = new Uint8Array(await captured.arrayBuffer());
      exchanges.push({
        url: captured.url,
        body: decodeBody(captured, bytes),
      });
    } catch {
      exchanges.push({
        url: input instanceof Request ? input.url : String(input),
        body: "",
      });
    }
    return globalThis.fetch(input, init);
  }) as FetchFunction;
  return { fetch: fetchImpl, exchanges };
}

interface SseFrame {
  readonly type?: unknown;
  readonly delta?: unknown;
  readonly item?: unknown;
  readonly response?: unknown;
}

function sseFrames(body: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          frames.push(parsed as SseFrame);
        }
      } catch {
        // Non-JSON frames are not part of the asserted contract.
      }
    }
  }
  return frames;
}

function compactionItems(frames: readonly SseFrame[]): Record<string, unknown>[] {
  return frames
    .filter((frame) => frame.type === "response.output_item.done")
    .map((frame) => frame.item)
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
    .filter((item) => item.type === "compaction");
}

function assistantText(frames: readonly SseFrame[]): string {
  const deltas = frames
    .filter((frame) => frame.type === "response.output_text.delta")
    .map((frame) => (typeof frame.delta === "string" ? frame.delta : ""))
    .join("");
  if (deltas.length > 0) return deltas;
  const parts: string[] = [];
  for (const frame of frames) {
    if (frame.type !== "response.output_item.done") continue;
    const item = frame.item;
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "output_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        parts.push((part as { text: string }).text);
      }
    }
  }
  return parts.join("");
}

async function postResponses(
  origin: string,
  body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly text: string }> {
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer unused-local-sdk-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, text: await response.text() };
}

async function main(): Promise<void> {
  const apiKey = (await readFile(API_KEY_FILE, "utf8")).trim();
  if (apiKey.length === 0) throw new Error(`${API_KEY_FILE} is empty`);
  const directory = await mkdtemp(join(tmpdir(), "Token-responses-compaction-"));
  const stateDirectory = join(directory, ".Token");
  await mkdir(join(stateDirectory, "pi"), { recursive: true });
  const configPath = join(stateDirectory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "token-config-v2",
      server: { port: 0 },
      clientProtocols: {
        "anthropic-messages": {},
        "openai-responses": { stateFile: "state/openai-responses.json" },
      },
      providerPackages: {},
      pi: { directory: "pi" },
      limits: {
        maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      },
    }),
    "utf8",
  );
  const config = await loadTokenCliConfig(configPath);
  const credentialRecordStore = createInMemoryProviderCredentialRecordStore({
    createRevision: randomUUID,
  });
  const capture = createCapturingFetch();
  const failures: string[] = [];
  let composition: ConfiguredTokenDataPlane | undefined;
  let server: Awaited<ReturnType<typeof startTokenHttpServer>> | undefined;
  try {
    const preLogin = await createConfiguredPiModels({
      piDirectory: config.pi.directory,
      commandCodeModelsPath: join(
        dirname(config.configPath),
        "commandcode-models.json",
      ),
      providerPackages: config.providerPackages,
      fetch: capture.fetch,
      credentialRecordStore,
    });
    for (const providerId of ["commandcode-private", "commandcode-goat"]) {
      await loginOnlineProvider({
        models: preLogin.models,
        providerAuthBindings: preLogin.providerAuthBindings,
        credentialManagement: preLogin.credentialManagement,
        providerId,
        authType: "api_key",
        displayName: "Responses compaction online test",
        interaction: keyFileLoginInteraction(apiKey),
      });
    }
    composition = await createConfiguredTokenDataPlane({
      config,
      credentialRecordStore,
      fetch: capture.fetch,
    });
    server = await startTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: config.server.port,
    });
    const origin = server.origin;

    for (const testCase of CASES) {
      const selector = `${testCase.providerId}/${MODEL_ID}`;
      const resolved = composition.catalog.models.getModel(
        testCase.providerId,
        MODEL_ID,
      );
      if (resolved === undefined) {
        failures.push(`${selector}: resolved model missing`);
        continue;
      }
      const nativeResponses = supportsProviderNativeResponses(
        resolved,
        "responses",
      );
      const nativeCompaction = supportsProviderNativeResponses(
        resolved,
        "responses-compaction",
      );
      const marker = `LT_COMPACT_${randomUUID().slice(0, 8)}`;

      console.log(`== ${selector} (${testCase.expectation}) ==`);
      console.log(
        `provider-native responses=${nativeResponses} responses-compaction=${nativeCompaction}`,
      );
      if (nativeResponses !== (testCase.providerId === "commandcode-goat")) {
        failures.push(`${selector}: unexpected provider-native certification`);
      }
      if (nativeCompaction) {
        failures.push(`${selector}: upstream unexpectedly certified to compact`);
      }

      const compactionStart = capture.exchanges.length;
      const compaction = await postResponses(origin, {
        model: selector,
        stream: true,
        instructions: "You are a coding agent.",
        tools: [
          {
            type: "function",
            name: "marker_tool",
            description: "must not reach the summarizer",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Remember the number 41 for the next request. Probe marker ${marker}.`,
              },
            ],
          },
          { type: "compaction_trigger" },
        ],
      });
      const compactionFrames = sseFrames(compaction.text);
      const items = compactionItems(compactionFrames);
      const completed = compactionFrames.some(
        (frame) => frame.type === "response.completed",
      );
      const envelope =
        items.length === 1 && typeof items[0]!.encrypted_content === "string"
          ? items[0]!.encrypted_content
          : undefined;
      const summary =
        envelope !== undefined && envelope.startsWith(TOKEN_COMPACTION_PREFIX)
          ? Buffer.from(
              envelope.slice(TOKEN_COMPACTION_PREFIX.length),
              "base64",
            ).toString("utf8")
          : undefined;
      console.log(
        `compaction: HTTP ${compaction.status}, compactionItems=${items.length}, completed=${completed}, summaryChars=${summary?.length ?? 0}`,
      );
      if (compaction.status !== 200) {
        failures.push(`${selector}: compaction HTTP ${compaction.status}`);
        console.log(compaction.text.slice(0, 400));
      }
      if (items.length !== 1 || envelope === undefined) {
        failures.push(`${selector}: expected exactly one Token compaction item`);
      }
      if (summary === undefined || summary.length === 0) {
        failures.push(`${selector}: envelope did not decode to summary text`);
      }
      if (!completed) failures.push(`${selector}: response.completed missing`);

      const compactionExchanges = capture.exchanges
        .slice(compactionStart)
        .filter((exchange) => exchange.body.includes(marker));
      for (const exchange of compactionExchanges) {
        console.log(`upstream(compaction) url=${exchange.url}`);
      }
      console.log(
        `upstream(compaction): requests=${compactionExchanges.length}, rewritten=${compactionExchanges.some(
          (exchange) => !exchange.body.includes("compaction_trigger"),
        )}`,
      );
      for (const exchange of compactionExchanges) {
        if (exchange.body.includes("compaction_trigger")) {
          failures.push(
            `${selector}: compaction_trigger was forwarded to the upstream`,
          );
        }
        if (exchange.body.includes("marker_tool")) {
          failures.push(`${selector}: tool surface reached the summarizer`);
        }
        if (!exchange.body.includes("context summarization assistant")) {
          failures.push(
            `${selector}: summarizer system prompt missing upstream`,
          );
        }
        if (!exchange.body.includes("## Goal")) {
          failures.push(`${selector}: summarizer prompt missing upstream`);
        }
      }

      const replayStart = capture.exchanges.length;
      const replay = await postResponses(origin, {
        model: selector,
        stream: true,
        input: [
          ...(items.length === 1 ? [items[0]!] : []),
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "What number did I ask you to remember? Reply with just the number.",
              },
            ],
          },
        ],
      });
      const replayFrames = sseFrames(replay.text);
      const reply = assistantText(replayFrames).trim();
      const replayCompleted = replayFrames.some(
        (frame) => frame.type === "response.completed",
      );
      console.log(
        `replay: HTTP ${replay.status}, completed=${replayCompleted}, replyChars=${reply.length}, kept41=${reply.includes("41")}`,
      );
      if (replay.status !== 200) {
        failures.push(`${selector}: replay HTTP ${replay.status}`);
        console.log(replay.text.slice(0, 400));
      }
      if (!replayCompleted || reply.length === 0) {
        failures.push(`${selector}: replay produced no completed text`);
      }
      const replayExchanges = capture.exchanges.slice(replayStart);
      for (const exchange of replayExchanges) {
        console.log(`upstream(replay) url=${exchange.url}`);
      }
      console.log(
        `upstream(replay): requests=${replayExchanges.length}, envelopeDecoded=${replayExchanges.every(
          (exchange) => !exchange.body.includes(TOKEN_COMPACTION_PREFIX),
        )}`,
      );
      for (const exchange of replayExchanges) {
        if (exchange.body.includes(TOKEN_COMPACTION_PREFIX)) {
          failures.push(
            `${selector}: Token envelope was forwarded to the upstream`,
          );
        }
      }
      console.log("");
    }
  } finally {
    if (server !== undefined) await server.close();
    if (composition !== undefined) await composition.close();
    await rm(directory, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    throw new Error(`Responses compaction online test failed (${failures.length})`);
  }
  console.log("PASS responses compaction online test");
}

void main().catch((error: unknown) => {
  const detail =
    error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Responses compaction online test failed\n${detail}\n`);
  process.exitCode = 1;
});
