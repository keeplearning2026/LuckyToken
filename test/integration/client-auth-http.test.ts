import Anthropic from "@anthropic-ai/sdk";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredLuckyTokenComposition } from "../../src/composition.js";
import { createEmptyServerConfig } from "../../src/providers/commandcode-private/project.js";
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

describe("per-Client-Protocol Auth over real HTTP", () => {
  const directories: string[] = [];
  const servers: Array<Awaited<ReturnType<typeof startLuckyTokenHttpServer>>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("isolates global/project facts and activates file changes only after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-client-auth-http-"));
    directories.push(root);
    const stateDirectory = join(root, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    const projectDir = join(root, "project");
    const authFile = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    const otherAuthFile = join(
      stateDirectory,
      "client-auth",
      "future-client-protocol.json",
    );
    await mkdir(piDirectory, { recursive: true });
    await mkdir(projectDir);
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
          },
        },
      }),
      "utf8",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        server: { host: "127.0.0.1", port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const tokenStore = createFileClientTokenStore({ path: authFile });
    await tokenStore.create({ type: "global" }, "old-global-token");
    await tokenStore.create(
      { type: "project", projectDir },
      "project-token",
    );
    await createFileClientTokenStore({ path: otherAuthFile }).create(
      { type: "global" },
      "other-protocol-token",
    );
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const projectSnapshot = vi.fn(
      async (input: { readonly projectDir: string; readonly signal: AbortSignal }) => {
        input.signal.throwIfAborted();
        return createEmptyServerConfig();
      },
    );
    const config = await loadLuckyTokenCliConfig(configPath);
    const start = async () => {
      const composition = await createConfiguredLuckyTokenComposition({
        config,
        credentials,
        fetch: async () => commandCodeText("authorized"),
        projectSnapshot: { snapshot: projectSnapshot },
      });
      const server = await startLuckyTokenHttpServer({
        runtime: composition.runtime,
        host: "127.0.0.1",
        port: 0,
      });
      servers.push(server);
      return server;
    };
    const client = (origin: string, apiKey: string) =>
      new Anthropic({ apiKey, baseURL: origin, maxRetries: 0, timeout: 10_000 });
    const complete = (sdk: Anthropic) =>
      sdk.messages.create({
        model: "configured-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      });

    const firstServer = await start();
    const oldGlobal = client(firstServer.origin, "old-global-token");
    const project = client(firstServer.origin, "project-token");
    await expect(
      Promise.all([complete(oldGlobal), complete(project)]),
    ).resolves.toHaveLength(2);
    expect(projectSnapshot).toHaveBeenCalledTimes(1);
    expect(projectSnapshot.mock.calls[0]?.[0].projectDir).toBe(projectDir);
    await expect(
      complete(client(firstServer.origin, "invalid-token")),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      complete(client(firstServer.origin, "other-protocol-token")),
    ).rejects.toMatchObject({ status: 401 });

    await tokenStore.rotate({ type: "global" }, "new-global-token");
    await tokenStore.remove({ type: "project", projectDir });
    await expect(
      Promise.all([complete(oldGlobal), complete(project)]),
    ).resolves.toHaveLength(2);
    expect(projectSnapshot).toHaveBeenCalledTimes(2);

    await firstServer.close();
    servers.splice(servers.indexOf(firstServer), 1);
    const secondServer = await start();
    await expect(
      complete(client(secondServer.origin, "new-global-token")),
    ).resolves.toMatchObject({ stop_reason: "end_turn" });
    await expect(
      complete(client(secondServer.origin, "old-global-token")),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      complete(client(secondServer.origin, "project-token")),
    ).rejects.toMatchObject({ status: 401 });
    expect(projectSnapshot).toHaveBeenCalledTimes(2);
  }, 30_000);
});
