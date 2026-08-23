export type ProjectionRequirement = "hard" | "preference";

export interface ProjectionControl<T> {
  readonly value: T;
  readonly requirement: ProjectionRequirement;
}

export type StructuredOutputFormat =
  | { readonly type: "text" }
  | { readonly type: "json_object" }
  | {
      readonly type: "json_schema";
      readonly name: string;
      readonly description?: string;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly strict?: boolean;
    };

export type SemanticToolChoice =
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
      readonly tools: readonly SemanticAllowedTool[];
    };

export type SemanticAllowedTool =
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

export interface OutputProjectionControls {
  readonly format?: ProjectionControl<StructuredOutputFormat>;
  readonly verbosity?: ProjectionControl<"low" | "medium" | "high">;
  readonly include?: ProjectionControl<readonly string[]>;
  readonly topLogprobs?: ProjectionControl<number>;
}

export interface ToolProjectionControls {
  readonly parallelCalls?: ProjectionControl<boolean>;
  readonly choice?: ProjectionControl<SemanticToolChoice>;
}

export interface SamplingProjectionControls {
  readonly maxOutputTokens?: ProjectionControl<number>;
  readonly temperature?: ProjectionControl<number>;
  readonly topP?: ProjectionControl<number>;
}

export interface CacheProjectionControls {
  readonly key?: ProjectionControl<string>;
  readonly retention?: ProjectionControl<"in_memory" | "24h">;
}

export interface IdentityProjectionControls {
  readonly safetyIdentifier?: ProjectionControl<string>;
  readonly deprecatedUser?: ProjectionControl<string>;
}

export interface LifecycleProjectionControls {
  readonly serviceTier?: ProjectionControl<
    "auto" | "default" | "flex" | "scale" | "priority"
  >;
  readonly truncation?: ProjectionControl<"auto" | "disabled">;
  readonly background?: ProjectionControl<boolean>;
  readonly store?: ProjectionControl<boolean>;
  readonly contextManagement?: ProjectionControl<
    readonly Readonly<Record<string, unknown>>[]
  >;
  readonly streamOptions?: ProjectionControl<Readonly<Record<string, unknown>>>;
}

export interface ProjectionSupplement {
  readonly output?: OutputProjectionControls;
  readonly tools?: ToolProjectionControls;
  readonly sampling?: SamplingProjectionControls;
  readonly cache?: CacheProjectionControls;
  readonly identity?: IdentityProjectionControls;
  readonly lifecycle?: LifecycleProjectionControls;
}

export type SupplementControlPath =
  | "output.format"
  | "output.verbosity"
  | "output.include"
  | "output.topLogprobs"
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
  | "lifecycle.truncation"
  | "lifecycle.background"
  | "lifecycle.store"
  | "lifecycle.contextManagement"
  | "lifecycle.streamOptions";

export interface SupplementProjectionOutcome {
  readonly control: SupplementControlPath;
  readonly outcome: ProjectionOutcome;
}

export interface SupplementProjectionResult {
  readonly payload: unknown;
  readonly outcomes: readonly SupplementProjectionOutcome[];
}

export const EMPTY_PROJECTION_SUPPLEMENT: ProjectionSupplement = Object.freeze({});
import type { ProjectionOutcome } from "../projection-outcome.js";
