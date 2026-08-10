import { describe, expect, it } from "vitest";

import { InvalidRequest, UnsupportedFeature } from "../../src/protocols/anthropic/failures.js";
import {
  convertValidatedAnthropicRequest,
  validateAnthropicSourceRequest,
} from "../../src/protocols/anthropic/request.js";

function request(tools: unknown[]): Record<string, unknown> {
  return {
    model: "model",
    max_tokens: 32,
    messages: [{ role: "user", content: "use a tool" }],
    tools,
  };
}

function tool(
  inputSchema: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name: "lookup", input_schema: inputSchema, ...extras };
}

describe("Anthropic tool definitions", () => {
  it("preserves the complete recursive v1 schema and strict semantics", () => {
    const inputSchema = {
      type: "object",
      title: "Lookup input",
      description: "Complete schema",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 20,
          pattern: "^[a-z]+$",
          enum: ["a", "b"],
          const: "a",
          default: "a",
          examples: ["a"],
          title: "Query",
          description: "A query",
        },
        count: {
          type: "integer",
          minimum: 0,
          maximum: 10,
          exclusiveMinimum: -1,
          exclusiveMaximum: 11,
          multipleOf: 1,
        },
        list: {
          type: "array",
          items: { type: "number" },
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
        },
        valueData: {
          type: "object",
          enum: [{ $ref: "value-not-schema" }],
          const: { anyOf: "value-not-schema" },
          default: { format: "value-not-schema" },
          examples: [{ type: ["value-not-schema"] }],
          additionalProperties: { type: "boolean" },
          minProperties: 0,
          maxProperties: 2,
        },
        nothing: { type: "null" },
      },
      required: ["query"],
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 5,
    };
    const validated = validateAnthropicSourceRequest(
      request([
        tool(inputSchema, {
          description: "Exact description",
          strict: true,
        }),
      ]),
    );
    const invocation = convertValidatedAnthropicRequest(validated, 1);

    expect(invocation.context.tools).toEqual([
      {
        name: "lookup",
        description: "Exact description",
        parameters: inputSchema,
        constrainedSampling: { type: "json_schema", strict: "require" },
      },
    ]);
  });

  it("projects an omitted description to the frozen empty required shape", () => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(
        request([tool({ type: "object", properties: {} })]),
      ),
      1,
    );

    expect(invocation.context.tools?.[0]).toEqual({
      name: "lookup",
      description: "",
      parameters: { type: "object", properties: {} },
    });
  });

  it.each([
    ["cache control", { cache_control: { type: "ephemeral" } }],
    ["allowed callers", { allowed_callers: ["direct"] }],
    ["deferred loading", { defer_loading: true }],
    ["eager input", { eager_input_streaming: true }],
    ["input examples", { input_examples: [{}] }],
    ["server tool type", { type: "web_search_20250305" }],
    ["future control", { future_control: true }],
  ])("rejects unsupported tool control: %s", (_name, extras) => {
    expect(() =>
      validateAnthropicSourceRequest(
        request([tool({ type: "object", properties: {} }, extras)]),
      ),
    ).toThrow(UnsupportedFeature);
  });

  it("keeps source-invalid schema ownership ahead of subset rejection", () => {
    expect(() =>
      validateAnthropicSourceRequest(
        request([
          tool({
            type: "object",
            properties: [],
            format: "also-unsupported",
          }),
        ]),
      ),
    ).toThrow(InvalidRequest);
  });

  it.each([
    ["reference", { type: "object", properties: { x: { $ref: "#/$defs/x" } } }],
    ["composition", { type: "object", properties: { x: { anyOf: [{ type: "string" }] } } }],
    ["format", { type: "object", properties: { x: { type: "string", format: "date" } } }],
    ["type array", { type: "object", properties: { x: { type: ["string", "null"] } } }],
    ["unknown keyword", { type: "object", properties: { x: { type: "string", future: true } } }],
  ])("classifies source-valid unsupported schema feature: %s", (_name, schema) => {
    expect(() => validateAnthropicSourceRequest(request([tool(schema)]))).toThrow(
      UnsupportedFeature,
    );
  });

  it("classifies cyclic schema graphs as unsupported without recursing forever", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} };
    (cyclic.properties as Record<string, unknown>).self = cyclic;

    expect(() => validateAnthropicSourceRequest(request([tool(cyclic)]))).toThrow(
      UnsupportedFeature,
    );
  });

  it("enforces request-wide strict limits before the subset check", () => {
    const strictTool = (name: string, schema: Record<string, unknown>) => ({
      name,
      input_schema: schema,
      strict: true,
    });
    expect(() =>
      validateAnthropicSourceRequest(
        request(
          Array.from({ length: 21 }, (_, index) =>
            strictTool(`tool_${index}`, { type: "object", properties: {} }),
          ),
        ),
      ),
    ).toThrow(InvalidRequest);

    const properties = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`p${index}`, { type: "string" }]),
    );
    expect(() =>
      validateAnthropicSourceRequest(
        request([strictTool("optional", { type: "object", properties })]),
      ),
    ).toThrow(InvalidRequest);

    const unions = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `p${index}`,
        { type: ["string", "null"] },
      ]),
    );
    expect(() =>
      validateAnthropicSourceRequest(
        request([
          strictTool("unions", {
            type: "object",
            properties: unions,
            required: Object.keys(unions),
          }),
        ]),
      ),
    ).toThrow(InvalidRequest);
  });

  it("accepts exact strict boundaries before applying the frozen subset", () => {
    const strictTool = (name: string, schema: Record<string, unknown>) => ({
      name,
      input_schema: schema,
      strict: true,
    });
    expect(() =>
      validateAnthropicSourceRequest(
        request(
          Array.from({ length: 20 }, (_, index) =>
            strictTool(`tool_${index}`, { type: "object", properties: {} }),
          ),
        ),
      ),
    ).not.toThrow();

    const optional = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`p${index}`, { type: "string" }]),
    );
    expect(() =>
      validateAnthropicSourceRequest(
        request([strictTool("optional", { type: "object", properties: optional })]),
      ),
    ).not.toThrow();

    const unions = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `p${index}`,
        { type: ["string", "null"] },
      ]),
    );
    expect(() =>
      validateAnthropicSourceRequest(
        request([
          strictTool("unions", {
            type: "object",
            properties: unions,
            required: Object.keys(unions),
          }),
        ]),
      ),
    ).toThrow(UnsupportedFeature);
  });
});
