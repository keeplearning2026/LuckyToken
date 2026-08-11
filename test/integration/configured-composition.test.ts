import {
  InMemoryCredentialStore,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredLuckyTokenComposition } from "../../src/composition.js";
import { createEmptyServerConfig } from "../../src/providers/commandcode-private/project.js";

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

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function writeConfiguration(
    providerOverrides: Record<string, unknown> = {},
  ): Promise<{ configPath: string; piDirectory: string }> {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-composition-"));
    directories.push(directory);
    const piDirectory = join(directory, "pi");
    await mkdir(piDirectory);
    await writeFile(
      join(piDirectory, "models.json"),
      JSON.stringify({
        providers: {
          "commandcode-private": {
            baseUrl: "https://commandcode.fixture.test",
            api: "commandcode-private",
            models: [
              {
                id: "configured-model",
                name: "configured-model",
                api: "commandcode-private",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 64_000,
              },
            ],
            ...providerOverrides,
          },
        },
      }),
      "utf8",
    );
    const configPath = join(directory, "luckytoken.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        server: { port: 0 },
        client: { apiKey: "local-client-key" },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    return { configPath, piDirectory };
  }

  it("turns models.json into a Pi Provider hidden behind one Client Protocol", async () => {
    const upstreamRequests: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
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
    const composition = await createConfiguredLuckyTokenComposition({
      config,
      credentials,
      fetch,
      projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
      createMessageId: () => "msg_configured",
      createSessionId: () => "00000000-0000-4000-8000-000000000250",
      now: () => 1_786_400_000_000,
    });

    expect(Object.keys(composition).sort()).toEqual(["certification", "runtime"]);
    expect(Object.keys(composition.runtime)).toEqual(["handle"]);
    expect(composition.certification.result).toBe("CERTIFIED");
    expect(composition.certification.policies.authEndpoint.providerAuth).toBe(
      "pi-models-credential-store-v1",
    );
    expect(
      composition.certification.policies.models.providerRegistration,
    ).toBe("pi-models-json-startup-registration-v1");
    expect(composition.runtime).not.toHaveProperty("models");
    expect(composition.runtime).not.toHaveProperty("provider");

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer local-client-key",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "configured-model",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "msg_configured",
      model: "configured-model",
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

  it("rejects an unregistered API instead of coupling it into Runtime", async () => {
    const { configPath } = await writeConfiguration({
      api: "unknown-private-api",
    });
    const config = await loadLuckyTokenCliConfig(configPath);
    await expect(
      createConfiguredLuckyTokenComposition({
        config,
        fetch: async () => commandCodeText("unused"),
      }),
    ).rejects.toThrow("commandcode-private API");
  });

  it("rejects CommandCode credentials in static models.json", async () => {
    const { configPath } = await writeConfiguration({
      apiKey: "must-live-in-auth-json",
    });
    const config = await loadLuckyTokenCliConfig(configPath);
    await expect(
      createConfiguredLuckyTokenComposition({
        config,
        fetch: async () => commandCodeText("unused"),
      }),
    ).rejects.toThrow("unknown field: apiKey");
  });
});
