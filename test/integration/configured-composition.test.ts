import {
  InMemoryCredentialStore,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { createConfiguredLuckyTokenComposition } from "../../src/composition.js";
import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";
import {
  COMMANDCODE_PROVIDER_PACKAGE,
  commandCodeProviderImportModule,
} from "../support/commandcode-provider-package.js";

function commandCodeText(text: string): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      }),
    ].join("\n"),
  );
}

describe("configured serving composition", () => {
  const directories: string[] = [];
  const compositions: Array<{
    diagnosticsStore: { close(): void };
    requestLedger: { close(): void };
    deepCaptureStore: { close(): void };
  }> = [];

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

  async function writeConfiguration(
    clientScope: "global" | "project" = "global",
  ): Promise<{
    configPath: string;
    piDirectory: string;
    clientToken: string;
    projectDir?: string;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-composition-"));
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    const clientAuthPath = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await mkdir(piDirectory, { recursive: true });
    const projectDir =
      clientScope === "project" ? join(directory, "workspace") : undefined;
    if (projectDir !== undefined) await mkdir(projectDir);
    const clientToken = `local-${clientScope}-token`;
    await createFileClientTokenStore({
      path: clientAuthPath,
    }).create(
      projectDir === undefined
        ? { type: "global" }
        : { type: "project", projectDir },
      clientToken,
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        providerPackages: { [COMMANDCODE_PROVIDER_PACKAGE]: {} },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    return {
      configPath,
      piDirectory,
      clientToken,
      ...(projectDir === undefined ? {} : { projectDir }),
    };
  }

  it("registers the packaged CommandCode Provider hidden behind one Client Protocol", async () => {
    const upstreamRequests: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      if (String(input).includes("/provider/v1/models")) {
        return new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      upstreamRequests.push(new Request(input, init));
      return commandCodeText("configured through Pi");
    };
    const { configPath, piDirectory, clientToken } = await writeConfiguration();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const config = await loadLuckyTokenCliConfig(configPath);
    const composition = await createConfiguredLuckyTokenComposition({
      config,
      credentials,
      fetch,
      importModule: commandCodeProviderImportModule({
        projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
      }),
      createMessageId: () => "msg_configured",
      createSessionId: () => "00000000-0000-4000-8000-000000000250",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);

    expect(Object.keys(composition).sort()).toEqual([
      "catalog",
      "certification",
      "clientTokenAuthorities",
      "credentialAuthority",
      "deepCapture",
      "deepCaptureStore",
      "diagnosticsStore",
      "requestIdentities",
      "requestLedger",
      "runtime",
      "userConfiguredProviderIds",
    ]);
    // Ticket 16: the running Data Plane owns one live global token authority
    // per configured Client Protocol.
    expect(Object.keys(composition.clientTokenAuthorities).sort()).toEqual([
      "anthropic-messages",
    ]);
    expect(composition.userConfiguredProviderIds).toEqual([
      "commandcode-private",
    ]);
    expect(Object.keys(composition.runtime).sort()).toEqual([
      "handle",
      "routes",
    ]);
    expect(composition.runtime.routes).toEqual([
      { method: "POST", pathname: "/v1/messages" },
      { method: "GET", pathname: "/v1/models" },
    ]);
    expect(composition.certification.result).toBe("CERTIFIED");
    expect(composition.certification.providerRegistrationPolicy).toBe(
      "pi-builtins-models-json-provider-packages-v1",
    );
    expect(composition.certification.providerIds).toContain(
      "commandcode-private",
    );
    expect(composition.runtime).not.toHaveProperty("models");
    expect(composition.runtime).not.toHaveProperty("provider");

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${clientToken}`,
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "msg_configured",
      model: "commandcode-private/deepseek/deepseek-v4-flash",
      content: [{ type: "text", text: "configured through Pi" }],
    });
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe(
      "Bearer provider-secret",
    );
    await expect(access(join(piDirectory, "auth.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serves every packaged CommandCode model through the route", async () => {
    const fetch: FetchFunction = async () =>
      commandCodeText("served through Pi");
    const { configPath, clientToken } = await writeConfiguration();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const composition = await createConfiguredLuckyTokenComposition({
      config: await loadLuckyTokenCliConfig(configPath),
      credentials,
      fetch,
      importModule: commandCodeProviderImportModule({
        projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
      }),
      createMessageId: () => "msg_models",
      createSessionId: () => "00000000-0000-4000-8000-000000000251",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${clientToken}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "commandcode-private/gpt-5.6-luna",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      content: [{ type: "text", text: "served through Pi" }],
    });
  });

  it("projects one protocol-scoped client token into Pi without exposing Auth state", async () => {
    const { configPath, clientToken, projectDir } =
      await writeConfiguration("project");
    const projectSnapshot = vi.fn(
      async (input: {
        readonly projectDir: string;
        readonly signal: AbortSignal;
      }) => {
        input.signal.throwIfAborted();
        return createEmptyServerConfig();
      },
    );
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const composition = await createConfiguredLuckyTokenComposition({
      config: await loadLuckyTokenCliConfig(configPath),
      credentials,
      fetch: async () => commandCodeText("project authorized"),
      importModule: commandCodeProviderImportModule({
        projectSnapshot: { snapshot: projectSnapshot },
      }),
      createMessageId: () => "msg_project_auth",
      createSessionId: () => "00000000-0000-4000-8000-000000000251",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);

    expect(composition.certification.schemaVersion).toBe(
      "luckytoken-core-serving-certification-v1",
    );
    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${clientToken}`,
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

    expect(response.status).toBe(200);
    expect(projectSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir }),
    );
    const snapshotInput = projectSnapshot.mock.calls[0]?.[0];
    expect(Object.keys(snapshotInput ?? {}).sort()).toEqual([
      "projectDir",
      "signal",
    ]);
  });

  it("rejects an uninstalled Client Protocol only at the composition root", async () => {
    const { configPath } = await writeConfiguration();
    const loaded = await loadLuckyTokenCliConfig(configPath);
    const config = {
      ...loaded,
      clientProtocols: Object.freeze({
        ...loaded.clientProtocols,
        "future-client-protocol": Object.freeze({
          authFile: join(dirname(configPath), "client-auth", "future.json"),
        }),
      }),
    };

    await expect(
      createConfiguredLuckyTokenComposition({
        config,
        fetch: async () => commandCodeText("unused"),
      }),
    ).rejects.toThrow(
      "Client Protocol is configured but not installed: future-client-protocol",
    );
  });

  it("loads the canonical models.json from the config data directory by default", async () => {
    const { configPath, piDirectory } = await writeConfiguration();
    // The canonical default is `models.json` next to the config file
    // (the desktop layout's `~/.luckytoken/models.json`), not the Pi
    // credential directory and never Pi Agent's own data directory.
    await writeFile(
      join(dirname(configPath), "models.json"),
      JSON.stringify({
        providers: {
          "my-anthropic": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            models: [{ id: "claude-sonnet" }],
          },
        },
      }),
      "utf8",
    );
    const config = await loadLuckyTokenCliConfig(configPath);
    expect(config.pi.modelsJson).toBe(join(dirname(configPath), "models.json"));
    expect(config.pi.modelsJson).not.toBe(join(piDirectory, "models.json"));

    const composition = await createConfiguredLuckyTokenComposition({
      config,
      fetch: async () => commandCodeText("unused"),
    });
    compositions.push(composition);
    expect(composition.userConfiguredProviderIds).toEqual([
      "my-anthropic",
      "commandcode-private",
    ]);
  });

  it("keeps the data plane running when models.json is invalid and reports the skip", async () => {
    const { configPath } = await writeConfiguration();
    await writeFile(
      join(dirname(configPath), "models.json"),
      '{ "providers": { "broken": { "baseUrl": 42 } } }',
      "utf8",
    );
    const config = await loadLuckyTokenCliConfig(configPath);
    const invalid: unknown[] = [];

    const composition = await createConfiguredLuckyTokenComposition({
      config,
      fetch: async () => commandCodeText("unused"),
      onInvalidModelsJson: (error) => invalid.push(error),
    });
    compositions.push(composition);

    // The invalid file never bricks the gateway: only the packaged provider
    // is registered and the skip is reported instead of thrown.
    expect(composition.userConfiguredProviderIds).toEqual([
      "commandcode-private",
    ]);
    expect(invalid).toHaveLength(1);
    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/models"),
    );
    expect(response.status).toBe(200);
  });

  it("registers the optional OpenAI Responses protocol with its own auth and state file", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-composition-responses-"),
    );
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const anthropicAuthPath = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    const responsesAuthPath = join(
      stateDirectory,
      "client-auth",
      "openai-responses.json",
    );
    await createFileClientTokenStore({
      path: anthropicAuthPath,
    }).create({ type: "global" }, "anthropic-token");
    await createFileClientTokenStore({
      path: responsesAuthPath,
    }).create({ type: "global" }, "responses-token");
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
          "openai-responses": {
            authFile: "client-auth/openai-responses.json",
            stateFile: "state/openai-responses.json",
          },
        },
        providerPackages: { [COMMANDCODE_PROVIDER_PACKAGE]: {} },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const composition = await createConfiguredLuckyTokenComposition({
      config: await loadLuckyTokenCliConfig(configPath),
      credentials,
      fetch: async () => commandCodeText("responses served"),
      importModule: commandCodeProviderImportModule({
        projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
      }),
      createMessageId: () => "msg_anthropic",
      createSessionId: () => "00000000-0000-4000-8000-000000000251",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);

    // Anthropic token works on the Anthropic route only.
    const anthropic = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer anthropic-token",
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
    expect(anthropic.status).toBe(200);
    // Anthropic token must NOT work on the Responses route.
    const forbidden = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer anthropic-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "hello",
        }),
      }),
    );
    expect(forbidden.status).toBe(401);
    // Responses token works on the Responses route.
    const responses = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer responses-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "hello",
        }),
      }),
    );
    expect(responses.status).toBe(200);
    const responsesJson = await responses.json();
    expect(responsesJson.output[0].content[0].text).toBe("responses served");
    // Responses token must NOT work on the Anthropic route.
    const forbiddenAnthropic = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer responses-token",
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
    expect(forbiddenAnthropic.status).toBe(401);
    // Model discovery is unauthenticated and cross-protocol.
    const modelsResponse = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/models", {
        method: "GET",
      }),
    );
    expect(modelsResponse.status).toBe(200);
    const modelsJson = await modelsResponse.json();
    expect(modelsJson.object).toBe("list");
    expect(modelsJson.data.map((entry: { id: string }) => entry.id)).toContain(
      "commandcode-private/deepseek/deepseek-v4-flash",
    );
  });
});
