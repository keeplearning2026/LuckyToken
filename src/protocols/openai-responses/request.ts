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

export class InvalidRequest extends Error {
  readonly kind = "InvalidRequest";

  constructor(message: string) {
    super(message);
    this.name = "InvalidRequest";
  }
}

export interface ResponsesInvocation {
  selector: string;
  context: Context;
  options: ModelsSimpleStreamOptions;
  renderState: {
    clientModel: string;
    stream: boolean;
    /** Tool names declared as freeform `custom` tools; their calls must
     *  round-trip as `custom_tool_call` output items. */
    freeformToolNames?: ReadonlySet<string>;
  };
}

export interface ValidatedResponsesRequest {
  selector: string;
  instructions?: string;
  input: unknown;
  stream: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  reasoning?: string;
  tools?: Tool[];
}

export const SYNTHETIC_CLIENT_HISTORY_API = "luckytoken-client-history";
export const SYNTHETIC_CLIENT_HISTORY_PROVIDER = "luckytoken-client";

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
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidRequest(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidRequest(`${field} must be a finite number when present`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
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

function parseContentParts(content: unknown): TextContent[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const parts: TextContent[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const type = raw.type;
    if ((type === "input_text" || type === "text" || type === "output_text") && typeof raw.text === "string") {
      parts.push({ type: "text", text: raw.text });
    }
  }
  return parts;
}

function parseImageParts(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  const parts: ImageContent[] = [];
  for (const raw of content) {
    if (!isRecord(raw) || raw.type !== "input_image") continue;
    const imageUrl = raw.image_url;
    if (typeof imageUrl !== "string" || !imageUrl.startsWith("data:")) continue;
    const match = /^data:([^;]+);base64,(.*)$/su.exec(imageUrl);
    if (match === null) continue;
    const mimeType = match[1] ?? "";
    const data = match[2] ?? "";
    if (mimeType.length === 0 || data.length === 0) continue;
    parts.push({ type: "image", mimeType, data });
  }
  return parts;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
    return {};
  } catch {
    // Tolerate non-JSON arguments (e.g. a no-arg tool call serialized as "").
    return {};
  }
}

function convertTools(
  value: unknown,
  freeformNames?: Set<string>,
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
  ): void => {
    if (names.has(name)) return;
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
    }
    tools.push(tool);
  };

  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) {
      throw new InvalidRequest(`tools[${index}] must be an object`);
    }
    const type = candidate.type;
    const name = candidate.name;
    const description =
      typeof candidate.description === "string" ? candidate.description : "";

    if (type === "function" && typeof name === "string" && name.length > 0) {
      pushFunction(name, description, candidate.parameters, candidate.strict);
      continue;
    }
    if (type === "custom" && typeof name === "string" && name.length > 0) {
      // Freeform custom tool (e.g. apply_patch): expose as a function with a
      // single string `input` carrying the raw tool body.
      freeformNames?.add(name);
      pushFunction(name, description, {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Raw tool input.",
          },
        },
        required: ["input"],
      });
      continue;
    }
    if (type === "namespace" && Array.isArray(candidate.tools)) {
      // MCP tools arrive grouped under a namespace tool; flatten inner
      // function tools (opencodex behavior).
      for (const inner of candidate.tools) {
        if (
          isRecord(inner) &&
          inner.type === "function" &&
          typeof inner.name === "string" &&
          inner.name.length > 0
        ) {
          pushFunction(
            inner.name,
            typeof inner.description === "string" ? inner.description : "",
            inner.parameters,
          );
        }
      }
      continue;
    }
    // OpenAI-hosted server-side tools (web_search, image_generation, ...) and
    // tool_search are intentionally skipped: the local Provider cannot
    // execute them, and listing them would mislead the model. Tools with a
    // non-string name are also skipped (opencodex parity).
  }
  return tools;
}

function convertReasoning(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidRequest("reasoning must be an object when present");
  }
  const effort = value.effort;
  if (effort === undefined) return undefined;
  if (typeof effort !== "string") {
    throw new InvalidRequest("reasoning.effort must be a string when present");
  }
  if (effort === "ultra") return "max";
  const known = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (!known.has(effort)) {
    throw new InvalidRequest(
      `reasoning.effort is not a known thinking level: ${effort}`,
    );
  }
  if (effort === "none") return undefined;
  return effort;
}

export function validateResponsesRequest(
  value: unknown,
  freeformNames?: Set<string>,
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
    (typeof previousResponseId !== "string" || previousResponseId.length === 0)
  ) {
    throw new InvalidRequest(
      "previous_response_id must be a non-empty string when present",
    );
  }
  if (value.store !== undefined && typeof value.store !== "boolean") {
    throw new InvalidRequest("store must be a boolean when present");
  }
  if (value.tool_choice !== undefined) {
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
  }
  const maxOutputTokens = optionalNonNegativeInt(
    value.max_output_tokens,
    "max_output_tokens",
  );
  const temperature = optionalFiniteNumber(value.temperature, "temperature");
  const topP = optionalFiniteNumber(value.top_p, "top_p");
  if (topP !== undefined) {
    // Validated but not converted (no Pi option for top_p in the closed set).
  }
  const tools = convertTools(value.tools, freeformNames);
  const reasoning = convertReasoning(value.reasoning);
  const instructions =
    value.instructions === undefined
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
  if (reasoning !== undefined) validated.reasoning = reasoning;
  if (tools !== undefined) validated.tools = tools;
  return validated;
}

function convertMessages(
  input: unknown,
  selector: string,
  receivedAt: number,
  additionalTools: unknown[],
): Message[] {
  const messages: Message[] = [];
  const systemPromptParts: string[] = [];
  let pendingReasoning: ThinkingContent[] = [];
  const assistantIndex = new Map<string, string>();

  const flushAssistant = (content: Array<TextContent | ThinkingContent | ToolCall>): void => {
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

  const items: unknown[] =
    typeof input === "string"
      ? [{ role: "user", content: input }]
      : (input as unknown[]);
  for (const rawItem of items) {
    if (!isRecord(rawItem)) continue;
    const type = rawItem.type ?? (typeof rawItem.role === "string" ? "message" : undefined);
    if (type === undefined) continue;

    switch (type) {
      case "message": {
        const role = rawItem.role;
        const content = parseContentParts(rawItem.content);
        const images = parseImageParts(rawItem.content);
        if (role === "system" || role === "developer") {
          const text = content.map((part) => part.text).join("");
          if (text.length > 0) systemPromptParts.push(text);
          pendingReasoning = [];
          continue;
        }
        if (role === "user") {
          pendingReasoning = [];
          const blocks = [...content, ...images];
          messages.push({
            role: "user",
            content: blocks,
            timestamp: receivedAt,
          });
          continue;
        }
        if (role === "assistant") {
          const blocks: Array<TextContent | ThinkingContent | ToolCall> = [
            ...pendingReasoning,
            ...content,
          ];
          pendingReasoning = [];
          flushAssistant(blocks);
          continue;
        }
        throw new InvalidRequest(`message role is not supported: ${String(role)}`);
      }
      case "reasoning": {
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
        if (thinking.length > 0) {
          pendingReasoning.push({ type: "thinking", thinking });
        }
        continue;
      }
      case "function_call":
      case "custom_tool_call": {
        const callId = nonEmptyString(rawItem.call_id, "function_call.call_id");
        const name = nonEmptyString(rawItem.name, "function_call.name");
        const argumentsJson =
          type === "custom_tool_call"
            ? { input: typeof rawItem.input === "string" ? rawItem.input : "" }
            : parseToolArguments(rawItem.arguments);
        const toolCall: ToolCall = {
          type: "toolCall",
          id: callId,
          name,
          arguments: argumentsJson,
        };
        // Find or create the assistant container.
        const last = messages.at(-1);
        if (last?.role === "assistant") {
          (last.content as Array<TextContent | ThinkingContent | ToolCall>).push(toolCall);
          assistantIndex.set(toolCall.id, toolCall.name);
        } else {
          flushAssistant([...pendingReasoning, toolCall]);
        }
        pendingReasoning = [];
        continue;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = nonEmptyString(rawItem.call_id, "function_call_output.call_id");
        const toolName = assistantIndex.get(callId);
        if (toolName === undefined) {
          // Codex real clients send tool-result increments that may reference
          // a call from an earlier response (or an incomplete replay).
          // Rejecting the whole turn would kill the conversation, so an
          // orphan output is tolerated: it is dropped from the Pi context.
          pendingReasoning = [];
          continue;
        }
        const output = rawItem.output;
        const text =
          typeof output === "string"
            ? output
            : Array.isArray(output)
              ? output
                  .filter(isRecord)
                  .filter((part) => part.type === "input_text" || part.type === "text")
                  .map((part) => (typeof part.text === "string" ? part.text : ""))
                  .join("\n")
              : "";
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: callId,
          toolName,
          content: text.length === 0 ? [] : [{ type: "text", text }],
          isError: false,
          timestamp: receivedAt,
        };
        messages.push(result);
        pendingReasoning = [];
        continue;
      }
      case "compaction":
      case "compaction_summary":
      case "context_compaction": {
        const encrypted = rawItem.encrypted_content;
        if (type === "context_compaction" && typeof encrypted !== "string") continue;
        const text =
          typeof encrypted === "string"
            ? `[compacted conversation: ${encrypted.length} bytes of encrypted content]`
            : "[compacted conversation]";
        pendingReasoning = [];
        messages.push({ role: "user", content: [{ type: "text", text }], timestamp: receivedAt });
        continue;
      }
      case "agent_message": {
        const content = parseContentParts(rawItem.content);
        const text = content.map((part) => part.text).join("") || "(sub-agent message received)";
        pendingReasoning = [];
        messages.push({ role: "user", content: [{ type: "text", text }], timestamp: receivedAt });
        continue;
      }
      case "web_search_call":
      case "web_search_tool_call":
      case "tool_search_call":
      case "compaction_trigger":
        continue;
      case "additional_tools": {
        const additional = rawItem.tools;
        if (Array.isArray(additional)) {
          additionalTools.push(...additional);
        }
        continue;
      }
      default:
        throw new InvalidRequest(`Unsupported input item type: ${String(type)}`);
    }
  }

  return messages;
}

export function convertResponsesRequest(
  value: unknown,
  receivedAt: number,
): ResponsesInvocation {
  const freeformNames = new Set<string>();
  const validated = validateResponsesRequest(value, freeformNames);
  const additionalTools: unknown[] = [];
  const messages = convertMessages(
    validated.input,
    validated.selector,
    receivedAt,
    additionalTools,
  );
  const context: Context = { messages };
  if (validated.instructions !== undefined) {
    context.systemPrompt = validated.instructions;
  }
  const mergedTools =
    validated.tools === undefined
      ? additionalTools.length === 0
        ? undefined
        : convertTools(additionalTools, freeformNames)
      : [
          ...validated.tools,
          ...(convertTools(additionalTools, freeformNames) ?? []),
        ];
  if (mergedTools !== undefined && mergedTools.length > 0) {
    context.tools = mergedTools;
  }
  const options: ModelsSimpleStreamOptions = {};
  if (validated.maxOutputTokens !== undefined) {
    options.maxTokens = validated.maxOutputTokens;
  }
  if (validated.temperature !== undefined) {
    options.temperature = validated.temperature;
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
      ...(freeformNames.size > 0 ? { freeformToolNames: freeformNames } : {}),
    },
  };
}
