import { describe, expect, it } from "vitest";

import {
  decodeModelsCommandResult,
  decodeModelsProjection,
  projectControlPlaneState,
} from "../src/control-plane-projection.js";

/**
 * Ticket 08 renderer seam: the full models catalog result and the sanitized
 * snapshot projection cross the bridge without leaking beyond the renderer.
 * Ticket 09 adds the effective catalog to every valid state: the renderer
 * decodes it strictly, and the pages render it without building a second
 * registry.
 */
describe("models Control Plane renderer projection public seam", () => {
  const catalogFixture = {
    schemaVersion: "luckytoken-effective-catalog-v1",
    baseline: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.1",
      schema: "pi-coding-agent-0.84.1-models-json-schema",
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        layer: "builtin",
        models: [
          {
            id: "gpt-4",
            name: "GPT-4",
            api: "openai-responses",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192,
            layer: "builtin",
          },
        ],
      },
      {
        id: "my-gateway",
        name: "my-gateway",
        baseUrl: "https://gateway.example.com/v1",
        layer: "user",
        models: [
          {
            id: "m-1",
            name: "m-1",
            api: "openai-completions",
            provider: "my-gateway",
            baseUrl: "https://gateway.example.com/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
            layer: "user",
          },
          {
            id: "gpt-4",
            name: "GPT-4 tuned",
            api: "openai-responses",
            provider: "my-gateway",
            baseUrl: "https://gateway.example.com/v1",
            reasoning: true,
            input: ["text"],
            cost: { input: 99, output: 60, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 99999,
            maxTokens: 8192,
            layer: "overridden",
            overriddenFields: ["name", "reasoning", "cost", "contextWindow"],
          },
        ],
      },
    ],
    compositionErrors: [
      {
        providerId: "broken",
        message: 'Provider broken, model m: no "api" specified. Set at provider or model level.',
      },
    ],
  };

  it("decodes the full models result with raw bytes, extension providers, and the effective catalog", () => {
    const result = decodeModelsCommandResult({
      outcome: "ok",
      state: {
        revision: 2,
        path: "C:\\Users\\Alice\\.luckytoken\\pi\\models.json",
        present: true,
        valid: true,
        raw: '{ "providers": { "ollama": { "vendorFlag": 1 } } }',
        providers: {
          ollama: { baseUrl: "http://x", vendorFlag: 1 },
        },
        catalog: catalogFixture,
      },
    });

    expect(result).toEqual({
      outcome: "ok",
      state: {
        revision: 2,
        path: "C:\\Users\\Alice\\.luckytoken\\pi\\models.json",
        present: true,
        valid: true,
        raw: '{ "providers": { "ollama": { "vendorFlag": 1 } } }',
        providers: { ollama: { baseUrl: "http://x", vendorFlag: 1 } },
        catalog: catalogFixture,
      },
    });
    expect(Object.isFrozen(result?.state)).toBe(true);
  });

  it("rejects a valid state without the effective catalog and an invalid state with one", () => {
    // Aligned with the wire decoder: every valid state carries the catalog.
    expect(
      decodeModelsCommandResult({
        outcome: "ok",
        state: {
          revision: 2,
          path: "C:\\models.json",
          present: true,
          valid: true,
          raw: "{}",
          providers: {},
        },
      }),
    ).toBeUndefined();
    expect(
      decodeModelsCommandResult({
        outcome: "ok",
        state: {
          revision: 2,
          path: "C:\\models.json",
          present: true,
          valid: false,
          raw: "broken",
          error: { kind: "parse", message: "broken" },
          catalog: catalogFixture,
        },
      }),
    ).toBeUndefined();
  });

  it("rejects malformed effective catalogs instead of passing them to the renderer", () => {
    const broken = (patch: (catalog: Record<string, unknown>) => void) => {
      const value = structuredClone(catalogFixture) as Record<string, unknown>;
      patch(value);
      return decodeModelsCommandResult({
        outcome: "ok",
        state: {
          revision: 1,
          path: "C:\\models.json",
          present: true,
          valid: true,
          raw: "{}",
          providers: {},
          catalog: value,
        },
      });
    };
    expect(
      broken((value) => {
        value.schemaVersion = "luckytoken-effective-catalog-v9";
      }),
    ).toBeUndefined();
    expect(
      broken((value) => {
        delete (value.providers as unknown[])[0];
      }),
    ).toBeUndefined();
    expect(
      broken((value) => {
        (value.compositionErrors as unknown[]) = [
          { providerId: "", message: "x" },
        ];
      }),
    ).toBeUndefined();
    expect(
      broken((value) => {
        const model = (
          ((value.providers as Array<Record<string, unknown>>)[1] as Record<
            string,
            unknown
          >).models as Array<Record<string, unknown>>
        )[0] as Record<string, unknown>;
        model.overriddenFields = "not-an-array";
      }),
    ).toBeUndefined();
    expect(
      broken((value) => {
        const models = (
          (value.providers as Array<Record<string, unknown>>)[1] as Record<
            string,
            unknown
          >
        ).models as Array<Record<string, unknown>>;
        (models[0] as Record<string, unknown>).layer = "mystery";
      }),
    ).toBeUndefined();
    expect(
      broken((value) => {
        delete (value.baseline as Record<string, unknown>).version;
      }),
    ).toBeUndefined();
    // A secret smuggled into an unknown spot is dropped by the strict
    // projection: the whole result still decodes, but the secret never
    // reaches the renderer.
    const secret = structuredClone(catalogFixture) as Record<string, unknown>;
    (secret.providers as Array<Record<string, unknown>>)[0]!.apiKey =
      "sk-leaked-123";
    const secretResult = decodeModelsCommandResult({
      outcome: "ok",
      state: {
        revision: 1,
        path: "C:\\models.json",
        present: true,
        valid: true,
        raw: "{}",
        providers: {},
        catalog: secret,
      },
    });
    expect(JSON.stringify(secretResult)).not.toContain("sk-leaked-123");
  });

  it("decodes invalid results with exact locations and never echoes values", () => {
    const result = decodeModelsCommandResult({
      outcome: "invalid",
      state: {
        revision: 1,
        path: "C:\\models.json",
        present: true,
        valid: true,
        raw: "previous valid bytes",
        providers: { ollama: { baseUrl: "http://x" } },
        catalog: catalogFixture,
      },
      error: {
        kind: "parse",
        message: "Unexpected token at position 5 (line 2, column 3)",
        location: { line: 2, column: 3, position: 5 },
      },
    });

    expect(result).toMatchObject({
      outcome: "invalid",
      error: { kind: "parse", location: { line: 2, column: 3 } },
      state: { revision: 1, valid: true, raw: "previous valid bytes" },
    });
  });

  it("rejects malformed models results instead of passing them to the renderer", () => {
    expect(
      decodeModelsCommandResult({
        outcome: "ok",
        state: {
          revision: 0,
          path: "p",
          present: true,
          valid: true,
          raw: "x",
          providers: {},
          catalog: catalogFixture,
        },
        error: { kind: "schema", message: "unexpected" },
      }),
    ).toBeUndefined();
    expect(
      decodeModelsCommandResult({
        outcome: "invalid",
        state: {
          revision: 0,
          path: "p",
          present: true,
          valid: true,
          raw: "x",
          providers: {},
          catalog: catalogFixture,
        },
      }),
    ).toBeUndefined();
    expect(
      decodeModelsCommandResult({
        outcome: "storage_failure",
        state: {
          revision: 0,
          path: "p",
          present: true,
          valid: true,
          raw: "x",
          providers: {},
          catalog: catalogFixture,
        },
        error: { kind: "parse", message: "wrong kind" },
      }),
    ).toBeUndefined();
    // Aligned with the wire decoder: a valid state never carries a file
    // error, an absent file never carries providers, and an invalid file
    // never carries providers.
    expect(
      decodeModelsCommandResult({
        outcome: "ok",
        state: {
          revision: 0,
          path: "p",
          present: true,
          valid: true,
          raw: "x",
          providers: {},
          catalog: catalogFixture,
          error: { kind: "parse", message: "contradiction" },
        },
      }),
    ).toBeUndefined();
    expect(
      decodeModelsCommandResult({
        outcome: "ok",
        state: {
          revision: 0,
          path: "p",
          present: false,
          valid: false,
          raw: "",
          providers: {},
        },
      }),
    ).toBeUndefined();
    expect(
      decodeModelsCommandResult({
        outcome: "ok",
        state: {
          revision: 0,
          path: "p",
          present: true,
          valid: false,
          raw: "x",
          error: { kind: "parse", message: "broken" },
          providers: {},
        },
      }),
    ).toBeUndefined();
    expect(
      decodeModelsCommandResult({
        outcome: "conflict",
        state: { revision: 0, path: "p", present: false, valid: false, raw: "" },
      }),
    ).toBeDefined();
  });

  it("decodes the sanitized snapshot projection without content", () => {
    const projection = decodeModelsProjection({
      revision: 3,
      path: "C:\\models.json",
      present: true,
      valid: false,
      error: {
        kind: "schema",
        message: "Invalid models.json schema:\n  - providers.ollama: Expected object",
      },
    });

    expect(projection).toMatchObject({
      revision: 3,
      present: true,
      valid: false,
      error: { kind: "schema" },
    });
    expect(decodeModelsProjection({ revision: 0, path: "x", present: false, valid: false })).toMatchObject({
      present: false,
    });
    expect(
      decodeModelsProjection({
        revision: 0,
        path: "x",
        present: true,
        valid: true,
        error: { kind: "parse", message: "x" },
      }),
    ).toBeUndefined();
  });

  it("projects snapshot models but never the raw content into the renderer state", () => {
    const projected = projectControlPlaneState({
      revision: 9,
      connection: "connected",
      applicationVersion: "1.2.3",
      contractVersion: 1,
      snapshot: {
        sequence: 12,
        modelDataPlane: "running",
        provider: "configured",
        models: {
          revision: 4,
          path: "C:\\models.json",
          present: true,
          valid: true,
        },
        raw: "must-not-reach-renderer",
        providers: { ollama: { apiKey: "must-not-reach-renderer" } },
      },
    });

    expect(projected.kind).toBe("connected");
    if (projected.kind !== "connected") return;
    expect(projected.modelsProjection).toEqual({
      revision: 4,
      path: "C:\\models.json",
      present: true,
      valid: true,
    });
    expect(projected.models).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("must-not-reach-renderer");
    expect(JSON.stringify(projected)).not.toContain("ollama");
  });
});
