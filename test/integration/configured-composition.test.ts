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
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
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

  it("registers the built-in CommandCode Provider hidden behind one Client Protocol", async () => {
    const upstreamRequests: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      if (String(input).includes("/provider/v1/models")) {
        return new Response(
          JSON.stringify({ object: "list", data: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
    ).toBe("startup-only-mutable-models-v1");
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

  it("serves every built-in CommandCode model through the route", async () => {
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
      projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
      createMessageId: () => "msg_models",
      createSessionId: () => "00000000-0000-4000-8000-000000000251",
      now: () => 1_786_400_000_000,
    });

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
      async (input: { readonly projectDir: string; readonly signal: AbortSignal }) => {
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
      projectSnapshot: { snapshot: projectSnapshot },
      createMessageId: () => "msg_project_auth",
      createSessionId: () => "00000000-0000-4000-8000-000000000251",
      now: () => 1_786_400_000_000,
    });

    expect(
      composition.certification.policies.authEndpoint.projectAuthorization,
    ).toBe("per-client-protocol-token-file-v1");
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

});
