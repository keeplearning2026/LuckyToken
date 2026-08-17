import { describe, expect, it } from "vitest";

import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

describe("LuckyTokenDesktopApi test seam", () => {
  it("can be replaced by a deterministic fake without Electron or Backend", async () => {
    const api = createFakeDesktopApi({
      control: {
        getStatus: async () => ({
          sequence: 8,
          modelDataPlane: "running",
          provider: "configured",
        }),
      },
      platform: {
        getAutoStart: async () => true,
      },
    });

    await expect(api.control.getStatus()).resolves.toMatchObject({
      sequence: 8,
      modelDataPlane: "running",
    });
    await expect(api.platform.getAutoStart()).resolves.toBe(true);
    expect(api.contractVersion).toBe(1);
  });
});
