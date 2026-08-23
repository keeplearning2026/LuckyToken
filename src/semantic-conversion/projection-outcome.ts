export type ProjectionOutcome =
  | { readonly kind: "pi-native" }
  | {
      readonly kind: "payload-projected";
      readonly projector: string;
      readonly warning?: "pi-native-mapping-repaired";
    }
  | { readonly kind: "content-fallback"; readonly reason: string }
  | { readonly kind: "omitted"; readonly warning: string }
  | { readonly kind: "failed"; readonly error: string };
