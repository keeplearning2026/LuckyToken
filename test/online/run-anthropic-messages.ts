/**
 * Mechanism-only harness for direct Anthropic Messages online certification.
 *
 * Provider entry points own request cases, semantic expectations, Provider-wire
 * assertions, reports, and exit status. This file owns only disposable setup,
 * authentication, local HTTP transport, upstream capture, SSE parsing, and cleanup.
 */
import type {
  AuthInteraction,
  AuthPrompt,
  FetchFunction,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { DEFAULT_MAX_REQUEST_BYTES } from "../../src/data-plane-limits.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";
import {
  createConfiguredLuckyTokenDataPlane,
  createConfiguredPiModels,
  type ConfiguredLuckyTokenDataPlane,
} from "../support/configured-data-plane.js";
import {
  createOnlinePublicModelAuthority,
  reconcileOnlinePublicModels,
} from "./public-model-fixture.js";
import { loginOnlineProvider } from "./provider-login.js";

const REQUEST_TIMEOUT_MS = 120_000;
const SUITE_TIMEOUT_MS = 20 * 60_000;

export interface AnthropicOnlineHarnessInput {
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyFile: string;
  readonly alias?: string;
}

export interface CapturedExchange {
  readonly url: string;
  readonly body: string;
}

export interface LocalHttpResult {
  readonly status: number;
  readonly text: string;
}

export interface LocalSseResult extends LocalHttpResult {
  readonly eventTypes: readonly string[];
  readonly visibleText: string;
}

export interface AnthropicOnlineHarness {
  readonly selector: string;
  readonly providerApi: string;
  readonly exchanges: readonly CapturedExchange[];
  postJson(body: Readonly<Record<string, unknown>>): Promise<LocalHttpResult>;
  postSse(body: Readonly<Record<string, unknown>>): Promise<LocalSseResult>;
  close(): Promise<void>;
}

export function isOnlineRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function aliasTargetFor(
  providerId: string,
  model: string,
): { readonly provider: string; readonly model: string } {
  const prefix = `${providerId}/`;
  return Object.freeze({
    provider: providerId,
    model: model.startsWith(prefix) ? model.slice(prefix.length) : model,
  });
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

function createCapturingFetch(base: FetchFunction): {
  readonly fetch: FetchFunction;
  readonly exchanges: CapturedExchange[];
} {
  const exchanges: CapturedExchange[] = [];
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

function parseSseWire(wire: string): {
  readonly eventTypes: readonly string[];
  readonly visibleText: string;
} {
  const eventTypes: string[] = [];
  let visibleText = "";
  for (const frame of wire.split("\n\n")) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine === undefined) continue;
    const event = JSON.parse(dataLine.slice(6)) as unknown;
    if (!isOnlineRecord(event)) continue;
    if (typeof event.type === "string") eventTypes.push(event.type);
    if (
      event.type === "content_block_delta" &&
      isOnlineRecord(event.delta) &&
      event.delta.type === "text_delta" &&
      typeof event.delta.text === "string"
    ) {
      visibleText += event.delta.text;
    }
  }
  return Object.freeze({
    eventTypes: Object.freeze(eventTypes),
    visibleText,
  });
}

export async function createAnthropicOnlineHarness(
  input: AnthropicOnlineHarnessInput,
): Promise<AnthropicOnlineHarness> {
  const selector = input.alias ?? input.model;
  const aliasTarget = aliasTargetFor(input.providerId, input.model);
  const apiKey = (await readFile(input.apiKeyFile, "utf8")).trim();
  if (apiKey.length === 0) throw new Error(`${input.apiKeyFile} is empty`);

  const totalSignal = AbortSignal.timeout(SUITE_TIMEOUT_MS);
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-anthropic-online-"));
  const originalFetch = globalThis.fetch;
  const capture = createCapturingFetch(originalFetch);
  globalThis.fetch = capture.fetch as typeof globalThis.fetch;
  let composition: ConfiguredLuckyTokenDataPlane | undefined;
  let server: Awaited<ReturnType<typeof startLuckyTokenHttpServer>> | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await server?.close();
    await composition?.close();
    if (globalThis.fetch === capture.fetch) globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  };

  try {
    const stateDirectory = join(directory, ".luckytoken");
    await mkdir(join(stateDirectory, "pi"), { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: "luckytoken-config-v2",
      server: { port: 0 },
      clientProtocols: { "anthropic-messages": {} },
      providerPackages: {},
      pi: { directory: "pi" },
      limits: {
        maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      },
    }), "utf8");
    const config = await loadLuckyTokenCliConfig(configPath);
    const credentialRecordStore = createInMemoryProviderCredentialRecordStore({
      createRevision: randomUUID,
    });
    const preLogin = await createConfiguredPiModels({
      piDirectory: config.pi.directory,
      ...(config.pi.modelsJson === undefined ? {} : { modelsJsonPath: config.pi.modelsJson }),
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
      displayName: "Anthropic online test",
      interaction: keyFileLoginInteraction(apiKey),
    });
    const publicModelAuthority = input.alias === undefined
      ? undefined
      : await createOnlinePublicModelAuthority({
          path: join(stateDirectory, "public-models.json"),
          endpoint: {
            host: "127.0.0.1",
            port: config.server.port > 0 ? config.server.port : 3000,
          },
          alias: input.alias,
          providerId: aliasTarget.provider,
          modelId: aliasTarget.model,
        });
    composition = await createConfiguredLuckyTokenDataPlane({
      config,
      credentialRecordStore,
      fetch: capture.fetch,
      ...(publicModelAuthority === undefined ? {} : { publicModelAuthority }),
    });
    if (publicModelAuthority !== undefined) {
      await reconcileOnlinePublicModels(
        publicModelAuthority,
        composition.catalog.models,
        input.providerId,
      );
    }
    const resolvedModel = composition.catalog.models.getModel(
      aliasTarget.provider,
      aliasTarget.model,
    );
    if (resolvedModel === undefined) {
      throw new Error("online_resolved_provider_model_missing");
    }
    const providerApi = resolvedModel.api;
    server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: config.server.port,
    });
    const origin = server.origin;

    const post = async (
      body: Readonly<Record<string, unknown>>,
    ): Promise<LocalHttpResult> => {
      const response = await fetch(`${origin}/v1/messages`, {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": "unused-local-client-key",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          totalSignal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
      return Object.freeze({
        status: response.status,
        text: await response.text(),
      });
    };

    return Object.freeze({
      selector,
      providerApi,
      exchanges: capture.exchanges,
      postJson: post,
      async postSse(body: Readonly<Record<string, unknown>>) {
        const response = await fetch(`${origin}/v1/messages`, {
          method: "POST",
          headers: {
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "x-api-key": "unused-local-client-key",
          },
          body: JSON.stringify({ ...body, stream: true }),
          signal: AbortSignal.any([
            totalSignal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ]),
        });
        const wire = await response.text();
        return Object.freeze({
          status: response.status,
          text: wire,
          ...parseSseWire(wire),
        });
      },
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
