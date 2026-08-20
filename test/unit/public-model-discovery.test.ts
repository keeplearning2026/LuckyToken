import { describe, expect, it } from "vitest";

import type { Models } from "@earendil-works/pi-ai";

import { createModelsDiscoveryHandler } from "../../src/models-discovery.js";
import { createPublicModelAuthority } from "../../src/public-models/authority.js";

describe("Public Model discovery", () => {
  it("renders exactly the PublicModelAuthority published models", async () => {
    const authority = createPublicModelAuthority({
      path: "C:\\app\\public-models.json",
      fileSystem: {
        readFile: async () =>
          `${JSON.stringify({
            schemaVersion: 1,
            endpoint: { host: "127.0.0.1", port: 3000 },
            providers: {
              anthropic: {
                enabled: true,
                models: {
                  "anthropic/opus": { target: "claude/opus", enabled: true },
                  "anthropic/sonnet": { target: "claude/sonnet", enabled: false },
                },
              },
            },
          })}\n`,
        writeFile: async () => undefined,
        rename: async () => undefined,
        mkdir: async () => undefined,
        rm: async () => undefined,
      },
    });
    await authority.reconcile({
      version: 1,
      providers: [
        {
          providerId: "anthropic",
          usable: true,
          models: ["claude/opus", "claude/sonnet"],
        },
      ],
    });
    const handler = createModelsDiscoveryHandler({
      models: {} as Models,
      providerIds: [],
      publicModels: {
        requestSnapshot: async () => authority.snapshot(),
      },
      now: () => 1_000,
    });

    const response = await handler.handle(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "anthropic/opus",
          object: "model",
          created: 1,
          owned_by: "anthropic",
        },
      ],
    });
  });
});
