import {
  normalizeContext,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { stream as streamAzureResponses } from "@earendil-works/pi-ai/api/azure-openai-responses";

import { createProviderResponsesSender } from "../src/provider-native-responses/index.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const CONTEXT = normalizeContext({ messages: [] });

function azureModel(): Model<string> {
  return {
    id: "gpt-5",
    name: "gpt-5",
    provider: "azure-openai-responses",
    api: "azure-openai-responses",
    baseUrl: "https://my-resource.openai.azure.com/openai/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    headers: { "x-provider-static": "provider-value" },
  };
}

function printHeaders(label: string, request: Request): void {
  const entries = [...request.headers.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  console.log(`\n=== ${label} ===`);
  console.log(`${request.method} ${request.url}`);
  for (const [name, value] of entries) {
    console.log(
      `${name}: ${
        name === "authorization" || name === "api-key" || name === "x-api-key"
          ? "<redacted>"
          : value
      }`,
    );
  }
}

const model = azureModel();

let piRequest: Request | undefined;
const piFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  piRequest = new Request(input, init);
  return new Response('{"status":"completed"}', { status: 200 });
}) as FetchFunction;
const piStream = streamAzureResponses(model, CONTEXT, {
  apiKey: "azure-key",
  fetch: piFetch,
  sessionId: SESSION_ID,
  maxRetries: 0,
});
for await (const event of piStream) void event;
if (piRequest === undefined) throw new Error("Pi did not dispatch");
printHeaders("Pi semantic: azure-openai-responses (AzureOpenAI SDK)", piRequest);

let tokenRequest: Request | undefined;
const tokenFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  tokenRequest = new Request(input, init);
  return new Response('{"status":"completed"}', { status: 200 });
}) as FetchFunction;
const sender = createProviderResponsesSender({
  model,
  auth: { auth: { apiKey: "azure-key" } },
  fetch: tokenFetch,
  sessionId: SESSION_ID,
});
await sender!.send(
  "responses",
  JSON.stringify({ model: model.id, input: "hello", stream: true }),
  AbortSignal.timeout(5_000),
);
if (tokenRequest === undefined) throw new Error("Token did not dispatch");
printHeaders("Token provider-native: azure", tokenRequest);
