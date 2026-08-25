import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  connectControlPlane,
  controlPlaneVersion,
  createLocalIpcAddress,
  startControlPlane,
  type PipeConnection,
} from "@token/application-control-plane/control-plane";

import { createProductionControlPipe } from "../../src/control-pipe-composition.js";

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

async function readExact(
  connection: PipeConnection,
  length: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let received = 0;
  while (received < length) {
    const chunk = await connection.read(length - received);
    if (chunk === null) return null;
    chunks.push(chunk);
    received += chunk.length;
  }
  return Buffer.concat(chunks);
}

async function readFrame(connection: PipeConnection): Promise<unknown> {
  const header = await readExact(connection, 4);
  if (header === null) return undefined;
  const body = await readExact(connection, header.readUInt32BE(0));
  return body === null ? undefined : JSON.parse(body.toString("utf8"));
}

async function fixture() {
  const transport = await createProductionControlPipe();
  const endpoint = {
    address: createLocalIpcAddress({
      platform: process.platform,
      runtimeDirectory: process.cwd(),
      randomId: `security-${process.pid}-${randomUUID()}`,
    }),
    capability: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
  };
  const host = await startControlPlane({
    endpoint,
    application: { id: "Token", version: "security-test" },
    initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
    pipeServerFactory: transport.pipeServerFactory,
    access: transport.access,
  });
  return { transport, endpoint, host };
}

describe("capability-authenticated Control Plane over production local IPC", () => {
  it("reveals no application state before a valid capability-authenticated hello", async () => {
    const { transport, endpoint, host } = await fixture();
    const raw = await transport.pipeConnector.connect(endpoint.address);
    try {
      await raw.write(
        encodeFrame({
          type: "get_status",
          requestId: "before-hello",
        }),
      );
      expect(await readFrame(raw)).toEqual({
        type: "error",
        requestId: "before-hello",
        code: "hello_required",
      });

      await raw.write(
        encodeFrame({
          type: "hello",
          requestId: "missing-capability",
          contractVersion: controlPlaneVersion,
        }),
      );
      expect(await readFrame(raw)).toEqual({
        type: "error",
        requestId: "missing-capability",
        code: "invalid_request",
      });

      await raw.write(
        encodeFrame({
          type: "hello",
          requestId: "wrong-capability",
          contractVersion: controlPlaneVersion,
          capability: "wrong-capability-012345678901234567890123456789",
        }),
      );
      const denied = await readFrame(raw);
      expect(denied).toEqual({
        type: "error",
        requestId: "wrong-capability",
        code: "unauthorized",
      });
      expect(JSON.stringify(denied)).not.toContain("security-test");
      expect(JSON.stringify(denied)).not.toContain(endpoint.capability);
    } finally {
      await raw.close();
      await host.close();
    }
  });

  it("cleans subscriptions on disconnect and reconnects from a fresh snapshot", async () => {
    const { transport, endpoint, host } = await fixture();
    let requestId = 0;
    const connect = () =>
      connectControlPlane(endpoint, {
        createRequestId: () => `security-client-${++requestId}`,
        pipeConnector: transport.pipeConnector,
      });

    const first = await connect();
    await first.hello(controlPlaneVersion);
    const firstEvents: number[] = [];
    await first.subscribe((event) => firstEvents.push(event.sequence));
    await host.publishStatus({
      modelDataPlane: "running",
      provider: "configured",
    });
    await expect.poll(() => firstEvents).toEqual([1]);
    await first.close();
    await expect(first.disconnected).resolves.toEqual({ reason: "closed" });

    await host.publishStatus({
      modelDataPlane: "stopping",
      provider: "configured",
    });
    expect(firstEvents).toEqual([1]);

    const second = await connect();
    await second.hello(controlPlaneVersion);
    await expect(second.getStatus()).resolves.toMatchObject({
      sequence: 2,
      modelDataPlane: "stopping",
    });
    const secondEvents: number[] = [];
    await second.subscribe((event) => secondEvents.push(event.sequence));
    await host.publishStatus({
      modelDataPlane: "stopped",
      provider: "configured",
    });
    await expect.poll(() => secondEvents).toEqual([3]);
    expect(firstEvents).toEqual([1]);

    await second.close();
    await host.close();
  });
});
