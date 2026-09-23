/**
 * Mechanism-only harness for one OpenAI Responses online smoke request.
 *
 * Provider runners own Provider/model selection and all semantic/wire
 * expectations. This file only owns disposable startup, real Provider login,
 * local HTTP transport, upstream capture, response parsing, and cleanup.
 */
import type {
  AuthInteraction,
  AuthPrompt,
  FetchFunction,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { DEFAULT_MAX_REQUEST_BYTES } from "../../src/data-plane-limits.js";
import { startTokenHttpServer } from "../../src/server.js";
import {
  createConfiguredPiModels,
  createConfiguredTokenDataPlane,
  type ConfiguredTokenDataPlane,
} from "../support/configured-data-plane.js";
import { loginOnlineProvider } from "./provider-login.js";

const REQUEST_TIMEOUT_MS = 90_000;

export interface ResponsesSmokeHarnessInput {
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyFile: string;
}

export interface CapturedResponsesExchange {
  readonly url: string;
  readonly body: string;
}

export interface ResponsesSmokeResult {
  readonly status: number;
  readonly text: string;
  readonly json?: Readonly<Record<string, unknown>>;
}

export interface ResponsesSmokeHarness {
  readonly selector: string;
  readonly providerApi: string;
  readonly upstreamModelId: string;
  readonly exchanges: readonly CapturedResponsesExchange[];
  post(body: Readonly<Record<string, unknown>>): Promise<ResponsesSmokeResult>;
  close(): Promise<void>;
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyFileLoginInteraction(apiKey: string): AuthInteraction {
  return Object.freeze({
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type !== "secret" && prompt.type !== "text") {
        throw new Error(`Online login cannot answer ${prompt.type}`);
      }
      return apiKey;
    },
    notify: () => undefined,
  });
}

function modelIdFor(providerId: string, selector: string): string {
  const prefix = `${providerId}/`;
  return selector.startsWith(prefix) ? selector.slice(prefix.length) : selector;
}

function createCapturingFetch(base: FetchFunction): {
  readonly fetch: FetchFunction;
  readonly exchanges: CapturedResponsesExchange[];
} {
  const exchanges: CapturedResponsesExchange[] = [];
  return Object.freeze({
    exchanges,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const host = new URL(request.url).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") {
        exchanges.push(Object.freeze({
          url: request.url,
          body: await request.clone().text(),
        }));
      }
      return base(request);
    },
  });
}

export function responsesVisibleText(
  result: Readonly<Record<string, unknown>>,
): string {
  const output = result.output;
  if (!Array.isArray(output)) return "";
  let text = "";
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (
        isRecord(part) &&
        part.type === "output_text" &&
        typeof part.text === "string"
      ) {
        text += part.text;
      }
    }
  }
  return text;
}

export async function createResponsesSmokeHarness(
  input: ResponsesSmokeHarnessInput,
): Promise<ResponsesSmokeHarness> {
  const apiKey = (await readFile(input.apiKeyFile, "utf8")).trim();
  if (apiKey.length === 0) throw new Error(`${input.apiKeyFile} is empty`);

  const directory = await mkdtemp(join(tmpdir(), "Token-responses-smoke-"));
  const stateDirectory = join(directory, ".Token");
  const piDirectory = join(stateDirectory, "pi");
  const configPath = join(stateDirectory, "config.json");
  const credentialRecordStore = createInMemoryProviderCredentialRecordStore({
    createRevision: randomUUID,
  });
  const originalFetch = globalThis.fetch;
  const capture = createCapturingFetch(originalFetch);
  let composition: ConfiguredTokenDataPlane | undefined;
  let server: Awaited<ReturnType<typeof startTokenHttpServer>> | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await server?.close();
    await composition?.close();
    await rm(directory, { recursive: true, force: true });
  };

  try {
    await mkdir(piDirectory, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "token-config-v2",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
          "openai-responses": {
            stateFile: "state/openai-responses.json",
          },
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

    const preLogin = await createConfiguredPiModels({
      piDirectory: config.pi.directory,
      modelsJsonPath: config.pi.modelsJson,
      commandCodeModelsPath: join(
        dirname(config.configPath),
        "commandcode-models.json",
      ),
      providerPackages: config.providerPackages,
      fetch: capture.fetch,
      credentialRecordStore,
    });
    await loginOnlineProvider({
      models: preLogin.models,
      providerAuthBindings: preLogin.providerAuthBindings,
      credentialManagement: preLogin.credentialManagement,
      providerId: input.providerId,
      authType: "api_key",
      displayName: "Responses smoke",
      interaction: keyFileLoginInteraction(apiKey),
    });

    composition = await createConfiguredTokenDataPlane({
      config,
      credentialRecordStore,
      fetch: capture.fetch,
    });

    const upstreamModelId = modelIdFor(input.providerId, input.model);
    const resolved = composition.catalog.models.getModel(
      input.providerId,
      upstreamModelId,
    );
    if (resolved === undefined) {
      throw new Error(
        `Online model is unavailable: ${input.providerId}/${upstreamModelId}`,
      );
    }

    server = await startTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: config.server.port,
    });

    return Object.freeze({
      selector: input.model,
      providerApi: resolved.api,
      upstreamModelId: resolved.id,
      exchanges: capture.exchanges,
      async post(body: Readonly<Record<string, unknown>>) {
        const response = await fetch(`${server!.origin}/v1/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer unused-local-client-key",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        let json: Readonly<Record<string, unknown>> | undefined;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (isRecord(parsed)) json = parsed;
        } catch {
          // The Provider runner reports the raw body on failure.
        }
        return Object.freeze({
          status: response.status,
          text,
          ...(json === undefined ? {} : { json }),
        });
      },
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
