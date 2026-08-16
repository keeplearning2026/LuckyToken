import { describe, expect, it } from "vitest";

import {
  decodeModelsCommandResult,
  decodeModelsProjection,
  projectControlPlaneState,
} from "../src/control-plane-projection.js";

/**
 * Ticket 08 renderer seam: the full models catalog result and the sanitized
 * snapshot projection cross the bridge without leaking beyond the renderer.
 */
describe("models Control Plane renderer projection public seam", () => {
  it("decodes the full models result with raw bytes and extension providers", () => {
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
      },
    });
    expect(Object.isFrozen(result?.state)).toBe(true);
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
        state: { revision: 0, path: "p", present: true, valid: true, raw: "x" },
        error: { kind: "schema", message: "unexpected" },
      }),
    ).toBeUndefined();
    expect(
      decodeModelsCommandResult({
        outcome: "invalid",
        state: { revision: 0, path: "p", present: true, valid: true, raw: "x" },
      }),
    ).toBeUndefined();
    expect(
      decodeModelsCommandResult({
        outcome: "storage_failure",
        state: { revision: 0, path: "p", present: true, valid: true, raw: "x" },
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
