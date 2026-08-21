import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBackupAuthority } from "../../src/backup/index.js";

const CONFIG_SECRET = "ordinary-config-secret-canary";
const CREDENTIAL_SECRET = "credential-secret-canary";
const TOKEN_SECRET = "client-token-secret-canary";
const HISTORY_SECRET = "history-sensitive-canary";

describe("Ticket 24 backup authority", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t24-owned-"));
    const exportRoot = await mkdtemp(join(tmpdir(), "luckytoken-t24-export-"));
    roots.push(root, exportRoot);
    const configPath = join(root, "config.json");
    const modelsPath = join(root, "models.json");
    const aliasesPath = join(root, "model-aliases.json");
    const settingsPath = join(root, "settings.json");
    const credentialPath = join(root, "auth.json");
    const tokenPath = join(root, "anthropic-client-tokens.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        providerPackages: { demo: { apiKey: CONFIG_SECRET } },
      }),
    );
    await writeFile(modelsPath, JSON.stringify({ providers: {} }));
    await writeFile(aliasesPath, JSON.stringify({ aliases: {} }));
    await writeFile(settingsPath, JSON.stringify({ "server.port": 3000 }));
    await writeFile(
      credentialPath,
      JSON.stringify({ demo: { type: "api_key", key: CREDENTIAL_SECRET } }),
    );
    await writeFile(
      tokenPath,
      JSON.stringify({
        schemaVersion: "luckytoken-client-auth-v2",
        global: TOKEN_SECRET,
        projects: {},
        revision: 1,
        globalDeleted: false,
      }),
    );
    const destination = join(exportRoot, "backup.json");
    const authority = createBackupAuthority({
      ownedRoot: root,
      applicationVersion: "1.0.0-test",
      now: () => 1_700_000_000_000,
      createActionId: () => "confirm-full-1",
      files: [
        {
          id: "configuration",
          path: configPath,
          contract: "luckytoken-config",
          version: 1,
          category: "configuration",
        },
        {
          id: "models",
          path: modelsPath,
          contract: "pi-models-json",
          version: "0.84.2",
          category: "configuration",
        },
        {
          id: "aliases",
          path: aliasesPath,
          contract: "luckytoken-model-aliases",
          version: 1,
          category: "configuration",
        },
        {
          id: "settings",
          path: settingsPath,
          contract: "luckytoken-settings",
          version: 1,
          category: "configuration",
        },
        {
          id: "provider-credentials",
          path: credentialPath,
          contract: "pi-auth-json",
          version: "0.84.1",
          category: "credentials",
        },
        {
          id: "client-tokens:anthropic-messages",
          path: tokenPath,
          contract: "luckytoken-client-auth",
          version: 2,
          category: "client_tokens",
        },
      ],
      snapshots: [
        {
          id: "request-ledger",
          contract: "luckytoken-request-ledger-sqlite",
          version: 2,
          category: "history",
          snapshot: async () => Buffer.from(HISTORY_SECRET),
        },
        {
          id: "deep-capture",
          contract: "luckytoken-deep-capture-sqlite",
          version: 1,
          category: "capture",
          snapshot: async () => Buffer.from("capture-sensitive-canary"),
        },
      ],
    });
    return { root, exportRoot, destination, authority };
  }

  it("creates an ordinary versioned backup containing only redacted transparent configuration", async () => {
    const { destination, authority } = await fixture();
    const result = await authority.handle(
      {
        command: "create",
        mode: "ordinary",
        destinationPath: destination,
        overwrite: false,
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("ok");
    expect(result.manifest).toMatchObject({
      format: "luckytoken-backup",
      formatVersion: 1,
      sensitive: false,
      entries: [
        { id: "configuration", contract: "luckytoken-config", version: 1 },
        { id: "models", contract: "pi-models-json", version: "0.84.2" },
        { id: "aliases", contract: "luckytoken-model-aliases", version: 1 },
        { id: "settings", contract: "luckytoken-settings", version: 1 },
      ],
    });
    const artifact = await readFile(destination, "utf8");
    expect(artifact).not.toContain(CONFIG_SECRET);
    expect(artifact).not.toContain(CREDENTIAL_SECRET);
    expect(artifact).not.toContain(TOKEN_SECRET);
    expect(artifact).not.toContain(HISTORY_SECRET);
    expect(artifact).toContain("ORDINARY_REDACTED");
  });

  it("requires a single-use confirmation and clearly labels every approved sensitive source", async () => {
    const { destination, authority } = await fixture();
    const requested = await authority.handle(
      {
        command: "create",
        mode: "full_sensitive",
        destinationPath: destination,
        overwrite: false,
      },
      new AbortController().signal,
    );
    expect(requested).toMatchObject({
      outcome: "confirmation_required",
      actionId: "confirm-full-1",
    });
    expect(requested.confirmationMessage).toContain("Provider credentials");
    expect(requested.confirmationMessage).toContain("Client token secrets");
    expect(requested.confirmationMessage).toContain("permanent history");
    expect(requested.confirmationMessage).toContain("Deep Diagnostics capture");

    const confirmed = await authority.handle(
      { command: "confirm", actionId: "confirm-full-1" },
      new AbortController().signal,
    );
    expect(confirmed.outcome).toBe("ok");
    expect(confirmed.manifest?.sensitive).toBe(true);
    expect(confirmed.manifest?.entries.map((entry) => entry.id)).toEqual([
      "configuration",
      "models",
      "aliases",
      "settings",
      "provider-credentials",
      "client-tokens:anthropic-messages",
      "request-ledger",
      "deep-capture",
    ]);
    const artifact = await readFile(destination, "utf8");
    expect(artifact).toContain("FULL_SENSITIVE");
    expect(artifact).toContain(Buffer.from(CREDENTIAL_SECRET).toString("base64").slice(0, 12));
    expect(artifact).toContain(Buffer.from(HISTORY_SECRET).toString("base64"));
    await expect(
      authority.handle(
        { command: "confirm", actionId: "confirm-full-1" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("No matching full-sensitive backup confirmation");
  });

  it("refuses an allowlisted path that resolves outside the owned root without reading or publishing it", async () => {
    const { root, exportRoot, destination } = await fixture();
    const externalRoot = await mkdtemp(join(tmpdir(), "pi-agent-private-"));
    roots.push(externalRoot);
    const externalAuth = join(externalRoot, "auth.json");
    const privateBytes = `external-private-${CREDENTIAL_SECRET}`;
    await writeFile(externalAuth, privateBytes);
    const authority = createBackupAuthority({
      ownedRoot: root,
      applicationVersion: "test",
      createActionId: () => "outside-confirm",
      files: [
        {
          id: "provider-credentials",
          path: externalAuth,
          contract: "pi-auth-json",
          version: "0.84.1",
          category: "credentials",
        },
      ],
      snapshots: [],
    });
    await authority.handle(
      {
        command: "create",
        mode: "full_sensitive",
        destinationPath: destination,
        overwrite: false,
      },
      new AbortController().signal,
    );
    const result = await authority.handle(
      { command: "confirm", actionId: "outside-confirm" },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "source_outside_owned_root" },
    });
    expect(await readFile(externalAuth, "utf8")).toBe(privateBytes);
    expect(await readdir(exportRoot)).toEqual([]);
  });

  it("never invokes a snapshot owner whose declared source is outside the owned root", async () => {
    const { root, exportRoot, destination } = await fixture();
    const externalRoot = await mkdtemp(join(tmpdir(), "foreign-history-store-"));
    roots.push(externalRoot);
    const externalDatabase = join(externalRoot, "ledger.sqlite3");
    await writeFile(externalDatabase, HISTORY_SECRET, "utf8");
    let invoked = false;
    const authority = createBackupAuthority({
      ownedRoot: root,
      applicationVersion: "test",
      createActionId: () => "outside-snapshot-confirm",
      files: [],
      snapshots: [
        {
          id: "request-ledger",
          contract: "luckytoken-request-ledger-sqlite",
          version: 2,
          category: "history",
          sourcePath: externalDatabase,
          snapshot: async () => {
            invoked = true;
            return Buffer.from(HISTORY_SECRET);
          },
        },
      ],
    });
    await authority.handle(
      {
        command: "create",
        mode: "full_sensitive",
        destinationPath: destination,
        overwrite: false,
      },
      new AbortController().signal,
    );
    const result = await authority.handle(
      { command: "confirm", actionId: "outside-snapshot-confirm" },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "source_outside_owned_root" },
    });
    expect(invoked).toBe(false);
    expect(await readdir(exportRoot)).toEqual([]);
  });

  it("removes temporary output when the operation is cancelled", async () => {
    const { exportRoot, destination, authority } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    const result = await authority.handle(
      {
        command: "create",
        mode: "ordinary",
        destinationPath: destination,
        overwrite: false,
      },
      controller.signal,
    );
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "cancelled" },
    });
    expect(await readdir(exportRoot)).toEqual([]);
  });
});
