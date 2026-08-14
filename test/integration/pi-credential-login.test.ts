import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createFileCredentialStore } from "../../src/index.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "../../packages/provider-commandcode-private/src/provider.js";
import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function fixtureProvider() {
  const model: Model<"fixture-api"> = {
    id: "fixture-model",
    name: "Fixture Model",
    api: "fixture-api",
    provider: "fixture-provider",
    baseUrl: "https://fixture.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
  const stream = (selected: Model<"fixture-api">) => {
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "fixture" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    events.push({ type: "start", partial: message });
    events.push({ type: "done", reason: "stop", message });
    events.end(message);
    return events;
  };
  return createProvider({
    id: "fixture-provider",
    name: "Fixture Provider",
    models: [model],
    auth: {
      apiKey: {
        name: "Fixture API key",
        login: async (interaction) => ({
          type: "api_key",
          key: await interaction.prompt({
            type: "secret",
            message: "Enter the fixture API key",
          }),
        }),
        resolve: async ({ credential }) =>
          credential?.key
            ? {
                auth: { apiKey: credential.key },
                source: "stored credential",
              }
            : undefined,
      },
    },
    api: { stream, streamSimple: stream },
  });
}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        cleanup();
        resolvePromise(output);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      rejectPromise(
        new Error(`Credential worker exited with ${String(code)} before ${expected}`),
      );
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Credential worker failed: ${stderr}`));
    });
  });
}

describe("Pi persistent credential login", () => {
  it("persists Models.login and Models.logout across new runtime instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-"));
    temporaryDirectories.push(directory);
    const authPath = join(directory, "auth.json");

    const firstStore = createFileCredentialStore(authPath);
    const firstModels = createModels({ credentials: firstStore });
    firstModels.setProvider(fixtureProvider());

    await expect(
      firstModels.login("fixture-provider", "api_key", {
        prompt: async (prompt) => {
          expect(prompt.type).toBe("secret");
          return "persisted-secret";
        },
        notify: () => {},
      }),
    ).resolves.toEqual({ type: "api_key", key: "persisted-secret" });
    await expect(firstStore.list()).resolves.toEqual([
      { providerId: "fixture-provider", type: "api_key" },
    ]);

    const secondStore = createFileCredentialStore(authPath);
    const secondModels = createModels({ credentials: secondStore });
    secondModels.setProvider(fixtureProvider());
    await expect(secondModels.getAuth("fixture-provider")).resolves.toEqual({
      auth: { apiKey: "persisted-secret" },
      source: "stored credential",
    });

    await secondModels.logout("fixture-provider");
    const thirdModels = createModels({
      credentials: createFileCredentialStore(authPath),
    });
    thirdModels.setProvider(fixtureProvider());
    await expect(thirdModels.getAuth("fixture-provider")).resolves.toBeUndefined();
  });

  it("dispatches a CommandCode login credential only through Pi Models", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-commandcode-auth-"));
    temporaryDirectories.push(directory);
    const authPath = join(directory, "auth.json");
    const commandCodeModel: Model<typeof commandCodePrivateApiId> = {
      id: "commandcode-model",
      name: "CommandCode Model",
      api: commandCodePrivateApiId,
      provider: commandCodePrivateProviderId,
      baseUrl: "https://commandcode.fixture.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    const upstreamRequests: Request[] = [];
    const commandCodeProvider = createCommandCodePrivateProvider({
      apiKey: "configured-fallback-secret",
      fetch: async (input, init) => {
        upstreamRequests.push(new Request(input, init));
        return new Response(
          [
            JSON.stringify({ type: "text-start", id: "0" }),
            JSON.stringify({ type: "text-delta", id: "0", text: "authenticated" }),
            JSON.stringify({ type: "text-end", id: "0" }),
            JSON.stringify({
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }),
          ].join("\n"),
        );
      },
      model: commandCodeModel,
      now: () => 1_786_400_000_000,
      projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
      createSessionId: () => "00000000-0000-4000-8000-000000000250",
    });
    expect(commandCodeProvider.auth.apiKey?.login).toBeTypeOf("function");
    expect(commandCodeProvider.auth.oauth).toBeUndefined();

    const loginModels = createModels({
      credentials: createFileCredentialStore(authPath),
    });
    loginModels.setProvider(commandCodeProvider);
    await loginModels.login(commandCodePrivateProviderId, "api_key", {
      prompt: async (prompt) => {
        expect(prompt).toMatchObject({
          type: "secret",
          message: "Enter the CommandCode API key",
        });
        return "stored-commandcode-secret";
      },
      notify: () => {},
    });

    const servingModels = createModels({
      credentials: createFileCredentialStore(authPath),
    });
    servingModels.setProvider(commandCodeProvider);
    const response = await servingModels.completeSimple(
      commandCodeModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: 1_786_400_000_000,
          },
        ],
      },
      { maxTokens: 64 },
    );

    expect(response.content).toEqual([{ type: "text", text: "authenticated" }]);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe(
      "Bearer stored-commandcode-secret",
    );
  });

  it("rejects an empty CommandCode login before persisting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-empty-auth-"));
    temporaryDirectories.push(directory);
    const authPath = join(directory, "auth.json");
    const commandCodeModel: Model<typeof commandCodePrivateApiId> = {
      id: "commandcode-model",
      name: "commandcode-model",
      api: commandCodePrivateApiId,
      provider: commandCodePrivateProviderId,
      baseUrl: "https://commandcode.fixture.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    const store = createFileCredentialStore(authPath);
    const models = createModels({ credentials: store });
    models.setProvider(
      createCommandCodePrivateProvider({
        fetch: async () => new Response(),
        model: commandCodeModel,
        now: () => 1,
        projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
      }),
    );

    await expect(
      models.login(commandCodePrivateProviderId, "api_key", {
        prompt: async () => "   ",
        notify: () => {},
      }),
    ).rejects.toThrow("non-empty");
    await expect(store.list()).resolves.toEqual([]);
  });

  it("serializes auth.json mutations between independent processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-lock-"));
    temporaryDirectories.push(directory);
    const authPath = join(directory, "auth.json");
    const storeModuleUrl = pathToFileURL(
      resolve("src/pi/file-credential-store.ts"),
    ).href;
    const workerSource = `
      import { createFileCredentialStore } from ${JSON.stringify(storeModuleUrl)};
      const store = createFileCredentialStore(process.env.LUCKYTOKEN_TEST_AUTH_PATH);
      if (process.env.LUCKYTOKEN_TEST_WORKER === "first") {
        await store.modify("fixture-provider", async () => {
          process.stdout.write("locked\\n");
          await new Promise((resolve) => process.stdin.once("data", resolve));
          return { type: "api_key", key: "first-secret" };
        });
      } else {
        process.stdout.write("started\\n");
        let observed;
        await store.modify("fixture-provider", async (current) => {
          observed = current?.type === "api_key" ? current.key : undefined;
          return { type: "api_key", key: "second-secret" };
        });
        process.stdout.write(\`observed=\${observed}\\n\`);
      }
    `;
    const spawnWorker = (worker: "first" | "second") =>
      spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LUCKYTOKEN_TEST_AUTH_PATH: authPath,
          LUCKYTOKEN_TEST_WORKER: worker,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

    const first = spawnWorker("first");
    await waitForOutput(first, "locked\n");
    const firstExit = waitForExit(first);
    const second = spawnWorker("second");
    const secondStarted = waitForOutput(second, "started\n");
    const secondOutput = waitForOutput(second, "observed=");
    const secondExit = waitForExit(second);
    await secondStarted;
    first.stdin.end("release\n");

    await expect(firstExit).resolves.toBeUndefined();
    await expect(secondOutput).resolves.toContain("observed=first-secret");
    await expect(secondExit).resolves.toBeUndefined();
    await expect(createFileCredentialStore(authPath).read("fixture-provider"))
      .resolves.toEqual({ type: "api_key", key: "second-secret" });
  });

  it("cancels a credential mutation while it waits for the file lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auth-abort-"));
    temporaryDirectories.push(directory);
    const authPath = join(directory, "auth.json");
    const firstStore = createFileCredentialStore(authPath);
    const secondStore = createFileCredentialStore(authPath);
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolvePromise) => {
      enteredResolve = resolvePromise;
    });
    let releaseResolve: (() => void) | undefined;
    const release = new Promise<void>((resolvePromise) => {
      releaseResolve = resolvePromise;
    });
    const firstMutation = firstStore.modify("fixture-provider", async () => {
      enteredResolve?.();
      await release;
      return { type: "api_key", key: "committed-secret" };
    });
    await entered;

    const controller = new AbortController();
    const reason = new Error("credential operation cancelled");
    let secondCallbackEntered = false;
    const secondMutation = secondStore.modify(
      "fixture-provider",
      async () => {
        secondCallbackEntered = true;
        return { type: "api_key", key: "must-not-commit" };
      },
      { signal: controller.signal },
    );
    controller.abort(reason);

    await expect(secondMutation).rejects.toBe(reason);
    expect(secondCallbackEntered).toBe(false);
    releaseResolve?.();
    await expect(firstMutation).resolves.toEqual({
      type: "api_key",
      key: "committed-secret",
    });
    await expect(firstStore.read("fixture-provider")).resolves.toEqual({
      type: "api_key",
      key: "committed-secret",
    });
  });
});
