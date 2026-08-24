import { isDeepStrictEqual } from "node:util";

import type { ResponsesSupplementProjectionOutcome } from "../outcome.js";
import type {
  ResponsesProjectionCandidate,
  ResponsesProjectionSupplement,
  ResponsesToolChoice,
  ResponsesStructuredOutputFormat,
  ResponsesProjectionControlPath,
  ResponsesProjectionRecord,
  ResponsesProjectionResult,
} from "../../supplement/contract.js";
import { InvalidResponsesProjection } from "./contract.js";

export interface ResponsesProjectionState {
  readonly projector: string;
  readonly payload: Record<string, unknown>;
  readonly supplement: ResponsesProjectionSupplement;
  readonly handled: Set<ResponsesProjectionControlPath>;
  readonly outcomes: ResponsesProjectionRecord[];
}

export function clonePayload(value: unknown, api: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidResponsesProjection(`${api} payload must be an object`);
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
      throw new InvalidResponsesProjection(
        `${api} payload shape mismatch at ${field}`,
      );
    }
  }
}

export function createState(
  projector: string,
  payload: Record<string, unknown>,
  supplement: ResponsesProjectionSupplement,
): ResponsesProjectionState {
  return { projector, payload, supplement, handled: new Set(), outcomes: [] };
}

function append(
  state: ResponsesProjectionState,
  control: ResponsesProjectionControlPath,
  projection: ResponsesSupplementProjectionOutcome,
): void {
  if (state.handled.has(control)) {
    throw new InvalidResponsesProjection(
      `${state.projector} attempted to project ${control} more than once`,
    );
  }
  state.handled.add(control);
  state.outcomes.push(
    Object.freeze({ control, outcome: Object.freeze(projection) }),
  );
}

export function native(
  state: ResponsesProjectionState,
  control: ResponsesProjectionControlPath,
): void {
  append(state, control, { kind: "pi-native" });
}

function projected(
  state: ResponsesProjectionState,
  control: ResponsesProjectionControlPath,
  warning?: "pi-native-mapping-repaired",
): void {
  append(state, control, {
    kind: "payload-projected",
    projector: state.projector,
    ...(warning === undefined ? {} : { warning }),
  });
}

export function degraded(
  state: ResponsesProjectionState,
  path: ResponsesProjectionControlPath,
  fallback:
    | "cache-retention-24h-to-1h"
    | "cache-retention-in-memory-to-provider-ephemeral",
  warning: string,
): void {
  append(state, path, {
    kind: "degraded",
    projector: state.projector,
    fallback,
    warning,
  });
}

export function projectTargetValue<T>(
  state: ResponsesProjectionState,
  path: ResponsesProjectionControlPath,
  actual: unknown,
  expected: T,
  write: (value: T) => void,
): void {
  if (isDeepStrictEqual(actual, expected)) {
    native(state, path);
    return;
  }
  write(expected);
  projected(
    state,
    path,
    actual === undefined ? undefined : "pi-native-mapping-repaired",
  );
}

export function projectTargetAbsence(
  state: ResponsesProjectionState,
  path: ResponsesProjectionControlPath,
  actual: unknown,
  remove: () => void,
): void {
  if (actual === undefined) {
    native(state, path);
    return;
  }
  remove();
  projected(state, path, "pi-native-mapping-repaired");
}

export function projectExactNumber(
  state: ResponsesProjectionState,
  path: ResponsesProjectionControlPath,
  control: ResponsesProjectionCandidate<number>,
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

export function projectCeilingNumber(
  state: ResponsesProjectionState,
  path: ResponsesProjectionControlPath,
  control: ResponsesProjectionCandidate<number>,
  actual: unknown,
  write: (value: number) => void,
): void {
  if (typeof actual === "number" && actual <= control.value) {
    native(state, path);
    return;
  }
  write(control.value);
  projected(state, path, "pi-native-mapping-repaired");
}

export function unsupported<T>(
  state: ResponsesProjectionState,
  path: ResponsesProjectionControlPath,
  _control: ResponsesProjectionCandidate<T>,
  reason: string,
): void {
  append(state, path, { kind: "omitted", warning: reason });
}

function omitUnconsumed(
  state: ResponsesProjectionState,
  path: ResponsesProjectionControlPath,
  reason: string,
): void {
  append(state, path, { kind: "omitted", warning: reason });
}

export function requireNativeNumber(
  state: ResponsesProjectionState,
  path: ResponsesProjectionControlPath,
  control: ResponsesProjectionCandidate<number>,
  actual: unknown,
  mode: "equal" | "ceiling" = "equal",
): void {
  const matches =
    typeof actual === "number" &&
    (mode === "equal" ? actual === control.value : actual <= control.value);
  if (matches) native(state, path);
}

export function toChatResponseFormat(
  format: ResponsesStructuredOutputFormat,
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
  choice: ResponsesToolChoice,
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
  choice: ResponsesToolChoice,
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

function controls(
  supplement: ResponsesProjectionSupplement,
): readonly [ResponsesProjectionControlPath, ResponsesProjectionCandidate<unknown>][] {
  const result: [ResponsesProjectionControlPath, ResponsesProjectionCandidate<unknown>][] = [];
  const add = (
    path: ResponsesProjectionControlPath,
    control: ResponsesProjectionCandidate<unknown> | undefined,
  ): void => {
    if (control !== undefined) result.push([path, control]);
  };
  add("output.format", supplement.output?.format);
  add("output.verbosity", supplement.output?.verbosity);
  add("output.include", supplement.output?.include);
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
  return result;
}

export function finish(state: ResponsesProjectionState): ResponsesProjectionResult {
  for (const [path] of controls(state.supplement)) {
    if (!state.handled.has(path)) {
      omitUnconsumed(
        state,
        path,
        `${state.projector} has no certified mapping for ${path}`,
      );
    }
  }
  return Object.freeze({
    payload: Object.freeze(state.payload),
    outcomes: Object.freeze(state.outcomes),
  });
}
