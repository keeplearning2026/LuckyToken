import type { AuthResult, Model } from "@earendil-works/pi-ai";
import { getPiUserAgent } from "@earendil-works/pi-ai/utils/pi-user-agent";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import { AzureOpenAI } from "openai";

import { publishSafeHttpEnvelopeArtifact } from "../diagnostics/http-envelope.js";
import type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesOperation,
  ProviderResponsesSender,
} from "./contract.js";
import { ProviderResponsesNetworkError } from "./contract.js";
import {
  completeProviderResponsesStep,
  enterProviderResponsesStep,
  observeProviderResponsesBodyProjection,
} from "./observation.js";
import { runShieldedSdkRequest } from "./sdk-dispatch.js";
import {
  projectProviderNativeBody,
  type ProviderNativeBodyProjection,
} from "./tool-call-adjacency.js";

const DEFAULT_AZURE_API_VERSION = "v1";

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!value) return map;
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [modelId, deploymentName] = trimmed.split("=", 2);
    if (!modelId || !deploymentName) continue;
    map.set(modelId.trim(), deploymentName.trim());
  }
  return map;
}

/** Pinned Pi `normalizeAzureBaseUrl`. */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
  }
  const isAzureHost =
    url.hostname.endsWith(".openai.azure.com") ||
    url.hostname.endsWith(".cognitiveservices.azure.com") ||
    url.hostname.endsWith(".ai.azure.com");
  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  if (
    isAzureHost &&
    (normalizedPath === "" ||
      normalizedPath === "/" ||
      normalizedPath === "/openai" ||
      normalizedPath === "/openai/v1/responses")
  ) {
    url.pathname = "/openai/v1";
    url.search = "";
  }
  return url.toString().replace(/\/+$/u, "");
}

/** Pinned Pi `resolveAzureConfig`. */
function resolveBaseUrl(model: Model<string>, auth: AuthResult): string {
  const configured =
    getProviderEnvValue("AZURE_OPENAI_BASE_URL", auth.env)?.trim() ||
    auth.auth.baseUrl?.trim() ||
    undefined;
  if (configured) return normalizeBaseUrl(configured);
  const resourceName = getProviderEnvValue("AZURE_OPENAI_RESOURCE_NAME", auth.env);
  if (resourceName) return `https://${resourceName}.openai.azure.com/openai/v1`;
  if (model.baseUrl) return normalizeBaseUrl(model.baseUrl);
  throw new Error(
    "Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or provide model.baseUrl.",
  );
}

function resolveApiVersion(auth: AuthResult): string {
  return (
    getProviderEnvValue("AZURE_OPENAI_API_VERSION", auth.env) || DEFAULT_AZURE_API_VERSION
  );
}

function resolveDeploymentName(model: Model<string>, auth: AuthResult): string {
  return (
    parseDeploymentNameMap(
      getProviderEnvValue("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", auth.env),
    ).get(model.id) || model.id
  );
}

export function createAzureResponsesSender(
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender {
  const apiKey = options.auth.auth.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("No API key for provider: azure-openai-responses");
  }
  const baseUrl = resolveBaseUrl(options.model, options.auth);
  const apiVersion = resolveApiVersion(options.auth);
  const deploymentName = resolveDeploymentName(options.model, options.auth);
  const defaultHeaders = {
    "User-Agent": getPiUserAgent(),
    ...options.model.headers,
    ...options.auth.auth.headers,
  };

  return Object.freeze({
    supportsNativeCompact: true,
    async send(
      operation: ProviderResponsesOperation,
      rawBody: string,
      signal: AbortSignal,
      observation?: Parameters<ProviderResponsesSender["send"]>[3],
    ): Promise<Response> {
      const attempt = observation?.attempt ?? 1;
      const projectionLocation = {
        phase: "lane_request_preparation",
        lane: "provider_native",
        step: "project_native_body",
        attempt,
      } as const;
      const projectionStep = `p3.project_native_body.${attempt}`;
      enterProviderResponsesStep(
        observation?.journey,
        projectionStep,
        projectionLocation,
      );
      let rewritten: ProviderNativeBodyProjection;
      try {
        rewritten = projectProviderNativeBody(rawBody, deploymentName, operation);
        observeProviderResponsesBodyProjection(
          observation?.journey,
          rewritten,
          projectionLocation,
        );
        completeProviderResponsesStep(
          observation?.journey,
          projectionStep,
          projectionLocation,
          "success",
        );
      } catch (error) {
        completeProviderResponsesStep(
          observation?.journey,
          projectionStep,
          projectionLocation,
          "failed",
        );
        throw error;
      }

      const envelopeLocation = {
        phase: "lane_request_preparation",
        lane: "provider_native",
        step: "reconstruct_provider_envelope",
        attempt,
      } as const;
      const envelopeStep = `p3.reconstruct_provider_envelope.${attempt}`;
      enterProviderResponsesStep(
        observation?.journey,
        envelopeStep,
        envelopeLocation,
      );
      const params = rewritten.parsed;
      completeProviderResponsesStep(
        observation?.journey,
        envelopeStep,
        envelopeLocation,
        "success",
      );

      const dispatchLocation = {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "dispatch_provider_native",
        attempt,
      } as const;
      const dispatchStep = `p4.dispatch_provider_native.${attempt}`;
      enterProviderResponsesStep(
        observation?.journey,
        dispatchStep,
        dispatchLocation,
      );

      let response: Response;
      try {
        response = await runShieldedSdkRequest(
          {
            fetch: options.fetch,
            signal,
            onRequest: (url, init) => {
              if (observation === undefined) return;
              publishSafeHttpEnvelopeArtifact(observation.journey, {
                artifactId: `provider_native_outbound_request_envelope.${attempt}`,
                artifactKind: "provider_native_outbound_request_envelope",
                method: init.method ?? "POST",
                url,
                headers: new Headers(init.headers),
                location: envelopeLocation,
              });
            },
          },
          async (fetchForSdk) => {
            const client = new AzureOpenAI({
              apiKey,
              apiVersion,
              dangerouslyAllowBrowser: true,
              fetch: fetchForSdk,
              defaultHeaders,
              baseURL: baseUrl,
            });
            const requestOptions = {
              signal,
              maxRetries: 0,
              ...(options.requestTimeoutMs === undefined
                ? {}
                : { timeout: options.requestTimeoutMs }),
            };
            if (operation === "compact") {
              await client.responses.compact(
                params as unknown as Parameters<
                  typeof client.responses.compact
                >[0],
                requestOptions,
              );
            } else {
              await client.responses.create(params, requestOptions);
            }
          },
        );
      } catch (error) {
        completeProviderResponsesStep(
          observation?.journey,
          dispatchStep,
          dispatchLocation,
          signal.aborted ? "aborted" : "failed",
        );
        throw error instanceof AzureOpenAI.APIConnectionError
          ? new ProviderResponsesNetworkError(error)
          : error;
      }
      publishSafeHttpEnvelopeArtifact(observation?.journey, {
        artifactId: `provider_native_upstream_response_envelope.${attempt}`,
        artifactKind: "provider_native_upstream_response_envelope",
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        location: dispatchLocation,
      });
      completeProviderResponsesStep(
        observation?.journey,
        dispatchStep,
        dispatchLocation,
        "success",
      );
      return response;
    },
  });
}
