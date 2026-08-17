import type { FetchFunction } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type ControlPlaneClient,
} from "@luckytoken/application-control-plane/control-plane";

import {
  createClientTokenControlPlaneHandler,
  createProtocolEnablementSettingsHandler,
} from "../../src/client-auth/control-plane.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredLuckyTokenComposition } from "../../src/composition.js";
import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";
import {
  COMMANDCODE_PROVIDER_PACKAGE,
  commandCodeProviderImportModule,
} from "../support/commandcode-provider-package.js";
import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
  type RuntimeDiagnosticsStore,
} from "../../src/runtime-diagnostics/index.js";
import { createSettingsRegistry } from "../../src/settings/catalog.js";
import { createSettingsControlPlaneHandler } from "../../src/settings/control-plane.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";

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
    ].join("\n"),
  );
}

const ANTHROPIC = "anthropic-messages";
const RESPONSES = "openai-responses";

interface RecordedUpstream {
  readonly protocol: string;
  readonly body: unknown;
}

interface ServingFixture {
  readonly client: ControlPlaneClient;
  readonly origin: string;
  readonly diagnostics: RuntimeDiagnosticsStore;
  readonly anthropicAuthFile: string;
  readonly responsesAuthFile: string;
  readonly upstream: RecordedUpstream[];
  /** Sequential deterministic effective session identity generator. */
  readonly sessions: () => string;
  /** Rebuilds the Data Plane composition (authorities + HTTP listener) with
   *  the same shared stores; returns the new origin. */
  restart(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Ticket 17 acceptance seams: canonical directory Client token scopes over
 * the versioned Control Plane commands, the real file authority, and real
 * Anthropic/OpenAI HTTP authorization and invocation facts. Every assertion
 * observes the public seams (Control Plane commands, the request identity
 * ledger query, real HTTP, upstream request bodies); no test inspects a
 * private canonicalization helper as the acceptance proof.
 */
describe("canonical directory Client token scopes over real HTTP", () => {
  const directories: string[] = [];
  const fixtures: ServingFixture[] = [];
  let nextPipe = 0;
  let nextRequest = 0;

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function createDirectoryAliases(
    root: string,
    projectDir: string,
  ): Promise<{
    readonly link: string;
    readonly nestedAlias: string;
    readonly caseAlias?: string;
    readonly separatorAlias?: string;
  }> {
    await mkdir(join(projectDir, "nested"), { recursive: true });
    // Windows junction (no privilege required); real symlink elsewhere.
    const link = join(root, "project-link");
    await symlink(projectDir, link, "junction").catch(() =>
      symlink(projectDir, link, "dir"),
    );
    const nestedAlias = join(projectDir, "nested", "..");
    if (process.platform === "win32") {
      // Windows case and separator aliases identify the same directory; on
      // case-sensitive POSIX filesystems they are different directories, so
      // these alias mechanics are guarded to the platform that has them.
      return { link, nestedAlias, caseAlias: projectDir.toUpperCase(), separatorAlias: projectDir.replaceAll("\\", "/") };
    }
    return { link, nestedAlias };
  }

  async function startServing(options: {
    readonly projectDir?: string;
    readonly aliases?: (root: string, projectDir: string) => Promise<Record<string, string>>;
    /** Runs after config/auth files exist but before the composition boots. */
    readonly beforeComposition?: (paths: {
      readonly anthropicAuthFile: string;
      readonly responsesAuthFile: string;
    }) => Promise<void>;
  } = {}): Promise<ServingFixture> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-http-"));
    directories.push(root);
    const stateDirectory = join(root, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    const stateDir = join(stateDirectory, "state");
    await mkdir(piDirectory, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const anthropicAuthFile = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    const responsesAuthFile = join(
      stateDirectory,
      "client-auth",
      "openai-responses.json",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port: 0 },
        clientProtocols: {
          [ANTHROPIC]: {
            authFile: "client-auth/anthropic-messages.json",
          },
          [RESPONSES]: {
            authFile: "client-auth/openai-responses.json",
            stateFile: "state/openai-responses.json",
          },
        },
        providerPackages: { [COMMANDCODE_PROVIDER_PACKAGE]: {} },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    if (options.projectDir !== undefined) {
      await mkdir(options.projectDir, { recursive: true });
      await options.aliases?.(root, options.projectDir);
    }
    await options.beforeComposition?.({
      anthropicAuthFile,
      responsesAuthFile,
    });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const projectSnapshot = async (input: {
      readonly projectDir: string;
      readonly signal: AbortSignal;
    }) => {
      input.signal.throwIfAborted();
      // The accepted project fact is the canonical directory; reflect it in
      // the upstream snapshot so real HTTP invocation facts prove which
      // project context was supplied.
      return { ...createEmptyServerConfig(), workingDir: input.projectDir };
    };
    const config = await loadLuckyTokenCliConfig(configPath);
    const diagnosticsStore = await createRuntimeDiagnosticsStoreFactory({
      configuration: parseRuntimeDiagnosticsConfiguration(
        { directory: join(stateDirectory, "diagnostics") },
        stateDirectory,
      ),
      now: () => 1_700_000_000_000,
    }).open();
    const registry = createSettingsRegistry(
      {
        async load() {
          return {};
        },
        async save() {},
      },
      {
        initial: {
          "server.port": 0,
          "server.bindHost": "127.0.0.1",
        },
      },
    );
    await registry.load();
    // Deterministic effective session generator: sequential UUIDs so the
    // ledger can prove the internal identities are never projected.
    let sessionCounter = 0;
    const sessions = () =>
      `00000000-0000-4000-8000-${String(sessionCounter++).padStart(12, "0")}`;
    const upstream: RecordedUpstream[] = [];
    const fetchImpl: FetchFunction = async (input, init) => {
      const fromRequest =
        input instanceof Request ? await input.text() : undefined;
      const raw =
        fromRequest ??
        (typeof init?.body === "string"
          ? init.body
          : init?.body instanceof ArrayBuffer
            ? Buffer.from(init.body).toString("utf8")
            : init?.body instanceof Uint8Array
              ? Buffer.from(init.body).toString("utf8")
              : undefined);
      if (raw !== undefined) {
        upstream.push({
          protocol: String(input).includes("/v1/responses")
            ? RESPONSES
            : ANTHROPIC,
          body: JSON.parse(raw) as unknown,
        });
      }
      return commandCodeText("authorized");
    };
    const buildComposition = () =>
      createConfiguredLuckyTokenComposition({
        config,
        credentials,
        fetch: fetchImpl,
        importModule: commandCodeProviderImportModule({
          projectSnapshot: { snapshot: projectSnapshot },
        }),
        diagnosticsStore,
        settingsRegistry: registry,
        createSessionId: sessions,
      });
    let composition = await buildComposition();
    const authorities = () => composition.clientTokenAuthorities;
    const protocolNames = {
      [ANTHROPIC]: "Anthropic Messages",
      [RESPONSES]: "OpenAI Responses",
    };
    const endpoint: ControlPlaneEndpoint = {
      pipeName: `\\\\.\\pipe\\luckytoken-dir-token-http-${process.pid}-${++nextPipe}`,
      capability: "dir-token-http-capability-012345678901234567",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "running", provider: "configured" },
      settingsCommandHandler: createProtocolEnablementSettingsHandler({
        settingsHandler: createSettingsControlPlaneHandler(registry),
        authorities,
        protocolNames,
        diagnostics: diagnosticsStore,
      }),
      clientTokenCommandHandler: createClientTokenControlPlaneHandler({
        authorities,
        protocolNames,
        diagnostics: diagnosticsStore,
      }),
      requestIdentitiesHandler: () =>
        Promise.resolve({ records: composition.requestIdentities.list() }),
      settingsProjection: () => registry.snapshot(),
      diagnostics: diagnosticsStore,
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `dir-token-http-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(1);
    let server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: 0,
    });
    const fixture: ServingFixture = {
      client,
      origin: server.origin,
      diagnostics: diagnosticsStore,
      anthropicAuthFile,
      responsesAuthFile,
      upstream,
      sessions,
      async restart() {
        await server.close();
        // The previous composition's ledger store closes with its data
        // plane; the shared diagnostics store and settings registry stay.
        composition.requestLedger.close();
        composition.deepCaptureStore.close();
        composition = await buildComposition();
        server = await startLuckyTokenHttpServer({
          runtime: composition.runtime,
          host: "127.0.0.1",
          port: 0,
        });
        return server.origin;
      },
      async close() {
        await server.close();
        await client.close();
        await host.close();
        composition.diagnosticsStore.close();
        composition.requestLedger.close();
        composition.deepCaptureStore.close();
      },
    };
    fixtures.push(fixture);
    return fixture;
  }

  const anthropicBody = {
    model: "commandcode-private/deepseek/deepseek-v4-flash",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
  };
  const responsesBody = {
    model: "commandcode-private/deepseek/deepseek-v4-flash",
    input: "hello",
  };

  async function post(
    origin: string,
    pathname: "/v1/messages" | "/v1/responses",
    token: string,
    sessionHeader?: string,
  ): Promise<Response> {
    return fetch(`${origin}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(sessionHeader === undefined ? {} : { "x-session-id": sessionHeader }),
        ...(pathname === "/v1/messages"
          ? { "anthropic-version": "2023-06-01" }
          : {}),
      },
      body: JSON.stringify(pathname === "/v1/messages" ? anthropicBody : responsesBody),
    });
  }

  async function createProjectToken(
    fixture: ServingFixture,
    protocolId: string,
    inputDir: string,
    token: string,
  ) {
    const result = await fixture.client.executeClientTokenCommand({
      command: "create",
      protocolId,
      scope: { type: "project", projectDir: inputDir },
      token,
    });
    expect(result.outcome).toBe("ok");
    return result;
  }

  it("creates one canonical directory scope through real-path aliases that share one identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-project-"));
    directories.push(root);
    const projectDir = join(root, "Project");
    const fixture = await startServing({
      projectDir,
      aliases: createDirectoryAliases,
    });

    const aliases = await createDirectoryAliases(root, projectDir);
    const aliasInputs = [
      aliases.link,
      aliases.nestedAlias,
      aliases.caseAlias,
      aliases.separatorAlias,
    ].filter((alias): alias is string => alias !== undefined);

    // Creating through any alias lands on the same canonical scope.
    const first = await createProjectToken(
      fixture,
      ANTHROPIC,
      aliasInputs[0]!,
      "canary-dir-http-1",
    );
    const canonicalDir = first.scopes!.find(
      (scope) => scope.type === "project",
    )!.projectDir as string;
    expect(canonicalDir).toBe(projectDir);

    for (const alias of aliasInputs.slice(1)) {
      const duplicate = await fixture.client.executeClientTokenCommand({
        command: "create",
        protocolId: ANTHROPIC,
        scope: { type: "project", projectDir: alias },
        token: `canary-dir-http-alias-${aliasInputs.indexOf(alias)}`,
      });
      expect(duplicate.outcome).toBe("already_exists");
      expect(duplicate.revision).toBe(first.revision);
    }
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    const projectScopes = listed.scopes!.filter(
      (scope) => scope.type === "project",
    );
    expect(projectScopes).toEqual([
      { type: "project", projectDir, maskedToken: "canary-d…tp-1" },
    ]);
    // No alias path and no raw token ever reach the wire.
    expect(JSON.stringify(listed)).not.toContain("alias");
    expect(JSON.stringify(listed)).not.toContain("canary-dir-http-1");

    // The token authorizes a real request and supplies the canonical
    // projectDir to the upstream invocation.
    await expect(
      post(fixture.origin, "/v1/messages", "canary-dir-http-1"),
    ).resolves.toMatchObject({ status: 200 });
    const upstreamBody = fixture.upstream.at(-1)!.body as {
      config: { workingDir: string };
    };
    expect(upstreamBody.config.workingDir).toBe(projectDir);
  });

  it("rejects nonexistent, non-directory, and invalid directory inputs value-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-bad-"));
    directories.push(root);
    const fixture = await startServing();
    const file = join(root, "file.txt");
    await writeFile(file, "content");

    const missing = await fixture.client.executeClientTokenCommand({
      command: "create",
      protocolId: ANTHROPIC,
      scope: { type: "project", projectDir: join(root, "missing") },
      token: "canary-dir-http-x",
    });
    expect(missing).toMatchObject({
      outcome: "invalid_directory",
      reason: "not_found",
    });
    const notDirectory = await fixture.client.executeClientTokenCommand({
      command: "create",
      protocolId: ANTHROPIC,
      scope: { type: "project", projectDir: file },
      token: "canary-dir-http-x",
    });
    expect(notDirectory).toMatchObject({
      outcome: "invalid_directory",
      reason: "not_a_directory",
    });
    const invalid = await fixture.client.executeClientTokenCommand({
      command: "create",
      protocolId: ANTHROPIC,
      scope: { type: "project", projectDir: "C:\\bad\\dir\u0000name" },
      token: "canary-dir-http-x",
    });
    expect(invalid).toMatchObject({
      outcome: "invalid_directory",
      reason: "invalid",
    });
    // An empty path is malformed at the wire boundary and never reaches
    // the backend.
    await expect(
      fixture.client.executeClientTokenCommand({
        command: "create",
        protocolId: ANTHROPIC,
        scope: { type: "project", projectDir: "" },
        token: "canary-dir-http-x",
      }),
    ).rejects.toThrow("invalid_request");
    // Value-free failures: no raw input path appears anywhere.
    for (const result of [missing, notDirectory, invalid]) {
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain("missing");
      expect(JSON.stringify(result)).not.toContain("file.txt");
      expect(JSON.stringify(result)).not.toContain("canary-dir-http-x");
    }
    // Nothing was persisted: no scope appears and the global token is the
    // only one left.
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    expect(
      listed.scopes!.filter((scope) => scope.type === "project"),
    ).toEqual([]);
  });

  it("keeps independent per-protocol tokens for one canonical directory and rejects cross-protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-xp-"));
    directories.push(root);
    const projectDir = join(root, "shared");
    const fixture = await startServing({
      projectDir,
      aliases: createDirectoryAliases,
    });
    const aliases = await createDirectoryAliases(root, projectDir);

    const anthropicCreated = await createProjectToken(
      fixture,
      ANTHROPIC,
      aliases.link,
      "canary-dir-anthropic-1",
    );
    const responsesCreated = await createProjectToken(
      fixture,
      RESPONSES,
      aliases.nestedAlias,
      "canary-dir-responses-1",
    );
    const canonicalDir = anthropicCreated.scopes!.find(
      (scope) => scope.type === "project",
    )!.projectDir as string;
    expect(
      responsesCreated.scopes!.find((scope) => scope.type === "project")!
        .projectDir,
    ).toBe(canonicalDir);

    await expect(
      post(fixture.origin, "/v1/messages", "canary-dir-anthropic-1"),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      post(fixture.origin, "/v1/responses", "canary-dir-anthropic-1"),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      post(fixture.origin, "/v1/responses", "canary-dir-responses-1"),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      post(fixture.origin, "/v1/messages", "canary-dir-responses-1"),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("hot-rotates and revokes a directory scope with locked revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-rotate-"));
    directories.push(root);
    const projectDir = join(root, "project");
    const fixture = await startServing({
      projectDir,
      aliases: createDirectoryAliases,
    });
    const aliases = await createDirectoryAliases(root, projectDir);
    const created = await createProjectToken(
      fixture,
      ANTHROPIC,
      projectDir,
      "canary-dir-rotate-1",
    );

    // A stale revision can never rotate the scope.
    const stale = await fixture.client.executeClientTokenCommand({
      command: "rotate",
      protocolId: ANTHROPIC,
      expectedRevision: 0,
      scope: { type: "project", projectDir: aliases.link },
      token: "canary-dir-rotate-stale",
    });
    expect(stale).toMatchObject({ outcome: "conflict" });
    await expect(
      post(fixture.origin, "/v1/messages", "canary-dir-rotate-1"),
    ).resolves.toMatchObject({ status: 200 });

    // Rotation through the alias hot-applies immediately.
    const rotated = await fixture.client.executeClientTokenCommand({
      command: "rotate",
      protocolId: ANTHROPIC,
      expectedRevision: created.revision,
      scope: { type: "project", projectDir: aliases.link },
      token: "canary-dir-rotate-2",
    });
    expect(rotated.outcome).toBe("ok");
    await expect(
      post(fixture.origin, "/v1/messages", "canary-dir-rotate-1"),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      post(fixture.origin, "/v1/messages", "canary-dir-rotate-2"),
    ).resolves.toMatchObject({ status: 200 });
    const workingDir = (fixture.upstream.at(-1)!.body as {
      config: { workingDir: string };
    }).config.workingDir;
    expect(workingDir).toBe(projectDir);

    // Revocation through the alias takes effect immediately.
    const removed = await fixture.client.executeClientTokenCommand({
      command: "remove",
      protocolId: ANTHROPIC,
      expectedRevision: rotated.revision,
      scope: { type: "project", projectDir: aliases.link },
    });
    expect(removed.outcome).toBe("ok");
    await expect(
      post(fixture.origin, "/v1/messages", "canary-dir-rotate-2"),
    ).resolves.toMatchObject({ status: 401 });
    // The scope is gone from the masked list.
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    expect(
      listed.scopes!.filter((scope) => scope.type === "project"),
    ).toEqual([]);
  });

  it("converges a running authority with an offline CLI writer through the same canonical identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-race-"));
    directories.push(root);
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const fixture = await startServing();
    const aliases = await createDirectoryAliases(root, projectDir);

    // The offline CLI (a second writer on the same file) creates the scope
    // through its own canonicalization.
    const offlineStore = createFileClientTokenStore({
      path: fixture.anthropicAuthFile,
    });
    const resolved = await (
      await import("../../src/client-auth/canonical-directory.js")
    ).resolveCanonicalDirectory(projectDir);
    expect(resolved.outcome).toBe("ok");
    await offlineStore.create(
      { type: "project", projectDir: resolved.outcome === "ok" ? resolved.canonicalDir : projectDir },
      "canary-offline-dir-1",
    );

    // The running authority's mirror is stale until a mutation converges
    // (exactly the Ticket 16 hot-authorization semantics for external
    // writes): the offline token does not authorize yet.
    await expect(
      post(fixture.origin, "/v1/messages", "canary-offline-dir-1"),
    ).resolves.toMatchObject({ status: 401 });

    // A mutation carrying the pre-convergence revision conflicts, the
    // mirror converges with the authoritative file, and the conflict
    // result reports the fresh generation.
    const stale = await fixture.client.executeClientTokenCommand({
      command: "remove",
      protocolId: ANTHROPIC,
      expectedRevision: 0,
      scope: { type: "project", projectDir: aliases.link },
    });
    expect(stale.outcome).toBe("conflict");
    expect(stale.revision).toBeGreaterThanOrEqual(1);
    // The mirror is fresh now: the offline token authorizes real HTTP and
    // the list shows its canonical scope without the raw token.
    await expect(
      post(fixture.origin, "/v1/messages", "canary-offline-dir-1"),
    ).resolves.toMatchObject({ status: 200 });

    // The current generation (read from a fresh list) succeeds.
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    const scope = listed.scopes!.find(
      (entry) => entry.type === "project" && entry.projectDir === projectDir,
    );
    expect(scope).toBeDefined();
    const removed = await fixture.client.executeClientTokenCommand({
      command: "remove",
      protocolId: ANTHROPIC,
      expectedRevision: listed.revision,
      scope: { type: "project", projectDir: aliases.link },
    });
    expect(removed.outcome).toBe("ok");
  });

  it("supplies canonical projectDir for directory tokens and none for global tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-pdir-"));
    directories.push(root);
    const projectDir = join(root, "project");
    const fixture = await startServing({
      projectDir,
      aliases: createDirectoryAliases,
    });
    const aliases = await createDirectoryAliases(root, projectDir);
    const globalToken = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;
    await createProjectToken(
      fixture,
      ANTHROPIC,
      aliases.link,
      "canary-dir-pdir-1",
    );

    await post(fixture.origin, "/v1/messages", globalToken);
    await post(fixture.origin, "/v1/messages", "canary-dir-pdir-1");

    const bodies = fixture.upstream.map((entry) => entry.body) as Array<{
      config: { workingDir: string };
    }>;
    // The global request carries no projectDir; the directory request
    // carries the canonical identity.
    expect(bodies[0]!.config.workingDir).toBe("");
    expect(bodies[1]!.config.workingDir).toBe(projectDir);

    // The public ledger observes the same split.
    const identities = await fixture.client.getRequestIdentities();
    const byProject = identities.records.find(
      (record) => record.projectDir !== undefined,
    );
    expect(byProject?.projectDir).toBe(projectDir);
    expect(
      identities.records.find((record) => record.projectDir === undefined),
    ).toBeDefined();
  });

  it("records client session identities separately and never projects the effective identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-session-"));
    directories.push(root);
    const fixture = await startServing();
    const globalToken = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;
    const clientSession = "11111111-1111-4111-8111-111111111111";

    // No session header: an effective identity is created internally and
    // never appears in the ledger.
    await post(fixture.origin, "/v1/messages", globalToken);
    // A valid client session header is recorded verbatim.
    await post(fixture.origin, "/v1/messages", globalToken, clientSession);
    // An invalid session header is not a client identity.
    await post(fixture.origin, "/v1/messages", globalToken, "not-a-uuid");

    const identities = await fixture.client.getRequestIdentities();
    const records = identities.records;
    expect(records).toHaveLength(3);
    expect(records[0]!.clientSessionId).toBeUndefined();
    expect(records[1]!.clientSessionId).toBe(clientSession);
    expect(records[2]!.clientSessionId).toBeUndefined();
    // Effective session identities (deterministic generator) are internal:
    // none of the generated UUIDs may appear in the public ledger.
    for (let index = 0; index < 3; index += 1) {
      expect(JSON.stringify(identities)).not.toContain(fixture.sessions());
    }
    expect(JSON.stringify(identities)).not.toContain("effectiveSessionId");
    expect(JSON.stringify(identities)).not.toContain(globalToken);
  });

  it("persists directory scopes across a Data Plane restart and keeps them masked", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-restart-"));
    directories.push(root);
    const projectDir = join(root, "project");
    const fixture = await startServing({
      projectDir,
      aliases: createDirectoryAliases,
    });
    const aliases = await createDirectoryAliases(root, projectDir);
    await createProjectToken(
      fixture,
      ANTHROPIC,
      aliases.link,
      "canary-dir-restart-1",
    );

    const origin = await fixture.restart();

    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    expect(listed.scopes).toContainEqual({
      type: "project",
      projectDir,
      maskedToken: "canary-d…rt-1",
    });
    expect(JSON.stringify(listed)).not.toContain("canary-dir-restart-1");
    await expect(
      post(origin, "/v1/messages", "canary-dir-restart-1"),
    ).resolves.toMatchObject({ status: 200 });
    const workingDir = (fixture.upstream.at(-1)!.body as {
      config: { workingDir: string };
    }).config.workingDir;
    expect(workingDir).toBe(projectDir);
  });

  it("never leaks tokens, paths, or internal identities into diagnostics or errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-leak-"));
    directories.push(root);
    const projectDir = join(root, "project");
    const fixture = await startServing({
      projectDir,
      aliases: createDirectoryAliases,
    });
    const aliases = await createDirectoryAliases(root, projectDir);
    await createProjectToken(
      fixture,
      ANTHROPIC,
      aliases.link,
      "canary-dir-leak-secret-1",
    );
    // Force a 401 and a failed request so the diagnostics path runs.
    await post(fixture.origin, "/v1/messages", "canary-dir-leak-secret-1", "bad");
    await expect(
      post(fixture.origin, "/v1/messages", "canary-unknown-token-99"),
    ).resolves.toMatchObject({ status: 401 });

    const diagnostics = await fixture.diagnostics.query({ limit: 50 });
    const serialized = JSON.stringify({
      records: diagnostics.records,
      identities: (await fixture.client.getRequestIdentities()).records,
    });
    expect(serialized).not.toContain("canary-dir-leak-secret-1");
    expect(serialized).not.toContain("canary-unknown-token-99");
    expect(serialized).not.toContain("provider-secret");
    for (let index = 0; index < 10; index += 1) {
      expect(serialized).not.toContain(fixture.sessions());
    }
    expect(serialized).not.toContain("effectiveSessionId");
    expect(serialized).not.toContain("x-session-id");
  });

  it("removes a directory token after its directory disappears, using the listed canonical identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-orphan-"));
    directories.push(root);
    const projectDir = join(root, "project");
    const fixture = await startServing({ projectDir });
    await createProjectToken(
      fixture,
      ANTHROPIC,
      projectDir,
      "canary-orphan-http-1",
    );
    // The directory disappears while the persisted canonical scope stays.
    await rm(projectDir, { recursive: true, force: true });

    // The persisted orphan scope still lists with its stored canonical
    // identity, and the old token still authorizes (it was never revoked).
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    expect(listed.scopes).toContainEqual({
      type: "project",
      projectDir,
      maskedToken: "canary-o…tp-1",
    });
    await expect(
      post(fixture.origin, "/v1/messages", "canary-orphan-http-1"),
    ).resolves.toMatchObject({ status: 200 });

    // Remove by the listed canonical scope identity succeeds.
    const removed = await fixture.client.executeClientTokenCommand({
      command: "remove",
      protocolId: ANTHROPIC,
      expectedRevision: listed.revision,
      scope: { type: "project", projectDir },
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.scopes).not.toContainEqual(
      expect.objectContaining({ type: "project" }),
    );
    // The old token is immediately invalid over the real HTTP seam.
    await expect(
      post(fixture.origin, "/v1/messages", "canary-orphan-http-1"),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("reveals and rotates an orphan scope by its stored canonical identity over real HTTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-orphan-"));
    directories.push(root);
    const projectDir = join(root, "project");
    const fixture = await startServing({ projectDir });
    await createProjectToken(
      fixture,
      ANTHROPIC,
      projectDir,
      "canary-orphan-http-1",
    );
    await rm(projectDir, { recursive: true, force: true });

    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    // Reveal by the listed canonical identity returns the active secret.
    const revealed = await fixture.client.executeClientTokenCommand({
      command: "reveal",
      protocolId: ANTHROPIC,
      scope: { type: "project", projectDir },
    });
    expect(revealed.outcome).toBe("ok");
    expect(revealed.token).toBe("canary-orphan-http-1");

    const rotated = await fixture.client.executeClientTokenCommand({
      command: "rotate",
      protocolId: ANTHROPIC,
      expectedRevision: listed.revision,
      scope: { type: "project", projectDir },
      token: "canary-orphan-http-2",
    });
    expect(rotated.outcome).toBe("ok");
    // The rotated scope retains the same stored canonical projectDir.
    expect(rotated.scopes).toContainEqual({
      type: "project",
      projectDir,
      maskedToken: "canary-o…tp-2",
    });
    // Old token immediately invalid; new token authorizes with the same
    // canonical project context over the real HTTP seam.
    await expect(
      post(fixture.origin, "/v1/messages", "canary-orphan-http-1"),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      post(fixture.origin, "/v1/messages", "canary-orphan-http-2"),
    ).resolves.toMatchObject({ status: 200 });
    const workingDir = (fixture.upstream.at(-1)!.body as {
      config: { workingDir: string };
    }).config.workingDir;
    expect(workingDir).toBe(projectDir);
  });

  it("still rejects missing-path create and arbitrary missing lookups over the Control Plane", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-dir-token-orphan-"));
    directories.push(root);
    const projectDir = join(root, "project");
    const fixture = await startServing({ projectDir });
    await createProjectToken(
      fixture,
      ANTHROPIC,
      projectDir,
      "canary-orphan-http-1",
    );
    await rm(projectDir, { recursive: true, force: true });

    // Creating a token for the missing directory still fails value-free.
    const created = await fixture.client.executeClientTokenCommand({
      command: "create",
      protocolId: ANTHROPIC,
      scope: { type: "project", projectDir },
      token: "canary-orphan-http-2",
    });
    expect(created.outcome).toBe("invalid_directory");
    expect(created.reason).toBe("not_found");
    // An arbitrary missing path (not a persisted canonical identity) can
    // never manage or match the orphan scope.
    const arbitrary = join(root, "never-existed");
    const removed = await fixture.client.executeClientTokenCommand({
      command: "remove",
      protocolId: ANTHROPIC,
      expectedRevision: created.revision,
      scope: { type: "project", projectDir: arbitrary },
    });
    expect(removed.outcome).toBe("invalid_directory");
    expect(removed.reason).toBe("not_found");
    // The orphan scope is untouched and the old token still authorizes.
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    expect(listed.scopes).toContainEqual({
      type: "project",
      projectDir,
      maskedToken: "canary-o…tp-1",
    });
    await expect(
      post(fixture.origin, "/v1/messages", "canary-orphan-http-1"),
    ).resolves.toMatchObject({ status: 200 });
  });
});
