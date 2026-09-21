import {
  normalizeContext,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  buildCommandCodeBody,
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
} from "../../packages/provider-commandcode-private/src/provider.js";
import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";

const model: Model<typeof commandCodePrivateApiId> = {
  id: "model",
  name: "model",
  api: commandCodePrivateApiId,
  provider: commandCodePrivateProviderId,
  baseUrl: "https://fixture.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};

function build(tools: Tool[], options: SimpleStreamOptions = {}) {
  const context = normalizeContext({
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    tools,
  });
  return buildCommandCodeBody(
    model,
    context,
    options,
    createEmptyServerConfig(),
    "00000000-0000-4000-8000-000000000022",
    {},
  );
}

describe("CommandCode Pi tool definitions", () => {
  it("emits only exact name, description, and the complete input schema", () => {
    const parameters = {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    };
    const tools: Tool[] = [
      {
        name: "lookup",
        description: "Exact description",
        parameters,
      },
      {
        name: "preferred",
        description: "",
        parameters: { type: "object", properties: {} },
        constrainedSampling: { type: "json_schema", strict: "prefer" },
      },
    ];

    expect((build(tools).body.params as { tools: unknown[] }).tools).toEqual([
      { name: "lookup", description: "Exact description", input_schema: parameters },
      {
        name: "preferred",
        description: "",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("implements Pi toolChoice none by removing the current tool catalog", () => {
    const tools: Tool[] = [
      {
        name: "lookup",
        description: "Exact description",
        parameters: { type: "object", properties: {} },
      },
    ];

    expect((build(tools, { toolChoice: "none" }).body.params as { tools: unknown[] }).tools)
      .toEqual([]);
    expect((build(tools, { toolChoice: "auto" }).body.params as { tools: unknown[] }).tools)
      .toHaveLength(1);
    expect((build(tools).body.params as { tools: unknown[] }).tools).toHaveLength(1);
  });

  it.each([
    ["required", { toolChoice: "required" }],
    ["named", { toolChoice: { type: "tool", name: "lookup" } }],
    ["serial", { parallelToolCalls: false }],
  ] as const)("keeps the catalog and reports Provider-owned omission for %s", (_name, options) => {
    const tools: Tool[] = [{
      name: "lookup",
      description: "Exact description",
      parameters: { type: "object", properties: {} },
    }];
    const built = build(tools, options);

    expect((built.body.params as { tools: unknown[] }).tools).toHaveLength(1);
    expect(built.notices).toContainEqual(expect.objectContaining({
      adapter: "commandcode-private",
      direction: "request",
      code: _name === "serial"
        ? "parallel_tool_calls_unsupported_omitted"
        : "tool_choice_unsupported_omitted",
      action: "ignore",
    }));
  });

  it("degrades required JSON-schema enforcement to an ordinary tool and notice", () => {
    const built = build([
        {
          name: "strict",
          description: "",
          parameters: { type: "object", properties: {} },
          constrainedSampling: { type: "json_schema", strict: "require" },
        },
      ]);

    expect((built.body.params as { tools: unknown[] }).tools).toEqual([
      {
        name: "strict",
        description: "",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    expect(built.notices).toEqual([
      {
        adapter: "commandcode-private",
        direction: "request",
        code: "constrained_sampling_require_degraded",
        jsonPath: "$.tools[0].constrainedSampling",
        action: "degrade",
      },
    ]);
  });

  it.each([
    ["absent", undefined],
    ["false", false],
    ["json-schema prefer", { type: "json_schema", strict: "prefer" }],
    [
      "Lark grammar",
      { type: "grammar", variants: { openai_lark: "start: WORD" } },
    ],
    [
      "regex grammar",
      { type: "grammar", variants: { openai_regex: "[a-z]+" } },
    ],
  ] as const)("drops %s without changing the ordinary target tool", (_name, constrainedSampling) => {
    const built = build([
      {
        name: "ordinary",
        description: "description",
        parameters: { type: "object", properties: { value: { type: "string" } } },
        ...(constrainedSampling === undefined ? {} : { constrainedSampling }),
      },
    ]);

    expect((built.body.params as { tools: unknown[] }).tools).toEqual([
      {
        name: "ordinary",
        description: "description",
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ]);
    expect(built.notices).toEqual([]);
  });

  it("clones the schema losslessly and still rejects non-JSON schema state", () => {
    const parameters = {
      type: "object",
      properties: { nested: { type: "array", items: { type: "integer" } } },
    };
    const built = build([
      { name: "clone", description: "", parameters },
    ]);
    parameters.properties.nested.items.type = "string";

    expect((built.body.params as { tools: unknown[] }).tools).toEqual([
      {
        name: "clone",
        description: "",
        input_schema: {
          type: "object",
          properties: { nested: { type: "array", items: { type: "integer" } } },
        },
      },
    ]);

    expect(() =>
      build([
        {
          name: "invalid",
          description: "",
          parameters: { type: "object", bad: undefined } as never,
        },
      ]),
    ).toThrow("non-JSON value");
  });
});
