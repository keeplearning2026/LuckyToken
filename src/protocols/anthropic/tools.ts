import type { Tool } from "@earendil-works/pi-ai";

import { InvalidRequest } from "./failures.js";

export interface ValidatedAnthropicTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  strict: boolean;
}

interface StrictSchemaCounts {
  optionalParameters: number;
  unionParameters: number;
}

const SUPPORTED_SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireUniqueStrings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new InvalidRequest(`${field} must be an array of unique strings`);
  }
  return value as string[];
}

function countStrictSchema(
  value: unknown,
  path: string,
  counts: StrictSchemaCounts,
  ancestors: Set<object>,
): void {
  if (typeof value === "boolean") {
    // JSON Schema boolean schemas are accepted as-is.
    return;
  }
  if (!isRecord(value)) {
    throw new InvalidRequest(`${path} must be a schema object`);
  }
  if (ancestors.has(value)) {
    throw new InvalidRequest(`${path} contains a cyclic schema graph`);
  }
  ancestors.add(value);
  try {
    const type = value.type;
    if (Array.isArray(type)) {
      if (
        type.length === 0 ||
        type.some(
          (entry) =>
            typeof entry !== "string" || !SUPPORTED_SCHEMA_TYPES.has(entry),
        ) ||
        new Set(type).size !== type.length
      ) {
        throw new InvalidRequest(`${path}.type array is malformed`);
      }
      if (type.length > 1) {
        counts.unionParameters += 1;
      }
    } else if (typeof type === "string") {
      if (!SUPPORTED_SCHEMA_TYPES.has(type)) {
        throw new InvalidRequest(`${path}.type is not a JSON Schema type`);
      }
    } else if (type !== undefined) {
      throw new InvalidRequest(`${path}.type has an invalid shape`);
    }

    const required =
      value.required === undefined
        ? []
        : requireUniqueStrings(value.required, `${path}.required`);
    const requiredNames = new Set(required);
    if (value.properties !== undefined) {
      if (!isRecord(value.properties)) {
        throw new InvalidRequest(`${path}.properties must be an object`);
      }
      for (const [name, schema] of Object.entries(value.properties)) {
        if (!requiredNames.has(name)) {
          counts.optionalParameters += 1;
        }
        countStrictSchema(
          schema,
          `${path}.properties.${name}`,
          counts,
          ancestors,
        );
      }
    }

    for (const keyword of [
      "additionalProperties",
      "items",
      "not",
      "if",
      "then",
      "else",
      "propertyNames",
      "contains",
      "unevaluatedProperties",
      "unevaluatedItems",
      "dependentSchemas",
      "patternProperties",
    ] as const) {
      const nested = value[keyword];
      if (nested === undefined) continue;
      countStrictSchema(nested, `${path}.${keyword}`, counts, ancestors);
    }
    for (const keyword of [
      "oneOf",
      "anyOf",
      "allOf",
      "prefixItems",
    ] as const) {
      const nested = value[keyword];
      if (nested === undefined) continue;
      if (!Array.isArray(nested) || nested.length === 0) {
        throw new InvalidRequest(`${path}.${keyword} must be a schema array`);
      }
      for (const [index, schema] of nested.entries()) {
        countStrictSchema(
          schema,
          `${path}.${keyword}[${index}]`,
          counts,
          ancestors,
        );
      }
    }
    for (const keyword of ["$defs", "definitions"] as const) {
      const nested = value[keyword];
      if (nested === undefined) continue;
      if (!isRecord(nested)) {
        throw new InvalidRequest(`${path}.${keyword} must be an object of schemas`);
      }
      for (const [name, schema] of Object.entries(nested)) {
        countStrictSchema(
          schema,
          `${path}.${keyword}.${name}`,
          counts,
          ancestors,
        );
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function validateToolControlShapes(tool: Record<string, unknown>): void {
  if (tool.cache_control !== undefined && !isRecord(tool.cache_control)) {
    throw new InvalidRequest("tool.cache_control must be an object");
  }
  if (tool.allowed_callers !== undefined) {
    requireUniqueStrings(tool.allowed_callers, "tool.allowed_callers");
  }
  for (const field of ["defer_loading", "eager_input_streaming"] as const) {
    if (tool[field] !== undefined && typeof tool[field] !== "boolean") {
      throw new InvalidRequest(`tool.${field} must be boolean`);
    }
  }
  if (tool.input_examples !== undefined && !Array.isArray(tool.input_examples)) {
    throw new InvalidRequest("tool.input_examples must be an array");
  }
  if (tool.type !== undefined && typeof tool.type !== "string") {
    throw new InvalidRequest("tool.type must be a string");
  }
}

export function validateAnthropicTools(
  value: unknown,
): ValidatedAnthropicTool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new InvalidRequest("tools must be an array when present");
  }

  const tools: ValidatedAnthropicTool[] = [];
  const names = new Set<string>();
  let strictToolCount = 0;
  const strictCounts: StrictSchemaCounts = {
    optionalParameters: 0,
    unionParameters: 0,
  };

  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) {
      throw new InvalidRequest(`tools[${index}] must be an object`);
    }
    if (typeof candidate.name !== "string" || candidate.name.length === 0) {
      throw new InvalidRequest(`tools[${index}].name must be a non-empty string`);
    }
    if (names.has(candidate.name)) {
      throw new InvalidRequest(`Duplicate tool name: ${candidate.name}`);
    }
    names.add(candidate.name);
    if (
      candidate.description !== undefined &&
      typeof candidate.description !== "string"
    ) {
      throw new InvalidRequest(`tools[${index}].description must be a string`);
    }
    if (!isRecord(candidate.input_schema)) {
      throw new InvalidRequest(`tools[${index}].input_schema must be an object`);
    }
    if (candidate.strict !== undefined && typeof candidate.strict !== "boolean") {
      throw new InvalidRequest(`tools[${index}].strict must be boolean`);
    }
    validateToolControlShapes(candidate);

    const strict = candidate.strict === true;
    if (strict) strictToolCount += 1;
    if (strict) {
      countStrictSchema(
        candidate.input_schema,
        `tools[${index}].input_schema`,
        strictCounts,
        new Set(),
      );
    }
    if (
      typeof candidate.input_schema.type === "string" &&
      candidate.input_schema.type !== "object"
    ) {
      throw new InvalidRequest(`tools[${index}].input_schema must have type object`);
    }
    const validated: ValidatedAnthropicTool = {
      name: candidate.name,
      inputSchema: candidate.input_schema,
      strict,
    };
    if (candidate.description !== undefined) {
      validated.description = candidate.description;
    }
    tools.push(validated);
  }

  if (strictToolCount > 20) {
    throw new InvalidRequest("A request may contain at most 20 strict tools");
  }
  if (strictCounts.optionalParameters > 24) {
    throw new InvalidRequest(
      "Strict schemas may contain at most 24 optional parameters per request",
    );
  }
  if (strictCounts.unionParameters > 16) {
    throw new InvalidRequest(
      "Strict schemas may contain at most 16 union parameters per request",
    );
  }
  return tools;
}

export function convertAnthropicTools(
  tools: readonly ValidatedAnthropicTool[] | undefined,
): Tool[] | undefined {
  return tools?.map((tool) => {
    const converted: Tool = {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema,
    };
    if (tool.strict) {
      converted.constrainedSampling = {
        type: "json_schema",
        strict: "require",
      };
    }
    return converted;
  });
}
