export interface ResponsesProjectionCandidate<T> {
  readonly value: T;
}

export type ResponsesStructuredOutputFormat =
  | { readonly type: "text" }
  | { readonly type: "json_object" }
  | {
      readonly type: "json_schema";
      readonly name: string;
      readonly description?: string;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly strict?: boolean;
    };

export type ResponsesToolChoice =
  | { readonly kind: "auto" | "none" | "required" }
  | {
      readonly kind: "named";
      readonly toolType: "function" | "custom";
      readonly name: string;
    }
  | {
      readonly kind: "hosted";
      readonly toolType: "apply_patch" | "shell" | "mcp";
      readonly name?: string;
      readonly serverLabel?: string;
    }
  | {
      readonly kind: "allowed";
      readonly mode: "auto" | "required";
      readonly tools: readonly ResponsesAllowedTool[];
    };

export type ResponsesAllowedTool =
  | {
      readonly toolType: "function" | "custom";
      readonly name: string;
    }
  | {
      readonly toolType: "apply_patch" | "shell";
    }
  | {
      readonly toolType: "mcp";
      readonly serverLabel: string;
      readonly name?: string;
    };

export interface ResponsesOutputProjectionCandidates {
  readonly format?: ResponsesProjectionCandidate<ResponsesStructuredOutputFormat>;
  readonly verbosity?: ResponsesProjectionCandidate<"low" | "medium" | "high">;
  readonly include?: ResponsesProjectionCandidate<readonly string[]>;
}

export interface ResponsesToolProjectionCandidates {
  readonly parallelCalls?: ResponsesProjectionCandidate<boolean>;
  readonly choice?: ResponsesProjectionCandidate<ResponsesToolChoice>;
}

export interface ResponsesSamplingProjectionCandidates {
  readonly maxOutputTokens?: ResponsesProjectionCandidate<number>;
  readonly temperature?: ResponsesProjectionCandidate<number>;
  readonly topP?: ResponsesProjectionCandidate<number>;
}

export interface ResponsesCacheProjectionCandidates {
  readonly key?: ResponsesProjectionCandidate<string>;
  readonly retention?: ResponsesProjectionCandidate<"in_memory" | "24h">;
}

export interface ResponsesIdentityProjectionCandidates {
  readonly safetyIdentifier?: ResponsesProjectionCandidate<string>;
  readonly deprecatedUser?: ResponsesProjectionCandidate<string>;
}

export interface ResponsesLifecycleProjectionCandidates {
  readonly serviceTier?: ResponsesProjectionCandidate<
    "auto" | "default" | "flex" | "scale" | "priority"
  >;
  readonly truncation?: ResponsesProjectionCandidate<"auto" | "disabled">;
}

export interface ResponsesProjectionSupplement {
  readonly output?: ResponsesOutputProjectionCandidates;
  readonly tools?: ResponsesToolProjectionCandidates;
  readonly sampling?: ResponsesSamplingProjectionCandidates;
  readonly cache?: ResponsesCacheProjectionCandidates;
  readonly identity?: ResponsesIdentityProjectionCandidates;
  readonly lifecycle?: ResponsesLifecycleProjectionCandidates;
}

export type ResponsesProjectionControlPath =
  | "output.format"
  | "output.verbosity"
  | "output.include"
  | "tools.parallelCalls"
  | "tools.choice"
  | "sampling.maxOutputTokens"
  | "sampling.temperature"
  | "sampling.topP"
  | "cache.key"
  | "cache.retention"
  | "identity.safetyIdentifier"
  | "identity.deprecatedUser"
  | "lifecycle.serviceTier"
  | "lifecycle.truncation";

export interface ResponsesProjectionRecord {
  readonly control: ResponsesProjectionControlPath;
  readonly outcome: ResponsesSupplementProjectionOutcome;
}

export interface ResponsesProjectionResult {
  readonly payload: unknown;
  readonly outcomes: readonly ResponsesProjectionRecord[];
}

export const EMPTY_RESPONSES_PROJECTION_SUPPLEMENT: ResponsesProjectionSupplement = Object.freeze({});
import type { ResponsesSupplementProjectionOutcome } from "../projection/outcome.js";
