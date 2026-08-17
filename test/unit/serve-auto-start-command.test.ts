import { describe, expect, it } from "vitest";

import { buildServeAutoStartCommand } from "../../src/auto-start.js";

describe("serve auto-start registration command", () => {
  it("registers the node CLI serve command for a cli owner", () => {
    expect(
      buildServeAutoStartCommand({
        ownerKind: "cli",
        nodeExecutable: "node.exe",
        cliScript: "C:\\app\\dist\\cli.js",
        configPath: "C:\\Users\\u\\.luckytoken\\config.json",
      }),
    ).toBe(
      "node.exe C:\\app\\dist\\cli.js serve --config C:\\Users\\u\\.luckytoken\\config.json",
    );
  });

  it("registers the desktop executable alone for a desktop owner", () => {
    expect(
      buildServeAutoStartCommand({
        ownerKind: "desktop",
        desktopExe: "C:\\Program Files\\LuckyToken\\LuckyToken.exe",
        nodeExecutable: "node.exe",
        cliScript: "C:\\app\\dist\\cli.js",
        configPath: "C:\\Users\\u\\.luckytoken\\config.json",
      }),
    ).toBe('"C:\\Program Files\\LuckyToken\\LuckyToken.exe"');
  });

  it("falls back to the node command when the desktop exe is unknown", () => {
    expect(
      buildServeAutoStartCommand({
        ownerKind: "desktop",
        nodeExecutable: "node.exe",
        cliScript: "C:\\app\\dist\\cli.js",
        configPath: "C:\\Users\\u\\.luckytoken\\config.json",
      }),
    ).toBe(
      "node.exe C:\\app\\dist\\cli.js serve --config C:\\Users\\u\\.luckytoken\\config.json --owner desktop",
    );
  });
});
