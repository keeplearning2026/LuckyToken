export type ReadonlyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJsonValue[]
  | ReadonlyJsonObject;

export interface ReadonlyJsonObject {
  readonly [key: string]: ReadonlyJsonValue;
}

export type AnthropicPresence<T> =
  | { readonly kind: "omitted" }
  | { readonly kind: "explicit-null" }
  | { readonly kind: "specified"; readonly value: T };

export type AnthropicToolChoice =
  | {
      readonly kind: "auto" | "any";
      readonly disableParallelToolUse: boolean;
    }
  | {
      readonly kind: "named";
      readonly name: string;
      readonly disableParallelToolUse: boolean;
    }
  | { readonly kind: "none" };
