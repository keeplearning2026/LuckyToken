import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import {
  isManagedProviderAuthBindingCapture,
  MAX_PROFILE_ATTEMPTS_PER_REQUEST,
  type ProviderAuthBindingAuthority,
} from "../credentials/profile-contract.js";

import { renderResponsesError } from "../protocols/openai-responses/response.js";
import { createAzureResponsesSender } from "./azure.js";
import {
  bindProviderNativeResponsesConfiguration,
  parseProviderNativeResponsesConfiguration,
  type ProviderNativeResponsesConfiguration,
} from "./configuration.js";
import { createCodexResponsesSender } from "./codex.js";
import { ProviderResponsesNetworkError } from "./contract.js";
import type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesLane,
  ProviderResponsesSender,
} from "./contract.js";
import { createOpenAIResponsesSender } from "./openai.js";

export type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesLane,
  ProviderResponsesOperation,
  ProviderResponsesSender,
} from "./contract.js";

export interface CreateProviderNativeResponsesOptions {
  readonly models: Pick<Models, "getAuth">;
  readonly bindings: Pick<
    ProviderAuthBindingAuthority,
    "capture" | "runBound" | "advanceAfterFinal429"
  >;
  readonly fetch: FetchFunction;
  readonly configuration?: ProviderNativeResponsesConfiguration;
  readonly retryDependencies?: Partial<ProviderNativeResponsesRetryDependencies>;
}

export interface ProviderNativeResponsesRetryDependencies {
  readonly random: () => number;
  readonly now: () => number;
  readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, delayMs));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(response: Response, now: () => number): number | undefined {
  const raw = response.headers.get("retry-after-ms");
  if (raw !== null) {
    const value = Number.parseFloat(raw);
    if (!Number.isNaN(value)) return Math.max(0, value);
  }
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? 0 : Math.max(0, date - now());
}

function codexRetryAfterMs(response: Response, now: () => number): number | undefined {
  const raw = response.headers.get("retry-after-ms");
  if (raw !== null) {
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}

function openAIRetryDelayMs(
  response: Response | undefined,
  retryIndex: number,
  maxRetryDelayMs: number,
  random: () => number,
  now: () => number,
): number {
  const requested = response === undefined ? undefined : retryAfterMs(response, now);
  if (requested !== undefined) {
    if (maxRetryDelayMs > 0 && requested > maxRetryDelayMs) {
      throw new Error(
        `Server requested ${Math.ceil(requested / 1_000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1_000)}s)`,
      );
    }
    return requested;
  }
  const exponential = Math.min(0.5 * 2 ** retryIndex, 8) * 1_000;
  return exponential * (1 - random() * 0.25);
}

function shouldRetryOpenAIResponse(response: Response): boolean {
  const directive = response.headers.get("x-should-retry");
  if (directive === "true") return true;
  if (directive === "false") return false;
  return (
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500
  );
}

const TERMINAL_CODEX_RATE_LIMIT =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/iu;
const TRANSIENT_CODEX_ERROR =
  /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/iu;

async function shouldRetryCodexResponse(response: Response): Promise<boolean> {
  if (response.status === 429) {
    const errorText = await response.clone().text();
    return !TERMINAL_CODEX_RATE_LIMIT.test(errorText);
  }
  if ([500, 502, 503, 504].includes(response.status)) return true;
  return TRANSIENT_CODEX_ERROR.test(await response.clone().text());
}

async function releaseRetryResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A retry must not be replaced by a body-disposal failure.
  }
}

function validateRequestedRetryDelay(delayMs: number, maxRetryDelayMs: number): number {
  if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
    throw new Error(
      `Server requested ${Math.ceil(delayMs / 1_000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1_000)}s)`,
    );
  }
  return delayMs;
}

function codexRetryDelayMs(
  response: Response,
  retryIndex: number,
  maxRetryDelayMs: number,
  now: () => number,
): number {
  const requested = codexRetryAfterMs(response, now);
  return requested === undefined
    ? 1_000 * 2 ** retryIndex
    : validateRequestedRetryDelay(requested, maxRetryDelayMs);
}

function errorResponse(status: number, type: string, message: string): Response {
  const prepared = renderResponsesError(status, type, message);
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

type ProviderResponsesTransportKind = "openai" | "codex" | "azure";

const CERTIFIED_OPENAI_RESPONSES_PROVIDERS = new Set([
  "openai",
  "xai",
  "opencode",
  "opencode-go",
  "cloudflare-ai-gateway",
  "github-copilot",
]);

function providerResponsesTransportKind(
  model: Model<string>,
): ProviderResponsesTransportKind | undefined {
  if (
    model.api === "openai-responses" &&
    CERTIFIED_OPENAI_RESPONSES_PROVIDERS.has(model.provider)
  ) {
    return "openai";
  }
  if (
    model.provider === "openai-codex" &&
    model.api === "openai-codex-responses"
  ) {
    return "codex";
  }
  if (
    model.provider === "azure-openai-responses" &&
    model.api === "azure-openai-responses"
  ) {
    return "azure";
  }
  return undefined;
}

export function supportsProviderNativeResponses(model: Model<string>): boolean {
  return providerResponsesTransportKind(model) !== undefined;
}

function createProviderResponsesSenderForTransport(
  transport: ProviderResponsesTransportKind,
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender {
  switch (transport) {
    case "openai":
      return createOpenAIResponsesSender(options);
    case "codex":
      return createCodexResponsesSender(options);
    case "azure":
      return createAzureResponsesSender(options);
  }
}

export function createProviderResponsesSender(
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender | undefined {
  const transport = providerResponsesTransportKind(options.model);
  return transport === undefined
    ? undefined
    : createProviderResponsesSenderForTransport(transport, options);
}

export function createProviderNativeResponses(
  options: CreateProviderNativeResponsesOptions,
): ProviderResponsesLane {
  const configuration = options.configuration === undefined
    ? parseProviderNativeResponsesConfiguration()
    : bindProviderNativeResponsesConfiguration(options.configuration);
  const retryDependencies: ProviderNativeResponsesRetryDependencies = {
    random: options.retryDependencies?.random ?? Math.random,
    now: options.retryDependencies?.now ?? Date.now,
    sleep: options.retryDependencies?.sleep ?? defaultSleep,
  };
  return Object.freeze({
    claims(model: Model<string>): boolean {
      return supportsProviderNativeResponses(model);
    },
    async execute(
      input: Parameters<ProviderResponsesLane["execute"]>[0],
    ): Promise<Response> {
      let capture = await options.bindings.capture(input.model.provider);
      const attemptedCredentialIds: string[] = [];
      let profileAttempt = 1;
      let selectionReason: "active" | "http_429_switch" = "active";
      if (capture.facts.kind === "managed") {
        input.credentialActivity?.credentialCaptured({
          ...capture.facts,
          lane: "provider_native",
          selectionReason,
        });
      }
      for (;;) {
      let response: Response;
      try {
      response = await options.bindings.runBound(capture, async () => {
      const auth = await options.models.getAuth(input.model);
      if (auth === undefined) {
        return errorResponse(502, "api_error", "Provider is not configured");
      }
      const transport = providerResponsesTransportKind(input.model);
      if (transport === undefined) {
        return errorResponse(502, "api_error", "Provider native transport is unavailable");
      }
      const sender = createProviderResponsesSenderForTransport(transport, {
        model: input.model,
        auth,
        fetch: options.fetch,
        ...(input.operation === "responses" ? { sessionId: input.sessionId } : {}),
      });
      const isCodex = transport === "codex";
      try {
        for (let attempt = 0; ; attempt += 1) {
          let response: Response;
          try {
            response = await sender.send(
              input.operation,
              input.rawBody,
              input.signal,
            );
          } catch (error) {
            if (input.signal.aborted) throw error;
            if (
              !(error instanceof ProviderResponsesNetworkError) ||
              input.operation !== "responses" ||
              attempt >= configuration.transport.maxRetries
            ) {
              throw error;
            }
            await retryDependencies.sleep(
              isCodex
                ? 1_000 * 2 ** attempt
                : openAIRetryDelayMs(
                    undefined,
                    attempt,
                    configuration.transport.maxRetryDelayMs,
                    retryDependencies.random,
                    retryDependencies.now,
                  ),
              input.signal,
            );
            continue;
          }
          if (
            response.ok ||
            input.operation !== "responses" ||
            attempt >= configuration.transport.maxRetries
          ) {
            return response;
          }
          let retryable: boolean;
          try {
            retryable = isCodex
              ? await shouldRetryCodexResponse(response)
              : shouldRetryOpenAIResponse(response);
          } catch (error) {
            if (!isCodex || input.signal.aborted) throw error;
            await releaseRetryResponse(response);
            await retryDependencies.sleep(1_000 * 2 ** attempt, input.signal);
            continue;
          }
          if (!retryable) return response;
          await releaseRetryResponse(response);
          const delayMs = isCodex
            ? codexRetryDelayMs(
                response,
                attempt,
                configuration.transport.maxRetryDelayMs,
                retryDependencies.now,
              )
            : openAIRetryDelayMs(
                response,
                attempt,
                configuration.transport.maxRetryDelayMs,
                retryDependencies.random,
                retryDependencies.now,
              );
          await retryDependencies.sleep(delayMs, input.signal);
        }
      } catch (error) {
        if (input.signal.aborted) throw error;
        return errorResponse(502, "api_error", "Upstream provider request failed");
      }
      });
      } catch (error) {
        if (capture.facts.kind === "managed") {
          input.credentialActivity?.credentialAttempt({
            ...capture.facts,
            lane: "provider_native",
            selectionReason,
            attempt: profileAttempt,
            outcome: input.signal.aborted ? "aborted" : "failed",
          });
        }
        throw error;
      }
      if (capture.facts.kind === "managed") {
        input.credentialActivity?.credentialAttempt({
          ...capture.facts,
          lane: "provider_native",
          selectionReason,
          attempt: profileAttempt,
          outcome: response.status === 429
            ? "http_429"
            : response.ok
              ? "success"
              : "failed",
        });
      }
      if (response.status !== 429) return response;
      if (!isManagedProviderAuthBindingCapture(capture)) return response;
      attemptedCredentialIds.push(capture.facts.credentialId);
      if (profileAttempt >= MAX_PROFILE_ATTEMPTS_PER_REQUEST) return response;
      const requestedDelay = retryAfterMs(response, retryDependencies.now);
      const transition = await options.bindings.advanceAfterFinal429({
        capture,
        attemptedCredentialIds,
        signal: input.signal,
        ...(requestedDelay === undefined ? {} : { retryAfterMs: requestedDelay }),
      });
      if (transition.outcome !== "switched") return response;
      await releaseRetryResponse(response);
      capture = transition.capture;
      profileAttempt += 1;
      selectionReason = "http_429_switch";
      }
    },
  });
}
