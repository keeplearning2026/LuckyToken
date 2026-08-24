import type {
  ResponsesProjectionCandidate,
  ResponsesProjectionSupplement,
  ResponsesAllowedTool,
  ResponsesToolChoice,
  ResponsesStructuredOutputFormat,
} from "./contract.js";

function candidate<T>(value: T): ResponsesProjectionCandidate<T> {
  return Object.freeze({ value });
}

export class InvalidResponsesProjectionSupplement extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidResponsesProjectionSupplement";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidResponsesProjectionSupplement(
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function cloneFrozenRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const clone = structuredClone(value) as Record<string, unknown>;
  const seen = new Set<object>();
  const freeze = (candidate: unknown): void => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      seen.has(candidate)
    ) {
      return;
    }
    seen.add(candidate);
    for (const nested of Object.values(candidate)) freeze(nested);
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone;
}

function parseFormat(value: unknown): ResponsesStructuredOutputFormat | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new InvalidResponsesProjectionSupplement("text.format must be an object");
  }
  if (value.type === "text" || value.type === "json_object") {
    if (Object.keys(value).some((key) => key !== "type")) {
      throw new InvalidResponsesProjectionSupplement(
        `text.format ${value.type} contains unsupported fields`,
      );
    }
    return Object.freeze({ type: value.type });
  }
  if (value.type !== "json_schema") {
    throw new InvalidResponsesProjectionSupplement(
      `unsupported text.format.type: ${String(value.type)}`,
    );
  }
  const name = nonEmptyString(value.name, "text.format.name");
  if (name.length > 64 || !/^[A-Za-z0-9_-]+$/u.test(name)) {
    throw new InvalidResponsesProjectionSupplement(
      "text.format.name must use A-Z, a-z, 0-9, underscore, or dash and be at most 64 characters",
    );
  }
  if (!isRecord(value.schema)) {
    throw new InvalidResponsesProjectionSupplement(
      "text.format.schema must be an object",
    );
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new InvalidResponsesProjectionSupplement(
      "text.format.description must be a string when present",
    );
  }
  if (value.strict !== undefined && typeof value.strict !== "boolean") {
    throw new InvalidResponsesProjectionSupplement(
      "text.format.strict must be a boolean when present",
    );
  }
  const known = new Set(["type", "name", "description", "schema", "strict"]);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new InvalidResponsesProjectionSupplement(
      "text.format.json_schema contains unsupported fields",
    );
  }
  return Object.freeze({
    type: "json_schema",
    name,
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    schema: cloneFrozenRecord(value.schema),
    ...(value.strict === undefined ? {} : { strict: value.strict }),
  });
}

function parseAllowedTool(value: unknown, field: string): ResponsesAllowedTool {
  if (!isRecord(value)) {
    throw new InvalidResponsesProjectionSupplement(`${field} must be an object`);
  }
  if (value.type === "function" || value.type === "custom") {
    return Object.freeze({
      toolType: value.type,
      name: nonEmptyString(value.name, `${field}.name`),
    });
  }
  if (value.type === "apply_patch" || value.type === "shell") {
    return Object.freeze({ toolType: value.type });
  }
  if (value.type === "mcp") {
    return Object.freeze({
      toolType: "mcp",
      serverLabel: nonEmptyString(value.server_label, `${field}.server_label`),
      ...(value.name === undefined
        ? {}
        : { name: nonEmptyString(value.name, `${field}.name`) }),
    });
  }
  throw new InvalidResponsesProjectionSupplement(
    `${field}.type is not a supported tool reference`,
  );
}

export function parseResponsesToolChoice(
  value: unknown,
): ResponsesToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") {
    return Object.freeze({ kind: value });
  }
  if (!isRecord(value)) {
    throw new InvalidResponsesProjectionSupplement(
      "tool_choice must be auto, none, required, or an object",
    );
  }
  if (value.type === "function" || value.type === "custom") {
    return Object.freeze({
      kind: "named",
      toolType: value.type,
      name: nonEmptyString(value.name, "tool_choice.name"),
    });
  }
  if (value.type === "apply_patch" || value.type === "shell") {
    return Object.freeze({ kind: "hosted", toolType: value.type });
  }
  if (value.type === "mcp") {
    return Object.freeze({
      kind: "hosted",
      toolType: "mcp",
      serverLabel: nonEmptyString(
        value.server_label,
        "tool_choice.server_label",
      ),
      ...(value.name === undefined
        ? {}
        : { name: nonEmptyString(value.name, "tool_choice.name") }),
    });
  }
  if (value.type === "allowed_tools") {
    if (value.mode !== "auto" && value.mode !== "required") {
      throw new InvalidResponsesProjectionSupplement(
        "tool_choice.mode must be auto or required",
      );
    }
    if (!Array.isArray(value.tools) || value.tools.length === 0) {
      throw new InvalidResponsesProjectionSupplement(
        "tool_choice.tools must be a non-empty array",
      );
    }
    return Object.freeze({
      kind: "allowed",
      mode: value.mode,
      tools: Object.freeze(
        value.tools.map((entry, index) =>
          parseAllowedTool(entry, `tool_choice.tools[${index}]`),
        ),
      ),
    });
  }
  throw new InvalidResponsesProjectionSupplement(
    `unsupported tool_choice.type: ${String(value.type)}`,
  );
}

const INCLUDABLE = new Set([
  "file_search_call.results",
  "web_search_call.results",
  "web_search_call.action.sources",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "code_interpreter_call.outputs",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
]);

function stringEnum<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new InvalidResponsesProjectionSupplement(
      `${field} must be one of ${values.join(", ")}`,
    );
  }
  return value as T;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new InvalidResponsesProjectionSupplement(
      `${field} must be a boolean when present`,
    );
  }
  return value;
}

export function parseResponsesProjectionSupplement(
  request: Readonly<Record<string, unknown>>,
): ResponsesProjectionSupplement {
  const format = parseFormat(isRecord(request.text) ? request.text.format : undefined);
  if (request.text !== undefined && !isRecord(request.text)) {
    throw new InvalidResponsesProjectionSupplement("text must be an object");
  }
  const verbosity = stringEnum(
    isRecord(request.text) ? request.text.verbosity : undefined,
    "text.verbosity",
    ["low", "medium", "high"] as const,
  );
  const includeValue = request.include;
  let include: readonly string[] | undefined;
  if (includeValue !== undefined && includeValue !== null) {
    if (
      !Array.isArray(includeValue) ||
      includeValue.some(
        (entry) => typeof entry !== "string" || !INCLUDABLE.has(entry),
      )
    ) {
      throw new InvalidResponsesProjectionSupplement(
        "include must contain only supported Responses include values",
      );
    }
    include =
      includeValue.length === 0
        ? undefined
        : (Object.freeze([...includeValue]) as readonly string[]);
  }
  const parallelCalls = optionalBoolean(
    request.parallel_tool_calls,
    "parallel_tool_calls",
  );
  const toolChoice = parseResponsesToolChoice(request.tool_choice);
  const promptCacheKey =
    request.prompt_cache_key === undefined || request.prompt_cache_key === null
      ? undefined
      : nonEmptyString(request.prompt_cache_key, "prompt_cache_key");
  const retention = stringEnum(
    request.prompt_cache_retention,
    "prompt_cache_retention",
    ["in_memory", "24h"] as const,
  );
  const safetyIdentifier =
    request.safety_identifier === undefined || request.safety_identifier === null
      ? undefined
      : nonEmptyString(request.safety_identifier, "safety_identifier");
  const deprecatedUser =
    request.user === undefined || request.user === null
      ? undefined
      : nonEmptyString(request.user, "user");
  if (safetyIdentifier !== undefined && safetyIdentifier.length > 64) {
    throw new InvalidResponsesProjectionSupplement(
      "safety_identifier must be at most 64 characters",
    );
  }
  const serviceTier = stringEnum(
    request.service_tier,
    "service_tier",
    ["auto", "default", "flex", "scale", "priority"] as const,
  );
  const truncation = stringEnum(
    request.truncation,
    "truncation",
    ["auto", "disabled"] as const,
  );
  const maxOutputTokens =
    typeof request.max_output_tokens === "number"
      ? request.max_output_tokens
      : undefined;
  const temperature =
    typeof request.temperature === "number" ? request.temperature : undefined;
  const topP = typeof request.top_p === "number" ? request.top_p : undefined;

  const output =
    format === undefined &&
    verbosity === undefined &&
    include === undefined
      ? undefined
      : Object.freeze({
          ...(format === undefined ? {} : { format: candidate(format) }),
          ...(verbosity === undefined
            ? {}
            : { verbosity: candidate(verbosity) }),
          ...(include === undefined ? {} : { include: candidate(include) }),
        });
  const tools =
    parallelCalls === undefined && toolChoice === undefined
      ? undefined
      : Object.freeze({
          ...(parallelCalls === undefined
            ? {}
            : { parallelCalls: candidate(parallelCalls) }),
          ...(toolChoice === undefined
            ? {}
            : { choice: candidate(toolChoice) }),
        });
  const sampling =
    maxOutputTokens === undefined && temperature === undefined && topP === undefined
      ? undefined
      : Object.freeze({
          ...(maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: candidate(maxOutputTokens) }),
          ...(temperature === undefined
            ? {}
            : { temperature: candidate(temperature) }),
          ...(topP === undefined ? {} : { topP: candidate(topP) }),
        });
  const cache =
    promptCacheKey === undefined && retention === undefined
      ? undefined
      : Object.freeze({
          ...(promptCacheKey === undefined
            ? {}
            : { key: candidate(promptCacheKey) }),
          ...(retention === undefined
            ? {}
            : { retention: candidate(retention) }),
        });
  const identity =
    safetyIdentifier === undefined && deprecatedUser === undefined
      ? undefined
      : Object.freeze({
          ...(safetyIdentifier === undefined
            ? {}
            : { safetyIdentifier: candidate(safetyIdentifier) }),
          ...(deprecatedUser === undefined
            ? {}
            : { deprecatedUser: candidate(deprecatedUser) }),
        });
  const lifecycle =
    serviceTier === undefined && truncation === undefined
      ? undefined
      : Object.freeze({
          ...(serviceTier === undefined
            ? {}
            : { serviceTier: candidate(serviceTier) }),
          ...(truncation === undefined
            ? {}
            : { truncation: candidate(truncation) }),
        });

  return Object.freeze({
    ...(output === undefined ? {} : { output }),
    ...(tools === undefined ? {} : { tools }),
    ...(sampling === undefined ? {} : { sampling }),
    ...(cache === undefined ? {} : { cache }),
    ...(identity === undefined ? {} : { identity }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
  });
}
