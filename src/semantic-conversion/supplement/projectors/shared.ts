import type { ProjectionOutcome } from "../../projection-outcome.js";
import type {
  ProjectionControl,
  ProjectionSupplement,
  SemanticToolChoice,
  StructuredOutputFormat,
  SupplementControlPath,
  SupplementProjectionOutcome,
  SupplementProjectionResult,
} from "../contract.js";
import { InvalidSupplementProjection } from "./contract.js";

export interface ProjectionState {
  readonly projector: string;
  readonly payload: Record<string, unknown>;
  readonly supplement: ProjectionSupplement;
  readonly handled: Set<SupplementControlPath>;
  readonly outcomes: SupplementProjectionOutcome[];
}

export function clonePayload(value: unknown, api: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidSupplementProjection(`${api} payload must be an object`);
  }
  return structuredClone(value) as Record<string, unknown>;
}

export function requirePayloadShape(
  payload: Record<string, unknown>,
  api: string,
  fields: readonly [string, "string" | "array" | "object" | "true"][],
): void {
  for (const [field, kind] of fields) {
    const value = payload[field];
    const valid =
      kind === "array"
        ? Array.isArray(value)
        : kind === "object"
          ? typeof value === "object" && value !== null && !Array.isArray(value)
          : kind === "true"
            ? value === true
            : typeof value === kind;
    if (!valid) {
      throw new InvalidSupplementProjection(
        `${api} payload shape mismatch at ${field}`,
      );
    }
  }
}

export function createState(
  projector: string,
  payload: Record<string, unknown>,
  supplement: ProjectionSupplement,
): ProjectionState {
  return { projector, payload, supplement, handled: new Set(), outcomes: [] };
}

function append(
  state: ProjectionState,
  control: SupplementControlPath,
  projection: ProjectionOutcome,
): void {
  if (state.handled.has(control)) {
    throw new InvalidSupplementProjection(
      `${state.projector} attempted to project ${control} more than once`,
    );
  }
  state.handled.add(control);
  state.outcomes.push(
    Object.freeze({ control, outcome: Object.freeze(projection) }),
  );
}

export function native(
  state: ProjectionState,
  control: SupplementControlPath,
): void {
  append(state, control, { kind: "pi-native" });
}

export function projected(
  state: ProjectionState,
  control: SupplementControlPath,
  warning?: "pi-native-mapping-repaired",
): void {
  append(state, control, {
    kind: "payload-projected",
    projector: state.projector,
    ...(warning === undefined ? {} : { warning }),
  });
}

export function projectExactNumber(
  state: ProjectionState,
  path: SupplementControlPath,
  control: ProjectionControl<number>,
  actual: unknown,
  write: (value: number) => void,
): void {
  if (actual === control.value) {
    native(state, path);
    return;
  }
  write(control.value);
  projected(state, path, "pi-native-mapping-repaired");
}

export function unsupported<T>(
  state: ProjectionState,
  path: SupplementControlPath,
  control: ProjectionControl<T>,
  reason: string,
): void {
  if (control.requirement === "hard") {
    throw new InvalidSupplementProjection(`${path}: ${reason}`);
  }
  append(state, path, { kind: "omitted", warning: reason });
}

export function requireNativeNumber(
  state: ProjectionState,
  path: SupplementControlPath,
  control: ProjectionControl<number>,
  actual: unknown,
  mode: "equal" | "ceiling" = "equal",
): void {
  const matches =
    typeof actual === "number" &&
    (mode === "equal" ? actual === control.value : actual <= control.value);
  if (!matches) {
    unsupported(
      state,
      path,
      control,
      `Pi did not emit an equivalent ${path} value`,
    );
    return;
  }
  native(state, path);
}

export function toChatResponseFormat(
  format: StructuredOutputFormat,
): Record<string, unknown> | undefined {
  if (format.type === "text") return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: format.name,
      ...(format.description === undefined
        ? {}
        : { description: format.description }),
      schema: format.schema,
      ...(format.strict === undefined ? {} : { strict: format.strict }),
    },
  };
}

export function toChatCompletionsToolChoice(
  choice: SemanticToolChoice,
): unknown | undefined {
  if (
    choice.kind === "auto" ||
    choice.kind === "none" ||
    choice.kind === "required"
  ) {
    return choice.kind;
  }
  if (choice.kind === "named") {
    return choice.toolType === "function"
      ? { type: "function", function: { name: choice.name } }
      : { type: "custom", custom: { name: choice.name } };
  }
  if (choice.kind === "allowed") {
    const tools: (
      | { readonly type: "function"; readonly function: { readonly name: string } }
      | { readonly type: "custom"; readonly custom: { readonly name: string } }
    )[] = [];
    for (const tool of choice.tools) {
      if (tool.toolType === "function") {
        tools.push({ type: "function", function: { name: tool.name } });
        continue;
      }
      if (tool.toolType === "custom") {
        tools.push({ type: "custom", custom: { name: tool.name } });
      }
    }
    if (tools.length !== choice.tools.length) return undefined;
    return {
      type: "allowed_tools",
      mode: choice.mode,
      tools,
    };
  }
  return undefined;
}

export function toResponsesToolChoice(
  choice: SemanticToolChoice,
): unknown | undefined {
  if (
    choice.kind === "auto" ||
    choice.kind === "none" ||
    choice.kind === "required"
  ) {
    return choice.kind;
  }
  if (choice.kind === "named") {
    return { type: choice.toolType, name: choice.name };
  }
  if (choice.kind === "allowed") {
    return {
      type: "allowed_tools",
      mode: choice.mode,
      tools: choice.tools.map((tool) => {
        if (tool.toolType === "function" || tool.toolType === "custom") {
          return { type: tool.toolType, name: tool.name };
        }
        if (tool.toolType === "mcp") {
          return {
            type: "mcp",
            server_label: tool.serverLabel,
            ...(tool.name === undefined ? {} : { name: tool.name }),
          };
        }
        return { type: tool.toolType };
      }),
    };
  }
  if (choice.kind !== "hosted") return undefined;
  if (choice.toolType === "mcp") {
    return {
      type: "mcp",
      server_label: choice.serverLabel,
      ...(choice.name === undefined ? {} : { name: choice.name }),
    };
  }
  return { type: choice.toolType };
}

export function handleUniversalResponseContracts(state: ProjectionState): void {
  const output = state.supplement.output;
  if (output?.include !== undefined) {
    if (output.include.value.length === 0) {
      native(state, "output.include");
    }
  }
  if (output?.topLogprobs !== undefined) {
    if (output.topLogprobs.value === 0) {
      native(state, "output.topLogprobs");
    } else {
      unsupported(
        state,
        "output.topLogprobs",
        output.topLogprobs,
        "Pi response IR and the Responses renderer do not preserve token logprobs",
      );
    }
  }
  const lifecycle = state.supplement.lifecycle;
  if (lifecycle?.background !== undefined) {
    if (lifecycle.background.value) {
      unsupported(
        state,
        "lifecycle.background",
        lifecycle.background,
        "background execution requires a deferred fetch/cancel lifecycle",
      );
    } else {
      native(state, "lifecycle.background");
    }
  }
  if (lifecycle?.contextManagement !== undefined) {
    unsupported(
      state,
      "lifecycle.contextManagement",
      lifecycle.contextManagement,
      "context management has no semantic-conversion lifecycle implementation",
    );
  }
  if (lifecycle?.store !== undefined) {
    unsupported(
      state,
      "lifecycle.store",
      lifecycle.store,
      "store is owned by the Responses client lifecycle, not the model Provider request",
    );
  }
  if (lifecycle?.streamOptions !== undefined) {
    unsupported(
      state,
      "lifecycle.streamOptions",
      lifecycle.streamOptions,
      "stream options are owned by the Responses transport renderer",
    );
  }
}

function controls(
  supplement: ProjectionSupplement,
): readonly [SupplementControlPath, ProjectionControl<unknown>][] {
  const result: [SupplementControlPath, ProjectionControl<unknown>][] = [];
  const add = (
    path: SupplementControlPath,
    control: ProjectionControl<unknown> | undefined,
  ): void => {
    if (control !== undefined) result.push([path, control]);
  };
  add("output.format", supplement.output?.format);
  add("output.verbosity", supplement.output?.verbosity);
  add("output.include", supplement.output?.include);
  add("output.topLogprobs", supplement.output?.topLogprobs);
  add("tools.parallelCalls", supplement.tools?.parallelCalls);
  add("tools.choice", supplement.tools?.choice);
  add("sampling.maxOutputTokens", supplement.sampling?.maxOutputTokens);
  add("sampling.temperature", supplement.sampling?.temperature);
  add("sampling.topP", supplement.sampling?.topP);
  add("cache.key", supplement.cache?.key);
  add("cache.retention", supplement.cache?.retention);
  add("identity.safetyIdentifier", supplement.identity?.safetyIdentifier);
  add("identity.deprecatedUser", supplement.identity?.deprecatedUser);
  add("lifecycle.serviceTier", supplement.lifecycle?.serviceTier);
  add("lifecycle.truncation", supplement.lifecycle?.truncation);
  add("lifecycle.background", supplement.lifecycle?.background);
  add("lifecycle.store", supplement.lifecycle?.store);
  add("lifecycle.contextManagement", supplement.lifecycle?.contextManagement);
  add("lifecycle.streamOptions", supplement.lifecycle?.streamOptions);
  return result;
}

export function finish(state: ProjectionState): SupplementProjectionResult {
  for (const [path, control] of controls(state.supplement)) {
    if (!state.handled.has(path)) {
      unsupported(
        state,
        path,
        control,
        `${state.projector} has no certified mapping for ${path}`,
      );
    }
  }
  return Object.freeze({
    payload: Object.freeze(state.payload),
    outcomes: Object.freeze(state.outcomes),
  });
}
