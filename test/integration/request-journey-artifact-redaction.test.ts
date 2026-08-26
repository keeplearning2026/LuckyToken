import type { FetchFunction } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type RequestArtifactDescriptor,
} from "../../src/diagnostics/index.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

const REQUEST_ID = "40000000-0000-4000-8000-000000000001";
const SAFE_MODEL = "missing-redaction-model";
const SAFE_MARKER = "safe-investigation-marker-7b2e";
const REDACTED = "[REDACTED]";

const AUTHORIZATION_CANARY = "header-authorization-canary-6a41f0";
const API_KEY_HEADER_CANARY = "header-api-key-canary-18b29d";
const COOKIE_CANARY = "header-cookie-canary-724ac9";
const PASSWORD_CANARY = "body-password-canary-d34e72";
const ACCESS_TOKEN_CANARY = "body-access-token-canary-92af51";
const API_KEY_BODY_CANARY = "body-api-key-canary-c56d03";
const PROVIDER_CANARY = "provider-credential-canary-88bd14";

const ALL_CANARIES = [
  AUTHORIZATION_CANARY,
  API_KEY_HEADER_CANARY,
  COOKIE_CANARY,
  PASSWORD_CANARY,
  ACCESS_TOKEN_CANARY,
  API_KEY_BODY_CANARY,
  PROVIDER_CANARY,
] as const;

interface PersistedArtifactRow {
  readonly artifactId: string;
  readonly descriptorJson: string;
  readonly bodyPath: string | null;
}

async function readDiagnosticsFiles(
  directory: string,
): Promise<ReadonlyMap<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const visit = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryRelative = join(relative, entry.name);
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath, entryRelative);
        continue;
      }
    try {
        files.set(entryRelative, await readFile(entryPath));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    }
  };
  await visit(directory, "");
  return files;
}

function combinedBytes(files: ReadonlyMap<string, Buffer>): Buffer {
  return Buffer.concat([...files.values()]);
}

function expectPhysicalRedaction(
  files: ReadonlyMap<string, Buffer>,
  phase: "running" | "closed",
): void {
  expect.soft([...files.keys()], `${phase}: diagnostics files`).toContain(
    "diagnostics-v3.sqlite3",
  );
  const bytes = combinedBytes(files);
  expect.soft(bytes.includes(Buffer.from(SAFE_MARKER)), `${phase}: safe marker`).toBe(
    true,
  );
  expect.soft(bytes.includes(Buffer.from(REDACTED)), `${phase}: redaction marker`).toBe(
    true,
  );
  for (const canary of ALL_CANARIES) {
    expect
      .soft(bytes.includes(Buffer.from(canary)), `${phase}: leaked ${canary}`)
      .toBe(false);
  }
}

function artifact(
  artifacts: readonly RequestArtifactDescriptor[],
  artifactId: string,
): RequestArtifactDescriptor {
  const result = artifacts.find((entry) => entry.artifactId === artifactId);
  expect(result, `${artifactId} descriptor`).toBeDefined();
  return result!;
}

describe("Request Journey failure artifact redaction", () => {
  it("persists useful failed request evidence without writing credential canaries to the index or artifact files", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-artifact-redaction-"));
    const diagnosticsDirectory = join(root, "diagnostics");
    const databasePath = join(diagnosticsDirectory, "diagnostics-v3.sqlite3");
    let authority: DiagnosticsAuthority | undefined;
    let server: RunningTokenHttpServer | undefined;
    let providerCalls = 0;

    try {
      const configuration = parseDiagnosticsConfiguration(
        { directory: diagnosticsDirectory },
        root,
      );
      authority = await createDiagnosticsAuthority({
        configuration,
        runtimeId: "artifact-redaction-runtime",
        now: () => 1_787_472_000_000,
      });
      const providerFetch: FetchFunction = async () => {
        providerCalls += 1;
        return new Response(null, { status: 500 });
      };
      const runtime = createCommandCodeTestRuntime({
        clientApiKey: AUTHORIZATION_CANARY,
        commandCodeApiKey: PROVIDER_CANARY,
        commandCodeBaseUrl: "https://fixture.commandcode.test",
        fetch: providerFetch,
        modelId: "claude-fixture",
        createMessageId: () => "msg_artifact_redaction",
        createSessionId: () => "40000000-0000-4000-8000-000000000002",
        now: () => 1_787_472_000_000,
      });
      server = await startTokenHttpServer({
        runtime,
        diagnostics: authority,
        createRequestId: () => REQUEST_ID,
        port: 0,
      });

      const requestBody = JSON.stringify({
        model: SAFE_MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: SAFE_MARKER }],
        password: PASSWORD_CANARY,
        access_token: ACCESS_TOKEN_CANARY,
        api_key: API_KEY_BODY_CANARY,
      });
      const response = await fetch(`${server.origin}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${AUTHORIZATION_CANARY}`,
          "x-api-key": API_KEY_HEADER_CANARY,
          cookie: `session=${COOKIE_CANARY}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: requestBody,
      });
      const responseBytes = Buffer.from(await response.arrayBuffer());
      const responseJson = JSON.parse(responseBytes.toString("utf8")) as {
        readonly type: string;
        readonly error: Readonly<{ type: string; message: string }>;
        readonly request_id: string;
      };

      expect(response.status).toBe(404);
      expect(response.headers.get("x-token-request-id")).toBe(REQUEST_ID);
      expect(responseJson).toMatchObject({
        type: "error",
        error: {
          type: "not_found_error",
          message: `Unknown model selector: ${SAFE_MODEL}`,
        },
        request_id: REQUEST_ID,
      });
      expect(providerCalls).toBe(0);

      await expect
        .poll(async () => {
          const page = await authority!.queryRequestJourneys({ limit: 10 });
          return page.records.find((record) => record.requestId === REQUEST_ID)
            ?.outcome;
        })
        .toBe("failed");
      const journey = await authority.getRequestJourney({
        requestId: REQUEST_ID,
      });
      expect(journey).toMatchObject({
        requestId: REQUEST_ID,
        operation: "model_generation",
        protocol: "anthropic-messages",
        outcome: "failed",
        admission: {
          transport: "http",
          method: "POST",
          path: "/v1/messages",
        },
        handoffOutcome: { outcome: "finished", transport: "http" },
      });
      expect(journey.lane).toBeUndefined();
      expect(journey.artifacts).toHaveLength(4);
      expect(journey.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifactId: "client_request_envelope",
          state: "captured",
          redaction: "not_required",
        }),
        expect.objectContaining({
          artifactId: "client_response_envelope",
          state: "captured",
          redaction: "not_required",
        }),
      ]));
      const requestDescriptor = artifact(
        journey.artifacts,
        "client_request_wire",
      );
      const responseDescriptor = artifact(
        journey.artifacts,
        "client_response_wire",
      );
      expect.soft(requestDescriptor).toMatchObject({
        artifactKind: "client_request_wire",
        state: "captured",
        mediaType: "application/json",
        redaction: "applied",
        truncated: false,
        originalBytes: Buffer.byteLength(requestBody),
      });
      expect.soft(requestDescriptor.capturedBytes).toBeGreaterThan(0);
      expect.soft(responseDescriptor).toMatchObject({
        artifactKind: "client_response_wire",
        state: "captured",
        mediaType: "application/json",
        redaction: "not_required",
        truncated: false,
        originalBytes: responseBytes.byteLength,
        capturedBytes: Buffer.byteLength(
          JSON.stringify(JSON.parse(responseBytes.toString("utf8")), null, 2),
        ),
      });

      // No more HTTP work may enter the diagnostics queue. The completed
      // Journey query above is the Worker commit barrier for every artifact.
      await server.close();
      server = undefined;
      const runningFiles = await readDiagnosticsFiles(diagnosticsDirectory);
      expectPhysicalRedaction(runningFiles, "running");

      await authority.close();
      authority = undefined;

      const database = new DatabaseSync(databasePath, { readOnly: true });
      let rows: PersistedArtifactRow[];
      try {
        rows = database
          .prepare(
            `SELECT artifact_id AS artifactId,
                    descriptor_json AS descriptorJson,
                    body_path AS bodyPath
             FROM request_journey_artifacts
             WHERE request_id = ?
             ORDER BY artifact_id`,
          )
          .all(REQUEST_ID) as unknown as PersistedArtifactRow[];
      } finally {
        database.close();
      }
      expect(rows).toHaveLength(4);
      const requestRow = rows.find(
        (row) => row.artifactId === "client_request_wire",
      );
      const responseRow = rows.find(
        (row) => row.artifactId === "client_response_wire",
      );
      expect(requestRow?.bodyPath).not.toBeNull();
      expect(responseRow?.bodyPath).not.toBeNull();

      const storedRequest = JSON.parse(
        await readFile(join(diagnosticsDirectory, requestRow!.bodyPath!), "utf8"),
      ) as Record<string, unknown>;
      expect.soft(storedRequest).toMatchObject({
        model: SAFE_MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: SAFE_MARKER }],
        password: REDACTED,
        access_token: REDACTED,
        api_key: REDACTED,
      });
      const storedRequestDescriptor = JSON.parse(
        requestRow!.descriptorJson,
      ) as RequestArtifactDescriptor;
      expect.soft(storedRequestDescriptor.redaction).toBe("applied");

      const storedResponse = JSON.parse(
        await readFile(join(diagnosticsDirectory, responseRow!.bodyPath!), "utf8"),
      ) as {
        readonly type: string;
        readonly error: Readonly<{ type: string; message: string }>;
        readonly request_id: string;
      };
      expect(storedResponse).toMatchObject({
        type: "error",
        error: {
          type: "not_found_error",
          message: `Unknown model selector: ${SAFE_MODEL}`,
        },
        request_id: REQUEST_ID,
      });

      const closedFiles = await readDiagnosticsFiles(diagnosticsDirectory);
      expectPhysicalRedaction(closedFiles, "closed");
    } finally {
      await Promise.allSettled([
        server?.close() ?? Promise.resolve(),
        authority?.close() ?? Promise.resolve(),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
