import type {
  FetchFunction,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { UpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";

import {
  execute,
  ExecutionAbortedError,
  freezePiInvocation,
  type ExecutionOperation,
} from "../../execution.js";
import type { InvocationDiagnostics } from "../../invocation-diagnostics/index.js";
import type { RequestIdentity } from "../../request-identity.js";
import type { RequestLedgerEntry } from "../../request-ledger/handler-seam.js";
import {
  composeOptions,
  type RouterOptionDefaults,
} from "../options.js";
import type { OpenAIResponsesConfiguration } from "./configuration.js";
import { mapUpstreamFailureFact } from "./error-rendering.js";
import {
  convertResponsesRequest,
  InvalidRequest,
  type ResponsesInvocation,
} from "./request.js";
import {
  convertAssistantMessageToResponses,
  renderResponsesError,
  renderResponsesErrorResponse,
  type PreparedHttpResponse,
  type ResponsesEchoTool,
  type ResponsesRenderState,
  type ResponsesResponseObject,
} from "./response.js";
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
  readonly diagnostics: InvocationDiagnostics;
  readonly ledger: RequestLedgerEntry;
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
  const state = invocation.renderState;
  const freeformNames = state.freeformToolNames;
  const namespaceReverse = state.namespaceReverse;
  const catalog = invocation.context.tools;
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
  unknownPiContent: "error" | "ignore",
  notice: (notice: {
    readonly adapter: string;
    readonly direction: "request" | "response";
    readonly code: string;
    readonly jsonPath?: string;
    readonly action: "ignore" | "degrade" | "xrepair";
  }) => void,
): ResponsesRenderState {
  const state = invocation.renderState;
  const tools = buildEchoTools(invocation);
  const freeformNames = state.freeformToolNames;
  const namespaceReverse = state.namespaceReverse;
  const temperature =
    typeof invocation.options.temperature === "number"
      ? invocation.options.temperature
      : undefined;
  const topP =
    typeof invocation.options.samplingParams?.top_p === "number"
      ? (invocation.options.samplingParams.top_p as number)
      : undefined;
  return Object.freeze({
    clientModel: state.clientModel,
    stream: state.stream,
    ...(state.toolChoice === undefined ? {} : { toolChoice: state.toolChoice }),
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
    { ...invocation.options },
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
    options.diagnostics.notice(notice);
    options.ledger.notice(notice);
  });
}

export async function executeSemanticResponses(
  options: SemanticResponsesExecutionOptions,
): Promise<Response> {
  const executeOperation = options.executeOperation ?? execute;
  try {
    const previousResponseId =
      typeof options.body === "object" && options.body !== null
        ? (options.body as Record<string, unknown>).previous_response_id
        : undefined;
    const expanded =
      typeof previousResponseId === "string" && previousResponseId.length > 0
        ? await options.sessionState.expand(options.body)
        : options.body;

    const invocation = convertResponsesRequest(
      expanded,
      options.now(),
      options.configuration.conversion.request,
    );
    for (const notice of invocation.notices) {
      options.diagnostics.notice(notice);
      options.ledger.notice(notice);
    }
    const piOptions = composeInvocationOptions(
      invocation,
      {
        sessionId: options.requestIdentity.effectiveSessionId,
        signal: options.request.signal,
      },
      options.routerDefaults,
    );
    options.diagnostics.checkpoint({
      stage: "pi-execution",
      selector: invocation.selector,
    });
    freezePiInvocation(options.model, invocation.context, piOptions);
    options.ledger.executing();
    const message = await executeOperation(
      options.models,
      options.model,
      invocation.context,
      piOptions,
      {
        notice: (notice) => {
          options.diagnostics.notice(notice);
          options.ledger.notice(notice);
        },
        attempt: (attempt) => {
          options.diagnostics.attempt(attempt);
          options.ledger.attempt(attempt);
        },
        terminalUsage: (snapshot) => {
          options.ledger.terminalUsage(snapshot);
        },
      },
    );
    options.request.signal.throwIfAborted();
    options.ledger.terminal("success", { piStopReason: message.stopReason });
    options.diagnostics.checkpoint({
      stage: "client-render",
      selector: invocation.selector,
    });
    options.ledger.rendering();

    const renderState = buildRenderState(
      invocation,
      options.configuration.conversion.response.unknownPiContent,
      (notice) => {
        options.diagnostics.notice(notice);
        options.ledger.notice(notice);
      },
    );
    const rendered = convertAssistantMessageToResponses(
      message,
      renderState,
      options.createResponseId(),
      Math.floor(options.now() / 1000),
      typeof previousResponseId === "string" ? previousResponseId : undefined,
    );
    await rememberAfterSuccess(options, rendered);
    const prepared = invocation.renderState.stream
      ? renderResponsesSse(rendered)
      : renderResponsesJson(rendered);
    options.request.signal.throwIfAborted();
    return toResponse(prepared);
  } catch (error) {
    if (options.request.signal.aborted || error instanceof ExecutionAbortedError) {
      throw new ExecutionAbortedError(options.request.signal.reason);
    }
    if (error instanceof InvalidRequest || error instanceof ResponseStateConversionFailure) {
      options.ledger.terminal("failed", { clientHttpStatus: 400 });
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
        const mapping = mapUpstreamFailureFact(execution.failure);
        options.ledger.terminal("failed", { clientHttpStatus: mapping.status });
        options.ledger.fail({ classification: "runtime-failure", error });
        return renderResponsesErrorResponse({
          status: mapping.status,
          type: mapping.type,
          message: mapping.message,
          code: mapping.code,
          param: mapping.param,
          safeHeaders: mapping.safeHeaders,
        });
      }
      options.ledger.terminal("failed", { clientHttpStatus: 502 });
      options.ledger.fail({ classification: "runtime-failure", error });
      return toResponse(
        renderResponsesError(502, "api_error", "Upstream provider failed"),
      );
    }
    throw error;
  }
}
