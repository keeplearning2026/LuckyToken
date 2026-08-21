import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createElectronBackendLauncher,
  readBundledBackendBuildId,
  resolveBundledBackendLaunch,
} from "../src/main/electron-backend-launcher.js";

describe("BackendLauncher", () => {
  it("resolves only bundled process-launch paths and current-user Backend state paths", () => {
    expect(
      resolveBundledBackendLaunch({
        resourcesPath: "C:/Program/LuckyToken/resources",
        desktopExecutable: "C:/Program/LuckyToken/LuckyToken.exe",
        packaged: true,
        homeDirectory: "C:/Users/tester",
      }),
    ).toEqual({
      executable: expect.stringMatching(/resources[\\/]backend[\\/]node[\\/]node\.exe$/u),
      cliScript: expect.stringMatching(/resources[\\/]backend[\\/]dist[\\/]cli\.js$/u),
      buildIdPath: expect.stringMatching(/resources[\\/]backend[\\/]build-id\.txt$/u),
      configPath: expect.stringMatching(/Users[\\/]tester[\\/]\.luckytoken[\\/]config\.json$/u),
      descriptorPath: expect.stringMatching(/Users[\\/]tester[\\/]\.luckytoken[\\/]control-plane\.json$/u),
    });
  });

  it("fails cleanly when the bundled Backend executable cannot be spawned", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-backend-launch-missing-"));
    const backendRoot = join(root, "backend");
    await mkdir(backendRoot, { recursive: true });
    await writeFile(join(backendRoot, "build-id.txt"), `${"a".repeat(64)}\n`, "utf8");
    const launcher = createElectronBackendLauncher({
      resourcesPath: root,
      desktopExecutable: join(root, "LuckyToken.exe"),
      packaged: true,
      homeDirectory: join(root, "home"),
    });

    await expect(launcher.launch()).rejects.toThrow(
      "LuckyToken Backend process did not start",
    );
  });

  it("accepts only the assembled Backend SHA-256 build identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-backend-build-id-"));
    const valid = join(root, "valid.txt");
    const invalid = join(root, "invalid.txt");
    const buildId = "a".repeat(64);
    await writeFile(valid, `${buildId}\n`, "utf8");
    await writeFile(invalid, "not-a-build-id\n", "utf8");

    await expect(readBundledBackendBuildId(valid)).resolves.toBe(buildId);
    await expect(readBundledBackendBuildId(invalid)).rejects.toThrow(
      "LuckyToken bundled Backend build identity is invalid",
    );
  });
});
