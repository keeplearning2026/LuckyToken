import type {
  Context,
  ImageContent,
  Message,
  ModelsSimpleStreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";

import type { ConversionNotice } from "../../invocation-diagnostics/index.js";

export class InvalidRequest extends Error {
  readonly kind = "InvalidRequest";

  constructor(message: string) {
    super(message);
    this.name = "InvalidRequest";
  }
}

/** Responses-owned frozen request conversion policy (from the adapter config). */
export interface ResponseRequestConversionPolicy {
  readonly privilegedMessages: "full" | "first" | "user";
  readonly unknownInputItem: "error" | "ignore";
  readonly orphanToolOutput: "error" | "ignore";
  readonly unresolvedToolCall: "error" | "xrepair";
  readonly futureReasoningEffort: "max" | "omit" | "error";
}

/**
 * Narrow Responses-owned resolver capability for LuckyToken-provable opaque
 * references/envelopes. Only the Responses adapter may install one; it never
 * borrows a Provider credential and never leaks a Responses handle into Pi.
 * The resolver receives an explicit authorization context, the caller's abort
 * signal, and bounded size/redirect limits so it can never over-fetch.
 */
export interface ResponseReferenceResolver {
  resolveItemReference(
    reference: Readonly<Record<string, unknown>>,
    context: {
      readonly authority: string;
      readonly signal?: AbortSignal;
      readonly limits?: Readonly<{
        maxBytes?: number;
        maxMimeTypes?: readonly string[];
        maxRedirects?: number;
      }>;
    },
  ): Promise<readonly unknown[]>;
}

/** Default bound for a reference resolution; a narrow adapter may tighten it. */
export const DEFAULT_REFERENCE_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxRedirects: 5,
});

export interface ResponsesInvocation {
  selector: string;
  context: Context;
  options: ModelsSimpleStreamOptions;
  renderState: {
    clientModel: string;
    stream: boolean;
    /** Effective tool_choice that actually took effect (auto/none/allowed). */
    toolChoice?: string;
    /** Tool names declared as freeform `custom` tools; their calls must
     *  round-trip as `custom_tool_call` output items. */
    freeformToolNames?: ReadonlySet<string>;
    /** Reverse metadata for flattened namespace tools, retained only for
     *  request-local response echo. Never placed into model context. */
    namespaceReverse?: Readonly<Record<string, { namespace: string; child: string }>>;
    /** Source metadata retained only for request-local response echo. Never
     *  placed into model context. */
    metadataEcho?: Readonly<Record<string, string>>;
  };
  notices: readonly ConversionNotice[];
}

export interface ValidatedResponsesRequest {
  selector: string;
  instructions?: string;
  input: unknown;
  stream: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  cacheRetention?: "short" | "long";
  metadataUserId?: string;
  reasoning?: string;
  tools?: Tool[];
  toolChoice?: string;
  background: boolean;
  conversationPresent: boolean;
  promptPresent: boolean;
}

export const SYNTHETIC_CLIENT_HISTORY_API = "luckytoken-client-history";
export const SYNTHETIC_CLIENT_HISTORY_PROVIDER = "luckytoken-client";

export const FUTURE_EFFORT_NOTICE_CODE = "openai-responses_future_effort";
export const EFFORT_NONE_OMITTED_NOTICE_CODE =
  "openai-responses_effort_none_omitted";
export const ULTRA_ALIAS_NOTICE_CODE = "openai-responses_effort_ultra_alias";
export const UNKNOWN_INPUT_ITEM_IGNORED_NOTICE_CODE =
  "openai-responses_unknown_input_item_ignored";
export const FORCED_TOOL_CHOICE_DROPPED_NOTICE_CODE =
  "openai-responses_forced_tool_choice_dropped";
export const REFERENCE_UNRESOLVED_NOTICE_CODE =
  "openai-responses_reference_unresolved";
export const INPUT_FILE_DROPPED_NOTICE_CODE =
  "openai-responses_input_file_dropped";
export const CUSTOM_INPUT_COMPAT_NOTICE_CODE =
  "openai-responses_custom_input_compat";
export const INCOMPLETE_MESSAGE_NOTICE_CODE =
  "openai-responses_incomplete_message";
export const NAMESPACE_COLLISION_NOTICE_CODE =
  "openai-responses_namespace_collision";

/** Separator for the reversible Responses-owned namespace flattening scheme.
 *  A flattened name is `<namespace>.<child>`; the reverse map in render state
 *  recovers the original namespace/child pair for output rendering. */
export const NAMESPACE_SEPARATOR = ".";

/** Responses-owned marker id for the versioned textSignature envelope.
 *  `phase` is preserved here, never injected into model-visible text. */
export const RESPONSES_TEXT_SIGNATURE_ID = "openai-responses";
/** Responses-owned authority for reasoning continuity envelopes. Only an
 *  envelope with this authority may restore `encrypted_content`; a foreign
 *  arbitrary Provider signature is never treated as Responses continuity. */
export const RESPONSES_CONTINUITY_AUTHORITY = "openai-responses";

export interface ResponsesTextSignatureV1 {
  readonly v: 1;
  readonly id: typeof RESPONSES_TEXT_SIGNATURE_ID;
  readonly phase: string;
}

export interface ResponsesContinuityEnvelopeV1 {
  readonly v: 1;
  readonly id: typeof RESPONSES_CONTINUITY_AUTHORITY;
  readonly authority: typeof RESPONSES_CONTINUITY_AUTHORITY;
  readonly item_id?: string;
  readonly encrypted_content: string;
}

const DEFAULT_POLICY: ResponseRequestConversionPolicy = Object.freeze({
  privilegedMessages: "first",
  unknownInputItem: "error",
  orphanToolOutput: "error",
  unresolvedToolCall: "xrepair",
  futureReasoningEffort: "max",
});

const KNOWN_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidRequest(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new InvalidRequest(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidRequest(`${field} must be a finite number when present`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new InvalidRequest(`${field} must be a boolean when present`);
  }
  return value;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function requestNotice(
  code: string,
  action: ConversionNotice["action"],
  jsonPath?: string,
): ConversionNotice {
  return Object.freeze({
    adapter: "openai-responses",
    direction: "request",
    code,
    ...(jsonPath === undefined ? {} : { jsonPath }),
    action,
  });
}

function parseContentParts(content: unknown): TextContent[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const parts: TextContent[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const type = raw.type;
    if (
      (type === "input_text" || type === "text" || type === "output_text") &&
      typeof raw.text === "string"
    ) {
      parts.push({ type: "text", text: raw.text });
      continue;
    }
    // A refusal carries visible text semantics; preserve it as deterministic
    // textual degradation rather than silently dropping the refusal.
    if (type === "refusal" && typeof raw.refusal === "string") {
      parts.push({ type: "text", text: raw.refusal });
    }
  }
  return parts;
}

/** A base64 data URL must carry a MIME type and well-formed base64 content;
 *  malformed data URLs/MIME are a conversion error, never a silent skip. */
function parseDataUrlImage(
  imageUrl: string,
  field: string,
): ImageContent {
  const match = /^data:([^;]+);base64,(.*)$/su.exec(imageUrl);
  if (match === null) {
    throw new InvalidRequest(
      `${field} must be a data URL with a MIME type and base64 payload`,
    );
  }
  const mimeType = match[1] ?? "";
  const data = match[2] ?? "";
  if (mimeType.length === 0) {
    throw new InvalidRequest(`${field} data URL must include a MIME type`);
  }
  if (
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
  ) {
    throw new InvalidRequest(`${field} data URL base64 payload is malformed`);
  }
  return { type: "image", mimeType, data };
}

/** Parse inline base64 data images. A non-data URL or a file_id is not
 *  materialized here: those require the trusted Responses-owned resolver and
 *  are handled by the async entry. */
function parseInlineImages(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  const parts: ImageContent[] = [];
  for (const raw of content) {
    if (!isRecord(raw) || raw.type !== "input_image") continue;
    const imageUrl = raw.image_url;
    if (typeof imageUrl === "string" && imageUrl.startsWith("data:")) {
      parts.push(parseDataUrlImage(imageUrl, "input_image.image_url"));
    }
  }
  return parts;
}

/** Parse images inside tool outputs. A tool output image that is directly
 *  materialized as a data URL maps to Pi ToolResult images on the Client
 *  side; a remote/file_id output image is not fetchable here and is dropped
 *  with the surrounding text retained. `output_image` and
 *  `computer_screenshot` both carry `image_url`. */
function parseOutputImageParts(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  const parts: ImageContent[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type !== "output_image" && raw.type !== "computer_screenshot") {
      continue;
    }
    const imageUrl = raw.image_url;
    if (typeof imageUrl === "string" && imageUrl.startsWith("data:")) {
      parts.push(
        parseDataUrlImage(imageUrl, `${String(raw.type)}.image_url`),
      );
    }
  }
  return parts;
}

/** Extract images that need the trusted Responses-owned resolver: a
 *  `file_id` handle or a remote (non-data) URL. */
function collectResolvableImages(content: unknown): Array<{
  raw: Record<string, unknown>;
  path: string;
}> {
  if (!Array.isArray(content)) return [];
  const images: Array<{ raw: Record<string, unknown>; path: string }> = [];
  for (const [index, raw] of content.entries()) {
    if (!isRecord(raw) || raw.type !== "input_image") continue;
    const fileId = raw.file_id;
    const imageUrl = raw.image_url;
    if (typeof fileId === "string" && fileId.length > 0) {
      images.push({
        raw,
        path: `$.input[?image=${index}].file_id`,
      });
      continue;
    }
    if (
      typeof imageUrl === "string" &&
      imageUrl.length > 0 &&
      !imageUrl.startsWith("data:")
    ) {
      images.push({
        raw,
        path: `$.input[?image=${index}].image_url`,
      });
    }
  }
  return images;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
    throw new InvalidRequest("function_call arguments must be a JSON object");
  } catch (error) {
    if (error instanceof InvalidRequest) throw error;
    throw new InvalidRequest("function_call arguments must be valid JSON");
  }
}

/** A custom tool grammar maps directly to Pi constrainedSampling grammar
 *  variants (Lark → openai_lark, regex → openai_regex); an unknown grammar
 *  variant type is a conversion error, never a silent drop.
 *
 *  The installed SDK models custom-tool grammar under `format` as
 *  {type:"grammar", definition, syntax:"lark"|"regex"}; an older `grammar`
 *  field shape ({type:"lark"|"regex", grammar|regex}) is also accepted.
 */
function convertCustomGrammar(
  grammar: unknown,
  name: string,
): Tool["constrainedSampling"] {
  if (grammar === undefined || grammar === null) return undefined;
  if (!isRecord(grammar) || typeof grammar.type !== "string") {
    throw new InvalidRequest(`custom tool ${name} grammar must be an object`);
  }
  if (grammar.type === "grammar" && typeof grammar.syntax === "string") {
    // SDK shape: {type:"grammar", definition, syntax}.
    const definition = grammar.definition;
    if (typeof definition !== "string" || definition.length === 0) {
      throw new InvalidRequest(
        `custom tool ${name} grammar definition must be a non-empty string`,
      );
    }
    if (grammar.syntax === "lark") {
      return { type: "grammar", variants: { openai_lark: definition } };
    }
    if (grammar.syntax === "regex") {
      return { type: "grammar", variants: { openai_regex: definition } };
    }
    throw new InvalidRequest(
      `custom tool ${name} grammar syntax is not supported: ${String(grammar.syntax)}`,
    );
  }
  if (grammar.type === "lark" && typeof grammar.grammar === "string") {
    return {
      type: "grammar",
      variants: { openai_lark: grammar.grammar },
    };
  }
  if (grammar.type === "regex" && typeof grammar.regex === "string") {
    return {
      type: "grammar",
      variants: { openai_regex: grammar.regex },
    };
  }
  throw new InvalidRequest(
    `custom tool ${name} grammar variant is not supported: ${String(grammar.type)}`,
  );
}

function convertTools(
  value: unknown,
  freeformNames?: Set<string>,
  namespaceReverse?: Record<string, { namespace: string; child: string }>,
  notices?: ConversionNotice[],
): Tool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new InvalidRequest("tools must be an array when present");
  }
  const tools: Tool[] = [];
  const names = new Set<string>();

  const pushFunction = (
    name: string,
    description: string,
    rawParameters: unknown,
    strict?: unknown,
    constrainedSampling?: Tool["constrainedSampling"],
  ): void => {
    // Duplicate names after flattening are an error: the reversible
    // namespace scheme must remain unambiguous.
    if (names.has(name)) {
      throw new InvalidRequest(
        `tool name collision after namespace flattening: ${name}`,
      );
    }
    names.add(name);
    // Codex clients may send tool definitions whose `parameters` is absent,
    // non-object, or missing the `type` marker (e.g. built-in shell/apply
    // tools). Normalize the same way opencodex does: wrap non-objects in a
    // JSON Schema object and force `type: "object"` so the Pi Tool contract
    // is always satisfied without rejecting the official client.
    const normalizedParameters: Record<string, unknown> = {
      ...(isRecord(rawParameters) ? rawParameters : {}),
      type: "object",
    };
    const tool: Tool = {
      name,
      description,
      parameters: normalizedParameters,
    };
    if (strict === true) {
      tool.constrainedSampling = { type: "json_schema", strict: "require" };
    } else if (constrainedSampling !== undefined) {
      tool.constrainedSampling = constrainedSampling;
    }
    tools.push(tool);
  };

  /** Flatten one namespace child under `<namespace>.<child>`, recording the
   *  reverse mapping in request-local render state. */
  const pushNamespaceChild = (
    namespace: string,
    inner: unknown,
  ): void => {
    if (!isRecord(inner) || typeof inner.name !== "string" || inner.name.length === 0) {
      return;
    }
    const childName = inner.name;
    const flatName = `${namespace}${NAMESPACE_SEPARATOR}${childName}`;
    const description =
      typeof inner.description === "string" ? inner.description : "";
    if (inner.type === "function") {
      pushFunction(
        flatName,
        description,
        inner.parameters,
        // The installed SDK defaults function `strict` to true.
        inner.strict ?? true,
        convertCustomGrammar(inner.format ?? inner.grammar, flatName),
      );
    } else if (inner.type === "custom") {
      freeformNames?.add(flatName);
      pushFunction(
        flatName,
        description,
        {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Raw tool input.",
            },
          },
          required: ["input"],
        },
        undefined,
        convertCustomGrammar(inner.format ?? inner.grammar, flatName),
      );
    }
    namespaceReverse![flatName] = { namespace, child: childName };
  };

  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) {
      throw new InvalidRequest(`tools[${index}] must be an object`);
    }
    // defer_loading that requires tool-search discovery is a Core v1
    // conversion error; it never silently becomes a normal executable tool.
    if (candidate.defer_loading === true) {
      throw new InvalidRequest(
        "defer_loading tool discovery is not supported by Core conversion v1",
      );
    }
    const type = candidate.type;
    const name = candidate.name;
    const description =
      typeof candidate.description === "string" ? candidate.description : "";

    if (type === "function" && typeof name === "string" && name.length > 0) {
      pushFunction(
        name,
        description,
        candidate.parameters,
        // The installed SDK defaults function `strict` to true; absent strict
        // maps to Pi constrainedSampling require.
        candidate.strict ?? true,
        convertCustomGrammar(candidate.format ?? candidate.grammar, name),
      );
      continue;
    }
    if (type === "custom" && typeof name === "string" && name.length > 0) {
      // Freeform custom tool (e.g. apply_patch): expose as a function with a
      // single string `input` carrying the raw tool body.
      freeformNames?.add(name);
      pushFunction(
        name,
        description,
        {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Raw tool input.",
            },
          },
          required: ["input"],
        },
        undefined,
        convertCustomGrammar(candidate.format ?? candidate.grammar, name),
      );
      continue;
    }
    if (type === "namespace" && typeof name === "string" && name.length > 0) {
      // MCP tools arrive grouped under a namespace tool; flatten inner
      // function/custom tools with the reversible Responses-owned scheme.
      if (!Array.isArray(candidate.tools)) {
        throw new InvalidRequest(
          `namespace tool ${name} must have a tools array`,
        );
      }
      for (const inner of candidate.tools) {
        pushNamespaceChild(name, inner);
      }
      void notices;
      continue;
    }
    // ---- Ticket 16: complete installed tool-definition family matrix ----
    // Client/BYOT executable families (local shell, shell, apply patch,
    // computer/computer_use, mcp) map into the Pi catalog as documented
    // action/operation schemas. Provider/server-hosted declarations
    // (file_search, web_search/preview, image_generation, code_interpreter)
    // are dropped: advertising them as executable Pi tools would mislead the
    // model. tool_search is a Core v1 conversion error, not a plain unknown.
    if (
      type === "local_shell" ||
      type === "shell" ||
      type === "apply_patch" ||
      type === "computer" ||
      type === "computer_use" ||
      type === "computer_use_preview" ||
      type === "mcp"
    ) {
      // The installed SDK models computer/computer_use_preview, apply_patch,
      // local_shell and shell without a name field; they map to deterministic
      // Responses-owned names so call ownership can be classified.
      // Viewport/environment fields without Pi slots drop.
      const effectiveName =
        (type === "computer" || type === "computer_use_preview") &&
        (typeof name !== "string" || name.length === 0)
          ? "computer"
          : (type === "apply_patch" ||
              type === "local_shell" ||
              type === "shell") &&
              (typeof name !== "string" || name.length === 0)
            ? type
            : typeof name === "string" && name.length > 0
              ? name
              : undefined;
      if (effectiveName === undefined) continue;
      if (type === "apply_patch") {
        freeformNames?.add(effectiveName);
      }
      if (type === "apply_patch") {
        pushFunction(
          effectiveName,
          description,
          {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "Raw patch input.",
              },
            },
            required: ["input"],
          },
          undefined,
          convertCustomGrammar(candidate.format ?? candidate.grammar, effectiveName),
        );
      } else {
        // MCP tools carry their argument schema under `arguments`; other
        // Client/BYOT families use `parameters`.
        const rawSchema =
          type === "mcp" ? candidate.arguments : candidate.parameters;
        pushFunction(
          effectiveName,
          description,
          rawSchema ?? { type: "object" },
          candidate.strict,
          convertCustomGrammar(candidate.format ?? candidate.grammar, effectiveName),
        );
      }
      continue;
    }
    // A bare tool_search tool declaration (without defer_loading) is a
    // hosted discovery capability, dropped like other hosted declarations:
    // the local Provider cannot execute it and advertising it would mislead
    // the model. A defer_loading=true that requires discovery is an error
    // (handled at the top of this loop); tool_search_call/output input items
    // are Core v1 conversion errors in the message converter.
    // OpenAI-hosted server-side tools (web_search, image_generation, ...) are
    // intentionally skipped for the same reason. Tools with a non-string name
    // are also skipped (opencodex parity).
  }
  return tools;
}

/**
 * Convert `reasoning.effort` per the frozen matrix:
 *   absent/null/none → omission (none is documented explicit-off degradation)
 *   minimal..xhigh   → direct
 *   ultra            → max (compatibility notice)
 *   max              → max
 *   future unknown   → futureReasoningEffort policy (max|omit|error), notice on max/omit
 */
function convertReasoning(
  value: unknown,
  futureReasoningEffort: ResponseRequestConversionPolicy["futureReasoningEffort"],
  notices: ConversionNotice[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new InvalidRequest("reasoning must be an object when present");
  }
  const effort = value.effort;
  if (effort === undefined || effort === null) return undefined;
  if (typeof effort !== "string" || effort.trim().length === 0) {
    throw new InvalidRequest(
      "reasoning.effort must be a non-empty string when present",
    );
  }
  if (effort === "none") {
    // Documented explicit-off degradation: omission is not claimed to be an
    // explicit Provider off, and the caller asked for none.
    notices.push(
      requestNotice(EFFORT_NONE_OMITTED_NOTICE_CODE, "degrade", "$.reasoning.effort"),
    );
    return undefined;
  }
  if (effort === "ultra") {
    notices.push(
      requestNotice(ULTRA_ALIAS_NOTICE_CODE, "degrade", "$.reasoning.effort"),
    );
    return "max";
  }
  if (effort === "max") return "max";
  if (KNOWN_EFFORTS.has(effort)) return effort;
  // Future unknown effort value.
  if (futureReasoningEffort === "error") {
    throw new InvalidRequest(
      `reasoning.effort is not a known thinking level: ${effort}`,
    );
  }
  notices.push(
    requestNotice(FUTURE_EFFORT_NOTICE_CODE, "degrade", "$.reasoning.effort"),
  );
  return futureReasoningEffort === "max" ? "max" : undefined;
}

function parseToolChoice(value: unknown): string | undefined {
  // "none" | "auto" | "required" | {type:"allowed"|"function"|...}
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value === "none" || value === "auto" || value === "required") {
      return value;
    }
    throw new InvalidRequest(`unsupported tool_choice: ${value}`);
  }
  if (!isRecord(value)) {
    throw new InvalidRequest("tool_choice must be a string or object when present");
  }
  const type = value.type;
  if (type === "allowed") {
    return "allowed";
  }
  if (
    type === "function" ||
    type === "custom" ||
    type === "namespace" ||
    type === "mcp" ||
    type === "shell" ||
    type === "apply_patch"
  ) {
    return "forced";
  }
  throw new InvalidRequest(`unsupported tool_choice.type: ${String(type)}`);
}

export function validateResponsesRequest(
  value: unknown,
  freeformNames?: Set<string>,
  namespaceReverse?: Record<string, { namespace: string; child: string }>,
): ValidatedResponsesRequest {
  if (!isRecord(value)) {
    throw new InvalidRequest("Request body must be a JSON object");
  }
  const selector = nonEmptyString(value.model, "model");
  const input = value.input;
  if (typeof input !== "string" && !Array.isArray(input)) {
    throw new InvalidRequest("input must be a string or an array");
  }
  const stream = optionalBoolean(value.stream, "stream") ?? false;
  const previousResponseId = value.previous_response_id;
  if (
    previousResponseId !== undefined &&
    previousResponseId !== null &&
    (typeof previousResponseId !== "string" || previousResponseId.length === 0)
  ) {
    throw new InvalidRequest(
      "previous_response_id must be a non-empty string when present",
    );
  }
  if (
    value.store !== undefined &&
    value.store !== null &&
    typeof value.store !== "boolean"
  ) {
    throw new InvalidRequest("store must be a boolean when present");
  }
  if (value.tool_choice !== undefined && value.tool_choice !== null) {
    const toolChoice = value.tool_choice;
    if (
      typeof toolChoice !== "string" &&
      (typeof toolChoice !== "object" ||
        toolChoice === null ||
        Array.isArray(toolChoice))
    ) {
      throw new InvalidRequest(
        "tool_choice must be a string or object when present",
      );
    }
    if (
      isRecord(toolChoice) &&
      toolChoice.type === "allowed" &&
      !Array.isArray(toolChoice.allowed_tools)
    ) {
      throw new InvalidRequest(
        "tool_choice.allowed_tools must be an array when present",
      );
    }
    if (
      isRecord(toolChoice) &&
      toolChoice.type === "allowed" &&
      Array.isArray(toolChoice.allowed_tools) &&
      toolChoice.allowed_tools.some((entry) => typeof entry !== "string")
    ) {
      throw new InvalidRequest(
        "tool_choice.allowed_tools must contain only strings",
      );
    }
  }
  validateReasoningShape(value.reasoning);
  if (value.background === true) {
    throw new InvalidRequest(
      "background=true is not supported by Core conversion v1",
    );
  }
  if (value.conversation !== undefined) {
    throw new InvalidRequest(
      "conversation is not supported by Core conversion v1",
    );
  }
  if (value.prompt !== undefined) {
    throw new InvalidRequest("prompt is not supported by Core conversion v1");
  }
  const maxOutputTokens = optionalNonNegativeInt(
    value.max_output_tokens,
    "max_output_tokens",
  );
  const temperature = optionalFiniteNumber(value.temperature, "temperature");
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    throw new InvalidRequest("temperature must be within 0 through 2");
  }
  const topP = optionalFiniteNumber(value.top_p, "top_p");
  if (topP !== undefined && (topP < 0 || topP > 1)) {
    throw new InvalidRequest("top_p must be within 0 through 1");
  }
  const cacheRetentionValue = value.prompt_cache_retention;
  let cacheRetention: "short" | "long" | undefined;
  if (cacheRetentionValue !== undefined && cacheRetentionValue !== null) {
    if (cacheRetentionValue === "in-memory") cacheRetention = "short";
    else if (cacheRetentionValue === "24h") cacheRetention = "long";
    else {
      throw new InvalidRequest(
        "prompt_cache_retention must be in-memory or 24h when present",
      );
    }
  }
  const safetyIdentifier = value.safety_identifier;
  const userValue = value.user;
  let metadataUserId: string | undefined;
  if (safetyIdentifier !== undefined && safetyIdentifier !== null) {
    if (typeof safetyIdentifier !== "string") {
      throw new InvalidRequest("safety_identifier must be a string when present");
    }
    metadataUserId = safetyIdentifier;
  } else if (userValue !== undefined && userValue !== null) {
    if (typeof userValue !== "string") {
      throw new InvalidRequest("user must be a string when present");
    }
    metadataUserId = userValue;
  }
  const tools = convertTools(value.tools, freeformNames, namespaceReverse);
  const toolChoice = parseToolChoice(value.tool_choice);
  const background = optionalBoolean(value.background, "background") ?? false;
  const conversationPresent = value.conversation !== undefined;
  const promptPresent = value.prompt !== undefined;
  const instructions =
    value.instructions === undefined || value.instructions === null
      ? undefined
      : typeof value.instructions === "string"
        ? value.instructions
        : (() => {
            throw new InvalidRequest("instructions must be a string when present");
          })();

  const validated: ValidatedResponsesRequest = {
    selector,
    input,
    stream,
    background,
    conversationPresent,
    promptPresent,
  };
  if (instructions !== undefined) validated.instructions = instructions;
  if (maxOutputTokens !== undefined) validated.maxOutputTokens = maxOutputTokens;
  if (temperature !== undefined) validated.temperature = temperature;
  if (topP !== undefined) validated.topP = topP;
  if (cacheRetention !== undefined) validated.cacheRetention = cacheRetention;
  if (metadataUserId !== undefined) validated.metadataUserId = metadataUserId;
  if (tools !== undefined) validated.tools = tools;
  if (toolChoice !== undefined) validated.toolChoice = toolChoice;
  return validated;
}

/** Validate the reasoning field shape; the effort matrix is applied in the
 *  conversion entries where the policy and notices are available. */
function validateReasoningShape(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    throw new InvalidRequest("reasoning must be an object when present");
  }
  const effort = value.effort;
  if (effort === undefined || effort === null) return;
  if (typeof effort !== "string" || effort.trim().length === 0) {
    throw new InvalidRequest(
      "reasoning.effort must be a non-empty string when present",
    );
  }
}

function convertMessages(
  input: unknown,
  selector: string,
  receivedAt: number,
  additionalTools: unknown[],
  policy: ResponseRequestConversionPolicy,
  notices: ConversionNotice[],
  executableNames?: ReadonlySet<string>,
): Message[] {
  const messages: Message[] = [];
  const pendingReasoning: ThinkingContent[] = [];
  const assistantIndex = new Map<string, string>();
  const resolvedCallIds = new Set<string>();
  let seenFirstUser = false;
  const privilegedMode = policy.privilegedMessages;

  const flushAssistant = (
    content: Array<TextContent | ThinkingContent | ToolCall>,
  ): void => {
    const assistant: Message = {
      role: "assistant",
      api: SYNTHETIC_CLIENT_HISTORY_API,
      provider: SYNTHETIC_CLIENT_HISTORY_PROVIDER,
      model: selector,
      content,
      usage: emptyUsage(),
      stopReason: content.some((block) => block.type === "toolCall")
        ? "toolUse"
        : "stop",
      timestamp: receivedAt,
    };
    messages.push(assistant);
    for (const block of content) {
      if (block.type === "toolCall") assistantIndex.set(block.id, block.name);
    }
  };

  /** Reasoning pending without an assistant carrier is preserved as its own
   *  reasoning-only assistant message; trailing reasoning never disappears. */
  const flushPendingReasoning = (): void => {
    if (pendingReasoning.length === 0) return;
    flushAssistant([...pendingReasoning]);
    pendingReasoning.length = 0;
  };

  /** Close every call that is still unresolved at a semantic history
   *  boundary (a new user turn or the end of input) per the frozen
   *  unresolvedToolCall policy. */
  const closeUnresolvedCalls = (): void => {
    if (policy.unresolvedToolCall === "error") {
      for (const [callId] of assistantIndex) {
        if (!resolvedCallIds.has(callId)) {
          throw new InvalidRequest(
            `unresolved function_call has no result: ${callId}`,
          );
        }
      }
      return;
    }
    for (const [callId, name] of assistantIndex) {
      repairUnresolvedCall(callId, name);
    }
  };

  /** Close a known missing call with the Responses-owned synthetic result
   *  when the configured policy is xrepair. The synthetic result preserves
   *  call ID and tool name, is isError, and never replaces a real result. */
  const repairUnresolvedCall = (
    callId: string,
    name: string,
  ): void => {
    if (resolvedCallIds.has(callId)) return;
    resolvedCallIds.add(callId);
    notices.push(
      requestNotice(
        "openai-responses_unresolved_call_repaired",
        "xrepair",
        `$.input[?call_id=${callId}]`,
      ),
    );
    messages.push({
      role: "toolResult",
      toolCallId: callId,
      toolName: name,
      content: [
        {
          type: "text",
          text: "No result — the tool call did not complete (interrupted or lost).",
        },
      ],
      isError: true,
      timestamp: receivedAt,
    });
  };

  const pushUser = (text: string): void => {
    messages.push({
      role: "user",
      content: text.length === 0 ? [] : [{ type: "text", text }],
      timestamp: receivedAt,
    });
  };

  const items: unknown[] =
    typeof input === "string"
      ? [{ role: "user", content: input }]
      : (input as unknown[]);
  for (const rawItem of items) {
    if (!isRecord(rawItem)) continue;
    const type =
      rawItem.type ?? (typeof rawItem.role === "string" ? "message" : undefined);
    if (type === undefined) continue;

    switch (type) {
      case "message": {
        const role = rawItem.role;
        // Historical message status: absent/completed convert normally;
        // in_progress is a structured lifecycle error; incomplete preserves
        // representable content only and never injects notice text or guesses
        // length.
        const status = rawItem.status;
        if (status !== undefined && status !== null) {
          if (typeof status !== "string" || status.length === 0) {
            throw new InvalidRequest("message status must be a non-empty string");
          }
          if (status === "in_progress") {
            throw new InvalidRequest(
              "a message with status in_progress cannot be converted",
            );
          }
          if (status !== "completed" && status !== "incomplete") {
            throw new InvalidRequest(
              `message status is not supported: ${status}`,
            );
          }
          if (status === "incomplete") {
            // A non-model-visible request-local diagnostic records the
            // incomplete status; notice text is never injected into the
            // model-visible content.
            notices.push(
              requestNotice(
                INCOMPLETE_MESSAGE_NOTICE_CODE,
                "degrade",
                `$.input[?type=message&status=incomplete]`,
              ),
            );
          }
        }
        // A file_id or remote image URL can only be materialized through the
        // trusted Responses-owned resolver. The async entry resolves these
        // before conversion, so any that survive to this point mean no
        // resolver handled them: that is a conversion error, never a silent
        // skip or a fabricated placeholder.
        const unresolvableImages = collectResolvableImages(rawItem.content);
        if (unresolvableImages.length > 0) {
          throw new InvalidRequest(
            `input_image ${unresolvableImages[0]?.path} requires a trusted Responses-owned resolver`,
          );
        }
        const content = parseContentParts(rawItem.content);
        const images = parseInlineImages(rawItem.content);
        if (role === "system" || role === "developer") {
          const text = content.map((part) => part.text).join("");
          const promote =
            privilegedMode === "full" ||
            (privilegedMode === "first" && !seenFirstUser);
          if (!promote) {
            // Degraded to a user message, preserving source order.
            pushUser(text);
          }
          pendingReasoning.length = 0;
          continue;
        }
        if (role === "user") {
          seenFirstUser = true;
          // A semantic history boundary: any call opened earlier that never
          // received a result is closed now (or errors under the frozen
          // policy).
          closeUnresolvedCalls();
          // A reasoning item followed by a user message has no assistant
          // carrier; it is preserved as its own reasoning-only assistant
          // message so it never disappears.
          flushPendingReasoning();
          // Generic non-image files have no Pi FileContent: they are dropped
          // and recorded as a fixed known degradation without fabricating a
          // marker or an empty message. A message that carried only files is
          // dropped entirely.
          const fileParts = Array.isArray(rawItem.content)
            ? rawItem.content.filter(
                (part): part is Record<string, unknown> =>
                  isRecord(part) && part.type === "input_file",
              )
            : [];
          if (fileParts.length > 0) {
            notices.push(
              requestNotice(
                INPUT_FILE_DROPPED_NOTICE_CODE,
                "ignore",
                `$.input[?role=user].content[?type=input_file]`,
              ),
            );
          }
          const nonFileParts = Array.isArray(rawItem.content)
            ? rawItem.content.filter(
                (part) => !isRecord(part) || part.type !== "input_file",
              )
            : [];
          if (
            fileParts.length > 0 &&
            nonFileParts.length === 0 &&
            content.length === 0 &&
            images.length === 0
          ) {
            continue;
          }
          const blocks = [...content, ...images];
          messages.push({
            role: "user",
            content: blocks,
            timestamp: receivedAt,
          });
          continue;
        }
        if (role === "assistant") {
          const phase = rawItem.phase;
          // Message `phase` is preserved in a versioned Responses-owned text
          // signature; it is never injected into model-visible text.
          if (
            typeof phase === "string" &&
            phase.length > 0 &&
            content.length > 0
          ) {
            const envelope: ResponsesTextSignatureV1 = {
              v: 1,
              id: RESPONSES_TEXT_SIGNATURE_ID,
              phase,
            };
            const signature = JSON.stringify(envelope);
            content[0] = { ...content[0], textSignature: signature } as TextContent;
          }
          const blocks: Array<TextContent | ThinkingContent | ToolCall> = [
            ...pendingReasoning,
            ...content,
          ];
          pendingReasoning.length = 0;
          flushAssistant(blocks);
          continue;
        }
        throw new InvalidRequest(`message role is not supported: ${String(role)}`);
      }
      case "reasoning": {
        // Reasoning items carry their own lifecycle status
        // (in_progress|completed|incomplete in the SDK). in_progress is a
        // structured lifecycle error; incomplete preserves representable
        // content without injecting notice text or guessing length; absent/
        // completed convert normally.
        const status = rawItem.status;
        if (status !== undefined && status !== null) {
          if (typeof status !== "string" || status.length === 0) {
            throw new InvalidRequest(
              "reasoning status must be a non-empty string",
            );
          }
          if (status === "in_progress") {
            throw new InvalidRequest(
              "a reasoning item with status in_progress cannot be converted",
            );
          }
          if (status !== "completed" && status !== "incomplete") {
            throw new InvalidRequest(
              `reasoning status is not supported: ${status}`,
            );
          }
          if (status === "incomplete") {
            // A non-model-visible request-local diagnostic records the
            // incomplete reasoning status.
            notices.push(
              requestNotice(
                INCOMPLETE_MESSAGE_NOTICE_CODE,
                "degrade",
                `$.input[?type=reasoning&status=incomplete]`,
              ),
            );
          }
        }
        const summary = Array.isArray(rawItem.summary)
          ? rawItem.summary
              .filter(isRecord)
              .map((part) => (typeof part.text === "string" ? part.text : ""))
              .join("")
          : "";
        const content = Array.isArray(rawItem.content)
          ? rawItem.content
              .filter(isRecord)
              .map((part) => (typeof part.text === "string" ? part.text : ""))
              .join("")
          : "";
        const thinking = summary || content;
        if (thinking.length > 0 || typeof rawItem.encrypted_content === "string") {
          const block: ThinkingContent = { type: "thinking", thinking };
          // Responses-native continuity state enters a versioned
          // provenance-bearing envelope. Only this adapter's authority may
          // restore `encrypted_content`; an arbitrary foreign signature never
          // does.
          const encrypted = rawItem.encrypted_content;
          if (typeof encrypted === "string" && encrypted.length > 0) {
            const envelope: ResponsesContinuityEnvelopeV1 = {
              v: 1,
              id: RESPONSES_CONTINUITY_AUTHORITY,
              authority: RESPONSES_CONTINUITY_AUTHORITY,
              ...(typeof rawItem.id === "string"
                ? { item_id: rawItem.id }
                : {}),
              encrypted_content: encrypted,
            };
            block.thinkingSignature = JSON.stringify(envelope);
          }
          // Trailing reasoning after an assistant message attaches to that
          // assistant turn and never disappears.
          const last = messages.at(-1);
          if (last?.role === "assistant") {
            (
              last.content as Array<TextContent | ThinkingContent | ToolCall>
            ).push(block);
          } else {
            pendingReasoning.push(block);
          }
        }
        continue;
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call":
      case "shell_call":
      case "apply_patch_call":
      case "computer_call":
      case "mcp_call": {
        // computer and MCP calls map structurally only when the execution
        // ownership is Client/BYOT, i.e. the name appears in the executable
        // Client catalog. A provider-hosted form degrades to an ordered
        // content/transcript drop and is never advertised as a Pi tool.
        if (type === "computer_call" || type === "mcp_call") {
          const name = rawItem.name;
          const owned =
            typeof name === "string" && executableNames?.has(name) === true;
          if (!owned) {
            pendingReasoning.length = 0;
            continue;
          }
        }
        // Structured tool status: absent/completed are eligible;
        // in_progress/incomplete/unknown structured status is an error.
        const status = rawItem.status;
        if (status !== undefined && status !== null) {
          if (typeof status !== "string" || status.length === 0) {
            throw new InvalidRequest("tool call status must be a non-empty string");
          }
          if (status !== "completed" && status !== "in_progress") {
            throw new InvalidRequest(
              `tool call status is not supported: ${status}`,
            );
          }
          if (status === "in_progress") {
            throw new InvalidRequest(
              "a tool call with status in_progress cannot be converted",
            );
          }
        }
        // The installed SDK models mcp_call with `id` as the tool-call key
        // (no separate call_id field); other families carry call_id.
        const callId =
          type === "mcp_call"
            ? nonEmptyString(rawItem.id, "mcp_call.id")
            : nonEmptyString(rawItem.call_id, "function_call.call_id");
        const name = nonEmptyString(rawItem.name, "function_call.name");
        if (type === "custom_tool_call") {
          // Custom freeform input uses the approved {input:string}
          // compatibility representation with a Responses-local notice.
          notices.push(
            requestNotice(
              CUSTOM_INPUT_COMPAT_NOTICE_CODE,
              "degrade",
              `$.input[?call_id=${callId}]`,
            ),
          );
        }
        // local_shell/shell/apply_patch/computer/mcp calls are Client/BYOT
        // structured tool calls. The installed SDK models local_shell/shell/
        // computer with a structured `action` object, apply_patch with an
        // `operation` object, and mcp/function with a JSON `arguments` string.
        // Structured objects map losslessly; otherwise the legacy JSON
        // arguments string applies.
        let argumentsJson: Record<string, unknown>;
        if (type === "custom_tool_call") {
          argumentsJson = {
            input: typeof rawItem.input === "string" ? rawItem.input : "",
          };
        } else if (isRecord(rawItem.action)) {
          argumentsJson = { ...rawItem.action };
        } else if (isRecord(rawItem.operation)) {
          argumentsJson = { ...rawItem.operation };
        } else {
          argumentsJson = parseToolArguments(rawItem.arguments);
        }
        const toolCall: ToolCall = {
          type: "toolCall",
          id: callId,
          name,
          arguments: argumentsJson,
        };
        // Find or create the assistant container.
        const last = messages.at(-1);
        if (last?.role === "assistant") {
          (
            last.content as Array<TextContent | ThinkingContent | ToolCall>
          ).push(toolCall);
          assistantIndex.set(toolCall.id, toolCall.name);
        } else {
          flushAssistant([...pendingReasoning, toolCall]);
        }
        pendingReasoning.length = 0;
        continue;
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output":
      case "shell_call_output":
      case "apply_patch_call_output":
      case "computer_call_output": {
        // A provider-hosted computer output has no correlated structured
        // call in the executable catalog; it degrades to a transcript drop.
        if (type === "computer_call_output") {
          const callId = rawItem.call_id;
          if (
            typeof callId !== "string" ||
            !assistantIndex.has(callId) ||
            !(executableNames?.has(assistantIndex.get(callId) ?? "") === true)
          ) {
            pendingReasoning.length = 0;
            continue;
          }
        }
        // Structured tool output status: absent/completed are eligible;
        // in_progress/incomplete/unknown structured status is an error.
        const status = rawItem.status;
        if (status !== undefined && status !== null) {
          if (typeof status !== "string" || status.length === 0) {
            throw new InvalidRequest(
              "tool output status must be a non-empty string",
            );
          }
          if (status !== "completed" && status !== "in_progress") {
            throw new InvalidRequest(
              `tool output status is not supported: ${status}`,
            );
          }
          if (status === "in_progress") {
            throw new InvalidRequest(
              "a tool output with status in_progress cannot be converted",
            );
          }
        }
        // The installed SDK models local_shell_call_output with `id` as the
        // correlation key (no separate call_id field); other output families
        // carry call_id.
        const callId =
          type === "local_shell_call_output"
            ? nonEmptyString(rawItem.id, "local_shell_call_output.id")
            : nonEmptyString(rawItem.call_id, "function_call_output.call_id");
        const toolName = assistantIndex.get(callId);
        if (toolName === undefined) {
          // Orphan output follows the frozen orphanToolOutput policy.
          if (policy.orphanToolOutput === "error") {
            throw new InvalidRequest(
              `function_call_output references an unknown call_id: ${callId}`,
            );
          }
          notices.push(
            requestNotice(
              "openai-responses_orphan_tool_output_ignored",
              "ignore",
              `$.input[?call_id=${callId}]`,
            ),
          );
          pendingReasoning.length = 0;
          continue;
        }
        // A duplicate result for an already-resolved call is a fixed error.
        if (resolvedCallIds.has(callId)) {
          throw new InvalidRequest(
            `function_call_output has a duplicate result for call_id: ${callId}`,
          );
        }
        resolvedCallIds.add(callId);
        const output = rawItem.output;
        // The installed SDK models computer_call_output.output as a single
        // screenshot object (an array form is tolerated for compatibility);
        // other output families use a string or an array.
        const outputParts =
          type === "computer_call_output"
            ? isRecord(output)
              ? [output]
              : Array.isArray(output)
                ? output
                : []
            : Array.isArray(output)
              ? output
              : [];
        const text =
          typeof output === "string"
            ? output
            : (() => {
                const texts: string[] = [];
                for (const part of outputParts) {
                  if (!isRecord(part)) continue;
                  if (
                    (part.type === "input_text" || part.type === "text") &&
                    typeof part.text === "string"
                  ) {
                    texts.push(part.text);
                    continue;
                  }
                  // The installed SDK models shell_call_output.output as an
                  // array of {stdout, stderr, outcome} chunks; representable
                  // stdout/stderr degrades to ordered transcript content.
                  if (typeof part.stdout === "string") {
                    texts.push(part.stdout);
                  }
                  if (typeof part.stderr === "string" && part.stderr.length > 0) {
                    texts.push(part.stderr);
                  }
                }
                return texts.join("\n");
              })();
        // Output images remain Pi ToolResult images on the Client side.
        const images = parseOutputImageParts(outputParts);
        const content: Array<TextContent | ImageContent> =
          text.length === 0 && images.length === 0
            ? []
            : [
                ...(text.length === 0
                  ? []
                  : ([{ type: "text", text }] as TextContent[])),
                ...images,
              ];
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: callId,
          toolName,
          content,
          isError: false,
          timestamp: receivedAt,
        };
        messages.push(result);
        pendingReasoning.length = 0;
        continue;
      }
      case "compaction":
      case "compaction_summary":
      case "context_compaction": {
        const encrypted = rawItem.encrypted_content;
        if (typeof encrypted === "string" && encrypted.length > 0) {
          // Foreign encrypted-only compaction: error, never fabricate bytes.
          throw new InvalidRequest(
            "compaction with foreign encrypted content cannot be converted",
          );
        }
        pendingReasoning.length = 0;
        continue;
      }
      case "item_reference": {
        // External/unknown item_reference: error (no fail-open). Lucky-owned
        // references are resolved by the async entry before conversion.
        throw new InvalidRequest(
          "item_reference cannot be resolved without a Lucky-owned envelope",
        );
      }
      case "agent_message": {
        const content = parseContentParts(rawItem.content);
        const text =
          content.map((part) => part.text).join("") ||
          "(sub-agent message received)";
        pendingReasoning.length = 0;
        messages.push({
          role: "user",
          content: [{ type: "text", text }],
          timestamp: receivedAt,
        });
        continue;
      }
      // ---- Ticket 16: complete installed input-item family matrix ----
      // Provider/server-hosted lifecycle families degrade to ordered
      // content/transcript or a deterministic drop; they are never advertised
      // as executable Pi tools.
      case "web_search_call":
      case "web_search_tool_call":
      case "compaction_trigger":
        pendingReasoning.length = 0;
        continue;
      case "image_generation_call": {
        // Hosted image-generation history: a result that is directly
        // materialized as a data URL (MIME-bearing) within Client image
        // limits maps to a Pi image. A bare base64 result carries no MIME, so
        // it drops rather than guessing a format; the result is never
        // advertised as an executable Pi tool.
        const result = rawItem.result;
        if (typeof result === "string" && result.startsWith("data:")) {
          const images = parseInlineImages([
            { type: "input_image", image_url: result },
          ]);
          if (images.length > 0) {
            messages.push({
              role: "user",
              content: images,
              timestamp: receivedAt,
            });
          }
        }
        pendingReasoning.length = 0;
        continue;
      }
      case "file_search_call": {
        // Hosted file-search history: representable result text degrades to
        // an ordered transcript; pure metadata (file ids, filenames, scores)
        // never enters Pi.
        const results = rawItem.results;
        if (Array.isArray(results)) {
          for (const entry of results) {
            if (isRecord(entry) && typeof entry.text === "string") {
              pushUser(entry.text);
            }
          }
        }
        pendingReasoning.length = 0;
        continue;
      }
      case "code_interpreter_call": {
        // Hosted code-interpreter history: representable log output degrades
        // to an ordered transcript; images and pure lifecycle metadata
        // (container id, code) never enter Pi.
        const outputs = rawItem.outputs;
        if (Array.isArray(outputs)) {
          for (const entry of outputs) {
            if (isRecord(entry) && typeof entry.logs === "string") {
              pushUser(entry.logs);
            }
          }
        }
        pendingReasoning.length = 0;
        continue;
      }
      // MCP list/approval lifecycles have no Pi approval lifecycle. Only
      // model-visible decision text survives as a deterministic transcript;
      // pure metadata drops. Credentials/headers never enter Pi.
      case "mcp_list_tools": {
        pendingReasoning.length = 0;
        continue;
      }
      case "mcp_approval_request":
      case "mcp_approval_response": {
        const decision = rawItem.decision;
        if (typeof decision === "string" && decision.length > 0) {
          pushUser(decision);
        }
        pendingReasoning.length = 0;
        continue;
      }
      // tool_search is a Core v1 conversion error: deferred dynamic discovery
      // is unsupported. It is not a plain unknown discriminator.
      case "tool_search_call":
      case "tool_search_output":
        throw new InvalidRequest(
          "tool_search lifecycle is not supported by Core conversion v1",
        );
      case "additional_tools": {
        const additional = rawItem.tools;
        if (Array.isArray(additional)) {
          additionalTools.push(...additional);
        }
        continue;
      }
      default:
        if (policy.unknownInputItem === "error") {
          throw new InvalidRequest(`Unsupported input item type: ${String(type)}`);
        }
        notices.push(
          requestNotice(
            UNKNOWN_INPUT_ITEM_IGNORED_NOTICE_CODE,
            "ignore",
            `$.input[?type=${String(type)}]`,
          ),
        );
        continue;
    }
  }

  // Trailing pending reasoning (no following assistant/user message) is
  // preserved as a reasoning-only assistant message.
  flushPendingReasoning();
  // End of input is a semantic history boundary; close unresolved calls.
  closeUnresolvedCalls();

  return messages;
}

/**
 * Expand Lucky-owned provable references/envelopes in the input items,
 * awaiting the narrow resolver, preserving source order. Unresolvable
 * references become notices rather than fabricated fallbacks. The caller's
 * abort signal is forwarded so resolution can be cancelled.
 *
 * `input_image.file_id` and remote image URLs are resolved through the same
 * trusted Responses-owned resolver capability. The resolver receives an
 * explicit Responses authority context and the caller's abort signal plus
 * size/MIME/redirect limits so it can never over-fetch. Resolved items are
 * re-inspected for inline images; an image that stays unresolved is dropped
 * from the message without a fabricated placeholder.
 */
async function resolveLuckyReferences(
  items: readonly unknown[],
  resolver: ResponseReferenceResolver,
  notices: ConversionNotice[],
  signal?: AbortSignal,
  limits?: Readonly<{
    maxBytes?: number;
    maxMimeTypes?: readonly string[];
    maxRedirects?: number;
  }>,
): Promise<unknown[]> {
  const expanded: unknown[] = [];
  for (const rawItem of items) {
    if (!isRecord(rawItem)) {
      expanded.push(rawItem);
      continue;
    }
    const type =
      rawItem.type ?? (typeof rawItem.role === "string" ? "message" : undefined);
    const envelope = rawItem.envelope;
    const isReference = type === "item_reference";
    const isCompaction =
      (type === "compaction" ||
        type === "compaction_summary" ||
        type === "context_compaction") &&
      isRecord(envelope) &&
      typeof envelope.authority === "string";
    if (isReference || isCompaction) {
      if (!isRecord(envelope) || typeof envelope.authority !== "string") {
        expanded.push(rawItem); // External reference; the core errors on it.
        continue;
      }
      try {
        const resolved = await resolver.resolveItemReference(rawItem, {
          authority: envelope.authority,
          ...(signal === undefined ? {} : { signal }),
          limits: limits ?? DEFAULT_REFERENCE_LIMITS,
        });
        expanded.push(...resolved);
      } catch {
        notices.push(
          requestNotice(
            REFERENCE_UNRESOLVED_NOTICE_CODE,
            "ignore",
            `$.input[?id=${String(rawItem.id)}]`,
          ),
        );
      }
      continue;
    }
    if (type === "message") {
      const content = rawItem.content;
      const resolvableImages = collectResolvableImages(content);
      if (resolvableImages.length === 0) {
        expanded.push(rawItem);
        continue;
      }
      // A message that only carried images keeps its position; a message
      // that also has text keeps the text. Resolved images become inline
      // data images in place; unresolved ones are dropped with a notice.
      const resolvedParts: unknown[] = Array.isArray(content)
        ? content.filter((part) => !isRecord(part) || part.type !== "input_image")
        : [];
      let resolvedAny = false;
      for (const image of resolvableImages) {
        try {
          const resolved = await resolver.resolveItemReference(image.raw, {
            authority: RESPONSES_CONTINUITY_AUTHORITY,
            ...(signal === undefined ? {} : { signal }),
            limits: limits ?? DEFAULT_REFERENCE_LIMITS,
          });
          for (const item of resolved) {
            if (isRecord(item) && item.type === "input_image") {
              // Keep the resolved data-URL form so the normal message
              // converter parses it into Pi image bytes in place.
              resolvedParts.push(item);
              resolvedAny = true;
              continue;
            }
            // A resolver may return a full message item carrying the image;
            // splice its content parts into the message in place.
            if (
              isRecord(item) &&
              (item.type === "message" || typeof item.role === "string") &&
              Array.isArray(item.content)
            ) {
              resolvedParts.push(...item.content);
              resolvedAny = true;
            }
          }
        } catch {
          notices.push(
            requestNotice(
              REFERENCE_UNRESOLVED_NOTICE_CODE,
              "ignore",
              image.path,
            ),
          );
        }
      }
      if (!resolvedAny && resolvedParts.length === 0 && typeof content === "string") {
        expanded.push(rawItem);
        continue;
      }
      if (resolvedParts.length === 0 && !resolvedAny) {
        // Image-only message that could not be resolved: drop it rather than
        // fabricate an empty message or a placeholder.
        continue;
      }
      expanded.push({
        ...rawItem,
        content: resolvedParts,
      });
      continue;
    }
    expanded.push(rawItem);
  }
  return expanded;
}

function applyToolChoiceFilter(
  value: unknown,
  mergedTools: Tool[] | undefined,
  toolChoice: string | undefined,
  freeformNames: Set<string>,
  notices: ConversionNotice[],
): { tools: Tool[] | undefined; effective: string | undefined } {
  let effectiveTools = mergedTools;
  let effectiveToolChoice: string | undefined;
  if (toolChoice === "none") {
    effectiveTools = undefined;
    effectiveToolChoice = "none";
  } else if (toolChoice === "allowed") {
    const allowed = (value as Record<string, unknown>).tool_choice as
      | Record<string, unknown>
      | undefined;
    const names = new Set(
      Array.isArray(allowed?.allowed_tools)
        ? allowed.allowed_tools.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    );
    effectiveTools =
      effectiveTools === undefined
        ? undefined
        : effectiveTools.filter((tool) => names.has(tool.name));
    effectiveToolChoice = "allowed";
  } else if (toolChoice === "forced") {
    // Unsupported forced control: drop unless it requires an unavailable tool.
    // This is an explicit hard-control degradation, so it emits a notice.
    const choice = (value as Record<string, unknown>).tool_choice as
      | Record<string, unknown>
      | undefined;
    const requiredName = choice?.name;
    if (typeof requiredName === "string") {
      const catalogNames = new Set(
        effectiveTools === undefined ? [] : effectiveTools.map((t) => t.name),
      );
      if (!catalogNames.has(requiredName)) {
        throw new InvalidRequest(
          `tool_choice requires an unavailable tool: ${requiredName}`,
        );
      }
    }
    notices.push(
      requestNotice(
        FORCED_TOOL_CHOICE_DROPPED_NOTICE_CODE,
        "degrade",
        "$.tool_choice",
      ),
    );
    // Dropped: no generic Pi control. effectiveToolChoice stays unset.
  }
  void freeformNames;
  return { tools: effectiveTools, effective: effectiveToolChoice };
}

function buildInvocation(
  value: unknown,
  validated: ValidatedResponsesRequest,
  freeformNames: Set<string>,
  additionalTools: unknown[],
  messages: Message[],
  notices: ConversionNotice[],
  policy: ResponseRequestConversionPolicy,
  inputForPromotion: unknown = validated.input,
  namespaceReverse: Record<string, { namespace: string; child: string }> =
    Object.create(null),
): ResponsesInvocation {
  const context: Context = { messages };
  // Source metadata is retained only for request-local response echo; it is
  // never placed into model context.
  const metadataEcho = collectMetadataEcho(value);
  // Top-level instructions always lead the Pi systemPrompt; promoted input
  // privileged segments follow in source order, joined by one newline.
  // `inputForPromotion` is the already-resolved item list so privileged
  // segments materialized through the resolver are promoted too.
  const promptParts: string[] = [];
  if (validated.instructions !== undefined) {
    promptParts.push(validated.instructions);
  }
  const promoted = collectPromotedSegments(
    inputForPromotion,
    policy.privilegedMessages,
  );
  for (const segment of promoted) {
    if (segment.length > 0) promptParts.push(segment);
  }
  if (promptParts.length > 0) {
    context.systemPrompt = promptParts.join("\n");
  }
  // Namespace flattening already happened during validation; the reverse map
  // is retained only for request-local response echo.
  const mergedTools =
    validated.tools === undefined
      ? additionalTools.length === 0
        ? undefined
        : convertTools(additionalTools, freeformNames, namespaceReverse, notices)
      : [
          ...validated.tools,
          ...(convertTools(additionalTools, freeformNames, namespaceReverse, notices) ?? []),
        ];
  const filtered = applyToolChoiceFilter(
    value,
    mergedTools,
    validated.toolChoice,
    freeformNames,
    notices,
  );
  if (filtered.tools !== undefined && filtered.tools.length > 0) {
    context.tools = filtered.tools;
  }
  const options: ModelsSimpleStreamOptions = {};
  if (validated.maxOutputTokens !== undefined) {
    options.maxTokens = validated.maxOutputTokens;
  }
  if (validated.temperature !== undefined) {
    options.temperature = validated.temperature;
  }
  if (validated.topP !== undefined) {
    options.samplingParams = { top_p: validated.topP };
  }
  if (validated.cacheRetention !== undefined) {
    options.cacheRetention = validated.cacheRetention;
  }
  if (validated.metadataUserId !== undefined) {
    options.metadata = { user_id: validated.metadataUserId };
  }
  if (validated.reasoning !== undefined) {
    const reasoning = validated.reasoning as ModelsSimpleStreamOptions["reasoning"];
    if (reasoning !== undefined) options.reasoning = reasoning;
  }
  return {
    selector: validated.selector,
    context,
    options,
    renderState: {
      clientModel: validated.selector,
      stream: validated.stream,
      ...(filtered.effective === undefined
        ? {}
        : { toolChoice: filtered.effective }),
      ...(freeformNames.size > 0 ? { freeformToolNames: freeformNames } : {}),
      ...(Object.keys(namespaceReverse).length > 0
        ? { namespaceReverse: Object.freeze(namespaceReverse) }
        : {}),
      ...(metadataEcho === undefined ? {} : { metadataEcho }),
    },
    notices: Object.freeze(notices),
  };
}

/** Retain only safely-echoable string metadata for the local response. */
function collectMetadataEcho(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const metadata = value.metadata;
  if (!isRecord(metadata)) return undefined;
  // A null-prototype object: hostile keys such as "__proto__" or
  // "constructor" from JSON.parse input can never pollute its prototype.
  const echo: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(metadata)) {
    if (typeof entry === "string") echo[key] = entry;
  }
  return Object.keys(echo).length === 0 ? undefined : Object.freeze(echo);
}

/**
 * Convert a validated Responses request into the Pi invocation.
 *
 * Without a resolver, Lucky-owned references/envelopes are a conversion
 * error (no fail-open). Use {@link convertResponsesRequestAsync} with a
 * narrow Responses-owned resolver to materialize them.
 */
export function convertResponsesRequest(
  value: unknown,
  receivedAt: number,
  policy: ResponseRequestConversionPolicy = DEFAULT_POLICY,
): ResponsesInvocation {
  const freeformNames = new Set<string>();
  const namespaceReverse: Record<string, { namespace: string; child: string }> =
    Object.create(null);
  const validated = validateResponsesRequest(
    value,
    freeformNames,
    namespaceReverse,
  );
  const notices: ConversionNotice[] = [];
  const reasoning = convertReasoning(
    isRecord(value) ? value.reasoning : undefined,
    policy.futureReasoningEffort,
    notices,
  );
  if (reasoning !== undefined) validated.reasoning = reasoning;
  const additionalTools: unknown[] = [];
  const executableNames = collectExecutableNames(
    value,
    freeformNames,
    namespaceReverse,
  );
  const messages = convertMessages(
    validated.input,
    validated.selector,
    receivedAt,
    additionalTools,
    policy,
    notices,
    executableNames,
  );
  return buildInvocation(
    value,
    validated,
    freeformNames,
    additionalTools,
    messages,
    notices,
    policy,
    validated.input,
    namespaceReverse,
  );
}

/**
 * Async conversion entry that materializes Lucky-owned opaque references
 * through the narrow Responses resolver capability. Resolved items are
 * converted in source order; an unresolvable reference becomes a notice, not
 * a fabricated fallback.
 */
export async function convertResponsesRequestAsync(
  value: unknown,
  receivedAt: number,
  policy: ResponseRequestConversionPolicy,
  resolver: ResponseReferenceResolver,
  signal?: AbortSignal,
  limits?: Readonly<{
    maxBytes?: number;
    maxMimeTypes?: readonly string[];
    maxRedirects?: number;
  }>,
): Promise<ResponsesInvocation> {
  const freeformNames = new Set<string>();
  const namespaceReverse: Record<string, { namespace: string; child: string }> =
    Object.create(null);
  const validated = validateResponsesRequest(
    value,
    freeformNames,
    namespaceReverse,
  );
  const notices: ConversionNotice[] = [];
  const reasoning = convertReasoning(
    isRecord(value) ? value.reasoning : undefined,
    policy.futureReasoningEffort,
    notices,
  );
  if (reasoning !== undefined) validated.reasoning = reasoning;
  const additionalTools: unknown[] = [];
  const executableNames = collectExecutableNames(
    value,
    freeformNames,
    namespaceReverse,
  );
  const rawItems: readonly unknown[] =
    typeof validated.input === "string"
      ? [{ role: "user", content: validated.input }]
      : (validated.input as readonly unknown[]);
  const expandedItems = await resolveLuckyReferences(
    rawItems,
    resolver,
    notices,
    signal,
    limits,
  );
  const messages = convertMessages(
    expandedItems,
    validated.selector,
    receivedAt,
    additionalTools,
    policy,
    notices,
    executableNames,
  );
  return buildInvocation(
    value,
    validated,
    freeformNames,
    additionalTools,
    messages,
    notices,
    policy,
    expandedItems,
    namespaceReverse,
  );
}

/**
 * Collect the executable Client/BYOT tool names from the request's tool
 * catalog (top-level tools plus additional_tools). Namespace children are
 * flattened with the same reversible scheme the tool converter uses, so
 * ownership classification is by catalog membership — never by a concrete
 * Provider or tool-name guess. computer/mcp calls map structurally only when
 * their name is in this catalog; everything else is provider-hosted.
 */
function collectExecutableNames(
  value: unknown,
  freeformNames: Set<string>,
  namespaceReverse: Record<string, { namespace: string; child: string }>,
): ReadonlySet<string> {
  const names = new Set<string>();
  const collect = (raw: unknown): void => {
    if (!Array.isArray(raw)) return;
    for (const candidate of raw) {
      if (!isRecord(candidate)) continue;
      const type = candidate.type;
      const name = candidate.name;
      if (type === "namespace" && typeof name === "string" && name.length > 0) {
        if (!Array.isArray(candidate.tools)) continue;
        for (const inner of candidate.tools) {
          if (
            isRecord(inner) &&
            typeof inner.name === "string" &&
            inner.name.length > 0
          ) {
            const flat = `${name}${NAMESPACE_SEPARATOR}${inner.name}`;
            names.add(flat);
            namespaceReverse[flat] = { namespace: name, child: inner.name };
          }
        }
        continue;
      }
      // function/custom/local_shell/shell/apply_patch/computer/mcp are
      // Client/BYOT executable families when declared in the catalog. The
      // installed SDK models the computer and apply_patch tools without a
      // name; they map to the deterministic "computer"/"apply_patch" names
      // like the tool converter does.
      if (
        type === "function" ||
        type === "custom" ||
        type === "local_shell" ||
        type === "shell" ||
        type === "apply_patch" ||
        type === "computer" ||
        type === "computer_use" ||
        type === "computer_use_preview" ||
        type === "mcp"
      ) {
        const effectiveName =
          (type === "computer" || type === "computer_use_preview") &&
          (typeof name !== "string" || name.length === 0)
            ? "computer"
            : (type === "apply_patch" ||
                type === "local_shell" ||
                type === "shell") &&
                (typeof name !== "string" || name.length === 0)
              ? type
              : typeof name === "string" && name.length > 0
                ? name
                : undefined;
        if (effectiveName === undefined) continue;
        names.add(effectiveName);
        if (type === "custom") freeformNames.add(effectiveName);
      }
    }
  };
  collect(isRecord(value) ? value.tools : undefined);
  if (isRecord(value) && Array.isArray(value.input)) {
    for (const item of value.input) {
      if (isRecord(item) && item.type === "additional_tools") {
        collect(item.tools);
      }
    }
  }
  return names;
}

function collectPromotedSegments(
  input: unknown,
  mode: "full" | "first" | "user",
): string[] {
  const segments: string[] = [];
  const items: unknown[] =
    typeof input === "string"
      ? [{ role: "user", content: input }]
      : (input as unknown[]);
  let seenFirstUser = false;
  for (const rawItem of items) {
    if (!isRecord(rawItem)) continue;
    const type =
      rawItem.type ?? (typeof rawItem.role === "string" ? "message" : undefined);
    if (type !== "message") continue;
    const role = rawItem.role;
    if (role === "user") {
      seenFirstUser = true;
      continue;
    }
    if (role !== "system" && role !== "developer") continue;
    if (mode === "user") continue;
    if (mode === "first" && seenFirstUser) continue;
    const text = parseContentParts(rawItem.content)
      .map((part) => part.text)
      .join("");
    if (text.length > 0) segments.push(text);
  }
  return segments;
}
