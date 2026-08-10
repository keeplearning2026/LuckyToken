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

const TOOL_FIELDS = new Set(["name", "description", "input_schema", "strict"]);
const SUPPORTED_SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
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

function validateJsonValue(
  value: unknown,
  field: string,
  ancestors: Set<object> = new Set(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidRequest(`${field} must contain finite JSON numbers`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new InvalidRequest(`${field} must contain JSON values only`);
  }
  if (ancestors.has(value)) {
    throw new InvalidRequest(`${field} must be JSON-serializable`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) validateJsonValue(entry, field, ancestors);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new InvalidRequest(`${field} must contain plain JSON objects`);
    }
    for (const entry of Object.values(value)) {
      validateJsonValue(entry, field, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function validateSchemaValue(
  value: unknown,
  field: string,
  unsupported: string[],
  ancestors: Set<object>,
  counts: StrictSchemaCounts | undefined,
): void {
  if (typeof value === "boolean") {
    unsupported.push(`${field} uses a boolean schema`);
    return;
  }
  validateSchemaNode(value, field, unsupported, ancestors, counts, false);
}

function validateSchemaMap(
  value: unknown,
  field: string,
  unsupported: string[],
  ancestors: Set<object>,
  counts: StrictSchemaCounts | undefined,
): void {
  if (!isRecord(value)) {
    throw new InvalidRequest(`${field} must be an object of schemas`);
  }
  for (const [name, schema] of Object.entries(value)) {
    validateSchemaValue(
      schema,
      `${field}.${name}`,
      unsupported,
      ancestors,
      counts,
    );
  }
}

function validateUnsupportedSchemaKeywords(
  node: Record<string, unknown>,
  path: string,
  unsupported: string[],
  ancestors: Set<object>,
  counts: StrictSchemaCounts | undefined,
): void {
  if (node.$ref !== undefined && typeof node.$ref !== "string") {
    throw new InvalidRequest(`${path}.$ref must be a string`);
  }
  for (const keyword of ["$defs", "definitions", "dependentSchemas", "patternProperties"] as const) {
    if (node[keyword] !== undefined) {
      validateSchemaMap(
        node[keyword],
        `${path}.${keyword}`,
        unsupported,
        ancestors,
        counts,
      );
    }
  }
  for (const keyword of ["oneOf", "anyOf", "allOf", "prefixItems"] as const) {
    const value = node[keyword];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0) {
      throw new InvalidRequest(`${path}.${keyword} must be a non-empty schema array`);
    }
    for (const [index, schema] of value.entries()) {
      validateSchemaValue(
        schema,
        `${path}.${keyword}[${index}]`,
        unsupported,
        ancestors,
        counts,
      );
    }
  }
  for (const keyword of [
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
    "contains",
    "unevaluatedProperties",
    "unevaluatedItems",
  ] as const) {
    if (node[keyword] !== undefined) {
      validateSchemaValue(
        node[keyword],
        `${path}.${keyword}`,
        unsupported,
        ancestors,
        counts,
      );
    }
  }
  if (node.dependentRequired !== undefined) {
    if (!isRecord(node.dependentRequired)) {
      throw new InvalidRequest(`${path}.dependentRequired must be an object`);
    }
    for (const [name, required] of Object.entries(node.dependentRequired)) {
      requireUniqueStrings(required, `${path}.dependentRequired.${name}`);
    }
  }
  for (const keyword of ["minContains", "maxContains"] as const) {
    const value = node[keyword];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || (value as number) < 0)
    ) {
      throw new InvalidRequest(`${path}.${keyword} must be a non-negative integer`);
    }
  }
  if (node.format !== undefined && typeof node.format !== "string") {
    throw new InvalidRequest(`${path}.format must be a string`);
  }
}

function validateSchemaNode(
  value: unknown,
  path: string,
  unsupported: string[],
  ancestors: Set<object>,
  counts: StrictSchemaCounts | undefined,
  isParameter: boolean,
): void {
  if (!isRecord(value)) {
    throw new InvalidRequest(`${path} must be a schema object`);
  }
  if (ancestors.has(value)) {
    unsupported.push(`${path} contains a cyclic schema graph`);
    return;
  }
  ancestors.add(value);
  try {
    const type = value.type;
    if (typeof type === "string") {
      if (!SUPPORTED_SCHEMA_TYPES.has(type)) {
        throw new InvalidRequest(`${path}.type is not a JSON Schema type`);
      }
    } else if (Array.isArray(type)) {
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
      if (counts !== undefined && isParameter && type.length > 1) {
        counts.unionParameters += 1;
      }
      unsupported.push(`${path}.type arrays are unsupported`);
    } else if (type === undefined) {
      unsupported.push(`${path}.type omission is outside the frozen subset`);
    } else {
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
        if (counts !== undefined && !requiredNames.has(name)) {
          counts.optionalParameters += 1;
        }
        validateSchemaNode(
          schema,
          `${path}.properties.${name}`,
          unsupported,
          ancestors,
          counts,
          true,
        );
      }
    }

    if (value.additionalProperties !== undefined) {
      if (typeof value.additionalProperties !== "boolean") {
        validateSchemaNode(
          value.additionalProperties,
          `${path}.additionalProperties`,
          unsupported,
          ancestors,
          counts,
          false,
        );
      }
    }
    if (value.items !== undefined) {
      validateSchemaValue(
        value.items,
        `${path}.items`,
        unsupported,
        ancestors,
        counts,
      );
    }

    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || value.enum.length === 0) {
        throw new InvalidRequest(`${path}.enum must be a non-empty array`);
      }
      validateJsonValue(value.enum, `${path}.enum`);
    }
    for (const keyword of ["const", "default"] as const) {
      if (Object.hasOwn(value, keyword)) {
        validateJsonValue(value[keyword], `${path}.${keyword}`);
      }
    }
    if (value.examples !== undefined) {
      if (!Array.isArray(value.examples)) {
        throw new InvalidRequest(`${path}.examples must be an array`);
      }
      validateJsonValue(value.examples, `${path}.examples`);
    }
    for (const keyword of ["description", "title"] as const) {
      if (value[keyword] !== undefined && typeof value[keyword] !== "string") {
        throw new InvalidRequest(`${path}.${keyword} must be a string`);
      }
    }
    for (const keyword of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
    ] as const) {
      if (
        value[keyword] !== undefined &&
        (typeof value[keyword] !== "number" || !Number.isFinite(value[keyword]))
      ) {
        throw new InvalidRequest(`${path}.${keyword} must be a finite number`);
      }
    }
    if (
      value.multipleOf !== undefined &&
      (typeof value.multipleOf !== "number" ||
        !Number.isFinite(value.multipleOf) ||
        value.multipleOf <= 0)
    ) {
      throw new InvalidRequest(`${path}.multipleOf must be a positive number`);
    }
    for (const keyword of [
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minProperties",
      "maxProperties",
    ] as const) {
      const entry = value[keyword];
      if (
        entry !== undefined &&
        (!Number.isSafeInteger(entry) || (entry as number) < 0)
      ) {
        throw new InvalidRequest(`${path}.${keyword} must be a non-negative integer`);
      }
    }
    if (value.pattern !== undefined) {
      if (typeof value.pattern !== "string") {
        throw new InvalidRequest(`${path}.pattern must be a string`);
      }
      try {
        new RegExp(value.pattern, "u");
      } catch {
        throw new InvalidRequest(`${path}.pattern must be a valid expression`);
      }
    }
    if (
      value.uniqueItems !== undefined &&
      typeof value.uniqueItems !== "boolean"
    ) {
      throw new InvalidRequest(`${path}.uniqueItems must be boolean`);
    }

    validateUnsupportedSchemaKeywords(
      value,
      path,
      unsupported,
      ancestors,
      counts,
    );
    for (const keyword of Object.keys(value)) {
      if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
        unsupported.push(`${path}.${keyword} is outside the frozen schema subset`);
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
  unsupported: string[],
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
    validateSchemaNode(
      candidate.input_schema,
      `tools[${index}].input_schema`,
      unsupported,
      new Set(),
      strict ? strictCounts : undefined,
      false,
    );
    if (
      typeof candidate.input_schema.type === "string" &&
      candidate.input_schema.type !== "object"
    ) {
      throw new InvalidRequest(`tools[${index}].input_schema must have type object`);
    }
    for (const field of Object.keys(candidate)) {
      if (!TOOL_FIELDS.has(field)) unsupported.push(`unsupported tool field: ${field}`);
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
