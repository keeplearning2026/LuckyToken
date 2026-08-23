import { InvalidRequest } from "../../failures.js";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const IMAGE_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const CALLER_TYPES = new Set([
  "direct",
  "code_execution_20250825",
  "code_execution_20260120",
]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRequest(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const set = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !set.has(key));
  if (unknown !== undefined) {
    throw new InvalidRequest(`${path}.${unknown} is unexpected`);
  }
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new InvalidRequest(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function nullableString(value: unknown, path: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new InvalidRequest(`${path} must be a string or null`);
  }
}

function requiredNullableString(value: unknown, path: string): void {
  if (value !== null && typeof value !== "string") {
    throw new InvalidRequest(`${path} must be a string or null`);
  }
}

function safeInteger(value: unknown, path: string, nullable = false): void {
  if (nullable && (value === null || value === undefined)) return;
  if (!Number.isSafeInteger(value)) {
    throw new InvalidRequest(`${path} must be a safe integer${nullable ? " or null" : ""}`);
  }
}

function validateCacheControl(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  const cache = record(value, path);
  exactKeys(cache, ["type", "ttl"], path);
  if (cache.type !== "ephemeral") {
    throw new InvalidRequest(`${path}.type must be ephemeral`);
  }
  if (cache.ttl !== undefined && cache.ttl !== "5m" && cache.ttl !== "1h") {
    throw new InvalidRequest(`${path}.ttl must be 5m or 1h`);
  }
}

function validateCitationsConfig(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  const config = record(value, path);
  exactKeys(config, ["enabled"], path);
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new InvalidRequest(`${path}.enabled must be boolean`);
  }
}

function validateCaller(value: unknown, path: string): void {
  if (value === undefined) return;
  const caller = record(value, path);
  if (!CALLER_TYPES.has(String(caller.type))) {
    throw new InvalidRequest(`${path}.type is not a supported Anthropic caller`);
  }
  if (caller.type === "direct") {
    exactKeys(caller, ["type"], path);
    return;
  }
  exactKeys(caller, ["type", "tool_id"], path);
  string(caller.tool_id, `${path}.tool_id`);
}

const CITATION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  char_location: [
    "type", "cited_text", "document_index", "document_title",
    "start_char_index", "end_char_index",
  ],
  page_location: [
    "type", "cited_text", "document_index", "document_title",
    "start_page_number", "end_page_number",
  ],
  content_block_location: [
    "type", "cited_text", "document_index", "document_title",
    "start_block_index", "end_block_index",
  ],
  web_search_result_location: [
    "type", "cited_text", "encrypted_index", "title", "url",
  ],
  search_result_location: [
    "type", "cited_text", "search_result_index", "source", "title",
    "start_block_index", "end_block_index",
  ],
};

function validateCitation(value: unknown, path: string): void {
  const citation = record(value, path);
  const fields = CITATION_FIELDS[String(citation.type)];
  if (fields === undefined) {
    throw new InvalidRequest(`${path}.type is not a recognized citation type`);
  }
  exactKeys(citation, fields, path);
  string(citation.cited_text, `${path}.cited_text`, true);
  const titleKey = fields.includes("title") ? "title" : "document_title";
  requiredNullableString(citation[titleKey], `${path}.${titleKey}`);
  for (const key of fields.filter(
    (field) => field.endsWith("_index") && field !== "encrypted_index",
  )) {
    safeInteger(citation[key], `${path}.${key}`);
  }
  for (const key of ["source", "url", "encrypted_index"] as const) {
    if (fields.includes(key)) string(citation[key], `${path}.${key}`);
  }
}

function enumString(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new InvalidRequest(`${path} is not a recognized value`);
  }
}

function validateOutputBlocks(input: {
  readonly value: unknown;
  readonly type: "code_execution_output" | "bash_code_execution_output";
  readonly path: string;
}): void {
  if (!Array.isArray(input.value)) {
    throw new InvalidRequest(`${input.path} must be an output-block array`);
  }
  input.value.forEach((entry, index) => {
    const outputPath = `${input.path}[${index}]`;
    const output = record(entry, outputPath);
    exactKeys(output, ["type", "file_id"], outputPath);
    if (output.type !== input.type) {
      throw new InvalidRequest(`${outputPath}.type must be ${input.type}`);
    }
    string(output.file_id, `${outputPath}.file_id`);
  });
}

const COMMON_SERVER_ERROR_CODES = new Set([
  "invalid_tool_input",
  "unavailable",
  "too_many_requests",
  "execution_time_exceeded",
]);

function validateServerError(input: {
  readonly value: Record<string, unknown>;
  readonly type: string;
  readonly allowedCodes: ReadonlySet<string>;
  readonly path: string;
  readonly errorMessage?: boolean;
}): void {
  exactKeys(
    input.value,
    input.errorMessage ? ["type", "error_code", "error_message"] : ["type", "error_code"],
    input.path,
  );
  if (input.value.type !== input.type) {
    throw new InvalidRequest(`${input.path}.type must be ${input.type}`);
  }
  enumString(input.value.error_code, input.allowedCodes, `${input.path}.error_code`);
  if (input.errorMessage === true) {
    nullableString(input.value.error_message, `${input.path}.error_message`);
  }
}

function validateExecutionResult(input: {
  readonly value: Record<string, unknown>;
  readonly path: string;
  readonly family: "code" | "bash";
}): void {
  const outputType = input.family === "code"
    ? "code_execution_output" as const
    : "bash_code_execution_output" as const;
  const resultType = input.family === "code"
    ? "code_execution_result"
    : "bash_code_execution_result";
  exactKeys(input.value, ["type", "content", "return_code", "stdout", "stderr"], input.path);
  if (input.value.type !== resultType) {
    throw new InvalidRequest(`${input.path}.type must be ${resultType}`);
  }
  validateOutputBlocks({ value: input.value.content, type: outputType, path: `${input.path}.content` });
  safeInteger(input.value.return_code, `${input.path}.return_code`);
  string(input.value.stdout, `${input.path}.stdout`, true);
  string(input.value.stderr, `${input.path}.stderr`, true);
}

function validateCodeExecutionContent(value: Record<string, unknown>, path: string): void {
  if (value.type === "code_execution_tool_result_error") {
    validateServerError({ value, type: value.type, allowedCodes: COMMON_SERVER_ERROR_CODES, path });
    return;
  }
  if (value.type === "code_execution_result") {
    validateExecutionResult({ value, path, family: "code" });
    return;
  }
  if (value.type === "encrypted_code_execution_result") {
    exactKeys(value, ["type", "content", "return_code", "encrypted_stdout", "stderr"], path);
    validateOutputBlocks({ value: value.content, type: "code_execution_output", path: `${path}.content` });
    safeInteger(value.return_code, `${path}.return_code`);
    string(value.encrypted_stdout, `${path}.encrypted_stdout`, true);
    string(value.stderr, `${path}.stderr`, true);
    return;
  }
  throw new InvalidRequest(`${path} is not a recognized code_execution_tool_result payload`);
}

function validateBashExecutionContent(value: Record<string, unknown>, path: string): void {
  if (value.type === "bash_code_execution_tool_result_error") {
    validateServerError({
      value,
      type: value.type,
      allowedCodes: new Set([...COMMON_SERVER_ERROR_CODES, "output_file_too_large"]),
      path,
    });
    return;
  }
  if (value.type === "bash_code_execution_result") {
    validateExecutionResult({ value, path, family: "bash" });
    return;
  }
  throw new InvalidRequest(`${path} is not a recognized bash_code_execution_tool_result payload`);
}

function validateTextEditorContent(value: Record<string, unknown>, path: string): void {
  if (value.type === "text_editor_code_execution_tool_result_error") {
    validateServerError({
      value,
      type: value.type,
      allowedCodes: new Set([...COMMON_SERVER_ERROR_CODES, "file_not_found"]),
      path,
      errorMessage: true,
    });
    return;
  }
  if (value.type === "text_editor_code_execution_view_result") {
    exactKeys(value, ["type", "content", "file_type", "num_lines", "start_line", "total_lines"], path);
    string(value.content, `${path}.content`, true);
    enumString(value.file_type, new Set(["text", "image", "pdf"]), `${path}.file_type`);
    for (const key of ["num_lines", "start_line", "total_lines"] as const) {
      safeInteger(value[key], `${path}.${key}`, true);
    }
    return;
  }
  if (value.type === "text_editor_code_execution_create_result") {
    exactKeys(value, ["type", "is_file_update"], path);
    if (typeof value.is_file_update !== "boolean") {
      throw new InvalidRequest(`${path}.is_file_update must be boolean`);
    }
    return;
  }
  if (value.type === "text_editor_code_execution_str_replace_result") {
    exactKeys(value, ["type", "lines", "new_lines", "new_start", "old_lines", "old_start"], path);
    if (value.lines !== undefined && value.lines !== null &&
      (!Array.isArray(value.lines) || value.lines.some((line) => typeof line !== "string"))) {
      throw new InvalidRequest(`${path}.lines must be an array of strings or null`);
    }
    for (const key of ["new_lines", "new_start", "old_lines", "old_start"] as const) {
      safeInteger(value[key], `${path}.${key}`, true);
    }
    return;
  }
  throw new InvalidRequest(`${path} is not a recognized text_editor_code_execution_tool_result payload`);
}

function validateToolSearchContent(value: Record<string, unknown>, path: string): void {
  if (value.type === "tool_search_tool_result_error") {
    validateServerError({
      value,
      type: value.type,
      allowedCodes: COMMON_SERVER_ERROR_CODES,
      path,
      errorMessage: true,
    });
    return;
  }
  exactKeys(value, ["type", "tool_references"], path);
  if (value.type !== "tool_search_tool_search_result" || !Array.isArray(value.tool_references)) {
    throw new InvalidRequest(`${path} is not a recognized tool_search_tool_result payload`);
  }
  value.tool_references.forEach((entry, index) =>
    validateToolReference(entry, `${path}.tool_references[${index}]`),
  );
}

function validateWebFetchContent(value: Record<string, unknown>, path: string): void {
  if (value.type === "web_fetch_tool_result_error") {
    validateServerError({
      value,
      type: value.type,
      allowedCodes: new Set([
        "invalid_tool_input", "url_too_long", "url_not_allowed", "url_not_accessible",
        "unsupported_content_type", "too_many_requests", "max_uses_exceeded", "unavailable",
      ]),
      path,
    });
    return;
  }
  exactKeys(value, ["type", "url", "retrieved_at", "content"], path);
  if (value.type !== "web_fetch_result") {
    throw new InvalidRequest(`${path} is not a recognized web_fetch_tool_result payload`);
  }
  string(value.url, `${path}.url`);
  nullableString(value.retrieved_at, `${path}.retrieved_at`);
  const document = record(value.content, `${path}.content`);
  if (document.type !== "document") {
    throw new InvalidRequest(`${path}.content must be a document block`);
  }
  validateDocumentBlock(document, `${path}.content`);
}

function validateTextBlock(block: Record<string, unknown>, path: string): void {
  exactKeys(block, ["type", "text", "cache_control", "citations", "luckytoken_continuity"], path);
  string(block.text, `${path}.text`, true);
  validateCacheControl(block.cache_control, `${path}.cache_control`);
  if (block.citations !== undefined && block.citations !== null) {
    if (!Array.isArray(block.citations)) {
      throw new InvalidRequest(`${path}.citations must be an array or null`);
    }
    block.citations.forEach((citation, index) =>
      validateCitation(citation, `${path}.citations[${index}]`),
    );
  }
}

function validateImageBlock(block: Record<string, unknown>, path: string): void {
  exactKeys(block, ["type", "source", "cache_control"], path);
  const source = record(block.source, `${path}.source`);
  if (source.type === "url") {
    exactKeys(source, ["type", "url"], `${path}.source`);
    string(source.url, `${path}.source.url`);
  } else if (source.type === "base64") {
    exactKeys(source, ["type", "media_type", "data"], `${path}.source`);
    if (!IMAGE_MEDIA.has(String(source.media_type))) {
      throw new InvalidRequest(`${path}.source.media_type is not a supported image type`);
    }
    if (typeof source.data !== "string" || !BASE64.test(source.data)) {
      throw new InvalidRequest(`${path}.source.data must be valid base64`);
    }
  } else {
    throw new InvalidRequest(`${path}.source.type is not supported`);
  }
  validateCacheControl(block.cache_control, `${path}.cache_control`);
}

function validateDocumentBlock(block: Record<string, unknown>, path: string): void {
  exactKeys(
    block,
    ["type", "source", "cache_control", "citations", "context", "title"],
    path,
  );
  validateCacheControl(block.cache_control, `${path}.cache_control`);
  validateCitationsConfig(block.citations, `${path}.citations`);
  nullableString(block.context, `${path}.context`);
  nullableString(block.title, `${path}.title`);
  const source = record(block.source, `${path}.source`);
  if (source.type === "base64") {
    exactKeys(source, ["type", "media_type", "data"], `${path}.source`);
    if (source.media_type !== "application/pdf") {
      throw new InvalidRequest(`${path}.source.media_type must be application/pdf`);
    }
    if (typeof source.data !== "string" || !BASE64.test(source.data)) {
      throw new InvalidRequest(`${path}.source.data must be valid base64`);
    }
    return;
  }
  if (source.type === "url") {
    exactKeys(source, ["type", "url"], `${path}.source`);
    string(source.url, `${path}.source.url`);
    return;
  }
  if (source.type === "text") {
    exactKeys(source, ["type", "media_type", "data"], `${path}.source`);
    if (source.media_type !== undefined && source.media_type !== "text/plain") {
      throw new InvalidRequest(`${path}.source.media_type must be text/plain`);
    }
    string(source.data, `${path}.source.data`, true);
    return;
  }
  if (source.type !== "content") {
    throw new InvalidRequest(`${path}.source.type is not supported`);
  }
  exactKeys(source, ["type", "content"], `${path}.source`);
  if (typeof source.content === "string") return;
  if (!Array.isArray(source.content)) {
    throw new InvalidRequest(`${path}.source.content must be a string or block array`);
  }
  source.content.forEach((nested, index) => {
    const candidate = record(nested, `${path}.source.content[${index}]`);
    if (candidate.type === "text") validateTextBlock(candidate, `${path}.source.content[${index}]`);
    else if (candidate.type === "image") validateImageBlock(candidate, `${path}.source.content[${index}]`);
    else throw new InvalidRequest(`${path}.source.content[${index}] must be text or image`);
  });
}

function validateSearchResult(block: Record<string, unknown>, path: string): void {
  exactKeys(block, ["type", "source", "title", "content", "cache_control", "citations"], path);
  string(block.source, `${path}.source`, true);
  string(block.title, `${path}.title`, true);
  if (!Array.isArray(block.content)) {
    throw new InvalidRequest(`${path}.content must be a text-block array`);
  }
  block.content.forEach((nested, index) => {
    const candidate = record(nested, `${path}.content[${index}]`);
    if (candidate.type !== "text") {
      throw new InvalidRequest(`${path}.content[${index}] must be a text block`);
    }
    validateTextBlock(candidate, `${path}.content[${index}]`);
  });
  validateCacheControl(block.cache_control, `${path}.cache_control`);
  validateCitationsConfig(block.citations, `${path}.citations`);
}

function validateToolReference(value: unknown, path: string): void {
  const block = record(value, path);
  exactKeys(block, ["type", "tool_name", "cache_control"], path);
  if (block.type !== "tool_reference") throw new InvalidRequest(`${path}.type must be tool_reference`);
  string(block.tool_name, `${path}.tool_name`);
  validateCacheControl(block.cache_control, `${path}.cache_control`);
}

function validateToolResult(block: Record<string, unknown>, path: string): void {
  exactKeys(block, ["type", "tool_use_id", "cache_control", "content", "is_error"], path);
  string(block.tool_use_id, `${path}.tool_use_id`);
  validateCacheControl(block.cache_control, `${path}.cache_control`);
  if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
    throw new InvalidRequest(`${path}.is_error must be boolean`);
  }
  if (block.content === undefined || typeof block.content === "string") return;
  if (!Array.isArray(block.content)) throw new InvalidRequest(`${path}.content must be a string or block array`);
  block.content.forEach((nested, index) => {
    const candidate = record(nested, `${path}.content[${index}]`);
    const nestedPath = `${path}.content[${index}]`;
    if (candidate.type === "text") validateTextBlock(candidate, nestedPath);
    else if (candidate.type === "image") validateImageBlock(candidate, nestedPath);
    else if (candidate.type === "document") validateDocumentBlock(candidate, nestedPath);
    else if (candidate.type === "search_result") validateSearchResult(candidate, nestedPath);
    else if (candidate.type === "tool_reference") validateToolReference(candidate, nestedPath);
    else throw new InvalidRequest(`${nestedPath}.type is not supported in tool_result`);
  });
}

function validateServerToolResult(block: Record<string, unknown>, path: string): void {
  const permitsCaller = block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result";
  exactKeys(
    block,
    permitsCaller
      ? ["type", "tool_use_id", "content", "cache_control", "caller"]
      : ["type", "tool_use_id", "content", "cache_control"],
    path,
  );
  string(block.tool_use_id, `${path}.tool_use_id`);
  validateCacheControl(block.cache_control, `${path}.cache_control`);
  if (permitsCaller) validateCaller(block.caller, `${path}.caller`);
  const content = block.content;
  if (block.type === "web_search_tool_result") {
    if (Array.isArray(content)) {
      content.forEach((value, index) => {
        const result = record(value, `${path}.content[${index}]`);
        exactKeys(result, ["type", "encrypted_content", "title", "url", "page_age"], `${path}.content[${index}]`);
        if (result.type !== "web_search_result") throw new InvalidRequest(`${path}.content[${index}] is not a web_search result`);
        string(result.encrypted_content, `${path}.content[${index}].encrypted_content`, true);
        string(result.title, `${path}.content[${index}].title`, true);
        string(result.url, `${path}.content[${index}].url`);
        nullableString(result.page_age, `${path}.content[${index}].page_age`);
      });
      return;
    }
    const error = record(content, `${path}.content`);
    exactKeys(error, ["type", "error_code"], `${path}.content`);
    if (error.type !== "web_search_tool_result_error" || typeof error.error_code !== "string") {
      throw new InvalidRequest(`${path}.content is not a valid web_search result or error`);
    }
    return;
  }
  const nestedPath = `${path}.content`;
  const nested = record(content, nestedPath);
  switch (block.type) {
    case "web_fetch_tool_result":
      validateWebFetchContent(nested, nestedPath);
      return;
    case "code_execution_tool_result":
      validateCodeExecutionContent(nested, nestedPath);
      return;
    case "bash_code_execution_tool_result":
      validateBashExecutionContent(nested, nestedPath);
      return;
    case "text_editor_code_execution_tool_result":
      validateTextEditorContent(nested, nestedPath);
      return;
    case "tool_search_tool_result":
      validateToolSearchContent(nested, nestedPath);
      return;
    default:
      throw new InvalidRequest(`${path}.type is not a recognized server tool result`);
  }
}

export function validateAnthropicSystemSupplementBlock(
  block: Record<string, unknown>,
  path: string,
): void {
  validateTextBlock(block, path);
}

export function validateAnthropicSupplementContentBlock(
  block: Record<string, unknown>,
  path: string,
): void {
  switch (block.type) {
    case "text":
      validateTextBlock(block, path);
      return;
    case "image":
      validateImageBlock(block, path);
      return;
    case "document":
      validateDocumentBlock(block, path);
      return;
    case "search_result":
      validateSearchResult(block, path);
      return;
    case "thinking":
      exactKeys(block, ["type", "thinking", "signature", "luckytoken_continuity"], path);
      return;
    case "redacted_thinking":
      exactKeys(block, ["type", "data", "luckytoken_continuity"], path);
      return;
    case "tool_use":
      exactKeys(block, ["type", "id", "name", "input", "cache_control", "caller", "luckytoken_continuity"], path);
      validateCacheControl(block.cache_control, `${path}.cache_control`);
      validateCaller(block.caller, `${path}.caller`);
      return;
    case "tool_result":
      validateToolResult(block, path);
      return;
    case "server_tool_use":
      exactKeys(block, ["type", "id", "name", "input", "cache_control", "caller"], path);
      validateCacheControl(block.cache_control, `${path}.cache_control`);
      validateCaller(block.caller, `${path}.caller`);
      return;
    case "container_upload":
      exactKeys(block, ["type", "file_id", "cache_control"], path);
      validateCacheControl(block.cache_control, `${path}.cache_control`);
      return;
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
      validateServerToolResult(block, path);
      return;
    default:
      return;
  }
}
