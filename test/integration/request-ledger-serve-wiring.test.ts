import { InMemoryCredentialStore, type FetchFunction } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { createConfiguredLuckyTokenComposition } from "../../src/composition.js";
import {
  createRequestLedgerStoreFactory,
  parseRequestLedgerConfiguration,
} from "../../src/request-ledger/index.js";
import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
} from "../../src/runtime-diagnostics/index.js";
import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";
import { commandCodeProviderImportModule } from "../support/commandcode-provider-package.js";

/**
 * Ticket 18 repair: the real `serve` wiring must report ledger persistence
 * faults through the same narrow sanitized diagnostics seam as the
 * composition-created store. This drives the production composition with a
 * serve-owned (injected) ledger store whose onPersistenceFailure callback is
 * wired exactly as src/cli.ts wires it, and proves exactly one sanitized
 * Critical record per request with no fault/credential canary, while the
 * model response stays untouched.
 */

const CLIENT_TOKEN = "client-token-canary-7788";
const FAULT_CANARY = "canary-fault-secret-998877";

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

describe("Request Ledger serve-level persistence-failure wiring (Ticket 18)", () => {
  const directories: string[] = [];
  const stores: Array<{ close(): void }> = [];

  afterEach(async () => {
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("reports one sanitized Critical per request from the serve-owned store without changing the model response", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-ledger-serve-"));
    directories.push(root);
    const stateDirectory = join(root, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const anthropicAuthFile = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await createFileClientTokenStore({ path: anthropicAuthFile }).create(
      { type: "global" },
      CLIENT_TOKEN,
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        server: { host: "127.0.0.1", port: 0 },
        clientProtocols: {
          "anthropic-messages": { authFile: "client-auth/anthropic-messages.json" },
        },
        providerPackages: { "@luckytoken/provider-commandcode-private": {} },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const config = await loadLuckyTokenCliConfig(configPath);

    // The serve-level diagnostics store (opened before the ledger, exactly
    // as src/cli.ts does).
    const diagnosticsStore = await createRuntimeDiagnosticsStoreFactory({
      configuration: parseRuntimeDiagnosticsConfiguration(
        { directory: join(stateDirectory, "diagnostics") },
        stateDirectory,
      ),
      now: () => 1_786_400_000_000,
    }).open();
    stores.push(diagnosticsStore);

    // The serve-owned ledger store: writes are poisoned AFTER open, and the
    // onPersistenceFailure callback is wired exactly like the real serve
    // path — one sanitized Critical append, guarded, with the message hash
    // only.
    let poisonWrites = false;
    const ledgerStore = await createRequestLedgerStoreFactory({
      configuration: parseRequestLedgerConfiguration(
        { directory: join(stateDirectory, "state", "request-ledger") },
        stateDirectory,
      ),
      now: () => 1_786_400_000_000,
      databaseFactory: {
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
                        /^\s*(INSERT|UPDATE)\b/i.test(sql)
                      ) {
                        return (...args: unknown[]) => {
                          if (poisonWrites) {
                            throw new Error(
                              `ledger write denied ${FAULT_CANARY}`,
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
      },
      onPersistenceFailure: (failure) => {
        try {
          diagnosticsStore.append({
            level: "critical",
            text: "Request Ledger persistence failure",
            ...(failure.requestId.length === 0
              ? {}
              : { requestId: failure.requestId }),
            details: { messageHash: failure.messageHash },
          });
        } catch {
          // The diagnostics seam must never affect the request path.
        }
      },
    }).open();
    stores.push(ledgerStore);
    poisonWrites = true;

    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const composition = await createConfiguredLuckyTokenComposition({
      config,
      credentials,
      fetch: (async () => commandCodeText("serve-wired answer")) as FetchFunction,
      importModule: commandCodeProviderImportModule({
        projectSnapshot: {
          snapshot: async () => createEmptyServerConfig(),
        },
      }),
      diagnosticsStore,
      requestLedgerStore: ledgerStore,
      now: () => 1_786_400_000_000,
    });
    stores.push(composition.requestLedger);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
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
      }),
    );

    // The model response is untouched by the ledger fault.
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("serve-wired answer");
    expect(response.headers.get("x-luckytoken-request-id")).toBeTruthy();

    // Exactly one sanitized Critical per request (the per-entry seam fires
    // once even though every ledger transition failed).
    await expect
      .poll(() => diagnosticsStore.query(undefined).records.length)
      .toBe(1);
    const record = diagnosticsStore.query(undefined).records[0]!;
    expect(record.level).toBe("critical");
    expect(record.text).toBe("Request Ledger persistence failure");
    expect(record.requestId).toBe(
      response.headers.get("x-luckytoken-request-id"),
    );
    const serialized = JSON.stringify(record);
    // No fault text, no credential canary.
    expect(serialized).not.toContain(FAULT_CANARY);
    expect(serialized).not.toContain("ledger write denied");
    expect(serialized).not.toContain(CLIENT_TOKEN);
    expect(serialized).toContain("messageHash");

    // A second request reports a second sanitized Critical (per request,
    // never duplicated within one request).
    const second = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${CLIENT_TOKEN}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          max_tokens: 32,
          messages: [{ role: "user", content: "again" }],
        }),
      }),
    );
    expect(second.status).toBe(200);
    await expect
      .poll(() => diagnosticsStore.query(undefined).records.length)
      .toBe(2);
  });
});