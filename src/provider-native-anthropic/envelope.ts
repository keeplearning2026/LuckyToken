import Anthropic from "@anthropic-ai/sdk";
import type { FetchFunction, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { arch, platform, release } from "node:os";

/** Credential branch the lane reconstructed the upstream envelope for. */
export type AnthropicNativeAuthMode =
  | "api_key"
  | "oauth"
  | "github_copilot"
  | "ambient";

/** Claude Code identity Pi's Anthropic adapter pins for the OAuth branch.
 *  Kept in sync with the pinned runtime by the SDK identity gate test. */
export const CLAUDE_CODE_VERSION = "2.1.251";
const FINE_GRAINED_TOOL_STREAMING_BETA =
  "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_OUTPUT_CONFIG_BETA =
  "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";

/** Pi's `getPiUserAgent()`. */
function piUserAgent(): string {
  return `pi (${platform()} ${release()}; ${arch()})`;
}

interface AnthropicNativeCompatFacts {
  readonly supportsEagerToolInputStreaming?: boolean;
  readonly forceAdaptiveThinking?: boolean;
  readonly sendSessionAffinityHeaders?: boolean;
  readonly sessionAffinityFormat?: "openrouter" | string;
  readonly allowedFallbackModels?: readonly string[];
  readonly supportsMidConvoEffort?: boolean;
}

function anthropicCompat(model: Model<string>): AnthropicNativeCompatFacts {
  return (
    model as unknown as { readonly compat?: AnthropicNativeCompatFacts }
  ).compat ?? {};
}

function isOpenRouterHosted(model: Model<string>): boolean {
  return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
}

/** Pinned Pi `getAnthropicCompat().sendSessionAffinityHeaders`. */
function sendsSessionAffinityHeaders(model: Model<string>): boolean {
  return (
    anthropicCompat(model).sendSessionAffinityHeaders ??
    isOpenRouterHosted(model)
  );
}

/** Pinned Pi `getAnthropicCompat().sessionAffinityFormat`. */
function sessionAffinityHeaderName(model: Model<string>): string {
  const format =
    anthropicCompat(model).sessionAffinityFormat ??
    (isOpenRouterHosted(model) ? "openrouter" : undefined);
  return format === "openrouter" ? "x-session-id" : "x-session-affinity";
}

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

function headerValue(
  sources: readonly (ProviderHeaders | undefined)[],
  name: string,
): string | null | undefined {
  let found: string | null | undefined;
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (key.toLowerCase() === name) found = value;
    }
  }
  return found;
}

/**
 * Pinned Pi `getBetaFeatures`, with the client-authored body standing in for
 * the facts Pi reads from its `Context`:
 *
 * - configured `anthropic-beta` (model or composed Provider headers) replaces
 *   the computed list entirely, and an explicit `null` means "no betas";
 * - OAuth adds the Claude Code beta pair;
 * - tool streaming and interleaved thinking are computed from the body;
 * - `allowedFallbackModels` and `supportsMidConvoEffort` come from the model's
 *   compatibility facts;
 * - the mid-conversation tool-changes beta needs Pi `Context` (initial tools
 *   and redefinitions), so the preservation lane does not reconstruct it —
 *   recorded as decision D2 in the plan.
 */
export function anthropicBetaFeatures(
  model: Model<string>,
  body: Record<string, unknown>,
  authMode: AnthropicNativeAuthMode,
  composedHeaders: ProviderHeaders | undefined,
): string[] {
  const configured = headerValue([model.headers, composedHeaders], "anthropic-beta");
  if (configured === null) return [];
  if (configured !== undefined) {
    return [
      ...new Set(
        configured
          .split(",")
          .map((feature) => feature.trim())
          .filter((feature) => feature.length > 0),
      ),
    ];
  }
  const compat = anthropicCompat(model);
  const features: string[] = [];
  if (authMode === "oauth") {
    features.push("claude-code-20250219", "oauth-2025-04-20");
  }
  if (
    Array.isArray(body.tools) &&
    body.tools.length > 0 &&
    compat.supportsEagerToolInputStreaming !== true
  ) {
    features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  const thinking = body.thinking;
  const thinkingEnabled =
    typeof thinking === "object" &&
    thinking !== null &&
    !Array.isArray(thinking) &&
    (thinking as Record<string, unknown>).type === "enabled";
  if (
    model.reasoning === true &&
    thinkingEnabled &&
    compat.forceAdaptiveThinking !== true
  ) {
    features.push(INTERLEAVED_THINKING_BETA);
  }
  if ((compat.allowedFallbackModels?.length ?? 0) > 0) {
    features.push(SERVER_SIDE_FALLBACK_BETA);
  }
  if (compat.supportsMidConvoEffort === true) {
    features.push(
      MID_CONVERSATION_OUTPUT_CONFIG_BETA,
      THINKING_BINDING_CONTROLS_BETA,
    );
  }
  return [...new Set(features)];
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
  const compat = anthropicCompat(facts.model);
  const body = parsedBody(rawBody);
  const base: ProviderHeaders = {
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const common = {
    baseURL: facts.model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch,
  } as const;

  if (facts.model.provider === "github-copilot") {
    return new Anthropic({
      ...common,
      apiKey: null,
      authToken: facts.apiKey ?? null,
      defaultHeaders: {
        "User-Agent": piUserAgent(),
        ...base,
        ...facts.model.headers,
        ...copilotDynamicHeaders(body),
        ...facts.composedHeaders,
      },
    });
  }
  if (facts.authMode === "oauth") {
    return new Anthropic({
      ...common,
      apiKey: null,
      authToken: facts.apiKey ?? null,
      defaultHeaders: {
        "User-Agent": piUserAgent(),
        ...base,
        "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
        "x-app": "cli",
        ...facts.model.headers,
        ...facts.composedHeaders,
      },
    });
  }
  const sessionAffinityHeaders: ProviderHeaders =
    facts.sessionId !== undefined &&
    (compat.sendSessionAffinityHeaders ?? isOpenRouterHosted(facts.model))
      ? { [sessionAffinityHeaderName(facts.model)]: facts.sessionId }
      : {};
  // Header-owned credentials may carry no apiKey. Pinned Pi 0.87 dispatches
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
  return new Anthropic({
    ...common,
    apiKey: facts.apiKey ?? null,
    authToken: null,
    defaultHeaders: {
      "User-Agent": piUserAgent(),
      ...base,
      ...sessionAffinityHeaders,
      ...facts.model.headers,
      ...omittedAuthHeaders,
      ...facts.composedHeaders,
    },
  });
}

/** Whether the lane would send session-affinity headers for this model. */
export function anthropicSendsSessionAffinity(
  model: Model<string>,
  authMode: AnthropicNativeAuthMode,
): boolean {
  if (authMode === "oauth" || authMode === "github_copilot") return false;
  return sendsSessionAffinityHeaders(model);
}
