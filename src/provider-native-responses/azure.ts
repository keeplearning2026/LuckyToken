import { createClient as createPiClient, resolveDeploymentName } from "./pi-azure.generated.js";
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

export function createAzureResponsesSender(
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender {
  const apiKey = options.auth.auth.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("No API key for provider: azure-openai-responses");
  }
  const model = { ...options.model, baseUrl: options.auth.auth.baseUrl ?? options.model.baseUrl };
  const piOptions = { env: options.auth.env, headers: options.auth.auth.headers };
  const deploymentName: string = resolveDeploymentName(model, piOptions);

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
        rewritten = projectProviderNativeBody(rawBody, deploymentName, operation, options.toolCallAdjacency);
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
            const client: AzureOpenAI = createPiClient(model, apiKey, { ...piOptions, fetch: fetchForSdk });
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
