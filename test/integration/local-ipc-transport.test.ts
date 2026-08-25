import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalIpcAddress,
  createNodePipeTransport,
} from "@token/application-control-plane/control-plane";
import { readFrame, writeFrame } from "../../packages/application-control-plane/src/framing.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("pure TypeScript local IPC transport", () => {
  it("creates platform-specific addresses without leaking platform semantics into callers", () => {
    expect(
      createLocalIpcAddress({ platform: "win32", randomId: "abc123" }),
    ).toBe("\\\\.\\pipe\\Token-abc123");
    expect(
      createLocalIpcAddress({
        platform: "linux",
        runtimeDirectory: "/tmp/Token-test",
        randomId: "abc123",
      }),
    ).toBe("/tmp/Token-test/Token-abc123.sock");
  });

  it("carries framed messages and reports peer close over real Node local IPC", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "Token-ipc-"));
    roots.push(runtimeDirectory);
    const address = createLocalIpcAddress({
      platform: process.platform,
      runtimeDirectory,
      randomId: `test-${process.pid}-${Date.now()}`,
    });
    const transport = createNodePipeTransport();
    const server = await transport.listen(address);
    const client = await transport.connect(address);
    const accepted = await server.accept();
    expect(accepted).not.toBeNull();
    if (accepted === null) return;

    try {
      await writeFrame(client, { type: "probe", value: 42 });
      await expect(readFrame(accepted)).resolves.toEqual({
        type: "frame",
        value: { type: "probe", value: 42 },
      });

      await client.close();
      await expect(readFrame(accepted)).resolves.toEqual({ type: "end" });
    } finally {
      await accepted.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
