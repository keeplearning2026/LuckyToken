import type {
  FetchFunction,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  ConversionNotice,
  ExecutionFactsSink,
  UpstreamFailureFact,
} from "@luckytoken/provider-contract/diagnostics";
import { bindCredentialActivityToExecutionFacts } from "../../credentials/activity.js";

import {
  execute,
  ExecutionAbortedError,
  type ExecutionOperation,
} from "../../execution.js";
import {
  executeOpenAIResponsesSemanticInvocation,
  type ResponsesSemanticExecutionResult,
} from "./semantic/execution.js";
import { ResponsesProjectionRejected } from "./semantic/pi-execution.js";
import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../../diagnostics/contract.js";
import type { RequestIdentity } from "../../request-identity.js";
import {
  composeOptions,
  type RouterOptionDefaults,
} from "../options.js";
import type { OpenAIResponsesConfiguration } from "./configuration.js";
import { mapUpstreamFailureFact } from "./error-rendering.js";
import {
  ADDITIONAL_UNCONSUMED_REQUEST_FIELDS_IGNORED_NOTICE_CODE,
  convertResponsesRequest,
  InvalidRequest,
  UNCONSUMED_REQUEST_FIELD_IGNORED_NOTICE_CODE,
  type ResponsesInvocation,
} from "./request.js";
import {
  convertAssistantMessageToResponses,
  renderResponsesError,
  renderResponsesErrorResponse,
  type PreparedHttpResponse,
  type ResponsesEchoTool,
  type ResponsesEchoToolChoice,
  type ResponsesRenderState,
  type ResponsesResponseObject,
} from "./response.js";
import type { ResponsesToolChoice } from "./semantic/supplement/contract.js";
import {
  ResponseStateConversionFailure,
  type ResponseSessionState,
} from "./session-state.js";
import { renderResponsesSse } from "./sse.js";

export interface SemanticResponsesExecutionOptions {
  readonly request: Request;
  readonly body: unknown;
  readonly model: Model<string>;
  readonly requestIdentity: RequestIdentity;
  readonly models: Models;
  readonly configuration: OpenAIResponsesConfiguration;
  readonly sessionState: ResponseSessionState;
  readonly routerDefaults: RouterOptionDefaults;
  readonly createResponseId: () => string;
  readonly now: () => number;
  readonly executeOperation?: ExecutionOperation;
  readonly journey?: RequestJourneyObserver;
}

const MAX_INVOCATION_ARTIFACT_BYTES = 256 * 1_024;
const MAX_SNAPSHOT_MESSAGES = 16;
const MAX_SNAPSHOT_CONTENT_BLOCKS = 8;
const MAX_SNAPSHOT_TEXT_CHARACTERS = 256;

function observeSemanticJourney(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Semantic execution remains authoritative over observation failure.
  }
}

function enterSemanticJourneyStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeSemanticJourney(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeSemanticJourneyStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed" | "aborted",
): void {
  observeSemanticJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
}

function observeClientConversionNotice(
  journey: RequestJourneyObserver | undefined,
  notice: ConversionNotice,
): void {
  const requestDirection = notice.direction === "request";
  const isUnconsumedRequestFieldWarning =
    notice.code === UNCONSUMED_REQUEST_FIELD_IGNORED_NOTICE_CODE ||
    notice.code ===
      ADDITIONAL_UNCONSUMED_REQUEST_FIELDS_IGNORED_NOTICE_CODE;
  observeSemanticJourney(journey, {
    kind: "conversion_notice_observed",
    code: notice.code,
    severity:
      isUnconsumedRequestFieldWarning || notice.action !== "ignore"
        ? "warning"
        : "info",
    location: {
      phase: requestDirection
        ? "lane_request_preparation"
        : "lane_response_processing",
      lane: "semantic_conversion",
      direction: requestDirection ? "client_to_pi" : "pi_to_client",
      step: requestDirection
        ? "apply_semantic_repairs"
        : "validate_response_fidelity",
      ...(notice.jsonPath === undefined
        ? {}
        : { sourcePath: notice.jsonPath }),
    },
  });
}

function observeProviderConversionNotice(
  journey: RequestJourneyObserver | undefined,
  notice: ConversionNotice,
): void {
  const requestDirection = notice.direction === "request";
  observeSemanticJourney(journey, {
    kind: "conversion_notice_observed",
    code: notice.code,
    severity: notice.action === "ignore" ? "info" : "warning",
    location: {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      direction: requestDirection ? "pi_to_provider" : "provider_to_pi",
      step: requestDirection ? "convert_pi_request" : "decode_provider_events",
      ...(notice.jsonPath === undefined
        ? {}
        : { sourcePath: notice.jsonPath }),
    },
  });
}

function boundedInvocationSnapshot(
  invocation: ResponsesInvocation,
  model: Model<string>,
  options: ModelsSimpleStreamOptions,
): { readonly bytes: Uint8Array<ArrayBuffer>; readonly truncated: boolean } {
  let truncated = false;
  const boundedText = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    if (value.length <= MAX_SNAPSHOT_TEXT_CHARACTERS) return value;
    truncated = true;
    return value.slice(0, MAX_SNAPSHOT_TEXT_CHARACTERS);
  };
  const boundedContent = (value: unknown): unknown => {
    if (typeof value === "string") return boundedText(value);
    if (!Array.isArray(value)) return undefined;
    if (value.length > MAX_SNAPSHOT_CONTENT_BLOCKS) truncated = true;
    return value.slice(0, MAX_SNAPSHOT_CONTENT_BLOCKS).map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return Object.freeze({ type: typeof entry });
      }
      const block = entry as Readonly<Record<string, unknown>>;
      const type = boundedText(block.type) ?? "unknown";
      return Object.freeze({
        type,
        ...(type === "text" && boundedText(block.text) !== undefined
          ? { text: boundedText(block.text)! }
          : {}),
        ...(type === "thinking" && boundedText(block.thinking) !== undefined
          ? { thinking: boundedText(block.thinking)! }
          : {}),
        ...((type === "toolCall" || type === "toolResult") &&
        boundedText(block.name) !== undefined
          ? { name: boundedText(block.name)! }
          : {}),
      });
    });
  };
  if (invocation.invocation.pi.context.messages.length > MAX_SNAPSHOT_MESSAGES) {
    truncated = true;
  }
  const messages = invocation.invocation.pi.context.messages
    .slice(0, MAX_SNAPSHOT_MESSAGES)
    .map((message) => {
      const safe = message as unknown as Readonly<Record<string, unknown>>;
      return Object.freeze({
        role: boundedText(safe.role) ?? "unknown",
        content: boundedContent(safe.content),
      });
    });
  const snapshot = Object.freeze({
    schema: "luckytoken.pi_invocation_summary.v1",
    selector: boundedText(invocation.selector),
    model: Object.freeze({
      provider: boundedText(model.provider),
      id: boundedText(model.id),
      api: boundedText(model.api),
    }),
    systemPrompt: boundedText(invocation.invocation.pi.context.systemPrompt),
    messageCount: invocation.invocation.pi.context.messages.length,
    messages: Object.freeze(messages),
    options: Object.freeze({
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    }),
    completeness: "bounded_summary",
  });
  let bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (bytes.byteLength > MAX_INVOCATION_ARTIFACT_BYTES) {
    truncated = true;
    bytes = new TextEncoder().encode(
      JSON.stringify({
        schema: "luckytoken.pi_invocation_summary.v1",
        selector: boundedText(invocation.selector),
        model: {
          provider: boundedText(model.provider),
          id: boundedText(model.id),
          api: boundedText(model.api),
        },
        messageCount: invocation.invocation.pi.context.messages.length,
        completeness: "counts_only_due_to_byte_bound",
      }),
    );
  }
  return Object.freeze({ bytes, truncated });
}

function trustedTerminalSummaryBytes(
  failure: UpstreamFailureFact,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      kind: failure.kind,
      ...(failure.phase === undefined ? {} : { phase: failure.phase }),
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.statusText === undefined
        ? {}
        : { statusText: failure.statusText }),
      ...(failure.providerType === undefined
        ? {}
        : { providerType: failure.providerType }),
      ...(failure.providerCode === undefined
        ? {}
        : { providerCode: failure.providerCode }),
      message: failure.message,
      headers: { ...failure.headers },
      ...(failure.retryable === undefined
        ? {}
        : { retryable: failure.retryable }),
      ...(failure.attemptCount === undefined
        ? {}
        : { attemptCount: failure.attemptCount }),
      ...(failure.snapshot === undefined
        ? {}
        : { snapshot: { ...failure.snapshot } }),
      truncated: failure.truncated,
    }),
  );
}

function trustedExecutionFailureLocation(
  failure: UpstreamFailureFact,
  attempt: number | undefined,
): RequestJourneyLocation {
  const attemptField = attempt === undefined ? {} : { attempt };
  if (failure.kind === "conversion") {
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      direction: "pi_to_provider",
      step: "convert_pi_request",
      subject: "envelope",
      ...attemptField,
    };
  }
  if (
    (failure.kind === "protocol" || failure.kind === "upstream_stream") &&
    failure.phase === "unexpected_eof"
  ) {
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      step: "validate_pi_terminal",
      ...attemptField,
    };
  }
  if (failure.kind === "protocol" || failure.kind === "upstream_stream") {
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      direction: "provider_to_pi",
      step:
        failure.phase === "stream"
          ? "construct_pi_terminal"
          : "decode_provider_events",
      subject: "envelope",
      ...attemptField,
    };
  }
  if (failure.kind === "transport" || failure.kind === "timeout") {
    const dispatch =
      failure.phase === "request" ||
      failure.phase === "connect" ||
      failure.phase === "request_body" ||
      failure.phase === "retry_delay";
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      step: dispatch ? "dispatch_provider_request" : "read_provider_response",
      ...attemptField,
    };
  }
  if (failure.kind === "http") {
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      step: "read_provider_response",
      ...attemptField,
    };
  }
  return {
    phase: "upstream_execution",
    lane: "semantic_conversion",
    step: "validate_pi_terminal",
    ...attemptField,
  };
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

function renderResponsesJson(target: ResponsesResponseObject): PreparedHttpResponse {
  return {
    status: 200,
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(target)),
  };
}

function buildEchoTools(invocation: ResponsesInvocation): ResponsesEchoTool[] {
  const state = invocation.client.renderState;
  const freeformNames = state.freeformToolNames;
  const namespaceReverse = state.namespaceReverse;
  const catalog = invocation.invocation.pi.context.tools;
  if (catalog === undefined || catalog.length === 0) return [];
  const seen = new Set<string>();
  const tools: ResponsesEchoTool[] = [];
  for (const tool of catalog) {
    const reverse = namespaceReverse?.[tool.name];
    const name = reverse?.child ?? tool.name;
    const key = reverse === undefined ? tool.name : `${reverse.namespace}.${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const freeform = freeformNames?.has(tool.name) === true;
    if (freeform) {
      tools.push({
        type: "custom",
        name,
        ...(reverse === undefined ? {} : { namespace: reverse.namespace }),
        description: tool.description,
        format: { type: "text" },
      });
      continue;
    }
    tools.push({
      type: "function",
      name,
      ...(reverse === undefined ? {} : { namespace: reverse.namespace }),
      description: tool.description,
      parameters: tool.parameters as Readonly<Record<string, unknown>>,
      strict:
        tool.constrainedSampling !== undefined &&
        tool.constrainedSampling !== false &&
        tool.constrainedSampling.type === "json_schema",
    });
  }
  return tools;
}

function buildRenderState(
  invocation: ResponsesInvocation,
  projection: ResponsesSemanticExecutionResult,
  unknownPiContent: "error" | "ignore",
  notice: (notice: {
    readonly adapter: string;
    readonly direction: "request" | "response";
    readonly code: string;
    readonly jsonPath?: string;
    readonly action: "ignore" | "degrade" | "xrepair";
  }) => void,
): ResponsesRenderState {
  const state = invocation.client.renderState;
  const tools = buildEchoTools(invocation);
  const freeformNames = state.freeformToolNames;
  const namespaceReverse = state.namespaceReverse;
  const applied = (control: string): boolean =>
    projection.supplementOutcomes.some(
      (entry) =>
        entry.control === control &&
        (entry.outcome.kind === "pi-native" ||
          entry.outcome.kind === "payload-projected"),
    );
  const temperatureControl = invocation.invocation.supplement.sampling?.temperature;
  const topPControl = invocation.invocation.supplement.sampling?.topP;
  const parallelControl = invocation.invocation.supplement.tools?.parallelCalls;
  const choiceControl = invocation.invocation.supplement.tools?.choice;
  const temperature =
    temperatureControl !== undefined && applied("sampling.temperature")
      ? temperatureControl.value
      : undefined;
  const topP =
    topPControl !== undefined && applied("sampling.topP")
      ? topPControl.value
      : undefined;
  const parallelToolCalls =
    parallelControl !== undefined && applied("tools.parallelCalls")
      ? parallelControl.value
      : true;
  const toolChoice =
    choiceControl !== undefined && applied("tools.choice")
      ? toResponsesEchoToolChoice(choiceControl.value)
      : undefined;
  return Object.freeze({
    clientModel: state.clientModel,
    stream: state.stream,
    ...(toolChoice === undefined ? {} : { toolChoice }),
    parallelToolCalls,
    ...(freeformNames === undefined || freeformNames.size === 0
      ? {}
      : { freeformToolNames: freeformNames }),
    ...(namespaceReverse === undefined || Object.keys(namespaceReverse).length === 0
      ? {}
      : { namespaceReverse }),
    ...(state.metadataEcho === undefined ? {} : { metadataEcho: state.metadataEcho }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(tools.length === 0 ? {} : { tools }),
    unknownPiContent,
    notices: { push: notice },
  });
}

function toResponsesEchoToolChoice(
  choice: ResponsesToolChoice,
): ResponsesEchoToolChoice {
  if (
    choice.kind === "auto" ||
    choice.kind === "none" ||
    choice.kind === "required"
  ) {
    return choice.kind;
  }
  if (choice.kind === "named") {
    return Object.freeze({
      type: choice.toolType,
      name: choice.name,
    });
  }
  if (choice.kind === "allowed") {
    return Object.freeze({
      type: "allowed_tools",
      mode: choice.mode,
      tools: Object.freeze(
        choice.tools.map((tool) =>
          Object.freeze(
            tool.toolType === "function" || tool.toolType === "custom"
              ? { type: tool.toolType, name: tool.name }
              : tool.toolType === "mcp"
                ? {
                    type: "mcp",
                    server_label: tool.serverLabel,
                    ...(tool.name === undefined ? {} : { name: tool.name }),
                  }
                : { type: tool.toolType },
          ),
        ),
      ),
    });
  }
  if (choice.kind !== "hosted") return "auto";
  return Object.freeze(
    choice.toolType === "mcp"
      ? {
          type: "mcp",
          server_label: choice.serverLabel,
          ...(choice.name === undefined ? {} : { name: choice.name }),
        }
      : { type: choice.toolType },
  );
}

function assertProviderRepresentableHistory(
  invocation: ResponsesInvocation,
): void {
  for (const message of invocation.invocation.pi.context.messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && block.namespace !== undefined) {
        // Namespace declarations that Pi can execute are flattened by the
        // Responses adapter before this seam. A namespace that survives on a
        // historical ToolCall has no certified Provider replay identity in
        // LuckyToken Core v1; letting Pi adapters silently omit it could call
        // a different tool.
        throw new InvalidRequest(
          "Namespaced tool-call history requires a matching namespace tool declaration",
        );
      }
    }
  }
}

function composeInvocationOptions(
  invocation: ResponsesInvocation,
  infrastructure: {
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly fetch?: FetchFunction;
  },
  routerDefaults: RouterOptionDefaults,
): ModelsSimpleStreamOptions {
  return composeOptions(
    { ...invocation.invocation.pi.options },
    infrastructure,
    routerDefaults,
  );
}

async function rememberAfterSuccess(
  options: SemanticResponsesExecutionOptions,
  rendered: ResponsesResponseObject,
): Promise<void> {
  await options.sessionState.remember(options.body, rendered, (code) => {
    const notice = {
      adapter: "openai-responses",
      direction: "request" as const,
      code,
      action: "degrade" as const,
    };
    observeClientConversionNotice(options.journey, notice);
  });
}

export async function executeSemanticResponses(
  options: SemanticResponsesExecutionOptions,
): Promise<Response> {
  const executeOperation = options.executeOperation ?? execute;
  let lastObservedAttempt = 0;
  try {
    const previousResponseId =
      typeof options.body === "object" && options.body !== null
        ? (options.body as Record<string, unknown>).previous_response_id
        : undefined;
    const expanded =
      typeof previousResponseId === "string" && previousResponseId.length > 0
        ? await options.sessionState.expand(options.body)
        : options.body;

    const conversionLocation = {
      phase: "lane_request_preparation",
      lane: "semantic_conversion",
      direction: "client_to_pi",
      step: "convert_request_envelope",
      subject: "envelope",
    } as const;
    enterSemanticJourneyStep(
      options.journey,
      "p3.convert_request_envelope",
      conversionLocation,
    );
    let invocation: ResponsesInvocation;
    try {
      invocation = convertResponsesRequest(
        expanded,
        options.now(),
        options.configuration.conversion.request,
      );
      assertProviderRepresentableHistory(invocation);
      completeSemanticJourneyStep(
        options.journey,
        "p3.convert_request_envelope",
        conversionLocation,
        "success",
      );
    } catch (error) {
      completeSemanticJourneyStep(
        options.journey,
        "p3.convert_request_envelope",
        conversionLocation,
        "failed",
      );
      throw error;
    }
    for (const notice of invocation.client.notices) {
      observeClientConversionNotice(options.journey, notice);
    }
    const finalizeLocation = {
      phase: "lane_request_preparation",
      lane: "semantic_conversion",
      direction: "client_to_pi",
      step: "finalize_pi_invocation",
      subject: "envelope",
    } as const;
    enterSemanticJourneyStep(
      options.journey,
      "p3.finalize_pi_invocation",
      finalizeLocation,
    );
    let piOptions: ModelsSimpleStreamOptions;
    try {
      piOptions = composeInvocationOptions(
        invocation,
        {
          sessionId: options.requestIdentity.effectiveSessionId,
          signal: options.request.signal,
        },
        options.routerDefaults,
      );
      if (options.journey !== undefined) {
        try {
          const snapshot = boundedInvocationSnapshot(
            invocation,
            options.model,
            piOptions,
          );
          observeSemanticJourney(options.journey, {
            kind: "artifact_observed",
            artifactId: "pi_invocation_snapshot",
            artifactKind: "pi_invocation_snapshot",
            state: snapshot.truncated ? "partial" : "captured",
            mediaType: "application/json",
            bytes: snapshot.bytes,
            originalBytes: snapshot.bytes.byteLength,
            capturedBytes: snapshot.bytes.byteLength,
            truncated: snapshot.truncated,
            location: finalizeLocation,
          });
        } catch {
          observeSemanticJourney(options.journey, {
            kind: "artifact_observed",
            artifactId: "pi_invocation_snapshot",
            artifactKind: "pi_invocation_snapshot",
            state: "unavailable",
            reason: "snapshot_projection_failed",
            location: finalizeLocation,
          });
        }
      }
      completeSemanticJourneyStep(
        options.journey,
        "p3.finalize_pi_invocation",
        finalizeLocation,
        "success",
      );
    } catch (error) {
      completeSemanticJourneyStep(
        options.journey,
        "p3.finalize_pi_invocation",
        finalizeLocation,
        "failed",
      );
      throw error;
    }
    const executionFacts: ExecutionFactsSink = {
      notice: (notice) => {
        observeProviderConversionNotice(options.journey, notice);
      },
      attempt: (attempt) => {
        lastObservedAttempt = Math.max(lastObservedAttempt, attempt.attempt);
        observeSemanticJourney(options.journey, {
          kind: "attempt_observed",
          attempt: attempt.attempt,
          ...(attempt.status === undefined ? {} : { status: attempt.status }),
          transition: attempt.status === undefined ? "terminal" : "response",
          location: {
            phase: "upstream_execution",
            lane: "semantic_conversion",
            step: "read_provider_response",
            attempt: attempt.attempt,
          },
        });
      },
      terminalUsage: (snapshot) => {
        observeSemanticJourney(options.journey, {
          kind: "terminal_usage_observed",
          usage: snapshot,
          location: {
            phase: "upstream_execution",
            lane: "semantic_conversion",
            step: "normalize_terminal_usage",
            subject: "usage",
          },
        });
      },
    };
    bindCredentialActivityToExecutionFacts(executionFacts, {
      credentialCaptured: (capture) => {
        observeSemanticJourney(options.journey, {
          kind: "profile_attributed",
          profileId: capture.credentialId,
          displayName: capture.displayName,
          location: {
            phase: "upstream_execution",
            lane: "semantic_conversion",
            step: "capture_semantic_profile",
          },
        });
      },
      credentialAttempt: (attempt) => {
        observeSemanticJourney(options.journey, {
          kind: "profile_attributed",
          profileId: attempt.credentialId,
          displayName: attempt.displayName,
          location: {
            phase: "upstream_execution",
            lane: "semantic_conversion",
            step: "attribute_semantic_profile_attempt",
            attempt: attempt.attempt,
          },
        });
      },
    });
    observeSemanticJourney(options.journey, {
      kind: "artifact_observed",
      artifactId: "pi_provider_outbound_request_evidence",
      artifactKind: "pi_provider_outbound_request_evidence",
      state: "unavailable",
      reason: "provider_did_not_expose",
      location: {
        phase: "upstream_execution",
        lane: "semantic_conversion",
        direction: "pi_to_provider",
        step: "convert_pi_request",
        subject: "envelope",
      },
    });
    observeSemanticJourney(options.journey, {
      kind: "artifact_observed",
      artifactId: "pi_provider_response_decode_evidence",
      artifactKind: "pi_provider_response_decode_evidence",
      state: "unavailable",
      reason: "provider_did_not_expose",
      location: {
        phase: "upstream_execution",
        lane: "semantic_conversion",
        direction: "provider_to_pi",
        step: "decode_provider_events",
        subject: "envelope",
      },
    });
    const createStreamLocation = {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      step: "create_pi_stream",
    } as const;
    enterSemanticJourneyStep(
      options.journey,
      "p4.create_pi_stream",
      createStreamLocation,
    );
    let semanticResult: ResponsesSemanticExecutionResult;
    try {
      semanticResult = await executeOpenAIResponsesSemanticInvocation({
        models: options.models,
        model: options.model,
        invocation: Object.freeze({
          ...invocation.invocation,
          pi: Object.freeze({
            context: invocation.invocation.pi.context,
            options: piOptions,
          }),
        }),
        infrastructure: {
          executeOperation,
          factsSink: executionFacts,
        },
      });
      completeSemanticJourneyStep(
        options.journey,
        "p4.create_pi_stream",
        createStreamLocation,
        "success",
      );
    } catch (error) {
      completeSemanticJourneyStep(
        options.journey,
        "p4.create_pi_stream",
        createStreamLocation,
        options.request.signal.aborted ? "aborted" : "failed",
      );
      throw error;
    }
    options.request.signal.throwIfAborted();
    const message = semanticResult.message;

    const responseProjectionLocation = {
      phase: "lane_response_processing",
      lane: "semantic_conversion",
      direction: "pi_to_client",
      step: "validate_assistant_message",
      subject: "message",
    } as const;
    enterSemanticJourneyStep(
      options.journey,
      "p5.validate_assistant_message",
      responseProjectionLocation,
    );
    const renderState = buildRenderState(
      invocation,
      semanticResult,
      options.configuration.conversion.response.unknownPiContent,
      (notice) => {
        observeClientConversionNotice(options.journey, notice);
      },
    );
    const rendered = convertAssistantMessageToResponses(
      message,
      renderState,
      options.createResponseId(),
      Math.floor(options.now() / 1000),
      typeof previousResponseId === "string" ? previousResponseId : undefined,
    );
    completeSemanticJourneyStep(
      options.journey,
      "p5.validate_assistant_message",
      responseProjectionLocation,
      "success",
    );

    const responseStateLocation = {
      phase: "lane_response_processing",
      lane: "semantic_conversion",
      direction: "pi_to_client",
      step: "update_client_response_state",
      subject: "metadata",
    } as const;
    enterSemanticJourneyStep(
      options.journey,
      "p5.update_client_response_state",
      responseStateLocation,
    );
    await rememberAfterSuccess(options, rendered);
    completeSemanticJourneyStep(
      options.journey,
      "p5.update_client_response_state",
      responseStateLocation,
      "success",
    );

    const responseEncodingLocation = {
      phase: "client_response_preparation",
      lane: "semantic_conversion",
      direction: "pi_to_client",
      step: invocation.client.renderState.stream
        ? "encode_atomic_sse"
        : "encode_client_json",
      subject: "envelope",
    } as const;
    enterSemanticJourneyStep(
      options.journey,
      "p6.encode_client_response",
      responseEncodingLocation,
    );
    const prepared = invocation.client.renderState.stream
      ? renderResponsesSse(rendered)
      : renderResponsesJson(rendered);
    options.request.signal.throwIfAborted();
    const response = toResponse(prepared);
    completeSemanticJourneyStep(
      options.journey,
      "p6.encode_client_response",
      responseEncodingLocation,
      "success",
    );
    observeSemanticJourney(options.journey, {
      kind: "client_response_prepared",
      status: response.status,
      ...(response.headers.get("content-type") === null
        ? {}
        : { mediaType: response.headers.get("content-type")! }),
      location: responseEncodingLocation,
    });

    const outcomeLocation = {
      phase: "outcome_commit",
      lane: "semantic_conversion",
      step: "commit_request_outcome",
    } as const;
    enterSemanticJourneyStep(
      options.journey,
      "p7.commit_request_outcome",
      outcomeLocation,
    );
    observeSemanticJourney(options.journey, {
      kind: "work_outcome_committed",
      outcome: "success",
      terminalAuthority: "pi_execution",
      location: outcomeLocation,
    });
    completeSemanticJourneyStep(
      options.journey,
      "p7.commit_request_outcome",
      outcomeLocation,
      "success",
    );
    return response;
  } catch (error) {
    if (options.request.signal.aborted || error instanceof ExecutionAbortedError) {
      throw new ExecutionAbortedError(options.request.signal.reason);
    }
    if (
      error instanceof InvalidRequest ||
      error instanceof ResponseStateConversionFailure ||
      error instanceof ResponsesProjectionRejected
    ) {
      return toResponse(
        renderResponsesError(400, "invalid_request_error", error.message),
      );
    }
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "ExecutionFailure" &&
      "reason" in error &&
      error.reason === "error"
    ) {
      const execution = error as unknown as {
        failure?: UpstreamFailureFact;
        message: string;
      };
      if (execution.failure !== undefined) {
        const terminalAttempt =
          execution.failure.attemptCount ??
          (lastObservedAttempt > 0 ? lastObservedAttempt : undefined);
        const terminalLocation = trustedExecutionFailureLocation(
          execution.failure,
          terminalAttempt,
        );
        const terminalStep = `p4.${terminalLocation.step}`;
        enterSemanticJourneyStep(
          options.journey,
          terminalStep,
          terminalLocation,
        );
        completeSemanticJourneyStep(
          options.journey,
          terminalStep,
          terminalLocation,
          "failed",
        );
        if (options.journey !== undefined) {
          try {
            const terminalBytes = trustedTerminalSummaryBytes(
              execution.failure,
            );
            observeSemanticJourney(options.journey, {
              kind: "artifact_observed",
              artifactId: "pi_terminal_summary",
              artifactKind: "pi_terminal_summary",
              state: "captured",
              mediaType: "application/json",
              bytes: terminalBytes,
              originalBytes: terminalBytes.byteLength,
              capturedBytes: terminalBytes.byteLength,
              truncated: false,
              location: terminalLocation,
            });
          } catch {
            observeSemanticJourney(options.journey, {
              kind: "artifact_observed",
              artifactId: "pi_terminal_summary",
              artifactKind: "pi_terminal_summary",
              state: "unavailable",
              reason: "snapshot_projection_failed",
              location: terminalLocation,
            });
          }
        }
        observeSemanticJourney(options.journey, {
          kind: "failure_detected",
          failureId: `trusted_upstream_${execution.failure.kind}_failure${terminalAttempt === undefined ? "" : `:${terminalAttempt}`}`,
          role: "primary",
          classification: `trusted_upstream_${execution.failure.kind}_failure`,
          origin: "provider",
          originPrecision: "external_boundary",
          safeMessage: execution.failure.message,
          location: terminalLocation,
        });
        const mapping = mapUpstreamFailureFact(execution.failure);
        const presentationLocation = {
          phase: "client_response_preparation",
          lane: "semantic_conversion",
          step: "render_client_error",
        } as const;
        enterSemanticJourneyStep(
          options.journey,
          "p6.render_client_error",
          presentationLocation,
        );
        const response = renderResponsesErrorResponse({
          status: mapping.status,
          type: mapping.type,
          message: mapping.message,
          code: mapping.code,
          param: mapping.param,
          safeHeaders: mapping.safeHeaders,
        });
        completeSemanticJourneyStep(
          options.journey,
          "p6.render_client_error",
          presentationLocation,
          "success",
        );
        observeSemanticJourney(options.journey, {
          kind: "client_response_prepared",
          status: response.status,
          ...(response.headers.get("content-type") === null
            ? {}
            : { mediaType: response.headers.get("content-type")! }),
          location: presentationLocation,
        });
        const outcomeLocation = {
          phase: "outcome_commit",
          lane: "semantic_conversion",
          step: "commit_request_outcome",
        } as const;
        enterSemanticJourneyStep(
          options.journey,
          "p7.commit_request_outcome",
          outcomeLocation,
        );
        observeSemanticJourney(options.journey, {
          kind: "work_outcome_committed",
          outcome: "failed",
          terminalAuthority: "pi_execution",
          location: outcomeLocation,
        });
        completeSemanticJourneyStep(
          options.journey,
          "p7.commit_request_outcome",
          outcomeLocation,
          "success",
        );
        return response;
      }
      return toResponse(
        renderResponsesError(502, "api_error", "Upstream provider failed"),
      );
    }
    throw error;
  }
}
