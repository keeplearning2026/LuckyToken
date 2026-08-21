import { describe, expect, it } from "vitest";

import { configuredBackupFiles } from "../../src/backup/configured.js";
import type { LuckyTokenCliConfig } from "../../src/cli-config.js";

describe("configured backup contract versions", () => {
  it("tracks the Pi 0.84.2 models schema without relabeling the unchanged auth.json format", () => {
    const config = {
      schemaVersion: 1,
      pi: {
        directory: "C:\\luckytoken",
        modelsJson: "C:\\luckytoken\\models.json",
      },
    } as unknown as LuckyTokenCliConfig;

    const files = configuredBackupFiles("C:\\luckytoken\\config.json", config);
    expect(files.find((file) => file.id === "models")).toMatchObject({
      contract: "pi-models-json",
      version: "0.84.2",
    });
    expect(files.find((file) => file.id === "provider-credentials")).toMatchObject({
      contract: "pi-auth-json",
      version: "0.84.1",
    });
  });
});
