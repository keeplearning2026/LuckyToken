import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  InvocationCompositionFailure,
  composeOptions,
} from "../../src/options.js";

const sessionId = "00000000-0000-4000-8000-000000000070";

describe("closed-world Pi option composition", () => {
  it.each([
    {
      name: "neither metadata fact",
      protocol: { maxTokens: 10 },
      projectDir: undefined,
      metadata: undefined,
    },
    {
      name: "client user id only",
      protocol: { maxTokens: 10, metadata: { user_id: "user" } },
      projectDir: undefined,
      metadata: { user_id: "user" },
    },
    {
      name: "auth project only",
      protocol: { maxTokens: 10 },
      projectDir: "D:/project",
      metadata: { projectDir: "D:/project" },
    },
    {
      name: "both facts",
      protocol: { maxTokens: 10, metadata: { user_id: "user" } },
      projectDir: "D:/project",
      metadata: { user_id: "user", projectDir: "D:/project" },
    },
  ])("merges $name per owned key", ({ protocol, projectDir, metadata }) => {
    const controller = new AbortController();
    const effective = composeOptions(
      protocol,
      {
        sessionId,
        signal: controller.signal,
        ...(projectDir === undefined ? {} : { projectDir }),
      },
      {},
    );

    expect(effective).toEqual({
      maxTokens: 10,
      sessionId,
      signal: controller.signal,
      ...(metadata === undefined ? {} : { metadata }),
    });
    expect(effective.signal).toBe(controller.signal);
  });

  it("preserves exact temperature presence and accepts only empty v1 defaults", () => {
    const signal = new AbortController().signal;
    expect(
      composeOptions(
        { maxTokens: 12, temperature: 0 },
        { sessionId, signal },
        {},
      ),
    ).toEqual({ maxTokens: 12, temperature: 0, sessionId, signal });
    expect(
      composeOptions({ maxTokens: 12 }, { sessionId, signal }, {}),
    ).not.toHaveProperty("temperature");
  });

  it.each([
    ["reserved user id", { metadata: { user_id: "default" } }],
    ["reserved project", { metadata: { projectDir: "D:/other" } }],
    ["unknown metadata", { metadata: { trace: "value" } }],
    ["session override", { sessionId: "override" }],
    ["signal override", { signal: new AbortController().signal }],
    ["reasoning", { reasoning: "high" }],
    ["deferred", { deferred: true }],
    ["sampling", { samplingParams: { top_p: 0.5 } }],
    ["cache", { cacheRetention: "long" }],
    ["payload callback", { onPayload: () => undefined }],
  ])("rejects unclassified Router default: %s", (_name, defaults) => {
    expect(() =>
      composeOptions(
        { maxTokens: 10 },
        { sessionId, signal: new AbortController().signal },
        defaults,
      ),
    ).toThrow(InvocationCompositionFailure);
  });

  it("rejects protocol metadata written by a non-owner", () => {
    expect(() =>
      composeOptions(
        {
          maxTokens: 10,
          metadata: { projectDir: "client", extra: true },
        } as ModelsSimpleStreamOptions,
        { sessionId, signal: new AbortController().signal },
        {},
      ),
    ).toThrow(InvocationCompositionFailure);
  });
});
