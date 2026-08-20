import type { AuthResult, Model } from "@earendil-works/pi-ai";

import { appendEndpoint, applyHeaders, rewriteModelJson } from "./common.js";
import type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesOperation,
  ProviderResponsesSender,
} from "./contract.js";

function providerEnv(name: string, auth: AuthResult): string | undefined {
  return auth.env?.[name] || process.env[name] || undefined;
}

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

function resolveBaseUrl(model: Model<string>, auth: AuthResult): string {
  const configured =
    providerEnv("AZURE_OPENAI_BASE_URL", auth)?.trim() ||
    auth.auth.baseUrl?.trim() ||
    undefined;
  if (configured) return normalizeBaseUrl(configured);
  const resourceName = providerEnv("AZURE_OPENAI_RESOURCE_NAME", auth);
  if (resourceName) return `https://${resourceName}.openai.azure.com/openai/v1`;
  if (model.baseUrl) return normalizeBaseUrl(model.baseUrl);
  throw new Error(
    "Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or provide model.baseUrl.",
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
  const apiVersion = providerEnv("AZURE_OPENAI_API_VERSION", options.auth) || "v1";
  const deploymentName =
    parseDeploymentNameMap(
      providerEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options.auth),
    ).get(options.model.id) || options.model.id;

  return Object.freeze({
    supportsNativeCompact: true,
    async send(
      operation: ProviderResponsesOperation,
      rawBody: string,
      signal: AbortSignal,
    ): Promise<Response> {
      const rewritten = rewriteModelJson(rawBody, deploymentName);
      const headers = new Headers({
        accept: "application/json",
        "api-key": apiKey,
        "content-type": "application/json",
      });
      applyHeaders(headers, options.model.headers);
      applyHeaders(headers, options.auth.auth.headers);
      applyHeaders(headers, options.forwardedHeaders);
      headers.set("content-type", "application/json");

      const endpoint = operation === "compact" ? "/responses/compact" : "/responses";
      const url = new URL(appendEndpoint(baseUrl, endpoint));
      url.searchParams.set("api-version", apiVersion);
      return options.fetch(url, {
        method: "POST",
        headers,
        body: rewritten.text,
        signal,
      });
    },
  });
}
