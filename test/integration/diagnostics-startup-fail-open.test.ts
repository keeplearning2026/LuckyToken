import { readFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type DiagnosticsUnavailableError,
} from "../../src/diagnostics/index.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

const REQUEST_ID = "30000000-0000-4000-8000-000000000001";

function commandCodeSuccess(): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text: "still served" }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      }),
      "",
    ].join("\n"),
  );
}

function createRuntime() {
  return createCommandCodeTestRuntime({
    clientApiKey: "fixture-client-key",
    commandCodeApiKey: "fixture-provider-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch: async () => commandCodeSuccess(),
    modelId: "claude-fixture",
    createMessageId: () => "msg_diagnostics_fail_open",
    createSessionId: () => "30000000-0000-4000-8000-000000000002",
    now: () => 1_787_558_400_000,
  });
}

async function invoke(server: RunningLuckyTokenHttpServer): Promise<{
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}> {
  const response = await fetch(`${server.origin}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-client-key",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-fixture",
      max_tokens: 32,
      messages: [{ role: "user", content: "diagnostics must fail open" }],
    }),
  });
  const headers = new Headers(response.headers);
  headers.delete("date");
  return {
    status: response.status,
    headers: Object.freeze(
      Array.from(headers.entries(), ([name, value]) =>
        Object.freeze([name, value] as const),
      ),
    ),
    body: await response.text(),
  };
}

describe("Diagnostics startup fail-open", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const servers: RunningLuckyTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("leaves diagnostics v1 unread and untouched while creating diagnostics v2", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-diagnostics-v2-"));
    roots.push(root);
    const v1Path = join(root, "diagnostics.sqlite3");
    const v1Bytes = Buffer.from("legacy diagnostics v1 must remain untouched");
    await writeFile(v1Path, v1Bytes);
    const v1Mtime = (await stat(v1Path)).mtimeMs;

    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);
    await expect(authority.queryRequestJourneys({ limit: 10 })).resolves.toEqual({
      records: [],
      hasMore: false,
    });
    await authority.close();
    authorities.splice(authorities.indexOf(authority), 1);

    expect(await readFile(v1Path)).toEqual(v1Bytes);
    expect((await stat(v1Path)).mtimeMs).toBe(v1Mtime);
    const v2 = new DatabaseSync(join(root, "diagnostics-v2.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(
        v2.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(),
      ).toEqual({ value: 2 });
      const usageColumns = v2
        .prepare("PRAGMA table_info(request_journeys)")
        .all()
        .map((column) => (column as { name: string }).name)
        .filter((name) => name.startsWith("usage_"));
      expect(usageColumns).toEqual([
        "usage_terminal_class",
        "usage_input",
        "usage_cache_read",
        "usage_output",
      ]);
    } finally {
      v2.close();
    }
  });

  it("preserves the Data Plane and reports typed unavailability without mutating incompatible storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-diagnostics-fail-open-"));
    roots.push(root);
    const databasePath = join(root, "diagnostics-v2.sqlite3");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_name', 'foreign_diagnostics');
      INSERT INTO meta (key, value) VALUES ('schema_version', 99);
      CREATE TABLE foreign_records (value TEXT NOT NULL);
      INSERT INTO foreign_records (value) VALUES ('must remain untouched');
    `);
    database.close();
    const bytesBefore = await readFile(databasePath);
    const mtimeBefore = (await stat(databasePath)).mtimeMs;

    const configuration = parseDiagnosticsConfiguration(
      { directory: root },
      root,
    );
    const authority = await createDiagnosticsAuthority({ configuration });
    authorities.push(authority);

    const observer = authority.begin({
      requestId: "30000000-0000-4000-8000-000000000003",
      operationCandidate: "pending",
      transport: "in_process",
      method: "POST",
      path: "/v1/messages",
      acceptedAt: 1_787_558_400_000,
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    expect(() =>
      observer.observe({
        kind: "step_entered",
        stepInstanceId: "fail-open-probe",
        location: { phase: "http_admission", step: "fail_open_probe" },
      }),
    ).not.toThrow();
    expect(() => observer.close({ outcome: "success" })).not.toThrow();

    const baseline = await startLuckyTokenHttpServer({
      runtime: createRuntime(),
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(baseline);
    const degraded = await startLuckyTokenHttpServer({
      runtime: createRuntime(),
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(degraded);

    const baselineResponse = await invoke(baseline);
    const degradedResponse = await invoke(degraded);
    expect(degradedResponse).toEqual(baselineResponse);
    expect(degradedResponse.status).toBe(200);
    expect(JSON.parse(degradedResponse.body)).toMatchObject({
      id: "msg_diagnostics_fail_open",
      content: [{ type: "text", text: "still served" }],
    });

    let queryFailure: unknown;
    try {
      await authority.queryRequestJourneys({ limit: 10 });
    } catch (error) {
      queryFailure = error;
    }
    expect(queryFailure).toBeInstanceOf(Error);
    const unavailable = queryFailure as DiagnosticsUnavailableError;
    expect(unavailable.name).toBe("DiagnosticsUnavailableError");
    expect(unavailable.code).toBe("diagnostics_unavailable");

    await authority.close();
    authorities.splice(authorities.indexOf(authority), 1);
    expect(await readFile(databasePath)).toEqual(bytesBefore);
    expect((await stat(databasePath)).mtimeMs).toBe(mtimeBefore);
  });
});
