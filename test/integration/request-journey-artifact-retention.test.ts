import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
} from "../../src/diagnostics/index.js";

const roots: string[] = [];

async function createFixture(options: {
  readonly artifactRetentionAgeMs: number;
  readonly maxArtifactJourneys: number;
}) {
  const root = await mkdtemp(join(tmpdir(), "Token-artifact-retention-"));
  roots.push(root);
  let now = 1_000;
  const authority = await createDiagnosticsAuthority({
    configuration: parseDiagnosticsConfiguration(
      {
        directory: join(root, "diagnostics"),
        artifactRetentionAgeMs: options.artifactRetentionAgeMs,
        maxArtifactJourneys: options.maxArtifactJourneys,
      },
      root,
    ),
    runtimeId: "artifact-retention-runtime",
    now: () => now,
    journeyCapturePolicy: {
      snapshot: () => ({
        allRequestsEnabled: true,
        failedRequestsEnabled: true,
      }),
    },
  });
  const writeJourney = async (
    requestId: string,
    acceptedAt: number,
    marker: string,
  ): Promise<void> => {
    now = acceptedAt;
    const observer = authority.begin({
      requestId,
      operationCandidate: "model_generation",
      transport: "in_process",
      method: "POST",
      path: "/retention",
      acceptedAt,
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    observer.observe({
      kind: "artifact_observed",
      artifactId: "client_request_wire",
      artifactKind: "client_request_wire",
      state: "captured",
      mediaType: "application/json",
      redaction: "not_required",
      truncated: false,
      bytes: Buffer.from(JSON.stringify({ marker })),
      location: {
        phase: "protocol_ingress",
        step: "capture_client_request_wire",
      },
    });
    observer.close({
      outcome: "success",
      lastKnownLocation: {
        phase: "outcome_commit",
        step: "commit_success",
      },
    });
    await expect
      .poll(async () =>
        (await authority.queryRequestJourneys({ limit: 100 })).records.some(
          (record) => record.requestId === requestId && record.outcome === "success",
        ),
      )
      .toBe(true);
  };
  return { authority, writeJourney };
}

async function expectExpired(
  authority: DiagnosticsAuthority,
  requestId: string,
): Promise<void> {
  const detail = await authority.getRequestJourney({ requestId });
  expect(detail.artifacts).toContainEqual(
    expect.objectContaining({
      artifactId: "client_request_wire",
      state: "unavailable",
      reason: "expired",
    }),
  );
  await expect(
    authority.getRequestArtifact({
      requestId,
      artifactId: "client_request_wire",
      offset: 0,
      limit: 1_024,
    }),
  ).rejects.toThrow("Request artifact body is unavailable");
}

describe("Request Journey artifact retention", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("expires artifact bodies by age while preserving truthful descriptors", async () => {
    const fixture = await createFixture({
      artifactRetentionAgeMs: 100,
      maxArtifactJourneys: 10,
    });
    try {
      await fixture.writeJourney(
        "retention-age-00000000-0000-4000-8000-000000000001",
        1_000,
        "first",
      );
      await fixture.writeJourney(
        "retention-age-00000000-0000-4000-8000-000000000002",
        1_101,
        "second",
      );
      await expectExpired(
        fixture.authority,
        "retention-age-00000000-0000-4000-8000-000000000001",
      );
    } finally {
      await fixture.authority.close();
    }
  });

  it("retains bodies for only the newest configured number of Journeys", async () => {
    const fixture = await createFixture({
      artifactRetentionAgeMs: 604_800_000,
      maxArtifactJourneys: 1,
    });
    try {
      await fixture.writeJourney(
        "retention-count-0000000-0000-4000-8000-000000000001",
        2_000,
        "first",
      );
      await fixture.writeJourney(
        "retention-count-0000000-0000-4000-8000-000000000002",
        2_001,
        "second",
      );
      await expectExpired(
        fixture.authority,
        "retention-count-0000000-0000-4000-8000-000000000001",
      );
      const latest = await fixture.authority.getRequestArtifact({
        requestId: "retention-count-0000000-0000-4000-8000-000000000002",
        artifactId: "client_request_wire",
        offset: 0,
        limit: 1_024,
      });
      expect(
        JSON.parse(Buffer.from(latest.dataBase64, "base64").toString("utf8")),
      ).toEqual({ marker: "second" });
    } finally {
      await fixture.authority.close();
    }
  });
});
