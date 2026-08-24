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

import type { ConversionNotice } from "@luckytoken/provider-contract/diagnostics";
import type { ResponsesConversionResult } from "./semantic/invocation.js";
import type {
  ResponsesHistoricalReasoning,
  ResponsesReasoningContinuityAttachment,
  ResponsesReasoningEffortIntent,
  ResponsesReasoningEffortLevel,
  ResponsesReasoningSemantics,
  ResponsesReasoningSummaryIntent,
  ResponsesReasoningSummaryPreference,
} from "./semantic/reasoning/contract.js";
import type {
  ResponsesProjectionSupplement,
  ResponsesToolChoice,
} from "./semantic/supplement/contract.js";
import {
  InvalidResponsesProjectionSupplement,
  parseResponsesProjectionSupplement,
  parseResponsesToolChoice,
  SUPPLEMENT_REQUEST_FIELDS,
} from "./semantic/supplement/request.js";
import {
  decodeResponsesContinuity,
  RESPONSES_CONTINUITY_FIELD,
  type WireContinuityAttachment,
} from "./semantic/reasoning/continuity.js";

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

export interface ResponsesClientRenderState {
    clientModel: string;
    stream: boolean;
    /** Effective tool_choice that actually took effect (auto/none). */
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
}

export type ResponsesInvocation = ResponsesConversionResult<ResponsesClientRenderState>;

interface ValidatedResponsesRequest {
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
  toolChoice?: ResponsesToolChoice;
}

export const SYNTHETIC_CLIENT_HISTORY_API = "luckytoken-client-history";
export const SYNTHETIC_CLIENT_HISTORY_PROVIDER = "luckytoken-client";

export const FUTURE_EFFORT_NOTICE_CODE = "openai-responses_future_effort";
export const ULTRA_ALIAS_NOTICE_CODE = "openai-responses_effort_ultra_alias";
export const UNKNOWN_INPUT_ITEM_IGNORED_NOTICE_CODE =
  "openai-responses_unknown_input_item_ignored";
export const REFERENCE_UNRESOLVED_NOTICE_CODE =
  "openai-responses_reference_unresolved";
export const INPUT_FILE_DROPPED_NOTICE_CODE =
  "openai-responses_input_file_dropped";
export const CUSTOM_INPUT_COMPAT_NOTICE_CODE =
  "openai-responses_custom_input_compat";
export const INCOMPLETE_MESSAGE_NOTICE_CODE =
  "openai-responses_incomplete_message";
export const OUTPUT_IMAGE_UNRESOLVED_NOTICE_CODE =
  "openai-responses_output_image_unresolved";
export const NAMESPACE_COLLISION_NOTICE_CODE =
  "openai-responses_namespace_collision";
export const UNCONSUMED_REQUEST_FIELD_IGNORED_NOTICE_CODE =
  "openai-responses_unconsumed_request_field_ignored";
export const ADDITIONAL_UNCONSUMED_REQUEST_FIELDS_IGNORED_NOTICE_CODE =
  "openai-responses_additional_unconsumed_request_fields_ignored";

/** Separator for the reversible Responses-owned namespace flattening scheme.
 *  A flattened name is `<namespace>__<child>`; the separator stays inside the
 *  OpenAI function-name alphabet and the reverse map in render state recovers
 *  the original namespace/child pair for output rendering. */
export const NAMESPACE_SEPARATOR = "__";

/** Responses-owned marker id for the versioned textSignature envelope.
 *  `phase` is preserved here, never injected into model-visible text. */
export const RESPONSES_TEXT_SIGNATURE_ID = "openai-responses";
export interface ResponsesTextSignatureV1 {
  readonly v: 1;
  readonly id: typeof RESPONSES_TEXT_SIGNATURE_ID;
  readonly phase: string;
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

const MAIN_REQUEST_FIELDS = Object.freeze([
  "model",
  "input",
  "instructions",
  "stream",
  "metadata",
  "previous_response_id",
  "store",
  "reasoning",
  "tools",
  "tool_choice",
  "max_output_tokens",
  "temperature",
  "top_p",
  "prompt_cache_retention",
  "safety_identifier",
  "user",
] as const);

const CONSUMED_REQUEST_FIELDS = new Set<string>([
  ...MAIN_REQUEST_FIELDS,
  ...SUPPLEMENT_REQUEST_FIELDS,
]);
const MAX_EXACT_UNCONSUMED_FIELD_NOTICES = 15;

interface ResponsesConsumerViews {
  readonly mainRequest: Readonly<Record<string, unknown>>;
  readonly supplementRequest: Readonly<Record<string, unknown>>;
  readonly notices: ConversionNotice[];
}

function requestFieldJsonPath(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `$.${key}`
    : `$[${JSON.stringify(key)}]`;
}

function pickOwnFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  const selected: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    if (Object.hasOwn(value, field)) selected[field] = value[field];
  }
  return Object.freeze(selected);
}

function selectResponsesConsumerViews(value: unknown): ResponsesConsumerViews {
  if (!isRecord(value)) {
    throw new InvalidRequest("Request body must be a JSON object");
  }
  const notices: ConversionNotice[] = [];
  let additionalUnconsumedFields = false;
  for (const key of Object.keys(value)) {
    if (CONSUMED_REQUEST_FIELDS.has(key)) continue;
    if (notices.length < MAX_EXACT_UNCONSUMED_FIELD_NOTICES) {
      notices.push(
        requestNotice(
          UNCONSUMED_REQUEST_FIELD_IGNORED_NOTICE_CODE,
          "ignore",
          requestFieldJsonPath(key),
        ),
      );
    } else {
      additionalUnconsumedFields = true;
    }
  }
  if (additionalUnconsumedFields) {
    notices.push(
      requestNotice(
        ADDITIONAL_UNCONSUMED_REQUEST_FIELDS_IGNORED_NOTICE_CODE,
        "ignore",
      ),
    );
  }
  return Object.freeze({
    mainRequest: pickOwnFields(value, MAIN_REQUEST_FIELDS),
    supplementRequest: pickOwnFields(value, SUPPLEMENT_REQUEST_FIELDS),
    notices,
  });
}

function parseContentParts(
  content: unknown,
  wireTextParts?: Map<number, TextContent>,
): TextContent[] {
  if (typeof content === "string") {
    if (content.length === 0) return [];
    const block: TextContent = { type: "text", text: content };
    wireTextParts?.set(0, block);
    return [block];
  }
  if (!Array.isArray(content)) return [];
  const parts: TextContent[] = [];
  for (const [wirePartIndex, raw] of content.entries()) {
    if (!isRecord(raw)) continue;
    const type = raw.type;
    if (
      (type === "input_text" || type === "text" || type === "output_text") &&
      typeof raw.text === "string"
    ) {
      const block: TextContent = { type: "text", text: raw.text };
      parts.push(block);
      wireTextParts?.set(wirePartIndex, block);
      continue;
    }
    // A refusal carries visible text semantics; preserve it as deterministic
    // textual degradation rather than silently dropping the refusal.
    if (type === "refusal" && typeof raw.refusal === "string") {
      const block: TextContent = { type: "text", text: raw.refusal };
      parts.push(block);
      wireTextParts?.set(wirePartIndex, block);
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
  const rawMime = match[1] ?? "";
  const data = match[2] ?? "";
  if (rawMime.length === 0) {
    throw new InvalidRequest(`${field} data URL must include a MIME type`);
  }
  // An input_image data URL must carry an image MIME; a non-image payload is
  // a malformed image, never a silent acceptance. The MIME is normalized to
  // lowercase so Pi ImageContent carries a canonical value.
  const mimeType = rawMime.toLowerCase();
  if (!/^image\//u.test(mimeType)) {
    throw new InvalidRequest(
      `${field} data URL MIME must be an image MIME: ${rawMime}`,
    );
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

  /** Flatten one namespace child under `<namespace>__<child>`, recording the
   *  reverse mapping in request-local render state. */
  const pushNamespaceChild = (
    namespace: string,
    inner: unknown,
  ): void => {
    if (!isRecord(inner) || typeof inner.name !== "string" || inner.name.length === 0) {
      return;
    }
    // defer_loading that requires tool-search discovery is a Core v1
    // conversion error even for namespace children.
    if (inner.defer_loading === true) {
      throw new InvalidRequest(
        "defer_loading tool discovery is not supported by Core conversion v1",
      );
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
interface ConvertedReasoningRequest {
  readonly piReasoning?: ResponsesReasoningEffortLevel;
  readonly intent: Readonly<{
    effort: ResponsesReasoningEffortIntent;
    summary: ResponsesReasoningSummaryIntent;
  }>;
}

const REASONING_SUMMARY_PREFERENCES = new Set<ResponsesReasoningSummaryPreference>([
  "auto",
  "concise",
  "detailed",
]);

function parseReasoningSummary(
  value: Readonly<Record<string, unknown>>,
): ResponsesReasoningSummaryIntent {
  const current = value.summary;
  const deprecated = value.generate_summary;
  for (const [field, candidate] of [
    ["reasoning.summary", current],
    ["reasoning.generate_summary", deprecated],
  ] as const) {
    if (candidate === undefined || candidate === null) continue;
    if (
      typeof candidate !== "string" ||
      !REASONING_SUMMARY_PREFERENCES.has(candidate as ResponsesReasoningSummaryPreference)
    ) {
      throw new InvalidRequest(
        `${field} must be auto, concise, or detailed when present`,
      );
    }
  }
  if (
    current !== undefined &&
    current !== null &&
    deprecated !== undefined &&
    deprecated !== null &&
    current !== deprecated
  ) {
    throw new InvalidRequest(
      "reasoning.summary and reasoning.generate_summary must agree when both are present",
    );
  }
  const selected = current ?? deprecated;
  return selected === undefined || selected === null
    ? Object.freeze({ kind: "provider-default" })
    : Object.freeze({
        kind: "requested",
        value: selected as ResponsesReasoningSummaryPreference,
      });
}

function convertReasoning(
  value: unknown,
  futureReasoningEffort: ResponseRequestConversionPolicy["futureReasoningEffort"],
  notices: ConversionNotice[],
): ConvertedReasoningRequest {
  const providerDefaultEffort = Object.freeze({
    kind: "provider-default",
  } as const);
  const providerDefaultSummary = Object.freeze({
    kind: "provider-default",
  } as const);
  if (value === undefined || value === null) {
    return Object.freeze({
      intent: Object.freeze({
        effort: providerDefaultEffort,
        summary: providerDefaultSummary,
      }),
    });
  }
  if (!isRecord(value)) {
    throw new InvalidRequest("reasoning must be an object when present");
  }
  const summary = parseReasoningSummary(value);
  const effort = value.effort;
  if (effort === undefined || effort === null) {
    return Object.freeze({
      intent: Object.freeze({ effort: providerDefaultEffort, summary }),
    });
  }
  if (typeof effort !== "string" || effort.trim().length === 0) {
    throw new InvalidRequest(
      "reasoning.effort must be a non-empty string when present",
    );
  }
  if (effort === "none") {
    return Object.freeze({
      intent: Object.freeze({
        effort: Object.freeze({ kind: "disabled" }),
        summary,
      }),
    });
  }
  if (effort === "ultra") {
    notices.push(
      requestNotice(ULTRA_ALIAS_NOTICE_CODE, "degrade", "$.reasoning.effort"),
    );
    return Object.freeze({
      piReasoning: "max",
      intent: Object.freeze({
        effort: Object.freeze({ kind: "enabled", level: "max" }),
        summary,
      }),
    });
  }
  if (effort === "max" || KNOWN_EFFORTS.has(effort)) {
    const level = effort as ResponsesReasoningEffortLevel;
    return Object.freeze({
      piReasoning: level,
      intent: Object.freeze({
        effort: Object.freeze({ kind: "enabled", level }),
        summary,
      }),
    });
  }
  // Future unknown effort value.
  if (futureReasoningEffort === "error") {
    throw new InvalidRequest(
      `reasoning.effort is not a known thinking level: ${effort}`,
    );
  }
  notices.push(
    requestNotice(FUTURE_EFFORT_NOTICE_CODE, "degrade", "$.reasoning.effort"),
  );
  if (futureReasoningEffort === "max") {
    return Object.freeze({
      piReasoning: "max",
      intent: Object.freeze({
        effort: Object.freeze({ kind: "enabled", level: "max" }),
        summary,
      }),
    });
  }
  return Object.freeze({
    intent: Object.freeze({ effort: providerDefaultEffort, summary }),
  });
}

function parseToolChoice(value: unknown): ResponsesToolChoice | undefined {
  try {
    return parseResponsesToolChoice(value);
  } catch (error) {
    if (error instanceof InvalidResponsesProjectionSupplement) {
      throw new InvalidRequest(error.message);
    }
    throw error;
  }
}

/**
 * Minimal selector extraction for passthrough routing.
 *
 * This deliberately performs no semantic validation beyond a JSON object
 * shape and a non-empty `model` string: passthrough must forward the raw
 * body verbatim. Semantic Conversion independently selects only the facts
 * consumed by its Responses-owned request and supplement views.
 */
export function extractResponsesModelSelector(value: unknown): string {
  if (!isRecord(value)) {
    throw new InvalidRequest("Request body must be a JSON object");
  }
  const model = value.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new InvalidRequest("model must be a non-empty string");
  }
  return model;
}

function validateMainRequest(
  value: unknown,
  freeformNames?: Set<string>,
  namespaceReverse?: Record<string, { namespace: string; child: string }>,
): ValidatedResponsesRequest {
  if (!isRecord(value)) {
    throw new InvalidRequest("Request body must be a JSON object");
  }
  const selector = nonEmptyString(value.model, "model");
  const input =
    value.input === undefined && typeof value.instructions === "string"
      ? []
      : value.input;
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
  const toolChoice = parseToolChoice(value.tool_choice);
  validateReasoningShape(value.reasoning);
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
    if (cacheRetentionValue === "in_memory") cacheRetention = "short";
    else if (cacheRetentionValue === "24h") cacheRetention = "long";
    else {
      throw new InvalidRequest(
        "prompt_cache_retention must be in_memory or 24h when present",
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

interface ResponsesHistoricalReasoningCandidate {
  readonly block: ThinkingContent;
  readonly summaryText: string;
  readonly sourceItemId?: string;
  readonly source?: ResponsesHistoricalReasoning["source"];
}

type InternalReasoningContinuityCandidate =
  | WireContinuityAttachment
  | {
      readonly source: ResponsesReasoningContinuityAttachment["source"];
      readonly target: "thinking";
      readonly kind: "responses-reasoning-item";
      readonly value: string;
    };

interface ReasoningContinuityCandidate {
  readonly block: ThinkingContent | TextContent | ToolCall;
  readonly sourceItemId?: string;
  readonly wire: InternalReasoningContinuityCandidate;
}

function resolveResponsesHistoricalReasoning(
  messages: readonly Message[],
  candidates: readonly ResponsesHistoricalReasoningCandidate[],
): readonly ResponsesHistoricalReasoning[] {
  if (candidates.length === 0) return Object.freeze([]);
  const byBlock = new Map(
    candidates.map((candidate) => [candidate.block, candidate] as const),
  );
  const resolved: ResponsesHistoricalReasoning[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    for (const [contentIndex, block] of message.content.entries()) {
      if (block.type !== "thinking") continue;
      const candidate = byBlock.get(block);
      if (candidate === undefined) continue;
      resolved.push(
        Object.freeze({
          attachment: Object.freeze({
            messageIndex,
            contentIndex,
            ...(candidate.sourceItemId === undefined
              ? {}
              : { sourceItemId: candidate.sourceItemId }),
          }),
          summaryText: candidate.summaryText,
          ...(candidate.source === undefined ? {} : { source: candidate.source }),
        }),
      );
    }
  }
  return Object.freeze(resolved);
}

function serializeResponsesReasoningReplayItem(
  item: Readonly<Record<string, unknown>>,
): string | undefined {
  if (
    typeof item.id !== "string" ||
    item.id.length === 0 ||
    typeof item.encrypted_content !== "string" ||
    item.encrypted_content.length === 0
  ) {
    return undefined;
  }
  const replay: Record<string, unknown> = {
    type: "reasoning",
    id: item.id,
  };
  if (item.status !== undefined) {
    if (item.status !== "completed") return undefined;
    replay.status = item.status;
  }
  if (item.summary !== undefined) {
    if (
      !Array.isArray(item.summary) ||
      !item.summary.every(
        (part) =>
          isRecord(part) &&
          part.type === "summary_text" &&
          typeof part.text === "string",
      )
    ) {
      return undefined;
    }
    replay.summary = item.summary.map((part) => ({
      type: "summary_text",
      text: (part as Record<string, unknown>).text,
    }));
  }
  if (item.content !== undefined) {
    if (
      !Array.isArray(item.content) ||
      !item.content.every(
        (part) =>
          isRecord(part) &&
          part.type === "reasoning_text" &&
          typeof part.text === "string",
      )
    ) {
      return undefined;
    }
    replay.content = item.content.map((part) => ({
      type: "reasoning_text",
      text: (part as Record<string, unknown>).text,
    }));
  }
  replay.encrypted_content = item.encrypted_content;
  return JSON.stringify(replay);
}

function resolveReasoningContinuity(
  messages: readonly Message[],
  candidates: readonly ReasoningContinuityCandidate[],
): readonly ResponsesReasoningContinuityAttachment[] {
  if (candidates.length === 0) return Object.freeze([]);
  const byBlock = new Map<
    ThinkingContent | TextContent | ToolCall,
    ReasoningContinuityCandidate[]
  >();
  for (const candidate of candidates) {
    const current = byBlock.get(candidate.block);
    if (current === undefined) byBlock.set(candidate.block, [candidate]);
    else current.push(candidate);
  }
  const resolved: ResponsesReasoningContinuityAttachment[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    for (const [contentIndex, block] of message.content.entries()) {
      const blockCandidates = byBlock.get(block);
      if (blockCandidates === undefined) continue;
      for (const candidate of blockCandidates) {
        const common = {
          source: candidate.wire.source,
          kind: candidate.wire.kind,
          value: candidate.wire.value,
          ...(candidate.wire.target === "thinking" &&
          candidate.wire.kind === "opaque-signature" &&
          candidate.wire.representation === "redacted"
            ? { representation: "redacted" as const }
            : {}),
        } as const;
        if (candidate.wire.target === "toolCall") {
          resolved.push(
            Object.freeze({
              attachment: Object.freeze({
                target: "toolCall",
                messageIndex,
                contentIndex,
                callId: candidate.wire.callId,
              }),
              ...common,
            }),
          );
          continue;
        }
        resolved.push(
          Object.freeze({
            attachment: Object.freeze({
              target: candidate.wire.target,
              messageIndex,
              contentIndex,
              ...(candidate.sourceItemId === undefined
                ? {}
                : { sourceItemId: candidate.sourceItemId }),
            }),
            ...common,
          }),
        );
      }
    }
  }
  return Object.freeze(resolved);
}

function convertMessages(
  input: unknown,
  selector: string,
  receivedAt: number,
  additionalTools: unknown[],
  policy: ResponseRequestConversionPolicy,
  notices: ConversionNotice[],
  executableNames?: ReadonlySet<string>,
  namespaceReverse?: Readonly<Record<string, { namespace: string; child: string }>>,
  historicalReasoningCandidates: ResponsesHistoricalReasoningCandidate[] = [],
  reasoningContinuityCandidates: ReasoningContinuityCandidate[] = [],
): Message[] {
  const messages: Message[] = [];
  const pendingReasoning: ThinkingContent[] = [];
  const assistantIndex = new Map<string, string>();
  const resolvedCallIds = new Set<string>();
  const failedCallIds = new Set<string>();
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
    // The SDK input array contains ResponseInputItem objects; a non-object
    // item is malformed and must not be silently dropped.
    if (!isRecord(rawItem)) {
      throw new InvalidRequest(
        "input items must be objects when input is an array",
      );
    }
    const type =
      rawItem.type ?? (typeof rawItem.role === "string" ? "message" : undefined);
    if (type === undefined) {
      throw new InvalidRequest(
        "input item must carry a type or a role discriminator",
      );
    }

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
        const wireTextParts = new Map<number, TextContent>();
        const content = parseContentParts(rawItem.content, wireTextParts);
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
          // A privileged/degraded message does not consume pending reasoning
          // from a preceding turn; it survives as a reasoning-only assistant.
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
          // marker or an empty message. A provable image file whose
          // `file_data` is already materialized as an image data URL maps to
          // Pi image bytes. A message that carried only non-image files is
          // dropped entirely.
          const fileParts = Array.isArray(rawItem.content)
            ? rawItem.content.filter(
                (part): part is Record<string, unknown> =>
                  isRecord(part) && part.type === "input_file",
              )
            : [];
          const materializedFileImages: ImageContent[] = [];
          if (fileParts.length > 0) {
            for (const part of fileParts) {
              const fileData = part.file_data;
              if (
                typeof fileData === "string" &&
                fileData.startsWith("data:")
              ) {
                try {
                  materializedFileImages.push(
                    parseDataUrlImage(fileData, "input_file.file_data"),
                  );
                } catch {
                  // A malformed or non-image file_data is a generic
                  // non-image file: falls through to the drop below.
                }
              }
            }
            if (materializedFileImages.length < fileParts.length) {
              notices.push(
                requestNotice(
                  INPUT_FILE_DROPPED_NOTICE_CODE,
                  "ignore",
                  `$.input[?role=user].content[?type=input_file]`,
                ),
              );
            }
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
            images.length === 0 &&
            materializedFileImages.length === 0
          ) {
            continue;
          }
          const blocks = [...content, ...images, ...materializedFileImages];
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
            const previousFirstBlock = content[0];
            content[0] = {
              ...previousFirstBlock,
              textSignature: signature,
            } as TextContent;
            const firstWirePart = [...wireTextParts.entries()].find(
              ([, block]) => block === previousFirstBlock,
            );
            if (firstWirePart !== undefined) {
              wireTextParts.set(firstWirePart[0], content[0]);
            }
          }
          const decodedContinuity = decodeResponsesContinuity(rawItem, {
            type: "message",
            contentPartCount: Array.isArray(rawItem.content)
              ? rawItem.content.length
              : content.length,
          });
          notices.push(...decodedContinuity.notices);
          for (const wire of decodedContinuity.attachments) {
            if (wire.target !== "text") continue;
            const block = wireTextParts.get(wire.partIndex);
            if (block === undefined) {
              notices.push(
                requestNotice(
                  "openai-responses_continuity_attachment_invalid",
                  "ignore",
                  `$.input[?type=message].${RESPONSES_CONTINUITY_FIELD}`,
                ),
              );
              continue;
            }
            reasoningContinuityCandidates.push({
              block,
              wire,
              ...(typeof rawItem.id === "string"
                ? { sourceItemId: rawItem.id }
                : {}),
            });
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
          const decodedContinuity = decodeResponsesContinuity(rawItem, {
            type: "reasoning",
          });
          notices.push(...decodedContinuity.notices);
          historicalReasoningCandidates.push({
            block,
            summaryText: thinking,
            ...(typeof rawItem.id === "string"
              ? { sourceItemId: rawItem.id }
              : {}),
            ...(decodedContinuity.source === undefined
              ? {}
              : { source: decodedContinuity.source }),
          });
          for (const wire of decodedContinuity.attachments) {
            reasoningContinuityCandidates.push({
              block,
              wire,
              ...(typeof rawItem.id === "string"
                ? { sourceItemId: rawItem.id }
              : {}),
            });
          }
          if (
            decodedContinuity.source !== undefined
          ) {
            const replayItem = serializeResponsesReasoningReplayItem(rawItem);
            if (replayItem !== undefined) {
              reasoningContinuityCandidates.push({
                block,
                ...(typeof rawItem.id === "string"
                  ? { sourceItemId: rawItem.id }
                  : {}),
                wire: {
                  source: decodedContinuity.source,
                  target: "thinking",
                  kind: "responses-reasoning-item",
                  value: replayItem,
                },
              });
            }
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
        // content/transcript drop and is never advertised as a Pi tool. The
        // installed SDK models ResponseComputerToolCall without a `name`
        // field; a name-less computer_call is Client/BYOT when the
        // deterministic "computer" executable name is in the catalog.
        if (type === "computer_call" || type === "mcp_call") {
          const name = rawItem.name;
          const owned =
            (typeof name === "string" && executableNames?.has(name) === true) ||
            (type === "computer_call" &&
              (typeof name !== "string" || name.length === 0) &&
              executableNames?.has("computer") === true);
          if (!owned) {
            pendingReasoning.length = 0;
            continue;
          }
        }
        // Structured tool status: absent/completed are eligible;
        // in_progress/incomplete/unknown structured status is an error. The
        // installed SDK models mcp_call.status additionally as `calling`
        // (non-terminal, errors like in_progress) and `failed` (a defined
        // terminal lifecycle with an error string; the correlated result
        // carries isError and representable content).
        const status = rawItem.status;
        if (status !== undefined && status !== null) {
          if (typeof status !== "string" || status.length === 0) {
            throw new InvalidRequest("tool call status must be a non-empty string");
          }
          if (type === "mcp_call" && status === "failed") {
            // A terminal failed lifecycle: eligible like completed; the
            // error semantics are carried by the correlated isError result.
            // (`calling` is not eligible and falls into the error branch.)
          } else if (status !== "completed" && status !== "in_progress") {
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
        // The installed SDK models computer_call, local_shell_call,
        // shell_call and apply_patch_call without a `name` field; a name-less
        // call maps to its deterministic Responses-owned family name so the
        // structured ToolCall/ToolResult round-trip. Other families require
        // a name.
        const rawName =
          (type === "computer_call" ||
            type === "local_shell_call" ||
            type === "shell_call" ||
            type === "apply_patch_call") &&
          (typeof rawItem.name !== "string" || rawItem.name.length === 0)
            ? type === "computer_call"
              ? "computer"
              : type === "local_shell_call"
                ? "local_shell"
                : type === "shell_call"
                  ? "shell"
                  : "apply_patch"
            : nonEmptyString(rawItem.name, "function_call.name");
        const wireNamespace =
          (type === "function_call" || type === "custom_tool_call") &&
          rawItem.namespace !== undefined
            ? nonEmptyString(rawItem.namespace, `${type}.namespace`)
            : undefined;
        const flattenedName =
          wireNamespace === undefined
            ? undefined
            : `${wireNamespace}${NAMESPACE_SEPARATOR}${rawName}`;
        const declaredNamespace =
          flattenedName === undefined ? undefined : namespaceReverse?.[flattenedName];
        const name =
          declaredNamespace?.namespace === wireNamespace &&
          declaredNamespace?.child === rawName
            ? flattenedName!
            : rawName;
        // An mcp_call with an error string is a failed tool invocation; the
        // correlated result must carry isError so the error semantics are
        // never lost.
        if (type === "mcp_call" && typeof rawItem.error === "string") {
          failedCallIds.add(callId);
        }
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
          // The SDK models custom_tool_call.input as a string; a non-string
          // input is malformed, never silently rewritten.
          if (typeof rawItem.input !== "string") {
            throw new InvalidRequest(
              "custom_tool_call input must be a string",
            );
          }
          argumentsJson = { input: rawItem.input };
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
          ...(wireNamespace !== undefined && name === rawName
            ? { namespace: wireNamespace }
            : {}),
        };
        const decodedContinuity = decodeResponsesContinuity(rawItem, {
          type: "toolCall",
          callId,
        });
        notices.push(...decodedContinuity.notices);
        for (const wire of decodedContinuity.attachments) {
          reasoningContinuityCandidates.push({ block: toolCall, wire });
        }
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
        // The installed SDK models mcp_call with an optional `output` string
        // carrying the tool result inline. A present output is a real
        // correlated result: it becomes the ToolResult immediately (never a
        // synthetic missing-result repair) and the call is marked resolved so
        // a later output item for the same id is a duplicate.
        if (type === "mcp_call" && typeof rawItem.output === "string") {
          resolvedCallIds.add(callId);
          messages.push({
            role: "toolResult",
            toolCallId: callId,
            toolName: name,
            content:
              rawItem.output.length === 0
                ? []
                : [{ type: "text", text: rawItem.output }],
            isError: failedCallIds.has(callId),
            timestamp: receivedAt,
          });
        }
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
        // in_progress/incomplete/unknown structured status is an error. An
        // incomplete tool output is a partial result that must never be
        // treated as a completed tool result. The installed SDK models
        // apply_patch_call_output.status additionally as `failed` (a defined
        // terminal lifecycle with representable output; the correlated
        // result carries isError so the failure semantics are never lost).
        const status = rawItem.status;
        if (status !== undefined && status !== null) {
          if (typeof status !== "string" || status.length === 0) {
            throw new InvalidRequest(
              "tool output status must be a non-empty string",
            );
          }
          if (
            type === "apply_patch_call_output" &&
            status === "failed"
          ) {
            // A terminal failed lifecycle: eligible like completed; the
            // error semantics are carried by the correlated isError result.
          } else if (status !== "completed" && status !== "in_progress") {
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
          // An ignored orphan output does not consume pending reasoning that
          // belongs to an earlier turn; it survives as a reasoning-only
          // assistant at the next semantic boundary.
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
        // A historical output image referenced by file_id/remote URL cannot
        // be materialized here; it drops with a recorded notice, never
        // silently.
        const unresolvedOutputImages = outputParts.filter(
          (part) =>
            isRecord(part) &&
            (part.type === "output_image" ||
              part.type === "computer_screenshot") &&
            (typeof part.file_id === "string" ||
              (typeof part.image_url === "string" &&
                !part.image_url.startsWith("data:"))),
        );
        if (unresolvedOutputImages.length > 0) {
          notices.push(
            requestNotice(
              OUTPUT_IMAGE_UNRESOLVED_NOTICE_CODE,
              "ignore",
              `$.input[?call_id=${callId}].output[?type=output_image]`,
            ),
          );
        }
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
          // A failed mcp_call (error field present) or a failed
          // apply_patch_call_output marks the correlated result isError so
          // the failure semantics are preserved.
          isError:
            failedCallIds.has(callId) ||
            (type === "apply_patch_call_output" && status === "failed"),
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
        // A compaction boundary preserves pending reasoning from the
        // preceding turn; it is not consumed by the drop.
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
        // Hosted drops do not consume pending reasoning from a preceding
        // turn; it survives as a reasoning-only assistant.
        continue;
      case "image_generation_call": {
        // A hosted call still in progress (in_progress/generating) or one
        // that failed (the installed SDK models status failed) has no
        // determinate result; lifecycle-only metadata drops. A failed call
        // never materializes a result it does not possess.
        const hostedStatus = rawItem.status;
        if (
          hostedStatus === "in_progress" ||
          hostedStatus === "generating" ||
          hostedStatus === "searching" ||
          hostedStatus === "failed"
        ) {
          continue;
        }
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
        continue;
      }
      case "file_search_call": {
        // A hosted call still in progress (in_progress/searching) or one
        // that failed (the installed SDK models status failed) has no
        // determinate results; lifecycle-only metadata drops.
        const hostedStatus = rawItem.status;
        if (
          hostedStatus === "in_progress" ||
          hostedStatus === "searching" ||
          hostedStatus === "failed"
        ) {
          continue;
        }
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
        continue;
      }
      case "code_interpreter_call": {
        // A hosted call still in progress (in_progress/interpreting) or one
        // that failed (the installed SDK models status failed) has no
        // determinate output; lifecycle-only metadata drops.
        const hostedStatus = rawItem.status;
        if (
          hostedStatus === "in_progress" ||
          hostedStatus === "interpreting" ||
          hostedStatus === "failed"
        ) {
          continue;
        }
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
        continue;
      }
      // MCP list/approval lifecycles have no Pi approval lifecycle. Only
      // model-visible decision text survives as a deterministic transcript;
      // pure metadata drops. Credentials/headers never enter Pi.
      case "mcp_list_tools": {
        continue;
      }
      case "mcp_approval_request":
        // A request has no model-visible decision text; pure lifecycle
        // metadata (arguments, server label) drops.
        continue;
      case "mcp_approval_response": {
        // The installed SDK models the decision as `approve: boolean` plus an
        // optional `reason` string. The model-visible decision fact degrades
        // to a deterministic transcript: the reason when present, otherwise a
        // deterministic approve/denied text so the decision is never silently
        // lost. Pure lifecycle metadata (approval_request_id, approve flag)
        // never enters Pi.
        const reason = rawItem.reason;
        if (typeof reason === "string" && reason.length > 0) {
          pushUser(reason);
        } else if (rawItem.approve === true) {
          pushUser("MCP tool call approved");
        } else if (rawItem.approve === false) {
          pushUser("MCP tool call denied");
        }
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

  // End of input is a semantic history boundary; close unresolved calls so
  // synthetic results precede any trailing reasoning-only assistant.
  closeUnresolvedCalls();
  // Trailing pending reasoning (no following assistant/user message) is
  // preserved as a reasoning-only assistant message.
  flushPendingReasoning();

  return messages;
}

/** Validate resolver limits so they are meaningful bounds: a negative or
 *  fractional byte/redirect limit would weaken the resolver's over-fetch
 *  protection. */
function validateResolverLimits(
  limits?: Readonly<{
    maxBytes?: number;
    maxMimeTypes?: readonly string[];
    maxRedirects?: number;
  }>,
): void {
  if (limits === undefined) return;
  if (
    limits.maxBytes !== undefined &&
    (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0)
  ) {
    throw new InvalidRequest(
      "resolver limits.maxBytes must be a positive safe integer",
    );
  }
  if (
    limits.maxRedirects !== undefined &&
    (!Number.isSafeInteger(limits.maxRedirects) ||
      limits.maxRedirects < 0)
  ) {
    throw new InvalidRequest(
      "resolver limits.maxRedirects must be a non-negative safe integer",
    );
  }
  if (limits.maxMimeTypes !== undefined) {
    if (
      !Array.isArray(limits.maxMimeTypes) ||
      limits.maxMimeTypes.some((entry) => typeof entry !== "string")
    ) {
      throw new InvalidRequest(
        "resolver limits.maxMimeTypes must be an array of strings",
      );
    }
  }
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
    // Cancellation cleanly terminates request-local resolution: once the
    // caller signal aborts, no further resolver calls happen.
    if (signal !== undefined && signal.aborted === true) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("aborted");
    }
    if (!isRecord(rawItem)) {
      expanded.push(rawItem);
      continue;
    }
    const type =
      rawItem.type ?? (typeof rawItem.role === "string" ? "message" : undefined);
    const envelope = rawItem.envelope;
    // A verified Lucky-owned envelope carries a non-empty authority; an
    // empty, non-object, or missing envelope is never passed to the resolver
    // (the core errors on it).
    const verifiedEnvelope =
      isRecord(envelope) &&
      typeof envelope.authority === "string" &&
      envelope.authority.length > 0;
    const isReference = type === "item_reference" && verifiedEnvelope;
    const isCompaction =
      (type === "compaction" ||
        type === "compaction_summary" ||
        type === "context_compaction") &&
      verifiedEnvelope;
    if (isReference || isCompaction) {
      const envelopeAuthority = isRecord(envelope)
        ? envelope.authority
        : undefined;
      try {
        const resolved = await resolver.resolveItemReference(rawItem, {
          authority: nonEmptyString(envelopeAuthority, "envelope.authority"),
          ...(signal === undefined ? {} : { signal }),
          limits: limits ?? DEFAULT_REFERENCE_LIMITS,
        });
        // Non-object resolver results are skipped (frozen ticket 13
        // behavior); they are not forwarded to the message converter.
        expanded.push(...resolved.filter((entry) => isRecord(entry)));
      } catch (error) {
        // Cancellation propagates: an aborted resolver call is not a
        // degradable failure, it terminates the whole resolution.
        if (signal !== undefined && signal.aborted === true) {
          throw error instanceof Error ? error : new Error("aborted");
        }
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
            authority: "openai-responses",
            ...(signal === undefined ? {} : { signal }),
            limits: limits ?? DEFAULT_REFERENCE_LIMITS,
          });
          for (const item of resolved) {
            if (isRecord(item) && item.type === "input_image") {
              // A resolver-returned image that is still a file_id/remote URL
              // was not materialized: degrade with a notice instead of
              // pushing it back so the converter double-errors.
              const imageUrl = item.image_url;
              if (
                typeof imageUrl !== "string" ||
                !imageUrl.startsWith("data:")
              ) {
                notices.push(
                  requestNotice(
                    REFERENCE_UNRESOLVED_NOTICE_CODE,
                    "ignore",
                    image.path,
                  ),
                );
                continue;
              }
              // Keep the resolved data-URL form so the normal message
              // converter parses it into Pi image bytes in place.
              resolvedParts.push(item);
              resolvedAny = true;
              continue;
            }
            // A resolver may return a full message item carrying the image;
            // splice its content parts into the message in place. Parts that
            // are still un-materialized images degrade with a notice rather
            // than double-erroring in the message converter.
            if (
              isRecord(item) &&
              (item.type === "message" || typeof item.role === "string") &&
              Array.isArray(item.content)
            ) {
              let addedAny = false;
              for (const part of item.content) {
                if (isRecord(part) && part.type === "input_image") {
                  const imageUrl = part.image_url;
                  if (
                    typeof imageUrl !== "string" ||
                    !imageUrl.startsWith("data:")
                  ) {
                    notices.push(
                      requestNotice(
                        REFERENCE_UNRESOLVED_NOTICE_CODE,
                        "ignore",
                        image.path,
                      ),
                    );
                    continue;
                  }
                }
                resolvedParts.push(part);
                addedAny = true;
              }
              resolvedAny = resolvedAny || addedAny;
            }
          }
        } catch (error) {
          // Cancellation propagates: an aborted resolver call is not a
          // degradable failure, it terminates the whole resolution.
          if (signal !== undefined && signal.aborted === true) {
            throw error instanceof Error ? error : new Error("aborted");
          }
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
  mergedTools: Tool[] | undefined,
  toolChoice: ResponsesToolChoice | undefined,
): { tools: Tool[] | undefined; effective: string | undefined } {
  let effectiveTools = mergedTools;
  let effectiveToolChoice: string | undefined;
  if (toolChoice?.kind === "none") {
    effectiveTools = undefined;
    effectiveToolChoice = "none";
  } else if (toolChoice?.kind === "allowed") {
    const names = new Set(
      toolChoice.tools.flatMap((entry) =>
        entry.toolType === "function" || entry.toolType === "custom"
          ? [entry.name]
          : [],
      ),
    );
    effectiveTools =
      effectiveTools === undefined
        ? undefined
        : effectiveTools.filter((tool) => names.has(tool.name));
    // The allowed_tools filter is auto-mode filtering: the SDK Response
    // tool_choice has no bare "allowed" string (only
    // 'none'|'auto'|'required' or the ToolChoiceAllowed object), so the
    // effective echo is "auto" with the already-filtered catalog.
    effectiveToolChoice = toolChoice.mode;
  } else if (toolChoice?.kind === "named") {
    const requiredName = toolChoice.name;
      const catalogNames = new Set(
        effectiveTools === undefined ? [] : effectiveTools.map((t) => t.name),
      );
      if (!catalogNames.has(requiredName)) {
        throw new InvalidRequest(
          `tool_choice requires an unavailable tool: ${requiredName}`,
        );
      }
    effectiveToolChoice = "required";
  } else if (toolChoice?.kind === "required") {
    effectiveToolChoice = "required";
  } else if (toolChoice?.kind === "auto") {
    effectiveToolChoice = "auto";
  }
  return { tools: effectiveTools, effective: effectiveToolChoice };
}

function buildInvocation(
  value: unknown,
  validated: ValidatedResponsesRequest,
  freeformNames: Set<string>,
  additionalTools: unknown[],
  messages: Message[],
  reasoning: ResponsesReasoningSemantics,
  supplement: ResponsesProjectionSupplement,
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
    mergedTools,
    validated.toolChoice,
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
  return Object.freeze({
    selector: validated.selector,
    invocation: Object.freeze({
      pi: Object.freeze({ context, options }),
      reasoning,
      supplement,
    }),
    client: Object.freeze({
      renderState: Object.freeze({
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
      }),
      notices: Object.freeze(notices),
    }),
  });
}

/** Validate and retain Responses metadata for request-local response echo. */
function collectMetadataEcho(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const metadata = value.metadata;
  if (metadata === undefined || metadata === null) return undefined;
  if (!isRecord(metadata)) {
    throw new InvalidRequest("metadata must be an object when present");
  }
  const entries = Object.entries(metadata);
  if (entries.length > 16) {
    throw new InvalidRequest("metadata must contain at most 16 entries");
  }
  // A null-prototype object: hostile keys such as "__proto__" or
  // "constructor" from JSON.parse input can never pollute its prototype.
  const echo: Record<string, string> = Object.create(null);
  for (const [key, entry] of entries) {
    if (key.length > 64) {
      throw new InvalidRequest("metadata keys must be at most 64 characters");
    }
    if (typeof entry !== "string") {
      throw new InvalidRequest("metadata values must be strings");
    }
    if (entry.length > 512) {
      throw new InvalidRequest(
        "metadata values must be at most 512 characters",
      );
    }
    echo[key] = entry;
  }
  return Object.keys(echo).length === 0 ? undefined : Object.freeze(echo);
}

/**
 * Select and validate the consumed Responses facts, then build a Pi invocation.
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
  const selected = selectResponsesConsumerViews(value);
  const mainRequest = selected.mainRequest;
  const freeformNames = new Set<string>();
  const namespaceReverse: Record<string, { namespace: string; child: string }> =
    Object.create(null);
  const validated = validateMainRequest(
    mainRequest,
    freeformNames,
    namespaceReverse,
  );
  let supplement: ResponsesProjectionSupplement;
  try {
    supplement = parseResponsesProjectionSupplement(selected.supplementRequest);
  } catch (error) {
    if (error instanceof InvalidResponsesProjectionSupplement) {
      throw new InvalidRequest(error.message);
    }
    throw error;
  }
  const notices = selected.notices;
  const convertedReasoning = convertReasoning(
    mainRequest.reasoning,
    policy.futureReasoningEffort,
    notices,
  );
  if (convertedReasoning.piReasoning !== undefined) {
    validated.reasoning = convertedReasoning.piReasoning;
  }
  const additionalTools: unknown[] = [];
  const historicalReasoningCandidates: ResponsesHistoricalReasoningCandidate[] = [];
  const reasoningContinuityCandidates: ReasoningContinuityCandidate[] = [];
  const executableNames = collectExecutableNames(
    mainRequest,
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
    namespaceReverse,
    historicalReasoningCandidates,
    reasoningContinuityCandidates,
  );
  const reasoning: ResponsesReasoningSemantics = Object.freeze({
    request: convertedReasoning.intent,
    history: resolveResponsesHistoricalReasoning(
      messages,
      historicalReasoningCandidates,
    ),
    continuity: resolveReasoningContinuity(
      messages,
      reasoningContinuityCandidates,
    ),
  });
  return buildInvocation(
    mainRequest,
    validated,
    freeformNames,
    additionalTools,
    messages,
    reasoning,
    supplement,
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
  validateResolverLimits(limits);
  const selected = selectResponsesConsumerViews(value);
  const mainRequest = selected.mainRequest;
  const freeformNames = new Set<string>();
  const namespaceReverse: Record<string, { namespace: string; child: string }> =
    Object.create(null);
  const validated = validateMainRequest(
    mainRequest,
    freeformNames,
    namespaceReverse,
  );
  let supplement: ResponsesProjectionSupplement;
  try {
    supplement = parseResponsesProjectionSupplement(selected.supplementRequest);
  } catch (error) {
    if (error instanceof InvalidResponsesProjectionSupplement) {
      throw new InvalidRequest(error.message);
    }
    throw error;
  }
  const notices = selected.notices;
  const convertedReasoning = convertReasoning(
    mainRequest.reasoning,
    policy.futureReasoningEffort,
    notices,
  );
  if (convertedReasoning.piReasoning !== undefined) {
    validated.reasoning = convertedReasoning.piReasoning;
  }
  const additionalTools: unknown[] = [];
  const historicalReasoningCandidates: ResponsesHistoricalReasoningCandidate[] = [];
  const reasoningContinuityCandidates: ReasoningContinuityCandidate[] = [];
  const executableNames = collectExecutableNames(
    mainRequest,
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
    namespaceReverse,
    historicalReasoningCandidates,
    reasoningContinuityCandidates,
  );
  const reasoning: ResponsesReasoningSemantics = Object.freeze({
    request: convertedReasoning.intent,
    history: resolveResponsesHistoricalReasoning(
      messages,
      historicalReasoningCandidates,
    ),
    continuity: resolveReasoningContinuity(
      messages,
      reasoningContinuityCandidates,
    ),
  });
  return buildInvocation(
    mainRequest,
    validated,
    freeformNames,
    additionalTools,
    messages,
    reasoning,
    supplement,
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
