import { parseTree, type Node as JsonNode } from "jsonc-parser";

export type AnthropicNativeBodyProjectionMode =
  | "model_only"
  | "anthropic_oauth";

export interface AnthropicNativeBodyProjectionInput {
  readonly rawBody: string;
  readonly modelId: string;
  readonly mode: AnthropicNativeBodyProjectionMode;
}

export interface AnthropicNativeBodyProjectionResult {
  readonly body: string;
  readonly applied: AnthropicNativeBodyProjectionMode;
}

export class AnthropicNativeBodyProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicNativeBodyProjectionError";
  }
}

const CLAUDE_CODE_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const CLAUDE_CODE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
] as const;

const CLAUDE_CODE_TOOL_LOOKUP = new Map(
  CLAUDE_CODE_TOOL_NAMES.map((name) => [name.toLowerCase(), name]),
);

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function projectionFailure(message: string): never {
  throw new AnthropicNativeBodyProjectionError(message);
}

function modelValueNode(rawBody: string): JsonNode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return projectionFailure("Anthropic Native request body is not valid JSON");
  }
  if (objectRecord(parsed) === undefined) {
    return projectionFailure("Anthropic Native request body must be a JSON object");
  }

  const tree = parseTree(rawBody, [], {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (tree?.type !== "object") {
    return projectionFailure("Anthropic Native request body has no object syntax tree");
  }
  const matches = (tree.children ?? []).filter(
    (property) =>
      property.type === "property" &&
      property.children?.[0]?.type === "string" &&
      property.children[0].value === "model",
  );
  if (matches.length !== 1) {
    return projectionFailure(
      "Anthropic Native request body must contain exactly one top-level model",
    );
  }
  const value = matches[0]?.children?.[1];
  if (value?.type !== "string") {
    return projectionFailure(
      "Anthropic Native request body top-level model must be a string",
    );
  }
  return value;
}

function projectModelSpan(rawBody: string, modelId: string): string {
  const value = modelValueNode(rawBody);
  return `${rawBody.slice(0, value.offset)}${JSON.stringify(modelId)}${rawBody.slice(
    value.offset + value.length,
  )}`;
}

function canonicalToolName(name: string): string {
  return CLAUDE_CODE_TOOL_LOOKUP.get(name.toLowerCase()) ?? name;
}

function canonicalizeContentBlocks(value: unknown, path: string): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) {
    projectionFailure(`${path} must be a string or content-block array`);
  }
  value.forEach((entry, index) => {
    const block = objectRecord(entry);
    if (block === undefined) {
      projectionFailure(`${path}[${index}] must be an object`);
    }
    if (block.type === "tool_use") {
      if (typeof block.name !== "string") {
        projectionFailure(`${path}[${index}].name must be a string`);
      }
      block.name = canonicalToolName(block.name);
    }
    if (block.type === "tool_reference") {
      if (typeof block.tool_name !== "string") {
        projectionFailure(`${path}[${index}].tool_name must be a string`);
      }
      block.tool_name = canonicalToolName(block.tool_name);
    }
    if (block.type === "tool_result" && block.content !== undefined) {
      canonicalizeContentBlocks(block.content, `${path}[${index}].content`);
    }
  });
}

function applyClaudeCodeDifferential(body: Record<string, unknown>): void {
  const identity = {
    type: "text",
    text: CLAUDE_CODE_SYSTEM_IDENTITY,
  } as const;
  if (body.system === undefined) {
    body.system = [identity];
  } else if (typeof body.system === "string") {
    body.system = [identity, { type: "text", text: body.system }];
  } else if (Array.isArray(body.system)) {
    body.system = [identity, ...body.system];
  } else {
    projectionFailure(
      "Anthropic OAuth Native system must be a string or content-block array",
    );
  }

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      projectionFailure("Anthropic OAuth Native tools must be an array");
    }
    body.tools.forEach((entry, index) => {
      const tool = objectRecord(entry);
      if (tool === undefined) {
        projectionFailure(`Anthropic OAuth Native tools[${index}] must be an object`);
      }
      if (tool.name !== undefined) {
        if (typeof tool.name !== "string") {
          projectionFailure(
            `Anthropic OAuth Native tools[${index}].name must be a string`,
          );
        }
        tool.name = canonicalToolName(tool.name);
      }
    });
  }

  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages)) {
      projectionFailure("Anthropic OAuth Native messages must be an array");
    }
    body.messages.forEach((entry, index) => {
      const message = objectRecord(entry);
      if (message === undefined) {
        projectionFailure(
          `Anthropic OAuth Native messages[${index}] must be an object`,
        );
      }
      if (message.content !== undefined) {
        canonicalizeContentBlocks(
          message.content,
          `Anthropic OAuth Native messages[${index}].content`,
        );
      }
    });
  }
}

/**
 * Project the Provider model identity and, only for the closed first-party
 * managed-OAuth mode selected by the Anthropic Native lane, the pinned Claude
 * Code request-body differential.
 */
export function projectAnthropicNativeBody(
  input: AnthropicNativeBodyProjectionInput,
): AnthropicNativeBodyProjectionResult {
  const modelProjected = projectModelSpan(input.rawBody, input.modelId);
  if (input.mode === "model_only") {
    return Object.freeze({ body: modelProjected, applied: input.mode });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(modelProjected);
  } catch {
    return projectionFailure(
      "Anthropic OAuth Native model projection produced invalid JSON",
    );
  }
  const body = objectRecord(parsed);
  if (body === undefined) {
    return projectionFailure("Anthropic OAuth Native body must be an object");
  }
  applyClaudeCodeDifferential(body);
  return Object.freeze({
    body: JSON.stringify(body),
    applied: input.mode,
  });
}
