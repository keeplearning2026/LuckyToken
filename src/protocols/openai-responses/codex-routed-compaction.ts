import type { AssistantMessage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type { ResponsesResponseObject } from "./response.js";

export const LUCKYTOKEN_COMPACTION_PREFIX = "luckytoken1:";

export class CodexRoutedCompactionSummaryError extends Error {
  readonly kind = "CodexRoutedCompactionSummaryError" as const;

  constructor() {
    super("Routed compaction summarizer produced no text");
    this.name = "CodexRoutedCompactionSummaryError";
  }
}

const ROUTED_COMPACTION_PROMPT = `Create a concise handoff summary of the conversation so another model can continue the task. Preserve current progress, key decisions, constraints, important facts, and clear next steps. Do not continue solving the task; summarize the state needed to resume it.`;
const ROUTED_COMPACTION_SUMMARY_PREFIX =
  "Another language model summarized the earlier conversation so work can continue from this checkpoint. Here is that summary:";

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

export function hasLuckyTokenCompactionEnvelope(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.input)) return false;
  return body.input.some((item) =>
    isRecord(item) &&
    item.type === "compaction" &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.startsWith(LUCKYTOKEN_COMPACTION_PREFIX),
  );
}

function decodeSummary(encryptedContent: string): string | undefined {
  if (!encryptedContent.startsWith(LUCKYTOKEN_COMPACTION_PREFIX)) return undefined;
  const payload = encryptedContent.slice(LUCKYTOKEN_COMPACTION_PREFIX.length);
  if (payload.length === 0) return undefined;
  const decoded = Buffer.from(payload, "base64").toString("utf8").trim();
  return decoded.length === 0 ? undefined : decoded;
}

export function expandLuckyTokenCompactionEnvelopes(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.input)) return body;
  return {
    ...body,
    input: body.input.map((item) => {
      if (
        !isRecord(item) ||
        item.type !== "compaction" ||
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
            text: `${ROUTED_COMPACTION_SUMMARY_PREFIX}\n\n${summary}`,
          },
        ],
      };
    }),
  };
}

export function buildCodexRoutedCompactionRequest(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.input)) return body;
  const input = [...body.input];
  const last = input.at(-1);
  if (isRecord(last) && last.type === "compaction_trigger") input.pop();
  input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: ROUTED_COMPACTION_PROMPT }],
  });
  const transformed: Record<string, unknown> = {
    ...body,
    stream: false,
    store: false,
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
  return `${LUCKYTOKEN_COMPACTION_PREFIX}${Buffer.from(summary, "utf8").toString("base64")}`;
}

export function projectRoutedCompactionResponse(
  response: ResponsesResponseObject,
  message: AssistantMessage,
): ResponsesResponseObject {
  const summary = summaryText(message);
  if (summary.length === 0) throw new CodexRoutedCompactionSummaryError();
  return {
    ...response,
    output: [
      {
        type: "compaction",
        id: `cmp_${randomUUID()}`,
        encrypted_content: encodeSummary(summary),
      },
    ],
  };
}
