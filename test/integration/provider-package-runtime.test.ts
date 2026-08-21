import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createConfiguredPiModels } from "../support/configured-data-plane.js";

describe("configured Provider Package runtime", () => {
  it("starts without a Provider credential and fails only at invocation", async () => {
    const fetch = vi.fn(async () => new Response());
    const { models, externalProviderIds } = await createConfiguredPiModels({
      piDirectory: ".unused-in-memory-pi",
      credentials: new InMemoryCredentialStore(),
      fetch,
      providerPackages: {},
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000007",
    });
    expect(externalProviderIds).toEqual(["commandcode-private"]);
    await expect(
      models.checkAuth("commandcode-private"),
    ).resolves.toBeUndefined();
    const model = models.getModel(
      "commandcode-private",
      "deepseek/deepseek-v4-flash",
    );
    expect(model).toBeDefined();

    const events = [];
    for await (const event of models.streamSimple(
      model!,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: 1,
          },
        ],
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000008",
        signal: AbortSignal.timeout(5_000),
      },
    )) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
  });
});
