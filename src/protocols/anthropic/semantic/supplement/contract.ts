export type AnthropicPresence<T> =
  | { readonly kind: "omitted" }
  | { readonly kind: "explicit-null" }
  | { readonly kind: "specified"; readonly value: T };

export interface AnthropicCacheControl {
  readonly ttl?: "5m" | "1h";
}

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

export type AnthropicOutputFormat = {
  readonly kind: "json-schema";
  readonly schema: Readonly<Record<string, unknown>>;
};

export interface AnthropicContentSupplement {
  readonly sourceMessageIndex: number;
  readonly sourceContentIndex: number;
  readonly role: "user" | "assistant";
  readonly kind: string;
  readonly piRepresentation: "partial" | "none";
  readonly value: Readonly<Record<string, unknown>>;
}

export interface AnthropicToolSupplement {
  readonly sourceToolIndex: number;
  readonly name: string;
  readonly kind: "custom" | "server";
  readonly piRepresentation: "partial" | "none";
  readonly value: Readonly<Record<string, unknown>>;
}

export type AnthropicSystemSupplement =
  | { readonly kind: "string"; readonly value: string }
  | {
      readonly kind: "blocks";
      readonly blocks: readonly Readonly<Record<string, unknown>>[];
    };

export interface AnthropicMessageFrame {
  readonly sourceMessageIndex: number;
  readonly role: "user" | "assistant";
  readonly entries: readonly (
    | { readonly sourceContentIndex: number; readonly ownership: "pi" }
    | {
        readonly sourceContentIndex: number;
        readonly ownership: "supplement";
        readonly consumesPi: boolean;
        readonly value: Readonly<Record<string, unknown>>;
      }
  )[];
}

export interface AnthropicProjectionSupplement {
  /** Anthropic's total generated-token ceiling, including thinking tokens. */
  readonly outputTokenCeiling: number;
  readonly sampling: {
    readonly temperature?: number;
    readonly topP?: number;
    readonly topK?: number;
  };
  readonly stopSequences?: readonly string[];
  readonly toolChoice?: AnthropicToolChoice;
  readonly outputFormat: AnthropicPresence<AnthropicOutputFormat>;
  readonly metadataUserId: AnthropicPresence<string>;
  readonly serviceTier: AnthropicPresence<"auto" | "standard_only">;
  readonly inferenceGeo: AnthropicPresence<string>;
  readonly container: AnthropicPresence<string>;
  readonly cacheControl: AnthropicPresence<AnthropicCacheControl>;
  readonly system?: AnthropicSystemSupplement;
  readonly finalAssistantPrefill?: true;
  readonly messageFrames: readonly AnthropicMessageFrame[];
  readonly content: readonly AnthropicContentSupplement[];
  readonly tools: readonly AnthropicToolSupplement[];
}
