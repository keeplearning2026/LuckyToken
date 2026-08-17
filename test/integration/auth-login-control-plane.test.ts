import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
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
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai";

import { createLiveCredentialAuthority } from "../../src/credentials/authority.js";
import { createCredentialControlPlaneHandler } from "../../src/credentials/control-plane.js";
import { createAuthLoginControlPlaneHandler } from "../../src/credentials/login-control-plane.js";
import { createFileCredentialStore } from "../../src/pi/file-credential-store.js";
import { createConfigValueResolver } from "../../src/providers/config-value.js";
import {
  createAmbientOnlyProvider,
  createBrowserOAuthProvider,
  createDeviceCodeOAuthProvider,
  createExpiredOAuthProvider,
  createFailingOAuthProvider,
  createFixtureAuthContext,
  createSelectOAuthProvider,
  createSecretApiKeyProvider,
  FAKE_AUTH_CODE,
} from "../support/auth-login-fixture.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

/**
 * Ticket 13 public seam: the versioned Control Plane Provider-auth
 * commands and typed interaction events. Every case drives the real
 * authority against a real auth.json in a temp directory and controlled
 * fake Providers through the pipe client, asserting on-disk bytes and
 * published status — no real online authentication. Covers browser
 * callback, device code, manual code, select, text, secret, progress,
 * cancel, replacement, refresh/expiry, logout and ambient authentication.
 */
describe("Provider-owned auth login through the Control Plane", () => {
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

  async function startAuthControlPlane(options: {
    readonly directory: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly providers?: readonly Provider[];
    readonly onLogin?: (providerId: string, authType: "oauth" | "api_key") => void;
  }): Promise<{
    readonly host: RunningControlPlane;
    readonly client: Awaited<ReturnType<typeof connectControlPlane>>;
    readonly path: string;
    readonly loggedInProviders: string[];
    readonly models: Models;
  }> {
    const path = join(options.directory, "auth.json");
    const env: Record<string, string> = { ...(options.env ?? {}) };
    const store = createFileCredentialStore(path);
    const providers = options.providers ?? [createBrowserOAuthProvider()];
    const authority = await createLiveCredentialAuthority({
      store,
      path,
      configValues: createConfigValueResolver({
        envSource: (name) => env[name],
        commandRunner: () => undefined,
      }),
      authContext: createFixtureAuthContext(env),
      providers: () => providers,
      modelsJsonProviders: () => ({}),
    });
    const mutable = createModels({
      credentials: store,
      authContext: createFixtureAuthContext(env),
    });
    for (const provider of providers) mutable.setProvider(provider);
    const loggedInProviders: string[] = [];
    // Mirror the Ticket 11 composition seam (an explicit facade — a class
    // instance cannot be spread): a successful login through the served
    // Models schedules the relevant catalog refresh.
    const loginAware: Models = Object.freeze({
      getProviders: () => mutable.getProviders(),
      getProvider: (id: string) => mutable.getProvider(id),
      getModels: (providerId?: string) => mutable.getModels(providerId),
      getModel: (providerId: string, id: string) =>
        mutable.getModel(providerId, id),
      refresh: (options?: Parameters<Models["refresh"]>[0]) =>
        mutable.refresh(options),
      checkAuth: (providerId: string, options?: { signal?: AbortSignal }) =>
        mutable.checkAuth(providerId, options),
      getAvailable: (
        providerId?: string,
        options?: { signal?: AbortSignal },
      ) => mutable.getAvailable(providerId, options),
      getAuth: (
        providerOrModel: string | never,
        overrides?: never,
      ) =>
        mutable.getAuth(
          providerOrModel as never,
          overrides as never,
        ) as ReturnType<Models["getAuth"]>,
      login: (
        providerId: string,
        authType: "oauth" | "api_key",
        interaction: never,
      ) =>
        mutable.login(providerId, authType, interaction).then((credential) => {
          options.onLogin?.(providerId, authType);
          loggedInProviders.push(providerId);
          return credential;
        }),
      logout: (providerId: string, optionsArg?: { signal?: AbortSignal }) =>
        mutable.logout(providerId, optionsArg),
      stream: (model, context, streamOptions) =>
        mutable.stream(model as never, context, streamOptions),
      complete: (model, context, streamOptions) =>
        mutable.complete(model as never, context, streamOptions),
      streamSimple: (model, context, streamOptions) =>
        mutable.streamSimple(model as never, context, streamOptions),
      completeSimple: (model, context, streamOptions) =>
        mutable.completeSimple(model as never, context, streamOptions),
      fetchDeferred: (model, handle, streamOptions) =>
        mutable.fetchDeferred(model as never, handle, streamOptions),
      cancelDeferred: (model, handle, streamOptions) =>
        mutable.cancelDeferred(model as never, handle, streamOptions),
    } as Models);
    const endpoint: ControlPlaneEndpoint = {
      address: `\\\\.\\pipe\\luckytoken-auth-${process.pid}-${++nextPipe}`,
      capability: "auth-test-capability-0123456789012345",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      authCommandHandler: createAuthLoginControlPlaneHandler({
        models: () => loginAware,
        authority: () => authority,
      }),
      credentialCommandHandler: createCredentialControlPlaneHandler({
        authority: () => authority,
      }),
      credentialProjection: () => authority.snapshot(),
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `auth-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    const hello = await client.hello(1);
    if (hello.type !== "compatible") {
      throw new Error("Control Plane hello failed");
    }
    return { host, client, path, loggedInProviders, models: mutable };
  }

  it("projects per-Provider login options from Provider metadata with effective status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-q-"));
    roots.push(directory);
    const { client } = await startAuthControlPlane({
      directory,
      env: { AMBIENT_ONLY_KEY: "ambient-only-key-value" },
      providers: [
        createBrowserOAuthProvider({
          id: "subscription-provider",
          isSubscription: true,
          loginLabel: "Sign in with Fixture",
        }),
        createBrowserOAuthProvider({ id: "account-provider" }),
        createSecretApiKeyProvider({ id: "key-provider" }),
        createAmbientOnlyProvider({ id: "ambient-only" }),
      ],
    });

    const queried = await client.executeAuthCommand({ command: "query" });
    expect(queried.outcome).toBe("ok");
    const rows = queried.options?.providers ?? [];
    expect(rows).toHaveLength(4);

    const subscription = rows.find(
      (row) => row.providerId === "subscription-provider",
    );
    expect(subscription).toMatchObject({
      name: "Browser Provider",
      account: true,
      subscription: true,
      accountLabel: "Sign in with Fixture",
      apiKey: true,
    });
    expect(subscription?.status).toMatchObject({
      providerId: "subscription-provider",
      stored: false,
      unavailable: true,
      effectiveSource: "none",
    });

    // An OAuth/account flow without isSubscription is never a subscription.
    const account = rows.find((row) => row.providerId === "account-provider");
    expect(account).toMatchObject({ account: true, subscription: false });

    const key = rows.find((row) => row.providerId === "key-provider");
    expect(key).toMatchObject({
      account: false,
      subscription: false,
      apiKey: true,
      apiKeyLabel: "Secret Provider API key",
    });

    // Ambient authentication is reflected in the status facts (no login).
    const ambient = rows.find((row) => row.providerId === "ambient-only");
    expect(ambient).toMatchObject({ account: false, apiKey: true });
    expect(ambient?.status).toMatchObject({
      stored: false,
      environment: true,
      unavailable: false,
      effectiveSource: "environment",
    });
    // No secret or code value ever crosses the wire.
    expect(JSON.stringify(queried)).not.toContain("ambient-only-key-value");
  });

  it("round-trips a browser flow: info, auth_url, progress, manual code, success and atomic replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-browser-"));
    roots.push(directory);
    const loggedIn: string[] = [];
    const { client, path, loggedInProviders } = await startAuthControlPlane({
      directory,
      onLogin: (providerId, authType) => {
        loggedIn.push(`${providerId}:${authType}`);
      },
    });
    const eventLog: string[] = [];

    // Seed an existing credential for a Provider outside the catalog: the
    // login must never touch it.
    const store = createFileCredentialStore(path);
    await store.casWrite("unrelated-provider", undefined, {
      type: "api_key",
      key: "sk-unrelated-keep",
    });
    await client.executeCredentialCommand({ command: "query" });

    const pending = client.executeAuthCommand(
      { command: "login", providerId: "browser-provider", authType: "oauth" },
      (event) => {
        eventLog.push(event.type);
        if (event.type === "prompt" && event.kind === "manual_code") {
          void client
            .respondAuthInteraction({
              type: "prompt_response",
              promptId: event.promptId,
              value: FAKE_AUTH_CODE,
            })
            .catch(() => undefined);
        }
      },
    );
    const result = await pending;
    expect(result.outcome).toBe("ok");
    expect(eventLog).toEqual([
      "info",
      "auth_url",
      "progress",
      "prompt",
      "progress",
    ]);
    expect(result.state.providers.find((row) => row.providerId === "browser-provider"))
      .toMatchObject({
        stored: true,
        storedType: "oauth",
        effectiveSource: "stored",
        expired: false,
      });
    // The on-disk slot was atomically replaced through the authority's
    // store; the unrelated slot is preserved byte-for-byte.
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk["browser-provider"]).toEqual({
      type: "oauth",
      refresh: "refresh-access-browser-provider",
      access: "access-browser-provider",
      expires: expect.any(Number),
    });
    expect(onDisk["unrelated-provider"]).toEqual({
      type: "api_key",
      key: "sk-unrelated-keep",
    });
    // The result carries no credential values.
    expect(JSON.stringify(result)).not.toContain("access-browser-provider");
    expect(JSON.stringify(result)).not.toContain(FAKE_AUTH_CODE);
    // Ticket 11: the successful login scheduled the catalog refresh.
    expect(loggedIn).toEqual(["browser-provider:oauth"]);
    expect(loggedInProviders).toEqual(["browser-provider"]);
    await client.close();
  });

  it("publishes a status event exactly when the login changed the revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-pub-"));
    roots.push(directory);
    const { client } = await startAuthControlPlane({ directory });
    const events: unknown[] = [];
    await client.subscribe((event) => events.push(event));

    const pending = client.executeAuthCommand(
      { command: "login", providerId: "browser-provider", authType: "oauth" },
      (event) => {
        if (event.type === "prompt" && event.kind === "manual_code") {
          void client
            .respondAuthInteraction({
              type: "prompt_response",
              promptId: event.promptId,
              value: FAKE_AUTH_CODE,
            })
            .catch(() => undefined);
        }
      },
    );
    const result = await pending;
    expect(result.outcome).toBe("ok");
    await expect.poll(() => events.length).toBe(1);
    expect(JSON.stringify(events)).not.toContain("access-browser-provider");
    expect(JSON.stringify(events)).toContain('"storedType":"oauth"');

    // A query never publishes.
    await client.executeAuthCommand({ command: "query" });
    await expect
      .poll(() => events.length, { timeout: 250, interval: 25 })
      .toBe(1);
  });

  it("round-trips a device-code flow: device_code event and a text prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-device-"));
    roots.push(directory);
    const { client } = await startAuthControlPlane({
      directory,
      providers: [createDeviceCodeOAuthProvider()],
    });
    const eventLog: string[] = [];

    const pending = client.executeAuthCommand(
      { command: "login", providerId: "device-provider", authType: "oauth" },
      (event) => {
        eventLog.push(event.type);
        if (event.type === "device_code") {
          expect(event.userCode).toBe("FAKE-USER-CODE");
          expect(event.verificationUri).toBe("https://fixture.invalid/verify");
          expect(event.intervalSeconds).toBe(5);
          expect(event.expiresInSeconds).toBe(600);
        }
        if (event.type === "prompt" && event.kind === "text") {
          void client
            .respondAuthInteraction({
              type: "prompt_response",
              promptId: event.promptId,
              value: "CONFIRM",
            })
            .catch(() => undefined);
        }
      },
    );
    const result = await pending;
    expect(result.outcome).toBe("ok");
    expect(eventLog).toEqual(["device_code", "prompt"]);
    const onDisk = JSON.parse(await readFile(join(directory, "auth.json"), "utf8"));
    expect(onDisk["device-provider"].type).toBe("oauth");
    expect(JSON.stringify(result)).not.toContain("FAKE-USER-CODE");
  });

  it("round-trips a select prompt and a secret API-key prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-select-"));
    roots.push(directory);
    const { client } = await startAuthControlPlane({
      directory,
      providers: [createSelectOAuthProvider(), createSecretApiKeyProvider()],
    });

    const eventLog: string[] = [];
    const selectResult = await client.executeAuthCommand(
      { command: "login", providerId: "select-provider", authType: "oauth" },
      (event) => {
        eventLog.push(event.type);
        if (event.type === "prompt" && event.kind === "select") {
          expect(event.options).toEqual([
            { id: "browser", label: "Browser", description: "Recommended" },
            { id: "device", label: "Device code" },
          ]);
          void client
            .respondAuthInteraction({
              type: "prompt_response",
              promptId: event.promptId,
              value: "browser",
            })
            .catch(() => undefined);
        }
      },
    );
    expect(selectResult.outcome).toBe("ok");
    expect(eventLog).toEqual(["prompt"]);

    const secretLog: string[] = [];
    const secretResult = await client.executeAuthCommand(
      { command: "login", providerId: "secret-provider", authType: "api_key" },
      (event) => {
        secretLog.push(event.type);
        if (event.type === "prompt" && event.kind === "secret") {
          void client
            .respondAuthInteraction({
              type: "prompt_response",
              promptId: event.promptId,
              value: "sk-secret-typed",
            })
            .catch(() => undefined);
        }
      },
    );
    expect(secretResult.outcome).toBe("ok");
    expect(secretLog).toEqual(["prompt"]);
    const onDisk = JSON.parse(await readFile(join(directory, "auth.json"), "utf8"));
    expect(onDisk["secret-provider"]).toEqual({
      type: "api_key",
      key: "sk-secret-typed",
    });
    expect(JSON.stringify(secretResult)).not.toContain("sk-secret-typed");
  });

  it("cancels a pending login value-safely: no credential is written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-cancel-"));
    roots.push(directory);
    const { client, path } = await startAuthControlPlane({ directory });

    const pending = client.executeAuthCommand(
      { command: "login", providerId: "browser-provider", authType: "oauth" },
      (event) => {
        if (event.type === "prompt" && event.kind === "manual_code") {
          void client
            .respondAuthInteraction({ type: "cancel" })
            .catch(() => undefined);
        }
      },
    );
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    expect(result.error).toBe("Sign-in was cancelled");
    // No credential was written and the file was never created.
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.state.providers.find((row) => row.providerId === "browser-provider"))
      .toMatchObject({ stored: false });
  });

  it("fails with a fixed value-safe error that never leaks the raw failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-fail-"));
    roots.push(directory);
    const { client, path } = await startAuthControlPlane({
      directory,
      providers: [createFailingOAuthProvider()],
    });

    const result = await client.executeAuthCommand({
      command: "login",
      providerId: "failing-provider",
      authType: "oauth",
    });
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe(
      "Sign-in did not complete. Check the Provider's requirements and try again.",
    );
    // The raw upstream message ("Upstream sign-in rejected the request")
    // never crosses the wire.
    expect(JSON.stringify(result)).not.toContain("Upstream sign-in rejected");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replaces an existing credential atomically and preserves unrelated slots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-repl-"));
    roots.push(directory);
    const { client, path } = await startAuthControlPlane({
      directory,
      providers: [
        createBrowserOAuthProvider(),
        createSecretApiKeyProvider({ id: "other-provider" }),
      ],
    });
    // Existing stored credential for the target Provider (Ticket 12 path).
    await client.executeCredentialCommand({
      command: "login",
      providerId: "browser-provider",
      expectedRevision: 0,
      value: "sk-old-key",
      overwrite: true,
    });
    // And one for an unrelated Provider that must survive.
    await client.executeCredentialCommand({
      command: "login",
      providerId: "other-provider",
      expectedRevision: 1,
      value: "sk-other-key",
      overwrite: true,
    });

    const pending = client.executeAuthCommand(
      { command: "login", providerId: "browser-provider", authType: "oauth" },
      (event) => {
        if (event.type === "prompt" && event.kind === "manual_code") {
          void client
            .respondAuthInteraction({
              type: "prompt_response",
              promptId: event.promptId,
              value: FAKE_AUTH_CODE,
            })
            .catch(() => undefined);
        }
      },
    );
    const result = await pending;
    expect(result.outcome).toBe("ok");
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk["browser-provider"].type).toBe("oauth");
    expect(onDisk["other-provider"]).toEqual({
      type: "api_key",
      key: "sk-other-key",
    });
  });

  it("rejects unknown Providers, unsupported logins and concurrent logins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-reject-"));
    roots.push(directory);
    const { client } = await startAuthControlPlane({
      directory,
      providers: [createAmbientOnlyProvider(), createSecretApiKeyProvider()],
    });

    const unknown = await client.executeAuthCommand({
      command: "login",
      providerId: "no-such-provider",
      authType: "oauth",
    });
    expect(unknown.outcome).toBe("unknown_provider");

    const unsupported = await client.executeAuthCommand({
      command: "login",
      providerId: "ambient-only-provider",
      authType: "oauth",
    });
    expect(unsupported.outcome).toBe("unsupported");

    // A second login on the same connection while one is pending is
    // refused instead of racing the Provider-owned flow.
    const first = client.executeAuthCommand(
      { command: "login", providerId: "secret-provider", authType: "api_key" },
      () => undefined,
    );
    // Wait until the first flow is pending before racing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await client.executeAuthCommand({
      command: "login",
      providerId: "secret-provider",
      authType: "api_key",
    });
    expect(second.outcome).toBe("conflict");
    // The first flow is still pending: cancel it.
    await client.respondAuthInteraction({ type: "cancel" });
    await expect(first).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("expired login is actionable and a refresh failure never deletes a still-valid unrelated credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-expired-"));
    roots.push(directory);
    const { client, models, path } = await startAuthControlPlane({
      directory,
      providers: [createExpiredOAuthProvider()],
    });

    // An expired stored OAuth credential plus a still-valid unrelated one.
    const store = createFileCredentialStore(path);
    await store.casWrite("expired-provider", undefined, {
      type: "oauth",
      refresh: "refresh-expired",
      access: "access-expired",
      expires: 1,
    });
    await store.casWrite("unrelated-provider", undefined, {
      type: "api_key",
      key: "sk-still-valid",
    });
    await client.executeCredentialCommand({ command: "query" });

    // The effective status exposes the expired login (actionable, non-secret).
    const queried = await client.executeAuthCommand({ command: "query" });
    const expired = queried.options?.providers.find(
      (row) => row.providerId === "expired-provider",
    );
    expect(expired?.status).toMatchObject({
      stored: true,
      storedType: "oauth",
      expired: true,
      effectiveSource: "stored",
    });
    expect(JSON.stringify(queried)).not.toContain("refresh-expired");
    expect(JSON.stringify(queried)).not.toContain("access-expired");

    // Request-path refresh failure (invalid_grant): the stored credential
    // is preserved for retry — re-login fixes it, nothing is deleted.
    await expect(models.getAuth("expired-provider")).rejects.toMatchObject({
      name: "ModelsError",
    });
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after["expired-provider"]).toMatchObject({
      type: "oauth",
      refresh: "refresh-expired",
    });
    expect(after["unrelated-provider"]).toEqual({
      type: "api_key",
      key: "sk-still-valid",
    });
    void client;
  });

  it("a dropped connection aborts the in-flight login and reconnect starts clean", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-drop-"));
    roots.push(directory);
    const { host, client, path } = await startAuthControlPlane({ directory });
    const eventLog: string[] = [];
    const pending = client.executeAuthCommand(
      { command: "login", providerId: "browser-provider", authType: "oauth" },
      (event) => {
        eventLog.push(event.type);
      },
    );
    // Wait for the flow to be pending, then drop the connection while the
    // user never responds.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.close().catch(() => undefined);
    await expect(pending).rejects.toThrow(/Control Plane/);
    expect(eventLog).toContain("prompt");

    // A fresh connection reads a safe current snapshot (never a replay of
    // the incomplete interaction history) and the file was never written.
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const fresh = await connectControlPlane(host.endpoint, {
      createRequestId: () => `auth-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    const hello = await fresh.hello(1);
    if (hello.type !== "compatible") {
      throw new Error("Control Plane hello failed");
    }
    const queried = await fresh.executeAuthCommand({ command: "query" });
    expect(queried.outcome).toBe("ok");
    expect(queried.options?.providers).toHaveLength(1);
    await fresh.close();
  });

  it("logs out through the Ticket 12 credential channel without touching unrelated Providers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cp-logout-"));
    roots.push(directory);
    const { client, path } = await startAuthControlPlane({ directory });
    const store = createFileCredentialStore(path);
    await store.casWrite("browser-provider", undefined, {
      type: "oauth",
      refresh: "refresh-a",
      access: "access-a",
      expires: Date.now() + 3_600_000,
    });
    await store.casWrite("unrelated-provider", undefined, {
      type: "api_key",
      key: "sk-keep",
    });
    const queried = await client.executeCredentialCommand({ command: "query" });
    const removed = await client.executeCredentialCommand({
      command: "logout",
      providerId: "browser-provider",
      expectedRevision: queried.revision,
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.changed).toBe(true);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk["browser-provider"]).toBeUndefined();
    expect(onDisk["unrelated-provider"]).toEqual({
      type: "api_key",
      key: "sk-keep",
    });
  });

  it("serves the CLI auth commands through the same Control Plane contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cli-"));
    roots.push(directory);
    const { host, path } = await startAuthControlPlane({ directory });
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(host.endpoint), "utf8");

    async function runCli(
      args: readonly string[],
      input?: string,
    ): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
      const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("exit", (exitCode) => resolvePromise(exitCode));
      });
      return { code, stdout, stderr };
    }

    const queried = await runCli([
      "control",
      "auth",
      "query",
      "--descriptor",
      descriptorPath,
    ]);
    expect(queried.code).toBe(0);
    const options = JSON.parse(queried.stdout);
    expect(options.outcome).toBe("ok");
    expect(options.options.providers[0]).toMatchObject({
      providerId: "browser-provider",
      account: true,
    });
    expect(queried.stdout).not.toContain(FAKE_AUTH_CODE);

    // The browser flow: the CLI prints the auth URL and answers the
    // manual_code prompt from stdin.
    const loggedIn = await runCli(
      [
        "control",
        "auth",
        "login",
        "browser-provider",
        "account",
        "--descriptor",
        descriptorPath,
      ],
      `${FAKE_AUTH_CODE}\n`,
    );
    expect(loggedIn.code).toBe(0);
    expect(loggedIn.stdout).toContain("Open this URL in a browser");
    expect(loggedIn.stdout).toContain("Signed in to browser-provider");
    expect(loggedIn.stdout).not.toContain(FAKE_AUTH_CODE);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk["browser-provider"].type).toBe("oauth");

    // An empty answer cancels the sign-in (exit 0, nothing written).
    await rm(path, { force: true });
    const cancelled = await runCli(
      [
        "control",
        "auth",
        "login",
        "browser-provider",
        "account",
        "--descriptor",
        descriptorPath,
      ],
      "\n",
    );
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain("Sign-in cancelled");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 120_000);

  it("serves a secret API-key login through the CLI with masked input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-cli-key-"));
    roots.push(directory);
    const { host, path } = await startAuthControlPlane({
      directory,
      providers: [createSecretApiKeyProvider()],
    });
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(host.endpoint), "utf8");

    const child = spawn(
      process.execPath,
      [
        tsxCli,
        "src/cli.ts",
        "control",
        "auth",
        "login",
        "secret-provider",
        "api-key",
        "--descriptor",
        descriptorPath,
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    children.push(child);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stdin.write("sk-cli-masked-secret\n");
    child.stdin.end();
    const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (exitCode) => resolvePromise(exitCode));
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Signed in to secret-provider");
    expect(stdout).not.toContain("sk-cli-masked-secret");
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk["secret-provider"]).toEqual({
      type: "api_key",
      key: "sk-cli-masked-secret",
    });
  }, 120_000);
});
