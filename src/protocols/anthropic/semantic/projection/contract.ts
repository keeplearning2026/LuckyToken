export type AnthropicProjectionDisposition =
  | { readonly kind: "pi-native" }
  | {
      readonly kind: "payload-projected";
      readonly projector: string;
      readonly warning?: "pi-native-mapping-repaired";
    }
  | { readonly kind: "omitted"; readonly warning: string }
  | { readonly kind: "failed"; readonly error: string };

export interface AnthropicProjectionOutcome {
  readonly control: string;
  readonly outcome: AnthropicProjectionDisposition;
}
