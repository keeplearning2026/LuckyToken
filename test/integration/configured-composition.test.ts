import {
  InMemoryCredentialStore,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredLuckyTokenDataPlane } from "../../src/composition.js";
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

  async function writeConfiguration(): Promise<{
    configPath: string;
    piDirectory: string;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-composition-"));
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
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
        providerPackages: { [COMMANDCODE_PROVIDER_PACKAGE]: {} },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    return { configPath, piDirectory };
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
    const { configPath, piDirectory } = await writeConfiguration();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const config = await loadLuckyTokenCliConfig(configPath);
    const composition = await createConfiguredLuckyTokenDataPlane({
      config,
      credentials,
      fetch,
      importModule: commandCodeProviderImportModule(),
      createMessageId: () => "msg_configured",
      createSessionId: () => "00000000-0000-4000-8000-000000000250",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);

    expect(Object.keys(composition).sort()).toEqual([
      "catalog",
      "certification",
      "credentialAuthority",
      "deepCapture",
      "deepCaptureStore",
      "diagnosticsStore",
      "requestIdentities",
      "requestLedger",
      "runtime",
      "userConfiguredProviderIds",
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
    const { configPath } = await writeConfiguration();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const composition = await createConfiguredLuckyTokenDataPlane({
      config: await loadLuckyTokenCliConfig(configPath),
      credentials,
      fetch,
      importModule: commandCodeProviderImportModule(),
      createMessageId: () => "msg_models",
      createSessionId: () => "00000000-0000-4000-8000-000000000251",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
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

  it("keeps configured CommandCode execution project-free", async () => {
    const { configPath } = await writeConfiguration();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    let upstream: Request | undefined;
    const composition = await createConfiguredLuckyTokenDataPlane({
      config: await loadLuckyTokenCliConfig(configPath),
      credentials,
      fetch: async (input, init) => {
        upstream = new Request(input, init);
        return commandCodeText("project-free");
      },
      importModule: commandCodeProviderImportModule(),
      createMessageId: () => "msg_project_free",
      createSessionId: () => "00000000-0000-4000-8000-000000000251",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
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
    expect(upstream?.headers.get("x-project-slug")).toBeNull();
    await expect(upstream?.json()).resolves.toMatchObject({
      config: { workingDir: "", structure: [], isGitRepo: false },
    });
  });

  it("rejects an uninstalled Client Protocol only at the composition root", async () => {
    const { configPath } = await writeConfiguration();
    const loaded = await loadLuckyTokenCliConfig(configPath);
    const config = {
      ...loaded,
      clientProtocols: Object.freeze({
        ...loaded.clientProtocols,
        "future-client-protocol": Object.freeze({}),
      }),
    };

    await expect(
      createConfiguredLuckyTokenDataPlane({
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

    const composition = await createConfiguredLuckyTokenDataPlane({
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

    const composition = await createConfiguredLuckyTokenDataPlane({
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

  it("registers the optional OpenAI Responses protocol with its own state file", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-composition-responses-"),
    );
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
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
          "openai-responses": {
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
    const composition = await createConfiguredLuckyTokenDataPlane({
      config: await loadLuckyTokenCliConfig(configPath),
      credentials,
      fetch: async () => commandCodeText("responses served"),
      importModule: commandCodeProviderImportModule(),
      createMessageId: () => "msg_anthropic",
      createSessionId: () => "00000000-0000-4000-8000-000000000251",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);

    const anthropic = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
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
    const responses = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
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
