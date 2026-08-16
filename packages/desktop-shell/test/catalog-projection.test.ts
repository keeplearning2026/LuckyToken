import { describe, expect, it } from "vitest";

import type { CatalogStatusProjection } from "@luckytoken/application-control-plane/control-plane";

import {
  decodeCatalogCommandResult,
  decodeCatalogStatusProjection,
} from "../src/control-plane-projection.js";

/**
 * Ticket 11 renderer seam: the sanitized catalog status projection and the
 * versioned catalog command results crossing the native bridge are decoded
 * strictly; malformed or credential-shaped payloads never reach the UI.
 */

const statusFixture: CatalogStatusProjection = {
  version: 3,
  refreshing: false,
  refreshedAt: 1_700_000_000_000,
  failedProviderIds: ["dynamic-a"],
};

describe("catalog projection decode", () => {
  it("decodes the sanitized catalog status projection", () => {
    const decoded = decodeCatalogStatusProjection(statusFixture);
    expect(decoded).toEqual(statusFixture);
  });

  it("rejects a catalog status projection without a monotonic version", () => {
    expect(
      decodeCatalogStatusProjection({ ...statusFixture, version: -1 }),
    ).toBeUndefined();
    expect(
      decodeCatalogStatusProjection({ ...statusFixture, version: 1.5 }),
    ).toBeUndefined();
  });

  it("rejects a status projection whose failed ids are not strings", () => {
    expect(
      decodeCatalogStatusProjection({
        ...statusFixture,
        failedProviderIds: [42],
      }),
    ).toBeUndefined();
  });

  it("decodes a manual refresh command result with per-Provider results", () => {
    const decoded = decodeCatalogCommandResult({
      outcome: "ok",
      snapshot: {
        version: 4,
        modelsJsonValid: true,
        refreshedAt: 1_700_000_000_000,
        providers: [
          {
            providerId: "dynamic-a",
            name: "dynamic-a",
            dynamic: true,
            state: "failed",
            error: 'Model catalog refresh failed for provider "dynamic-a"',
            errorCode: "model_source",
            models: [
              { id: "cached-model", dynamic: true, availability: "available" },
            ],
          },
          {
            providerId: "openai",
            name: "OpenAI",
            dynamic: false,
            state: "known",
            models: [
              { id: "gpt-4", dynamic: false, availability: "unavailable" },
            ],
          },
        ],
        refreshErrors: [
          {
            providerId: "dynamic-a",
            code: "model_source",
            message: 'Model catalog refresh failed for provider "dynamic-a"',
          },
        ],
      },
      refresh: {
        trigger: "manual",
        startedAt: 1_699_999_000_000,
        finishedAt: 1_700_000_000_000,
        providers: [
          { providerId: "dynamic-a", outcome: "failed", errorCode: "model_source" },
        ],
      },
    });
    expect(decoded?.outcome).toBe("ok");
    expect(decoded?.refresh?.providers[0]?.outcome).toBe("failed");
    expect(decoded?.snapshot.providers[0]?.state).toBe("failed");
  });

  it("rejects a failed Provider that carries no value-safe error", () => {
    expect(
      decodeCatalogCommandResult({
        outcome: "ok",
        snapshot: {
          version: 1,
          modelsJsonValid: true,
          providers: [
            {
              providerId: "dynamic-a",
              name: "dynamic-a",
              dynamic: true,
              state: "failed",
              models: [],
            },
          ],
          refreshErrors: [],
        },
      }),
    ).toBeUndefined();
  });

  it("rejects a manual-only report on a non-ok outcome", () => {
    expect(
      decodeCatalogCommandResult({
        outcome: "scheduled",
        snapshot: { version: 1, modelsJsonValid: true, providers: [], refreshErrors: [] },
        refresh: { trigger: "manual", startedAt: 1, finishedAt: 2, providers: [] },
      }),
    ).toBeUndefined();
  });

  it("rejects an invalid models.json snapshot without its file error", () => {
    expect(
      decodeCatalogCommandResult({
        outcome: "ok",
        snapshot: {
          version: 1,
          modelsJsonValid: false,
          providers: [],
          refreshErrors: [],
        },
      }),
    ).toBeUndefined();
  });

  it("passes through only shape-valid value-safe failure summaries", () => {
    // Value-safety is enforced by the backend producer (fixed templates,
    // safe codes); the renderer enforces the shape and never renders
    // anything the bridge did not validate.
    const decoded = decodeCatalogCommandResult({
      outcome: "ok",
      snapshot: {
        version: 1,
        modelsJsonValid: true,
        providers: [
          {
            providerId: "dynamic-a",
            name: "dynamic-a",
            dynamic: true,
            state: "failed",
            error: 'Model catalog refresh failed for provider "dynamic-a"',
            errorCode: "model_source",
            models: [],
          },
        ],
        refreshErrors: [],
      },
    });
    expect(decoded?.snapshot.providers[0]?.state).toBe("failed");
    expect(decoded?.snapshot.providers[0]?.errorCode).toBe("model_source");
  });
});
