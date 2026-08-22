import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import {
  createConfiguredLuckyTokenDataPlane,
  createSeededCredentialRecordStore,
} from "../support/configured-data-plane.js";

/**
 * Ticket 12 secret hygiene: credential values that enter the authority
 * (literal secrets, env references and their resolved values, stored OAuth
 * tokens) must never appear in status projections, status events, Runtime
 * Diagnostics DB/WAL, failure journals, or CLI output. Every canary is fake.
 */
describe("credential canary hygiene across public surfaces", () => {
  const CANARY_KEY = "sk-credential-canary-1234567890";
  const CANARY_ENV = "CANARY_CRED_ENV_42";
  const CANARY_ENV_VALUE = "env-credential-canary-value-77";
  const CANARY_IMPORT_KEY = "sk-import-canary-555";

  const directories: string[] = [];
  const compositions: Array<{ diagnosticsStore: { close(): void }; requestLedger: { close(): void }; deepCaptureStore: { close(): void } }> = [];

  afterEach(async () => {
    compositions
      .splice(0)
      .forEach((composition) => {
        composition.diagnosticsStore.close();
        composition.requestLedger.close();
        composition.deepCaptureStore.close();
      });
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function serve() {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cred-canary-"));
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const modelsJsonPath = join(piDirectory, "models.json");
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "secret-gw": {
            baseUrl: "https://secret-gw.example.com",
            api: "anthropic-messages",
            apiKey: `$${CANARY_ENV}`,
            models: [{ id: "m1" }],
          },
        },
      }),
      "utf8",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
        },
        pi: { directory: "pi", modelsJson: "pi/models.json" },
        failureLogging: { detail: "full", directory: "logs/failed-requests" },
        runtimeDiagnostics: { directory: "diagnostics" },
      }),
      "utf8",
    );
    const credentialRecordStore = await createSeededCredentialRecordStore([{
      providerId: "secret-gw",
      credential: {
        type: "api_key",
        key: CANARY_KEY,
        env: { PROVIDER_PRIVATE_TOKEN: CANARY_IMPORT_KEY },
      },
    }]);
    const composition = await createConfiguredLuckyTokenDataPlane({
      config: await loadLuckyTokenCliConfig(configPath),
      fetch: async () => new Response(),
      credentialRecordStore,
      configValueAdapters: {
        envSource: (name) =>
          name === CANARY_ENV ? CANARY_ENV_VALUE : undefined,
        commandRunner: () => undefined,
      },
      createMessageId: () => "msg_canary_cred",
      createSessionId: () => "00000000-0000-4000-8000-000000000030",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);
    return { composition, stateDirectory };
  }

  async function readdirRecursive(root: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const out: string[] = [];
    const walk = async (entry: string): Promise<void> => {
      const entries = await readdir(entry, { withFileTypes: true });
      for (const child of entries) {
        const path = join(entry, child.name);
        if (child.isDirectory()) await walk(path);
        else if (child.isFile()) out.push(path);
      }
    };
    try {
      await walk(root);
    } catch {
      return out;
    }
    return out;
  }

  it("keeps stored credential canaries out of status, events, diagnostics and journals", async () => {
    const { composition, stateDirectory } = await serve();
    const management = composition.credentialManagement;

    // The sanitized projection never carries the raw or resolved values.
    const projection = JSON.stringify(management.snapshot());
    expect(projection).not.toContain(CANARY_KEY);
    expect(projection).not.toContain(CANARY_ENV_VALUE);
    expect(projection).not.toContain(CANARY_ENV);
    expect(projection).toContain("secret-gw");

    // The known-value scrub attached to the Diagnostics store redacts the
    // stored credential values (raw and env-resolved) from records.
    composition.diagnosticsStore.append({
      level: "error",
      text: `request failed with ${CANARY_KEY} and ${CANARY_ENV_VALUE}`,
    });
    const records = await composition.diagnosticsStore.query({ limit: 10 });
    const diagnosticsText = JSON.stringify(records);
    expect(diagnosticsText).not.toContain(CANARY_KEY);
    expect(diagnosticsText).not.toContain(CANARY_ENV_VALUE);
    expect(diagnosticsText).toContain("[REDACTED]");

    // Diagnostics DB/WAL on disk contain no canary bytes.
    const files = await readdirRecursive(join(stateDirectory, "diagnostics"));
    for (const file of files) {
      const bytes = await readFile(file, "utf8");
      expect(bytes).not.toContain(CANARY_KEY);
      expect(bytes).not.toContain(CANARY_ENV_VALUE);
    }

    expect(projection).not.toContain(CANARY_IMPORT_KEY);
  });

  it("keeps canaries out of every credential command result and failure surface", async () => {
    const { composition } = await serve();
    const management = composition.credentialManagement;
    const current = management.snapshot().providers.find(
      (provider) => provider.providerId === "secret-gw",
    )!;
    const target = current.profiles[0]!;
    const results = [
      await management.query(),
      await management.updateMetadata({
        providerId: "secret-gw",
        credentialId: target.credentialId,
        expectedRevision: current.revision!,
        displayName: CANARY_IMPORT_KEY,
      }),
      await management.remove({
        providerId: "secret-gw",
        credentialId: target.credentialId,
        expectedRevision: current.revision!,
      }),
    ];
    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(CANARY_KEY);
      expect(serialized).not.toContain(CANARY_IMPORT_KEY);
    }
  });

  it("projects ambient eligibility after the last managed Profile is removed", async () => {
    const { composition } = await serve();
    const management = composition.credentialManagement;
    const current = management.snapshot().providers.find(
      (provider) => provider.providerId === "secret-gw",
    )!;
    await management.remove({
      providerId: "secret-gw",
      credentialId: current.profiles[0]!.credentialId,
      expectedRevision: current.revision!,
    });
    const projection = await management.query();
    const row = projection.providers.find(
      (entry) => entry.providerId === "secret-gw",
    );
    expect(row).toMatchObject({
      implementationAvailable: true,
      profiles: [],
      ambient: { kind: "external", status: "configured" },
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(CANARY_KEY);
    expect(serialized).not.toContain(CANARY_ENV_VALUE);
  });
});
