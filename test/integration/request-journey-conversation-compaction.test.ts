import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type DiagnosticsSubscription,
  type RequestJourneyPersistedObservation,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import type { ExecutionOperation } from "../../src/execution.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { createOpenAIResponsesCompactHandler } from "../../src/protocols/openai-responses/compact.js";
import type { PublicModelSource } from "../../src/public-model-seam.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "67000000-0000-4000-8000-000000000001";
const ALIAS = "compact-alias";
const PROVIDER_TOKEN = "compact-provider-token-4df392";
const UPSTREAM_MALFORMED_BODY = '{"object":"response.compaction","model":';
const PRIMARY_LOCATION = {
  phase: "lane_response_processing",
  lane: "provider_native",
  step: "project_native_alias",
  attempt: 1,
} as const;
const PRESENTATION_LOCATION = {
  phase: "client_response_preparation",
  lane: "provider_native",
  step: "prepare_provider_native_error_response",
} as const;
const WORK_OUTCOME_LOCATION = {
  phase: "outcome_commit",
  lane: "provider_native",
  step: "commit_request_outcome",
} as const;
const HANDOFF_LOCATION = {
  phase: "http_handoff",
  step: "write_http_response",
} as const;

interface ResponseSnapshot {
  readonly status: number;
  readonly requestId: string | null;
  readonly mediaType: string | null;
  readonly body: string;
}

interface OutboundSnapshot {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string;
}

async function readResponse(response: Response): Promise<ResponseSnapshot> {
  return Object.freeze({
    status: response.status,
    requestId: response.headers.get("x-token-request-id"),
    mediaType: response.headers.get("content-type"),
    body: await response.text(),
  });
}

function compactModel(): Model<string> {
  return {
    id: "gpt-compact",
    name: "GPT Compact",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://provider.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function completedStep(
  observations: readonly RequestJourneyPersistedObservation[],
  stepInstanceId: string,
): RequestJourneyPersistedObservation | undefined {
  return observations.find(
    (observation) =>
      observation.kind === "step_completed" &&
      observation.stepInstanceId === stepInstanceId,
  );
}

describe("Request Journey OpenAI Responses conversation compaction", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const subscriptions: DiagnosticsSubscription[] = [];
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    for (const subscription of subscriptions.splice(0)) {
      subscription.unsubscribe();
    }
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("locates an unprojectable Provider Native compact response without changing its safe 502", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-compact-journey-"));
    roots.push(root);
    const model = compactModel();
    const ambientCapture: ProviderAuthBindingCapture = Object.freeze({
      facts: Object.freeze({ kind: "ambient" as const, providerId: "openai" }),
    });
    const bindings: Pick<
      ProviderAuthBindingAuthority,
      "capture" | "runBound" | "advanceAfterFinal429"
    > = Object.freeze({
      capture: async () => ambientCapture,
      runBound: async <T>(
        _capture: ProviderAuthBindingCapture,
        operation: () => Promise<T>,
      ): Promise<T> => operation(),
      advanceAfterFinal429: async () => {
        throw new Error("A successful compact response must not switch Profile");
      },
    });
    const models = {
      getModels: () => [model],
      getAuth: async () => ({
        auth: { apiKey: PROVIDER_TOKEN },
        source: "fixture",
      }),
    } as unknown as Models;
    const publicModels: PublicModelSource = Object.freeze({
      requestSnapshot: async () =>
        ({
          resolve: (selector: string) =>
            selector === ALIAS
              ? { providerId: model.provider, modelId: model.id }
              : undefined,
        }) as never,
    });
    const outbound: OutboundSnapshot[] = [];
    const providerFetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      outbound.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return new Response(UPSTREAM_MALFORMED_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    let semanticExecutions = 0;
    const executeOperation = (async () => {
      semanticExecutions += 1;
      throw new Error("Semantic compact must not run after Provider Native claims");
    }) as ExecutionOperation;
    const providerNativeLane = createProviderNativeResponses({
      models,
      bindings,
      fetch: providerFetch,
    });
    const handler = createOpenAIResponsesCompactHandler({
      models,
      publicModels,
      providerNativeLane,
      executeOperation,
      stateFile: join(root, "responses-state.json"),
      createSessionId: () => "67000000-0000-4000-8000-000000000002",
      maxRequestBytes: 8_192,
    });
    const runtime = createTokenRuntime({ clientProtocols: [handler] });
    const requestBody = JSON.stringify({
      model: ALIAS,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "compact this history" }],
        },
      ],
    });

    const baselineServer = await startTokenHttpServer({
      runtime,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(baselineServer);
    const baseline = await readResponse(
      await fetch(`${baselineServer.origin}/v1/responses/compact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      }),
    );

    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: join(root, "diagnostics") },
        root,
      ),
    });
    authorities.push(authority);
    let publish!: (record: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    subscriptions.push(
      authority.subscribeRequestJourneys((record) => {
        if (record.requestId === REQUEST_ID) publish(record);
      }),
    );
    const observedServer = await startTokenHttpServer({
      runtime,
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(observedServer);
    const observed = await readResponse(
      await fetch(`${observedServer.origin}/v1/responses/compact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      }),
    );
    const publishedSummary = await published;

    const expectedBody = JSON.stringify({
      error: {
        message: "Upstream response could not be projected safely",
        type: "api_error",
        code: null,
        param: null,
      },
    });
    expect(observed).toEqual(baseline);
    expect(observed).toEqual({
      status: 502,
      requestId: REQUEST_ID,
      mediaType: "application/json",
      body: expectedBody,
    });
    expect(semanticExecutions).toBe(0);
    expect(outbound).toHaveLength(2);
    expect(outbound).toEqual([
      {
        url: "https://provider.example.com/v1/responses/compact",
        method: "POST",
        authorization: `Bearer ${PROVIDER_TOKEN}`,
        body: requestBody.replace(`"${ALIAS}"`, `"${model.id}"`),
      },
      {
        url: "https://provider.example.com/v1/responses/compact",
        method: "POST",
        authorization: `Bearer ${PROVIDER_TOKEN}`,
        body: requestBody.replace(`"${ALIAS}"`, `"${model.id}"`),
      },
    ]);

    expect(publishedSummary).toMatchObject({
      requestId: REQUEST_ID,
      operation: "conversation_compaction",
      protocol: "openai-responses",
      lane: "provider_native",
      outcome: "failed",
      primaryFailureLocation: PRIMARY_LOCATION,
    });
    const page = await authority.queryRequestJourneys({ limit: 10 });
    expect(page.records).toEqual([publishedSummary]);
    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    expect(detail.admission).toMatchObject({
      operationCandidate: "pending",
      transport: "http",
      method: "POST",
      path: "/v1/responses/compact",
    });
    const observations = detail.timeline.map((event) => event.observation);
    expect(completedStep(observations, "p1.resolve_route")).toMatchObject({
      completion: "success",
      location: { phase: "protocol_ingress", step: "resolve_route" },
    });
    expect(completedStep(observations, "p2.extract_model_selector"))
      .toMatchObject({
        completion: "success",
        operation: "conversation_compaction",
        protocol: "openai-responses",
        location: {
          phase: "request_resolution",
          step: "extract_model_selector",
        },
      });
    expect(completedStep(observations, "p2.resolve_public_model"))
      .toMatchObject({
        completion: "success",
        location: {
          phase: "request_resolution",
          step: "resolve_public_model",
        },
      });
    expect(completedStep(observations, "p2.recognize_provider_native"))
      .toMatchObject({
        completion: "success",
        location: {
          phase: "request_resolution",
          lane: "provider_native",
          step: "recognize_provider_native",
        },
      });
    expect(
      observations.filter((observation) => observation.kind === "lane_committed"),
    ).toEqual([
      {
        kind: "lane_committed",
        lane: "provider_native",
        location: {
          phase: "request_resolution",
          lane: "provider_native",
          step: "commit_lane",
        },
      },
    ]);

    for (const step of [
      "p3.capture_provider_profile.1",
      "p3.resolve_provider_auth.1",
      "p3.project_native_body.1",
      "p3.reconstruct_provider_envelope.1",
      "p4.dispatch_provider_native.1",
      "p4.read_provider_native_response.1",
      "p4.classify_native_retry.1",
      "p5.buffer_provider_native_response.1",
    ]) {
      expect(completedStep(observations, step), step).toMatchObject({
        completion: "success",
      });
    }
    expect(completedStep(observations, "p5.project_native_alias.1"))
      .toMatchObject({
        completion: "failed",
        location: PRIMARY_LOCATION,
      });

    const failures = observations.filter(
      (observation) => observation.kind === "failure_detected",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "failure_detected",
      failureId: detail.incident?.primaryFailureId,
      role: "primary",
      classification: "provider_native_alias_projection_failed",
      origin: "Token",
      originPrecision: "exact",
      location: PRIMARY_LOCATION,
    });
    expect(detail.incident?.failures).toEqual(failures);
    expect(detail.workOutcome).toEqual({
      outcome: "failed",
      terminalAuthority: "openai_responses_provider_native_lane",
      location: WORK_OUTCOME_LOCATION,
    });
    expect(detail.clientPresentation).toEqual({
      status: 502,
      mediaType: "application/json",
      location: PRESENTATION_LOCATION,
    });
    expect(detail.handoffOutcome).toMatchObject({
      outcome: "finished",
      transport: "http",
      writableFinished: true,
      location: HANDOFF_LOCATION,
    });
  });
});
