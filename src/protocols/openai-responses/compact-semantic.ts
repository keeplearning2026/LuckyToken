import type { Model, Models } from "@earendil-works/pi-ai";

import type { ExecutionOperation } from "../../execution.js";
import type {
  ArtifactRecorder,
  ImmutableArtifactMeta,
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../../diagnostics/contract.js";
import type { RequestIdentity } from "../../request-identity.js";
import type { RouterOptionDefaults } from "../options.js";
import type { OpenAIResponsesConfiguration } from "./configuration.js";
import {
  renderResponsesError,
  type PreparedHttpResponse,
} from "./response.js";
import type { ResponseSessionState } from "./session-state.js";
import { executeSemanticResponses } from "./semantic.js";

export const CODEX_COMPACT_PROMPT = `Create a concise handoff summary of the conversation so another model can continue the task. Preserve current progress, key decisions, constraints, important facts, and clear next steps. Do not continue solving the task; summarize the state needed to resume it.`;
export const CODEX_COMPACT_SUMMARY_PREFIX =
  "Another language model summarized the earlier conversation so work can continue from this checkpoint. Here is that summary:";

const RETAINED_USER_CHAR_BUDGET = 80_000;

export interface SemanticCompactOptions {
  readonly request: Request;
  readonly body: Record<string, unknown>;
  readonly model: Model<string>;
  readonly models: Models;
  readonly configuration: OpenAIResponsesConfiguration;
  readonly sessionState: ResponseSessionState;
  readonly requestIdentity: RequestIdentity;
  readonly createResponseId: () => string;
  readonly executeOperation?: ExecutionOperation;
  readonly routerDefaults: RouterOptionDefaults;
  readonly now: () => number;
  readonly requestTimeoutMs?: number;
  readonly journey?: RequestJourneyObserver;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

function errorResponse(status: number, message: string): Response {
  return toResponse(renderResponsesError(status, "api_error", message));
}

function observeSemanticCompact(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Compact execution and response remain authoritative over diagnostics.
  }
}

function semanticExecutionJourney(
  journey: RequestJourneyObserver | undefined,
): RequestJourneyObserver | undefined {
  if (journey === undefined) return undefined;
  return Object.freeze({
    requestId: journey.requestId,
    ...(journey.openArtifact === undefined
      ? {}
      : {
          openArtifact(meta: ImmutableArtifactMeta): ArtifactRecorder {
            return journey.openArtifact!(meta);
          },
        }),
    observe(observation: RequestJourneyObservationInput): void {
      if (
        observation.kind === "client_response_prepared" ||
        observation.kind === "work_outcome_committed"
      ) {
        return;
      }
      observeSemanticCompact(journey, observation);
    },
    close: () => undefined,
  });
}

function observeSemanticCompactTerminal(
  journey: RequestJourneyObserver | undefined,
  response: Response,
  outcome: "success" | "failed",
): void {
  const presentationLocation = {
    phase: "client_response_preparation",
    lane: "semantic_conversion",
    step: "prepare_semantic_compact_response",
  } as const;
  observeSemanticCompact(journey, {
    kind: "step_entered",
    stepInstanceId: "p6.prepare_semantic_compact_response",
    location: presentationLocation,
  });
  observeSemanticCompact(journey, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: presentationLocation,
  });
  observeSemanticCompact(journey, {
    kind: "step_completed",
    stepInstanceId: "p6.prepare_semantic_compact_response",
    completion: "success",
    operation: "conversation_compaction",
    protocol: "openai-responses",
    location: presentationLocation,
  });
  const outcomeLocation = {
    phase: "outcome_commit",
    lane: "semantic_conversion",
    step: "commit_request_outcome",
  } as const;
  observeSemanticCompact(journey, {
    kind: "step_entered",
    stepInstanceId: "p7.commit_request_outcome",
    location: outcomeLocation,
  });
  observeSemanticCompact(journey, {
    kind: "work_outcome_committed",
    outcome,
    terminalAuthority: "openai_responses_semantic_compact",
    location: outcomeLocation,
  });
  observeSemanticCompact(journey, {
    kind: "step_completed",
    stepInstanceId: "p7.commit_request_outcome",
    completion: "success",
    operation: "conversation_compaction",
    protocol: "openai-responses",
    location: outcomeLocation,
  });
}

function enterSemanticCompactStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeSemanticCompact(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeSemanticCompactStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed",
): void {
  observeSemanticCompact(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    operation: "conversation_compaction",
    protocol: "openai-responses",
    location,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (
        (part.type === "input_text" || part.type === "text") &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
}

function retainedUserMessages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const messages = input.flatMap((item): string[] => {
    if (!isRecord(item)) return [];
    if (item.type !== undefined && item.type !== "message") return [];
    if (item.role !== "user") return [];
    const text = textFromUserContent(item.content);
    return text.trim().length === 0 ? [] : [text];
  });
  const selected: string[] = [];
  let remaining = RETAINED_USER_CHAR_BUDGET;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index]!;
    if (message.length <= remaining) {
      selected.push(message);
      remaining -= message.length;
    } else {
      selected.push(message.slice(message.length - remaining));
      remaining = 0;
    }
  }
  return selected.reverse();
}

function compactMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function buildCompactOutput(input: unknown, summary: string): Record<string, unknown>[] {
  return [
    ...retainedUserMessages(input).map(compactMessage),
    compactMessage(`${CODEX_COMPACT_SUMMARY_PREFIX}\n${summary}`),
  ];
}

function extractSummary(response: unknown): string | undefined {
  if (!isRecord(response) || response.status !== "completed" || !Array.isArray(response.output)) {
    return undefined;
  }
  const fragments: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      if (
        (part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string"
      ) {
        fragments.push(part.text);
      }
    }
  }
  const summary = fragments.join("").trim();
  return summary.length === 0 ? undefined : summary;
}

export async function executeSemanticCompact(
  options: SemanticCompactOptions,
): Promise<Response> {
  const input = Array.isArray(options.body.input) ? options.body.input : [];
  const internalBody = {
    ...options.body,
    stream: false,
    store: false,
    input: [
      ...input,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: CODEX_COMPACT_PROMPT }],
      },
    ],
  };
  const executionJourney = semanticExecutionJourney(options.journey);
  const summarized = await executeSemanticResponses({
    request: options.request,
    body: internalBody,
    model: options.model,
    requestIdentity: options.requestIdentity,
    models: options.models,
    configuration: options.configuration,
    sessionState: options.sessionState,
    routerDefaults: options.routerDefaults,
    createResponseId: options.createResponseId,
    now: options.now,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(executionJourney === undefined ? {} : { journey: executionJourney }),
    ...(options.executeOperation === undefined
      ? {}
      : { executeOperation: options.executeOperation }),
  });
  if (!summarized.ok) {
    observeSemanticCompactTerminal(options.journey, summarized, "failed");
    return summarized;
  }

  const extractLocation = {
    phase: "lane_response_processing",
    lane: "semantic_conversion",
    direction: "pi_to_client",
    step: "extract_compaction_summary",
    subject: "content",
  } as const;
  enterSemanticCompactStep(
    options.journey,
    "p5.extract_compaction_summary",
    extractLocation,
  );
  let parsed: unknown;
  try {
    parsed = await summarized.json();
  } catch {
    completeSemanticCompactStep(
      options.journey,
      "p5.extract_compaction_summary",
      extractLocation,
      "failed",
    );
    const response = errorResponse(
      502,
      "Compaction summary response was not valid JSON",
    );
    observeSemanticCompactTerminal(options.journey, response, "failed");
    return response;
  }
  const summary = extractSummary(parsed);
  if (summary === undefined) {
    completeSemanticCompactStep(
      options.journey,
      "p5.extract_compaction_summary",
      extractLocation,
      "failed",
    );
    const response = errorResponse(
      502,
      "Compaction summary response contained no text",
    );
    observeSemanticCompactTerminal(options.journey, response, "failed");
    return response;
  }
  completeSemanticCompactStep(
    options.journey,
    "p5.extract_compaction_summary",
    extractLocation,
    "success",
  );
  const response = new Response(
    JSON.stringify({ output: buildCompactOutput(options.body.input, summary) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  observeSemanticCompactTerminal(options.journey, response, "success");
  return response;
}
