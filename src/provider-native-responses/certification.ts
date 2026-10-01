import type { ProviderResponsesOperation } from "./contract.js";

export type ProviderResponsesTransportKind = "openai" | "codex" | "azure";
export type ProviderResponsesCertificationAuthType =
  | "managed"
  /** Codex-owned external `auth.json` source, consumed read-only with a
   * Codex-delegated in-place refresh. Certified for `openai-codex` only. */
  | "external"
  | "ambient";

/**
 * One certified Provider Native Responses tuple.
 *
 * `operations` is the closed set of operations this exact provider/api pair
 * may serve. `commandcode-goat` for example is certified for `responses` but
 * never for `compact`.
 */
export interface ProviderNativeResponsesCertification {
  readonly transport: ProviderResponsesTransportKind;
  readonly provider: string;
  readonly api: string;
  readonly operations: readonly ProviderResponsesOperation[];
  readonly authTypes: readonly ProviderResponsesCertificationAuthType[];
}

/**
 * Closed Provider Native Responses certification table.
 *
 * Routing (`index.ts`) and the certification tests both derive from this data,
 * so a tuple can never be routed without being certified, or certified without
 * being routable. Entries are explicit literals: adding a provider is a
 * reviewed contract change, not a configuration value.
 *
 * There is deliberately no runtime registration entry point — Provider
 * Packages cannot claim a native lane.
 */
export const PROVIDER_NATIVE_RESPONSES_CERTIFIED: readonly ProviderNativeResponsesCertification[] =
  Object.freeze([
    {
      transport: "openai",
      provider: "openai",
      api: "openai-responses",
      operations: ["responses", "compact"],
      authTypes: ["managed", "ambient"],
    },
    {
      transport: "openai",
      provider: "xai",
      api: "openai-responses",
      operations: ["responses", "compact"],
      authTypes: ["managed", "ambient"],
    },
    {
      transport: "openai",
      provider: "opencode",
      api: "openai-responses",
      operations: ["responses", "compact"],
      authTypes: ["managed", "ambient"],
    },
    {
      transport: "openai",
      provider: "opencode-go",
      api: "openai-responses",
      operations: ["responses", "compact"],
      authTypes: ["managed", "ambient"],
    },
    {
      transport: "openai",
      provider: "cloudflare-ai-gateway",
      api: "openai-responses",
      operations: ["responses", "compact"],
      authTypes: ["managed", "ambient"],
    },
    {
      transport: "openai",
      provider: "github-copilot",
      api: "openai-responses",
      operations: ["responses", "compact"],
      authTypes: ["managed", "ambient"],
    },
    {
      transport: "openai",
      provider: "commandcode-goat",
      api: "openai-responses",
      operations: ["responses"],
      authTypes: ["managed", "ambient"],
    },
    {
      transport: "codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      operations: ["responses", "compact"],
      authTypes: ["managed", "external"],
    },
    {
      transport: "azure",
      provider: "azure-openai-responses",
      api: "azure-openai-responses",
      operations: ["responses", "compact"],
      authTypes: ["managed", "ambient"],
    },
  ]);

/**
 * The transport that serves `model`, ignoring the operation. `undefined` means
 * the tuple stays in Semantic Conversion.
 */
export function certifiedResponsesTransport(
  provider: string,
  api: string,
): ProviderResponsesTransportKind | undefined {
  return PROVIDER_NATIVE_RESPONSES_CERTIFIED.find(
    (entry) => entry.provider === provider && entry.api === api,
  )?.transport;
}

/** Whether the certified tuple also covers `operation`. */
export function certifiedResponsesOperation(
  provider: string,
  api: string,
  operation: ProviderResponsesOperation,
): boolean {
  return PROVIDER_NATIVE_RESPONSES_CERTIFIED.some(
    (entry) =>
      entry.provider === provider &&
      entry.api === api &&
      entry.operations.includes(operation),
  );
}

/** Every provider id certified for at least one native Responses operation. */
export function certifiedResponsesProviders(): readonly string[] {
  return PROVIDER_NATIVE_RESPONSES_CERTIFIED.map((entry) => entry.provider);
}
