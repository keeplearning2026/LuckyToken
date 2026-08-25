import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type RequestJourneyCloseInput,
  type RequestJourneyObservationAuthority,
} from "../../src/diagnostics/index.js";
import {
  createAnthropicMessagesHandler,
} from "../../src/protocols/anthropic/handler.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "50000000-0000-4000-8000-000000000001";
const WORK_OUTCOME_LOCATION = {
  phase: "outcome_commit",
  lane: "semantic_conversion",
  step: "commit_request_outcome",
} as const;
const FAILURE_LOCATION = {
  phase: "lane_response_processing",
  lane: "semantic_conversion",
  direction: "pi_to_client",
  step: "validate_assistant_message",
  subject: "message",
} as const;
const HANDOFF_LOCATION = {
  phase: "http_handoff",
  step: "write_http_response",
} as const;

const model: Model<string> = {
  id: "model",
  name: "model",
  api: "pi-messages",
  provider: "fixture-provider",
  baseUrl: "https://provider.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100,
  maxTokens: 10,
};

function successfulPiMessageWithUnrepresentableClientArguments(): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [
      { type: "text", text: "must-not-be-written" },
      {
        type: "toolCall",
        id: "call",
        name: "tool",
        arguments: { invalid: BigInt(1) },
      },
    ],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function streamFrom(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  let index = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = events[index++];
        return value === undefined
          ? { done: true as const, value: undefined }
          : { done: false as const, value };
      },
    }),
  } as AssistantMessageEventStream;
}

describe("Request Journey semantic response failures", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("keeps trusted Pi success when Anthropic client conversion fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-journey-render-failure-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);

    let resolveJourneyClosed!: (input: RequestJourneyCloseInput) => void;
    const journeyClosed = new Promise<RequestJourneyCloseInput>((resolve) => {
      resolveJourneyClosed = resolve;
    });
    const latchedAuthority: RequestJourneyObservationAuthority = {
      begin: (input) => {
        const observer = authority.begin(input);
        return {
          requestId: observer.requestId,
          observe: (observation) => observer.observe(observation),
          close: (closeInput) => {
            observer.close(closeInput);
            resolveJourneyClosed(closeInput);
          },
        };
      },
      observeRuntime: (input) => authority.observeRuntime(input),
    };

    const terminal = successfulPiMessageWithUnrepresentableClientArguments();
    const streamSimple = vi.fn(
      (_model: Model<string>, _context: unknown, options?: ModelsSimpleStreamOptions) => {
        const stream = streamFrom([
          { type: "done", reason: "toolUse", message: terminal },
        ]);
        const iterator = stream[Symbol.asyncIterator]();
        let prepared = false;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (!prepared) {
                prepared = true;
                await options?.onPayload?.({
                  model: model.id,
                  context: {},
                  options: { maxTokens: 10 },
                }, model);
              }
              return iterator.next();
            },
          }),
        } as AssistantMessageEventStream;
      },
    );
    const models = {
      getModels: () => [model],
      streamSimple,
    } as unknown as Models;
    const createMessageId = vi.fn(() => "msg_client");
    const anthropic = createAnthropicMessagesHandler({
      models,
      modelValidityPolicy: defaultAnthropicModelValidityPolicy,
      createMessageId,
      maxRequestBytes: 1_000_000,
      routerDefaults: {},
      now: () => 1,
    });
    const runtime = createTokenRuntime({ clientProtocols: [anthropic] });
    const server = await startTokenHttpServer({
      runtime,
      diagnostics: latchedAuthority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer client",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const responseBody = await response.text();
    const closeInput = await journeyClosed;

    expect(streamSimple).toHaveBeenCalledOnce();
    expect(createMessageId).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-token-request-id")).toBe(REQUEST_ID);
    expect(JSON.parse(responseBody)).toEqual({
      type: "error",
      error: { type: "api_error", message: "Internal server error" },
      request_id: REQUEST_ID,
    });
    expect(responseBody).not.toContain("must-not-be-written");
    expect(closeInput).toMatchObject({
      outcome: "failed",
      lastKnownLocation: HANDOFF_LOCATION,
    });

    // close() posts the seal before resolving this latch. The subsequent get
    // command therefore acts as a causal Worker barrier without polling time.
    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    expect(detail).toMatchObject({
      requestId: REQUEST_ID,
      operation: "model_generation",
      protocol: "anthropic-messages",
      lane: "semantic_conversion",
      outcome: "failed",
    });
    expect(detail.workOutcome).toEqual({
      outcome: "success",
      terminalAuthority: "pi_execution",
      location: WORK_OUTCOME_LOCATION,
    });

    const workOutcomes = detail.timeline.filter(
      (event) => event.observation.kind === "work_outcome_committed",
    );
    expect(workOutcomes).toHaveLength(1);
    expect(workOutcomes[0]!.observation).toMatchObject({
      kind: "work_outcome_committed",
      outcome: "success",
      terminalAuthority: "pi_execution",
      location: WORK_OUTCOME_LOCATION,
    });

    expect(detail.incident).toBeDefined();
    const primaryFailureId = detail.incident!.primaryFailureId;
    const primaryFailureEvent = detail.timeline.find(
      (event) =>
        event.observation.kind === "failure_detected" &&
        event.observation.failureId === primaryFailureId,
    );
    expect(primaryFailureEvent?.observation).toMatchObject({
      kind: "failure_detected",
      role: "primary",
      classification: "client_response_conversion_failed",
      origin: "Token",
      originPrecision: "exact",
      location: FAILURE_LOCATION,
    });
    expect(detail.incident!.failures).toContainEqual(
      primaryFailureEvent!.observation,
    );
    expect(detail.primaryFailureLocation).toEqual(FAILURE_LOCATION);

    expect(primaryFailureEvent!.sequence).toBeLessThan(workOutcomes[0]!.sequence);
    const observations = detail.timeline.map((event) => event.observation);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "step_completed",
          stepInstanceId: "p5.validate_assistant_message",
          completion: "failed",
          location: FAILURE_LOCATION,
        }),
      ]),
    );
    expect(
      observations.some(
        (observation) =>
          (observation.kind === "step_entered" ||
            observation.kind === "step_completed") &&
          observation.stepInstanceId === "p6.encode_client_response",
      ),
    ).toBe(false);
    expect(detail.handoffOutcome).toMatchObject({
      outcome: "finished",
      transport: "http",
      writableFinished: true,
      location: HANDOFF_LOCATION,
    });

    const responseArtifact = await authority.getRequestArtifact({
      requestId: REQUEST_ID,
      artifactId: "client_response_wire",
      offset: 0,
      limit: 256 * 1_024,
    });
    expect(Buffer.from(responseArtifact.dataBase64, "base64").toString("utf8"))
      .toBe(responseBody);
  });
});
