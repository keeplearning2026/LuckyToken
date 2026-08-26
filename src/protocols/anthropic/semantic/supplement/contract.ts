declare const anthropicCandidateIdBrand: unique symbol;

export type AnthropicKnownCandidateId =
  | "maxTokens"
  | "sampling.temperature"
  | "sampling.topP"
  | "sampling.topK"
  | "stopSequences"
  | "toolChoice"
  | "outputFormat"
  | "metadataUserId"
  | "serviceTier"
  | "inferenceGeo"
  | "container"
  | "finalAssistantPrefill"
  | "cacheControl";

export type AnthropicCandidateId =
  | AnthropicKnownCandidateId
  | (string & { readonly [anthropicCandidateIdBrand]: true });

export function anthropicCandidateId(value: string): AnthropicCandidateId {
  return value as AnthropicCandidateId;
}

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
  readonly schema: ReadonlyJsonObject;
};

export type AnthropicSourceAttachment =
  | { readonly kind: "request"; readonly path: string }
  | { readonly kind: "system-block"; readonly blockIndex: number }
  | {
      readonly kind: "message-content";
      readonly messageIndex: number;
      readonly contentIndex: number;
      /** Source-semantic path from the owning message block to a nested block. */
      readonly nestedPath?: readonly (string | number)[];
    }
  | { readonly kind: "tool-definition"; readonly toolIndex: number };

export type AnthropicPiAttachment =
  | {
      readonly kind: "message-content";
      readonly messageIndex: number;
      readonly contentIndex: number;
    }
  | { readonly kind: "tool-call"; readonly callId: string }
  | { readonly kind: "tool-result"; readonly callId: string }
  | { readonly kind: "tool-definition"; readonly toolName: string };

export interface AnthropicCandidateBase {
  readonly id: AnthropicCandidateId;
  readonly source: AnthropicSourceAttachment;
  readonly piAttachment?: AnthropicPiAttachment;
}

export type AnthropicControlWriter =
  | "pi-verifier"
  | "ceiling-verifier"
  | "pi-first-projector"
  | "target-projector";

export interface AnthropicControlCandidate<T, K extends string>
  extends AnthropicCandidateBase {
  readonly kind: K;
  readonly writer: AnthropicControlWriter;
  readonly value: T;
}

export type AnthropicCeilingVerificationCandidate = AnthropicControlCandidate<
  number,
  "output-token-ceiling"
> & { readonly writer: "ceiling-verifier" };

export type AnthropicPiVerificationCandidate<T> = AnthropicControlCandidate<
  T,
  "pi-verification"
> & { readonly writer: "pi-verifier" };

export type AnthropicPiFirstProjectionCandidate<T> = AnthropicControlCandidate<
  T,
  "pi-first-projection"
> & { readonly writer: "pi-first-projector" };

export type AnthropicProjectionCandidate<T> = AnthropicControlCandidate<
  T,
  "target-projection"
> & { readonly writer: "target-projector" };

export type AnthropicToolChoiceCandidate = AnthropicControlCandidate<
  AnthropicToolChoice,
  "tool-choice"
> & { readonly writer: "target-projector" };

export interface AnthropicControlCandidates {
  readonly outputTokenCeiling: AnthropicCeilingVerificationCandidate;
  readonly temperature?: AnthropicPiVerificationCandidate<number>;
  readonly topP?: AnthropicPiFirstProjectionCandidate<number>;
  readonly topK?: AnthropicPiFirstProjectionCandidate<number>;
  readonly stopSequences?: AnthropicProjectionCandidate<readonly string[]>;
  readonly toolChoice?: AnthropicToolChoiceCandidate;
  readonly outputFormat?: AnthropicProjectionCandidate<AnthropicOutputFormat | null>;
  readonly metadataUserId?: AnthropicPiFirstProjectionCandidate<string | null>;
  readonly serviceTier?: AnthropicProjectionCandidate<"auto" | "standard_only" | null>;
  readonly inferenceGeo?: AnthropicProjectionCandidate<string | null>;
  readonly container?: AnthropicProjectionCandidate<string | null>;
  readonly finalAssistantPrefill?: AnthropicProjectionCandidate<true>;
}

export interface AnthropicStructuredSystemCandidate extends AnthropicCandidateBase {
  readonly kind: "structured-system-block";
  readonly blockIndex: number;
  readonly value: ReadonlyJsonObject;
}

export type AnthropicSystemCandidate = AnthropicStructuredSystemCandidate;

interface AnthropicContentCandidateBase extends AnthropicCandidateBase {
  readonly sourceMessageIndex: number;
  readonly sourceContentIndex: number;
  readonly effectiveRole: "user" | "assistant";
  readonly piRepresentation: "partial" | "none";
}

export interface AnthropicTextCitationsCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "text-citations";
  readonly piRepresentation: "partial";
  readonly value: readonly ReadonlyJsonObject[] | null;
}

export interface AnthropicUrlImageSourceCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "url-image-source";
  readonly piRepresentation: "none";
  readonly value: { readonly type: "url"; readonly url: string };
}

export interface AnthropicDocumentSourceCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "document-source";
  readonly value: ReadonlyJsonObject;
}

export interface AnthropicDocumentMetadataCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "document-metadata";
  readonly piRepresentation: "none";
  readonly value: {
    readonly citations?: ReadonlyJsonObject | null;
    readonly context?: string | null;
    readonly title?: string | null;
  };
}

export interface AnthropicSearchResultCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "search-result";
  readonly piRepresentation: "partial";
  readonly value: ReadonlyJsonObject;
}

export type AnthropicCaller =
  | { readonly type: "direct" }
  | {
      readonly type: "code_execution_20250825" | "code_execution_20260120";
      readonly tool_id: string;
    };

export interface AnthropicClientToolUseCallerCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "client-tool-use-caller";
  readonly piRepresentation: "partial";
  readonly value: AnthropicCaller;
}

export interface AnthropicRichClientToolResultCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "rich-client-tool-result";
  readonly piRepresentation: "partial";
  readonly value: {
    readonly contentLength: number;
    readonly blocks: readonly {
      readonly contentIndex: number;
      /** Number of Pi ToolResult content items emitted for this source block. */
      readonly piContentCount: 0 | 1;
      readonly value: ReadonlyJsonObject;
    }[];
  };
}

export interface AnthropicToolReferenceCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "tool-reference";
  readonly piRepresentation: "partial";
  readonly value: {
    readonly contentIndex: number;
    readonly contentLength: number;
    readonly toolName: string;
  };
}

export interface AnthropicServerToolUseCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "server-tool-use";
  readonly piRepresentation: "none";
  readonly value: ReadonlyJsonObject;
}

export interface AnthropicServerToolResultCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "server-tool-result";
  readonly piRepresentation: "none";
  readonly value: ReadonlyJsonObject;
}

export interface AnthropicContainerUploadCandidate
  extends AnthropicContentCandidateBase {
  readonly kind: "container-upload";
  readonly piRepresentation: "none";
  readonly value: { readonly fileId: string };
}

export type AnthropicContentCandidate =
  | AnthropicTextCitationsCandidate
  | AnthropicUrlImageSourceCandidate
  | AnthropicDocumentSourceCandidate
  | AnthropicDocumentMetadataCandidate
  | AnthropicSearchResultCandidate
  | AnthropicClientToolUseCallerCandidate
  | AnthropicRichClientToolResultCandidate
  | AnthropicToolReferenceCandidate
  | AnthropicServerToolUseCandidate
  | AnthropicServerToolResultCandidate
  | AnthropicContainerUploadCandidate;

interface AnthropicToolCandidateBase extends AnthropicCandidateBase {
  readonly sourceToolIndex: number;
  readonly name: string;
}

export interface AnthropicCustomToolCallerPolicyCandidate
  extends AnthropicToolCandidateBase {
  readonly kind: "custom-tool-caller-policy";
  readonly toolKind: "custom";
  readonly piRepresentation: "partial";
  readonly value: readonly (
    | "direct"
    | "code_execution_20250825"
    | "code_execution_20260120"
  )[];
}

export interface AnthropicCustomToolDeferredLoadingCandidate
  extends AnthropicToolCandidateBase {
  readonly kind: "custom-tool-deferred-loading";
  readonly toolKind: "custom";
  readonly piRepresentation: "partial";
  readonly value: boolean;
}

export interface AnthropicCustomToolInputStreamingCandidate
  extends AnthropicToolCandidateBase {
  readonly kind: "custom-tool-input-streaming";
  readonly toolKind: "custom";
  readonly piRepresentation: "partial";
  readonly value: boolean | null;
}

export interface AnthropicCustomToolInputExamplesCandidate
  extends AnthropicToolCandidateBase {
  readonly kind: "custom-tool-input-examples";
  readonly toolKind: "custom";
  readonly piRepresentation: "partial";
  readonly value: readonly ReadonlyJsonObject[];
}

export interface AnthropicServerToolDefinitionCandidate
  extends AnthropicToolCandidateBase {
  readonly kind: "server-tool-definition";
  readonly toolKind: "server";
  readonly piRepresentation: "none";
  readonly value: ReadonlyJsonObject;
}

export type AnthropicToolCandidate =
  | AnthropicCustomToolCallerPolicyCandidate
  | AnthropicCustomToolDeferredLoadingCandidate
  | AnthropicCustomToolInputStreamingCandidate
  | AnthropicCustomToolInputExamplesCandidate
  | AnthropicServerToolDefinitionCandidate;

export type AnthropicCacheAttachment =
  | { readonly kind: "request" }
  | { readonly kind: "system-block"; readonly blockIndex: number }
  | {
      readonly kind: "message-content";
      readonly messageIndex: number;
      readonly contentIndex: number;
      /** Source-semantic path from the owning message block to a nested block. */
      readonly nestedPath?: readonly (string | number)[];
    }
  | { readonly kind: "tool-definition"; readonly toolIndex: number };

export interface AnthropicCacheCandidate extends AnthropicCandidateBase {
  readonly kind: "cache-control";
  readonly attachment: AnthropicCacheAttachment;
  readonly value: AnthropicCacheControl | null;
}

export type AnthropicConversationEntry =
  | {
      readonly kind: "source-content";
      readonly sourceContentIndex: number;
      readonly piAttachment?: AnthropicPiAttachment;
      readonly candidateIds: readonly AnthropicCandidateId[];
    }
  | {
      readonly kind: "synthetic-tool-result";
      readonly callId: string;
      readonly piAttachment: {
        readonly kind: "tool-result";
        readonly callId: string;
      };
      readonly candidateIds: readonly [];
    };

export interface AnthropicConversationLayout {
  readonly messages: readonly {
    readonly sourceMessageIndex: number;
    readonly effectiveRole: "user" | "assistant";
    readonly entries: readonly AnthropicConversationEntry[];
  }[];
}

export interface AnthropicProjectionSupplement {
  readonly controls: AnthropicControlCandidates;
  readonly system: readonly AnthropicSystemCandidate[];
  readonly conversation: AnthropicConversationLayout;
  readonly content: readonly AnthropicContentCandidate[];
  readonly tools: readonly AnthropicToolCandidate[];
  readonly cache: readonly AnthropicCacheCandidate[];
}
