import type Anthropic from "@anthropic-ai/sdk";
import type { FetchFunction, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { createClient as createPiClient, getAnthropicCompat, getBetaFeatures } from "./pi-envelope.generated.js";
export { claudeCodeVersion as CLAUDE_CODE_VERSION } from "./pi-envelope.generated.js";

/** Credential branch the lane reconstructed the upstream envelope for. */
export type AnthropicNativeAuthMode =
  | "api_key"
  | "oauth"
  | "github_copilot"
  | "ambient";

function parsedBody(rawBody: string): Record<string, unknown> {
  const parsed = JSON.parse(rawBody) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Anthropic Native body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Pi's Copilot dynamic headers are derived from its `Context`; the
 * preservation lane has no `Context`, so the same facts are read from the
 * client-authored body (which the lane already owns for projection).
 */
function copilotDynamicHeaders(body: Record<string, unknown>): ProviderHeaders {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1);
  const lastRole =
    typeof last === "object" && last !== null && !Array.isArray(last)
      ? (last as Record<string, unknown>).role
      : undefined;
  const hasImage = messages.some((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return false;
    }
    const content = (message as Record<string, unknown>).content;
    return (
      Array.isArray(content) &&
      content.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          !Array.isArray(block) &&
          (block as Record<string, unknown>).type === "image",
      )
    );
  });
  return {
    "X-Initiator":
      lastRole !== undefined && lastRole !== "user" ? "agent" : "user",
    "Openai-Intent": "conversation-edits",
    ...(hasImage ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

export function anthropicBetaFeatures(
  model: Model<string>,
  body: Record<string, unknown>,
  authMode: AnthropicNativeAuthMode,
  composedHeaders: ProviderHeaders | undefined,
): string[] {
  const thinking = body.thinking;
  const thinkingEnabled = typeof thinking === "object" && thinking !== null && !Array.isArray(thinking) && (thinking as Record<string, unknown>).type === "enabled";
  return getBetaFeatures(
    model, Array.isArray(body.tools) && body.tools.length > 0, authMode === "oauth", false,
    { headers: composedHeaders, thinkingEnabled },
  ) as string[];
}

export interface AnthropicSdkRequestFacts {
  readonly model: Model<string>;
  readonly authMode: AnthropicNativeAuthMode;
  readonly apiKey: string | undefined;
  readonly sessionId: string | undefined;
  readonly composedHeaders: ProviderHeaders | undefined;
}

/**
 * Request params for the SDK call. The lane never builds headers by hand: it
 * hands the SDK the projected body plus the beta list, and the resource layer
 * turns `betas` into the `anthropic-beta` header and the `?beta=true` query
 * exactly as it does for Pi.
 */
export function anthropicRequestParams(
  facts: AnthropicSdkRequestFacts,
  rawBody: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const body = parsedBody(rawBody);
  const betas = anthropicBetaFeatures(
    facts.model,
    body,
    facts.authMode,
    facts.composedHeaders,
  );
  const params = { ...body } as Record<string, unknown>;
  // Pi owns the beta surface: a client-authored `betas` field must never
  // survive into the SDK's header conversion.
  delete params.betas;
  if (betas.length > 0) params.betas = betas;
  return params as unknown as Anthropic.MessageCreateParamsNonStreaming;
}

/**
 * Construct the SDK client exactly as pinned Pi's `createClient` does for the
 * captured credential branch, including the `defaultHeaders` merge order:
 * Pi user agent → branch identity/session headers → model headers → composed
 * Provider/auth headers.
 */
export function createAnthropicSdkClient(
  facts: AnthropicSdkRequestFacts,
  rawBody: string,
  fetch: FetchFunction,
): Anthropic {
  const body = parsedBody(rawBody);
  // Header-owned credentials may carry no apiKey. The installed Pi adapter dispatches
  // explicit Authorization/X-Api-Key headers correctly, but its Cloudflare
  // cf-aig-authorization branch has a confirmed adapter gap: assertRequestAuth
  // accepts the credential, then Anthropic's SDK rejects the client before
  // fetch because neither x-api-key nor authorization is present. The lane
  // uses the SDK's explicit-omission escape hatch so the separately certified
  // Cloudflare Provider contract remains usable. A parity regression test
  // locks this one bounded exception and must turn red when pinned Pi starts
  // dispatching the same shape, at which point this workaround is removed.
  const omittedAuthHeaders: ProviderHeaders =
    facts.apiKey === undefined || facts.apiKey.length === 0
      ? { "x-api-key": null, authorization: null }
      : {};
  const result: { client: Anthropic; isOAuthToken: boolean } = createPiClient(
    facts.model, facts.apiKey, { ...omittedAuthHeaders, ...facts.composedHeaders }, fetch,
    facts.model.provider === "github-copilot" ? copilotDynamicHeaders(body) : undefined, facts.sessionId,
    facts.authMode === "oauth",
  );
  return result.client;
}

/** Whether the lane would send session-affinity headers for this model. */
export function anthropicSendsSessionAffinity(
  model: Model<string>,
  authMode: AnthropicNativeAuthMode,
): boolean {
  if (authMode === "oauth" || authMode === "github_copilot") return false;
  return getAnthropicCompat(model).sendSessionAffinityHeaders;
}
