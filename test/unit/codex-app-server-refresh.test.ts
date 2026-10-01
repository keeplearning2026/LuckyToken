import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  createCodexAppServerRefresher,
  type CreateCodexAppServerRefresherOptions,
} from "../../src/credentials/codex-app-server-refresh.js";

interface FakeAppServer {
  readonly spawn: NonNullable<
    CreateCodexAppServerRefresherOptions["spawnProcess"]
  >;
  readonly starts: () => number;
  readonly homes: readonly string[];
}

function fakeAppServer(options: {
  readonly codexHome: string;
  readonly initialize?: "ok" | "never" | "error";
  readonly accountRead?: "ok" | "never";
  readonly exitOnClose?: boolean;
}): FakeAppServer {
  let starts = 0;
  const homes: string[] = [];
  const spawn: NonNullable<CreateCodexAppServerRefresherOptions["spawnProcess"]> = (
    file,
    args,
    spawnOptions,
  ) => {
    starts += 1;
    homes.push(spawnOptions.env.CODEX_HOME ?? "");
    void file;
    void args;
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      kill: () => true,
    });
    let buffer = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        const message = JSON.parse(line) as {
          readonly id?: number;
          readonly method?: string;
        };
        if (message.method === "initialize") {
          if (options.initialize === "never") continue;
          if (options.initialize === "error") {
            stdout.write(`${JSON.stringify({ id: 1, error: { code: -1 } })}\n`);
            continue;
          }
          stdout.write(
            `${JSON.stringify({
              id: 1,
              result: { codexHome: options.codexHome },
            })}\n`,
          );
          continue;
        }
        if (message.method === "account/read") {
          if (options.accountRead === "never") continue;
          stdout.write(
            `${JSON.stringify({
              id: 2,
              result: { account: null, requiresOpenaiAuth: true },
            })}\n`,
          );
        }
      }
    });
    stdin.on("finish", () => {
      if (options.exitOnClose !== false) child.emit("exit", 0, null);
    });
    return child;
  };
  return { spawn, starts: () => starts, homes };
}

describe("Codex app-server refresh delegation", () => {
  it("performs the bounded one-shot handshake against the same CODEX_HOME", async () => {
    const codexHome = "C:\\temp\\codex-home";
    const fake = fakeAppServer({ codexHome });
    const refresher = createCodexAppServerRefresher({
      codexHome,
      discoverCommands: async () => ["codex"],
      spawnProcess: fake.spawn,
    });

    await expect(
      refresher.refresh({ canonicalPath: "auth.json" }),
    ).resolves.toEqual({ outcome: "completed" });
    expect(fake.starts()).toBe(1);
    expect(fake.homes).toEqual([codexHome]);
  });

  it("shares exactly one run per canonical path across concurrent waiters", async () => {
    const codexHome = "C:\\temp\\codex-home";
    const fake = fakeAppServer({ codexHome });
    const refresher = createCodexAppServerRefresher({
      codexHome,
      discoverCommands: async () => ["codex"],
      spawnProcess: fake.spawn,
    });

    const results = await Promise.all([
      refresher.refresh({ canonicalPath: "auth.json" }),
      refresher.refresh({ canonicalPath: "auth.json" }),
      refresher.refresh({ canonicalPath: "auth.json" }),
    ]);

    expect(results).toEqual([
      { outcome: "completed" },
      { outcome: "completed" },
      { outcome: "completed" },
    ]);
    expect(fake.starts()).toBe(1);
    expect(refresher.inflightCount()).toBe(0);
  });

  it("does not abort the shared run when one waiter cancels", async () => {
    const codexHome = "C:\\temp\\codex-home";
    const fake = fakeAppServer({ codexHome });
    const refresher = createCodexAppServerRefresher({
      codexHome,
      discoverCommands: async () => ["codex"],
      spawnProcess: fake.spawn,
    });
    const controller = new AbortController();

    const cancelled = refresher.refresh({
      canonicalPath: "auth.json",
      signal: controller.signal,
    });
    const joined = refresher.refresh({ canonicalPath: "auth.json" });
    controller.abort();

    await expect(cancelled).resolves.toEqual({
      outcome: "unavailable",
      reason: "timeout",
    });
    await expect(joined).resolves.toEqual({ outcome: "completed" });
    expect(fake.starts()).toBe(1);
  });

  it("fails closed on a protocol mismatch or a missing runtime", async () => {
    const codexHome = "C:\\temp\\codex-home";
    const mismatched = fakeAppServer({ codexHome: "C:\\temp\\other" });
    const mismatchedRefresher = createCodexAppServerRefresher({
      codexHome,
      discoverCommands: async () => ["codex"],
      spawnProcess: mismatched.spawn,
    });
    await expect(
      mismatchedRefresher.refresh({ canonicalPath: "auth.json" }),
    ).resolves.toEqual({ outcome: "unavailable", reason: "protocol" });

    const noRuntime = createCodexAppServerRefresher({
      codexHome,
      discoverCommands: async () => [],
      spawnProcess: fakeAppServer({ codexHome }).spawn,
    });
    await expect(
      noRuntime.refresh({ canonicalPath: "auth.json" }),
    ).resolves.toEqual({ outcome: "unavailable", reason: "no_runtime" });
  });
});
