import type { Tool } from "@earendil-works/pi-ai";

import { InvalidRequest } from "./failures.js";

export interface ValidatedAnthropicTool {
  name: string;
  kind: "custom" | "server";
  description?: string;
  inputSchema?: Record<string, unknown>;
  strict: boolean;
  omittedJsonPaths: readonly string[];
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

const SERVER_TOOL_TYPES = new Set([
  "bash_20250124",
  "code_execution_20250522",
  "code_execution_20250825",
  "code_execution_20260120",
  "memory_20250818",
  "text_editor_20250124",
  "text_editor_20250429",
  "text_editor_20250728",
  "web_search_20250305",
  "web_search_20260209",
  "web_fetch_20250910",
  "web_fetch_20260209",
  "web_fetch_20260309",
  "tool_search_tool_bm25_20251119",
  "tool_search_tool_bm25",
  "tool_search_tool_regex_20251119",
  "tool_search_tool_regex",
]);
const SERVER_TOOL_NAMES_BY_TYPE_PREFIX: Readonly<Record<string, string>> = {
  bash: "bash",
  code_execution: "code_execution",
  memory: "memory",
  text_editor: "str_replace",
  web_search: "web_search",
  web_fetch: "web_fetch",
  tool_search_tool_bm25: "tool_search_tool_bm25",
  tool_search_tool_regex: "tool_search_tool_regex",
};

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


function expectedServerToolName(type: string): string | undefined {
  const prefix = Object.keys(SERVER_TOOL_NAMES_BY_TYPE_PREFIX).find(
    (candidate) => type === candidate || type.startsWith(`${candidate}_`),
  );
  const expected = prefix === undefined
    ? undefined
    : SERVER_TOOL_NAMES_BY_TYPE_PREFIX[prefix];
  if (expected === "str_replace") return undefined;
  return expected;
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
    const inputSchema = isRecord(candidate.input_schema)
      ? candidate.input_schema
      : undefined;
    const custom = inputSchema !== undefined;
    const server =
      typeof candidate.type === "string" && SERVER_TOOL_TYPES.has(candidate.type);
    if (custom && server) {
      throw new InvalidRequest(
        `tools[${index}] cannot combine a server-tool type with input_schema`,
      );
    }
    if (!custom && !server) {
      throw new InvalidRequest(
        `tools[${index}] must be a custom tool with input_schema or a known typed server tool`,
      );
    }
    if (candidate.strict !== undefined && typeof candidate.strict !== "boolean") {
      throw new InvalidRequest(`tools[${index}].strict must be boolean`);
    }
    if (custom && candidate.type !== undefined && candidate.type !== null && candidate.type !== "custom") {
      throw new InvalidRequest(`tools[${index}].type must be custom or null`);
    }
    if (server) {
      const expectedName = expectedServerToolName(candidate.type as string);
      if (expectedName !== undefined && candidate.name !== expectedName) {
        throw new InvalidRequest(
          `tools[${index}].name must be ${expectedName} for ${candidate.type}`,
        );
      }
    }

    const strict = candidate.strict === true;
    if (strict) strictToolCount += 1;
    if (strict && custom) {
      countStrictSchema(
        inputSchema,
        `tools[${index}].input_schema`,
        strictCounts,
        new Set(),
      );
    }
    if (inputSchema !== undefined &&
      typeof inputSchema.type === "string" &&
      inputSchema.type !== "object"
    ) {
      throw new InvalidRequest(`tools[${index}].input_schema must have type object`);
    }
    const validated: ValidatedAnthropicTool = {
      name: candidate.name,
      kind: custom ? "custom" : "server",
      strict,
      omittedJsonPaths: Object.freeze(
        server
          ? [`$.tools[${index}]`]
          : Object.keys(candidate)
              .filter((key) =>
                !["name", "type", "description", "input_schema", "strict"].includes(key),
              )
              .map((key) => `$.tools[${index}].${key}`),
      ),
    };
    if (inputSchema !== undefined) {
      validated.inputSchema = structuredClone(inputSchema);
    }
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
  return tools?.filter((tool) => tool.kind === "custom").map((tool) => {
    const converted: Tool = {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? {},
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
