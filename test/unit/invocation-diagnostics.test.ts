import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseFailureLoggingConfiguration } from "../../src/invocation-diagnostics/configuration.js";
import { createInvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";

async function jsonFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true });
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => join(root, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("invocation diagnostics public interface", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(overrides: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-diagnostics-"));
    roots.push(root);
    const configuration = parseFailureLoggingConfiguration(
      { directory: "journals", ...overrides },
      root,
    );
    return { root, configuration };
  }

  it("destroys successful state without writing a journal", async () => {
    const { configuration } = await fixture();
    const invocation = createInvocationDiagnosticsFactory({ configuration }).begin("anthropic-messages");
    invocation.notice({ adapter: "anthropic-messages", direction: "request", code: "repair", action: "xrepair" });
    await invocation.succeed();
    await invocation.fail({ classification: "late-failure", clientStatus: 500 });
    expect(await jsonFiles(configuration.directory)).toEqual([]);
  });

  it("writes exactly one bounded safe journal with no caller-controlled filename", async () => {
    const { configuration } = await fixture({ maxFileBytes: 1_024 });
    const requestId = "00000000-0000-4000-8000-000000000001";
    const invocation = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => requestId,
      now: () => Date.UTC(2026, 7, 13),
    }).begin("openai-responses");
    invocation.checkpoint({ stage: "pi-execution", selector: "commandcode-private/model/with/slashes" });
    for (let index = 0; index < 200; index += 1) {
      invocation.notice({
        adapter: "openai-responses",
        direction: "request",
        code: `ignore_${index}`,
        jsonPath: `$.input[${index}]`,
        action: "ignore",
      });
    }
    await invocation.fail({
      classification: "upstream-http",
      clientStatus: 502,
      safeIds: { request_id: "req-safe" },
      measurements: { bodyLength: 999, truncated: true },
      error: new Error("prompt text MUST_NOT_APPEAR and Bearer top-secret-token"),
    });
    await invocation.fail({ classification: "second", clientStatus: 500 });

    const files = await jsonFiles(configuration.directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`${requestId}\\.json$`, "u"));
    expect((await stat(files[0]!)).size).toBeLessThanOrEqual(1_024);
    const text = await readFile(files[0]!, "utf8");
    expect(text).not.toContain("MUST_NOT_APPEAR");
    expect(text).not.toContain("top-secret-token");
    expect(JSON.parse(text)).toMatchObject({
      requestId,
      clientProtocol: "openai-responses",
      selector: "commandcode-private/model/with/slashes",
      stage: "pi-execution",
      classification: "upstream-http",
      clientStatus: 502,
      truncation: { truncated: true },
    });
  });

  it("keeps concurrent and sequential invocation facts isolated", async () => {
    const { configuration } = await fixture();
    const ids = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000013",
    ];
    const factory = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => ids.shift()!,
    });
    const first = factory.begin("anthropic-messages");
    const second = factory.begin("openai-responses");
    first.notice({ adapter: "anthropic-messages", direction: "response", code: "anthropic_only", action: "degrade" });
    second.notice({ adapter: "openai-responses", direction: "request", code: "responses_only", action: "xrepair" });
    first.attempt({ attempt: 1, classification: "transport", stage: "fetch" });
    second.attempt({ attempt: 7, classification: "timeout", stage: "read" });
    await Promise.all([
      first.fail({ classification: "first", clientStatus: 502 }),
      second.fail({ classification: "second", clientStatus: 504 }),
    ]);
    const third = factory.begin("anthropic-messages");
    await third.fail({ classification: "third", clientStatus: 500 });

    const journals = await Promise.all((await jsonFiles(configuration.directory)).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    const byClassification = Object.fromEntries(journals.map((journal) => [journal.classification, journal]));
    expect(byClassification.first.notices).toEqual([expect.objectContaining({ code: "anthropic_only" })]);
    expect(byClassification.first.attempts).toEqual([expect.objectContaining({ attempt: 1 })]);
    expect(JSON.stringify(byClassification.first)).not.toContain("responses_only");
    expect(byClassification.second.notices).toEqual([expect.objectContaining({ code: "responses_only" })]);
    expect(byClassification.third.notices).toEqual([]);
    expect(byClassification.third.attempts).toEqual([]);
  });

  it("permanently redacts credentials, cookies, and binary data in full mode", async () => {
    const warnings: string[] = [];
    const { configuration } = await fixture({ detail: "full" });
    const invocation = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => "00000000-0000-4000-8000-000000000021",
      stderr: (message) => warnings.push(message),
    }).begin("openai-responses");
    await invocation.fail({
      classification: "full",
      clientStatus: 500,
      fullSnapshot: {
        prompt: "full prompt may be retained",
        authorization: "Bearer secret",
        cookie: "session=secret",
        image_data: "base64-secret",
        nested: { apiKey: "key-secret", file_bytes: [1, 2, 3] },
      },
    });
    const text = await readFile((await jsonFiles(configuration.directory))[0]!, "utf8");
    expect(text).toContain("full prompt may be retained");
    for (const secret of ["Bearer secret", "session=secret", "base64-secret", "key-secret"]) {
      expect(text).not.toContain(secret);
    }
    expect(warnings).toEqual([expect.stringContaining("detail=full")]);
  });

  it("enforces cancellation and retention policies", async () => {
    const { configuration } = await fixture({ logCancellation: false, maxFiles: 1, retentionDays: 1 });
    const ids = [
      "00000000-0000-4000-8000-000000000031",
      "00000000-0000-4000-8000-000000000032",
      "00000000-0000-4000-8000-000000000033",
    ];
    const factory = createInvocationDiagnosticsFactory({ configuration, createRequestId: () => ids.shift()! });
    await factory.begin("anthropic-messages").fail({ classification: "cancel", cancellation: true });
    expect(await jsonFiles(configuration.directory)).toEqual([]);

    await factory.begin("anthropic-messages").fail({ classification: "old", clientStatus: 500 });
    const oldFile = (await jsonFiles(configuration.directory))[0]!;
    const oldTime = new Date(Date.now() - 3 * 86_400_000);
    await utimes(oldFile, oldTime, oldTime);
    await factory.begin("anthropic-messages").fail({ classification: "new", clientStatus: 500 });
    const files = await jsonFiles(configuration.directory);
    expect(files).toHaveLength(1);
    expect(await readFile(files[0]!, "utf8")).toContain('"classification": "new"');
  });

  it("reports journal write failure without replacing the original failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-diagnostics-"));
    roots.push(root);
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory", "utf8");
    const configuration = parseFailureLoggingConfiguration({ directory: blocked }, root);
    const errors: string[] = [];
    const invocation = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => "00000000-0000-4000-8000-000000000041",
      stderr: (message) => errors.push(message),
    }).begin("anthropic-messages");
    await expect(invocation.fail({ classification: "original", clientStatus: 500 })).resolves.toBeUndefined();
    expect(errors).toEqual([expect.stringContaining("journal write failed")]);
  });

  it("validates notice, attempt, and measurement facts at the public interface", async () => {
    const { configuration } = await fixture();
    const invocation = createInvocationDiagnosticsFactory({ configuration }).begin("anthropic-messages");
    expect(() => invocation.notice({
      adapter: "anthropic-messages", direction: "future" as never,
      code: "bad", action: "ignore",
    })).toThrow("notice.direction");
    expect(() => invocation.notice({
      adapter: "anthropic-messages", direction: "request",
      code: "bad", action: "invent" as never,
    })).toThrow("notice.action");
    expect(() => invocation.attempt({
      attempt: 1, classification: "transport", stage: "fetch",
      retryable: "yes" as never,
    })).toThrow("attempt.retryable");
    await expect(invocation.fail({
      classification: "invalid-measurement",
      measurements: { count: Number.NaN },
    })).rejects.toThrow("measurement count");
    expect(await jsonFiles(configuration.directory)).toEqual([]);
  });

  it("is created at each configured Client Protocol ingress", async () => {
    const { root, configuration } = await fixture();
    const ids = [
      "00000000-0000-4000-8000-000000000051",
      "00000000-0000-4000-8000-000000000052",
    ];
    const invocationDiagnostics = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => ids.shift()!,
    });
    const anthropic = createAnthropicMessagesHandler({
      models: {} as never,
      invocationDiagnostics,
      maxRequestBytes: 1_024,
    });
    const responses = createOpenAIResponsesHandler({
      models: {} as never,
      invocationDiagnostics,
      stateFile: join(root, "responses-state.json"),
      maxRequestBytes: 1_024,
    });
    const request = (url: string) => new Request(url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const [anthropicResponse, responsesResponse] = await Promise.all([
      anthropic.handle(request("http://localhost/v1/messages")),
      responses.handle(request("http://localhost/v1/responses")),
    ]);
    expect(anthropicResponse.status).toBe(415);
    expect(responsesResponse.status).toBe(415);
    const journals = await Promise.all((await jsonFiles(configuration.directory)).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    expect(journals.map((journal) => journal.clientProtocol).sort()).toEqual([
      "anthropic-messages",
      "openai-responses",
    ]);
    expect(journals.every((journal) => journal.stage === "client-validation")).toBe(true);
  });
});
