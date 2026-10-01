/**
 * Codex remote compaction v2 shared wire boundary. Native and Semantic own
 * their execution; this module owns only the rewrite, summary and envelope.
 *
 * Codex decides "this provider supports remote compaction" by provider name
 * (the built-in `openai` provider), and a proxied OpenAI provider points that
 * name at Token — so Codex sends remote compaction v2 requests for every
 * routed model. The request is an ordinary `/v1/responses` call whose input
 * ends with `{"type":"compaction_trigger"}`; codex-rs then requires the
 * stream to carry EXACTLY ONE `{"type":"compaction","encrypted_content":...}`
 * output item or it fatals with "expected exactly one compaction output item".
 *
 * Routed models cannot mint OpenAI's opaque blob, so Token runs the model as
 * a plain summarizer and wraps the summary text in a transparent envelope:
 * `Token1:` + base64(utf8 summary). Codex stores the item and replays it
 * verbatim in later input; {@link expandTokenCompactionEnvelopes} decodes the
 * envelope back into plain model-visible text for routed models. Foreign
 * OpenAI-encrypted blobs stay opaque and fail conversion rather than being
 * fabricated.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import { flattenResponsesNamespaceToolName } from "./protocols/openai-responses/namespace-tool-name.js";
import { renderResponsesSse } from "./responses-sse.js";

interface CompactionOutputItem {
  readonly type: "compaction";
  readonly id: string;
  readonly encrypted_content: string;
}

export const TOKEN_COMPACTION_PREFIX = "Token1:";

export class CodexRoutedCompactionSummaryError extends Error {
  readonly kind = "CodexRoutedCompactionSummaryError" as const;

  constructor(
    message = "Routed compaction summarizer produced no complete text",
  ) {
    super(message);
    this.name = "CodexRoutedCompactionSummaryError";
  }
}

export class CodexRoutedCompactionRequestError extends Error {
  readonly kind = "CodexRoutedCompactionRequestError" as const;

  constructor(message: string) {
    super(message);
    this.name = "CodexRoutedCompactionRequestError";
  }
}

/**
 * Summarizer prompts ported from the pi-agent harness
 * (`reference/pi-agent/packages/agent/src/harness/compaction/compaction.ts`).
 * Token keeps the Responses history structured and borrows the prompt
 * contract: a system role that forbids continuing the conversation, plus the
 * exact structured handoff format for the summary.
 */
export const ROUTED_COMPACTION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const ROUTED_COMPACTION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** pi-agent's replayed-summary framing. */
const ROUTED_COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const ROUTED_COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCodexRoutedCompactionRequest(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.input) || body.input.length === 0) {
    return false;
  }
  const last = body.input.at(-1);
  return isRecord(last) && last.type === "compaction_trigger";
}

function decodeSummary(encryptedContent: string): string | undefined {
  if (!encryptedContent.startsWith(TOKEN_COMPACTION_PREFIX)) return undefined;
  const payload = encryptedContent.slice(TOKEN_COMPACTION_PREFIX.length);
  if (payload.length === 0) return undefined;
  const base64Pattern =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
  if (!base64Pattern.test(payload)) return undefined;
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) return undefined;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return undefined;
  }
  return decoded.length === 0 ? undefined : decoded;
}

/**
 * Render replayed `Token1:` compaction items as plain model-visible text.
 * Foreign (real OpenAI-encrypted) items are returned untouched so the request
 * converter keeps failing them instead of fabricating summary bytes.
 */
export function expandTokenCompactionEnvelopes(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.input)) return body;
  return {
    ...body,
    input: body.input.map((item) => {
      if (
        !isRecord(item) ||
        (item.type !== "compaction" && item.type !== "compaction_summary") ||
        typeof item.encrypted_content !== "string"
      ) {
        return item;
      }
      const summary = decodeSummary(item.encrypted_content);
      if (summary === undefined) return item;
      return {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${ROUTED_COMPACTION_SUMMARY_PREFIX}${summary}${ROUTED_COMPACTION_SUMMARY_SUFFIX}`,
          },
        ],
      };
    }),
  };
}

/** Collect declared namespace/child identities from both Responses locations. */
function declaredNamespaceChildren(
  body: Record<string, unknown>,
): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>();
  const candidates: unknown[] = [];
  if (Array.isArray(body.tools)) candidates.push(...body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isRecord(item) || item.type !== "additional_tools") continue;
      if (Array.isArray(item.tools)) candidates.push(...item.tools);
    }
  }
  for (const candidate of candidates) {
    if (!isRecord(candidate) || candidate.type !== "namespace") continue;
    const namespace = candidate.name;
    if (
      typeof namespace !== "string" ||
      namespace.length === 0 ||
      !Array.isArray(candidate.tools)
    ) {
      continue;
    }
    const children = declared.get(namespace) ?? new Set<string>();
    for (const child of candidate.tools) {
      if (
        isRecord(child) &&
        typeof child.name === "string" &&
        child.name.length > 0
      ) {
        children.add(child.name);
      }
    }
    declared.set(namespace, children);
  }
  return declared;
}

/**
 * Preserve a declared namespaced call's canonical Pi history identity before
 * removing tools from the summarizer request. Undeclared calls stay untouched
 * so the normal Responses converter still rejects them.
 */
function flattenDeclaredNamespaceHistoryCalls(
  input: readonly unknown[],
  declared: Map<string, Set<string>>,
): unknown[] {
  const namespacedOwners = new Map<string, string>();
  return input.map((item) => {
    if (
      !isRecord(item) ||
      (item.type !== "function_call" && item.type !== "custom_tool_call")
    ) {
      return item;
    }
    const namespace = item.namespace;
    const name = item.name;
    if (typeof name !== "string" || name.length === 0) {
      return item;
    }
    const hasNamespace = namespace !== undefined;
    if (
      hasNamespace &&
      (typeof namespace !== "string" || namespace.length === 0)
    ) {
      return item;
    }
    if (
      hasNamespace &&
      !declared.get(namespace as string)?.has(name)
    ) {
      return item;
    }
    if (!hasNamespace) return item;
    const identity = JSON.stringify([namespace, name]);
    const flattenedName = flattenResponsesNamespaceToolName(
      namespace as string,
      name,
    );
    const owner = namespacedOwners.get(flattenedName);
    if (owner !== undefined && owner !== identity) {
      throw new CodexRoutedCompactionRequestError(
        `tool name collision after namespace flattening: ${flattenedName}`,
      );
    }
    namespacedOwners.set(flattenedName, identity);
    const flattened: Record<string, unknown> = { ...item, name: flattenedName };
    delete flattened.namespace;
    return flattened;
  });
}

/**
 * Rewrite one compaction turn into a routed summarization turn: drop the
 * trigger and tool surface, canonicalize declared namespaced history calls,
 * replace client instructions with the summarizer system role, and append the
 * structured handoff prompt. The canonical name matches the one produced by
 * Responses request conversion; unmatched namespace calls remain unchanged and
 * fail closed there.
 * The original `stream` mode is preserved because it selects the
 * client-facing response encoding, not the internal execution style.
 */
export function buildCodexRoutedCompactionRequest(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.input)) return body;
  const declared = declaredNamespaceChildren(body);
  const input = flattenDeclaredNamespaceHistoryCalls(
    body.input,
    declared,
  ).filter(
    (item) =>
      !(
        isRecord(item) &&
        (item.type === "compaction_trigger" || item.type === "additional_tools")
      ),
  );
  input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: ROUTED_COMPACTION_PROMPT }],
  });
  const transformed: Record<string, unknown> = {
    ...body,
    instructions: ROUTED_COMPACTION_SYSTEM_PROMPT,
    input,
  };
  delete transformed.tools;
  delete transformed.tool_choice;
  delete transformed.parallel_tool_calls;
  delete transformed.text;
  return transformed;
}

function summaryText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is Extract<AssistantMessage["content"][number], { type: "text" }> =>
      item.type === "text",
    )
    .map((item) => item.text)
    .join("")
    .trim();
}

function encodeSummary(summary: string): string {
  return `${TOKEN_COMPACTION_PREFIX}${Buffer.from(summary, "utf8").toString("base64")}`;
}

function buildRoutedCompactionItem(
  summary: string,
): CompactionOutputItem {
  return {
    type: "compaction",
    id: `cmp_${randomUUID()}`,
    encrypted_content: encodeSummary(summary),
  };
}

/**
 * Replace the routed model's ordinary output with the single synthetic
 * compaction item codex-rs requires. A truncated or empty summary fails
 * instead of installing replacement history (#422 equivalence).
 */
export function projectRoutedCompactionResponse<T extends { readonly output: readonly unknown[] }>(
  response: T,
  message: AssistantMessage,
): T & { output: CompactionOutputItem[] } {
  const summary = summaryText(message);
  if (message.stopReason !== "stop") {
    throw new CodexRoutedCompactionSummaryError(
      "Routed compaction summarizer did not finish cleanly",
    );
  }
  if (summary.length === 0) {
    throw new CodexRoutedCompactionSummaryError();
  }
  return {
    ...response,
    output: [buildRoutedCompactionItem(summary)],
  };
}

/**
 * Collect the assistant text from a routed upstream's Responses JSON or SSE.
 *
 * Shared by the Provider Native lane, which forwards to a Responses-shaped
 * upstream and therefore receives the same wire family this protocol already
 * renders. A summary is usable only after a completed terminal response;
 * deltas win because they are the canonical streaming source, with completed
 * output items as a fallback for gateways that omit deltas.
 */
export function extractResponsesOutputText(
  rawBody: string,
): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    json = undefined;
  }
  if (isRecord(json)) {
    if (json.status !== "completed" || !Array.isArray(json.output)) {
      return undefined;
    }
    const text = outputText(json.output).trim();
    return text.length === 0 ? undefined : text;
  }

  const deltas: string[] = [];
  const itemTexts: string[] = [];
  let completedOutputTexts: string[] = [];
  let completed = false;
  let done = false;
  let invalidTerminal = false;
  const normalizedBody = rawBody.replace(/\r\n?/gu, "\n");
  for (const block of normalizedBody.split("\n\n")) {
    const payload = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /u, ""))
      .join("\n")
      .trim();
    if (payload.length === 0) continue;
    if (payload === "[DONE]") {
      if (!completed || done) invalidTerminal = true;
      done = true;
      continue;
    }
    if (done) {
      invalidTerminal = true;
      continue;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      invalidTerminal = true;
      continue;
    }
    if (!isRecord(frame)) {
      invalidTerminal = true;
      continue;
    }
    if (completed) {
      invalidTerminal = true;
      continue;
    }
    if (
      frame.type === "response.incomplete" ||
      frame.type === "response.failed"
    ) {
      invalidTerminal = true;
      continue;
    }
    if (frame.type === "response.completed") {
      const response = frame.response;
      if (
        completed ||
        !isRecord(response) ||
        response.status !== "completed" ||
        !Array.isArray(response.output)
      ) {
        invalidTerminal = true;
        continue;
      }
      completed = true;
      completedOutputTexts = collectOutputText(response.output);
      continue;
    }
    if (
      frame.type === "response.output_text.delta" &&
      typeof frame.delta === "string"
    ) {
      deltas.push(frame.delta);
      continue;
    }
    if (
      frame.type === "response.output_item.done" &&
      isRecord(frame.item) &&
      frame.item.type === "message" &&
      Array.isArray(frame.item.content)
    ) {
      itemTexts.push(...collectOutputText([frame.item]));
    }
  }
  if (!completed || invalidTerminal) return undefined;
  const text = (
    deltas.length > 0
      ? deltas.join("")
      : completedOutputTexts.length > 0
        ? completedOutputTexts.join("")
        : itemTexts.join("")
  ).trim();
  return text.length === 0 ? undefined : text;
}

function collectOutputText(output: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const item of output) {
    if (
      !isRecord(item) ||
      item.type !== "message" ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (const part of item.content) {
      if (
        isRecord(part) &&
        part.type === "output_text" &&
        typeof part.text === "string"
      ) {
        texts.push(part.text);
      }
    }
  }
  return texts;
}

function outputText(output: readonly unknown[]): string {
  return collectOutputText(output).join("");
}

const EMPTY_COMPACTION_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  input_tokens_details: Object.freeze({ cached_tokens: 0 }),
  output_tokens_details: Object.freeze({ reasoning_tokens: 0 }),
});

export interface RoutedCompactionClientResponseContext {
  readonly responseId: string;
  readonly createdAt: number;
  readonly model: string;
  readonly stream: boolean;
}

/**
 * Build the complete client-facing Responses response for a routed
 * compaction turn: exactly one Token-owned compaction item, encoded as the
 * SSE Codex consumes (or as JSON for a non-streaming caller).
 */
export function renderRoutedCompactionClientResponse(
  summary: string,
  context: RoutedCompactionClientResponseContext,
): Response {
  const response = {
    id: context.responseId,
    object: "response",
    created_at: Math.floor(context.createdAt / 1000),
    status: "completed" as const,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model: context.model,
    output: [buildRoutedCompactionItem(summary)],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: EMPTY_COMPACTION_USAGE,
  };
  if (!context.stream) {
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const prepared = renderResponsesSse(response);
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}
