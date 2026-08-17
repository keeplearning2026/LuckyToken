import { describe, expect, it } from "vitest";

import {
  decodeCredentialCommandResult,
  decodeCredentialProjection,
  projectControlPlaneState,
} from "../src/control-plane-projection.js";

/**
 * Ticket 12 renderer seam: the sanitized auth.json credential projection
 * and credential command results cross the bridge with strict decoding —
 * credential values, environment names, command text and raw credential
 * shapes can never reach the renderer, and renderer state persistence
 * (React state) only ever sees the bounded facts.
 */
describe("credentials Control Plane renderer projection public seam", () => {
  const projectionFixture = {
    revision: 3,
    path: "C:\\Users\\me\\.luckytoken\\auth.json",
    present: true,
    valid: true,
    providers: [
      {
        providerId: "anthropic",
        stored: true,
        storedType: "api_key",
        environment: false,
        modelsJson: false,
        commandDerived: false,
        expired: false,
        unavailable: false,
        effectiveSource: "stored",
      },
      {
        providerId: "my-gateway",
        stored: false,
        environment: false,
        modelsJson: true,
        commandDerived: true,
        expired: false,
        unavailable: false,
        effectiveSource: "command",
      },
      {
        providerId: "openai",
        stored: false,
        environment: true,
        modelsJson: false,
        commandDerived: false,
        expired: false,
        unavailable: false,
        effectiveSource: "environment",
      },
    ],
  };

  it("decodes the sanitized credential projection from a status snapshot", () => {
    const decoded = decodeCredentialProjection(projectionFixture);
    expect(decoded).toEqual(projectionFixture);
  });

  it("drops credential-shaped extras and rejects raw credential shapes", () => {
    // Unknown fields on an otherwise valid row are never propagated: the
    // renderer state can not carry a credential value even if the wire did.
    const withExtraKey = decodeCredentialProjection({
      ...projectionFixture,
      providers: [
        {
          ...projectionFixture.providers[0],
          key: "sk-leaked-canary-1",
        } as never,
      ],
    });
    expect(withExtraKey).toBeDefined();
    expect(JSON.stringify(withExtraKey)).not.toContain("sk-leaked-canary-1");
    expect(JSON.stringify(withExtraKey)).not.toContain('"key"');
    // A raw credential shape (missing the bounded facts) is rejected.
    expect(
      decodeCredentialProjection({
        ...projectionFixture,
        providers: [
          {
            providerId: "anthropic",
            stored: true,
            storedType: "api_key",
            key: "sk-leaked-canary-2",
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      decodeCredentialProjection({
        ...projectionFixture,
        providers: [{ providerId: "anthropic", rawCredential: {} }],
      }),
    ).toBeUndefined();
    // An invalid file error must be value-free and consistent.
    expect(
      decodeCredentialProjection({
        revision: 1,
        path: "C:\\auth.json",
        present: true,
        valid: false,
        error: {
          kind: "parse",
          message: "Invalid credential file: expected valid JSON",
        },
        providers: [],
      }),
    ).toMatchObject({ valid: false });
  });

  it("projects the credential facts into the connected renderer state", () => {
    const state = projectControlPlaneState({
      revision: 4,
      connection: "connected",
      applicationVersion: "0.0.0-test",
      contractVersion: 1,
      snapshot: {
        sequence: 3,
        modelDataPlane: "running",
        provider: "configured",
        credentials: projectionFixture,
      },
    } as never);
    if (state.kind !== "connected") {
      throw new Error("expected connected state");
    }
    expect(state.credentialsProjection).toEqual(projectionFixture);
    // The projection never carries secret-shaped fields into renderer state.
    expect(JSON.stringify(state)).not.toContain("sk-");
  });

  it("validates credential command results per command without values", () => {
    const baseState = {
      revision: 2,
      path: "C:\\auth.json",
      present: true,
      valid: true,
      providers: [],
    };
    const login = decodeCredentialCommandResult(
      {
        outcome: "ok",
        revision: 2,
        state: baseState,
        changed: true,
      },
      {
        command: "login",
        providerId: "anthropic",
        expectedRevision: 1,
        value: "sk-x",
        overwrite: true,
      },
    );
    expect(login).toMatchObject({ outcome: "ok", changed: true });
    // A login result can never carry a credential value: unknown fields are
    // dropped by the strict per-command projection.
    const leaked = decodeCredentialCommandResult(
      { outcome: "ok", revision: 2, state: baseState, key: "sk-leaked" },
      {
        command: "login",
        providerId: "anthropic",
        expectedRevision: 1,
        value: "sk-x",
        overwrite: true,
      },
    );
    expect(leaked).toMatchObject({ outcome: "ok" });
    expect(JSON.stringify(leaked)).not.toContain("sk-leaked");

    const preview = decodeCredentialCommandResult(
      {
        outcome: "ok",
        revision: 2,
        state: baseState,
        importId: "import-1",
        previewEntries: [
          { providerId: "anthropic", type: "api_key", wouldOverwrite: true },
        ],
      },
      { command: "import_preview", expectedRevision: 1, content: "{}" },
    );
    expect(preview).toMatchObject({ outcome: "ok", importId: "import-1" });

    const apply = decodeCredentialCommandResult(
      {
        outcome: "conflict",
        revision: 2,
        state: baseState,
        error: "stored credential changed",
        entries: [{ providerId: "anthropic", outcome: "conflict" }],
      },
      {
        command: "import_apply",
        expectedRevision: 1,
        importId: "import-1",
        selections: [{ providerId: "anthropic", overwrite: false }],
      },
    );
    expect(apply).toMatchObject({ outcome: "conflict" });
  });

  it("projects the unavailable credential DTO value-safely", () => {
    const result = decodeCredentialCommandResult(
      {
        outcome: "unavailable",
        revision: 0,
        state: {
          revision: 0,
          path: "",
          present: false,
          valid: false,
          providers: [],
        },
        error: "Credential Authority is unavailable",
      },
      { command: "query" },
    );
    expect(result).toMatchObject({
      outcome: "unavailable",
      revision: 0,
      error: "Credential Authority is unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("accepts an empty Pi-compatible import and skipped declines", () => {
    const baseState = {
      revision: 2,
      path: "C:\auth.json",
      present: true,
      valid: true,
      providers: [],
    };
    const preview = decodeCredentialCommandResult(
      {
        outcome: "ok",
        revision: 2,
        state: baseState,
        importId: "import-empty",
        previewEntries: [],
      },
      { command: "import_preview", expectedRevision: 1, content: "{}" },
    );
    expect(preview).toMatchObject({ outcome: "ok", previewEntries: [] });

    const apply = decodeCredentialCommandResult(
      {
        outcome: "ok",
        revision: 2,
        state: baseState,
        entries: [],
      },
      {
        command: "import_apply",
        expectedRevision: 1,
        importId: "import-empty",
        selections: [],
      },
    );
    expect(apply).toMatchObject({ outcome: "ok", entries: [] });

    const declined = decodeCredentialCommandResult(
      {
        outcome: "ok",
        revision: 2,
        state: baseState,
        entries: [
          { providerId: "anthropic", outcome: "skipped" },
          { providerId: "my-gateway", outcome: "applied" },
        ],
      },
      {
        command: "import_apply",
        expectedRevision: 1,
        importId: "import-empty",
        selections: [
          { providerId: "anthropic", overwrite: false },
          { providerId: "my-gateway", overwrite: false },
        ],
      },
    );
    expect(declined).toMatchObject({ outcome: "ok" });
    expect(declined?.entries?.[0]).toMatchObject({ outcome: "skipped" });
  });
});
