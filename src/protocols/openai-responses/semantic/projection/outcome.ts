export type ResponsesProjectionOutcome =
  | { readonly kind: "pi-native" }
  | {
      readonly kind: "payload-projected";
      readonly projector: string;
      readonly warning?: "pi-native-mapping-repaired";
    }
  | { readonly kind: "content-fallback"; readonly reason: string }
  | {
      readonly kind: "degraded";
      readonly projector: string;
      readonly fallback:
        | "cache-retention-24h-to-1h"
        | "cache-retention-in-memory-to-provider-ephemeral"
        | "reasoning-effort-nearest-level"
        | "reasoning-disable-to-provider-default"
        | "reasoning-to-provider-default"
        | "reasoning-to-binary-enable"
        | "reasoning-to-ordinary-generation";
      readonly warning: string;
    }
  | { readonly kind: "omitted"; readonly warning: string }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Supplement facts are availability-first candidates. A target's inability to
 * express one is observable degradation, never a projection rejection.
 */
export type ResponsesSupplementProjectionOutcome = Exclude<
  ResponsesProjectionOutcome,
  { readonly kind: "failed" }
>;
