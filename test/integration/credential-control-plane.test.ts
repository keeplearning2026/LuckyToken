import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

import { createCredentialControlPlaneHandler } from "../../src/credentials/control-plane.js";
import {
  createLiveCredentialAuthority,
  type LiveCredentialAuthority,
} from "../../src/credentials/authority.js";
import { createFileCredentialStore } from "../../src/pi/file-credential-store.js";
import {
  createConfigValueResolver,
  type ConfigValueResolver,
} from "../../src/providers/config-value.js";
import {
  createFixtureAuthContext,
  createFixtureProvider,
} from "../support/credential-fixture.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

/**
 * Ticket 12 public seam: the versioned Control Plane Credential commands and
 * the CLI. Every case drives the real authority against a real auth.json in
 * a temp directory and asserts through the pipe client plus the on-disk
 * bytes — with fake independent secrets and deterministic adapters.
 */
describe("credential management through the Control Plane", () => {
  const roots: string[] = [];
  const hosts: RunningControlPlane[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  let nextPipe = 0;
  let nextRequest = 0;

  afterEach(async () => {
    children.splice(0).forEach((child) => child.kill());
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function startCredentialControlPlane(options: {
    readonly directory: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly modelsJson?: Record<string, { apiKey?: string }>;
  }): Promise<{
    readonly host: RunningControlPlane;
    readonly client: Awaited<ReturnType<typeof connectControlPlane>>;
    readonly authority: LiveCredentialAuthority;
    readonly path: string;
  }> {
    const path = join(options.directory, "auth.json");
    const env: Record<string, string> = { ...(options.env ?? {}) };
    const configValues: ConfigValueResolver = createConfigValueResolver({
      envSource: (name) => env[name],
      commandRunner: () => undefined,
    });
    const providers = [
      createFixtureProvider({
        id: "fixture-provider",
        envVarName: "FIXTURE_API_KEY",
      }),
    ];
    const authority = await createLiveCredentialAuthority({
      store: createFileCredentialStore(path),
      path,
      configValues,
      authContext: createFixtureAuthContext(env),
      providers: () => providers,
      modelsJsonProviders: () =>
        (options.modelsJson ?? {}) as Record<string, { apiKey?: string }>,
    });
    const endpoint: ControlPlaneEndpoint = {
      pipeName: `\\\\.\\pipe\\luckytoken-cred-${process.pid}-${++nextPipe}`,
      capability: "credential-test-capability-0123456789012345",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      credentialCommandHandler: createCredentialControlPlaneHandler({
        authority: () => authority,
      }),
      credentialProjection: () => authority.snapshot(),
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `credential-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    const hello = await client.hello(1);
    if (hello.type !== "compatible") {
      throw new Error("Control Plane hello failed");
    }
    return { host, client, authority, path };
  }

  async function runCli(args: readonly string[]): Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }> {
    const child = spawn(process.execPath, [tsxCli, "src/cli.ts", ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>(
      (resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("exit", (exitCode) => resolvePromise(exitCode));
      },
    );
    return { code, stdout, stderr };
  }

  it("round-trips query, login, logout and status projection through the versioned wire", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cred-cp-"));
    roots.push(directory);
    const { client, path } = await startCredentialControlPlane({ directory });

    const queried = await client.executeCredentialCommand({ command: "query" });
    expect(queried.outcome).toBe("ok");
    expect(queried.state).toMatchObject({
      revision: 0,
      path,
      present: false,
      valid: false,
    });
    expect(queried.state.providers).toHaveLength(1);
    expect(queried.state.providers[0]).toMatchObject({
      providerId: "fixture-provider",
      stored: false,
      unavailable: true,
      effectiveSource: "none",
    });

    const loggedIn = await client.executeCredentialCommand({
      command: "login",
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-control-plane-secret",
      overwrite: true,
    });
    expect(loggedIn.outcome).toBe("ok");
    expect(loggedIn.changed).toBe(true);
    expect(loggedIn.revision).toBe(1);
    expect(loggedIn.state.providers[0]).toMatchObject({
      stored: true,
      storedType: "api_key",
      effectiveSource: "stored",
    });
    // The stored value lives only in the file, never in the result.
    expect(JSON.stringify(loggedIn)).not.toContain("sk-control-plane-secret");
    await expect(readFile(path, "utf8")).resolves.toContain(
      "sk-control-plane-secret",
    );

    // The status snapshot carries the sanitized projection.
    const status = await client.getStatus();
    expect(status.credentials).toMatchObject({ revision: 1, valid: true });
    expect(JSON.stringify(status)).not.toContain("sk-control-plane-secret");

    const removed = await client.executeCredentialCommand({
      command: "logout",
      providerId: "fixture-provider",
      expectedRevision: 1,
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.changed).toBe(true);
    expect(removed.revision).toBe(2);
    expect(removed.state.providers[0]).toMatchObject({
      stored: false,
      effectiveSource: "none",
    });
  });

  it("two Control Plane clients cannot lose a concurrent mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cred-cp-race-"));
    roots.push(directory);
    const first = await startCredentialControlPlane({ directory });
    const secondClient = await connectControlPlane(first.host.endpoint, {
      createRequestId: () => `credential-race-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    const hello = await secondClient.hello(1);
    if (hello.type !== "compatible") {
      throw new Error("Control Plane hello failed");
    }

    const a = await first.client.executeCredentialCommand({
      command: "login",
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-race-winner",
      overwrite: true,
    });
    expect(a.outcome).toBe("ok");
    const b = await secondClient.executeCredentialCommand({
      command: "login",
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-race-loser",
      overwrite: true,
    });
    expect(b.outcome).toBe("conflict");
    expect(b.revision).toBe(1);
    await expect(
      createFileCredentialStore(join(directory, "auth.json")).read(
        "fixture-provider",
      ),
    ).resolves.toEqual({ type: "api_key", key: "sk-race-winner" });
    await secondClient.close();
  });

  it("publishes exactly when a credential mutation changes the revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cred-cp-pub-"));
    roots.push(directory);
    const { client } = await startCredentialControlPlane({ directory });
    const events: unknown[] = [];
    await client.subscribe((event) => events.push(event));

    // Reads never publish.
    await client.executeCredentialCommand({ command: "query" });
    await expect
      .poll(() => events.length, { timeout: 250, interval: 25 })
      .toBe(0);

    // A successful login publishes exactly one status_changed event.
    await client.executeCredentialCommand({
      command: "login",
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-publish-secret",
      overwrite: true,
    });
    await expect.poll(() => events.length).toBe(1);
    expect(JSON.stringify(events)).not.toContain("sk-publish-secret");
    expect(JSON.stringify(events)).toContain('"effectiveSource":"stored"');

    // A stale mutation (no state change) does not publish.
    await client.executeCredentialCommand({
      command: "login",
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-stale",
      overwrite: true,
    });
    await expect
      .poll(() => events.length, { timeout: 250, interval: 25 })
      .toBe(1);
  });

  it("imports Provider by Provider with confirmation and preserves unselected credentials", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-cred-cp-import-"),
    );
    roots.push(directory);
    const { client, path } = await startCredentialControlPlane({ directory });
    // Seed an existing credential that the import must not touch.
    await createFileCredentialStore(path).casWrite(
      "provider-existing",
      undefined,
      { type: "api_key", key: "sk-existing-keep" },
    );

    const queried = await client.executeCredentialCommand({ command: "query" });
    expect(queried.revision).toBe(1);

    const preview = await client.executeCredentialCommand({
      command: "import_preview",
      expectedRevision: 1,
      content: JSON.stringify({
        "provider-a": { type: "api_key", key: "sk-imported-a" },
        "provider-b": { type: "api_key", key: "sk-imported-b" },
        "provider-existing": { type: "api_key", key: "sk-imported-overwrite" },
      }),
    });
    expect(preview.outcome).toBe("ok");
    expect(preview.importId).toBeDefined();
    expect(preview.previewEntries).toEqual([
      { providerId: "provider-a", type: "api_key", wouldOverwrite: false },
      { providerId: "provider-b", type: "api_key", wouldOverwrite: false },
      {
        providerId: "provider-existing",
        type: "api_key",
        wouldOverwrite: true,
      },
    ]);
    // The preview never echoes credential values.
    expect(JSON.stringify(preview)).not.toContain("sk-imported-a");

    // The CLI would ask before this overwrite; a declined entry is
    // skipped/preserved while the confirmed entries still apply.
    const unconfirmed = await client.executeCredentialCommand({
      command: "import_apply",
      expectedRevision: 1,
      importId: preview.importId as string,
      selections: [
        { providerId: "provider-a", overwrite: false },
        { providerId: "provider-existing", overwrite: false },
      ],
    });
    expect(unconfirmed.outcome).toBe("ok");
    expect(unconfirmed.entries).toEqual([
      { providerId: "provider-a", outcome: "applied" },
      {
        providerId: "provider-existing",
        outcome: "skipped",
      },
    ]);
    await expect(
      createFileCredentialStore(path).read("provider-existing"),
    ).resolves.toEqual({ type: "api_key", key: "sk-existing-keep" });

    // The confirmed apply writes only the selected Providers.
    const previewed = await client.executeCredentialCommand({
      command: "import_preview",
      expectedRevision: 2,
      content: JSON.stringify({
        "provider-a": { type: "api_key", key: "sk-imported-a" },
        "provider-existing": { type: "api_key", key: "sk-imported-overwrite" },
      }),
    });
    const applied = await client.executeCredentialCommand({
      command: "import_apply",
      expectedRevision: 2,
      importId: previewed.importId as string,
      selections: [
        { providerId: "provider-a", overwrite: true },
        { providerId: "provider-existing", overwrite: true },
      ],
    });
    expect(applied.outcome).toBe("ok");
    expect(applied.entries).toEqual([
      // provider-a already holds the identical value from the first apply.
      { providerId: "provider-a", outcome: "unchanged" },
      { providerId: "provider-existing", outcome: "applied" },
    ]);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk["provider-a"]).toEqual({
      type: "api_key",
      key: "sk-imported-a",
    });
    expect(onDisk["provider-existing"]).toEqual({
      type: "api_key",
      key: "sk-imported-overwrite",
    });
    expect(Object.keys(onDisk).sort()).toEqual([
      "provider-a",
      "provider-existing",
    ]);
  });

  it("serves an unavailable credential result through the versioned wire", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-cred-cp-unavail-"),
    );
    roots.push(directory);
    const endpoint: ControlPlaneEndpoint = {
      pipeName: `\\\\.\\pipe\\luckytoken-cred-unavail-${process.pid}-${++nextPipe}`,
      capability: "credential-unavailable-capability-0123456789",
    };
    // The authority slot is empty (e.g. before the Data Plane composition
    // is running): the handler reports a coherent unavailable DTO.
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      credentialCommandHandler: createCredentialControlPlaneHandler({
        authority: () => undefined,
      }),
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `credential-unavailable-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    const hello = await client.hello(1);
    if (hello.type !== "compatible") {
      throw new Error("Control Plane hello failed");
    }

    const result = await client.executeCredentialCommand({ command: "query" });
    expect(result.outcome).toBe("unavailable");
    expect(result.revision).toBe(0);
    expect(result.error).toBe("Credential Authority is unavailable");
    // The unavailable DTO is value-free and structurally decodable.
    expect(JSON.stringify(result)).not.toContain("sk-");
    await client.close();
  });

  it("accepts an empty Pi-compatible auth.json import through the versioned wire", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-cred-cp-empty-"),
    );
    roots.push(directory);
    const { client } = await startCredentialControlPlane({ directory });

    const preview = await client.executeCredentialCommand({
      command: "import_preview",
      expectedRevision: 0,
      content: "{}",
    });
    expect(preview.outcome).toBe("ok");
    expect(preview.importId).toBeDefined();
    expect(preview.previewEntries).toEqual([]);

    const applied = await client.executeCredentialCommand({
      command: "import_apply",
      expectedRevision: 0,
      importId: preview.importId as string,
      selections: [],
    });
    expect(applied.outcome).toBe("ok");
    expect(applied.entries).toEqual([]);
  });

  it("reports a declined import overwrite as skipped through the versioned wire", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cred-cp-skip-"));
    roots.push(directory);
    const { client, path } = await startCredentialControlPlane({ directory });
    await createFileCredentialStore(path).casWrite("provider-a", undefined, {
      type: "api_key",
      key: "sk-existing-a",
    });
    const queried = await client.executeCredentialCommand({ command: "query" });
    expect(queried.revision).toBe(1);

    const preview = await client.executeCredentialCommand({
      command: "import_preview",
      expectedRevision: 1,
      content: JSON.stringify({
        "provider-a": { type: "api_key", key: "sk-imported-a" },
        "provider-b": { type: "api_key", key: "sk-imported-b" },
      }),
    });
    expect(preview.outcome).toBe("ok");
    const applied = await client.executeCredentialCommand({
      command: "import_apply",
      expectedRevision: 1,
      importId: preview.importId as string,
      selections: [
        { providerId: "provider-a", overwrite: false },
        { providerId: "provider-b", overwrite: false },
      ],
    });
    expect(applied.outcome).toBe("ok");
    expect(applied.entries).toEqual([
      { providerId: "provider-a", outcome: "skipped" },
      { providerId: "provider-b", outcome: "applied" },
    ]);
    await expect(
      createFileCredentialStore(path).read("provider-a"),
    ).resolves.toEqual({ type: "api_key", key: "sk-existing-a" });
  });

  it("rejects malformed import content and keeps malformed auth.json bytes untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cred-cp-bad-"));
    roots.push(directory);
    const { client, path } = await startCredentialControlPlane({ directory });

    const broken = await client.executeCredentialCommand({
      command: "import_preview",
      expectedRevision: 0,
      content: "{ not json at all",
    });
    expect(broken.outcome).toBe("invalid");
    expect(broken.error).toBeDefined();
    expect(broken.error).not.toContain("not json at all");

    const garbage = "{ this is not json";
    await writeFile(path, garbage, "utf8");
    const queried = await client.executeCredentialCommand({ command: "query" });
    expect(queried.outcome).toBe("ok");
    expect(queried.state).toMatchObject({ present: true, valid: false });
    expect(queried.state.error?.kind).toBe("parse");
    expect(queried.state.providers).toEqual([]);
    expect(JSON.stringify(queried)).not.toContain("this is not json");

    const login = await client.executeCredentialCommand({
      command: "login",
      providerId: "fixture-provider",
      expectedRevision: queried.revision,
      value: "sk-must-not-write",
      overwrite: true,
    });
    expect(login.outcome).toBe("conflict");
    await expect(readFile(path, "utf8")).resolves.toBe(garbage);
  });

  it("serves the CLI credentials commands end to end and reports Stored credential removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cred-cli-"));
    roots.push(directory);
    const { host, client, path } = await startCredentialControlPlane({
      directory,
    });
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(host.endpoint), "utf8");

    const query = await runCli([
      "control",
      "credentials",
      "query",
      "--descriptor",
      descriptorPath,
    ]);
    expect(query.code).toBe(0);
    const queried = JSON.parse(query.stdout);
    expect(queried.outcome).toBe("ok");
    expect(queried.state.providers[0]).toMatchObject({
      providerId: "fixture-provider",
      effectiveSource: "none",
    });
    expect(query.stdout).not.toContain("sk-");

    const login = await runCli([
      "control",
      "credentials",
      "login",
      "fixture-provider",
      "sk-cli-secret",
      "--descriptor",
      descriptorPath,
    ]);
    expect(login.code).toBe(0);
    expect(login.stdout).toContain(
      "Stored API key credential for fixture-provider",
    );

    // An occupied slot requires the explicit overwrite confirmation.
    const refused = await runCli([
      "control",
      "credentials",
      "login",
      "fixture-provider",
      "sk-cli-2",
      "--descriptor",
      descriptorPath,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("already has a stored credential");

    const confirmed = await runCli([
      "control",
      "credentials",
      "login",
      "fixture-provider",
      "sk-cli-2",
      "--overwrite",
      "--descriptor",
      descriptorPath,
    ]);
    expect(confirmed.code).toBe(0);

    // The CLI status output carries the sanitized projection only.
    const status = await runCli([
      "control",
      "status",
      "--descriptor",
      descriptorPath,
    ]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("fixture-provider");
    expect(status.stdout).not.toContain("sk-cli-secret");
    expect(status.stdout).not.toContain("sk-cli-2");

    const logout = await runCli([
      "control",
      "credentials",
      "logout",
      "fixture-provider",
      "--descriptor",
      descriptorPath,
    ]);
    expect(logout.code).toBe(0);
    expect(logout.stdout).toContain("Stored credential removed");
    await expect(
      createFileCredentialStore(path).read("fixture-provider"),
    ).resolves.toBeUndefined();

    // Logging out an empty slot reports the accurate no-op.
    const emptyLogout = await runCli([
      "control",
      "credentials",
      "logout",
      "fixture-provider",
      "--descriptor",
      descriptorPath,
    ]);
    expect(emptyLogout.code).toBe(0);
    expect(emptyLogout.stdout).toContain("No stored credential to remove");
    await client.close();
  }, 120_000);

  it("imports an empty Pi-compatible auth.json through the CLI as a no-op", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-cred-cli-empty-"),
    );
    roots.push(directory);
    const { host } = await startCredentialControlPlane({ directory });
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(host.endpoint), "utf8");
    const importFile = join(directory, "empty.json");
    await writeFile(importFile, "{}", "utf8");

    const imported = await runCli([
      "control",
      "credentials",
      "import",
      importFile,
      "--descriptor",
      descriptorPath,
    ]);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain("Nothing to import.");
  }, 120_000);

  it("imports through the CLI with Provider-by-Provider confirmation", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-cred-cli-import-"),
    );
    roots.push(directory);
    const { host, path } = await startCredentialControlPlane({ directory });
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(host.endpoint), "utf8");
    await createFileCredentialStore(path).casWrite(
      "provider-existing",
      undefined,
      { type: "api_key", key: "sk-existing-keep" },
    );

    const importFile = join(directory, "import.json");
    await writeFile(
      importFile,
      JSON.stringify({
        "provider-a": { type: "api_key", key: "sk-imported-a" },
        "provider-existing": {
          type: "api_key",
          key: "sk-imported-overwrite",
        },
      }),
      "utf8",
    );

    // Non-interactive confirmation is refused explicitly.
    const unconfirmed = await runCli([
      "control",
      "credentials",
      "import",
      importFile,
      "--descriptor",
      descriptorPath,
    ]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("Overwrite confirmation required");
    await expect(
      createFileCredentialStore(path).read("provider-existing"),
    ).resolves.toEqual({ type: "api_key", key: "sk-existing-keep" });

    const imported = await runCli([
      "control",
      "credentials",
      "import",
      importFile,
      "--overwrite-all",
      "--descriptor",
      descriptorPath,
    ]);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain("provider-a");
    expect(imported.stdout).toContain("provider-existing");
    expect(imported.stdout).not.toContain("sk-imported-a");
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk["provider-a"]).toEqual({
      type: "api_key",
      key: "sk-imported-a",
    });
    expect(onDisk["provider-existing"]).toEqual({
      type: "api_key",
      key: "sk-imported-overwrite",
    });
  }, 120_000);
});
