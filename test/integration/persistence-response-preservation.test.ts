import { InMemoryCredentialStore, type FetchFunction } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredLuckyTokenDataPlane } from "../support/configured-data-plane.js";
import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
} from "../../src/runtime-diagnostics/index.js";
import {
  createPersistenceDegradationAuthority,
  createUnavailableDeepCaptureStore,
  observeDiagnosticsStore,
} from "../../src/persistence-degradation/index.js";
import { commandCodeProviderImportModule } from "../support/commandcode-provider-package.js";

/**
 * Ticket 23 fail-open serving proof at the real model HTTP seam: with the
 * diagnostics store fault-injected behind its adapter and the capture store
 * unavailable, an otherwise valid model response is byte/status identical to
 * the control run — no persistence failure ever changes the model response
 * outcome — while the fixed sanitized Critical reaches the bounded ring and
 * stderr and the audit-unavailable state becomes visible.
 */

const CLIENT_TOKEN = "client-token-canary-7788";

function commandCodeText(text: string): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      "",
    ].join("\n"),
    { status: 200 },
  );
}

async function serveFixture(options: {
  readonly faultDiagnostics: boolean;
  readonly captureEnabled: boolean;
  readonly captureUnavailable: boolean;
  readonly onCritical?: (text: string) => void;
}) {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-serve-"));
  const stateDirectory = join(root, ".luckytoken");
  const piDirectory = join(stateDirectory, "pi");
  await mkdir(piDirectory, { recursive: true });
  const configPath = join(stateDirectory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "luckytoken-config-v1",
      server: { port: 0 },
      clientProtocols: {
        "anthropic-messages": {},
      },
      providerPackages: {},
      pi: { directory: "pi" },
      ...(options.captureEnabled
        ? { deepDiagnostics: { enabled: true } }
        : {}),
    }),
    "utf8",
  );
  const config = await loadLuckyTokenCliConfig(configPath);

  // Poison every diagnostics INSERT after open (exactly the serve-level
  // fault-injection posture: behind the store adapter, never at SQL level;
  // the open itself must succeed, including the fingerprint-key INSERT).
  let poisonWrites = false;
  const databaseFactory = {
    open: (path: string) => {
      const inner = new DatabaseSync(path);
      return new Proxy(inner, {
        get(target, property) {
          if (property === "prepare") {
            return (sql: string) => {
              const statement = target.prepare(sql);
              return new Proxy(statement, {
                get(statementTarget, statementProperty) {
                  if (
                    statementProperty === "run" &&
                    /^\s*INSERT\b/i.test(sql)
                  ) {
                    return (...args: unknown[]) => {
                      if (poisonWrites) {
                        throw new Error(
                          "diagnostics write denied canary-112233",
                        );
                      }
                      return statementTarget.run(
                        ...(args as Parameters<typeof statementTarget.run>),
                      );
                    };
                  }
                  const value = Reflect.get(
                    statementTarget,
                    statementProperty,
                    statementTarget,
                  );
                  return typeof value === "function"
                    ? value.bind(statementTarget)
                    : value;
                },
              });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const innerDiagnostics = await createRuntimeDiagnosticsStoreFactory({
    configuration: parseRuntimeDiagnosticsConfiguration(
      { directory: join(stateDirectory, "diagnostics") },
      stateDirectory,
    ),
    now: () => 1_786_400_000_000,
    scrub: (value) => value,
    databaseFactory,
  }).open();
  poisonWrites = options.faultDiagnostics;
  const stderrLines: string[] = [];
  const authority = createPersistenceDegradationAuthority({
    now: () => 1_786_400_000_000,
    stderr: (line) => stderrLines.push(line),
    ...(options.faultDiagnostics ? {} : { diagnosticsStore: innerDiagnostics }),
  });
  const diagnostics = options.faultDiagnostics
    ? observeDiagnosticsStore(innerDiagnostics, authority)
    : innerDiagnostics;
  diagnostics.attachScrub((value) => value);

  const credentials = new InMemoryCredentialStore();
  await credentials.modify("commandcode-private", async () => ({
    type: "api_key",
    key: "provider-secret",
  }));
  const composition = await createConfiguredLuckyTokenDataPlane({
    config,
    credentialSeedStore: credentials,
    createMessageId: () => "msg_fixture",
    fetch: (async () =>
      commandCodeText("serve-preserved answer")) as FetchFunction,
    importModule: commandCodeProviderImportModule(),
    diagnosticsStore: diagnostics,
    now: () => 1_786_400_000_000,
    // An unavailable capture store keeps serving: every capture commit
    // fails and flows through the degradation hooks (never the response).
    ...(options.captureUnavailable
      ? { deepCaptureStore: createUnavailableDeepCaptureStore() }
      : {}),
    ...(options.captureUnavailable
      ? {
          onCapturePersistenceFailure: (failure) => {
            authority.reportFailure("capture", {
              ...(failure.requestId.length === 0
                ? {}
                : { requestId: failure.requestId }),
              code: failure.code,
            });
          },
          onCapturePersistenceRecovery: (fact) => {
            void fact;
            authority.reportRecovery("capture");
          },
        }
      : {}),
  });
  return {
    root,
    composition,
    authority,
    stderrLines,
    async close() {
      composition.requestLedger.close();
      composition.deepCaptureStore.close();
      composition.diagnosticsStore.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function requestBody(): Request {
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "commandcode-private/deepseek/deepseek-v4-flash",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

describe("Persistence failure never changes an otherwise valid model response (Ticket 23)", () => {
  const fixtures: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(
      fixtures.splice(0).map((fixture) => fixture.close()),
    );
  });

  it("a faulted diagnostics store and an unavailable capture store leave the model response byte/status identical", async () => {
    const control = await serveFixture({
      faultDiagnostics: false,
      captureEnabled: true,
      captureUnavailable: false,
    });
    fixtures.push(control);
    const controlResponse = await control.composition.runtime.handle(
      requestBody(),
    );
    const controlStatus = controlResponse.status;
    const controlBytes = await controlResponse.text();
    const controlRequestId = controlResponse.headers.get(
      "x-luckytoken-request-id",
    );
    expect(controlStatus).toBe(200);
    expect(controlBytes).toContain("serve-preserved answer");
    expect(controlRequestId).toBeTruthy();

    const faulted = await serveFixture({
      faultDiagnostics: true,
      captureEnabled: true,
      captureUnavailable: true,
    });
    fixtures.push(faulted);
    const faultedResponse = await faulted.composition.runtime.handle(
      requestBody(),
    );
    expect(faultedResponse.status).toBe(controlStatus);
    expect(await faultedResponse.text()).toBe(controlBytes);
    expect(
      faultedResponse.headers.get("x-luckytoken-request-id"),
    ).toBeTruthy();
    // Let the fire-and-forget capture finalize run so its double-write
    // failure reaches the degradation authority.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A direct diagnostics write fault is also observed (the request path
    // itself never writes the store).
    expect(() =>
      faulted.composition.diagnosticsStore.append({
        level: "info",
        text: "post-request write",
      }),
    ).toThrow();

    // The persistence failures became visible only through the degraded
    // state, never through the response: fixed sanitized Criticals on
    // stderr and in the bounded ring, no fault text anywhere.
    expect(faulted.authority.state().auditUnavailable).toBe(true);
    expect(
      new Set(
        faulted.authority.state().authorities.map((entry) => entry.authority),
      ),
    ).toEqual(new Set(["diagnostics", "capture"]));
    const ringText = faulted.authority
      .ring()
      .map((record) => record.text)
      .join(" ");
    expect(ringText).toContain("audit guarantee unavailable");
    expect(ringText).not.toContain("canary-112233");
    expect(ringText).not.toContain("write denied");
    const stderr = faulted.stderrLines.join("");
    expect(stderr).toContain("LuckyToken Critical:");
    expect(stderr).not.toContain("canary-112233");
    // The healthy control run shows no degradation.
    expect(control.authority.state().auditUnavailable).toBe(false);
  });

  it("a diagnostics write fault is fail-open: the request completes and the next successful write demonstrates recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-recover-"));
    const stateDirectory = join(root, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
        },
        providerPackages: {},
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const config = await loadLuckyTokenCliConfig(configPath);
    const inner = await createRuntimeDiagnosticsStoreFactory({
      configuration: parseRuntimeDiagnosticsConfiguration(
        { directory: join(stateDirectory, "diagnostics") },
        stateDirectory,
      ),
      now: () => 1_786_400_000_000,
      scrub: (value) => value,
    }).open();
    const authority = createPersistenceDegradationAuthority({
      now: () => 1_786_400_000_000,
      stderr: () => undefined,
      diagnosticsStore: inner,
    });
    let faulted = false;
    const faulting: typeof inner = {
      ...inner,
      append(draft) {
        if (faulted) throw new Error("diag fault canary-998866");
        return inner.append(draft);
      },
    };
    const observed = observeDiagnosticsStore(faulting, authority);
    observed.attachScrub((value) => value);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const composition = await createConfiguredLuckyTokenDataPlane({
      config,
      credentialSeedStore: credentials,
      createMessageId: () => "msg_fixture",
      fetch: (async () =>
        commandCodeText("recovery answer")) as FetchFunction,
      importModule: commandCodeProviderImportModule(),
      diagnosticsStore: observed,
      now: () => 1_786_400_000_000,
    });
    try {
      const baseline = await composition.runtime.handle(requestBody());
      expect(baseline.status).toBe(200);
      expect(await baseline.text()).toContain("recovery answer");
      faulted = true;
      expect(() =>
        observed.append({ level: "info", text: "faulted write" }),
      ).toThrow();
      // The degraded state never changes an otherwise valid response.
      expect(authority.state().auditUnavailable).toBe(true);
      const degraded = await composition.runtime.handle(requestBody());
      expect(degraded.status).toBe(200);
      expect(await degraded.text()).toContain("recovery answer");
      faulted = false;
      // The next successful diagnostics write demonstrates recovery.
      observed.append({ level: "info", text: "recovered" });
      expect(authority.state().auditUnavailable).toBe(false);
    } finally {
      composition.requestLedger.close();
      composition.deepCaptureStore.close();
      composition.diagnosticsStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
