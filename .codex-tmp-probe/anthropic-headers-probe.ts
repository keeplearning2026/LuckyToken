import {
  normalizeContext,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";

import { passthroughAnthropicRequest } from "../src/provider-native-anthropic/transport.js";

const CONTEXT = normalizeContext({ messages: [] });

function anthropicModel(): Model<string> {
  return {
    id: "claude-sonnet-4-5",
    name: "claude-sonnet-4-5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_000,
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

const body = JSON.stringify({
  model: "anthropic/claude-sonnet",
  max_tokens: 32,
  messages: [{ role: "user", content: "hi" }],
  stream: true,
});

let piRequest: Request | undefined;
const piFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  piRequest = new Request(input, init);
  return new Response('{"type":"message"}', { status: 200 });
}) as FetchFunction;
const piStream = streamAnthropicMessages(anthropicModel(), CONTEXT, {
  apiKey: "sk-ant-key",
  fetch: piFetch,
  maxRetries: 0,
  headers: { "x-provider-static": "provider-value" },
});
for await (const event of piStream) void event;
if (piRequest === undefined) throw new Error("Pi did not dispatch");
printHeaders("Pi semantic: anthropic-messages (Anthropic Node SDK)", piRequest);

let tokenRequest: Request | undefined;
const tokenFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  tokenRequest = new Request(input, init);
  return new Response('{"type":"message"}', { status: 200 });
}) as FetchFunction;
await passthroughAnthropicRequest({
  model: anthropicModel(),
  rawBody: body,
  apiKey: "sk-ant-key",
  signal: AbortSignal.timeout(5_000),
  fetch: tokenFetch,
  bodyProjectionMode: "rewrite-model",
  authMode: "api_key",
  attempt: 1,
  composedHeaders: { "x-provider-static": "provider-value" },
});
if (tokenRequest === undefined) throw new Error("Token did not dispatch");
printHeaders("Token provider-native: anthropic", tokenRequest);
