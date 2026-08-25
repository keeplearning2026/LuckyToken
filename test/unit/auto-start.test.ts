import { describe, expect, it } from "vitest";

import {
  buildWindowsAutoStartCommand,
  createUnsupportedAutoStartRegistrar,
  createWindowsAutoStartRegistrar,
  executeAutoStart,
  windowsRunKey,
} from "../../src/auto-start.js";

describe("Windows login auto-start registrar seam", () => {
  it("builds a quoted sign-in command line from the launch executable and args", () => {
    expect(
      buildWindowsAutoStartCommand(
        "C:\\Program Files\\Token\\node.exe",
        ["C:\\Program Files\\Token\\cli.js", "serve", "--config", "D:\\a b\\config.json"],
      ),
    ).toBe(
      '"C:\\Program Files\\Token\\node.exe" "C:\\Program Files\\Token\\cli.js" serve --config "D:\\a b\\config.json"',
    );
    expect(buildWindowsAutoStartCommand("node", ["serve"])).toBe("node serve");
  });

  it("enables, disables, and reports the effective registration through the Run key", async () => {
    const calls: string[][] = [];
    const registrar = createWindowsAutoStartRegistrar({
      name: "Token",
      command: "node serve",
      run: (args) => {
        calls.push([...args]);
        return { status: 0, stderr: "" };
      },
    });

    await registrar.enable();
    await registrar.status();

    expect(calls).toEqual([
      ["add", windowsRunKey, "/v", "Token", "/t", "REG_SZ", "/d", "node serve", "/f"],
      ["query", windowsRunKey, "/v", "Token"],
    ]);
    await expect(registrar.status()).resolves.toEqual({ enabled: true });
  });

  it("reports disabled when the value is not registered and tolerates an idempotent disable", async () => {
    let queryStatus = 1;
    const registrar = createWindowsAutoStartRegistrar({
      name: "Token",
      command: "node serve",
      run: (args) => {
        if (args[0] === "query") return { status: queryStatus, stderr: "" };
        return { status: 0, stderr: "" };
      },
    });
    await expect(registrar.status()).resolves.toEqual({ enabled: false });
    queryStatus = 0;
    await expect(registrar.status()).resolves.toEqual({ enabled: true });

    const failing = createWindowsAutoStartRegistrar({
      name: "Token",
      command: "node serve",
      run: () => ({ status: 1, stderr: "forbidden" }),
    });
    await expect(failing.disable()).resolves.toBeUndefined();
  });

  it("fails enable/disable with an actionable message when the registry write is refused", async () => {
    const registrar = createWindowsAutoStartRegistrar({
      name: "Token",
      command: "node serve",
      run: () => ({ status: 5, stderr: "access denied" }),
    });
    await expect(registrar.enable()).rejects.toThrow("access denied");
    await expect(registrar.disable()).rejects.toThrow("access denied");
  });

  it("projects status, enable, disable, failure, and unsupported outcomes", async () => {
    let enabled = false;
    const registrar = createUnsupportedAutoStartRegistrar();
    const memory = {
      async enable() {
        enabled = true;
      },
      async disable() {
        enabled = false;
      },
      async status() {
        return { enabled };
      },
    };

    await expect(executeAutoStart(memory, "status")).resolves.toEqual({
      outcome: "ok",
      enabled: false,
    });
    await expect(executeAutoStart(memory, "enable")).resolves.toEqual({
      outcome: "ok",
      enabled: true,
    });
    await expect(executeAutoStart(memory, "disable")).resolves.toEqual({
      outcome: "ok",
      enabled: false,
    });
    await expect(
      executeAutoStart(
        {
          async enable() {
            throw new Error("registry write refused");
          },
          async disable() {
            throw new Error("registry write refused");
          },
          async status() {
            return { enabled: false };
          },
        },
        "enable",
      ),
    ).resolves.toEqual({
      outcome: "failed",
      error: "registry write refused",
    });
    await expect(executeAutoStart(registrar, "enable")).resolves.toEqual({
      outcome: "unsupported",
    });
  });
});
