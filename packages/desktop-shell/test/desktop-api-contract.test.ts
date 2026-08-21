import { describe, expect, it } from "vitest";

import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

describe("LuckyTokenDesktopApi test seam", () => {
  it("can be replaced by a deterministic fake without Electron or Backend", async () => {
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({
          revision: 3,
          kind: "ready",
          status: {
            sequence: 8,
            modelDataPlane: "running",
            provider: "configured",
          },
        }),
      },
      platform: {
        getAutoStart: async () => true,
      },
    });

    await expect(api.control.getBackendState()).resolves.toMatchObject({
      revision: 3,
      kind: "ready",
      status: { sequence: 8, modelDataPlane: "running" },
    });
    await expect(api.platform.getAutoStart()).resolves.toBe(true);
    expect(api.contractVersion).toBe(1);
  });
});
