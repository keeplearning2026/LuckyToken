import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type {
  CodexFetchFunction,
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
} from "../../src/codex-native-seam.js";
import type {
  RequestJourneyBeginInput,
  RequestJourneyCloseInput,
  RequestJourneyObservationAuthority,
  RequestJourneyObservationInput,
} from "../../src/diagnostics/index.js";
import type { ExecutionOperation } from "../../src/execution.js";
import { createCodexLocalCompactLane } from "../../src/integrations/codex/local-compact.js";
import { createOpenAIResponsesCompactHandler } from "../../src/protocols/openai-responses/compact.js";
import type { ProviderResponsesLane } from "../../src/provider-native-responses/contract.js";
import { createLuckyTokenRuntime } from "../../src/runtime.js";

const REQUEST_ID = "68000000-0000-4000-8000-000000000001";

interface RecordedJourney {
  readonly admission: RequestJourneyBeginInput;
  readonly observations: RequestJourneyObservationInput[];
  close?: RequestJourneyCloseInput;
}

function recordingAuthority(): {
  readonly authority: RequestJourneyObservationAuthority;
  readonly journeys: RecordedJourney[];
} {
  const journeys: RecordedJourney[] = [];
  return {
    journeys,
    authority: {
      begin(admission) {
        const journey: RecordedJourney = { admission, observations: [] };
        journeys.push(journey);
        return {
          requestId: admission.requestId,
          observe: (observation) => journey.observations.push(observation),
          close: (input) => {
            journey.close = input;
          },
        };
      },
      observeRuntime: () => undefined,
    },
  };
}

function compactRequest(model: string): Request {
  return new Request("http://luckytoken.test/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "compact this" }],
        },
      ],
    }),
  });
}

function providerModel(): Model<string> {
  return {
    id: "gpt-compact",
    name: "GPT Compact",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://provider.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function semanticMessage(model: Model<string>): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "compact summary" }],
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("Request Journey successful conversation compaction", () => {
  it("keeps the Local Native compact lane observable through final in-process handoff", async () => {
    const recording = recordingAuthority();
    const credentials: CodexLocalCredentialAuthority = {
      resolveForwardAuth: async () => ({
        authorization: "Bearer local-secret",
        accountId: "local-account",
      }),
      scrub: (value) => value,
    };
    const nativeModels: CodexNativeModelSource = {
      has: (selector) => selector === "gpt-native",
    };
    const outbound: string[] = [];
    const fetch: CodexFetchFunction = async (input, init) => {
      const request = new Request(input, init);
      outbound.push(await request.text());
      return new Response(
        JSON.stringify({ object: "response.compaction", output: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const models = new Proxy({} as Models, {
      get() {
        throw new Error("Local Native compact must not touch Pi Models");
      },
    });
    const handler = createOpenAIResponsesCompactHandler({
      models,
      localNativeLane: createCodexLocalCompactLane({
        credentials,
        models: nativeModels,
        fetch,
      }),
      stateFile: "unused-local-compact-journey.json",
      maxRequestBytes: 8_192,
    });
    const response = await createLuckyTokenRuntime({
      clientProtocols: [handler],
      diagnostics: recording.authority,
      createRequestId: () => REQUEST_ID,
    }).handle(compactRequest("gpt-native"));

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(1);
    expect(recording.journeys).toHaveLength(1);
    const journey = recording.journeys[0]!;
    expect(journey.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "lane_committed",
          lane: "local_native",
        }),
        expect.objectContaining({
          kind: "artifact_observed",
          artifactKind: "client_request_wire",
          state: "captured",
        }),
        expect.objectContaining({
          kind: "artifact_observed",
          artifactKind: "local_outbound_request_wire",
          state: "captured",
        }),
        expect.objectContaining({
          kind: "artifact_observed",
          artifactKind: "local_upstream_response_wire",
          state: "captured",
        }),
        expect.objectContaining({
          kind: "client_response_prepared",
          status: 200,
          location: expect.objectContaining({ lane: "local_native" }),
        }),
        expect.objectContaining({
          kind: "work_outcome_committed",
          outcome: "success",
          terminalAuthority: "codex_local_compact_lane",
        }),
        expect.objectContaining({
          kind: "handoff_observed",
          outcome: "finished",
          transport: "in_process",
        }),
      ]),
    );
    expect(journey.close).toMatchObject({ outcome: "success" });
  });

  it("records the Provider Native compact response artifact before terminal presentation", async () => {
    const recording = recordingAuthority();
    const model = providerModel();
    const upstreamBody = JSON.stringify({
      object: "response.compaction",
      model: model.id,
      output: [],
    });
    const providerNativeLane: ProviderResponsesLane = {
      claims: () => true,
      execute: async () =>
        new Response(upstreamBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    };
    const handler = createOpenAIResponsesCompactHandler({
      models: { getModels: () => [model] } as unknown as Models,
      providerNativeLane,
      stateFile: "unused-provider-compact-journey.json",
      maxRequestBytes: 8_192,
    });

    const response = await createLuckyTokenRuntime({
      clientProtocols: [handler],
      diagnostics: recording.authority,
      createRequestId: () => REQUEST_ID,
    }).handle(compactRequest(`${model.provider}/${model.id}`));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamBody);
    const journey = recording.journeys[0]!;
    expect(journey.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "lane_committed",
          lane: "provider_native",
        }),
        expect.objectContaining({
          kind: "artifact_observed",
          artifactKind: "provider_native_preserved_response_wire",
          state: "captured",
        }),
        expect.objectContaining({
          kind: "client_response_prepared",
          status: 200,
          location: expect.objectContaining({ lane: "provider_native" }),
        }),
        expect.objectContaining({
          kind: "work_outcome_committed",
          outcome: "success",
          terminalAuthority: "openai_responses_provider_native_lane",
        }),
      ]),
    );
    expect(journey.close).toMatchObject({ outcome: "success" });
  });

  it("records Semantic compact execution evidence separately from its final response", async () => {
    const recording = recordingAuthority();
    const model = {
      ...providerModel(),
      provider: "fixture",
      api: "fixture-api",
      id: "summary-model",
    };
    const executeOperation = (async (
      _models,
      _model,
      _context,
      options,
    ) => {
      await options.onPayload?.({}, model);
      return semanticMessage(model);
    }) as ExecutionOperation;
    const handler = createOpenAIResponsesCompactHandler({
      models: { getModels: () => [model] } as unknown as Models,
      executeOperation,
      createResponseId: () => "resp_compact_summary",
      now: () => 1,
      stateFile: "unused-semantic-compact-journey.json",
      maxRequestBytes: 8_192,
    });

    const response = await createLuckyTokenRuntime({
      clientProtocols: [handler],
      diagnostics: recording.authority,
      createRequestId: () => REQUEST_ID,
    }).handle(compactRequest(`${model.provider}/${model.id}`));

    expect(response.status).toBe(200);
    const journey = recording.journeys[0]!;
    expect(journey.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "lane_committed",
          lane: "semantic_conversion",
        }),
        expect.objectContaining({
          kind: "artifact_observed",
          artifactKind: "pi_invocation_snapshot",
        }),
        expect.objectContaining({
          kind: "client_response_prepared",
          status: 200,
          location: expect.objectContaining({
            lane: "semantic_conversion",
            step: "prepare_semantic_compact_response",
          }),
        }),
        expect.objectContaining({
          kind: "work_outcome_committed",
          outcome: "success",
          terminalAuthority: "openai_responses_semantic_compact",
        }),
      ]),
    );
    expect(journey.close).toMatchObject({ outcome: "success" });
  });
});
